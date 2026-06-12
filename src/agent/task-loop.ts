import {
  applyWorkingMemoryOperations,
  type WorkingMemoryOperation,
} from '../engine/working-memory.js'
import { formatLogicContextAsText, getLogicContext } from '../engine/logic-context.js'
import { simulateActionEffects } from '../engine/simulate.js'
import { deriveActionEffects } from '../engine/semantic-derivation.js'
import { formatAtom } from '../kernel/predicate.js'
import type { PredicateAtom } from '../model/types.js'
import type { SpaceStore } from '../storage/space-store.js'
import { parseToolCall, type ChatMessage } from './llm.js'
import type { ToolRegistry, ToolContext } from './tools.js'

/** Minimal LLM surface the loop needs (so tests can inject a scripted model). */
export interface ChatModel {
  chat(messages: ChatMessage[]): Promise<string>
}

export interface RunAgentTaskOptions {
  store: SpaceStore
  llm: ChatModel
  reg: ToolRegistry
  rootDir: string
  goal: string
  maxTurns: number
  /** Optional rules/vocab seeded from the experience layer. */
  seedOperations?: WorkingMemoryOperation[]
  /** Receives the task's space id + process-fact recorder for follow-up (e.g. /remember). */
  onContext?: (info: { spaceId: string }, recordProcessFact: ProcessFactRecorder) => void
  /** Test hook: capture each turn's tool + result. */
  onTurn?: (turn: number, tool: string, result: string) => void
}

/** Records a harness-attested process fact onto the board (edited/build_status). */
export type ProcessFactRecorder = (kind: 'edited' | 'build_status', args: Record<string, string>) => void

function taskSystemPrompt(reg: ToolRegistry): string {
  return [
    'You are galaxy-agent running a board-driven task. Reply with EXACTLY one JSON object per turn:',
    '  {"tool": "<name>", "args": {...}, "note": "<one short why>"}',
    '',
    'You have a reasoning board (working memory + rule engine). Drive it with update_working_memory.',
    'Record observations as facts (cite evidence), derive conclusions via rules, finish with done.',
    'Board ops in update_working_memory.operations: declare_goal{id,label,desired:[atom]},',
    '  assert_fact{id,predicate,args,evidenceRefs?}, add_axiom{id,label,when:[atom],then:[atom]},',
    '  declare_hypothesis{id,predicate,args}, record_result{id,label,summary,evidenceRefs}, retract_node{nodeId}.',
    'Atoms: {"predicate":"p","args":{"k":"v"}}; variables are "?x" (rules only).',
    '',
    'Built-ins in rule BODIES (not heads): compare eq/neq/lt/lte/gt/gte{left,right};',
    'EXACT arithmetic add/sub/mul/div/mod/pow/min/max{left,right,result} and neg/abs{left,result}',
    '— do not multiply in your head, let the board compute it. The result becomes a derived fact',
    'with an evidence chain (retract an input and it disappears). Copyable template:',
    '  {"op":"add_axiom","id":"ax_cost","label":"cost = unit*qty",',
    '   "when":[{"predicate":"line","args":{"item":"?i","unit":"?u","qty":"?q"}},',
    '           {"predicate":"mul","args":{"left":"?u","right":"?q","result":"?t"}}],',
    '   "then":[{"predicate":"cost","args":{"item":"?i","total":"?t"}}]}',
    '',
    'For CONSUME/PRODUCE transformations (a reactant is used up, a product appears) use an ACTION,',
    'not a rule (rules are monotonic - they never delete). define_action then apply_action; a',
    'negated effect DELETES the matching fact (consumption), a positive effect asserts it',
    '(production). Preconditions bind variables (incl. arithmetic) usable in effects. Template:',
    '  {"op":"define_action","id":"burn","action":"combust",',
    '   "preconditions":[{"predicate":"have","args":{"species":"H2"}},{"predicate":"have","args":{"species":"O2"}}],',
    '   "effects":[{"predicate":"have","args":{"species":"H2"},"negated":true},',
    '              {"predicate":"have","args":{"species":"H2O"}}]}',
    'Then call apply_action{actionNodeId:"burn"} (or simulate_action first to preview).',
    'Open goals list "producible via action X" when a defined action could produce the missing',
    'atom - that is the cue to simulate/apply that action (NOT to assert the product yourself).',
    '',
    'For COUNTED amounts (stoichiometry, budgets, inventory) do NOT consume the whole fact -',
    'bind the current amount, guard it with gte, COMPUTE the new amount with sub/add in the',
    'preconditions, then swap old amount for new in the effects. Template (consume 2 H2, produce 2 H2O):',
    '  {"op":"define_action","id":"burn1","action":"combust_once",',
    '   "preconditions":[{"predicate":"amount","args":{"species":"H2","mol":"?h"}},',
    '                    {"predicate":"gte","args":{"left":"?h","right":2}},',
    '                    {"predicate":"sub","args":{"left":"?h","right":2,"result":"?h2"}},',
    '                    {"predicate":"amount","args":{"species":"H2O","mol":"?w"}},',
    '                    {"predicate":"add","args":{"left":"?w","right":2,"result":"?w2"}}],',
    '   "effects":[{"predicate":"amount","args":{"species":"H2","mol":"?h"},"negated":true},',
    '              {"predicate":"amount","args":{"species":"H2","mol":"?h2"}},',
    '              {"predicate":"amount","args":{"species":"H2O","mol":"?w"},"negated":true},',
    '              {"predicate":"amount","args":{"species":"H2O","mol":"?w2"}}]}',
    '(extend the same pattern per species; gte guards make the action refuse when amounts run short)',
    '',
    'Tools:',
    reg.promptSection('task'),
    '- update_working_memory {operations:[...]}  // drive the board (incl. define_action)',
    '- simulate_action {actionNodeId}            // preview an action without committing',
    '- apply_action {actionNodeId}               // commit: consume/produce facts',
    '- get_logic_context {}                       // re-read the board',
    '- done {summary}                             // finish',
  ].join('\n')
}

/**
 * Board-driven task loop for the agent (v0.1). Same shape as the validated
 * fixture loop - turn budget, board persistence, stuck-action breaker - but
 * tool dispatch goes through the registry, and update_working_memory is
 * handled inline so the kernel invariants (derivation gate, attestation
 * warnings, idempotence) apply unchanged.
 */
export async function runAgentTask(options: RunAgentTaskOptions): Promise<string> {
  const { store, llm, reg, rootDir, goal, maxTurns } = options
  const space = store.createSpace({ id: `space:agent-${Date.now()}`, title: goal.slice(0, 80) })
  const ctx: ToolContext = { rootDir, mode: 'task', evidenceLog: new Map(), metrics: {} }

  // Machine-attested process facts (edited/build_status): write tools call
  // this so fixed(...) is DERIVED from facts the harness vouches for, not
  // claimed by the model. Mirrors the validated repair-mode design.
  let buildStatusOnBoard = false
  let editSeq = 0
  const recordProcessFact: ProcessFactRecorder = (kind, args) => {
    try {
      if (kind === 'edited') {
        editSeq += 1
        applyWorkingMemoryOperations(store, space.id, [
          { op: 'assert_fact', id: `me_edit_${editSeq}`, predicate: 'edited', args, summary: 'Harness-attested: edit applied' },
        ])
      } else {
        applyWorkingMemoryOperations(store, space.id, [
          buildStatusOnBoard
            ? { op: 'revise_fact', nodeId: 'build_status', id: 'build_status', predicate: 'build_status', args, summary: 'Harness-attested build status' }
            : { op: 'assert_fact', id: 'build_status', predicate: 'build_status', args, summary: 'Harness-attested build status' },
        ])
        buildStatusOnBoard = true
      }
    } catch {
      // bookkeeping must never block a tool result
    }
  }
  options.onContext?.({ spaceId: space.id }, recordProcessFact)
  if (options.seedOperations && options.seedOperations.length > 0) {
    applyBoardOps(store, space.id, options.seedOperations)
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: taskSystemPrompt(reg) },
    { role: 'user', content: `Task: ${goal}\nStart by declaring a goal and a plan. Reply with one JSON tool call.` },
  ]

  let finished = false
  let lastFailing = ''
  let failRepeat = 0

  for (let turn = 0; turn < maxTurns && !finished; turn += 1) {
    const reply = await llm.chat(messages)
    messages.push({ role: 'assistant', content: reply })
    const call = parseToolCall(reply)
    if (!call) {
      messages.push({
        role: 'user',
        content:
          'No valid JSON tool call. Output ONE JSON object {"tool":...,"args":...}. ' +
          'If your last reply was long it was likely truncated - send a smaller batch.',
      })
      continue
    }

    let result: string
    if (call.tool === 'done') {
      finished = true
      result = `done: ${String(call.args?.summary ?? '')}`
    } else if (call.tool === 'update_working_memory') {
      result = applyBoardOps(store, space.id, (call.args?.operations ?? []) as WorkingMemoryOperation[])
    } else if (call.tool === 'get_logic_context') {
      result = formatLogicContextAsText(getLogicContext(store, space.id))
    } else if (call.tool === 'simulate_action') {
      result = runSimulateAction(store, space.id, String(call.args?.actionNodeId ?? ''))
    } else if (call.tool === 'apply_action') {
      result = runApplyAction(store, space.id, String(call.args?.actionNodeId ?? ''))
    } else {
      result = await reg.invoke(call.tool, call.args ?? {}, ctx)
    }

    options.onTurn?.(turn, call.tool, result)

    // Stuck-action breaker (fixture lesson): identical failing call repeated.
    const key = JSON.stringify(call)
    if (result.startsWith('error:')) {
      failRepeat = key === lastFailing ? failRepeat + 1 : 1
      lastFailing = key
      if (failRepeat >= 6) {
        return `aborted: model wedged on a failing "${call.tool}" call. ${boardSummary(store, space.id)}`
      }
    } else {
      failRepeat = 0
      lastFailing = ''
    }

    messages.push({ role: 'user', content: `[turn ${turn + 1}/${maxTurns}]\n${result.slice(0, 6000)}` })
  }

  return finished
    ? boardSummary(store, space.id)
    : `max turns reached. ${boardSummary(store, space.id)}`
}

function describePreconditionFailure(r: {
  failedPrecondition?: PredicateAtom
  unsatisfiedPreconditions: PredicateAtom[]
}): string {
  const lines: string[] = []
  if (r.failedPrecondition) {
    lines.push(`first failing precondition: ${formatAtom(r.failedPrecondition)}`)
    if (r.failedPrecondition.negated === true) {
      const positive = formatAtom({ ...r.failedPrecondition, negated: undefined })
      lines.push(
        `hint: "negated":true is STRONG negation - it only matches an explicit not-${positive} fact. ` +
          `To require the ABSENCE of ${positive}, use "naf":true in the precondition instead.`,
      )
    }
  }
  lines.push(
    `missing facts: ${r.unsatisfiedPreconditions.map(formatAtom).join(', ') || 'none (a guard/arithmetic literal failed, see above)'}`,
  )
  return lines.join('\n')
}

function describeBinding(binding: Record<string, unknown>, candidates: number): string {
  const text = Object.entries(binding)
    .map(([name, value]) => `?${name}=${String(value)}`)
    .join(', ')
  if (!text) return ''
  const ambiguity =
    candidates > 1
      ? ` (WARNING: ${candidates} candidate bindings matched - the first is used; add preconditions to pin the instance you mean)`
      : ''
  return `binding: ${text}${ambiguity}`
}

function runSimulateAction(store: SpaceStore, spaceId: string, actionNodeId: string): string {
  if (!actionNodeId) return 'error: actionNodeId required (the id of a define_action node)'
  try {
    const r = simulateActionEffects(store, spaceId, actionNodeId)
    if (!r.applicable) {
      return `simulate ${actionNodeId}: NOT applicable\n${describePreconditionFailure(r)}`
    }
    return [
      `simulate ${actionNodeId}: applicable`,
      describeBinding(r.binding, r.bindingCandidates),
      `would add: ${r.addedAtoms.map(formatAtom).join(', ') || 'none'}`,
      `would remove: ${r.removedAtoms.map(formatAtom).join(', ') || 'none'}`,
      `new derived: ${r.newDerivedAtoms.map(formatAtom).join(', ') || 'none'}`,
      `lost derived: ${r.lostDerivedAtoms.map(formatAtom).join(', ') || 'none'}`,
      `would satisfy goals: ${r.wouldSatisfyGoalIds.join(', ') || 'none'}`,
      r.predicateConflicts.length > 0
        ? `WARNING: would introduce ${r.predicateConflicts.length} predicate conflict(s)`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

function runApplyAction(store: SpaceStore, spaceId: string, actionNodeId: string): string {
  if (!actionNodeId) return 'error: actionNodeId required (the id of a define_action node)'
  try {
    const r = deriveActionEffects(store, spaceId, actionNodeId)
    if (!r.applied) {
      return `apply ${actionNodeId}: blocked\n${describePreconditionFailure(r)}`
    }
    const header = [
      `applied ${actionNodeId}: +${r.addedFactNodeIds.length} fact(s), -${r.removedFactNodeIds.length} fact(s) (consumed facts are archived, see event ${r.eventNodeId ?? ''})`,
      describeBinding(r.binding, r.bindingCandidates),
    ]
      .filter(Boolean)
      .join('\n')
    return `${header}\n${formatLogicContextAsText(getLogicContext(store, spaceId))}`
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

function applyBoardOps(store: SpaceStore, spaceId: string, ops: WorkingMemoryOperation[]): string {
  try {
    const result = applyWorkingMemoryOperations(store, spaceId, ops, { format: 'text' })
    const warnings = result.warnings.map((w) => `warning: ${w}`).join('\n')
    return [warnings, result.workingMemoryText ?? ''].filter(Boolean).join('\n')
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

function boardSummary(store: SpaceStore, spaceId: string): string {
  const board = getLogicContext(store, spaceId)
  const results = board.results.map((r) => `- ${r.label}: ${r.summary}`).join('\n')
  return results || `(${board.stats.facts} facts, ${board.stats.findings} findings, no recorded result)`
}
