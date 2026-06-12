import type { PredicateAtom, SemanticArgs, SemanticScalar } from '../model/types.js'
import {
  evaluateBuiltin,
  isBuiltinPredicate,
  isArithmeticBuiltin,
  computeArithmetic,
  ARITHMETIC_RESULT_KEY,
} from './builtins.js'

export type BindingMap = Record<string, SemanticScalar>

export type PredicateFact = {
  id: string
  atom: PredicateAtom
}

export type RuleDefinition = {
  id: string
  when?: PredicateAtom[]
  then?: PredicateAtom[]
}

export type RuleMatch = {
  bindings: BindingMap
  factIds: string[]
}

export function matchRule(rule: RuleDefinition, facts: PredicateFact[]): RuleMatch[] {
  const conditions = rule.when ?? []
  if (conditions.length === 0) return [{ bindings: {}, factIds: [] }]

  // Positive (and strong-negative) literals bind variables; evaluate
  // them before naf and built-in literals so that both are checked
  // under complete bindings, independent of how the rule was written.
  return matchConditions(orderConditionsForMatching(conditions), facts, [
    { bindings: {}, factIds: [] },
  ])
}

/**
 * The evaluation order matchRule actually uses: binding literals first,
 * then built-ins/naf in data-dependency order. Exported so diagnostics
 * (e.g. "which precondition failed first") can walk the same order the
 * matcher does.
 */
export function orderConditionsForMatching(conditions: PredicateAtom[]): PredicateAtom[] {
  const binds = (condition: PredicateAtom): boolean =>
    condition.naf !== true && !isBuiltinPredicate(condition.predicate)
  const binders = conditions.filter(binds)
  const rest = conditions.filter((condition) => !binds(condition))
  return [...binders, ...orderByDataDependency(binders, rest)]
}

/**
 * Order non-binding literals (built-ins and naf) so each is evaluated only
 * once its variables are available. Chained arithmetic (one result feeding
 * another's input) written out of source order previously failed silently:
 * the early literal saw an unbound input and produced no match. Models
 * cannot be expected to topologically sort their rule bodies — the matcher
 * does it. Literals whose dependencies never become available keep their
 * original order at the end (they fail exactly as before).
 */
function orderByDataDependency(
  binders: PredicateAtom[],
  rest: PredicateAtom[],
): PredicateAtom[] {
  const available = new Set<string>()
  for (const literal of binders) {
    for (const value of Object.values(literal.args ?? {})) {
      if (isVariable(value)) available.add(value.slice(1))
    }
  }

  const variablesOf = (literal: PredicateAtom): string[] =>
    Object.values(literal.args ?? {})
      .filter(isVariable)
      .map((value) => value.slice(1))

  const requiredVars = (literal: PredicateAtom): string[] => {
    if (!isArithmeticBuiltin(literal.predicate)) return variablesOf(literal)
    // Arithmetic OUTPUT (result) is bound by the literal itself.
    return variablesOf(literal).filter(
      (variable) => literal.args?.[ARITHMETIC_RESULT_KEY] !== `?${variable}`,
    )
  }

  const ordered: PredicateAtom[] = []
  const pending = [...rest]
  let progress = true
  while (pending.length > 0 && progress) {
    progress = false
    for (let i = 0; i < pending.length; i += 1) {
      const literal = pending[i]!
      if (!requiredVars(literal).every((variable) => available.has(variable))) continue
      ordered.push(literal)
      if (isArithmeticBuiltin(literal.predicate)) {
        const resultTerm = literal.args?.[ARITHMETIC_RESULT_KEY]
        if (typeof resultTerm === 'string' && isVariable(resultTerm)) {
          available.add(resultTerm.slice(1))
        }
      }
      pending.splice(i, 1)
      progress = true
      break
    }
  }
  return [...ordered, ...pending]
}

export function matchConditions(
  conditions: PredicateAtom[],
  facts: PredicateFact[],
  matches: RuleMatch[],
): RuleMatch[] {
  let current = matches
  for (const condition of conditions) {
    current = current.flatMap((match) => matchCondition(condition, facts, match))
    if (current.length === 0) break
  }
  return current
}

export function matchCondition(
  condition: PredicateAtom,
  facts: PredicateFact[],
  match: RuleMatch,
): RuleMatch[] {
  if (isArithmeticBuiltin(condition.predicate)) {
    // Value-producing built-in: inputs (left[/right]) are bound by safety;
    // compute and bind `result`. If `result` is already a value/bound var,
    // act as a guard (the computed value must equal it).
    const args = condition.args ?? {}
    const left = resolveTerm(args.left, match.bindings)
    const right = resolveTerm(args.right, match.bindings)
    if (left === undefined) return []
    const value = computeArithmetic(condition.predicate, left, right)
    if (value === undefined) return []
    const resultTerm = args[ARITHMETIC_RESULT_KEY]
    if (resultTerm === undefined) return [] // malformed: no result slot
    if (isVariable(resultTerm)) {
      const name = resultTerm.slice(1)
      const existing = match.bindings[name]
      if (existing !== undefined) return existing === value ? [match] : []
      return [{ bindings: { ...match.bindings, [name]: value }, factIds: match.factIds }]
    }
    // result is a constant -> guard
    return resultTerm === value ? [match] : []
  }

  if (isBuiltinPredicate(condition.predicate)) {
    // Guarded comparison built-in: instantiate with current bindings and
    // evaluate. Safety guarantees all variables are bound at this point.
    const ground = instantiateAtom(condition, match.bindings)
    return ground && evaluateBuiltin(ground) ? [match] : []
  }

  if (condition.naf === true) {
    // Negation as failure: succeeds iff no fact matches the literal
    // (including its strong-negation flag) under the current bindings.
    const target: PredicateAtom = { ...condition, naf: undefined }
    const hasMatch = facts.some((fact) => matchAtom(target, fact.atom, match.bindings))
    return hasMatch ? [] : [match]
  }

  // Positive or strong-negative literal: matches actual facts (matchAtom
  // requires the negated flags to agree) and binds variables.
  return facts
    .map((fact) => {
      const bindings = matchAtom(condition, fact.atom, match.bindings)
      return bindings ? { bindings, factIds: [...match.factIds, fact.id] } : undefined
    })
    .filter((item): item is RuleMatch => item !== undefined)
}

export function matchAtom(
  pattern: PredicateAtom,
  fact: PredicateAtom,
  existingBindings: BindingMap = {},
): BindingMap | undefined {
  if (pattern.predicate !== fact.predicate) return undefined
  if ((pattern.negated === true) !== (fact.negated === true)) return undefined

  const bindings: BindingMap = { ...existingBindings }
  const patternArgs = pattern.args ?? {}
  const factArgs = fact.args ?? {}

  for (const [key, patternValue] of Object.entries(patternArgs)) {
    const factValue = factArgs[key]
    if (factValue === undefined) return undefined

    if (isVariable(patternValue)) {
      const variableName = patternValue.slice(1)
      const existing = bindings[variableName]
      if (existing !== undefined && existing !== factValue) return undefined
      bindings[variableName] = factValue
      continue
    }

    if (patternValue !== factValue) return undefined
  }

  return bindings
}

/** Resolve a term (a "?var" or a literal scalar) against bindings. */
function resolveTerm(term: SemanticScalar | undefined, bindings: BindingMap): SemanticScalar | undefined {
  if (term === undefined) return undefined
  if (isVariable(term)) return bindings[term.slice(1)]
  return term
}

export function instantiateAtom(atom: PredicateAtom, bindings: BindingMap): PredicateAtom | undefined {
  const args = instantiateArgs(atom.args, bindings)
  if (args === undefined && atom.args !== undefined) return undefined
  return {
    predicate: atom.predicate,
    args,
    negated: atom.negated,
  }
}

export function instantiateArgs(args: SemanticArgs | undefined, bindings: BindingMap): SemanticArgs | undefined {
  if (!args) return undefined

  const instantiated: SemanticArgs = {}
  for (const [key, value] of Object.entries(args)) {
    if (isVariable(value)) {
      const bound = bindings[value.slice(1)]
      if (bound === undefined) return undefined
      instantiated[key] = bound
    } else {
      instantiated[key] = value
    }
  }
  return instantiated
}

/**
 * Partial instantiation: substitute bound variables, keep unbound
 * variables as-is. Used by abduction to present missing atoms with
 * their remaining degrees of freedom visible.
 */
export function substituteAtom(atom: PredicateAtom, bindings: BindingMap): PredicateAtom {
  if (!atom.args) return atom
  const args: SemanticArgs = {}
  for (const [key, value] of Object.entries(atom.args)) {
    if (isVariable(value)) {
      const bound = bindings[value.slice(1)]
      args[key] = bound !== undefined ? bound : value
    } else {
      args[key] = value
    }
  }
  return { ...atom, args }
}

export function atomHasVariables(atom: PredicateAtom): boolean {
  return Object.values(atom.args ?? {}).some((value) => isVariable(value))
}

/**
 * Does the atom hold against a fact set? Ground atoms require an exact
 * match; atoms with variables are patterns and hold when any fact
 * matches ("there exists an instance").
 */
export function findAtomInstances(
  pattern: PredicateAtom,
  facts: PredicateAtom[],
): PredicateAtom[] {
  if (!atomHasVariables(pattern)) {
    return facts.filter((fact) => atomEquals(fact, pattern))
  }
  return facts.filter((fact) => matchAtom(pattern, fact) !== undefined)
}

export function atomHolds(pattern: PredicateAtom, facts: PredicateAtom[]): boolean {
  return findAtomInstances(pattern, facts).length > 0
}

export function atomEquals(left: PredicateAtom, right: PredicateAtom): boolean {
  return atomKey(left) === atomKey(right)
}

export function atomKey(atom: PredicateAtom): string {
  const args = Object.entries(atom.args ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|')
  return `${atom.negated === true ? 'not:' : ''}${atom.predicate}|${args}`
}

export function formatAtom(atom: PredicateAtom): string {
  const args = atom.args
    ? Object.entries(atom.args).map(([key, value]) => `${key}=${value}`).join(', ')
    : ''
  const prefix = atom.naf ? 'naf ' : atom.negated ? 'not ' : ''
  return `${prefix}${atom.predicate}(${args})`
}

export function isVariable(value: SemanticScalar): value is string {
  return typeof value === 'string' && value.startsWith('?') && value.length > 1
}
