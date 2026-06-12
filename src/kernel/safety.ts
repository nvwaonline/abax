import type { PredicateAtom, SemanticScalar } from '../model/types.js'
import { isBuiltinPredicate, isArithmeticBuiltin, ARITHMETIC_RESULT_KEY } from './builtins.js'
import { isVariable, type RuleDefinition } from './predicate.js'

export class RuleSafetyError extends Error {
  readonly ruleId: string
  readonly violations: string[]

  constructor(ruleId: string, violations: string[]) {
    super(`Rule "${ruleId}" is unsafe: ${violations.join('; ')}`)
    this.name = 'RuleSafetyError'
    this.ruleId = ruleId
    this.violations = violations
  }
}

/**
 * Range restriction (rule safety): every variable in a head atom and in
 * every negation-as-failure literal must be bound by a positive body
 * literal (strong-negative literals bind variables too — they match
 * explicit negative facts). Unsafe rules have order-dependent or
 * undefined semantics and are rejected at assertion time.
 */
export function validateRuleSafety(rule: RuleDefinition): string[] {
  const violations: string[] = []
  const boundVars = new Set<string>()

  for (const literal of rule.when ?? []) {
    if (literal.naf !== true && !isBuiltinPredicate(literal.predicate)) {
      for (const variable of atomVariables(literal)) {
        boundVars.add(variable)
      }
    }
  }
  // Arithmetic built-ins bind their `result` variable, so it is available
  // to downstream literals and the head (function evaluation, not a guard).
  for (const literal of rule.when ?? []) {
    if (isArithmeticBuiltin(literal.predicate)) {
      const resultTerm = literal.args?.[ARITHMETIC_RESULT_KEY]
      if (typeof resultTerm === 'string' && isVariable(resultTerm)) boundVars.add(resultTerm.slice(1))
    }
  }

  for (const literal of rule.when ?? []) {
    if (isBuiltinPredicate(literal.predicate)) {
      if (literal.naf === true || literal.negated === true) {
        violations.push(
          `built-in literal ${literal.predicate}(...) must not be negated; use the inverse comparison instead`,
        )
      }
      // For arithmetic, the result var is an OUTPUT (bound by the literal),
      // so only the INPUT vars (everything but `result`) need prior binding.
      const inputVars = isArithmeticBuiltin(literal.predicate)
        ? atomVariables(literal).filter((v) => literal.args?.[ARITHMETIC_RESULT_KEY] !== `?${v}`)
        : atomVariables(literal)
      for (const variable of inputVars) {
        if (!boundVars.has(variable)) {
          violations.push(
            `variable ?${variable} in built-in literal ${literal.predicate}(...) is not bound by a positive body literal`,
          )
        }
      }
      continue
    }
    if (literal.naf !== true) continue
    for (const variable of atomVariables(literal)) {
      if (!boundVars.has(variable)) {
        violations.push(
          `variable ?${variable} in naf literal ${literal.predicate}(...) is not bound by a positive body literal`,
        )
      }
    }
  }

  for (const head of rule.then ?? []) {
    if (head.naf === true) {
      violations.push(`head atom ${head.predicate}(...) must not use naf`)
    }
    if (isBuiltinPredicate(head.predicate)) {
      violations.push(
        `reserved built-in predicate "${head.predicate}" cannot appear in a rule head`,
      )
    }
    for (const variable of atomVariables(head)) {
      if (!boundVars.has(variable)) {
        violations.push(
          `variable ?${variable} in head atom ${head.predicate}(...) is not bound by a positive body literal`,
        )
      }
    }
  }

  return violations
}

export function assertRuleSafety(rule: RuleDefinition): void {
  const violations = validateRuleSafety(rule)
  if (violations.length > 0) {
    throw new RuleSafetyError(rule.id, violations)
  }
}

export class ActionSafetyError extends Error {
  readonly actionId: string
  readonly violations: string[]

  constructor(actionId: string, violations: string[]) {
    super(
      `Action "${actionId}" is unsafe: ${violations.join('; ')}. ` +
        `Every variable used in an effect must be bound by a precondition ` +
        `(a positive literal or an arithmetic result); otherwise the effect ` +
        `cannot be instantiated at apply time.`,
    )
    this.name = 'ActionSafetyError'
    this.actionId = actionId
    this.violations = violations
  }
}

export type ActionSafetyInput = {
  id: string
  preconditions?: PredicateAtom[]
  effects?: PredicateAtom[]
}

/**
 * Action safety — the define_action analogue of rule safety. Preconditions
 * are matched exactly like a rule body, so the same range restriction
 * applies; effects are instantiated from the precondition binding, so every
 * effect variable must be bound there. Without this check an unbound effect
 * variable silently produced a fact with a literal "?x" argument — a silent
 * wrong answer instead of a teaching error.
 */
export function validateActionSafety(action: ActionSafetyInput): string[] {
  const violations: string[] = []
  const boundVars = new Set<string>()
  const preconditions = action.preconditions ?? []

  for (const literal of preconditions) {
    if (literal.naf !== true && !isBuiltinPredicate(literal.predicate)) {
      for (const variable of atomVariables(literal)) boundVars.add(variable)
    }
  }
  for (const literal of preconditions) {
    if (isArithmeticBuiltin(literal.predicate)) {
      const resultTerm = literal.args?.[ARITHMETIC_RESULT_KEY]
      if (typeof resultTerm === 'string' && isVariable(resultTerm)) boundVars.add(resultTerm.slice(1))
    }
  }

  for (const literal of preconditions) {
    if (isBuiltinPredicate(literal.predicate)) {
      if (literal.naf === true || literal.negated === true) {
        violations.push(
          `built-in precondition ${literal.predicate}(...) must not be negated; use the inverse comparison instead`,
        )
      }
      const inputVars = isArithmeticBuiltin(literal.predicate)
        ? atomVariables(literal).filter((v) => literal.args?.[ARITHMETIC_RESULT_KEY] !== `?${v}`)
        : atomVariables(literal)
      for (const variable of inputVars) {
        if (!boundVars.has(variable)) {
          violations.push(
            `variable ?${variable} in built-in precondition ${literal.predicate}(...) is not bound by a positive precondition`,
          )
        }
      }
      continue
    }
    if (literal.naf !== true) continue
    for (const variable of atomVariables(literal)) {
      if (!boundVars.has(variable)) {
        violations.push(
          `variable ?${variable} in naf precondition ${literal.predicate}(...) is not bound by a positive precondition`,
        )
      }
    }
  }

  for (const effect of action.effects ?? []) {
    if (effect.naf === true) {
      violations.push(
        `effect ${effect.predicate}(...) must not use naf; a negated effect (negated:true) deletes the matching fact`,
      )
    }
    if (isBuiltinPredicate(effect.predicate)) {
      violations.push(
        `reserved built-in predicate "${effect.predicate}" cannot appear in an effect; ` +
          `compute values in preconditions and use the bound result variable in the effect`,
      )
    }
    for (const variable of atomVariables(effect)) {
      if (!boundVars.has(variable)) {
        violations.push(
          `variable ?${variable} in effect ${effect.predicate}(...) is not bound by any precondition`,
        )
      }
    }
  }

  return violations
}

export function assertActionSafety(action: ActionSafetyInput): void {
  const violations = validateActionSafety(action)
  if (violations.length > 0) {
    throw new ActionSafetyError(action.id, violations)
  }
}

function atomVariables(atom: PredicateAtom): string[] {
  return Object.values(atom.args ?? {})
    .filter((value): value is SemanticScalar & string => isVariable(value))
    .map((value) => value.slice(1))
}
