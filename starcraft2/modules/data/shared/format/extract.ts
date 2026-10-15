import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'

/** Minimal catalog lookup surface needed by dependency extraction. */
export interface CatalogExtractStore {
  get(namespace: string, id: string): CatalogEntity | undefined
}

/** Structural relation edge used by dependency extraction. */
export interface CatalogExtractRelation {
  from: CatalogEntity
  to: CatalogEntity
}

/**
 * Minimal graph surface needed by dependency extraction.
 *
 * The richer legacy `@modkitx/ops` `RelationGraph` satisfies this contract structurally.
 */
export interface CatalogExtractRelationGraph {
  outgoing(namespace: string, id: string): readonly CatalogExtractRelation[]
  incoming(namespace: string, id: string): readonly CatalogExtractRelation[]
}

export interface ExtractOptions {
  /** If true, also include all entities that reference the seed (reverse direction). Default false. */
  includeIncoming?: boolean
  /** Namespaces to exclude from traversal. Useful to skip Actor/Sound subtrees when only data is needed. */
  excludeNamespaces?: string[]
}

/**
 * Extract the minimal dependency subtree for a set of seed entities.
 *
 * Performs a BFS over the outgoing relation graph starting from the seeds,
 * also following `parent=` chains for each visited entity.
 * Returns all reachable entities sorted namespace/id.
 */
export function extractSubtree(
  catalog: CatalogExtractStore,
  graph: CatalogExtractRelationGraph,
  seeds: CatalogEntity[],
  opts: ExtractOptions = {},
): CatalogEntity[] {
  const excluded = new Set(opts.excludeNamespaces ?? [])
  const visited = new Map<string, CatalogEntity>() // "Namespace/id" → entity

  function key(e: CatalogEntity): string {
    return `${e.namespace}/${e.id}`
  }

  function enqueue(entity: CatalogEntity, queue: CatalogEntity[]): void {
    const k = key(entity)
    if (visited.has(k)) return
    if (excluded.has(entity.namespace)) return
    visited.set(k, entity)
    queue.push(entity)
  }

  const queue: CatalogEntity[] = []
  for (const seed of seeds) enqueue(seed, queue)

  while (queue.length > 0) {
    const entity = queue.shift()!

    // Follow parent= chain
    if (entity.parent !== undefined) {
      const parent = catalog.get(entity.namespace, entity.parent)
      if (parent !== undefined) enqueue(parent, queue)
    }

    // Follow all outgoing links
    for (const ref of graph.outgoing(entity.namespace, entity.id)) {
      enqueue(ref.to, queue)
    }

    // Optionally follow incoming links
    if (opts.includeIncoming === true) {
      for (const ref of graph.incoming(entity.namespace, entity.id)) {
        enqueue(ref.from, queue)
      }
    }
  }

  return [...visited.values()].sort((a, b) => {
    const nsCmp = a.namespace.localeCompare(b.namespace)
    return nsCmp !== 0 ? nsCmp : a.id.localeCompare(b.id)
  })
}
