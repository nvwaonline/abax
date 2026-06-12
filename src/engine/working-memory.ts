import type { PredicateAtom, SemanticArgs, SpaceNode } from '../model/types.js'
import { isBuiltinPredicate } from '../kernel/builtins.js'
import { assertActionSafety, assertRuleSafety } from '../kernel/safety.js'
import { detectVacuousRule } from '../kernel/rule-quality.js'
import type { SpaceStore } from '../storage/space-store.js'
import { applySemanticRules, type SemanticRuleApplicationResult } from './semantic-rules.js'
import {
  FINDING_PREDICATE,
  getLogicContext,
  formatLogicContextAsText,
  isDerivedFactNode,
  type LogicContext,
} from './logic-context.js'
import { logicallyUsableNodes } from './semantic-active.js'
import { formatAtom } from './semantic-derivation.js'
import { retractNode } from './semantic-tools.js'
import {
  checkAtomSignature,
  collectPredicateVocabulary,
  registerAtom,
} from './vocabulary.js'

export type WorkingMemoryOperation =
  | ({ op: 'declare_goal' } & {
      id?: string
      label: string
      summary?: string
      desired: PredicateAtom[]
      confidence?: number
      activation?: number
    })
  | ({ op: 'assert_fact' } & {
      id?: string
      label?: string
      summary?: string
      predicate: string
      args?: SemanticArgs
      negated?: boolean
      confidence?: number
      activation?: number
      evidenceRefs?: string[]
    })
  | ({ op: 'add_axiom' } & {
      id?: string
      label: string
      summary?: string
      when: PredicateAtom[]
      then: PredicateAtom[]
      confidence?: number
      activation?: number
    })
  | ({ op: 'define_action' } & {
      id?: string
      label: string
      summary?: string
      action: string
      preconditions?: PredicateAtom[]
      effects?: PredicateAtom[]
      confidence?: number
      activation?: number
    })
  | ({ op: 'declare_hypothesis' } & {
      id?: string
      label?: string
      summary?: string
      predicate: string
      args?: SemanticArgs
      negated?: boolean
      confidence?: number
      activation?: number
    })
  | ({ op: 'record_result' } & {
      id?: string
      label: string
      summary?: string
      evidenceRefs?: string[]
      confidence?: number
    })
  | ({ op: 'record_conflict' } & {
      id?: string
      label: string
      summary?: string
      evidenceRefs?: string[]
      confidence?: number
    })
  | {
      op: 'retract_node'
      nodeId: string
      reason?: string
    }
  | ({ op: 'revise_fact' } & {
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
    })

export type WorkingMemoryOperationResult = {
  index: number
  op: WorkingMemoryOperation['op']
  nodeIds: string[]
  retractedNodeIds: string[]
}

export type WorkingMemoryApplyResult = {
  operationResults: WorkingMemoryOperationResult[]
  semanticRuleApplication: SemanticRuleApplicationResult
  warnings: string[]
  workingMemory: LogicContext
  workingMemoryText?: string
}

export function applyWorkingMemoryOperations(
  store: SpaceStore,
  spaceId: string,
  operations: WorkingMemoryOperation[],
  options: { format?: 'json' | 'text' } = {},
): WorkingMemoryApplyResult {
  const operationResults: WorkingMemoryOperationResult[] = []
  const newNodeIds: string[] = []
  const warnings: string[] = []
  const vocabulary = collectPredicateVocabulary(store.listNodes(spaceId))
  const factIndex = collectFactIndex(store, spaceId)
  const ruleIndex = collectRuleIndex(store, spaceId)

  // Normalize, then validate the whole batch before applying anything,
  // so a rejected operation cannot leave the batch half-applied.
  operations = operations.map(normalizeOperationShape).map(normalizeOperationScalars)
  const existingIds = new Set(store.listNodes(spaceId).map((node) => node.id))
  const removedInBatch = new Set(
    operations.flatMap((operation) =>
      operation.op === 'retract_node' || operation.op === 'revise_fact'
        ? [operation.nodeId]
        : [],
    ),
  )
  const newIdsInBatch = new Set<string>()
  for (const operation of operations) {
    assertKnownOperation(operation)
    assertNoBuiltinAssertion(operation)
    assertValidAtoms(operation)
    assertNoForgedProvenance(operation)
    assertNoStrictPlaceholders(operation)
    assertValidNodeReference(operation)
    assertFreshNodeId(operation, existingIds, removedInBatch, newIdsInBatch)
    if (operation.op === 'add_axiom') {
      assertRuleSafety({
        id: operation.id ?? operation.label,
        when: operation.when,
        then: operation.then,
      })
    }
    if (operation.op === 'define_action') {
      assertActionSafety({
        id: operation.id ?? operation.label ?? operation.action,
        preconditions: operation.preconditions,
        effects: operation.effects,
      })
    }
  }
  assertDerivationGate(store, spaceId, operations)

  operations.forEach((operation, index) => {
    for (const atom of operationAtoms(operation)) {
      const warning = checkAtomSignature(vocabulary, atom)
      if (warning) warnings.push(`op #${index} (${operation.op}): ${warning}`)
      registerAtom(vocabulary, atom)
    }

    if (operation.op === 'declare_goal' || operation.op === 'declare_hypothesis') {
      const placeholder = detectPlaceholderConstants(operation)
      if (placeholder) warnings.push(`op #${index} (${operation.op}): ${placeholder}`)
    }

    if (operation.op === 'assert_fact') {
      // Idempotent re-assert: an identical fact (same predicate, args,
      // sign) maps to the SAME state, so creating a second node only
      // clutters the board - real runs ignored the warning-only version
      // and accumulated duplicate copies. Reuse the existing node instead.
      const existing = factIndex.get(
        canonicalAtomKey({
          predicate: operation.predicate,
          args: operation.args,
          negated: operation.negated,
        }),
      )
      if (existing) {
        warnings.push(
          `op #${index} (assert_fact): this exact fact is already on the board as ${existing}; ` +
            `reused it instead of adding a copy (retract it first if you meant to replace it)`,
        )
        operationResults.push(operationResult(index, operation.op, [existing]))
        return
      }
    }

    if (operation.op === 'revise_fact') {
      const existing = factIndex.get(
        canonicalAtomKey({
          predicate: operation.predicate,
          args: operation.args,
          negated: operation.negated,
        }),
      )
      if (existing && existing !== operation.nodeId) {
        warnings.push(
          `op #${index} (revise_fact): the replacement is identical to ${existing}, which is already on the board`,
        )
      }
    }

    if (operation.op === 'add_axiom') {
      // Idempotent re-add: an identical rule derives nothing new; real
      // runs re-added the same rule up to 4 times after context loss.
      const existingRule = ruleIndex.get(canonicalRuleKey(operation.when, operation.then))
      if (existingRule) {
        warnings.push(
          `op #${index} (add_axiom): an identical rule is already on the board as ${existingRule}; ` +
            `reused it instead of adding a copy`,
        )
        operationResults.push(operationResult(index, operation.op, [existingRule]))
        return
      }
      const vacuous = detectVacuousRule({
        id: operation.id ?? operation.label,
        when: operation.when,
        then: operation.then,
      })
      if (vacuous) warnings.push(`op #${index} (add_axiom): ${vacuous}`)
    }

    const result = applyOperation(store, spaceId, operation, index)
    operationResults.push(result)
    newNodeIds.push(...result.nodeIds)

    if (operation.op === 'assert_fact' || operation.op === 'revise_fact') {
      const newId = result.nodeIds[result.nodeIds.length - 1]
      if (newId) {
        factIndex.set(
          canonicalAtomKey({
            predicate: operation.predicate,
            args: operation.args,
            negated: operation.negated,
          }),
          newId,
        )
      }
    }

    if (operation.op === 'add_axiom') {
      const newId = result.nodeIds[result.nodeIds.length - 1]
      if (newId) ruleIndex.set(canonicalRuleKey(operation.when, operation.then), newId)
    }
  })

  const semanticRuleApplication = applySemanticRules(store, spaceId)

  const workingMemory = getLogicContext(store, spaceId)
  return {
    operationResults,
    semanticRuleApplication,
    warnings,
    workingMemory,
    workingMemoryText:
      options.format === 'text' ? formatLogicContextAsText(workingMemory) : undefined,
  }
}

function applyOperation(
  store: SpaceStore,
  spaceId: string,
  operation: WorkingMemoryOperation,
  index: number,
): WorkingMemoryOperationResult {
  switch (operation.op) {
    case 'declare_goal': {
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'goal',
        label: operation.label,
        summary: operation.summary,
        confidence: operation.confidence,
        activation: operation.activation ?? 1,
        semantic: { kind: 'goal', desired: operation.desired },
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'assert_fact': {
      const atom = { predicate: operation.predicate, args: operation.args, negated: operation.negated }
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'fact',
        label: operation.label ?? formatAtom(atom),
        summary: operation.summary ?? `Fact: ${formatAtom(atom)}`,
        confidence: operation.confidence,
        activation: operation.activation,
        evidenceRefs: operation.evidenceRefs,
        semantic: {
          kind: 'predicate',
          predicate: operation.predicate,
          args: operation.args,
          negated: operation.negated,
        },
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'add_axiom': {
      assertRuleSafety({
        id: operation.id ?? operation.label,
        when: operation.when,
        then: operation.then,
      })
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'axiom',
        label: operation.label,
        summary: operation.summary,
        confidence: operation.confidence,
        activation: operation.activation ?? 0.9,
        semantic: {
          kind: 'axiom',
          when: operation.when,
          then: operation.then,
        },
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'define_action': {
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'action',
        // Models routinely omit label; default to the action name instead of
        // storing undefined (which the board rendered literally).
        label: operation.label ?? operation.action,
        summary: operation.summary,
        confidence: operation.confidence,
        activation: operation.activation,
        semantic: {
          kind: 'action',
          action: operation.action,
          preconditions: operation.preconditions,
          effects: operation.effects,
        },
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'declare_hypothesis': {
      const atom = { predicate: operation.predicate, args: operation.args, negated: operation.negated }
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'hypothesis',
        label: operation.label ?? formatAtom(atom),
        summary: operation.summary ?? `Hypothesis: ${formatAtom(atom)}`,
        status: 'open',
        confidence: operation.confidence,
        activation: operation.activation,
        semantic: {
          kind: 'predicate',
          predicate: operation.predicate,
          args: operation.args,
          negated: operation.negated,
        },
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'record_result':
    case 'record_conflict': {
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: operation.op === 'record_result' ? 'result' : 'conflict',
        label: operation.label,
        summary: operation.summary,
        status: 'verified',
        confidence: operation.confidence,
        evidenceRefs: operation.evidenceRefs,
        createdBy: 'agent',
      })
      return operationResult(index, operation.op, [node.id])
    }
    case 'retract_node': {
      return retractOperation(store, spaceId, operation.nodeId, operation.reason, index, operation.op)
    }
    case 'revise_fact': {
      const retracted = retractOperation(
        store,
        spaceId,
        operation.nodeId,
        operation.reason,
        index,
        operation.op,
      )
      const atom = { predicate: operation.predicate, args: operation.args, negated: operation.negated }
      const node = store.addNode(spaceId, {
        id: operation.id,
        type: 'fact',
        label: operation.label ?? formatAtom(atom),
        summary: operation.summary ?? `Fact: ${formatAtom(atom)}`,
        confidence: operation.confidence,
        activation: operation.activation,
        evidenceRefs: operation.evidenceRefs,
        semantic: {
          kind: 'predicate',
          predicate: operation.predicate,
          args: operation.args,
          negated: operation.negated,
        },
        createdBy: 'agent',
      })
      retracted.nodeIds.push(node.id)
      return retracted
    }
  }
}

function retractOperation(
  store: SpaceStore,
  spaceId: string,
  nodeId: string,
  reason: string | undefined,
  index: number,
  op: WorkingMemoryOperation['op'],
): WorkingMemoryOperationResult {
  const retraction = retractNode(store, spaceId, { nodeId, reason })
  return {
    index,
    op,
    nodeIds: [],
    retractedNodeIds: retraction.removedNodeIds,
  }
}

/**
 * Values that are almost certainly type placeholders rather than real
 * constants. Seen in a real run: a goal of finding(file=string, line=number)
 * can never be satisfied because it only matches the literal value "string".
 *
 * The unambiguous type names are a HARD error (the warning-only version
 * was ignored in three consecutive real runs, leaving the goal forever
 * unsatisfiable); fuzzier words stay warnings because they can be
 * legitimate domain constants.
 */
const STRICT_PLACEHOLDER_VALUES = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'int',
  'float',
  'double',
  'object',
  'array',
])

const SOFT_PLACEHOLDER_VALUES = new Set([
  'value',
  'values',
  'any',
  'anything',
  'placeholder',
  'unknown',
  'tbd',
  'todo',
  'n/a',
  'na',
  'xxx',
])

function placeholderArgs(
  operation: WorkingMemoryOperation & { op: 'declare_goal' | 'declare_hypothesis' },
  values: Set<string>,
): string[] {
  const hits: string[] = []
  for (const atom of operationAtoms(operation)) {
    for (const [key, value] of Object.entries(atom.args ?? {})) {
      if (typeof value !== 'string') continue
      if (value.startsWith('?')) continue
      if (values.has(value.toLowerCase())) hits.push(`${key}=${value}`)
    }
  }
  return hits
}

function assertNoStrictPlaceholders(operation: WorkingMemoryOperation): void {
  if (operation.op !== 'declare_goal' && operation.op !== 'declare_hypothesis') return
  const hits = placeholderArgs(operation, STRICT_PLACEHOLDER_VALUES)
  // Alternation literals (judgment=confirmed|refuted) are placeholders too:
  // the atom only matches that exact pipe-string, never a real value.
  for (const atom of operationAtoms(operation)) {
    for (const [key, value] of Object.entries(atom.args ?? {})) {
      if (typeof value === 'string' && !value.startsWith('?') && value.includes('|')) {
        hits.push(`${key}=${value}`)
      }
    }
  }
  if (hits.length === 0) return
  throw new Error(
    `${operation.op}: argument(s) ${hits.join(', ')} are type-name placeholders, not real values - ` +
      `this atom only matches those literal strings and can never be satisfied by real facts. ` +
      `Use a "?variable" (e.g. file=?f, line=?l) to mean "any value"; pattern goals/hypotheses ` +
      `are satisfied by any matching instance. The whole batch was rejected; nothing was applied.`,
  )
}

function detectPlaceholderConstants(
  operation: WorkingMemoryOperation & { op: 'declare_goal' | 'declare_hypothesis' },
): string | undefined {
  const suspicious = placeholderArgs(operation, SOFT_PLACEHOLDER_VALUES)
  if (suspicious.length === 0) return undefined
  return (
    `argument(s) ${suspicious.join(', ')} look like type placeholders, not real values - ` +
    `this atom only matches those literal strings, so it can never be satisfied by real facts. ` +
    `Use a "?variable" (e.g. file=?f) to mean "any value": pattern goals/hypotheses are satisfied by any matching instance.`
  )
}

/** Canonical identity of a ground atom: predicate + sorted args + sign. */
function canonicalAtomKey(atom: PredicateAtom): string {
  const args = atom.args ?? {}
  const keys = Object.keys(args).sort()
  const body = keys.map((key) => `${key}=${JSON.stringify(args[key])}`).join(',')
  return `${atom.negated ? '!' : ''}${atom.predicate}(${body})`
}

/** Canonical identity of a rule: literal order is semantically irrelevant. */
function canonicalRuleKey(when: PredicateAtom[], then: PredicateAtom[]): string {
  const literalKey = (atom: PredicateAtom): string =>
    `${atom.naf ? '~' : ''}${canonicalAtomKey(atom)}`
  return `${(when ?? []).map(literalKey).sort().join(' & ')} => ${(then ?? [])
    .map(literalKey)
    .sort()
    .join(' & ')}`
}

function collectRuleIndex(store: SpaceStore, spaceId: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const node of logicallyUsableNodes(store.listNodes(spaceId))) {
    if (node.type !== 'axiom' || node.semantic?.kind !== 'axiom') continue
    index.set(canonicalRuleKey(node.semantic.when ?? [], node.semantic.then ?? []), node.id)
  }
  return index
}

function collectFactIndex(store: SpaceStore, spaceId: string): Map<string, string> {
  const index = new Map<string, string>()
  for (const node of logicallyUsableNodes(store.listNodes(spaceId))) {
    if (node.type !== 'fact' || node.semantic?.kind !== 'predicate') continue
    index.set(
      canonicalAtomKey({
        predicate: node.semantic.predicate ?? node.label,
        args: node.semantic.args,
        negated: node.semantic.negated,
      }),
      node.id,
    )
  }
  return index
}

/**
 * Hard derivation gate: record_result is the agent's "I am done" move,
 * so it must not rest on findings the rule engine does not stand behind.
 * An asserted (not derived) positive finding(...) is an unproven claim;
 * the nudge layer already warns about it, but prompts can be ignored —
 * this invariant cannot. Negated findings are exempt: they refute
 * hypotheses rather than claim results. record_conflict is never gated.
 */
export class DerivationGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DerivationGateError'
  }
}

const GATE_LIST_LIMIT = 10

function assertDerivationGate(
  store: SpaceStore,
  spaceId: string,
  operations: WorkingMemoryOperation[],
): void {
  if (!operations.some((operation) => operation.op === 'record_result')) return

  // Findings directly retracted (or revised away) in this same batch are excused.
  const removedIds = new Set(
    operations.flatMap((operation) =>
      operation.op === 'retract_node' || operation.op === 'revise_fact'
        ? [operation.nodeId]
        : [],
    ),
  )

  const onBoard = logicallyUsableNodes(store.listNodes(spaceId))
    .filter(
      (node) =>
        node.type === 'fact' &&
        node.semantic?.kind === 'predicate' &&
        (node.semantic.predicate ?? node.label) === FINDING_PREDICATE &&
        node.semantic.negated !== true &&
        !isDerivedFactNode(node) &&
        !removedIds.has(node.id),
    )
    .map((node) => `${node.id}: ${node.label}`)

  const inBatch = operations.flatMap((operation, index) =>
    (operation.op === 'assert_fact' || operation.op === 'revise_fact') &&
    operation.predicate === FINDING_PREDICATE &&
    operation.negated !== true
      ? [`op #${index} (${operation.op}${operation.id ? ` ${operation.id}` : ''})`]
      : [],
  )

  if (onBoard.length === 0 && inBatch.length === 0) return

  const offenders = [
    ...(onBoard.length > 0
      ? [`on the board: ${truncateList(onBoard)}`]
      : []),
    ...(inBatch.length > 0
      ? [`asserted in this same batch: ${truncateList(inBatch)}`]
      : []),
  ].join('; ')

  throw new DerivationGateError(
    `record_result blocked: ${onBoard.length + inBatch.length} positive finding fact(s) are asserted, not derived — ${offenders}. ` +
      `A recorded result must rest on findings the rule closure stands behind. For each finding either ` +
      `(1) retract it, assert the primitive observation you actually verified (e.g. empty_catch(file=..., line=...)), ` +
      `and add_axiom a rule deriving finding(...) from that observation — the closure re-derives the finding; or ` +
      `(2) retract_node it if the observation does not hold. Then submit record_result again. ` +
      `The whole batch was rejected; nothing was applied.`,
  )
}

function truncateList(items: string[]): string {
  if (items.length <= GATE_LIST_LIMIT) return items.join(', ')
  return `${items.slice(0, GATE_LIST_LIMIT).join(', ')}, … and ${items.length - GATE_LIST_LIMIT} more`
}

/**
 * Readable errors for the two node-reference mistakes seen in real runs
 * (verification #8b): retract_node without a nodeId previously surfaced
 * as "Node undefined does not belong to space ..."; re-adding an existing
 * id crashed MID-BATCH (after earlier ops had applied), breaking the
 * validate-whole-batch-first promise.
 */
function assertValidNodeReference(operation: WorkingMemoryOperation): void {
  if (operation.op !== 'retract_node' && operation.op !== 'revise_fact') return
  if (typeof operation.nodeId === 'string' && operation.nodeId.length > 0) return
  throw new Error(
    `${operation.op} requires "nodeId": the id of the board entry to ` +
      `${operation.op === 'retract_node' ? 'remove' : 'replace'}, ` +
      `e.g. {"op":"${operation.op}","nodeId":"O3",...}. Find the id in the working memory listing.`,
  )
}

function assertFreshNodeId(
  operation: WorkingMemoryOperation,
  existingIds: Set<string>,
  removedInBatch: Set<string>,
  newIdsInBatch: Set<string>,
): void {
  const id = 'id' in operation ? operation.id : undefined
  if (typeof id !== 'string' || id.length === 0) return
  const collidesOnBoard = existingIds.has(id) && !removedInBatch.has(id)
  const collidesInBatch = newIdsInBatch.has(id)
  if (collidesOnBoard || collidesInBatch) {
    throw new Error(
      `node id "${id}" already exists on the board (${operation.op}). ` +
        `If you meant to re-add the same entry: it is already there, no action needed. ` +
        `To change it, use retract_node or revise_fact; otherwise pick a fresh id. ` +
        `The whole batch was rejected; nothing was applied.`,
    )
  }
  newIdsInBatch.add(id)
}

function assertNoBuiltinAssertion(operation: WorkingMemoryOperation): void {
  if (
    (operation.op === 'assert_fact' ||
      operation.op === 'revise_fact' ||
      operation.op === 'declare_hypothesis') &&
    isBuiltinPredicate(operation.predicate)
  ) {
    throw new Error(
      `"${operation.predicate}" is a reserved built-in comparison predicate; it can only appear in rule bodies`,
    )
  }
}

function operationAtoms(operation: WorkingMemoryOperation): PredicateAtom[] {
  switch (operation.op) {
    case 'declare_goal':
      return operation.desired
    case 'assert_fact':
    case 'declare_hypothesis':
    case 'revise_fact':
      return [{ predicate: operation.predicate, args: operation.args, negated: operation.negated }]
    case 'add_axiom':
      return [...operation.when, ...operation.then]
    case 'define_action':
      return [...(operation.preconditions ?? []), ...(operation.effects ?? [])]
    case 'record_result':
    case 'record_conflict':
    case 'retract_node':
      return []
  }
}

/**
 * Tolerate the most common shape mistake models make:
 * {"declare_goal": {...}} instead of {"op": "declare_goal", ...}.
 */
function normalizeOperationShape(operation: WorkingMemoryOperation): WorkingMemoryOperation {
  const raw = operation as unknown as Record<string, unknown>
  if (typeof raw.op === 'string') return operation
  const keys = Object.keys(raw).filter((key) => key !== 'note')
  const [key] = keys
  if (keys.length === 1 && key && KNOWN_OPERATIONS.has(key) && typeof raw[key] === 'object' && raw[key] !== null) {
    return { op: key, ...(raw[key] as Record<string, unknown>) } as WorkingMemoryOperation
  }
  return operation
}

/**
 * Normalize CANONICAL numeric strings ("5", "-3", "2.5") to numbers at the
 * boundary, so every layer agrees on scalar identity. Before this, the
 * layers disagreed: atomKey treated amount(mol=5) and amount(mol="5") as
 * the same fact, the matcher treated the bindings as different, arithmetic
 * coerced strings while comparisons required numbers — so a model writing
 * {"mol":"5"} (a high-frequency JSON accident) got silently-failing gte
 * guards and "action not applicable" with no clue.
 *
 * Only round-trip-canonical strings convert (String(Number(v)) === v):
 * "007", "5.0", "1e3", " 5" keep their identity as strings. Variables
 * ("?x") and non-finite values are never touched.
 */
function normalizeScalar<T>(value: T): T | number {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('?')) return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  return String(numeric) === value ? numeric : value
}

function normalizeAtomScalars(atom: PredicateAtom): PredicateAtom {
  if (!atom || typeof atom !== 'object' || !atom.args || typeof atom.args !== 'object') return atom
  const args: SemanticArgs = {}
  for (const [key, value] of Object.entries(atom.args)) {
    args[key] = normalizeScalar(value)
  }
  return { ...atom, args }
}

function normalizeAtomList(atoms: PredicateAtom[] | undefined): PredicateAtom[] | undefined {
  // Malformed shapes pass through untouched so assertValidAtoms can still
  // produce its teaching error instead of a crash here.
  if (!Array.isArray(atoms)) return atoms
  return atoms.map(normalizeAtomScalars)
}

function normalizeOperationScalars(operation: WorkingMemoryOperation): WorkingMemoryOperation {
  switch (operation.op) {
    case 'assert_fact':
    case 'revise_fact':
    case 'declare_hypothesis': {
      if (!operation.args || typeof operation.args !== 'object') return operation
      const args: SemanticArgs = {}
      for (const [key, value] of Object.entries(operation.args)) {
        args[key] = normalizeScalar(value)
      }
      return { ...operation, args }
    }
    case 'declare_goal':
      return { ...operation, desired: normalizeAtomList(operation.desired) as PredicateAtom[] }
    case 'add_axiom':
      return {
        ...operation,
        when: normalizeAtomList(operation.when) as PredicateAtom[],
        then: normalizeAtomList(operation.then) as PredicateAtom[],
      }
    case 'define_action':
      return {
        ...operation,
        preconditions: normalizeAtomList(operation.preconditions),
        effects: normalizeAtomList(operation.effects),
      }
    default:
      return operation
  }
}

/** Provenance markers the board assigns; user ops may not claim them.
 * (External review P0: assert_fact with summary "Rule-derived fact: ..."
 * passed isDerivedFactNode and sailed through the record_result gate.) */
const RESERVED_SUMMARY_PREFIXES = ['Rule-derived fact:', 'Derived fact:', 'Action-effect fact:']

function assertNoForgedProvenance(operation: WorkingMemoryOperation): void {
  const id = (operation as { id?: unknown }).id
  if (typeof id === 'string' && id.startsWith('derived:')) {
    throw new Error(
      `${operation.op}: "derived:" is a reserved id prefix - closure provenance is assigned by ` +
        `the board, never claimed. Use a plain id (e.g. "F1"); if you want the fact DERIVED, ` +
        `add a rule and let the closure produce it.`,
    )
  }
  const summary = (operation as { summary?: unknown }).summary
  if (typeof summary === 'string') {
    const forged = RESERVED_SUMMARY_PREFIXES.find((prefix) => summary.startsWith(prefix))
    if (forged !== undefined) {
      throw new Error(
        `${operation.op}: summary may not start with "${forged}" - that is a reserved provenance ` +
          `marker the board assigns. Describe the node in your own words; derivation status comes ` +
          `from the closure, not from labels.`,
      )
    }
  }
}

const ATOM_SHAPE_HINT =
  'each atom must be an object like {"predicate":"at","args":{"object":"car","location":"home"}}'

function assertValidAtoms(operation: WorkingMemoryOperation): void {
  const check = (atom: unknown, field: string): void => {
    if (
      typeof atom !== 'object' ||
      atom === null ||
      typeof (atom as PredicateAtom).predicate !== 'string' ||
      (atom as PredicateAtom).predicate.length === 0
    ) {
      throw new Error(
        `invalid atom in ${operation.op}.${field}: got ${JSON.stringify(atom)}; ${ATOM_SHAPE_HINT}`,
      )
    }
  }

  switch (operation.op) {
    case 'assert_fact':
    case 'declare_hypothesis':
    case 'revise_fact': {
      check(
        { predicate: (operation as { predicate?: unknown }).predicate, args: operation.args },
        'predicate',
      )
      return
    }
    case 'declare_goal': {
      if (!Array.isArray(operation.desired) || operation.desired.length === 0) {
        throw new Error(`declare_goal.desired must be a non-empty atom array; ${ATOM_SHAPE_HINT}`)
      }
      operation.desired.forEach((atom) => check(atom, 'desired'))
      return
    }
    case 'add_axiom': {
      ;(operation.when ?? []).forEach((atom) => check(atom, 'when'))
      ;(operation.then ?? []).forEach((atom) => check(atom, 'then'))
      return
    }
    case 'define_action': {
      ;(operation.preconditions ?? []).forEach((atom) => check(atom, 'preconditions'))
      ;(operation.effects ?? []).forEach((atom) => check(atom, 'effects'))
      return
    }
    default:
      return
  }
}

const KNOWN_OPERATIONS = new Set([
  'declare_goal',
  'assert_fact',
  'declare_hypothesis',
  'add_axiom',
  'define_action',
  'record_result',
  'record_conflict',
  'retract_node',
  'revise_fact',
])

function assertKnownOperation(operation: WorkingMemoryOperation): void {
  if (!KNOWN_OPERATIONS.has(operation.op)) {
    throw new Error(
      `unknown op "${(operation as { op: string }).op}"; valid ops: ${[...KNOWN_OPERATIONS].join(', ')}. ` +
        'Each operation needs an "op" key, e.g. {"op":"assert_fact","id":"F1","predicate":"at","args":{"object":"car"}}',
    )
  }
}

function operationResult(
  index: number,
  op: WorkingMemoryOperation['op'],
  nodeIds: string[],
): WorkingMemoryOperationResult {
  return {
    index,
    op,
    nodeIds,
    retractedNodeIds: [],
  }
}
