import { createSc2WorkspaceLinkIndex, hasSc2CatalogLinkAt } from '../../modules/galaxy/language/sc2-workspace-links.js'

/** Where each line of a text starts; built once per document for all of its occurrences. */
const lineStarts = text => {
  const starts = [0]
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1))
    starts.push(index + 1)
  return starts
}

/** Line and column of `offset`: the last line start at or before it (lines end at `\n`). */
const position = (starts, offset) => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return { line: low, column: offset - starts[low] }
}

// An SC2 entity is its catalog and id: a declaration knows its class (CUnit), a mention does not,
// so the class stays in the subject and semanticPath and one entity keeps one reference target.
const target = (item, contextId) => ({
  owner: 'blizzard/sc2-data',
  kind: 'catalog-entity',
  namespace: item.namespace,
  id: item.entityId,
  workspace: contextId,
})

/** Project the existing canonical SC2 mixed-link parser into the generic host occurrence DTO. */
export function sc2MixedReferenceOccurrenceBatches(request) {
  const context = request.workspaceContext
  if (context === undefined) return Object.freeze([])
  const documents = [...new Map(
    [request.document, ...request.workspaceDocuments].map(document => [document.uri, document]),
  ).values()]
  const origins = new Map(context.documentOrigins.map(origin => [origin.uri, origin]))
  const links = createSc2WorkspaceLinkIndex(request)
  const items = [
    ...links.declarations.map(item => ({ ...item, declaration: true })),
    ...links.references.map(item => ({ ...item, declaration: false })),
  ]
  // Grouped once, in the same order, instead of scanning every item for every document.
  const itemsByUri = new Map()
  for (const item of items) {
    const list = itemsByUri.get(item.uri)
    if (list === undefined) itemsByUri.set(item.uri, [item])
    else list.push(item)
  }
  return Object.freeze(documents.flatMap(document => {
    const origin = origins.get(document.uri)
    if (origin === undefined) return []
    const own = itemsByUri.get(document.uri) ?? []
    const starts = own.length === 0 ? [0] : lineStarts(document.text)
    const occurrences = own
      .map(item => {
        const at = position(starts, item.start)
        return Object.freeze({
          target: Object.freeze(target(item, context.id)),
          source: Object.freeze({
            uri: document.uri,
            sourceRevision: origin.sourceRevision,
            span: Object.freeze({
              utf16Offset: item.start,
              utf16Length: item.end - item.start,
              line: at.line,
              column: at.column,
            }),
            origin,
          }),
          semanticPath: Object.freeze([item.namespace, item.entityId]),
          role: item.declaration ? 'declaration' : 'reference',
          form: 'literal',
          provenance: links.provenance,
          ...(item.declaration
            ? {
                subject: Object.freeze({
                  workspace: context.id,
                  source: Object.freeze({ id: document.uri }),
                  identity: Object.freeze({
                    kind: 'blizzard/sc2-data-entity',
                    key: `${item.namespace}/${item.entityId}`,
                  }),
                }),
              }
            : {}),
        })
      })
    return [Object.freeze({
      contextId: context.id,
      contextRevision: context.revision,
      semanticComplete: context.semanticComplete && !links.isIncomplete,
      sourceUri: document.uri,
      sourceRevision: origin.sourceRevision,
      occurrences: Object.freeze(occurrences),
    })]
  }))
}

/** Local proof for the mixed catalog occurrence owner; ordinary Galaxy identifiers use its language index. */
export async function sc2MixedReferenceIndexApplies(request) {
  request.signal?.throwIfAborted()
  const starts = lineStarts(request.document.text)
  const offset = starts[request.position.line] + request.position.character
  return hasSc2CatalogLinkAt(request.document, offset)
}

/** Merge owner projections per source without losing differently typed targets at the same URI. */
export function mergeReferenceOccurrenceBatches(...groups) {
  const byUri = new Map()
  for (const group of groups) for (const batch of group) {
    const prior = byUri.get(batch.sourceUri)
    byUri.set(batch.sourceUri, prior === undefined ? batch : Object.freeze({
      ...batch,
      semanticComplete: batch.semanticComplete && prior.semanticComplete,
      occurrences: Object.freeze([...prior.occurrences, ...batch.occurrences]),
    }))
  }
  return Object.freeze([...byUri.values()])
}
