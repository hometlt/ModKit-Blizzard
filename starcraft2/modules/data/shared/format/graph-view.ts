/**
 * Serializable BFS projection of an SC2 catalog relation graph, rooted at one entity — the data
 * the VS Code relation-graph view (F4) renders. Works for any namespace.
 *
 * See docs/tasks-active/entity-cards-strings/PLAN-strings-cards-views.md (B3 / F4).
 */

import type { CatalogRelationGraph } from './relations.js'

export type CatalogGraphViewRelationGraph = Pick<CatalogRelationGraph, 'outgoing' | 'incoming'>

export interface GraphViewNode {
  ns: string
  id: string
  label: string
  /** BFS distance from the root (0 = root). */
  depth: number
}

export interface GraphViewEdge {
  /** `"Ns/id"` of the source node. */
  from: string
  /** `"Ns/id"` of the target node. */
  to: string
  /** Field path the reference travels through (e.g. `WeaponArray.0.Link`). */
  path: string
  /** `out` = root references it; `in` = it references root (relative to BFS direction). */
  dir: 'out' | 'in'
}

export interface GraphView {
  /** `"Ns/id"` of the root node. */
  root: string
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
  /** True when the result was capped by `maxNodes`. */
  truncated: boolean
}

export interface GraphViewOptions {
  ns: string
  id: string
  /** BFS depth (default 1). */
  depth?: number
  /** Which edges to follow (default `both`). */
  direction?: 'out' | 'in' | 'both'
  /** Node cap (default 80). */
  maxNodes?: number
  /** Display label for a node; defaults to the id. */
  getLabel?: (ns: string, id: string) => string
}

const key = (ns: string, id: string): string => `${ns}/${id}`

/** Project the relation graph into a `{nodes, edges}` view rooted at `(ns, id)`. */
export function toRelationGraphView(
  graph: CatalogGraphViewRelationGraph,
  opts: GraphViewOptions,
): GraphView {
  const depthLimit = opts.depth ?? 1
  const direction = opts.direction ?? 'both'
  const maxNodes = opts.maxNodes ?? 80
  const label = opts.getLabel ?? ((_ns: string, id: string) => id)

  const nodes = new Map<string, GraphViewNode>()
  const edges: GraphViewEdge[] = []
  const edgeSeen = new Set<string>()
  let truncated = false

  const add = (ns: string, id: string, depth: number): GraphViewNode | undefined => {
    const k = key(ns, id)
    const existing = nodes.get(k)
    if (existing) return existing
    if (nodes.size >= maxNodes) {
      truncated = true
      return undefined
    }
    const node: GraphViewNode = { ns, id, label: label(ns, id), depth }
    nodes.set(k, node)
    return node
  }

  const rootNode = add(opts.ns, opts.id, 0)
  if (!rootNode) return { root: key(opts.ns, opts.id), nodes: [], edges: [], truncated: true }

  let frontier: GraphViewNode[] = [rootNode]
  for (let d = 0; d < depthLimit && frontier.length; d++) {
    const next: GraphViewNode[] = []
    for (const node of frontier) {
      const refs: Array<{
        to: { namespace: string; id: string }
        path: string
        dir: 'out' | 'in'
      }> = []
      if (direction !== 'in')
        for (const r of graph.outgoing(node.ns, node.id))
          refs.push({ to: r.to, path: r.path, dir: 'out' })
      if (direction !== 'out')
        for (const r of graph.incoming(node.ns, node.id))
          refs.push({ to: r.from, path: r.path, dir: 'in' })
      for (const r of refs) {
        const child = add(r.to.namespace, r.to.id, d + 1)
        if (!child) continue
        const from = r.dir === 'out' ? key(node.ns, node.id) : key(r.to.namespace, r.to.id)
        const to = r.dir === 'out' ? key(r.to.namespace, r.to.id) : key(node.ns, node.id)
        const ek = `${from}|${to}|${r.path}`
        if (!edgeSeen.has(ek)) {
          edgeSeen.add(ek)
          edges.push({ from, to, path: r.path, dir: r.dir })
        }
        if (child.depth === d + 1) next.push(child)
      }
    }
    frontier = next
  }

  return { root: key(opts.ns, opts.id), nodes: [...nodes.values()], edges, truncated }
}
