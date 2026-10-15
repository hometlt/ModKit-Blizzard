/**
 * The mod server's answer to one language feature (`data.language`, owner decision 07.10): what a
 * hover, a completion, a diagnostics pass or a code lens needs from the loaded chain, asked in one
 * question and answered from the chain's Data session and strings, so no feature receives the
 * whole catalog.
 *
 * A question names any of:
 * - `authoring: { refs, chains? }` — authoring index rows of those entities (and of their
 *   ancestors), with values and provenance as the full index has them;
 * - `ids: [namespace]` — every id of those Data spaces, in index order;
 * - `summaries: [namespace]` — each id with its class and declaring document;
 * - `defaults: [namespace]` — the ids declared as class templates;
 * - `exists: refs`, `heirs: refs` — declared or not (and template or not); how many inherit;
 * - `metadata: true` — the chain's owner metadata (EditorCategories);
 * - `strings: { keys, locales? }` — localized strings in the chain's locale order;
 * - `search: { needle, limit }` — named entities whose id fuzzily matches;
 * - `declarations: [{ layerId, path, namespace, entityId }]` — the exact range of each entity's first
 *   declaration in that document (its id, as the language provider finds it with `collectAllRefs`
 *   in a document it holds), or null; a definition then needs no copy of the chain's documents;
 * - `constAliases: true` — the `<const>` aliases the chain's catalogs declare (`path\u0000id`), which
 *   a diagnostics pass accepts as enum values, kept per set of session documents.
 * The answer carries the server's `revision` and the Data's completeness (`complete`), and names
 * every document it points at once, in `documents: [{ layerId, path }]` (layer-relative); the host
 * completes each with the URI it uses. `index.sourceDocuments[i]` is `documents[indexDocuments[i]]`;
 * summaries and search name documents by their place in `documents`.
 *
 * Bounds: 16 384 references or keys per part, 64 Data spaces, answers past 48 MiB of authoring rows
 * keep identities and drop values as the full index does.
 */
import type { JsonValue } from '@modkit/sdk'
import type { DataEntitySource } from '@modkit/sdk/data'
import type {
  DataEntityKey,
  DataEntitySummary,
  Starcraft2DataSession,
} from '../../../data/services/catalog/data-session.js'
import type { ChainLayer } from './chain-data.js'
import { collectAllRefs, referenceTargetAt, type RefMatch } from '../../../data/shared/format/language/references.js'
import { catalogConstAliasKeys } from '../../../data/shared/format/language/diagnostics.js'
import { lineStartOffsets, positionAt } from '../../../../shared/xml/text-position.js'

const MAXIMUM_REFS = 16_384
const MAXIMUM_NAMESPACES = 64
const MAXIMUM_SEARCH = 65_536
const MAXIMUM_AUTHORING_BYTES = 48 * 1_024 * 1_024

export interface LanguageAnswerInput {
  readonly session: Starcraft2DataSession
  readonly revision: string
  readonly layers: readonly ChainLayer[]
  /** Localized strings of the chain (`data.strings`), in its locale order. */
  strings(keys: readonly string[], locales: readonly string[] | undefined, signal?: AbortSignal): Promise<readonly unknown[]>
}

function refsOf(value: unknown, part: string): readonly DataEntityKey[] {
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_REFS ||
    !value.every(
      ref =>
        typeof ref?.namespace === 'string' && ref.namespace !== '' &&
        typeof ref?.entityId === 'string' && ref.entityId !== '',
    )
  ) {
    throw new TypeError(`data.language ${part} needs up to ${MAXIMUM_REFS} namespace/entityId references`)
  }
  return value
}

function namespacesOf(value: unknown, part: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_NAMESPACES ||
    !value.every(namespace => typeof namespace === 'string' && namespace !== '')
  ) {
    throw new TypeError(`data.language ${part} needs up to ${MAXIMUM_NAMESPACES} Data spaces`)
  }
  return [...new Set(value as readonly string[])]
}

/** Answer one `data.language` question from the chain's session and strings. */
export async function languageAnswer(
  request: unknown,
  input: LanguageAnswerInput,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const question = request as Readonly<Record<string, unknown>> | null
  if (question === null || typeof question !== 'object' || question['kind'] !== 'data.language') {
    throw new TypeError('a data.language question is an object of kind data.language')
  }
  const { session } = input
  const layerOfRoot = new Map(input.layers.map(layer => [layer.rootId, layer] as const))
  const documents: { readonly layerId: string; readonly path: string }[] = []
  const documentIndexes = new Map<string, number>()
  /** The answer's own index of a document a source names, or -1 for one no layer holds. */
  const documentOf = (source: Pick<DataEntitySource, 'rootId' | 'path'>): number => {
    const key = `${source.rootId}\u0000${source.path}`
    const known = documentIndexes.get(key)
    if (known !== undefined) return known
    const layer = layerOfRoot.get(source.rootId)
    const prefix = layer === undefined ? undefined : `${layer.sourcePath}/`
    const index =
      layer === undefined || prefix === undefined || !source.path.startsWith(prefix)
        ? -1
        : documents.push(Object.freeze({ layerId: layer.id, path: source.path.slice(prefix.length) })) - 1
    documentIndexes.set(key, index)
    return index
  }
  /** A summary as the answer carries it: the declaration's document by index, and its place. */
  const summaryRow = (summary: DataEntitySummary) => {
    const range = summary.source.range
    return Object.freeze({
      namespace: summary.namespace,
      entityId: summary.entityId,
      typeId: summary.typeId,
      document: documentOf(summary.source),
      ...(range?.line === undefined ? {} : { line: range.line }),
      ...(range?.column === undefined ? {} : { column: range.column }),
    })
  }

  const answer: Record<string, JsonValue> = { revision: input.revision, complete: session.complete() }
  const authoring = question['authoring'] as { readonly refs?: unknown; readonly chains?: unknown } | undefined
  if (authoring !== undefined) {
    const { ownerMetadata: _metadata, ...index } = session.authoring(refsOf(authoring.refs, 'authoring'), {
      chains: authoring.chains === true,
      maxOutputBytes: MAXIMUM_AUTHORING_BYTES,
    })
    // The chain's owner metadata goes only to a question that asks for it (`metadata`): it is the
    // whole EditorCategories, and every hover's rows would otherwise carry it.
    answer['index'] = index as unknown as JsonValue
    // The session's index has schema version 2: a table of documents its sources point into.
    answer['indexDocuments'] = index.schemaVersion === 2 ? index.sourceDocuments.map(source => documentOf(source)) : []
  }
  if (question['ids'] !== undefined) {
    answer['ids'] = Object.fromEntries(
      namespacesOf(question['ids'], 'ids').map(namespace => [namespace, [...session.ids(namespace)]]),
    )
  }
  if (question['summaries'] !== undefined) {
    answer['summaries'] = Object.fromEntries(
      namespacesOf(question['summaries'], 'summaries').map(namespace => {
        const rows = session.summaries(namespace)
        return [
          namespace,
          {
            ids: rows.map(row => row.entityId),
            types: rows.map(row => row.typeId),
            documents: rows.map(row => documentOf(row.source)),
          },
        ]
      }),
    )
  }
  if (question['defaults'] !== undefined) {
    answer['defaults'] = Object.fromEntries(
      namespacesOf(question['defaults'], 'defaults').map(namespace => [namespace, [...session.defaults(namespace)]]),
    )
  }
  if (question['exists'] !== undefined) {
    answer['exists'] = session.exists(refsOf(question['exists'], 'exists')) as unknown as JsonValue
  }
  if (question['heirs'] !== undefined) {
    answer['heirs'] = [...session.heirs(refsOf(question['heirs'], 'heirs'))]
  }
  if (question['metadata'] === true) answer['metadata'] = session.metadata() ?? null
  const strings = question['strings'] as { readonly keys?: unknown; readonly locales?: unknown } | undefined
  if (strings !== undefined) {
    const keys = strings.keys
    if (!Array.isArray(keys) || keys.length > MAXIMUM_REFS || !keys.every(key => typeof key === 'string' && key !== '')) {
      throw new TypeError(`data.language strings need up to ${MAXIMUM_REFS} keys`)
    }
    const locales = strings.locales
    if (locales !== undefined && (!Array.isArray(locales) || !locales.every(locale => typeof locale === 'string'))) {
      throw new TypeError('data.language string locales are names like enUS')
    }
    const found: unknown[] = []
    // The strings owner answers a bounded number of keys at a time.
    for (let at = 0; at < keys.length; at += 4_096) {
      found.push(...(await input.strings(keys.slice(at, at + 4_096), locales as readonly string[] | undefined, signal)))
      signal?.throwIfAborted()
    }
    answer['strings'] = found as JsonValue
  }
  const search = question['search'] as { readonly needle?: unknown; readonly limit?: unknown } | undefined
  if (search !== undefined) {
    const limit = search.limit
    if (typeof search.needle !== 'string' || search.needle.length > 512 ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SEARCH) {
      throw new TypeError(`data.language search needs a needle and a limit up to ${MAXIMUM_SEARCH}`)
    }
    answer['search'] = session.search(search.needle, limit).map(summaryRow)
  }
  if (question['declarations'] !== undefined) {
    answer['declarations'] = declarationRanges(question['declarations'], input) as unknown as JsonValue
  }
  if (question['constAliases'] !== undefined) {
    if (question['constAliases'] !== true) throw new TypeError('data.language constAliases is true or absent')
    let aliases = constAliasesOf.get(session.documents)
    if (aliases === undefined) {
      aliases = Object.freeze([...catalogConstAliasKeys(session.documents.map(document => document.text))].sort())
      constAliasesOf.set(session.documents, aliases)
    }
    answer['constAliases'] = aliases as unknown as JsonValue
  }
  answer['documents'] = documents
  return Object.freeze(answer)
}

/** The chain's `<const>` aliases per set of session documents (a new revision has a new set). */
const constAliasesOf = new WeakMap<object, readonly string[]>()

/** Each asked entity's first declaration range in the named document of the chain, or null. */
function declarationRanges(value: unknown, input: LanguageAnswerInput) {
  if (!Array.isArray(value) || value.length > MAXIMUM_REFS || !value.every(item =>
    typeof item?.layerId === 'string' && typeof item?.path === 'string' &&
    typeof item?.namespace === 'string' && item.namespace !== '' &&
    typeof item?.entityId === 'string' && item.entityId !== '')) {
    throw new TypeError(`data.language declarations need up to ${MAXIMUM_REFS} layerId/path/namespace/entityId entries`)
  }
  const layers = new Map(input.layers.map(layer => [layer.id, layer] as const))
  const textOf = new Map(input.session.documents.map(document => [JSON.stringify([document.rootId, document.path]), document.text] as const))
  /** First declaration offsets by entity, per document, read once per answer. */
  const scanned = new Map<string, { readonly starts: number[]; readonly ranges: Map<string, readonly [number, number]> } | null>()
  return (value as readonly { layerId: string; path: string; namespace: string; entityId: string }[]).map(item => {
    const layer = layers.get(item.layerId)
    const document = layer === undefined ? undefined : JSON.stringify([layer.rootId, `${layer.sourcePath}/${item.path}`])
    if (document === undefined) return null
    let found = scanned.get(document)
    if (found === undefined) {
      const text = textOf.get(document)
      if (text === undefined) found = null
      else {
        const ranges = new Map<string, readonly [number, number]>()
        for (const ref of collectAllRefs(text)) {
          const key = JSON.stringify([ref.namespace, ref.id])
          if (ref.kind === 'definition' && !ranges.has(key)) ranges.set(key, [ref.start, ref.end])
        }
        found = { starts: lineStartOffsets(text), ranges }
      }
      scanned.set(document, found)
    }
    const range = found?.ranges.get(JSON.stringify([item.namespace, item.entityId]))
    return found === null || found === undefined || range === undefined
      ? null
      : { start: positionAt(found.starts, range[0]), end: positionAt(found.starts, range[1]) }
  })
}

/** An item of the server's cross-language link index (`galaxy/language/served-links.js`). */
export interface ServedLinkItem {
  readonly uri: string
  readonly start: number
  readonly end: number
  readonly namespace: string
  readonly entityId: string
}

/** A document of the chain as `servedDataReferences` reads it, with its language and name in the link index. */
export interface ServedDataDocument {
  readonly layerId: string
  readonly path: string
  readonly languageId: string
  readonly text: string
  readonly linkUri: string
}

/** A location a served answer names: a document by its place in `documents`, a UTF-16 range. */
type ServedLocation = { readonly document: number; readonly range: { readonly start: { line: number; character: number }; readonly end: { line: number; character: number } } }

/** Link items per document (declarations first, then references), per link index. */
const linkItemsOf = new WeakMap<object, ReadonlyMap<string, readonly (ServedLinkItem & { readonly declaration: boolean })[]>>()
/** Each Data catalog's references grouped by entity, while its text stays the same. */
const catalogRefsOf = new WeakMap<ServedDataDocument, ReadonlyMap<string, readonly RefMatch[]>>()
const lineStartsOf = new WeakMap<ServedDataDocument, number[]>()

/**
 * `data.references`: what a Data references request answers over a snapshot of the chain, from the
 * server's copy of it (owner decision 10.10, no second copy). Two parts merged as the host merges
 * them, without repeats: the occurrences of the cross-language link index (`links`, over the chain's
 * mixed-language `documents`) of the target under the cursor, if a link is there — the host's typed
 * index — and the provider's (`data/providers/language/runtime.js` `referencesAcrossLanguages`): the
 * entity's references in every Data catalog (`collectAllRefs`), then its uses in the other languages
 * (`links.referencesTo`), for the target the Data owner reads even in a half-typed tag. Documents go
 * in snapshot order: the asked one first, then the chain's. `incomplete` is the asking workspace's;
 * the index adds its own.
 */
export function servedDataReferences(input: {
  readonly documents: readonly ServedDataDocument[]
  readonly primary: { readonly layerId: string; readonly path: string }
  readonly offset: number
  readonly includeDeclaration: boolean
  readonly maxResults: number
  readonly incomplete: boolean
  readonly links: {
    readonly declarations: readonly ServedLinkItem[]
    readonly references: readonly ServedLinkItem[]
    readonly isIncomplete: boolean
    referencesTo(namespace: string, entityId: string, includeDeclaration?: boolean): readonly { readonly uri: string; readonly range: ServedLocation['range'] }[]
  }
}): { readonly documents: readonly { readonly layerId: string; readonly path: string }[]; readonly locations: readonly ServedLocation[]; readonly isIncomplete: boolean } | undefined {
  const primary = input.documents.find(document => document.layerId === input.primary.layerId && document.path === input.primary.path)
  if (primary === undefined) return undefined
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > primary.text.length) {
    throw new RangeError('data.references offset is outside its document')
  }
  const order = [primary, ...input.documents.filter(document => document !== primary)]
  const catalogs = order.filter(document => document.languageId === 'sc2-data')
  const places: { layerId: string; path: string }[] = []
  const slots = new Map<ServedDataDocument, number>()
  const slotOf = (document: ServedDataDocument): number => {
    let slot = slots.get(document)
    if (slot === undefined) {
      slot = places.push({ layerId: document.layerId, path: document.path }) - 1
      slots.set(document, slot)
    }
    return slot
  }
  const rangeIn = (document: ServedDataDocument, start: number, end: number) => {
    let starts = lineStartsOf.get(document)
    if (starts === undefined) lineStartsOf.set(document, (starts = lineStartOffsets(document.text)))
    return { start: positionAt(starts, start), end: positionAt(starts, end) }
  }
  type Range = ServedLocation['range']
  type Part = { readonly locations: { readonly document: ServedDataDocument; readonly range: Range }[]; readonly isIncomplete: boolean }
  // The typed index: the link occurrences of the target under the cursor, the shortest first.
  let items = linkItemsOf.get(input.links)
  if (items === undefined) {
    const grouped = new Map<string, (ServedLinkItem & { readonly declaration: boolean })[]>()
    for (const item of [...input.links.declarations.map(entry => ({ ...entry, declaration: true })),
      ...input.links.references.map(entry => ({ ...entry, declaration: false }))]) {
      const list = grouped.get(item.uri)
      if (list === undefined) grouped.set(item.uri, [item])
      else list.push(item)
    }
    linkItemsOf.set(input.links, (items = grouped))
  }
  let indexed: Part | undefined
  const atCursor = (items.get(primary.linkUri) ?? [])
    .filter(item => input.offset >= item.start && input.offset <= item.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]
  if (atCursor !== undefined) {
    const found = order.flatMap(document => (items.get(document.linkUri) ?? [])
      .filter(item => item.namespace === atCursor.namespace && item.entityId === atCursor.entityId &&
        (input.includeDeclaration || !item.declaration))
      .map(item => ({ document, range: rangeIn(document, item.start, item.end) })))
    indexed = {
      locations: found.slice(0, input.maxResults),
      isIncomplete: found.length > input.maxResults || input.incomplete || input.links.isIncomplete,
    }
  }
  // The provider's: the entity's references in every catalog, then its uses in the other languages.
  let own: Part
  const target = referenceTargetAt(primary.text, input.offset)
  if (target === undefined) own = { locations: [], isIncomplete: false }
  else {
    const locations: Part['locations'] = []
    let capped = false
    for (const document of catalogs) {
      let grouped = catalogRefsOf.get(document)
      if (grouped === undefined) {
        const map = new Map<string, RefMatch[]>()
        for (const ref of collectAllRefs(document.text)) {
          const key = JSON.stringify([ref.namespace, ref.id])
          const list = map.get(key)
          if (list === undefined) map.set(key, [ref])
          else list.push(ref)
        }
        catalogRefsOf.set(document, (grouped = map))
      }
      for (const ref of grouped.get(JSON.stringify([target.namespace, target.id])) ?? []) {
        if (!input.includeDeclaration && ref.kind === 'definition') continue
        locations.push({ document, range: rangeIn(document, ref.start, ref.end) })
        if (locations.length >= input.maxResults) {
          capped = true
          break
        }
      }
      if (capped) break
    }
    const byLinkUri = new Map(order.map(document => [document.linkUri, document]))
    const cross = input.links.referencesTo(target.namespace, target.id, input.includeDeclaration)
      .flatMap(item => {
        const document = byLinkUri.get(item.uri)
        return document === undefined ? [] : [{ document, range: item.range }]
      })
    // As `referencesAcrossLanguages` merges them: no repeats, capped at maxResults.
    const seen = new Set<string>()
    const merged = [...locations, ...cross].filter(location => {
      const key = JSON.stringify([location.document.linkUri, location.range])
      return !seen.has(key) && seen.add(key) !== undefined
    })
    own = {
      locations: merged.slice(0, input.maxResults),
      isIncomplete: capped || input.incomplete || merged.length > input.maxResults ||
        (cross.length > 0 && input.links.isIncomplete),
    }
  }
  // Merged as the host merges an index answer with a provider's: one list, no repeats.
  const present = indexed === undefined ? [own] : [indexed, own]
  const seen = new Set<string>()
  const locations: ServedLocation[] = []
  for (const part of present) {
    for (const location of part.locations) {
      const range = location.range
      const key = JSON.stringify([slotOf(location.document), range])
      if (seen.has(key)) continue
      seen.add(key)
      locations.push({ document: slotOf(location.document), range })
    }
  }
  // Neither a catalog-only answer nor a bounded index proves the mixed-language search complete.
  return { documents: places, locations: locations.slice(0, input.maxResults),
    isIncomplete: input.incomplete || input.links.isIncomplete || locations.length > input.maxResults ||
      present.some(part => part.isIncomplete) }
}
