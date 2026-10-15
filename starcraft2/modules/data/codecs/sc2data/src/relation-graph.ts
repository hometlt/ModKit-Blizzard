/**
 * The catalog's relation graph, published as `common.view/relation-graph-source`.
 *
 * `relations.ts` — 646 ported lines that walk every typed field of every entity and find the links,
 * including the ones nested inside arrays and structs — was carried across and had no consumer.
 * This is the consumer. Nothing about which fields count as references is decided here; that is the
 * library's knowledge, and it comes from the same schema the checker uses.
 *
 * A node of an entity declared here carries the subject the entity card links by
 * (`entitySubjectId`), the one this codec's subject selector publishes, so opening a node opens its
 * card; a reference target not declared here, or a string key, has no card and no subject.
 *
 * It deliberately does not follow references out of this document set. The graph covers what the codec parsed —
 * `completeness` says so, and a consumer that needs the whole mod asks the analyzer rather than
 * assuming this graph is the world.
 */
import type {
  Page,
  PageRequest,
  RelationGraphEdge,
  RelationGraphNode,
  RelationGraphSource,
  RelationGraphSummary,
} from '@modkit/sdk'
import { buildCatalogRelations } from '../../../../../modules/data/shared/format/relations.js'
import type { CatalogRelationsSource } from '../../../../../modules/data/shared/format/relations.js'
import { entitySubjectId } from './entity-facts.js'

/** `Namespace/id`, the identity a catalog uses and the one the graph keys nodes by. */
function key(namespace: string, id: string): string {
  return `${namespace}/${id}`
}

function page<T>(items: readonly T[], request: PageRequest): Page<T> {
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new TypeError('relation graph page limit must be a positive safe integer')
  }
  const start = request.cursor === undefined ? 0 : Number(request.cursor)
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError('relation graph cursor is invalid')
  }
  const slice = items.slice(start, start + request.limit)
  return Object.freeze({
    items: Object.freeze(slice),
    ...(start + slice.length < items.length
      ? { nextCursor: String(start + slice.length) }
      : {}),
  })
}

export interface CatalogRelationGraphOptions {
  readonly snapshotId: string
  /**
   * Whether the codec parsed the whole dependency chain. A graph built from one file is `partial`,
   * and saying so is the difference between "this entity has no references" and "this view cannot
   * see them".
   */
  readonly complete: boolean
  readonly reason?: string
}

export function createCatalogRelationGraphSource(
  catalog: CatalogRelationsSource,
  options: CatalogRelationGraphOptions,
): RelationGraphSource {
  const graph = buildCatalogRelations(catalog)

  const nodes: RelationGraphNode[] = []
  const seen = new Set<string>()
  for (const namespace of catalog.namespaces()) {
    for (const entity of catalog.all(namespace)) {
      const id = key(entity.namespace, entity.id)
      if (seen.has(id)) continue
      seen.add(id)
      nodes.push(
        Object.freeze({
          id,
          label: entity.id === '' ? `(default ${entity.class})` : entity.id,
          // The presentation bucket is the namespace: a graph of a catalog groups by Unit, Abil,
          // Effect, which is how a modder already thinks about it.
          type: entity.namespace,
          kind: entity.class,
          ...(entity.id === '' ? {} : { subject: entitySubjectId(entity.namespace, entity.id) }),
        }),
      )
    }
  }

  const edges: RelationGraphEdge[] = []
  const edgeSeen = new Set<string>()
  for (const reference of graph.all()) {
    const from = key(reference.from.namespace, reference.from.id)
    const to = key(reference.to.namespace, reference.to.id)
    /*
     * The same pair can be linked through several fields; the role keeps them apart so a reader can
     * tell "used as its weapon" from "used as its death effect" instead of seeing one nameless line.
     */
    const identity = `${from}\u0000${to}\u0000${reference.path}`
    if (edgeSeen.has(identity)) continue
    edgeSeen.add(identity)
    edges.push(Object.freeze({ from, to, role: reference.path }))
  }

  /*
   * Localized text is a reference too, and the surfaces care: renaming a string key should show the
   * entities that use it. The target is not an entity, so it is added as its own node typed `Text`
   * rather than dropped for not fitting the entity shape.
   */
  for (const reference of graph.texts()) {
    const to = key('Text', reference.key)
    if (!seen.has(to)) {
      seen.add(to)
      nodes.push(Object.freeze({ id: to, label: reference.key, type: 'Text', kind: 'string-key' }))
    }
    const from = key(reference.from.namespace, reference.from.id)
    const identity = `${from}\u0000${to}\u0000${reference.path}`
    if (edgeSeen.has(identity)) continue
    edgeSeen.add(identity)
    edges.push(Object.freeze({ from, to, role: reference.path }))
  }

  /*
   * `tone` is the bucket's colour slot, assigned by position so the same namespace keeps the same
   * colour across sessions. Deriving it from the name would be prettier and would change whenever
   * a namespace appears or disappears.
   */
  const typeIds = [...new Set(nodes.map(node => node.type))].sort()
  const types = typeIds.map((id, index) =>
    Object.freeze({
      id,
      label: id,
      count: nodes.filter(node => node.type === id).length,
      tone: index,
    }),
  )

  const summary: RelationGraphSummary = Object.freeze({
    snapshotId: options.snapshotId,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    types: Object.freeze(types),
    completeness: options.complete ? 'complete' : 'partial',
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })

  return Object.freeze({
    async summary() {
      return summary
    },
    async nodes(request: PageRequest, signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      return page(nodes, request)
    },
    async edges(request: PageRequest, signal?: AbortSignal) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      return page(edges, request)
    },
  })
}
