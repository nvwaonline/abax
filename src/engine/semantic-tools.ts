import type { PredicateAtom, SemanticArgs, SpaceNode } from '../model/types.js'
import { assertRuleSafety } from '../kernel/safety.js'
import type { SpaceStore } from '../storage/space-store.js'
import { applySemanticRules, type SemanticRuleApplicationResult } from './semantic-rules.js'
import { formatAtom } from './semantic-derivation.js'

export type SemanticToolResult = {
  node: SpaceNode
  semanticRuleApplication: SemanticRuleApplicationResult
}

export type RetractionResult = {
  removedNodeIds: string[]
  semanticRuleApplication: SemanticRuleApplicationResult
}

export type FactRevisionResult = {
  removedNodeIds: string[]
  replacement: SemanticToolResult
}

export type DeclareGoalInput = {
  id?: string
  label: string
  summary?: string
  desired: PredicateAtom[]
  confidence?: number
  activation?: number
}

export type AssertFactInput = {
  id?: string
  label?: string
  summary?: string
  predicate: string
  args?: SemanticArgs
  negated?: boolean
  confidence?: number
  activation?: number
  evidenceRefs?: string[]
}

export type AddAxiomInput = {
  id?: string
  label: string
  summary?: string
  when: PredicateAtom[]
  then: PredicateAtom[]
  confidence?: number
  activation?: number
}

export type DefineActionInput = {
  id?: string
  label: string
  summary?: string
  action: string
  preconditions?: PredicateAtom[]
  effects?: PredicateAtom[]
  confidence?: number
  activation?: number
}

export type DeclareHypothesisInput = {
  id?: string
  label?: string
  summary?: string
  predicate: string
  args?: SemanticArgs
  negated?: boolean
  confidence?: number
  activation?: number
}

export type RetractNodeInput = {
  nodeId: string
  reason?: string
}

export type ReviseFactInput = {
  nodeId: string
  reason?: string
  id?: string
  label?: string
  summary?: string
  predicate: string
  args?: SemanticArgs
  negated?: boolean
  confidence?: number
  activation?: number
  evidenceRefs?: string[]
}

export function declareSemanticGoal(
  store: SpaceStore,
  spaceId: string,
  input: DeclareGoalInput,
): SemanticToolResult {
  const node = store.addNode(spaceId, {
    id: input.id,
    type: 'goal',
    label: input.label,
    summary: input.summary,
    confidence: input.confidence,
    activation: input.activation ?? 1,
    semantic: {
      kind: 'goal',
      desired: input.desired,
    },
    createdBy: 'agent',
  })

  return repairAndApplyRules(store, spaceId, node)
}

export function assertPredicateFact(
  store: SpaceStore,
  spaceId: string,
  input: AssertFactInput,
): SemanticToolResult {
  const atom = { predicate: input.predicate, args: input.args, negated: input.negated }
  const node = store.addNode(spaceId, {
    id: input.id,
    type: 'fact',
    label: input.label ?? formatAtom(atom),
    summary: input.summary ?? `Fact: ${formatAtom(atom)}`,
    confidence: input.confidence,
    activation: input.activation,
    evidenceRefs: input.evidenceRefs,
    semantic: {
      kind: 'predicate',
      predicate: input.predicate,
      args: input.args,
      negated: input.negated,
    },
    createdBy: 'agent',
  })

  return repairAndApplyRules(store, spaceId, node)
}

export function addSemanticAxiom(
  store: SpaceStore,
  spaceId: string,
  input: AddAxiomInput,
): SemanticToolResult {
  assertRuleSafety({ id: input.id ?? input.label, when: input.when, then: input.then })
  const node = store.addNode(spaceId, {
    id: input.id,
    type: 'axiom',
    label: input.label,
    summary: input.summary,
    confidence: input.confidence,
    activation: input.activation ?? 0.9,
    semantic: {
      kind: 'axiom',
      when: input.when,
      then: input.then,
    },
    createdBy: 'agent',
  })

  return repairAndApplyRules(store, spaceId, node)
}

export function defineSemanticAction(
  store: SpaceStore,
  spaceId: string,
  input: DefineActionInput,
): SemanticToolResult {
  const node = store.addNode(spaceId, {
    id: input.id,
    type: 'action',
    label: input.label,
    summary: input.summary,
    confidence: input.confidence,
    activation: input.activation,
    semantic: {
      kind: 'action',
      action: input.action,
      preconditions: input.preconditions,
      effects: input.effects,
    },
    createdBy: 'agent',
  })

  return repairAndApplyRules(store, spaceId, node)
}

/**
 * Declare a hypothesis: a predicate atom awaiting verification. After
 * every closure recompute the kernel judges it automatically — the atom
 * derivable means supported, its negation derivable means refuted,
 * otherwise it stays open and marks what still needs investigation.
 */
export function declareHypothesis(
  store: SpaceStore,
  spaceId: string,
  input: DeclareHypothesisInput,
): SemanticToolResult {
  const atom = { predicate: input.predicate, args: input.args, negated: input.negated }
  const node = store.addNode(spaceId, {
    id: input.id,
    type: 'hypothesis',
    label: input.label ?? formatAtom(atom),
    summary: input.summary ?? `Hypothesis: ${formatAtom(atom)}`,
    status: 'open',
    confidence: input.confidence,
    activation: input.activation,
    semantic: {
      kind: 'predicate',
      predicate: input.predicate,
      args: input.args,
      negated: input.negated,
    },
    createdBy: 'agent',
  })

  return repairAndApplyRules(store, spaceId, node)
}

export function retractNode(
  store: SpaceStore,
  spaceId: string,
  input: RetractNodeInput,
): RetractionResult {
  ensureNodeBelongsToSpace(store, spaceId, input.nodeId)

  // Physically remove the node plus every node whose evidence chain depends
  // on it, then re-run the rule closure. Conclusions still supported by the
  // remaining facts are re-derived automatically.
  const removedNodeIds = collectEvidenceDependents(store, spaceId, input.nodeId)
  for (const nodeId of removedNodeIds) {
    store.removeNode(spaceId, nodeId)
  }

  const semanticRuleApplication = applySemanticRules(store, spaceId)
  return { removedNodeIds, semanticRuleApplication }
}

function collectEvidenceDependents(
  store: SpaceStore,
  spaceId: string,
  rootNodeId: string,
): string[] {
  const removed = new Set<string>([rootNodeId])
  let changed = true

  while (changed) {
    changed = false
    for (const node of store.listNodes(spaceId)) {
      if (removed.has(node.id)) continue
      if (node.evidenceRefs.some((ref) => removed.has(ref))) {
        removed.add(node.id)
        changed = true
      }
    }
  }

  return [...removed]
}

export function revisePredicateFact(
  store: SpaceStore,
  spaceId: string,
  input: ReviseFactInput,
): FactRevisionResult {
  const retraction = retractNode(store, spaceId, {
    nodeId: input.nodeId,
    reason: input.reason,
  })
  const replacement = assertPredicateFact(store, spaceId, {
    id: input.id,
    label: input.label,
    summary: input.summary,
    predicate: input.predicate,
    args: input.args,
    negated: input.negated,
    confidence: input.confidence,
    activation: input.activation,
    evidenceRefs: input.evidenceRefs,
  })
  return { removedNodeIds: retraction.removedNodeIds, replacement }
}

function repairAndApplyRules(
  store: SpaceStore,
  spaceId: string,
  node: SpaceNode,
): SemanticToolResult {
  const semanticRuleApplication = applySemanticRules(store, spaceId)
  return { node, semanticRuleApplication }
}

function ensureNodeBelongsToSpace(
  store: SpaceStore,
  spaceId: string,
  nodeId: string,
): void {
  if (!store.listNodes(spaceId).some((node) => node.id === nodeId)) {
    throw new Error(`Node ${nodeId} does not belong to space ${spaceId}`)
  }
}
