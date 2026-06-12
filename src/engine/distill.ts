import type { PredicateAtom, SpaceNode } from '../model/types.js'
import type { SpaceStore } from '../storage/space-store.js'
import { assertRuleSafety } from '../kernel/safety.js'
import { logicallyUsableNodes } from './semantic-active.js'
import { collectPredicateVocabulary, formatVocabulary } from './vocabulary.js'

/**
 * A distilled experience capsule: what survives when a problem bubble
 * is finished. Facts and hypotheses are task-specific and die with the
 * bubble; rules are portable knowledge, results are reusable
 * conclusions, and the vocabulary anchors predicate naming for the
 * next task (the cross-task defense against vocabulary drift).
 */
export type ExperienceCapsule = {
  sourceSpaceId: string
  title: string
  axioms: Array<{
    id: string
    label: string
    summary: string
    when: PredicateAtom[]
    then: PredicateAtom[]
  }>
  results: Array<{ label: string; summary: string }>
  vocabulary: string[]
}

export function distillSpace(store: SpaceStore, spaceId: string): ExperienceCapsule {
  const space = store.getSpace(spaceId)
  const nodes = logicallyUsableNodes(store.listNodes(spaceId))

  return {
    sourceSpaceId: space.id,
    title: space.title,
    axioms: nodes.filter(isSemanticAxiom).map((node) => ({
      id: node.id,
      label: node.label,
      summary: node.summary,
      when: node.semantic.when ?? [],
      then: node.semantic.then ?? [],
    })),
    results: nodes
      .filter((node) => node.type === 'result')
      .map((node) => ({ label: node.label, summary: node.summary })),
    vocabulary: formatVocabulary(collectPredicateVocabulary(store.listNodes(spaceId))),
  }
}

/**
 * Seed a fresh space from a capsule: replant the portable rules. The
 * axioms carry their predicate signatures with them, so the vocabulary
 * largely seeds itself; the full vocabulary list is returned for the
 * agent to read alongside.
 */
export function seedSpace(
  store: SpaceStore,
  spaceId: string,
  capsule: ExperienceCapsule,
): { seededAxiomIds: string[]; vocabulary: string[]; skipped: string[] } {
  const seededAxiomIds: string[] = []
  // Capsules are an ingestion channel like any other (self-audit #29):
  // unsafe rules must not enter (they would fail LATE, at closure time,
  // poisoning every subsequent update), and "derived:" ids must not enter
  // (the next recompute would silently delete them as stale derived facts).
  const skipped: string[] = []

  for (const axiom of capsule.axioms) {
    if (axiom.id.startsWith('derived:')) {
      skipped.push(`${axiom.id}: reserved "derived:" id prefix (closure provenance)`)
      continue
    }
    try {
      assertRuleSafety({ id: axiom.id, when: axiom.when, then: axiom.then })
    } catch (error) {
      skipped.push(`${axiom.id}: ${String((error as Error).message).slice(0, 140)}`)
      continue
    }
    // Ids are scoped per space; suffix only when the target space
    // already uses the id, and skip if even that is taken.
    const id = nodeIdTaken(store, spaceId, axiom.id)
      ? `${axiom.id}@${capsule.sourceSpaceId}`
      : axiom.id
    if (nodeIdTaken(store, spaceId, id)) continue
    const node = store.addNode(spaceId, {
      id,
      type: 'axiom',
      label: axiom.label,
      summary: axiom.summary,
      status: 'verified',
      evidenceRefs: [`seed:${capsule.sourceSpaceId}`],
      semantic: { kind: 'axiom', when: axiom.when, then: axiom.then },
      createdBy: 'system',
    })
    seededAxiomIds.push(node.id)
  }

  return { seededAxiomIds, vocabulary: capsule.vocabulary, skipped }
}

function nodeIdTaken(store: SpaceStore, spaceId: string, nodeId: string): boolean {
  try {
    store.getNode(spaceId, nodeId)
    return true
  } catch {
    return false
  }
}

function isSemanticAxiom(
  node: SpaceNode,
): node is SpaceNode & { semantic: { kind: 'axiom'; when?: PredicateAtom[]; then?: PredicateAtom[] } } {
  return node.type === 'axiom' && node.semantic?.kind === 'axiom'
}
