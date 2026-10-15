import { createRelationGraphSource } from '@modkit/codec-kit'
import type { RelationGraphEdge, RelationGraphNode, RelationGraphSource } from '@modkit/sdk'
import { buildSc2LayoutReferences } from '../../../shared/format/relations.js'
import type { Sc2LayoutDocument } from '../../../shared/format/document.js'

function stableId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join('/')}`
}

/** Publish this document's cross-format references without pretending its dependencies are loaded. */
export function createSc2LayoutRelationGraphSource(
  document: Sc2LayoutDocument,
  snapshotId: string,
): RelationGraphSource {
  const file = document.source.path.replaceAll('\\', '/')
  const references = buildSc2LayoutReferences({
    layouts: new Map([[file, document.data]]),
    namespaces: () => [],
    get: () => undefined,
  })
  const nodes: RelationGraphNode[] = []
  const edges: RelationGraphEdge[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const addNode = (node: RelationGraphNode) => {
    if (nodeIds.has(node.id)) return
    nodeIds.add(node.id)
    nodes.push(Object.freeze(node))
  }

  for (const reference of references) {
    const from = stableId('layout-frame', file, reference.frame || '(root)')
    const to = stableId(reference.kind, reference.key)
    addNode({
      id: from,
      label: reference.frame || '(root)',
      type: 'layout-frame',
      kind: 'sc2-layout-frame',
    })
    addNode({ id: to, label: reference.key, type: reference.kind, kind: reference.kind })
    const identity = `${from}\0${to}\0${reference.property}`
    if (edgeIds.has(identity)) continue
    edgeIds.add(identity)
    edges.push(Object.freeze({ from, to, role: reference.property }))
  }

  return createRelationGraphSource({
    snapshotId,
    nodes,
    edges,
    completeness: 'partial',
    reason: 'This source contains one layout document; dependency and catalog targets are not loaded.',
  })
}
