import type { PredicateAtom, SemanticArgs, SemanticFrame, SemanticScalar } from './types.js'

const semanticKinds = new Set<SemanticFrame['kind']>([
  'predicate',
  'action',
  'axiom',
  'goal',
])

export function normalizeSemanticFrame(value: unknown): SemanticFrame | undefined {
  const record = asRecord(value)
  const kind = asSemanticKind(record.kind)
  if (!kind) return undefined

  const frame: SemanticFrame = {
    kind,
    predicate: asString(record.predicate),
    args: asSemanticArgs(record.args),
    negated: typeof record.negated === 'boolean' ? record.negated : undefined,
    action: asString(record.action),
    preconditions: asPredicateAtoms(record.preconditions),
    effects: asPredicateAtoms(record.effects),
    when: asPredicateAtoms(record.when),
    then: asPredicateAtoms(record.then),
    desired: asPredicateAtoms(record.desired),
  }

  return pruneUndefined(frame)
}

export function normalizePredicateAtom(value: unknown): PredicateAtom | undefined {
  const record = asRecord(value)
  const predicate = asString(record.predicate)
  if (!predicate) return undefined

  return pruneUndefined({
    predicate,
    args: asSemanticArgs(record.args),
    negated: typeof record.negated === 'boolean' ? record.negated : undefined,
    naf: typeof record.naf === 'boolean' ? record.naf : undefined,
  })
}

function asPredicateAtoms(value: unknown): PredicateAtom[] | undefined {
  if (!Array.isArray(value)) return undefined
  const atoms = value
    .map(normalizePredicateAtom)
    .filter((atom): atom is PredicateAtom => atom !== undefined)
  return atoms.length > 0 ? atoms : undefined
}

function asSemanticArgs(value: unknown): SemanticArgs | undefined {
  const record = asRecord(value)
  const entries = Object.entries(record)
    .map(([key, item]) => [key, asSemanticScalar(item)] as const)
    .filter((entry): entry is readonly [string, SemanticScalar] => entry[1] !== undefined)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function asSemanticScalar(value: unknown): SemanticScalar | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  return undefined
}

function asSemanticKind(value: unknown): SemanticFrame['kind'] | undefined {
  return typeof value === 'string' && semanticKinds.has(value as SemanticFrame['kind'])
    ? (value as SemanticFrame['kind'])
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}
