import type { PredicateAtom } from '../model/types.js'
import type { LogicContext, LogicContextFact } from './logic-context.js'

/**
 * Context slicing (kernel candidate #1): the logic context returns the full
 * active set, which is correct but unbounded - a long-lived board (chat +
 * many tasks, or a deep audit) overflows the model's window. This is a pure
 * PROJECTION over an already-computed context (facts are truth, everything
 * else is a view), so getLogicContext stays byte-for-byte unchanged and the
 * kernel's 65 tests are untouched.
 *
 * Relevance is deterministic and cheap: the skeleton (goals, hypotheses,
 * axioms, results, conflicts) is always kept; facts/findings are kept when
 * they relate to an OPEN goal or hypothesis - by shared predicate, shared
 * argument value, or by being disputed (contradictions always surface).
 * Recency breaks ties up to the budget.
 */

export interface SliceOptions {
  /** Max facts to keep (most relevant + most recent). Default 60. */
  maxFacts?: number
  /** Max findings to keep. Default 40. */
  maxFindings?: number
  /** Always keep these predicates regardless of relevance (e.g. 'finding'). */
  pinPredicates?: string[]
}

function argValues(atom: PredicateAtom): Set<string> {
  const out = new Set<string>()
  for (const v of Object.values(atom.args ?? {})) {
    if (typeof v === 'string' && !v.startsWith('?')) out.add(v.toLowerCase())
  }
  return out
}

function relevanceSeeds(context: LogicContext): { predicates: Set<string>; values: Set<string> } {
  const predicates = new Set<string>()
  const values = new Set<string>()
  const consider = (atoms: PredicateAtom[]): void => {
    for (const atom of atoms) {
      predicates.add(atom.predicate)
      for (const v of argValues(atom)) values.add(v)
    }
  }
  // Goals and hypotheses define what the model is working toward; a
  // satisfied goal's SUPPORTING facts are still the relevant ones, so we
  // seed from all of them regardless of satisfied/open status.
  for (const goal of context.goals) consider(goal.desired)
  for (const hyp of context.hypotheses) consider([hyp.atom])
  // Abduction hints name the predicates the model still needs to observe.
  for (const goal of context.goals) for (const h of goal.hints) consider(h.missing)
  for (const hyp of context.hypotheses) for (const h of hyp.hints) consider(h.missing)
  return { predicates, values }
}

function scoreFact(
  fact: LogicContextFact,
  seeds: { predicates: Set<string>; values: Set<string> },
): number {
  let score = 0
  if (fact.disputed) score += 100 // contradictions always surface
  if (seeds.predicates.has(fact.atom.predicate)) score += 10
  for (const v of argValues(fact.atom)) if (seeds.values.has(v)) score += 3
  if (fact.derived) score += 1 // a derived fact is a standing conclusion
  return score
}

export function sliceLogicContext(context: LogicContext, options: SliceOptions = {}): LogicContext {
  const maxFacts = options.maxFacts ?? 60
  const maxFindings = options.maxFindings ?? 40
  const pin = new Set(options.pinPredicates ?? [])
  const seeds = relevanceSeeds(context)

  // If everything already fits, slicing is a no-op (cheap fast path).
  if (context.facts.length <= maxFacts && context.findings.length <= maxFindings) {
    return context
  }

  const rank = (items: LogicContextFact[], budget: number): LogicContextFact[] => {
    if (items.length <= budget) return items
    const scored = items.map((fact, index) => ({
      fact,
      score: (pin.has(fact.atom.predicate) ? 1000 : 0) + scoreFact(fact, seeds),
      index,
    }))
    // Highest score first; recency (later index) breaks ties.
    scored.sort((a, b) => b.score - a.score || b.index - a.index)
    return scored
      .slice(0, budget)
      .sort((a, b) => a.index - b.index) // restore board order for readability
      .map((s) => s.fact)
  }

  const facts = rank(context.facts, maxFacts)
  const findings = rank(context.findings, maxFindings)

  return {
    ...context,
    facts,
    findings,
    stats: {
      ...context.stats,
      facts: facts.length,
      findings: findings.length,
    },
  }
}
