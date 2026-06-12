import type { PredicateAtom, SpaceNode } from '../model/types.js'
import { detectPredicateConflicts } from '../kernel/conflict.js'
import {
  atomHasVariables,
  atomHolds,
  type PredicateFact,
  type RuleDefinition,
} from '../kernel/predicate.js'
import type { SpaceStore } from '../storage/space-store.js'
import {
  abduceMissingFacts,
  abduceProducingActions,
  type AbductionHint,
  type ActionDefinition,
  type ActionHint,
} from './abduction.js'
import { logicallyUsableNodes } from './semantic-active.js'
import { formatAtom } from './semantic-derivation.js'
import { collectPredicateVocabulary, formatVocabulary } from './vocabulary.js'

/** Facts with this predicate are task outputs and listed under findings. */
export const FINDING_PREDICATE = 'finding'

export type LogicContextGoal = {
  nodeId: string
  label: string
  desired: PredicateAtom[]
  satisfied: boolean
  /** For unsatisfied goals: which facts would close the gap, per rule. */
  hints: AbductionHint[]
  /** For unsatisfied goals: which defined actions could produce the missing atoms. */
  actionHints: ActionHint[]
  status: SpaceNode['status']
  confidence: number
}

export type LogicContextFact = {
  nodeId: string
  atom: PredicateAtom
  status: SpaceNode['status']
  confidence: number
  evidenceRefs: string[]
  /** The rule closure stands behind this fact. */
  derived: boolean
  /** Asserted by applying an action (transformation product). */
  effect?: boolean
  /** Evidence chain touches a contradicted fact (p and not-p both active). */
  disputed?: boolean
}

export type LogicContextAxiom = {
  nodeId: string
  label: string
  when: PredicateAtom[]
  then: PredicateAtom[]
  status: SpaceNode['status']
  confidence: number
}

export type LogicContextAction = {
  nodeId: string
  label: string
  action: string
  preconditions: PredicateAtom[]
  effects: PredicateAtom[]
  status: SpaceNode['status']
  confidence: number
}

export type LogicContextNote = {
  nodeId: string
  label: string
  summary: string
  status: SpaceNode['status']
  confidence: number
  disputed?: boolean
}

export type LogicContextPredicateConflict = {
  atom: PredicateAtom
  positiveFactId: string
  negativeFactId: string
}

export type LogicContextHypothesis = {
  nodeId: string
  atom: PredicateAtom
  status: 'open' | 'supported' | 'refuted'
  /** For open hypotheses: which facts would decide them, per rule. */
  hints: AbductionHint[]
  /** For pattern hypotheses: the instances supporting them. */
  instances?: PredicateAtom[]
  label: string
  confidence: number
}

export type LogicContext = {
  spaceId: string
  title: string
  goals: LogicContextGoal[]
  facts: LogicContextFact[]
  findings: LogicContextFact[]
  hypotheses: LogicContextHypothesis[]
  axioms: LogicContextAxiom[]
  actions: LogicContextAction[]
  results: LogicContextNote[]
  conflicts: LogicContextNote[]
  predicateConflicts: LogicContextPredicateConflict[]
  vocabulary: string[]
  stats: {
    goals: number
    facts: number
    findings: number
    hypotheses: number
    openHypotheses: number
    axioms: number
    actions: number
    results: number
    conflicts: number
    predicateConflicts: number
  }
}

export function getLogicContext(store: SpaceStore, spaceId: string): LogicContext {
  const space = store.getSpace(spaceId)
  const allNodes = store.listNodes(spaceId)
  const nodes = logicallyUsableNodes(allNodes)
  const allFacts = nodes.flatMap(toLogicFact)
  const facts = allFacts.filter((fact) => fact.atom.predicate !== FINDING_PREDICATE)
  const findings = allFacts.filter((fact) => fact.atom.predicate === FINDING_PREDICATE)
  const axioms = nodes.flatMap(toLogicAxiom)

  // Abduction inputs: active rules and the full active atom set.
  const ruleDefinitions: RuleDefinition[] = axioms.map((axiom) => ({
    id: axiom.nodeId,
    when: axiom.when,
    then: axiom.then,
  }))
  const activeAtoms: PredicateFact[] = allFacts.map((fact) => ({
    id: fact.nodeId,
    atom: fact.atom,
  }))
  const activeAtomList = allFacts.map((fact) => fact.atom)
  const hintsFor = (atom: PredicateAtom): AbductionHint[] =>
    abduceMissingFacts(atom, ruleDefinitions, activeAtoms)

  // Producing-action hints: judged by the same matcher simulate/apply use.
  const actionDefinitions: ActionDefinition[] = nodes.flatMap((node) =>
    node.type === 'action' && node.semantic?.kind === 'action'
      ? [
          {
            id: node.id,
            action: node.semantic.action ?? node.label,
            preconditions: node.semantic.preconditions ?? [],
            effects: node.semantic.effects ?? [],
          },
        ]
      : [],
  )
  const actionHintsFor = (atom: PredicateAtom): ActionHint[] =>
    abduceProducingActions(atom, actionDefinitions, activeAtoms)

  const goals = nodes.flatMap((node) =>
    toLogicGoal(node, activeAtomList, hintsFor, actionHintsFor),
  )
  const hypotheses = allNodes.flatMap((node) =>
    toLogicHypothesis(node, activeAtomList, hintsFor),
  )
  const actions = nodes.flatMap(toLogicAction)
  const results = nodes.filter((node) => node.type === 'result').map(toLogicNote)
  const conflicts = nodes.filter((node) => node.type === 'conflict').map(toLogicNote)
  const predicateConflicts = detectPredicateConflicts(
    allFacts.map((fact) => ({ id: fact.nodeId, atom: fact.atom })),
  )
  const vocabulary = formatVocabulary(collectPredicateVocabulary(allNodes))

  // Paraconsistent taint: contradictions do not explode the closure, but
  // everything whose evidence chain touches a contradicted fact is
  // marked disputed so the model resolves the conflict before relying
  // on downstream conclusions.
  const disputedIds = collectDisputed(allNodes, predicateConflicts)
  for (const fact of [...facts, ...findings]) {
    if (disputedIds.has(fact.nodeId)) fact.disputed = true
  }
  for (const note of results) {
    if (disputedIds.has(note.nodeId)) note.disputed = true
  }

  return {
    spaceId: space.id,
    title: space.title,
    goals,
    facts,
    findings,
    hypotheses,
    axioms,
    actions,
    results,
    conflicts,
    predicateConflicts,
    vocabulary,
    stats: {
      goals: goals.length,
      facts: facts.length,
      findings: findings.length,
      hypotheses: hypotheses.length,
      openHypotheses: hypotheses.filter((hypothesis) => hypothesis.status === 'open').length,
      axioms: axioms.length,
      actions: actions.length,
      results: results.length,
      conflicts: conflicts.length,
      predicateConflicts: predicateConflicts.length,
    },
  }
}

export function formatLogicContextAsText(context: LogicContext): string {
  return [
    `logic_context ${context.spaceId}: ${context.title}`,
    formatSection(
      'goals',
      context.goals.flatMap((goal) => [
        `${goal.nodeId}: ${goal.desired.map(formatAtom).join(' AND ')} [${goal.satisfied ? 'satisfied' : 'open'}] (${goal.label})`,
        ...(goal.satisfied ? [] : formatGoalGuidance(goal)),
      ]),
    ),
    formatSection(
      'facts',
      context.facts.map((fact) => {
        const source = fact.derived ? 'derived' : fact.effect ? 'effect' : 'asserted'
        const disputed = fact.disputed ? ' [disputed]' : ''
        return `${fact.nodeId}: ${formatAtom(fact.atom)} [${source}]${disputed}`
      }),
    ),
    formatSection(
      'hypotheses',
      context.hypotheses.flatMap((hypothesis) => [
        `${hypothesis.nodeId}: ${formatAtom(hypothesis.atom)} [${hypothesis.status}]`,
        ...(hypothesis.instances ?? []).map(
          (instance) => `  instance: ${formatAtom(instance)}`,
        ),
        ...(hypothesis.status === 'open' ? formatHints(hypothesis.hints) : []),
      ]),
    ),
    formatSection(
      'findings',
      context.findings.map((finding) => {
        // An asserted finding is an unproven claim; a derived one is a
        // conclusion the rule engine stands behind. Keep them distinguishable.
        const source = finding.derived ? 'derived' : 'asserted, not derived'
        return `${finding.nodeId}: ${formatAtom(finding.atom)} [${source}]${finding.disputed ? ' [disputed]' : ''}`
      }),
    ),
    formatSection(
      'axioms',
      context.axioms.map(
        (axiom) =>
          `${axiom.nodeId}: IF ${axiom.when.map(formatAtom).join(' AND ')} THEN ${axiom.then
            .map(formatAtom)
            .join(' AND ')} (${axiom.label})`,
      ),
    ),
    formatSection(
      'actions',
      context.actions.map(
        (action) =>
          `${action.nodeId}: ${action.action}; PRE ${formatAtoms(action.preconditions)}; EFFECT ${formatAtoms(
            action.effects,
          )}${action.label && action.label !== action.action ? ` (${action.label})` : ''}`,
      ),
    ),
    formatSection(
      'results',
      context.results.map(
        (result) =>
          `${result.nodeId}: ${result.label} - ${result.summary}${result.disputed ? ' [disputed]' : ''}`,
      ),
    ),
    formatSection(
      'conflicts',
      [
        ...context.conflicts.map(
          (conflict) => `${conflict.nodeId}: ${conflict.label} - ${conflict.summary}`,
        ),
        ...context.predicateConflicts.map(
          (conflict) =>
            `predicate contradiction: ${conflict.positiveFactId} contradicts ${conflict.negativeFactId} on ${formatAtom(conflict.atom)}`,
        ),
      ],
    ),
    formatSection('vocabulary', context.vocabulary),
  ].join('\n')
}

function collectDisputed(
  nodes: SpaceNode[],
  conflicts: Array<{ positiveFactId: string; negativeFactId: string }>,
): Set<string> {
  const disputed = new Set<string>()
  for (const conflict of conflicts) {
    disputed.add(conflict.positiveFactId)
    disputed.add(conflict.negativeFactId)
  }
  let changed = disputed.size > 0
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (disputed.has(node.id)) continue
      if (node.evidenceRefs.some((ref) => disputed.has(ref))) {
        disputed.add(node.id)
        changed = true
      }
    }
  }
  return disputed
}

function toLogicGoal(
  node: SpaceNode,
  activeAtoms: PredicateAtom[],
  hintsFor: (atom: PredicateAtom) => AbductionHint[],
  actionHintsFor: (atom: PredicateAtom) => ActionHint[],
): LogicContextGoal[] {
  if (node.type !== 'goal' || node.semantic?.kind !== 'goal') return []
  const desired = node.semantic.desired ?? []
  const unsatisfied = desired.filter((atom) => !atomHolds(atom, activeAtoms))
  return [
    {
      nodeId: node.id,
      label: node.label,
      desired,
      satisfied: desired.length > 0 && unsatisfied.length === 0,
      hints: unsatisfied.flatMap(hintsFor),
      actionHints: unsatisfied.flatMap(actionHintsFor),
      status: node.status,
      confidence: node.confidence,
    },
  ]
}

/**
 * A fact node the rule CLOSURE stands behind, vs. a bare agent assertion.
 * This must be closure-only: the old `createdBy === 'system'` clause also
 * matched action-effect facts, which are the model's own construct (it
 * defined the action) — counting them as derived let a model launder
 * finding(...) past the record_result derivation gate by routing it
 * through an action effect, and rendered action products as [derived]
 * (conflating "the closure proved this" with "my action asserted this").
 */
export function isDerivedFactNode(node: SpaceNode): boolean {
  return (
    node.id.startsWith('derived:') ||
    node.summary.startsWith('Derived fact:') ||
    node.summary.startsWith('Rule-derived fact:')
  )
}

/** A fact asserted by applying an action (transformation product). */
export function isActionEffectFactNode(node: SpaceNode): boolean {
  return node.summary.startsWith('Action-effect fact:')
}

function toLogicFact(node: SpaceNode): LogicContextFact[] {
  if (node.type !== 'fact' || node.semantic?.kind !== 'predicate') return []
  return [
    {
      nodeId: node.id,
      atom: {
        predicate: node.semantic.predicate ?? node.label,
        args: node.semantic.args,
        negated: node.semantic.negated,
      },
      status: node.status,
      confidence: node.confidence,
      evidenceRefs: node.evidenceRefs,
      derived: isDerivedFactNode(node),
      effect: isActionEffectFactNode(node) || undefined,
    },
  ]
}

function toLogicHypothesis(
  node: SpaceNode,
  activeAtoms: PredicateAtom[],
  hintsFor: (atom: PredicateAtom) => AbductionHint[],
): LogicContextHypothesis[] {
  if (node.type !== 'hypothesis' || node.semantic?.kind !== 'predicate') return []
  if (node.status === 'archived') return []
  const status =
    node.status === 'supported' ? 'supported' : node.status === 'rejected' ? 'refuted' : 'open'
  const atom: PredicateAtom = {
    predicate: node.semantic.predicate ?? node.label,
    args: node.semantic.args,
    negated: node.semantic.negated,
  }
  const instances =
    status === 'supported' && atomHasVariables(atom)
      ? activeAtoms.filter((fact) => atomHolds(atom, [fact]))
      : undefined
  return [
    {
      nodeId: node.id,
      atom,
      status,
      hints: status === 'open' ? hintsFor(atom) : [],
      instances,
      label: node.label,
      confidence: node.confidence,
    },
  ]
}

function toLogicAxiom(node: SpaceNode): LogicContextAxiom[] {
  if (node.type !== 'axiom' || node.semantic?.kind !== 'axiom') return []
  return [
    {
      nodeId: node.id,
      label: node.label,
      when: node.semantic.when ?? [],
      then: node.semantic.then ?? [],
      status: node.status,
      confidence: node.confidence,
    },
  ]
}

function toLogicAction(node: SpaceNode): LogicContextAction[] {
  if (node.type !== 'action' || node.semantic?.kind !== 'action') return []
  return [
    {
      nodeId: node.id,
      label: node.label,
      action: node.semantic.action ?? node.label,
      preconditions: node.semantic.preconditions ?? [],
      effects: node.semantic.effects ?? [],
      status: node.status,
      confidence: node.confidence,
    },
  ]
}

function toLogicNote(node: SpaceNode): LogicContextNote {
  return {
    nodeId: node.id,
    label: node.label,
    summary: node.summary,
    status: node.status,
    confidence: node.confidence,
  }
}

function formatHints(hints: AbductionHint[]): string[] {
  if (hints.length === 0) {
    // The kernel knows no rule can derive this atom - say so instead of
    // staying silent, so the model learns to add a rule or observe directly.
    return ['  no rule derives this yet: add_axiom whose "then" matches it, or assert the fact directly']
  }
  return hints
    .slice(0, 3)
    .map(
      (hint) =>
        `  needs via ${hint.ruleId}: ${hint.missing.map(formatAtom).join(' AND ')}`,
    )
}

/**
 * Guidance lines for an open goal: rule paths (abduction) AND producing
 * actions. The bare-assertion fallback only appears when NEITHER exists —
 * with a producing action on the board, suggesting "assert the fact
 * directly" would teach exactly the laundering move the derivation gate
 * blocks (apply_action is the honest way to make the atom true).
 */
function formatGoalGuidance(goal: LogicContextGoal): string[] {
  const ruleLines =
    goal.hints.length > 0
      ? goal.hints
          .slice(0, 3)
          .map(
            (hint) =>
              `  needs via ${hint.ruleId}: ${hint.missing.map(formatAtom).join(' AND ')}`,
          )
      : []
  const actionLines = goal.actionHints.slice(0, 3).map(formatActionHint)
  if (ruleLines.length === 0 && actionLines.length === 0) {
    return ['  no rule derives this yet: add_axiom whose "then" matches it, or assert the fact directly']
  }
  return [...ruleLines, ...actionLines]
}

function formatActionHint(hint: ActionHint): string {
  const status = hint.applicable
    ? '[preconditions hold - apply_action]'
    : `[blocked on ${hint.blockedOn ? formatAtom(hint.blockedOn) : 'unsatisfied preconditions'}]`
  return `  producible via action ${hint.actionNodeId}: ${formatAtom(hint.produces)} ${status}`
}

function formatSection(title: string, lines: string[]): string {
  if (lines.length === 0) return `${title}: none`
  return [`${title}:`, ...lines.map((line) => `- ${line}`)].join('\n')
}

function formatAtoms(atoms: PredicateAtom[]): string {
  return atoms.length > 0 ? atoms.map(formatAtom).join(' AND ') : 'none'
}
