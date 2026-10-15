/**
 * A loaded chain's Data on its mod's server — the loader's ModContext (owner decision 07.10: one
 * holder of a mod's data for languages, Resources, wiki, cards and Runtime).
 *
 * The chain's catalog documents are each layer's standard catalogs in the game's order, then the
 * catalogs its `Base.SC2Data/GameData.xml` includes (declared order, files the layer holds), then
 * the chain's EditorCategories documents, appended so they never move a catalog's position. They are
 * read through the server's reader, so unsaved editor text over a file is what the Data reads. The
 * Data session (`data-session.ts`) parses them once and resolves each entity only when a question
 * names it. Proven unrelated overlays leave Data intact; changed catalog inputs or a change on
 * disk mark documents stale. The next question
 * reads the listing again and updates the session, which re-parses only the documents that changed.
 * A saved chain supplies `base` to its session views. The first question forks the saved Data
 * model and applies that view's documents only when they differ; updates stay in that view.
 * Equal editor buffers reuse saved inputs on initial load and refresh, without rereading the
 * chain. Equality may be asynchronous; cancellation is checked again before publishing a view.
 * Catalog inputs are bounded separately from a single read: 4096 documents and 256MiB of raw
 * catalog/EditorCategories bytes per chain load, with the existing 64MiB per-file ceiling. A
 * refused refresh leaves the previous session inputs intact and remains retryable; callers do
 * not receive a silently truncated catalog. These input ceilings do not measure heap/RSS.
 *
 * Kept parses (owner decision 10.10): with a `cache` the saved chain takes the documents and typed
 * parses of its leading stock layers (Core up to the last mod the user keeps, every one of them with a
 * content fingerprint - the installation's build for CASC) from the cache instead of reading and
 * parsing them, and reads only the layers after them. A miss reads everything and, once the session
 * has parsed, keeps that prefix. The kept documents sit at the same positions they would be read at,
 * so the session uses their parses exactly as a parse kept across updates; answers are unchanged.
 */
import type { Starcraft2DataSession, Starcraft2ParsedDocument } from '../../../data/services/catalog/data-session.js'
import type { CatalogDocument } from '../../../data/services/catalog/catalog-analysis.js'
import { sameCatalogDocuments } from '../../../data/services/catalog/document-inputs.js'
import { gameDataIncludePaths } from '../../../data/shared/catalog-engine/gamedata-order.js'

/** A layer of the chain: its id in the context, its path in its source, and the root its sources name. */
export interface ChainLayer {
  readonly id: string
  readonly sourcePath: string
  /** The layer's address, which an entity's sources name it by, so a reader can open the file. */
  readonly rootId: string
  /** Content identity of the layer when its source knows one (CASC: the installation's build). */
  readonly fingerprint?: string
}

/** The kept catalog documents and typed parses of a chain's leading layers. */
export interface ChainPrefixRecord {
  readonly catalogs: readonly CatalogDocument[]
  readonly editorCategories: readonly CatalogDocument[]
  /** Raw bytes the documents were read as, for the chain's catalog byte bound. */
  readonly bytes: number
  readonly parses: readonly (readonly [string, Starcraft2ParsedDocument])[]
  /** Bounded evidence from the canonical collector, including missing Includes targets. */
  readonly inputs?: readonly {
    readonly rootId: string
    readonly sourcePath: string
    readonly includes: readonly string[]
    readonly fallback: boolean
  }[]
}

/** Where a saved chain keeps the parses of its leading layers (`data-cache-node.ts`). */
export interface ChainDataCache {
  /** How many leading layers to keep and their key, or undefined when none qualify. */
  prefixOf(layers: readonly ChainLayer[]): { readonly count: number; readonly key: string } | undefined
  /** Concurrent cold misses may share the canonical producer; implementations can ignore it. */
  load(key: string, create?: () => Promise<ChainPrefixRecord | undefined>): Promise<ChainPrefixRecord | undefined>
  save(key: string, record: ChainPrefixRecord): Promise<void>
}

/** How the chain's files are listed and read: through the server, overlays included. */
export interface ChainReader {
  files(layerId: string): Promise<readonly string[]>
  read(layerId: string, path: string, maxBytes: number): Promise<Uint8Array>
}

const MAXIMUM_DOCUMENT_BYTES = 64 * 1024 * 1024
const MAXIMUM_CATALOG_DOCUMENTS = 4096
const MAXIMUM_CATALOG_BYTES = 256 * 1024 * 1024
const GAME_DATA_INCLUDES = 'base.sc2data/gamedata.xml'
const EDITOR_CATEGORIES = 'base.sc2data/editordata/editorcategories.xml'
const decoder = new TextDecoder()

/** Canonical inputs of one layer; a missing entry means dependencies have not been proven. */
interface LayerCatalogInputs {
  readonly standard: ReadonlyMap<string, number>
  readonly includes: ReadonlySet<string>
  readonly fallback: boolean
}
type CatalogInputs = Map<string, LayerCatalogInputs>

const slash = (value: string) => value.split(String.fromCharCode(92)).join('/')

/** Standard input paths come from the one Data schema owner, both for reads and cached evidence. */
async function standardCatalogInputs(): Promise<ReadonlyMap<string, number>> {
  const { STARCRAFT2_CATALOG_FILES } = await import('../../../data/services/schema/full-data-schema.js')
  return new Map<string, number>((STARCRAFT2_CATALOG_FILES as readonly string[]).map(
    (file, order) => [`base.sc2data/gamedata/${file.toLowerCase()}`, order] as const,
  ))
}

/**
 * Catalogs a package names in its `GameData.xml` (`<Includes><Catalog path=…/>`), beyond the
 * standard catalog files, in declared order. The game loads a map's or mod's own catalog files only
 * through this list, so a custom `GameData/*.xml` exists for it exactly when the package includes
 * it; a named file the layer does not hold is skipped. A package without `GameData.xml` has every
 * other `GameData` catalog it holds loaded, by path — as the Data plan and analysis do
 * (`planStarcraft2DataWorkspace`, `loadedCatalogDocuments`).
 */
async function includedCatalogs(
  layerId: string,
  byPath: ReadonlyMap<string, string>,
  standard: ReadonlyMap<string, number>,
  reader: ChainReader,
  dependencies?: Set<string>,
): Promise<string[]> {
  const declaration = byPath.get(GAME_DATA_INCLUDES)
  if (declaration === undefined) {
    return [...byPath]
      .filter(([key]) => key.startsWith('base.sc2data/gamedata/') && key.endsWith('.xml') && !standard.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, file]) => file)
  }
  const text = decoder.decode(await reader.read(layerId, declaration, MAXIMUM_DOCUMENT_BYTES))
  const included: string[] = []
  const seen = new Set<string>()
  for (const path of gameDataIncludePaths(text)) {
    const key = `base.sc2data/${path}`.toLowerCase()
    // Missing targets still affect the next model if an overlay creates them. Excess metadata
    // makes the layer unknown rather than truncating inputs or guessing from file extensions.
    if (dependencies !== undefined && dependencies.size <= MAXIMUM_CATALOG_DOCUMENTS) dependencies.add(key)
    const file = byPath.get(key)
    if (file === undefined || standard.has(key) || seen.has(key)) continue
    seen.add(key)
    included.push(file)
  }
  return included
}

/** The chain's catalog documents in load order, then its EditorCategories documents. */
export async function chainCatalogDocuments(
  layers: readonly ChainLayer[],
  reader: ChainReader,
  signal?: AbortSignal,
  dependencies?: CatalogInputs,
): Promise<CatalogDocument[]> {
  const read = await collectCatalogDocuments(layers, reader, { documents: 0, bytes: 0 }, signal, dependencies)
  return [...read.catalogs, ...read.editorCategories]
}

/**
 * The catalog and EditorCategories documents of these layers, accounted after `before` documents
 * and bytes the chain already holds (its kept prefix).
 */
async function collectCatalogDocuments(
  layers: readonly ChainLayer[],
  reader: ChainReader,
  before: { readonly documents: number; readonly bytes: number },
  signal?: AbortSignal,
  dependencies?: CatalogInputs,
): Promise<{ catalogs: CatalogDocument[]; editorCategories: CatalogDocument[]; bytes: number }> {
  // The schema owner is needed when Data is first read, not when a source or context is opened.
  const wanted = await standardCatalogInputs()
  const documents: CatalogDocument[] = []
  const editorCategories: CatalogDocument[] = []
  let catalogBytes = before.bytes
  /** Account every model input before retaining decoded text; metadata discovery is separate. */
  const appendDocument = async (destination: CatalogDocument[], layer: ChainLayer, file: string): Promise<void> => {
    signal?.throwIfAborted()
    if (before.documents + documents.length + editorCategories.length >= MAXIMUM_CATALOG_DOCUMENTS) {
      throw new RangeError(`SC2 Data chain exceeds ${MAXIMUM_CATALOG_DOCUMENTS} catalog documents`)
    }
    const bytes = await reader.read(layer.id, file, MAXIMUM_DOCUMENT_BYTES)
    if (bytes.byteLength > MAXIMUM_DOCUMENT_BYTES || catalogBytes + bytes.byteLength > MAXIMUM_CATALOG_BYTES) {
      throw new RangeError(`SC2 Data chain exceeds ${MAXIMUM_CATALOG_BYTES} catalog bytes or ${MAXIMUM_DOCUMENT_BYTES} bytes per document`)
    }
    catalogBytes += bytes.byteLength
    destination.push({ rootId: layer.rootId, path: `${layer.sourcePath}/${file}`, text: decoder.decode(bytes) })
  }
  for (const layer of layers) {
    signal?.throwIfAborted()
    const files = await reader.files(layer.id)
    // Each path's lookup key once: a stock layer lists about 180 000 files.
    const keyed = files.map(file => [slash(file).toLowerCase(), file] as const)
    const catalogs = keyed
      .filter(([key]) => wanted.has(key))
      .sort(([left], [right]) => wanted.get(left)! - wanted.get(right)!)
      .map(([, file]) => file)
    const byPath = new Map(keyed)
    const includes = new Set([GAME_DATA_INCLUDES, EDITOR_CATEGORIES])
    const included = await includedCatalogs(layer.id, byPath, wanted, reader, includes)
    for (const file of [...catalogs, ...included]) {
      await appendDocument(documents, layer, file)
    }
    const categories = keyed.find(([key]) => key === EDITOR_CATEGORIES)?.[1]
    if (categories !== undefined) {
      await appendDocument(editorCategories, layer, categories)
    }
    if (includes.size <= MAXIMUM_CATALOG_DOCUMENTS) dependencies?.set(layer.id, {
      standard: wanted, includes, fallback: !byPath.has(GAME_DATA_INCLUDES),
    })
  }
  return { catalogs: documents, editorCategories, bytes: catalogBytes - before.bytes }
}

/**
 * Open the canonical saved session, sharing prefix parses produced by another cold chain when
 * possible. The producer builds its own full session once; waiters build independent tail models.
 */
async function savedChainSession(
  layers: readonly ChainLayer[],
  reader: ChainReader,
  cache: ChainDataCache | undefined,
  options: { readonly workspaceId: string; readonly incomplete: boolean },
  signal?: AbortSignal,
  dependencies?: CatalogInputs,
): Promise<Starcraft2DataSession> {
  const { openStarcraft2DataSession } = await import('../../../data/services/catalog/data-session.js')
  /** Construct through the Data owner, retaining its parse-position and budget validation. */
  const open = (documents: CatalogDocument[], parses?: ReadonlyMap<string, Starcraft2ParsedDocument>) => {
    signal?.throwIfAborted()
    return openStarcraft2DataSession(documents, { ...options, ...(parses === undefined ? {} : { parses }) })
  }
  const prefix = cache?.prefixOf(layers)
  if (cache === undefined || prefix === undefined) return open(await chainCatalogDocuments(layers, reader, signal, dependencies))
  let created: Starcraft2DataSession | undefined
  let attempted = false
  /** Publish only prefix parses from this producer's existing full canonical session. */
  const create = async (): Promise<ChainPrefixRecord | undefined> => {
    attempted = true
    const head = await collectCatalogDocuments(layers.slice(0, prefix.count), reader, { documents: 0, bytes: 0 }, signal, dependencies)
    const rest = await collectCatalogDocuments(layers.slice(prefix.count), reader, {
      documents: head.catalogs.length + head.editorCategories.length, bytes: head.bytes,
    }, signal, dependencies)
    created = open([...head.catalogs, ...rest.catalogs, ...head.editorCategories, ...rest.editorCategories])
    await created.prepare(signal)
    const separator = String.fromCharCode(0)
    const identities = new Set(head.catalogs.map(document => `${document.rootId}${separator}${document.path}`))
    const parses = [...created.parsedDocuments()].filter(([identity]) => identities.has(identity))
    if (parses.length !== head.catalogs.length) return undefined
    const inputs = layers.slice(0, prefix.count).flatMap(layer => {
      const input = dependencies?.get(layer.id)
      return input === undefined ? [] : [{ rootId: layer.rootId, sourcePath: layer.sourcePath,
        includes: [...input.includes], fallback: input.fallback }]
    })
    const record = { catalogs: head.catalogs, editorCategories: head.editorCategories, bytes: head.bytes, parses, inputs }
    void cache.save(prefix.key, record).catch(() => {})
    return record
  }
  const kept = await cache.load(prefix.key, create).catch(error => {
    if (attempted) throw error
    return undefined
  })
  signal?.throwIfAborted()
  if (created !== undefined) return created
  if (kept === undefined) { await create(); return created! }
  if (dependencies !== undefined && Array.isArray(kept.inputs) && kept.inputs.length <= prefix.count) {
    const standard = await standardCatalogInputs()
    for (const layer of layers.slice(0, prefix.count)) {
      const rows = kept.inputs.filter(input => input?.rootId === layer.rootId && input.sourcePath === layer.sourcePath)
      if (rows.length !== 1) continue
      const input = rows[0]!
      if (typeof input.fallback !== 'boolean' || !Array.isArray(input.includes) || input.includes.length > MAXIMUM_CATALOG_DOCUMENTS ||
          !input.includes.every((path: unknown) => typeof path === 'string' && path === slash(path).toLowerCase()) ||
          !input.includes.includes(GAME_DATA_INCLUDES) || !input.includes.includes(EDITOR_CATEGORIES)) continue
      dependencies.set(layer.id, { standard, includes: new Set(input.includes), fallback: input.fallback })
    }
  }
  const rest = await collectCatalogDocuments(layers.slice(prefix.count), reader, {
    documents: kept.catalogs.length + kept.editorCategories.length,
    bytes: kept.bytes,
  }, signal, dependencies)
  return open([...kept.catalogs, ...rest.catalogs, ...kept.editorCategories, ...rest.editorCategories], new Map(kept.parses))
}

/** A chain's Data: its session, opened on the first question and refreshed after changes. */
export interface ChainData {
  /** The session over the chain's current documents. */
  session(signal?: AbortSignal): Promise<Starcraft2DataSession>
  /** Refresh affected canonical inputs; an omitted change list invalidates the whole chain. */
  refresh(changes?: readonly { readonly layerId: string; readonly path: string }[]): void
  /** Unknown inputs conservatively affect Data, including cached prefixes without include evidence. */
  dependsOn(layerId: string, path: string): boolean
  /** The reader and layers to read the chain with from now on (a context opened again). */
  rebind(layers: readonly ChainLayer[], reader: ChainReader, incomplete: boolean): void
}

export function createChainData(
  workspaceId: string,
  initial: {
    readonly layers: readonly ChainLayer[]
    readonly reader: ChainReader
    readonly incomplete: boolean
    readonly base?: ChainData
    /** Compare editor inputs with this saved generation; equal text can share its native inputs. */
    readonly hasOverlays?: (saved: readonly CatalogDocument[]) => boolean | Promise<boolean>
    /** Kept parses of the leading layers; only a saved chain (no `base`) uses it. */
    readonly cache?: ChainDataCache
  },
): ChainData {
  let layers = initial.layers
  let reader = initial.reader
  let incomplete = initial.incomplete
  let opened: Promise<Starcraft2DataSession> | undefined
  let stale = false
  /** Refreshes may arrive while the saved generation/equality proof is awaited. */
  let generation = 0
  /** One update at a time: a question during an update waits for it. */
  let pending: Promise<Starcraft2DataSession> | undefined
  let dependencies: CatalogInputs | undefined
  let inheritedInputs: ChainData | undefined
  /** Decide only from the canonical collection, never from a language or file-extension guess. */
  const dependsOn = (layerId: string, path: string): boolean => {
    if (opened === undefined || stale || pending !== undefined) return true
    if (inheritedInputs !== undefined) return inheritedInputs.dependsOn(layerId, path)
    const layer = dependencies?.get(layerId)
    if (layer === undefined) return true
    const key = slash(path).replace(/^\/+/u, '').toLowerCase()
    return layer.standard.has(key) || layer.includes.has(key) ||
      (layer.fallback && key.startsWith('base.sc2data/gamedata/') && key.endsWith('.xml'))
  }
  return {
    session(signal) {
      if (opened === undefined) {
        const savedChain = initial.base
        const nextInputs: CatalogInputs = new Map()
        opened = savedChain === undefined
          ? savedChainSession(layers, reader, initial.cache, { workspaceId, incomplete }, signal, nextInputs).then(session => {
            dependencies = nextInputs
            return session
          })
          : (async () => {
            for (;;) {
              const version = generation
              const base = await savedChain.session(signal)
              // fork() shares a built model: warm it cooperatively even when no prefix cache exists.
              await base.prepare(signal)
              signal?.throwIfAborted()
              // The server knows whether a view changes saved inputs. Clean views reuse those inputs
              // without decoding and listing the entire chain a second time.
              const clean = await initial.hasOverlays?.(base.documents) === false
              signal?.throwIfAborted()
              if (version !== generation) continue
              const viewInputs: CatalogInputs = new Map()
              const documents = clean ? base.documents : await chainCatalogDocuments(layers, reader, signal, viewInputs)
              if (version !== generation) continue
              const view = base.fork()
              if (!sameCatalogDocuments(documents, base.documents)) view.update(documents, { incomplete })
              dependencies = clean ? undefined : viewInputs
              inheritedInputs = clean ? savedChain : undefined
              stale = false
              return view
            }
          })()
        opened.catch(() => {
          opened = undefined
        })
        stale = false
        return opened
      }
      if (!stale) return pending ?? opened
      stale = false
      const base = opened
      const next = (pending ?? base).then(async session => {
        for (;;) {
          const version = generation
          const savedChain = initial.base
          if (savedChain !== undefined) {
            let saved: Starcraft2DataSession | undefined
            try { saved = await savedChain.session(signal) }
            catch {
              // A valid editor repair must remain readable when the native refresh fails.
              // The normal view collection below still enforces the complete input bounds.
              signal?.throwIfAborted()
            }
            signal?.throwIfAborted()
            const clean = saved !== undefined && await initial.hasOverlays?.(saved.documents) === false
            signal?.throwIfAborted()
            if (version !== generation) continue
            if (clean && saved !== undefined) {
              session.update(saved.documents, { incomplete })
              dependencies = undefined
              inheritedInputs = savedChain
              stale = false
              return session
            }
          }
          const nextInputs: CatalogInputs = new Map()
          const documents = await chainCatalogDocuments(layers, reader, signal, nextInputs)
          if (version !== generation) continue
          session.update(documents, { incomplete })
          dependencies = nextInputs
          inheritedInputs = undefined
          stale = false
          return session
        }
      })
      pending = next
      next.then(() => {
        if (pending === next) pending = undefined
      }, () => {
        if (pending === next) pending = undefined
        stale = true
      })
      return next
    },
    dependsOn,
    refresh(changes) {
      if (changes === undefined || changes.some(change => dependsOn(change.layerId, change.path))) {
        stale = true
        generation += 1
      }
    },
    rebind(nextLayers, nextReader, nextIncomplete) {
      layers = nextLayers
      reader = nextReader
      if (nextIncomplete !== incomplete) { stale = true; generation += 1 }
      incomplete = nextIncomplete
    },
  }
}
