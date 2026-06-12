import type { PredicateAtom, SpaceNode } from '../model/types.js'
import {
  atomEquals,
  atomHasVariables,
  atomHolds,
  atomKey,
  findAtomInstances,
  type PredicateFact,
} from '../kernel/predicate.js'
import { detectPredicateConflicts, type PredicateConflict } from '../kernel/conflict.js'
import { derivedFactId, evaluateStratifiedClosure } from '../kernel/stratify.js'
import type { SpaceStore } from '../storage/space-store.js'
import { indexNodesById, isNodeLogicallyUsable } from './semantic-active.js'
import type { HypothesisUpdate } from './semantic-rules.js'
import { bindPreconditions, instantiateEffect } from './action-binding.js'
import type { BindingMap } from '../kernel/predicate.js'

export type ActionSimulationResult = {
  actionNodeId: string
  applicable: boolean
  unsatisfiedPreconditions: PredicateAtom[]
  /** First precondition (matcher order) that failed, partial binding substituted. */
  failedPrecondition?: PredicateAtom
  /** The precondition binding the action would run under. */
  binding: BindingMap
  /** Number of distinct full bindings; >1 means the choice is ambiguous. */
  bindingCandidates: number
  /** EDB atoms the action would assert. */
  addedAtoms: PredicateAtom[]
  /** EDB atoms the action would delete. */
  removedAtoms: PredicateAtom[]
  /** Derived atoms that would appear, relative to the current closure. */
  newDerivedAtoms: PredicateAtom[]
  /** Derived atoms that would disappear, relative to the current closure. */
  lostDerivedAtoms: PredicateAtom[]
  /** Goals whose every desired atom holds in the simulated state. */
  wouldSatisfyGoalIds: string[]
  /** Hypothesis verdicts under the simulated state. */
  hypothesisVerdicts: HypothesisUpdate[]
  predicateConflicts: PredicateConflict[]
}

/**
 * Try an action without committing it. The simulation is a pure
 * computation over atom sets: snapshot the asserted facts, apply the
 * action's add/delete effects, recompute the closure, and report the
 * difference. The space is not touched, so candidate actions can be
 * compared side by side without polluting the world — commit the chosen
 * one with deriveActionEffects.
 */
export function simulateActionEffects(
  store: SpaceStore,
  spaceId: string,
  actionNodeId: string,
): ActionSimulationResult {
  const action = store.getNode(spaceId, actionNodeId)
  if (action.type !== 'action' || action.semantic?.kind !== 'action') {
    throw new Error(`Node is not a semantic action: ${actionNodeId}`)
  }

  const nodes = store.listNodes(spaceId)
  const nodesById = indexNodesById(nodes)
  if (!isNodeLogicallyUsable(action, nodesById)) {
    throw new Error(`Semantic action is not active: ${actionNodeId}`)
  }

  const activeNodes = nodes.filter((node) => isNodeLogicallyUsable(node, nodesById))
  const activeFacts = predicateFacts(activeNodes)
  const rules = activeNodes
    .filter((node) => node.type === 'axiom' && node.semantic?.kind === 'axiom')
    .map((node) => ({
      id: node.id,
      when: node.semantic?.when,
      then: node.semantic?.then,
    }))

  // Current state: EDB (non-derived facts) and the full active atom set.
  const currentEdb: PredicateFact[] = activeFacts
    .filter((node) => !node.id.startsWith('derived:'))
    .map((node) => ({ id: node.id, atom: factAtom(node) }))
  const currentTotalKeys = new Set(activeFacts.map((node) => atomKey(factAtom(node))))

  const preconditions = action.semantic.preconditions ?? []
  // Bind preconditions through the matcher so simulate agrees with apply:
  // ground actions bind nothing (unchanged); variable + arithmetic
  // preconditions compute values the effects then use (counted transformation).
  const bound = bindPreconditions(preconditions, currentEdb)
  if (!bound.ok) {
    return {
      actionNodeId,
      applicable: false,
      unsatisfiedPreconditions: bound.unsatisfied,
      failedPrecondition: bound.failedPrecondition,
      binding: bound.partialBinding,
      bindingCandidates: 0,
      addedAtoms: [],
      removedAtoms: [],
      newDerivedAtoms: [],
      lostDerivedAtoms: [],
      wouldSatisfyGoalIds: [],
      hypothesisVerdicts: [],
      predicateConflicts: [],
    }
  }

  // Apply effects to the EDB snapshot, instantiated with the binding.
  const effects = (action.semantic.effects ?? []).map((effect) => instantiateEffect(effect, bound.binding))
  const addedAtoms: PredicateAtom[] = []
  const removedAtoms: PredicateAtom[] = []
  let simulatedEdb = [...currentEdb]

  for (const effect of effects) {
    if (effect.negated === true) {
      const target: PredicateAtom = { predicate: effect.predicate, args: effect.args }
      const before = simulatedEdb.length
      simulatedEdb = simulatedEdb.filter((fact) => !atomEquals(fact.atom, target))
      if (simulatedEdb.length < before) removedAtoms.push(target)
      continue
    }
    if (!simulatedEdb.some((fact) => atomEquals(fact.atom, effect))) {
      addedAtoms.push(effect)
      simulatedEdb.push({ id: `sim:${atomKey(effect)}`, atom: effect })
    }
  }

  // Closures before and after, diffed on derived atoms.
  const currentClosure = evaluateStratifiedClosure({ rules, facts: currentEdb })
  const simulatedClosure = evaluateStratifiedClosure({ rules, facts: simulatedEdb })
  const currentDerived = new Map(
    currentClosure.derivations.map((d) => [derivedFactId(d.atom), d.atom]),
  )
  const simulatedDerived = new Map(
    simulatedClosure.derivations.map((d) => [derivedFactId(d.atom), d.atom]),
  )

  const newDerivedAtoms = [...simulatedDerived.entries()]
    .filter(([key]) => !currentDerived.has(key))
    .map(([, atom]) => atom)
  const lostDerivedAtoms = [...currentDerived.entries()]
    .filter(([key]) => !simulatedDerived.has(key))
    .map(([, atom]) => atom)

  // Total simulated atom set: EDB plus derived.
  const simulatedAtoms = [
    ...simulatedEdb.map((fact) => fact.atom),
    ...simulatedClosure.derivations.map((d) => d.atom),
  ]
  const simulatedKeys = new Set(simulatedAtoms.map((atom) => atomKey(atom)))

  const wouldSatisfyGoalIds = activeNodes
    .filter((node) => node.type === 'goal' && node.semantic?.kind === 'goal')
    .filter((goal) => {
      const desired = goal.semantic?.desired ?? []
      return desired.length > 0 && desired.every((atom) => atomHolds(atom, simulatedAtoms))
    })
    .map((goal) => goal.id)

  const hypothesisVerdicts: HypothesisUpdate[] = nodes
    .filter((node) => node.type === 'hypothesis' && node.semantic?.kind === 'predicate')
    .filter((node) => node.status !== 'archived')
    .map((node) => {
      const atom = factAtom(node)
      const instances = findAtomInstances(atom, simulatedAtoms)
      if (instances.length > 0) {
        return {
          nodeId: node.id,
          status: 'supported' as const,
          instances: atomHasVariables(atom) ? instances : undefined,
        }
      }
      const negatedAtom: PredicateAtom = { ...atom, negated: atom.negated !== true }
      const refuted = !atomHasVariables(atom) && simulatedKeys.has(atomKey(negatedAtom))
      return { nodeId: node.id, status: refuted ? ('refuted' as const) : ('open' as const) }
    })

  const predicateConflicts = detectPredicateConflicts([
    ...simulatedEdb,
    ...simulatedClosure.derivations.map((d) => ({ id: derivedFactId(d.atom), atom: d.atom })),
  ])

  return {
    actionNodeId,
    applicable: true,
    unsatisfiedPreconditions: [],
    binding: bound.binding,
    bindingCandidates: bound.candidates,
    addedAtoms,
    removedAtoms,
    newDerivedAtoms,
    lostDerivedAtoms,
    wouldSatisfyGoalIds,
    hypothesisVerdicts,
    predicateConflicts,
  }
}

function factAtom(node: SpaceNode): PredicateAtom {
  return {
    predicate: node.semantic?.predicate ?? node.label,
    args: node.semantic?.args,
    negated: node.semantic?.negated,
  }
}

function predicateFacts(nodes: SpaceNode[]): SpaceNode[] {
  return nodes.filter(
    (node) =>
      node.type === 'fact' &&
      node.semantic?.kind === 'predicate' &&
      typeof node.semantic.predicate === 'string',
  )
}
