import type { PredicateAtom, SpaceNode } from '../model/types.js'
import { isBuiltinPredicate } from '../kernel/builtins.js'
import { atomHasVariables } from '../kernel/predicate.js'

/**
 * The predicate vocabulary is a projection of the working memory, not
 * stored state. It exists to fight vocabulary drift: the model sees the
 * vocabulary every round, and atoms whose argument keys deviate from
 * the registered signature yield structured warnings.
 *
 * Two registration strengths:
 * - Ground atoms (facts) define a **firm** signature: later ground atoms
 *   must match it exactly.
 * - Atoms with variables (rule literals, existential goal/hypothesis
 *   patterns) are deliberately allowed to underspecify, so they only
 *   register a **provisional** signature, which a superset can upgrade.
 */
export type PredicateSignature = { keys: string[]; provisional: boolean }
export type PredicateVocabulary = Map<string, PredicateSignature>

export function collectPredicateVocabulary(nodes: SpaceNode[]): PredicateVocabulary {
  const vocabulary: PredicateVocabulary = new Map()
  for (const node of nodes) {
    if (node.status === 'archived') continue
    for (const atom of semanticAtoms(node)) {
      registerAtom(vocabulary, atom)
    }
  }
  return vocabulary
}

export function checkAtomSignature(
  vocabulary: PredicateVocabulary,
  atom: PredicateAtom,
): string | undefined {
  if (isBuiltinPredicate(atom.predicate)) return undefined
  const known = vocabulary.get(atom.predicate)
  if (!known) return undefined

  const keys = argKeys(atom)
  const compatible = atomHasVariables(atom)
    ? // Patterns may underspecify or extend a provisional signature.
      isSubset(keys, known.keys) || (known.provisional && isSubset(known.keys, keys))
    : known.provisional
      ? isSubset(known.keys, keys)
      : sameKeys(known.keys, keys)
  if (compatible) return undefined

  return (
    `predicate signature mismatch: "${atom.predicate}(${keys.join(', ')})" ` +
    `does not match the registered signature "${atom.predicate}(${known.keys.join(', ')})". ` +
    `Reuse the registered argument keys, or revise the earlier facts if the new shape is correct.`
  )
}

export function registerAtom(vocabulary: PredicateVocabulary, atom: PredicateAtom): void {
  if (isBuiltinPredicate(atom.predicate)) return
  const keys = argKeys(atom)
  const provisional = atomHasVariables(atom)
  const known = vocabulary.get(atom.predicate)

  if (!known) {
    vocabulary.set(atom.predicate, { keys, provisional })
    return
  }
  if (known.provisional && !provisional && isSubset(known.keys, keys)) {
    // A ground atom firms up a compatible provisional signature.
    vocabulary.set(atom.predicate, { keys, provisional: false })
    return
  }
  if (known.provisional && provisional && isSubset(known.keys, keys) && keys.length > known.keys.length) {
    // A more specific pattern expands a provisional signature.
    vocabulary.set(atom.predicate, { keys, provisional: true })
  }
}

export function formatVocabulary(vocabulary: PredicateVocabulary): string[] {
  return [...vocabulary.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([predicate, signature]) => `${predicate}(${signature.keys.join(', ')})`)
}

function semanticAtoms(node: SpaceNode): PredicateAtom[] {
  const semantic = node.semantic
  if (!semantic) return []

  switch (semantic.kind) {
    case 'predicate':
      return semantic.predicate
        ? [{ predicate: semantic.predicate, args: semantic.args, negated: semantic.negated }]
        : []
    case 'axiom':
      return [...(semantic.when ?? []), ...(semantic.then ?? [])]
    case 'action':
      return [...(semantic.preconditions ?? []), ...(semantic.effects ?? [])]
    case 'goal':
      return semantic.desired ?? []
    default:
      return []
  }
}

function argKeys(atom: PredicateAtom): string[] {
  return Object.keys(atom.args ?? {}).sort((left, right) => left.localeCompare(right))
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

function isSubset(left: string[], right: string[]): boolean {
  return left.every((key) => right.includes(key))
}
