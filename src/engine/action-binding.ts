import type { PredicateAtom } from '../model/types.js'
import {
  matchRule,
  matchConditions,
  orderConditionsForMatching,
  instantiateAtom,
  substituteAtom,
  atomHolds,
  formatAtom,
  isVariable,
  type BindingMap,
  type PredicateFact,
  type RuleMatch,
} from '../kernel/predicate.js'
import { isBuiltinPredicate } from '../kernel/builtins.js'

/**
 * Bind an action's preconditions against the active facts (v1.4).
 *
 * Actions used to be purely PROPOSITIONAL: preconditions only tested fact
 * presence, effects were static atoms, no variable flowed precondition →
 * effect. That made the action layer a boolean STRIPS - enough for "consume
 * H2, produce H2O" but not for COUNTED transformation ("5 mol H2, consume 2,
 * leave 3"). Routing preconditions through the rule matcher (which already
 * handles comparison AND arithmetic built-ins) gives actions variables, so a
 * reaction can compute new quantities in its preconditions and assert them in
 * its effects - the user's chemical-equation insight, in its quantitative form,
 * composing the action layer with the arithmetic built-ins.
 *
 * Ground (variable-free) preconditions still bind nothing and behave exactly
 * as before - boolean actions are unchanged.
 *
 * The binding is part of the result so callers can SHOW it: which instance
 * an action will consume must be visible, not a matter of luck. `candidates`
 * counts the distinct full bindings; >1 means the choice is ambiguous (the
 * first match is used) and callers should surface a warning.
 */
export type PreconditionBinding =
  | { ok: true; binding: BindingMap; factIds: string[]; candidates: number }
  | {
      ok: false
      /** Positive preconditions that hold for no instance (built-ins excluded - they are never facts). */
      unsatisfied: PredicateAtom[]
      /** The first literal (in matcher order) that killed the match, with the partial binding substituted in. */
      failedPrecondition?: PredicateAtom
      /** The variable bindings that were established before the failure. */
      partialBinding: BindingMap
    }

export function bindPreconditions(
  preconditions: PredicateAtom[],
  facts: PredicateFact[],
): PreconditionBinding {
  if (preconditions.length === 0) return { ok: true, binding: {}, factIds: [], candidates: 1 }
  const matches = matchRule({ id: 'action-preconditions', when: preconditions, then: [] }, facts)
  if (matches.length > 0) {
    const first = matches[0]!
    return {
      ok: true,
      binding: first.bindings,
      factIds: first.factIds,
      candidates: matches.length,
    }
  }

  // Failure diagnostics: replay the literals in the exact order the matcher
  // evaluates them and report the FIRST one that empties the match set,
  // with the partial binding substituted in. The old diagnostic ran
  // atomHolds over every literal including built-ins, which are never
  // facts - so a failing counted action listed every arithmetic literal as
  // "unsatisfied", burying the real cause in noise.
  const ordered = orderConditionsForMatching(preconditions)
  let current: RuleMatch[] = [{ bindings: {}, factIds: [] }]
  let failedPrecondition: PredicateAtom | undefined
  let partialBinding: BindingMap = {}
  for (const literal of ordered) {
    const next = matchConditions([literal], facts, current)
    if (next.length === 0) {
      partialBinding = current[0]?.bindings ?? {}
      failedPrecondition = substituteAtom(literal, partialBinding)
      break
    }
    current = next
  }

  const atomList = facts.map((fact) => fact.atom)
  const unsatisfied = preconditions.filter(
    (atom) =>
      !isBuiltinPredicate(atom.predicate) &&
      atom.naf !== true &&
      !atomHolds(atom, atomList),
  )
  return { ok: false, unsatisfied, failedPrecondition, partialBinding }
}

/**
 * Instantiate an effect atom with a precondition binding (ground it).
 * An effect variable the binding does not cover is a hard error: the old
 * silent fallback asserted facts with literal "?x" arguments (or made
 * delete effects silently match nothing). define_action now validates
 * this at definition time; this throw is defense in depth for actions
 * created before validation existed or through direct kernel APIs.
 */
export function instantiateEffect(effect: PredicateAtom, binding: BindingMap): PredicateAtom {
  const ground = instantiateAtom(effect, binding)
  if (ground) return ground
  const unbound = Object.values(effect.args ?? {})
    .filter(isVariable)
    .filter((value) => binding[value.slice(1)] === undefined)
  throw new Error(
    `action effect ${formatAtom(effect)} uses variable(s) ${unbound.join(', ')} ` +
      `not bound by the action's preconditions - add a positive precondition ` +
      `(or arithmetic literal) that binds ${unbound.join(', ')}, then redefine the action`,
  )
}
