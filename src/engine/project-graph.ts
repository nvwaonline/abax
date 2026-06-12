import type { SpaceNode } from '../model/types.js'
import { isDerivedFactId } from '../kernel/stratify.js'
import type { SpaceStore } from '../storage/space-store.js'

export type ProjectedEdge = {
  from: string
  to: string
  kind: 'derive' | 'supports' | 'seed'
}

export type ProjectedGraph = {
  spaceId: string
  nodes: SpaceNode[]
  edges: ProjectedEdge[]
}

/**
 * Project a graph view from the working memory for visualization
 * (e.g. the galaxy spatial console). The kernel stores no edges —
 * relationships live in `evidenceRefs` — so this derives them:
 *
 * - derived fact:  rule --derive--> fact, sources --supports--> fact
 * - other entries: each evidence ref --supports--> entry
 * - seed refs (`seed:<spaceId>`) become seed edges from a virtual node.
 *
 * Pure read; the projection is presentation, not kernel state.
 */
export function projectGraph(store: SpaceStore, spaceId: string): ProjectedGraph {
  const nodes = store.listNodes(spaceId)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges: ProjectedEdge[] = []

  for (const node of nodes) {
    node.evidenceRefs.forEach((ref, index) => {
      if (ref.startsWith('seed:')) {
        edges.push({ from: ref, to: node.id, kind: 'seed' })
        return
      }
      if (!nodeIds.has(ref)) return
      const kind = isDerivedFactId(node.id) && index === 0 ? 'derive' : 'supports'
      edges.push({ from: ref, to: node.id, kind })
    })
  }

  return { spaceId, nodes, edges }
}
