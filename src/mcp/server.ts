import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatAtom } from '../kernel/predicate.js'
import type { SpaceStore } from '../storage/space-store.js'
import { deriveActionEffects } from '../engine/semantic-derivation.js'
import { simulateActionEffects } from '../engine/simulate.js'
import { distillSpace, seedSpace } from '../engine/distill.js'
import { formatLogicContextAsText, getLogicContext } from '../engine/logic-context.js'
import {
  applyWorkingMemoryOperations,
  type WorkingMemoryOperation,
} from '../engine/working-memory.js'

const semanticScalarSchema = z.union([z.string(), z.number(), z.boolean()])
const semanticArgsSchema = z.record(z.string(), semanticScalarSchema)

const atomSchema = z.object({
  predicate: z.string(),
  args: semanticArgsSchema.optional(),
  negated: z.boolean().optional().describe('Strong negation: "verified that not p".'),
  naf: z
    .boolean()
    .optional()
    .describe('Negation as failure ("p cannot be proven"). Rule bodies and action preconditions - the way to require ABSENCE of a fact.'),
})

const operationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('declare_goal'),
    id: z.string().optional(),
    label: z.string(),
    summary: z.string().optional(),
    desired: z.array(atomSchema),
  }),
  z.object({
    op: z.literal('assert_fact'),
    id: z.string().optional(),
    label: z.string().optional(),
    summary: z.string().optional(),
    predicate: z.string(),
    args: semanticArgsSchema.optional(),
    negated: z.boolean().optional(),
    evidenceRefs: z
      .array(z.string())
      .optional()
      .describe('Provenance, e.g. ["tool:grep"] or ids of supporting entries.'),
  }),
  z.object({
    op: z.literal('declare_hypothesis'),
    id: z.string().optional(),
    label: z.string().optional(),
    summary: z.string().optional(),
    predicate: z.string(),
    args: semanticArgsSchema.optional(),
    negated: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('add_axiom'),
    id: z.string().optional(),
    label: z.string(),
    summary: z.string().optional(),
    when: z.array(atomSchema),
    then: z.array(atomSchema),
  }),
  z.object({
    op: z.literal('define_action'),
    id: z.string().optional(),
    label: z.string(),
    summary: z.string().optional(),
    action: z.string(),
    preconditions: z.array(atomSchema).optional(),
    effects: z
      .array(atomSchema)
      .optional()
      .describe('Positive atoms are asserted; negated atoms delete the matching fact.'),
  }),
  z.object({
    op: z.literal('record_result'),
    id: z.string().optional(),
    label: z.string(),
    summary: z.string().optional(),
    evidenceRefs: z
      .array(z.string())
      .optional()
      .describe('Ids of the facts/findings this conclusion rests on.'),
  }),
  z.object({
    op: z.literal('record_conflict'),
    id: z.string().optional(),
    label: z.string(),
    summary: z.string().optional(),
    evidenceRefs: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal('retract_node'),
    nodeId: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    op: z.literal('revise_fact'),
    nodeId: z.string(),
    reason: z.string().optional(),
    id: z.string().optional(),
    label: z.string().optional(),
    summary: z.string().optional(),
    predicate: z.string(),
    args: semanticArgsSchema.optional(),
    negated: z.boolean().optional(),
    evidenceRefs: z.array(z.string()).optional(),
  }),
])

const PROTOCOL_NOTES = [
  'Predicate conventions: use the same predicate name and argument keys every round',
  '(check the vocabulary section of the working memory; signature mismatches return warnings).',
  'Variables are strings starting with "?" and may only appear in rules.',
  'Comparison built-ins eq/neq/lt/lte/gt/gte(left, right) may appear in rule bodies.',
  'Arithmetic built-ins add/sub/mul/div/mod/pow/min/max(left, right, result) and neg/abs(left, result)',
  'compute EXACT values in rule bodies and bind result - do not do arithmetic in your head, let the',
  'board derive it (the product becomes a derived fact with an evidence chain). Copyable template:',
  '{"op":"add_axiom","id":"ax_cost","label":"cost = unit*qty","when":[{"predicate":"line","args":{"item":"?i","unit":"?u","qty":"?q"}},{"predicate":"mul","args":{"left":"?u","right":"?q","result":"?t"}}],"then":[{"predicate":"cost","args":{"item":"?i","total":"?t"}}]}',
  'Built-ins go in rule WHEN bodies only - never in then, never in action effects.',
  'For consume/produce transformations use define_action (negated effect = consume, positive = produce)',
  'then apply_action - rules are monotonic and never delete; actions do.',
  'For COUNTED amounts (stoichiometry, budgets, inventory): bind the current amount in a precondition,',
  'guard with gte, compute the new amount with sub/add (also in preconditions), then swap the amount',
  'fact in the effects (negated old + positive new). Consumed facts are archived with an event record,',
  'not destroyed. Copyable counted-action template:',
  '{"op":"define_action","id":"burn1","action":"consume_two","preconditions":[{"predicate":"amount","args":{"species":"H2","mol":"?h"}},{"predicate":"gte","args":{"left":"?h","right":2}},{"predicate":"sub","args":{"left":"?h","right":2,"result":"?h2"}}],"effects":[{"predicate":"amount","args":{"species":"H2","mol":"?h"},"negated":true},{"predicate":"amount","args":{"species":"H2","mol":"?h2"}}]}',
  'negated:true is STRONG negation (an explicit not-p fact; in effects it deletes the matching fact).',
  'naf:true means "cannot be proven" and is the way to require ABSENCE in rule bodies and action',
  'preconditions - do not use negated for absence checks.',
  'Open goals list "producible via action X" when a defined action could produce the missing atom -',
  'simulate/apply that action instead of asserting the product yourself.',
  'To correct a mistake use retract_node or revise_fact - never assert a contradicting',
  'fact on top. Retraction physically removes the entry and everything resting on it,',
  'then re-derives whatever is still supported.',
  'Findings must be derived, not asserted: record_result is rejected while any positive',
  'finding(...) fact is asserted rather than rule-derived. Assert the primitive observation',
  'you verified, add a rule deriving finding(...) from it, and let the closure produce the finding.',
].join(' ')

export function createGalaxyCoreMcpServer(store: SpaceStore): McpServer {
  const server = new McpServer({ name: 'abax', version: '0.2.0' })

  server.registerTool(
    'create_space',
    {
      title: 'create_space',
      description:
        'Create a working-memory space for one task. Do this once per task, then drive everything through update_working_memory. ' +
        'Pass seedFromSpaceId to replant the verified rules and predicate vocabulary of a finished space - reuse experience and keep predicate names consistent across tasks.',
      inputSchema: {
        id: z.string().optional(),
        title: z.string(),
        scopes: z.array(z.string()).optional(),
        seedFromSpaceId: z.string().optional(),
      },
    },
    guard(async ({ seedFromSpaceId, ...input }) => {
      const space = store.createSpace(input)
      const lines = [`created space ${space.id}: ${space.title}`]
      if (seedFromSpaceId) {
        const seeded = seedSpace(store, space.id, distillSpace(store, seedFromSpaceId))
        lines.push(
          `seeded ${seeded.seededAxiomIds.length} rule(s) from ${seedFromSpaceId}: ${seeded.seededAxiomIds.join(', ') || 'none'}`,
          `inherited vocabulary: ${seeded.vocabulary.join(', ') || 'none'}`,
        )
      }
      return textResult(lines.join('\n'))
    }),
  )

  server.registerTool(
    'distill_space',
    {
      title: 'distill_space',
      description:
        'Distill a finished space into an experience capsule: its verified rules, recorded conclusions, and predicate vocabulary. ' +
        'Task-specific facts and hypotheses are not included. Use the capsule to review what was learned, or seed a new space via create_space.seedFromSpaceId.',
      inputSchema: {
        spaceId: z.string(),
      },
    },
    guard(async ({ spaceId }: { spaceId: string }) => {
      return textResult(JSON.stringify(distillSpace(store, spaceId), null, 2))
    }),
  )

  server.registerTool(
    'list_spaces',
    {
      title: 'list_spaces',
      description: 'List existing working-memory spaces.',
      inputSchema: {},
    },
    guard(async () => {
      const spaces = store.listSpaces()
      if (spaces.length === 0) return textResult('no spaces')
      return textResult(spaces.map((space) => `${space.id}: ${space.title}`).join('\n'))
    }),
  )

  server.registerTool(
    'update_working_memory',
    {
      title: 'update_working_memory',
      description:
        'Submit a batch of working-memory operations (declare_goal, assert_fact, declare_hypothesis, add_axiom, define_action, record_result, record_conflict, retract_node, revise_fact). ' +
        'The kernel applies them, recomputes the rule closure once, and returns the updated working memory: derived facts, goal satisfaction, ' +
        'hypothesis verdicts (open/supported/refuted), and "needs via <rule>: ..." hints that tell you exactly which facts to observe next. ' +
        'Read the returned state instead of calling get_logic_context again. ' +
        PROTOCOL_NOTES,
      inputSchema: {
        spaceId: z.string(),
        operations: z.array(operationSchema),
      },
    },
    guard(async ({ spaceId, operations }: { spaceId: string; operations: unknown[] }) => {
      const result = applyWorkingMemoryOperations(
        store,
        spaceId,
        operations as WorkingMemoryOperation[],
        { format: 'text' },
      )
      const lines: string[] = []
      if (result.warnings.length > 0) {
        lines.push('warnings:', ...result.warnings.map((warning) => `- ${warning}`), '')
      }
      const closure = result.semanticRuleApplication
      lines.push(
        `applied ${operations.length} operation(s); derived +${closure.addedFactNodeIds.length}/-${closure.removedFactNodeIds.length} fact(s)`,
        '',
        result.workingMemoryText ?? '',
      )
      return textResult(lines.join('\n'))
    }),
  )

  server.registerTool(
    'simulate_action',
    {
      title: 'simulate_action',
      description:
        'Try a defined action WITHOUT committing it: returns which facts it would add/remove, which derived conclusions would appear or disappear, ' +
        'which goals it would satisfy, and how hypothesis verdicts would change. Nothing is written. ' +
        'Use this to compare candidate actions side by side, then commit the chosen one with apply_action.',
      inputSchema: {
        spaceId: z.string(),
        actionNodeId: z.string(),
      },
    },
    guard(async ({ spaceId, actionNodeId }: { spaceId: string; actionNodeId: string }) => {
      const result = simulateActionEffects(store, spaceId, actionNodeId)
      if (!result.applicable) {
        return textResult(
          [
            `simulate ${actionNodeId}: NOT applicable`,
            result.failedPrecondition
              ? `first failing precondition: ${formatAtom(result.failedPrecondition)}`
              : '',
            nafHint(result.failedPrecondition),
            `missing facts: ${result.unsatisfiedPreconditions.map(formatAtom).join(' AND ') || 'none (a guard/arithmetic literal failed)'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }
      return textResult(
        [
          `simulate ${actionNodeId}: applicable`,
          bindingLine(result.binding, result.bindingCandidates),
          `would assert: ${formatAtoms(result.addedAtoms)}`,
          `would delete: ${formatAtoms(result.removedAtoms)}`,
          `new derived: ${formatAtoms(result.newDerivedAtoms)}`,
          `lost derived: ${formatAtoms(result.lostDerivedAtoms)}`,
          `would satisfy goals: ${result.wouldSatisfyGoalIds.join(', ') || 'none'}`,
          `hypothesis verdicts: ${
            result.hypothesisVerdicts.map((v) => `${v.nodeId}=${v.status}`).join(', ') || 'none'
          }`,
          `predicate conflicts: ${result.predicateConflicts.length}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }),
  )

  server.registerTool(
    'apply_action',
    {
      title: 'apply_action',
      description:
        'Commit a defined action: asserts its positive effects as facts, deletes facts matched by negated effects, then recomputes the closure. ' +
        'Fails softly when preconditions are unsatisfied (returns the gap, writes nothing). ' +
        'Applying an action is a decision - prefer simulate_action first when choosing between candidates.',
      inputSchema: {
        spaceId: z.string(),
        actionNodeId: z.string(),
      },
    },
    guard(async ({ spaceId, actionNodeId }: { spaceId: string; actionNodeId: string }) => {
      const result = deriveActionEffects(store, spaceId, actionNodeId)
      if (!result.applied) {
        return textResult(
          [
            `apply ${actionNodeId}: NOT applied`,
            result.failedPrecondition
              ? `first failing precondition: ${formatAtom(result.failedPrecondition)}`
              : '',
            nafHint(result.failedPrecondition),
            `missing facts: ${result.unsatisfiedPreconditions.map(formatAtom).join(' AND ') || 'none (a guard/arithmetic literal failed)'}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }
      const context = formatLogicContextAsText(getLogicContext(store, spaceId))
      return textResult(
        [
          `applied ${actionNodeId}: +${result.addedFactNodeIds.length}/-${result.removedFactNodeIds.length} fact(s); satisfied goals: ${result.satisfiedGoalNodeIds.join(', ') || 'none'}`,
          bindingLine(result.binding, result.bindingCandidates),
          '',
          context,
        ]
          .filter((line, index) => line !== '' || index === 2)
          .join('\n'),
      )
    }),
  )

  server.registerTool(
    'get_logic_context',
    {
      title: 'get_logic_context',
      description:
        'Read the current working memory: goals (with satisfied flag and missing-fact hints), facts, hypotheses (with hints), findings, ' +
        'axioms, actions, results, conflicts, and the predicate vocabulary. ' +
        'Write operations already return this - call it only when you need to re-read the state.',
      inputSchema: {
        spaceId: z.string(),
      },
    },
    guard(async ({ spaceId }: { spaceId: string }) => {
      return textResult(formatLogicContextAsText(getLogicContext(store, spaceId)))
    }),
  )

  return server
}

/** Teach naf-vs-negated at the moment a strong-negated literal fails. */
function nafHint(atom?: Parameters<typeof formatAtom>[0]): string {
  if (!atom || atom.negated !== true) return ''
  const positive = formatAtom({ ...atom, negated: undefined })
  return (
    `hint: "negated":true is STRONG negation - it only matches an explicit not-${positive} fact. ` +
    `To require the ABSENCE of ${positive}, use "naf":true instead.`
  )
}

function formatAtoms(atoms: Array<Parameters<typeof formatAtom>[0]>): string {
  return atoms.length > 0 ? atoms.map(formatAtom).join(', ') : 'none'
}

/** Render the precondition binding an action ran (or would run) under. */
function bindingLine(binding: Record<string, unknown>, candidates: number): string {
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * Errors become structured tool results instead of protocol failures, so
 * the model can read the message (e.g. RuleSafetyError violations,
 * unknown node ids) and self-correct.
 */
function guard<T>(handler: (input: T) => ToolResult | Promise<ToolResult>): (input: T) => Promise<ToolResult> {
  return async (input: T) => {
    try {
      return await handler(input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }
    }
  }
}
