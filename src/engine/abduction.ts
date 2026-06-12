import type { PredicateAtom } from '../model/types.js'
import { isBuiltinPredicate } from '../kernel/builtins.js'
import {
  isVariable,
  matchAtom,
  matchCondition,
  substituteAtom,
  type PredicateFact,
  type RuleDefinition,
  type RuleMatch,
} from '../kernel/predicate.js'
import { bindPreconditions } from './action-binding.js'

export type AbductionHint = {
  ruleId: string
  /** Positive body literals already satisfied by active facts. */
  satisfied: PredicateAtom[]
  /** Positive body literals with no matching active fact — what to go observe. */
  missing: PredicateAtom[]
}

export type ActionHint = {
  actionNodeId: string
  /** The action verb (for display alongside the node id). */
  action: string
  /**
   * The positive effect, as defined (variables intact): the SHAPE this
   * action can produce. Effect variables are computed by the preconditions
   * at apply time, so no concrete value is promised here.
   */
  produces: PredicateAtom
  /**
   * Whether the preconditions bind against the given facts right now —
   * judged by the same matcher simulate/apply use, so the hint and the
   * commit never disagree.
   */
  applicable: boolean
  /** When blocked: first failing precondition (matcher order), partial binding substituted. */
  blockedOn?: PredicateAtom
}

export type ActionDefinition = {
  id: string
  action: string
  preconditions: PredicateAtom[]
  effects: PredicateAtom[]
}

/**
 * Forward hint for an unproven atom: which defined actions could PRODUCE
 * it (a positive effect unifies with the target), and whether each could
 * fire right now. This is the first step toward planning: an open goal
 * whose atom is a transformation product should point at apply_action,
 * not at add_axiom — and never at "assert the fact directly", which is
 * exactly the laundering move the derivation gate blocks. Negated
 * effects are consumption and never count as producing. Applicable
 * actions sort before blocked ones.
 */
export function abduceProducingActions(
  target: PredicateAtom,
  actions: ActionDefinition[],
  facts: PredicateFact[],
): ActionHint[] {
  const hints: ActionHint[] = []
  for (const action of actions) {
    const produces = (action.effects ?? []).find(
      (effect) => effect.negated !== true && effectCanProduce(effect, target),
    )
    if (!produces) continue
    const bound = bindPreconditions(action.preconditions ?? [], facts)
    hints.push({
      actionNodeId: action.id,
      action: action.action,
      produces,
      applicable: bound.ok,
      blockedOn: bound.ok ? undefined : bound.failedPrecondition,
    })
  }
  // Stable sort: applicable first, original order within each group.
  return hints.sort((left, right) => Number(right.applicable) - Number(left.applicable))
}

/**
 * Can this (positive) effect produce the target atom? Predicates must
 * match; every ground argument the target demands must be either matched
 * exactly or left open in the effect (a variable there is computed from
 * the preconditions at apply time, so it MAY produce the wanted value).
 */
function effectCanProduce(effect: PredicateAtom, target: PredicateAtom): boolean {
  if (effect.predicate !== target.predicate) return false
  if (target.negated === true) return false // positive effects produce positive facts
  const effectArgs = effect.args ?? {}
  for (const [key, wanted] of Object.entries(target.args ?? {})) {
    if (isVariable(wanted)) continue // target leaves it open
    const offered = effectArgs[key]
    if (offered === undefined) return false // effect does not even mention the key
    if (isVariable(offered)) continue // computed at apply time - may produce it
    if (offered !== wanted) return false
  }
  return true
}

/**
 * Backward analysis for an unproven atom: find every rule whose head
 * unifies with it, instantiate the body under those bindings, and
 * report which positive literals already hold and which are missing.
 * The missing literals are exactly what an agent should observe or
 * assert next to make the closure derive the atom. naf and built-in
 * literals are evaluation conditions, not observables, so they are not
 * suggested. One level deep by design: each round of new facts yields
 * fresh, more specific hints.
 */
export function abduceMissingFacts(
  target: PredicateAtom,
  rules: RuleDefinition[],
  facts: PredicateFact[],
): AbductionHint[] {
  const hints: AbductionHint[] = []

  for (const rule of rules) {
    for (const head of rule.then ?? []) {
      const headBindings = matchAtom(head, target)
      if (!headBindings) continue

      // Walk the positive body literals while threading variable
      // bindings: a literal satisfied earlier constrains the variables
      // of the ones after it, so "missing" is judged under the bindings
      // accumulated so far (greedy, first-match representative).
      const satisfied: PredicateAtom[] = []
      const missing: PredicateAtom[] = []
      let candidates: RuleMatch[] = [{ bindings: headBindings, factIds: [] }]

      for (const literal of rule.when ?? []) {
        if (literal.naf === true || isBuiltinPredicate(literal.predicate)) continue
        const extended = candidates.flatMap((candidate) =>
          matchCondition(literal, facts, candidate),
        )
        const representative = substituteAtom(literal, candidates[0]?.bindings ?? {})
        if (extended.length > 0) {
          satisfied.push(representative)
          candidates = extended
        } else {
          missing.push(representative)
        }
      }

      if (missing.length > 0) {
        hints.push({ ruleId: rule.id, satisfied, missing })
      }
    }
  }

  // Prefer paths that are closest to completion.
  return hints.sort((left, right) => left.missing.length - right.missing.length)
}
