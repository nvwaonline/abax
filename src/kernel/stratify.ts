import type { PredicateAtom } from '../model/types.js'
import {
  atomKey,
  instantiateAtom,
  matchRule,
  type PredicateFact,
  type RuleDefinition,
} from './predicate.js'
import { assertRuleSafety } from './safety.js'

/** Per-stratum fixpoint iteration cap (env-overridable). Protects against
 * divergent recursive arithmetic; pure logic closures need far fewer. */
const MAX_CLOSURE_ITERATIONS = Number(process.env.GALAXY_MAX_CLOSURE_ITERATIONS ?? 100000)

export class ClosureDivergenceError extends Error {
  constructor(stratum: number, factCount: number) {
    super(
      `closure did not converge within ${MAX_CLOSURE_ITERATIONS} iterations at stratum ${stratum} ` +
        `(${factCount} facts and growing) — likely a recursive arithmetic rule generating unbounded values. ` +
        `Bound it with a comparison guard (e.g. lt) or remove the recursion.`,
    )
    this.name = 'ClosureDivergenceError'
  }
}

export type StratifiedDerivation = {
  ruleId: string
  atom: PredicateAtom
  sourceFactIds: string[]
}

export type StratifiedClosureResult = {
  derivations: StratifiedDerivation[]
  appliedRuleIds: string[]
  strataCount: number
}

export class StratificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StratificationError'
  }
}

/**
 * Assign each rule a stratum so that negation-as-failure is sound:
 * a rule may only apply naf to predicates whose derivation is complete
 * in a strictly lower stratum. Strong-negative literals are ordinary
 * dependencies (they match explicit negative facts). Programs with a
 * negative dependency cycle cannot be stratified and are rejected.
 */
export function stratifyRules(rules: RuleDefinition[]): Map<string, number> {
  const predicateStratum = new Map<string, number>()
  const predicates = new Set<string>()

  for (const rule of rules) {
    for (const atom of rule.when ?? []) predicates.add(atom.predicate)
    for (const atom of rule.then ?? []) predicates.add(atom.predicate)
  }
  for (const predicate of predicates) predicateStratum.set(predicate, 0)

  const maxStratum = predicates.size + 1
  let changed = true
  while (changed) {
    changed = false
    for (const rule of rules) {
      let required = 0
      for (const condition of rule.when ?? []) {
        const bodyStratum = predicateStratum.get(condition.predicate) ?? 0
        required = Math.max(
          required,
          condition.naf === true ? bodyStratum + 1 : bodyStratum,
        )
      }
      for (const head of rule.then ?? []) {
        const current = predicateStratum.get(head.predicate) ?? 0
        if (required > current) {
          if (required > maxStratum) {
            throw new StratificationError(
              `Rules cannot be stratified: negative dependency cycle involving predicate "${head.predicate}"`,
            )
          }
          predicateStratum.set(head.predicate, required)
          changed = true
        }
      }
    }
  }

  const ruleStratum = new Map<string, number>()
  for (const rule of rules) {
    const stratum = Math.max(
      0,
      ...(rule.then ?? []).map((head) => predicateStratum.get(head.predicate) ?? 0),
    )
    ruleStratum.set(rule.id, stratum)
  }
  return ruleStratum
}

/**
 * Full stratified closure: evaluate rules stratum by stratum, each to
 * fixpoint. The base facts are never mutated; every derivation carries
 * provenance (rule id + source fact ids). Derived atom ids are
 * deterministic (`derived:` + atom key) so recomputation is stable.
 */
export function evaluateStratifiedClosure(input: {
  rules: RuleDefinition[]
  facts: PredicateFact[]
}): StratifiedClosureResult {
  for (const rule of input.rules) {
    assertRuleSafety(rule)
  }
  const ruleStratum = stratifyRules(input.rules)
  const strataCount =
    input.rules.length === 0 ? 0 : Math.max(...ruleStratum.values()) + 1

  const facts: PredicateFact[] = [...input.facts]
  const knownKeys = new Set(facts.map((fact) => atomKey(fact.atom)))
  const derivations: StratifiedDerivation[] = []
  const appliedRuleIds = new Set<string>()

  for (let stratum = 0; stratum < strataCount; stratum += 1) {
    const rules = input.rules.filter((rule) => ruleStratum.get(rule.id) === stratum)
    if (rules.length === 0) continue

    let changed = true
    let iterations = 0
    while (changed) {
      changed = false
      // Runaway guard: value-producing arithmetic built-ins can, in a
      // recursive rule, generate facts without bound (count-to-infinity).
      // Pure predicate/comparison closures converge well within this cap;
      // exceeding it means a divergent arithmetic recursion - fail loudly
      // instead of hanging, the same "fail visibly" discipline used elsewhere.
      if (iterations++ > MAX_CLOSURE_ITERATIONS) {
        throw new ClosureDivergenceError(stratum, facts.length)
      }
      for (const rule of rules) {
        for (const match of matchRule(rule, facts)) {
          for (const conclusion of rule.then ?? []) {
            const atom = instantiateAtom(conclusion, match.bindings)
            if (!atom) continue
            const key = atomKey(atom)
            if (knownKeys.has(key)) continue

            knownKeys.add(key)
            derivations.push({ ruleId: rule.id, atom, sourceFactIds: match.factIds })
            facts.push({ id: derivedFactId(atom), atom })
            appliedRuleIds.add(rule.id)
            changed = true
          }
        }
      }
    }
  }

  return { derivations, appliedRuleIds: [...appliedRuleIds], strataCount }
}

export function derivedFactId(atom: PredicateAtom): string {
  return `derived:${atomKey(atom)}`
}

export function isDerivedFactId(nodeId: string): boolean {
  return nodeId.startsWith('derived:')
}
