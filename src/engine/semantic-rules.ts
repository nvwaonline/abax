import type { PredicateAtom, SemanticArgs, SpaceNode } from '../model/types.js'
import type { PredicateFact, RuleDefinition } from '../kernel/predicate.js'
import {
  atomHasVariables,
  atomHolds,
  atomKey,
  findAtomInstances,
  formatAtom,
} from '../kernel/predicate.js'
import {
  derivedFactId,
  evaluateStratifiedClosure,
  isDerivedFactId,
} from '../kernel/stratify.js'
import type { SpaceStore } from '../storage/space-store.js'
import { indexNodesById, isNodeLogicallyUsable, logicallyUsableNodes } from './semantic-active.js'

export type HypothesisUpdate = {
  nodeId: string
  status: 'open' | 'supported' | 'refuted'
  /** For pattern (non-ground) hypotheses: the instances that support it. */
  instances?: PredicateAtom[]
}

export type SemanticRuleApplicationResult = {
  strataCount: number
  appliedRuleNodeIds: string[]
  addedFactNodeIds: string[]
  removedFactNodeIds: string[]
  satisfiedGoalNodeIds: string[]
  hypothesisUpdates: HypothesisUpdate[]
}

/**
 * Recompute the rule closure of a space from scratch.
 *
 * Truth = asserted facts (EDB) + stratified closure (IDB). Derived facts
 * are a cache with deterministic ids; this function diffs the desired
 * closure against the materialized one, removes stale derived facts,
 * creates missing ones with provenance in `evidenceRefs` (rule id first,
 * then source fact ids), reports satisfied goals, and judges open
 * hypotheses. It is idempotent.
 */
export function applySemanticRules(
  store: SpaceStore,
  spaceId: string,
): SemanticRuleApplicationResult {
  const nodes = store.listNodes(spaceId)
  const activeNodes = logicallyUsableNodes(nodes)
  const rules = activeNodes.filter(isSemanticAxiom)
  const baseFacts = predicateFacts(activeNodes)
    .filter((node) => !isDerivedFactId(node.id))
    .map(toPredicateFact)

  const closure = evaluateStratifiedClosure({
    rules: rules.map(toRuleDefinition),
    facts: baseFacts,
  })

  const desired = new Map(
    closure.derivations.map((derivation) => [derivedFactId(derivation.atom), derivation]),
  )

  // Remove materialized derived facts that the closure no longer supports.
  const removedFactNodeIds: string[] = []
  for (const node of nodes) {
    if (isDerivedFactId(node.id) && !desired.has(node.id)) {
      store.removeNode(spaceId, node.id)
      removedFactNodeIds.push(node.id)
    }
  }

  // Materialize derivations that are not in the working memory yet.
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]))
  const existingIds = new Set(store.listNodes(spaceId).map((node) => node.id))
  const addedFactNodeIds: string[] = []
  const appliedRuleNodeIds = new Set<string>()

  const nodesById = indexNodesById(nodes)
  for (const [nodeId, derivation] of desired) {
    appliedRuleNodeIds.add(derivation.ruleId)
    if (existingIds.has(nodeId)) {
      // Refresh provenance: the closure may now support this fact via a
      // DIFFERENT derivation (e.g. the original source was consumed by an
      // action while an alternative rule still holds). Stale evidenceRefs
      // pointing at archived sources would hide the fact from the board -
      // usability cascades along the evidence chain (external review P1).
      const fresh = [derivation.ruleId, ...derivation.sourceFactIds]
      const node = nodesById.get(nodeId)
      if (
        node &&
        (node.evidenceRefs.length !== fresh.length ||
          node.evidenceRefs.some((ref, i) => ref !== fresh[i]))
      ) {
        store.updateNode(spaceId, nodeId, { evidenceRefs: fresh })
      }
      continue
    }

    const rule = ruleById.get(derivation.ruleId)
    const fact = store.addNode(spaceId, {
      id: nodeId,
      type: 'fact',
      label: formatAtom(derivation.atom),
      summary: `Rule-derived fact: ${formatAtom(derivation.atom)}`,
      status: 'verified',
      confidence: rule?.confidence ?? 0.9,
      activation: Math.max(0.7, rule?.activation ?? 0.7),
      evidenceRefs: [derivation.ruleId, ...derivation.sourceFactIds],
      semantic: {
        kind: 'predicate',
        predicate: derivation.atom.predicate,
        args: derivation.atom.args,
        negated: derivation.atom.negated,
      },
      createdBy: 'system',
    })
    addedFactNodeIds.push(fact.id)
  }

  const satisfiedGoalNodeIds = collectSatisfiedGoals(store, spaceId)
  const hypothesisUpdates = judgeHypotheses(store, spaceId)

  return {
    strataCount: closure.strataCount,
    appliedRuleNodeIds: [...appliedRuleNodeIds],
    addedFactNodeIds,
    removedFactNodeIds,
    satisfiedGoalNodeIds,
    hypothesisUpdates,
  }
}

function collectSatisfiedGoals(store: SpaceStore, spaceId: string): string[] {
  const nodes = store.listNodes(spaceId)
  const nodesById = indexNodesById(nodes)
  const activeAtoms = predicateFacts(nodes)
    .filter((node) => isNodeLogicallyUsable(node, nodesById))
    .map(factAtom)

  return nodes
    .filter(isSemanticGoal)
    .filter((goal) => isNodeLogicallyUsable(goal, nodesById))
    .filter((goal) => {
      const desired = goal.semantic.desired ?? []
      // Desired atoms may be patterns: "?x" means "any instance".
      return desired.length > 0 && desired.every((atom) => atomHolds(atom, activeAtoms))
    })
    .map((goal) => goal.id)
}

function judgeHypotheses(store: SpaceStore, spaceId: string): HypothesisUpdate[] {
  const nodes = store.listNodes(spaceId)
  const nodesById = indexNodesById(nodes)
  const activeAtoms = predicateFacts(nodes)
    .filter((node) => isNodeLogicallyUsable(node, nodesById))
    .map(factAtom)

  const updates: HypothesisUpdate[] = []
  for (const node of nodes) {
    if (node.type !== 'hypothesis' || node.semantic?.kind !== 'predicate') continue
    if (node.status === 'archived') continue

    const atom: PredicateAtom = factAtom(
      node as SpaceNode & { semantic: { predicate?: string; args?: SemanticArgs; negated?: boolean } },
    )

    const instances = findAtomInstances(atom, activeAtoms)
    let verdict: HypothesisUpdate['status'] = 'open'
    if (instances.length > 0) {
      verdict = 'supported'
    } else if (!atomHasVariables(atom)) {
      // Only ground hypotheses can be refuted: an explicit negated
      // counterpart proves "not p". A pattern (∃x) cannot be refuted by
      // any finite set of negative instances, so it stays open.
      const negatedAtom: PredicateAtom = { ...atom, negated: atom.negated !== true }
      if (activeAtoms.some((fact) => atomKey(fact) === atomKey(negatedAtom))) {
        verdict = 'refuted'
      }
    }

    const status =
      verdict === 'supported' ? 'supported' : verdict === 'refuted' ? 'rejected' : 'open'
    if (node.status !== status) {
      store.updateNode(spaceId, node.id, { status })
    }
    updates.push({
      nodeId: node.id,
      status: verdict,
      instances: atomHasVariables(atom) && instances.length > 0 ? instances : undefined,
    })
  }
  return updates
}

function factAtom(
  node: SpaceNode & { semantic: { predicate?: string; args?: SemanticArgs; negated?: boolean } },
): PredicateAtom {
  return {
    predicate: node.semantic.predicate ?? node.label,
    args: node.semantic.args,
    negated: node.semantic.negated,
  }
}

function predicateFacts(
  nodes: SpaceNode[],
): Array<SpaceNode & { semantic: { kind: 'predicate'; predicate: string; args?: SemanticArgs; negated?: boolean } }> {
  return nodes.filter((node): node is SpaceNode & { semantic: { kind: 'predicate'; predicate: string; args?: SemanticArgs; negated?: boolean } } => (
    node.type === 'fact' &&
    node.semantic?.kind === 'predicate' &&
    typeof node.semantic.predicate === 'string'
  ))
}

function isSemanticAxiom(
  node: SpaceNode,
): node is SpaceNode & { semantic: { kind: 'axiom'; when?: PredicateAtom[]; then?: PredicateAtom[] } } {
  return node.type === 'axiom' && node.semantic?.kind === 'axiom'
}

function isSemanticGoal(
  node: SpaceNode,
): node is SpaceNode & { semantic: { kind: 'goal'; desired?: PredicateAtom[] } } {
  return node.type === 'goal' && node.semantic?.kind === 'goal'
}

function toPredicateFact(
  node: SpaceNode & { semantic: { kind: 'predicate'; predicate: string; args?: SemanticArgs; negated?: boolean } },
): PredicateFact {
  return { id: node.id, atom: factAtom(node) }
}

function toRuleDefinition(
  node: SpaceNode & { semantic: { kind: 'axiom'; when?: PredicateAtom[]; then?: PredicateAtom[] } },
): RuleDefinition {
  return {
    id: node.id,
    when: node.semantic.when,
    then: node.semantic.then,
  }
}
