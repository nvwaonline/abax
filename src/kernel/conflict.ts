import type { PredicateAtom } from '../model/types.js'
import { atomKey, type PredicateFact } from './predicate.js'

export type PredicateConflict = {
  atom: PredicateAtom
  positiveFactId: string
  negativeFactId: string
}

export function detectPredicateConflicts(facts: PredicateFact[]): PredicateConflict[] {
  const positives = new Map<string, PredicateFact[]>()
  const negatives = new Map<string, PredicateFact[]>()

  for (const fact of facts) {
    const key = atomKey(asPositiveAtom(fact.atom))
    const bucket = fact.atom.negated === true ? negatives : positives
    bucket.set(key, [...(bucket.get(key) ?? []), fact])
  }

  const conflicts: PredicateConflict[] = []
  for (const [key, negativeFacts] of negatives) {
    const positiveFacts = positives.get(key) ?? []
    for (const positive of positiveFacts) {
      for (const negative of negativeFacts) {
        conflicts.push({
          atom: asPositiveAtom(positive.atom),
          positiveFactId: positive.id,
          negativeFactId: negative.id,
        })
      }
    }
  }

  return conflicts
}

function asPositiveAtom(atom: PredicateAtom): PredicateAtom {
  return {
    predicate: atom.predicate,
    args: atom.args,
  }
}
