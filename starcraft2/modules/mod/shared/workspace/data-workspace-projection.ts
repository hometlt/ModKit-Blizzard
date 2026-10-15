/**
 * SC2 ModContext delivery of the existing full Data projection, owned by the mod loader and
 * canonical Data session. `data.workspace` opens one recoverable projection lease, pages schema,
 * definitions, entities, relations, strings and diagnostics, then closes it. Catalog XML never
 * travels in these answers. Named localization/usage inputs read through the context's existing
 * ChainReader; optional raw-byte/decoded-text SHA-256 guards use codec-kit's digest owner.
 * Describe binds native layers/schema/catalog order; guarded loader controls and active prospective
 * overrides let typed previews fork the canonical session through the existing catalog loader.
 * An optional caller UUID binds open/close even if cancellation hides the open response.
 *
 * Native document identities, calculated values, lexemes, ranges, provenance and completeness
 * are the existing projector's. No parser/resolver, dependency loader, writer or model registry
 * is added. Revisions guard every async phase and page; a stale/disposed lease loses its snapshot.
 * One live/pending lease per context refuses concurrent replacement. Pages bound both rows and
 * UTF-8 JSON bytes (at most 8 MiB), including metadata; an oversized row refuses explicitly.
 * This bounds delivery and the number of snapshots, not the canonical model's heap/RSS. Host
 * alias binding and physical editing guards remain the Host adapter's responsibility.
 */
import type { DataCatalogDocument, ResolvedDataWorkspaceAnalysisRequest, ResolvedDataWorkspaceSnapshot } from '@modkit/sdk/data'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { chainCatalogDocuments, type ChainData, type ChainLayer, type ChainReader } from './chain-data.js'

const MAX_PAGE_BYTES = 8 * 1024 * 1024
const MAX_ROWS = 1000
const MAX_INPUTS = 4096
const MAX_READ_BYTES = 64 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const facets = ['schemas', 'definitions', 'entities', 'relations', 'localizedStrings', 'diagnostics'] as const
type Facet = typeof facets[number]
type ProjectionOptions = Pick<ResolvedDataWorkspaceAnalysisRequest,
  'workspaceId' | 'locales' | 'localizationKeys' | 'queries' | 'maxDocuments' | 'maxTextBytes' | 'maxEntities' | 'maxDepth'>

/** One context-local delivery lease over its canonical session's full projection. */
export function createContextDataWorkspaceProjection(owner: {
  readonly data: ChainData
  readonly layers: readonly ChainLayer[]
  readonly reader: ChainReader
  readonly revision: () => string
}) {
  let disposed = false
  let pending = false
  let lease: { id: string; revision: string; maxPageBytes: number; snapshot: ResolvedDataWorkspaceSnapshot } | undefined

  /** Reject another revision before returning or publishing any part of the projection. */
  const current = (revision: unknown, signal?: AbortSignal): string => {
    signal?.throwIfAborted()
    if (disposed) throw new Error('Data workspace projection is disposed')
    if (typeof revision !== 'string' || revision !== owner.revision()) {
      if (lease?.revision !== owner.revision()) lease = undefined
      throw new Error('Data workspace projection revision changed')
    }
    return revision
  }
  /** Measure the actual wire encoding, including envelope/cursor fields. */
  const bounded = <T>(value: T, maxBytes: number): T => {
    if (encoder.encode(JSON.stringify(value)).byteLength > maxBytes)
      throw new RangeError(`Data workspace answer exceeds ${maxBytes} JSON bytes`)
    return value
  }
  /** Resolve a named input through an existing layer; confinement stays with ChainReader. */
  const input = (value: unknown) => {
    const item = value as { layerId?: unknown; path?: unknown; kind?: unknown; locale?: unknown; sha256?: unknown; textSha256?: unknown } | null
    const layer = owner.layers.find(layer => layer.id === item?.layerId)
    if (layer === undefined || typeof item?.path !== 'string' || item.path === '' ||
        item.path.includes('\\') || item.path.startsWith('/') || item.path.includes('\0') ||
        item.path.split('/').some(part => part === '' || part === '.' || part === '..'))
      throw new TypeError('Data workspace input needs a confined layer-relative path')
    return { layer, item: { ...item, path: item.path }, rootId: layer.rootId, path: `${layer.sourcePath}/${item.path}` }
  }
  /** Fingerprints bind decoded semantic input separately from any optional raw-byte guard. */
  const fingerprint = (ref: ReturnType<typeof input>, required: boolean): void => {
    const hashes = [ref.item.sha256, ref.item.textSha256].filter(value => value !== undefined)
    if ((required && hashes.length === 0) || hashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)))
      throw new TypeError('Data workspace guard needs a SHA-256 content fingerprint')
  }
  /** Compare through the existing digest owner; decoded fingerprints never replace file revisions. */
  const checkContent = async (ref: ReturnType<typeof input>, bytes: Uint8Array): Promise<string> => {
    const text = decoder.decode(bytes)
    if ((ref.item.sha256 !== undefined && await sha256Hex(bytes) !== ref.item.sha256) ||
        (ref.item.textSha256 !== undefined && await sha256Hex(encoder.encode(text)) !== ref.item.textSha256))
      throw new Error('Data workspace catalog content guard changed')
    return text
  }

  return {
    /** The existing ModContext.query dispatches only this game-defined question here. */
    async query(request: unknown, signal?: AbortSignal): Promise<unknown> {
      const question = request as { action?: unknown; revision?: unknown; leaseId?: unknown; facet?: unknown;
        cursor?: unknown; limit?: unknown; maxPageBytes?: unknown; options?: unknown; resources?: unknown;
        catalogGuards?: unknown; catalogControls?: unknown; catalogOverrides?: unknown } | null
      if (question?.action === 'revision') return { revision: current(owner.revision(), signal) }
      if (question?.action === 'describe') {
        const revision = current(owner.revision(), signal)
        const { STARCRAFT2_DATA_SCHEMA_REVISION } = await import('../../../data/services/schema/data-schema-identity.js')
        const session = await owner.data.session(signal)
        current(revision, signal)
        const controls = []
        for (const layer of owner.layers) {
          const files = await owner.reader.files(layer.id)
          current(revision, signal)
          const path = files.find(path => path.toLowerCase() === 'base.sc2data/gamedata.xml')
          if (path !== undefined) controls.push({ layerId: layer.id, path })
        }
        return bounded({ revision, schemaRevision: STARCRAFT2_DATA_SCHEMA_REVISION, layers: owner.layers, controls,
          documents: session.documents.map((document, documentIndex) => {
            const layer = owner.layers.find(layer => layer.rootId === document.rootId && document.path.startsWith(`${layer.sourcePath}/`))
            if (layer === undefined) throw new Error('canonical catalog document has no context layer')
            return { layerId: layer.id, path: document.path.slice(layer.sourcePath.length + 1), rootId: document.rootId,
              nativePath: document.path, documentIndex }
          }) }, MAX_PAGE_BYTES)
      }
      if (question?.action === 'close') {
        signal?.throwIfAborted()
        if (disposed) throw new Error('Data workspace projection is disposed')
        if (typeof question.leaseId !== 'string') throw new TypeError('Data workspace close needs a leaseId')
        const closed = lease?.id === question.leaseId
        if (closed) lease = undefined
        return { closed }
      }
      const revision = current(question?.revision, signal)
      if (question?.action === 'page') {
        const active = lease
        if (active === undefined || active.id !== question.leaseId || active.revision !== revision)
          throw new Error('Data workspace projection lease is unavailable')
        if (!facets.includes(question.facet as Facet) || !Number.isSafeInteger(question.limit) ||
            (question.limit as number) < 1 || (question.limit as number) > MAX_ROWS ||
            (question.cursor !== undefined && (!Number.isSafeInteger(question.cursor) || (question.cursor as number) < 0)))
          throw new TypeError('invalid Data workspace page')
        const values = active.snapshot[question.facet as Facet] ?? []
        const start = question.cursor === undefined ? 0 : question.cursor as number
        if (start > values.length) throw new TypeError('Data workspace cursor exceeds the facet')
        const rows: unknown[] = []
        const envelope = (consumed: number) => ({ revision, leaseId: active.id, facet: question.facet, rows: [] as unknown[],
          count: values.length, ...(start + consumed < values.length ? { nextCursor: start + consumed } : {}) })
        const response = () => ({ ...envelope(rows.length), rows })
        // Measure each row and the small envelope once; serializing the accumulated page on
        // every iteration would make large pages quadratic.
        let bytes = 0
        for (let index = start; index < Math.min(values.length, start + (question.limit as number)); index += 1) {
          const rowBytes = encoder.encode(JSON.stringify(values[index])).byteLength + (rows.length === 0 ? 0 : 1)
          const headerBytes = encoder.encode(JSON.stringify(envelope(rows.length + 1))).byteLength
          if (headerBytes + bytes + rowBytes > active.maxPageBytes) {
            if (rows.length === 0) throw new RangeError(`Data workspace row exceeds ${active.maxPageBytes} JSON bytes`)
            break
          }
          rows.push(values[index])
          bytes += rowBytes
        }
        return bounded(response(), active.maxPageBytes)
      }
      if (question?.action !== 'open') throw new TypeError('unknown Data workspace action')
      if (pending || lease !== undefined) throw new Error('Data workspace projection already has an active lease')
      const maxPageBytes = question.maxPageBytes ?? MAX_PAGE_BYTES
      if (!Number.isSafeInteger(maxPageBytes) || (maxPageBytes as number) < 1024 || (maxPageBytes as number) > MAX_PAGE_BYTES)
        throw new TypeError('invalid Data workspace byte limit')
      if (question.leaseId !== undefined && (typeof question.leaseId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(question.leaseId)))
        throw new TypeError('Data workspace open leaseId must be a UUID')
      const id = question.leaseId === undefined ? globalThis.crypto.randomUUID() : question.leaseId
      if (question.options === null || typeof question.options !== 'object' || Array.isArray(question.options))
        throw new TypeError('Data workspace open needs projection options')
      const resources = question.resources ?? []
      const guards = question.catalogGuards ?? []
      const controls = question.catalogControls ?? []
      const overrides = question.catalogOverrides ?? []
      if (!Array.isArray(resources) || resources.length > MAX_INPUTS || !Array.isArray(guards) || guards.length > MAX_INPUTS ||
          !Array.isArray(controls) || controls.length > MAX_INPUTS || !Array.isArray(overrides) || overrides.length > MAX_INPUTS ||
          ((controls.length > 0 || overrides.length > 0) && question.catalogGuards === undefined))
        throw new TypeError('too many Data workspace inputs')
      const named = resources.map(input)
      const pinned = guards.map(input)
      const controlled = controls.map(input)
      const prospective = overrides.map(value => ({ ...input(value), text: (value as { text?: unknown } | null)?.text }))
      const changes = new Map<string, { path: string; text: string }>()
      for (const ref of prospective) {
        if (ref.layer.id !== owner.layers.at(-1)?.id || typeof ref.text !== 'string' ||
            !/^base\.sc2data\/(?:gamedata\/.+\.xml|gamedata\.xml|editordata\/editorcategories\.xml)$/iu.test(ref.item.path) ||
            encoder.encode(ref.text).byteLength > Math.min(MAX_READ_BYTES, (question.options as ProjectionOptions).maxTextBytes))
          throw new TypeError('Data preview needs bounded catalog text in the active layer')
        const key = `${ref.layer.id}\0${ref.item.path.toLowerCase()}`
        if (changes.has(key)) throw new TypeError('duplicate Data preview document')
        changes.set(key, { path: ref.item.path, text: ref.text })
      }
      const pinnedSeen = new Set<string>()
      const seen = new Set<string>()
      for (const ref of named) {
        if ((ref.item.kind !== 'localization' && ref.item.kind !== 'usage') ||
            (ref.item.kind === 'localization' && typeof ref.item.locale !== 'string'))
          throw new TypeError('Data workspace resource needs a kind and localization locale')
        const key = `${ref.layer.id}\0${ref.item.path.toLowerCase()}`
        if (seen.has(key)) throw new TypeError('duplicate Data workspace resource')
        seen.add(key)
        fingerprint(ref, false)
      }
      for (const ref of [...pinned, ...controlled]) {
        fingerprint(ref, true)
        const key = `${ref.layer.id}\0${ref.item.path.toLowerCase()}`
        if (pinnedSeen.has(key)) throw new TypeError('duplicate Data workspace guard')
        pinnedSeen.add(key)
      }
      pending = true
      try {
        const session = await owner.data.session(signal)
        current(revision, signal)
        if (question.catalogGuards !== undefined && pinned.length !== session.documents.length)
          throw new TypeError('Data workspace catalog guards must cover the canonical model exactly')
        const options = question.options as ProjectionOptions
        // Empty facet text validates limits, locales, queries and exact accounting before facet I/O.
        const placeholders = named.map(ref => ({ rootId: ref.rootId, path: ref.path, text: '',
          ...(ref.item.kind === 'localization' ? { locale: ref.item.locale as string } : {}) }))
        const base = { ...options, gameId: 'blizzard/starcraft-2', documents: session.documents as readonly DataCatalogDocument[],
          localizationDocuments: placeholders.flatMap((document, index) => named[index]!.item.kind === 'localization'
            ? [{ ...document, locale: named[index]!.item.locale as string }] : []),
          usageDocuments: placeholders.filter((_, index) => named[index]!.item.kind === 'usage'),
          plannedDocumentCount: session.documents.length + named.length, unresolvedRequirementIds: [],
          ...(signal === undefined ? {} : { signal }) }
        const { validateStarcraft2ResolvedDataRequest } = await import('../../../data/services/catalog/provider.js')
        current(revision, signal)
        validateStarcraft2ResolvedDataRequest({ ...base,
          documents: [...session.documents as readonly DataCatalogDocument[], ...controlled.map(ref => ({ rootId: ref.rootId, path: ref.path, text: '' }))],
          plannedDocumentCount: base.plannedDocumentCount + controlled.length })
        let guardedTextBytes = 0
        const savedText = new Map<string, string>()
        for (const ref of pinned) {
          current(revision, signal)
          const document = session.documents.find(document => document.rootId === ref.rootId && document.path.toLowerCase() === ref.path.toLowerCase())
          if (document === undefined)
            throw new TypeError('Data workspace catalog guard is outside the canonical model')
          const bytes = await owner.reader.read(ref.layer.id, ref.item.path, MAX_READ_BYTES)
          const text = await checkContent(ref, bytes)
          if (text !== document.text)
            throw new Error('Data workspace catalog content guard changed')
          guardedTextBytes += encoder.encode(text).byteLength
          savedText.set(`${ref.layer.id}\0${ref.item.path.toLowerCase()}`, text)
          if (guardedTextBytes > options.maxTextBytes) throw new RangeError('Data workspace guards exceed maxTextBytes')
          current(revision, signal)
        }
        for (const ref of controlled) {
          current(revision, signal)
          const bytes = await owner.reader.read(ref.layer.id, ref.item.path, MAX_READ_BYTES)
          const text = await checkContent(ref, bytes)
          savedText.set(`${ref.layer.id}\0${ref.item.path.toLowerCase()}`, text)
          guardedTextBytes += encoder.encode(text).byteLength
          if (guardedTextBytes > options.maxTextBytes) throw new RangeError('Data workspace guards exceed maxTextBytes')
          current(revision, signal)
        }
        const loaded = []
        let textBytes = question.catalogGuards === undefined
          ? session.documents.reduce((sum, document) => sum + encoder.encode(document.text).byteLength, 0) : guardedTextBytes
        for (const [index, ref] of named.entries()) {
          current(revision, signal)
          const bytes = await owner.reader.read(ref.layer.id, ref.item.path, Math.min(MAX_READ_BYTES, options.maxTextBytes))
          const text = await checkContent(ref, bytes)
          textBytes += encoder.encode(text).byteLength
          if (textBytes > options.maxTextBytes) throw new RangeError('Data workspace resources exceed maxTextBytes')
          loaded.push({ ...placeholders[index]!, text })
        }
        current(revision, signal)
        let projectedSession = session
        if (changes.size > 0) {
          // The existing loader's catalog order over prospective inputs, never a live overlay or
          // a new parser. Every needed saved catalog/control text was fingerprint-guarded above.
          const previewReader: ChainReader = {
            async files(layerId) {
              const files = [...await owner.reader.files(layerId)]
              const names = new Set(files.map(path => path.toLowerCase()))
              for (const [key, change] of changes) if (key.startsWith(`${layerId}\0`) && !names.has(change.path.toLowerCase())) {
                files.push(change.path); names.add(change.path.toLowerCase())
              }
              return files
            },
            async read(layerId, path, maxBytes) {
              current(revision, signal)
              const key = `${layerId}\0${path.toLowerCase()}`
              const text = changes.get(key)?.text ?? savedText.get(key)
              if (text === undefined) throw new Error('Data preview needs a pinned saved catalog/control input')
              const bytes = encoder.encode(text)
              if (bytes.byteLength > maxBytes) throw new RangeError('Data preview document exceeds its read budget')
              return bytes
            },
          }
          const documents = await chainCatalogDocuments(owner.layers, previewReader, signal)
          current(revision, signal)
          projectedSession = session.fork()
          projectedSession.update(documents)
        }
        const snapshot = await projectedSession.projectSnapshot({ ...base,
          plannedDocumentCount: projectedSession.documents.length + named.length,
          localizationDocuments: loaded.flatMap((document, index) => named[index]!.item.kind === 'localization'
            ? [{ ...document, locale: named[index]!.item.locale as string }] : []),
          usageDocuments: loaded.filter((_, index) => named[index]!.item.kind === 'usage') })
        current(revision, signal)
        const metadata = { ...snapshot }
        for (const facet of facets) delete (metadata as unknown as Record<string, unknown>)[facet]
        const answer = bounded({ revision, leaseId: id, metadata,
          counts: Object.fromEntries(facets.map(facet => [facet, snapshot[facet]?.length ?? 0])),
          documents: projectedSession.documents.map(({ rootId, path, revision }, documentIndex) => ({ rootId, path, documentIndex,
            ...(revision === undefined ? {} : { revision }) })) }, maxPageBytes as number)
        lease = { id, revision, snapshot, maxPageBytes: maxPageBytes as number }
        return answer
      } finally { pending = false }
    },
    /** Explicit context disposal releases this recoverable projection without unloading its chain. */
    dispose() { disposed = true; lease = undefined },
    /** Local changes discard the recoverable projection; canonical session lifetime is unchanged. */
    invalidate() { lease = undefined },
  }
}
