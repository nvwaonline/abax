import type { PredicateAtom, SpaceNode } from '../model/types.js'
import { atomEquals, formatAtom, type BindingMap, type PredicateFact } from '../kernel/predicate.js'
import { isDerivedFactId } from '../kernel/stratify.js'
import type { SpaceStore } from '../storage/space-store.js'
import { indexNodesById, isNodeLogicallyUsable } from './semantic-active.js'
import { applySemanticRules, type SemanticRuleApplicationResult } from './semantic-rules.js'
import { bindPreconditions, instantiateEffect } from './action-binding.js'

export { atomEquals, formatAtom } from '../kernel/predicate.js'

export type ActionEffectDerivationResult = {
  actionNodeId: string
  /** False when preconditions failed and nothing was changed. */
  applied: boolean
  addedFactNodeIds: string[]
  /** Consumed facts: archived (not destroyed), so the transformation keeps its history. */
  removedFactNodeIds: string[]
  /** The event node recording what this application did (when applied). */
  eventNodeId?: string
  /** The precondition binding the effects ran under. */
  binding: BindingMap
  /** Distinct full bindings found; >1 means the chosen instance was ambiguous. */
  bindingCandidates: number
  unsatisfiedPreconditions: PredicateAtom[]
  /** First precondition (matcher order) that failed, partial binding substituted. */
  failedPrecondition?: PredicateAtom
  satisfiedGoalNodeIds: string[]
  ruleApplication?: SemanticRuleApplicationResult
}

/**
 * Apply an action to the working memory (STRIPS-style).
 *
 * Preconditions are checked against the active fact set; if any is
 * unsatisfied nothing changes. Positive effects are asserted as base
 * facts (EDB, evidence = the action). Negated effects CONSUME the
 * matching asserted facts: they are archived, not destroyed — retraction
 * means "this was never true" (physical removal + evidence cascade), but
 * consumption means "this was true and got used up", which is history
 * worth keeping. Archived facts leave the active set, so the closure,
 * goals and conflicts behave exactly as with removal; the board's listing
 * hides them. An event node records the binding and the ±diff, giving the
 * transformation an evidence trail (the board previously kept only the
 * end state — you could not tell afterwards what an apply had done).
 * The rule closure is recomputed afterwards, so derived facts and
 * hypothesis verdicts always reflect the post-action state.
 */
export function deriveActionEffects(
  store: SpaceStore,
  spaceId: string,
  actionNodeId: string,
): ActionEffectDerivationResult {
  const action = store.getNode(spaceId, actionNodeId)
  if (action.type !== 'action' || action.semantic?.kind !== 'action') {
    throw new Error(`Node is not a semantic action: ${actionNodeId}`)
  }

  const nodes = store.listNodes(spaceId)
  const nodesById = indexNodesById(nodes)
  if (!isNodeLogicallyUsable(action, nodesById)) {
    throw new Error(`Semantic action is not active: ${actionNodeId}`)
  }

  const preconditions = action.semantic.preconditions ?? []
  const effects = action.semantic.effects ?? []
  // Bind preconditions through the rule matcher: ground actions bind nothing
  // (boolean behaviour unchanged); variable preconditions + arithmetic
  // built-ins let effects use computed values (quantitative transformation).
  const bound = bindPreconditions(preconditions, activePredicateFacts(store.listNodes(spaceId)))
  if (!bound.ok) {
    return {
      actionNodeId,
      applied: false,
      addedFactNodeIds: [],
      removedFactNodeIds: [],
      binding: bound.partialBinding,
      bindingCandidates: 0,
      unsatisfiedPreconditions: bound.unsatisfied,
      failedPrecondition: bound.failedPrecondition,
      satisfiedGoalNodeIds: [],
    }
  }

  const addedFactNodeIds: string[] = []
  const removedFactNodeIds: string[] = []
  const consumedAtoms: PredicateAtom[] = []
  const producedAtoms: PredicateAtom[] = []

  for (const rawEffect of effects) {
    const effect = instantiateEffect(rawEffect, bound.binding)
    if (effect.negated === true) {
      // Consume effect: archive matching ACTIVE asserted facts (positive form).
      const target: PredicateAtom = { predicate: effect.predicate, args: effect.args }
      const current = store.listNodes(spaceId)
      const currentById = indexNodesById(current)
      for (const fact of predicateFacts(current)) {
        if (isDerivedFactId(fact.id)) continue
        if (!isNodeLogicallyUsable(fact, currentById)) continue
        if (!atomEquals(factAtom(fact), target)) continue
        store.updateNode(spaceId, fact.id, {
          status: 'archived',
          summary: `${fact.summary ?? ''} [consumed by action ${action.id}]`.trim(),
        })
        removedFactNodeIds.push(fact.id)
        consumedAtoms.push(target)
      }
      continue
    }

    const existing = findActivePredicateFact(store.listNodes(spaceId), effect)
    if (existing) continue

    const fact = store.addNode(spaceId, {
      type: 'fact',
      label: formatAtom(effect),
      summary: `Action-effect fact: ${formatAtom(effect)}`,
      status: 'verified',
      confidence: 0.9,
      activation: 0.8,
      evidenceRefs: [action.id],
      semantic: {
        kind: 'predicate',
        predicate: effect.predicate,
        args: effect.args,
        negated: effect.negated,
      },
      createdBy: 'system',
    })
    addedFactNodeIds.push(fact.id)
    producedAtoms.push(effect)
  }

  // Event record: the process trail of the transformation. The board keeps
  // state, not history — without this, nothing on the board says that (or
  // how) the action ever ran. The event cites ONLY the action: logical
  // usability is recursive over evidenceRefs, so citing the consumed
  // (archived) facts — or produced facts a later apply may consume — would
  // make the event itself unusable and silently vanish from the board (the
  // exact bug real-run #26 surfaced). A history record documents that those
  // facts WERE there; its validity must not rest on them staying active.
  // The consumed/produced atoms and node ids live in the summary text.
  const bindingText = formatBinding(bound.binding)
  const event = store.addNode(spaceId, {
    type: 'result',
    label: `applied action: ${action.semantic.action ?? action.label ?? action.id}`,
    summary:
      `consumed: ${consumedAtoms.map(formatAtom).join(', ') || 'none'}; ` +
      `produced: ${producedAtoms.map(formatAtom).join(', ') || 'none'}` +
      (bindingText ? `; binding: ${bindingText}` : '') +
      (removedFactNodeIds.length > 0 ? `; archived: ${removedFactNodeIds.join(', ')}` : ''),
    status: 'verified',
    evidenceRefs: [action.id],
    createdBy: 'system',
  })

  const ruleApplication = applySemanticRules(store, spaceId)

  return {
    actionNodeId,
    applied: true,
    addedFactNodeIds,
    removedFactNodeIds,
    eventNodeId: event.id,
    binding: bound.binding,
    bindingCandidates: bound.candidates,
    unsatisfiedPreconditions: [],
    satisfiedGoalNodeIds: ruleApplication.satisfiedGoalNodeIds,
    ruleApplication,
  }
}

export function formatBinding(binding: BindingMap): string {
  return Object.entries(binding)
    .map(([name, value]) => `?${name}=${String(value)}`)
    .join(', ')
}

function findActivePredicateFact(
  nodes: SpaceNode[],
  atom: PredicateAtom,
): SpaceNode | undefined {
  const nodesById = indexNodesById(nodes)
  return predicateFacts(nodes).find(
    (node) => isNodeLogicallyUsable(node, nodesById) && atomEquals(factAtom(node), atom),
  )
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

/** Active predicate facts as matcher inputs (for precondition binding). */
function activePredicateFacts(nodes: SpaceNode[]): PredicateFact[] {
  const nodesById = indexNodesById(nodes)
  return predicateFacts(nodes)
    .filter((node) => isNodeLogicallyUsable(node, nodesById))
    .map((node) => ({ id: node.id, atom: factAtom(node) }))
}
