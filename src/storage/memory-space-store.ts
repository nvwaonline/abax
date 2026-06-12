import { randomUUID } from 'node:crypto'
import type {
  CreateNodeInput,
  ProblemSpace,
  SpaceNode,
} from '../model/types.js'
import type { CreateSpaceInput, NodePatch, SpaceStore } from './space-store.js'

export class MemorySpaceStore implements SpaceStore {
  private readonly spaces = new Map<string, ProblemSpace>()
  /** Keyed by `spaceId/nodeId`: ids are scoped per space by design. */
  private readonly nodes = new Map<string, SpaceNode>()

  createSpace(input: CreateSpaceInput): ProblemSpace {
    const now = timestamp()
    const space: ProblemSpace = {
      id: input.id ?? randomUUID(),
      title: input.title,
      summary: input.summary,
      scopes: input.scopes ?? [],
      nodeIds: [],
      createdAt: now,
      updatedAt: now,
    }

    this.spaces.set(space.id, space)
    return space
  }

  getSpace(spaceId: string): ProblemSpace {
    const space = this.spaces.get(spaceId)
    if (!space) {
      throw new Error(`Problem space not found: ${spaceId}`)
    }
    return space
  }

  listSpaces(): ProblemSpace[] {
    return [...this.spaces.values()]
  }

  addNode(spaceId: string, input: CreateNodeInput): SpaceNode {
    const space = this.getSpace(spaceId)
    const now = timestamp()
    const node: SpaceNode = {
      id: input.id ?? randomUUID(),
      type: input.type,
      label: input.label,
      summary: input.summary ?? input.label,
      status: input.status ?? defaultStatus(input.type),
      confidence: input.confidence ?? defaultConfidence(input.type),
      activation: input.activation ?? defaultActivation(input.type),
      evidenceRefs: input.evidenceRefs ?? [],
      semantic: input.semantic,
      createdBy: input.createdBy ?? 'agent',
      createdAt: now,
      updatedAt: now,
    }

    if (this.nodes.has(nodeKey(spaceId, node.id))) {
      throw new Error(`Node already exists in space ${spaceId}: ${node.id}`)
    }

    this.nodes.set(nodeKey(spaceId, node.id), node)
    space.nodeIds.push(node.id)
    space.updatedAt = now
    return node
  }

  updateNode(spaceId: string, nodeId: string, patch: NodePatch): SpaceNode {
    const current = this.getNode(spaceId, nodeId)
    const next: SpaceNode = {
      ...current,
      ...patch,
      updatedAt: timestamp(),
    }

    this.nodes.set(nodeKey(spaceId, nodeId), next)
    return next
  }

  getNode(spaceId: string, nodeId: string): SpaceNode {
    const node = this.nodes.get(nodeKey(spaceId, nodeId))
    if (!node) {
      throw new Error(`Node not found in space ${spaceId}: ${nodeId}`)
    }
    return node
  }

  listNodes(spaceId: string): SpaceNode[] {
    const space = this.getSpace(spaceId)
    return space.nodeIds.map((nodeId) => this.getNode(spaceId, nodeId))
  }

  removeNode(spaceId: string, nodeId: string): void {
    const space = this.getSpace(spaceId)
    if (!space.nodeIds.includes(nodeId)) {
      throw new Error(`Node ${nodeId} does not belong to space ${space.id}`)
    }

    space.nodeIds = space.nodeIds.filter((id) => id !== nodeId)
    this.nodes.delete(nodeKey(spaceId, nodeId))
    space.updatedAt = timestamp()
  }
}

function nodeKey(spaceId: string, nodeId: string): string {
  return `${spaceId}/${nodeId}`
}

function timestamp(): string {
  return new Date().toISOString()
}

function defaultStatus(type: SpaceNode['type']): SpaceNode['status'] {
  if (type === 'fact' || type === 'result' || type === 'constraint' || type === 'axiom') {
    return 'verified'
  }
  return 'open'
}

function defaultConfidence(type: SpaceNode['type']): number {
  if (type === 'fact' || type === 'result' || type === 'constraint' || type === 'axiom') {
    return 0.9
  }
  if (type === 'hypothesis') {
    return 0.35
  }
  return 0.5
}

function defaultActivation(type: SpaceNode['type']): number {
  if (type === 'goal') {
    return 1
  }
  if (type === 'action') {
    return 0.7
  }
  return 0.5
}
