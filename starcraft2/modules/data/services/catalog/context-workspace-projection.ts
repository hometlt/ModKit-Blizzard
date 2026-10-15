/**
 * SC2 resolved-workspace provider adapter to its canonical ModContext Data owner. Describes the
 * native loaded catalog, binds its documents to the already revision-pinned Host inputs, verifies
 * SHA-256 of decoded semantic text (including loader controls/localization/usages), and consumes
 * the existing bounded snapshot pages. Only declared DataEntitySource positions are rebound to
 * Host roots/paths/revisions; game values, tokens, metadata and canonical synthetic IDs stay intact.
 * Native ranges/lexemes, full values, diagnostics, relations and schema come from the one projector.
 *
 * The provider's existing snapshot book, typed edit owners and Host physical/topology/history
 * guards remain authoritative. No parser/resolver/model registry or writer is added. Standalone
 * and partial plans without every canonical catalog return undefined to the existing analyzer;
 * content/revision/protocol errors refuse rather than attach a new token to old data. The one
 * context projection lease is closed on success/failure/cancellation, and page counts, cursor
 * progress, negotiated bytes, source bindings and context revision are checked before publication.
 */
import type { JsonValue, ModContextQueryPort, ModWorkspaceLock } from '@modkit/sdk'
import type { DataCatalogDocument, DataEntitySource, DataResolvedEntity, ResolvedDataWorkspaceAnalysisRequest,
  ResolvedDataWorkspaceSnapshot } from '@modkit/sdk/data'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../schema/data-schema-identity.js'

const PAGE_BYTES = 8 * 1024 * 1024
const PAGE_ROWS = 1000
const MAX_DOCUMENTS = 4096
const facets = ['schemas', 'definitions', 'entities', 'relations', 'localizedStrings', 'diagnostics'] as const
const encoder = new TextEncoder()
const keyOf = (rootId: string, path: string) => `${rootId}\0${path.toLowerCase()}`

interface NativeLayer { readonly id: string; readonly rootId: string; readonly sourcePath: string }
interface NativeDocument { readonly layerId: string; readonly path: string; readonly rootId: string; readonly nativePath: string; readonly documentIndex: number }
interface Description { readonly revision: string; readonly schemaRevision: string; readonly layers: readonly NativeLayer[]; readonly documents: readonly NativeDocument[];
  readonly controls: readonly { layerId: string; path: string }[] }
interface SourceBinding { readonly document: DataCatalogDocument; readonly documentIndex: number }

/** Bind semantic input identities, consume the native projection, and preserve full source fidelity. */
export async function queryStarcraft2ContextWorkspaceProjection(
  port: ModContextQueryPort,
  workspace: ModWorkspaceLock,
  request: ResolvedDataWorkspaceAnalysisRequest,
  baseline = request,
): Promise<ResolvedDataWorkspaceSnapshot | undefined> {
  // Incomplete resource plans keep the standalone projector's truthful partial result.
  if (request.unresolvedRequirementIds.length > 0 || baseline.unresolvedRequirementIds.length > 0) return undefined
  const query = (question: object, signal = request.signal) =>
    port.query(workspace.workspaceId, question as unknown as JsonValue, signal)
  const described = await query({ kind: 'data.workspace', action: 'describe' }) as unknown as Description
  if (typeof described?.revision !== 'string' || !Array.isArray(described.layers) || !Array.isArray(described.documents) ||
      !Array.isArray(described.controls) || described.controls.length > workspace.loadOrder.length ||
      described.schemaRevision !== STARCRAFT2_DATA_SCHEMA_REVISION || described.layers.length !== workspace.loadOrder.length ||
      described.documents.length > MAX_DOCUMENTS || encoder.encode(JSON.stringify(described)).byteLength > PAGE_BYTES)
    throw new TypeError('invalid canonical Data workspace description')
  const layers = new Map<string, NativeLayer>()
  for (const [index, layer] of described.layers.entries()) {
    if (typeof layer?.id !== 'string' || typeof layer.rootId !== 'string' || typeof layer.sourcePath !== 'string' ||
        layer.id !== workspace.loadOrder[index]!.rootId || layers.has(layer.id))
      throw new TypeError('canonical Data layers do not match the pinned workspace order')
    const root = workspace.loadOrder[index]!
    const expected = (root as typeof root & { location?: string }).location ?? root.sourcePath
    const nativePath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/u, '')
    if (root.caseSensitive === true ? nativePath(expected) !== nativePath(layer.sourcePath)
      : nativePath(expected).toLowerCase() !== nativePath(layer.sourcePath).toLowerCase())
      throw new TypeError('canonical Data layer source path differs from the pinned workspace')
    layers.set(layer.id, layer)
  }
  const sourceBindings = new Map<string, SourceBinding>()
  const allCatalogs = new Map<string, { document: DataCatalogDocument; documentIndex: number; layerId: string; path: string }>()
  /** Resolve a Host input inside its declared workspace root, without guessing native paths. */
  const locate = (document: DataCatalogDocument, documentIndex: number) => {
    const root = workspace.loadOrder.find(root => root.rootId === document.rootId)
    const layer = layers.get(document.rootId)
    if (root === undefined || layer === undefined) throw new TypeError('Data input has no canonical context layer')
    const prefix = `${root.sourcePath}/`
    if (!(root.caseSensitive === true ? document.path.startsWith(prefix) : document.path.toLowerCase().startsWith(prefix.toLowerCase())))
      throw new TypeError('Data input is outside its pinned workspace root')
    const path = document.path.slice(prefix.length)
    if (path === '' || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..'))
      throw new TypeError('Data input is not a confined layer-relative path')
    return { document, documentIndex, layerId: layer.id, path, nativeKey: keyOf(layer.rootId, `${layer.sourcePath}/${path}`) }
  }
  /** Bind only provenance positions to prospective Host inputs; baseline guards are independent. */
  const bind = (document: DataCatalogDocument, documentIndex: number) => {
    const located = locate(document, documentIndex)
    const { nativeKey } = located
    if (sourceBindings.has(nativeKey)) throw new TypeError('ambiguous canonical Data input source')
    sourceBindings.set(nativeKey, { document, documentIndex })
    return located
  }
  for (const [index, document] of baseline.documents.entries()) {
    const bound = locate(document, index)
    if (allCatalogs.has(keyOf(bound.layerId, bound.path))) throw new TypeError('duplicate pinned Data catalog input')
    allCatalogs.set(keyOf(bound.layerId, bound.path), bound)
  }
  for (const control of described.controls) {
    if (!layers.has(control?.layerId) || typeof control.path !== 'string' || control.path.toLowerCase() !== 'base.sc2data/gamedata.xml')
      throw new TypeError('invalid canonical Data loader control')
    if (!allCatalogs.has(keyOf(control.layerId, control.path))) return undefined
  }
  const modelKeys = new Set<string>()
  for (const [index, document] of described.documents.entries()) {
    const layer = layers.get(document?.layerId)
    if (layer === undefined || typeof document.path !== 'string' || document.path === '' ||
        document.rootId !== layer.rootId || document.nativePath !== `${layer.sourcePath}/${document.path}` ||
        document.documentIndex !== index)
      throw new TypeError('invalid canonical Data document identity')
    const key = keyOf(document.layerId, document.path)
    if (modelKeys.has(key)) throw new TypeError('duplicate canonical Data document identity')
    modelKeys.add(key)
    if (!allCatalogs.has(key)) return undefined
  }
  if (allCatalogs.size - modelKeys.size > MAX_DOCUMENTS) return undefined
  /** Hash only decoded semantic text. The Host's raw physical/revision guards remain separate. */
  const guarded = async (bound: { document: DataCatalogDocument; layerId: string; path: string }) => ({
    layerId: bound.layerId, path: bound.path, textSha256: await sha256Hex(encoder.encode(bound.document.text)),
  })
  const catalogGuards = []
  const catalogControls = []
  for (const bound of allCatalogs.values()) {
    const guard = await guarded(bound)
    if (modelKeys.has(keyOf(bound.layerId, bound.path))) catalogGuards.push(guard)
    else catalogControls.push(guard)
  }
  const resources = []
  for (const [index, document] of (baseline.localizationDocuments ?? []).entries()) {
    resources.push({ ...await guarded(locate(document, index)), kind: 'localization', locale: document.locale })
  }
  for (const [index, document] of (baseline.usageDocuments ?? []).entries()) resources.push({ ...await guarded(locate(document, index)), kind: 'usage' })
  const catalogOverrides = []
  for (const [index, document] of request.documents.entries()) {
    const bound = bind(document, index)
    const original = allCatalogs.get(keyOf(bound.layerId, bound.path))
    if (baseline !== request && original?.document.text !== document.text) {
      if (bound.layerId !== workspace.activeRootId) throw new TypeError('Data preview changes a read-only dependency')
      catalogOverrides.push({ layerId: bound.layerId, path: bound.path, text: document.text })
    }
  }
  for (const [kind, documents, saved] of [
    ['localization', request.localizationDocuments ?? [], baseline.localizationDocuments ?? []],
    ['usage', request.usageDocuments ?? [], baseline.usageDocuments ?? []],
  ] as const) {
    if (documents.length !== saved.length) throw new TypeError(`Data preview changed its pinned ${kind} inputs`)
    for (const [index, document] of documents.entries()) {
      const original = saved[index]!
      if (document.rootId !== original.rootId || document.path !== original.path || document.text !== original.text)
        throw new TypeError(`Data preview changed its pinned ${kind} input`)
      bind(document, index)
    }
  }
  request.signal?.throwIfAborted()
  // Pin the close address before await: a cancellation at the Host boundary can hide a
  // successful open response, but must still release only this request's projection.
  let leaseId: string | undefined = globalThis.crypto.randomUUID()
  const requestedLeaseId = leaseId
  let succeeded = false
  try {
    const opened = await query({ kind: 'data.workspace', action: 'open', leaseId: requestedLeaseId,
      revision: described.revision, maxPageBytes: PAGE_BYTES,
      options: { workspaceId: request.workspaceId, locales: request.locales, localizationKeys: request.localizationKeys,
        queries: request.queries, maxDocuments: request.maxDocuments, maxTextBytes: request.maxTextBytes,
        maxEntities: request.maxEntities, maxDepth: request.maxDepth }, catalogGuards, catalogControls, catalogOverrides, resources }) as unknown as {
        leaseId: string; revision: string; metadata: Record<string, unknown>; counts: Record<string, number>;
      }
    if (typeof opened?.leaseId !== 'string' || opened.leaseId === '') throw new TypeError('canonical Data projection returned no lease')
    leaseId = opened.leaseId
    if (opened.leaseId !== requestedLeaseId || opened.revision !== described.revision || opened.metadata === null || typeof opened.metadata !== 'object' ||
        opened.counts === null || typeof opened.counts !== 'object' || encoder.encode(JSON.stringify(opened)).byteLength > PAGE_BYTES)
      throw new TypeError('invalid canonical Data projection metadata')
    const result: Record<string, unknown> = { ...opened.metadata }
    for (const facet of facets) {
      const count = opened.counts[facet]
      if (!Number.isSafeInteger(count) || count! < 0) throw new TypeError('invalid canonical Data facet count')
      const rows: unknown[] = []
      let cursor = 0
      do {
        const page = await query({ kind: 'data.workspace', action: 'page', revision: described.revision, leaseId, facet, cursor, limit: PAGE_ROWS }) as unknown as {
          leaseId: string; revision: string; facet: string; rows: unknown[]; count: number; nextCursor?: number;
        }
        if (page?.leaseId !== leaseId || page.revision !== described.revision || page.facet !== facet || page.count !== count ||
            !Array.isArray(page.rows) || page.rows.length > PAGE_ROWS || rows.length + page.rows.length > count! ||
            encoder.encode(JSON.stringify(page)).byteLength > PAGE_BYTES ||
            (page.nextCursor !== undefined && (page.rows.length === 0 || page.nextCursor !== rows.length + page.rows.length || page.nextCursor >= count!)))
          throw new TypeError('invalid canonical Data projection page or cursor')
        rows.push(...page.rows)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      } while (true)
      if (rows.length !== count) throw new TypeError('canonical Data facet ended before its declared count')
      result[facet] = rows
    }
    request.signal?.throwIfAborted()
    const native = result as unknown as ResolvedDataWorkspaceSnapshot
    if (native.workspaceId !== request.workspaceId || native.gameId !== request.gameId || native.schemaVersion !== 1 ||
        typeof native.snapshotId !== 'string' || typeof native.complete !== 'boolean')
      throw new TypeError('canonical Data projection does not match this workspace')
    const mapped = new WeakMap<DataEntitySource, DataEntitySource>()
    /** Rebind only declared provenance positions, preserving ranges and game-owned payloads. */
    const source = (value: DataEntitySource): DataEntitySource => {
      const known = mapped.get(value)
      if (known !== undefined) return known
      const binding = sourceBindings.get(keyOf(value.rootId, value.path))
      if (binding === undefined) throw new TypeError('canonical Data source has no revision-pinned Host input')
      const { revision: _nativeRevision, ...location } = value
      const answer = Object.freeze({ ...location, rootId: binding.document.rootId, path: binding.document.path,
        documentIndex: binding.documentIndex, ...(binding.document.revision === undefined ? {} : { revision: binding.document.revision }) })
      mapped.set(value, answer)
      return answer
    }
    const entity = (value: DataResolvedEntity): DataResolvedEntity => Object.freeze({ ...value,
      sources: Object.freeze(value.sources.map(source)), ...(value.fieldSources === undefined ? {} : {
        fieldSources: Object.freeze(Object.fromEntries(Object.entries(value.fieldSources).map(([field, value]) => [field, source(value)]))),
      }) })
    const snapshot = Object.freeze({ ...native, definitions: Object.freeze(native.definitions.map(entity)), entities: Object.freeze(native.entities.map(entity)),
      localizedStrings: Object.freeze(native.localizedStrings.map(value => Object.freeze({ ...value, source: source(value.source) }))),
      relations: Object.freeze(native.relations.map(value => Object.freeze({ ...value,
        ...(value.source === undefined ? {} : { source: source(value.source) }) }))),
      diagnostics: Object.freeze(native.diagnostics.map(value => {
        if (value.source === undefined) return value
        const bound = source(value.source)
        const prefix = `${value.source.path}:`
        return Object.freeze({ ...value, source: bound,
          message: value.message.startsWith(prefix) ? `${bound.path}:${value.message.slice(prefix.length)}` : value.message })
      })) })
    succeeded = true
    return snapshot
  } finally {
    if (leaseId !== undefined) {
      try {
        const closed = await port.query(workspace.workspaceId, { kind: 'data.workspace', action: 'close', leaseId }) as { closed?: unknown }
        if (succeeded && closed?.closed !== true) throw new Error('canonical Data projection lease changed before close')
        if (succeeded) {
          const current = await query({ kind: 'data.workspace', action: 'revision' }) as { revision?: unknown }
          if (current?.revision !== described.revision) throw new Error('canonical Data context revision changed before publication')
        }
      }
      catch (error) { if (succeeded) throw error }
    }
  }
}
