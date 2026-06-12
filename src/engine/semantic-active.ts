import type { SpaceNode } from '../model/types.js'

export function indexNodesById(nodes: SpaceNode[]): Map<string, SpaceNode> {
  return new Map(nodes.map((node) => [node.id, node]))
}

export function isNodeActive(node: SpaceNode): boolean {
  return node.status !== 'rejected' && node.status !== 'archived'
}

export function isNodeLogicallyUsable(
  node: SpaceNode,
  nodesById: Map<string, SpaceNode>,
  seen = new Set<string>(),
): boolean {
  if (!isNodeActive(node)) return false
  if (seen.has(node.id)) return true

  seen.add(node.id)
  for (const evidenceRef of node.evidenceRefs) {
    const evidenceNode = nodesById.get(evidenceRef)
    if (evidenceNode && !isNodeLogicallyUsable(evidenceNode, nodesById, seen)) {
      return false
    }
  }

  return true
}

export function logicallyUsableNodes(nodes: SpaceNode[]): SpaceNode[] {
  const nodesById = indexNodesById(nodes)
  return nodes.filter((node) => isNodeLogicallyUsable(node, nodesById))
}
