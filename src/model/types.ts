export type NodeKind =
  | 'goal'
  | 'axiom'
  | 'constraint'
  | 'fact'
  | 'hypothesis'
  | 'action'
  | 'result'
  | 'conflict'

export type NodeStatus =
  | 'open'
  | 'verified'
  | 'supported'
  | 'weak'
  | 'rejected'
  | 'conflict'
  | 'archived'

export type Creator = 'user' | 'agent' | 'tool' | 'system'

export type SemanticScalar = string | number | boolean

export type SemanticArgs = Record<string, SemanticScalar>

/**
 * A predicate atom. Two kinds of negation are deliberately distinct:
 *
 * - `negated` is strong (classical) negation: "verified that not p".
 *   Valid on facts, rule-body literals (matches explicit negative
 *   facts), and rule heads (derives negative knowledge).
 * - `naf` is negation as failure: "p cannot be proven". Valid only on
 *   rule-body literals; soundness is guaranteed by stratification.
 */
export type PredicateAtom = {
  predicate: string
  args?: SemanticArgs
  negated?: boolean
  naf?: boolean
}

export type SemanticFrame = {
  kind: 'predicate' | 'action' | 'axiom' | 'goal'
  predicate?: string
  args?: SemanticArgs
  negated?: boolean
  action?: string
  preconditions?: PredicateAtom[]
  effects?: PredicateAtom[]
  when?: PredicateAtom[]
  then?: PredicateAtom[]
  desired?: PredicateAtom[]
}

/**
 * A typed working-memory entry: a statement with identity, status, and
 * provenance. Not a spatial node — relationships between entries are
 * carried entirely by `evidenceRefs` (which entries this one rests on);
 * any graph view can be projected from that.
 */
export type SpaceNode = {
  id: string
  type: NodeKind
  label: string
  summary: string
  status: NodeStatus
  /** Display metadata only: the kernel never propagates confidence. */
  confidence: number
  /** Display metadata only. */
  activation: number
  /** Provenance: the entries (or external sources) this one rests on. */
  evidenceRefs: string[]
  semantic?: SemanticFrame
  createdBy: Creator
  createdAt: string
  updatedAt: string
}

export type ProblemSpace = {
  id: string
  title: string
  summary?: string
  scopes: string[]
  nodeIds: string[]
  createdAt: string
  updatedAt: string
}

export type CreateNodeInput = {
  id?: string
  type: NodeKind
  label: string
  summary?: string
  status?: NodeStatus
  confidence?: number
  activation?: number
  evidenceRefs?: string[]
  semantic?: SemanticFrame
  createdBy?: Creator
}
