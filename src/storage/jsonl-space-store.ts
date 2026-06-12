import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CreateNodeInput, ProblemSpace, SpaceNode } from '../model/types.js'
import { MemorySpaceStore } from './memory-space-store.js'
import type { CreateSpaceInput, NodePatch, SpaceStore } from './space-store.js'

type LogEntry =
  | { op: 'create_space'; input: CreateSpaceInput & { id: string } }
  | { op: 'add_node'; spaceId: string; input: CreateNodeInput & { id: string } }
  | { op: 'update_node'; spaceId: string; nodeId: string; patch: NodePatch }
  | { op: 'remove_node'; spaceId: string; nodeId: string }

/**
 * Durable SpaceStore: an append-only JSONL log of store mutations,
 * replayed into a MemorySpaceStore on open. Persistence by replay is
 * the storage-level mirror of the kernel's recompute philosophy —
 * state is a pure function of the recorded operations. Ids are pinned
 * in the log, so replay reproduces the exact same state.
 */
export class JsonlSpaceStore implements SpaceStore {
  private readonly memory = new MemorySpaceStore()
  private readonly path: string

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        this.replay(JSON.parse(line) as LogEntry)
      }
    }
  }

  createSpace(input: CreateSpaceInput): ProblemSpace {
    const space = this.memory.createSpace(input)
    this.append({ op: 'create_space', input: { ...input, id: space.id } })
    return space
  }

  getSpace(spaceId: string): ProblemSpace {
    return this.memory.getSpace(spaceId)
  }

  listSpaces(): ProblemSpace[] {
    return this.memory.listSpaces()
  }

  addNode(spaceId: string, input: CreateNodeInput): SpaceNode {
    const node = this.memory.addNode(spaceId, input)
    this.append({ op: 'add_node', spaceId, input: nodeToInput(node) })
    return node
  }

  updateNode(spaceId: string, nodeId: string, patch: NodePatch): SpaceNode {
    const node = this.memory.updateNode(spaceId, nodeId, patch)
    this.append({ op: 'update_node', spaceId, nodeId, patch })
    return node
  }

  getNode(spaceId: string, nodeId: string): SpaceNode {
    return this.memory.getNode(spaceId, nodeId)
  }

  listNodes(spaceId: string): SpaceNode[] {
    return this.memory.listNodes(spaceId)
  }

  removeNode(spaceId: string, nodeId: string): void {
    this.memory.removeNode(spaceId, nodeId)
    this.append({ op: 'remove_node', spaceId, nodeId })
  }

  private replay(entry: LogEntry): void {
    switch (entry.op) {
      case 'create_space':
        this.memory.createSpace(entry.input)
        return
      case 'add_node':
        this.memory.addNode(entry.spaceId, entry.input)
        return
      case 'update_node':
        this.memory.updateNode(entry.spaceId, entry.nodeId, entry.patch)
        return
      case 'remove_node':
        this.memory.removeNode(entry.spaceId, entry.nodeId)
        return
    }
  }

  private append(entry: LogEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
  }
}

function nodeToInput(node: SpaceNode): CreateNodeInput & { id: string } {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    summary: node.summary,
    status: node.status,
    confidence: node.confidence,
    activation: node.activation,
    evidenceRefs: node.evidenceRefs,
    semantic: node.semantic,
    createdBy: node.createdBy,
  }
}
