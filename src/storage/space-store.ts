import type {
  CreateNodeInput,
  ProblemSpace,
  SpaceNode,
} from '../model/types.js'

export type CreateSpaceInput = {
  id?: string
  title: string
  summary?: string
  scopes?: string[]
}

export type NodePatch = Partial<
  Pick<
    SpaceNode,
    | 'label'
    | 'summary'
    | 'status'
    | 'confidence'
    | 'activation'
    | 'evidenceRefs'
    | 'semantic'
  >
>

export interface SpaceStore {
  createSpace(input: CreateSpaceInput): ProblemSpace
  getSpace(spaceId: string): ProblemSpace
  listSpaces(): ProblemSpace[]
  addNode(spaceId: string, input: CreateNodeInput): SpaceNode
  updateNode(spaceId: string, nodeId: string, patch: NodePatch): SpaceNode
  getNode(spaceId: string, nodeId: string): SpaceNode
  listNodes(spaceId: string): SpaceNode[]
  removeNode(spaceId: string, nodeId: string): void
}
