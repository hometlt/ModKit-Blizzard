/**
 * The Data session of one loaded SC2 mod chain, held by the chain's server — the loader's
 * ModContext (owner decision 07.10: one holder of a mod's data for languages, Resources, wiki,
 * cards and Runtime).
 *
 * It holds the chain's catalog documents in load order (the list its holder gives, overlays
 * included), each document's typed parse while its text and position stay the same, the merged
 * structure defaults, schema extensions and EditorCategories, and catalog-engine over them. An
 * entity resolves, types and gains provenance only when a question names it; the values and
 * provenance are the full authoring index's (`catalog-analysis` and `buildStarcraft2AuthoringIndex`
 * own both), so a feature reads the same entity here as in a full analysis.
 *
 * Questions:
 * - `authoring(refs, { chains })` — authoring index rows of those entities, and of their
 *   ancestors when asked, in the schema version 2 shape (`ResolvedDataAuthoringIndex`);
 * - `ids(namespace)` — every id of a Data space in index order (named and synthetic);
 * - `summaries(namespace)` — each id of a Data space with its class and declaration, in index order;
 * - `defaults(namespace)` — the ids of a Data space declared as class templates (`default="1"`);
 * - `search(needle, limit)` — named entities whose id fuzzily matches, in index order;
 * - `exists(refs)` — declared or not, and whether the first declaration is a class template;
 * - `heirs(refs)` — how many entities name each as their parent;
 * - `metadata()` — the owner metadata (EditorCategories) of the chain;
 * - `catalog()` — the chain's catalog-engine view (entities, resolved values, structure defaults)
 *   and the documents that did not parse, for the mod's Resources: one catalog per chain;
 * - `definitions(refs)` — resolved entities as the full workspace snapshot defines them (values,
 *   parent, chain, declaration sites, field sources and lexemes), for `data.entities` questions.
 * - `projectSnapshot(request)` — the existing full workspace projection over this canonical state,
 *   preserving localization/usage/diagnostics and all existing validation. One alternate bounds
 *   state is recoverably cached and shared by unchanged forks; smaller parse depth never reuses a
 *   parse validated at a larger depth. Updates drop derived state, retaining reusable typed parses.
 * `update(documents)` replaces the document list (an edit, a file changed on disk, a new file); the
 * next question parses only documents whose text or position changed and rebuilds the engine.
 * `fork()` creates a session view over the saved model. It shares the current parsed documents and
 * resolved state; an update replaces only the view's document list, parse map and derived state.
 * No view mutates another's inputs, and unchanged documents still use the canonical parser once.
 *
 * Completeness: false when a document fails to parse or repeats an id, an entity names a parent no
 * document declares, or the holder marks the chain incomplete (a dependency it could not open).
 * Bounds: depth and entity limits as the language context's; answers are bounded by
 * `maxOutputBytes`, past which rows keep identities and drop values, as the full index does.
 */
import type { JsonValue } from '@modkit/sdk'
import { OperationCancelledError } from '@modkit/core'
import {
  resolveDataCatalog,
  type DataCatalogDiagnostic,
  type DataEntitySource,
  type DataResolvedEntity,
  type DataTypeSchema,
  type ResolvedDataAuthoringIndex,
  type ResolvedDataWorkspaceAnalysisRequest,
  type ResolvedDataWorkspaceSnapshot,
} from '@modkit/sdk/data'
import type { DataCatalogDocument } from '@modkit/sdk/data'
import { projectStarcraft2ResolvedDataFromPreparedCatalog } from './provider.js'
import { buildStarcraft2AuthoringIndex, type AuthoringIndexEntityInput } from './authoring-index.js'
import type { EngineCatalogEntries } from './engine-resolution.js'
import { sameCatalogDocuments } from './document-inputs.js'
import { fuzzyMatches } from '../../../../shared/language/symbol-match.js'
import {
  editorCategoriesMetadata,
  effectiveSchemas,
  isEditorCategoriesDocument,
  loadedCatalogDocuments,
  parseCatalogDocument,
  parseCatalogDocuments,
  resolveThroughEngine,
  type CatalogDocument,
  type CatalogResolution,
  type ParsedCatalog,
  type ParsedCatalogDocument,
} from './catalog-analysis.js'

const GAME_ID = 'blizzard/starcraft-2'
const ANALYZER_ID = 'blizzard.starcraft2.data'
const DEFAULT_MAX_DEPTH = 64
const DEFAULT_MAX_ENTITIES = 100_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024
/** Yield between documents; an individual document and final model assembly remain atomic. */
const PREPARATION_BATCH_DOCUMENTS = 16
const PREPARATION_SLICE_MS = 8
/** The diagnostic a document that does not parse leaves (`catalog-analysis`). */
const INVALID_DOCUMENT = 'blizzard.starcraft2/data-document-invalid'

/** An entity by its Data space and id. */
export interface DataEntityKey {
  readonly namespace: string
  readonly entityId: string
}

/** An entity's class and the declaration that first names it, as its index row has them. */
export interface DataEntitySummary extends DataEntityKey {
  readonly typeId: string
  readonly source: DataEntitySource
}

export interface Starcraft2DataSessionOptions {
  readonly workspaceId: string
  readonly maxDepth?: number
  readonly maxEntities?: number
  /** True when the holder could not provide every document of the chain. */
  readonly incomplete?: boolean
  readonly signal?: AbortSignal
  /**
   * Typed parses a holder kept (`parsedDocuments` of an earlier session over the same documents,
   * restored from its cache). Each is used only where the document's text, position and revision
   * are the same and it was parsed at no greater depth, exactly as a parse kept across updates.
   */
  readonly parses?: ReadonlyMap<string, Starcraft2ParsedDocument>
}

/** One document's typed parse with what it was parsed from, by `rootId\u0000path`. */
export interface Starcraft2ParsedDocument {
  readonly text: string
  readonly documentIndex: number
  readonly revision?: string
  readonly maxDepth: number
  readonly parsed: ParsedCatalogDocument
}

export interface Starcraft2DataSession {
  /** Complete snapshot projection; native documents remain session-owned, with no second resolver. */
  projectSnapshot(request: Omit<ResolvedDataWorkspaceAnalysisRequest, 'documents'>): Promise<ResolvedDataWorkspaceSnapshot>
  /** An independent view sharing immutable parses and the current model until its first update. */
  fork(): Starcraft2DataSession
  /** Changes with every document update. */
  readonly revision: number
  readonly documents: readonly CatalogDocument[]
  update(documents: readonly CatalogDocument[], options?: { readonly incomplete?: boolean }): void
  /** Warm canonical parses cooperatively, then publish the full model; queries can finish it sooner. */
  prepare(signal?: AbortSignal): Promise<void>
  complete(): boolean
  authoring(
    refs: readonly DataEntityKey[],
    options?: { readonly chains?: boolean; readonly maxOutputBytes?: number },
  ): ResolvedDataAuthoringIndex
  ids(namespace: string): readonly string[]
  /** Every entity of a Data space (named and synthetic) with its class and declaration, in index order. */
  summaries(namespace: string): readonly DataEntitySummary[]
  /** The ids of a Data space whose declaration is a class template, in index order. */
  defaults(namespace: string): readonly string[]
  /** Named entities whose id fuzzily matches `needle`, Data spaces then ids in index order. */
  search(needle: string, limit: number): readonly DataEntitySummary[]
  exists(refs: readonly DataEntityKey[]): readonly { readonly known: boolean; readonly defaultTemplate?: true }[]
  heirs(refs: readonly DataEntityKey[]): readonly number[]
  metadata(): JsonValue | undefined
  /** The chain's catalog, read only, and each document that did not parse with why. */
  catalog(): {
    readonly entries: EngineCatalogEntries
    readonly invalid: readonly { readonly rootId: string; readonly path: string; readonly message: string }[]
  }
  /** Resolved definitions of these entities, as the full snapshot gives them; unknown ones are left out. */
  definitions(refs: readonly DataEntityKey[]): readonly DataResolvedEntity[]
  /** Entities the catalog declares (first declarations), named and synthetic. */
  entityCount(): number
  /** The typed parses the session holds, by `rootId\u0000path`, for a holder to keep. */
  parsedDocuments(): ReadonlyMap<string, Starcraft2ParsedDocument>
}

interface SessionState {
  readonly parsed: ParsedCatalog
  readonly diagnostics: readonly DataCatalogDiagnostic[]
  readonly parsedDiagnosticCount: number
  readonly resolution: CatalogResolution
  readonly schemas: readonly DataTypeSchema[]
  readonly ids: Map<string, readonly string[]>
  readonly heirs: Map<string, ReadonlyMap<string, number>>
  complete?: boolean
}

/** Private owner input to the existing projector, never a wire payload or a new model registry. */
export interface Starcraft2CatalogProjectionState {
  readonly documents: readonly CatalogDocument[]
  readonly incomplete: boolean
  readonly maxDepth: number
  readonly maxEntities: number
  readonly parsed: ParsedCatalog
  readonly resolution: CatalogResolution
  readonly diagnostics: readonly DataCatalogDiagnostic[]
  readonly parsedDiagnosticCount: number
}

type ParsedDocumentCacheEntry = Starcraft2ParsedDocument

/** One alternate semantic-bounds state; unchanged views share it until their inputs change. */
interface ProjectionBoundsCache {
  entry?: {
    readonly maxDepth: number
    readonly maxEntities: number
    readonly state: SessionState
    readonly parses: ReadonlyMap<string, ParsedDocumentCacheEntry>
  }
  parses?: ReadonlyMap<string, ParsedDocumentCacheEntry>
}

const keyOf = (namespace: string, entityId: string) => `${namespace}\u0000${entityId}`

/** Open the Data session of a chain over its catalog documents in load order. */
export function openStarcraft2DataSession(
  documents: readonly CatalogDocument[],
  options: Starcraft2DataSessionOptions,
): Starcraft2DataSession {
  return createDataSession(documents, options)
}

/** A canonical session or a copy-on-write view of its parsed documents and resolved state. */
function createDataSession(
  documents: readonly CatalogDocument[],
  options: Starcraft2DataSessionOptions,
  seed?: {
    readonly state: SessionState | undefined
    readonly parses: ReadonlyMap<string, ParsedDocumentCacheEntry>
    readonly projectionBounds?: ProjectionBoundsCache
  },
): Starcraft2DataSession {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES
  let current = Object.freeze(documents.map(document => Object.freeze({ ...document })))
  let incomplete = options.incomplete === true
  let revision = 0
  let state: SessionState | undefined = seed?.state
  /** Each document's parse by identity, kept while its text and position are unchanged. */
  let parses: ReadonlyMap<string, ParsedDocumentCacheEntry> = seed?.parses ?? options.parses ?? new Map()
  /** One copy-on-write parse cache shared by preparers of these exact document inputs. */
  let preparation: {
    readonly documents: readonly CatalogDocument[]
    readonly parses: Map<string, ParsedDocumentCacheEntry>
  } | undefined
  let projectionBounds: ProjectionBoundsCache = seed?.projectionBounds ?? {}

  /** Reuse a typed parse only when its text, source position, revision and depth proof still match. */
  const parseEntry = (
    document: CatalogDocument,
    documentIndex: number,
    depth: number,
    known: ParsedDocumentCacheEntry | undefined,
    signal?: AbortSignal,
  ): ParsedDocumentCacheEntry => {
    const reuse = known !== undefined && known.text === document.text &&
      known.documentIndex === documentIndex && known.revision === document.revision &&
      known.maxDepth <= depth
    return reuse ? known : {
      text: document.text,
      documentIndex,
      maxDepth: depth,
      ...(document.revision === undefined ? {} : { revision: document.revision }),
      parsed: parseCatalogDocument(document, documentIndex, signal, depth),
    }
  }

  /** Parse with explicit bounds, sharing only entries that were validated at a safe depth. */
  const prepareState = (
    depth: number,
    entities: number,
    knownParses: ReadonlyMap<string, ParsedDocumentCacheEntry>,
    signal?: AbortSignal,
  ) => {
    const diagnostics: DataCatalogDiagnostic[] = []
    const kept = new Map<string, ParsedDocumentCacheEntry>()
    const parsed = parseCatalogDocuments(current, {
      includeWorkspaceFacets: true,
      maxDepth: depth,
      maxEntities: entities,
      ...(signal === undefined ? {} : { signal }),
      diagnostics,
      parse(document, documentIndex) {
        const identity = keyOf(document.rootId, document.path)
        const entry = parseEntry(document, documentIndex, depth, knownParses.get(identity), signal)
        kept.set(identity, entry)
        return entry.parsed
      },
    })
    const parsedDiagnosticCount = diagnostics.length
    const resolution = resolveThroughEngine(parsed.patches, parsed.engineDocuments, { documents: current, maxDepth: depth }, diagnostics)
    const prepared: SessionState = {
      parsed,
      diagnostics,
      parsedDiagnosticCount,
      resolution,
      schemas: effectiveSchemas(parsed.schemaExtensions),
      ids: new Map(),
      heirs: new Map(),
    }
    return { state: prepared, parses: kept }
  }

  /** Canonical language/model bounds, preserving the existing lazy state lifetime. */
  const build = (signal = options.signal): SessionState => {
    if (state !== undefined) return state
    const prepared = prepareState(maxDepth, maxEntities, parses, signal)
    parses = prepared.parses
    state = prepared.state
    preparation = undefined
    return state
  }

  /** Whether an entity anywhere names a parent no document declares (the full analysis's error). */
  const missingParent = (built: SessionState): boolean => {
    const engine = built.resolution.engine
    for (const namespace of engine.namespaces()) {
      const declared = engine.declarations(namespace)
      const ids = new Set(declared.map(entity => entity.entityId))
      if (declared.some(entity => entity.parent !== undefined && !ids.has(entity.parent))) return true
    }
    return false
  }

  const complete = (): boolean => {
    const built = build()
    if (built.complete === undefined) {
      built.complete = !incomplete &&
        built.diagnostics.every(diagnostic => diagnostic.severity !== 'error') &&
        !missingParent(built)
    }
    return built.complete
  }

  const idsOf = (built: SessionState, namespace: string): readonly string[] => {
    let ids = built.ids.get(namespace)
    if (ids === undefined) {
      ids = Object.freeze(
        [...built.resolution.firstPatches().values()]
          .filter(patch => patch.namespace === namespace)
          .map(patch => patch.entityId)
          .sort((left, right) => left.localeCompare(right)),
      )
      built.ids.set(namespace, ids)
    }
    return ids
  }

  /** The class and declaration an entity's index row names. */
  const summaryOf = (built: SessionState, namespace: string, entityId: string): DataEntitySummary => {
    const summary = built.resolution.summary(namespace, entityId)!
    return Object.freeze({ namespace, entityId, typeId: summary.typeId, source: summary.source })
  }

  const heirsOf = (built: SessionState, namespace: string): ReadonlyMap<string, number> => {
    let counts = built.heirs.get(namespace)
    if (counts === undefined) {
      const declared = built.resolution.engine.declarations(namespace)
      const ids = new Set(declared.map(entity => entity.entityId))
      const next = new Map<string, number>()
      for (const entity of declared) {
        if (entity.parent === undefined || !ids.has(entity.parent)) continue
        next.set(entity.parent, (next.get(entity.parent) ?? 0) + 1)
      }
      counts = next
      built.heirs.set(namespace, counts)
    }
    return counts
  }

  return {
    projectSnapshot(request) {
      return projectStarcraft2ResolvedDataFromPreparedCatalog({
        ...request,
        documents: current as readonly DataCatalogDocument[],
      }, validated => {
        let projected: SessionState
        if (validated.maxDepth === maxDepth && validated.maxEntities === maxEntities) {
          projected = build(validated.signal)
        } else {
          const known = projectionBounds.entry
          if (known?.maxDepth === validated.maxDepth && known.maxEntities === validated.maxEntities) {
            projected = known.state
          } else {
            const next = prepareState(validated.maxDepth, validated.maxEntities,
              known?.parses ?? projectionBounds.parses ?? parses, validated.signal)
            projectionBounds.entry = { maxDepth: validated.maxDepth, maxEntities: validated.maxEntities, ...next }
            projected = next.state
          }
        }
        return { documents: current, incomplete, maxDepth: validated.maxDepth, maxEntities: validated.maxEntities,
          parsed: projected.parsed, resolution: projected.resolution, diagnostics: projected.diagnostics,
          parsedDiagnosticCount: projected.parsedDiagnosticCount }
      })
    },
    fork() {
      return createDataSession(current, { ...options, incomplete }, { state: build(), parses, projectionBounds })
    },
    get revision() {
      return revision
    },
    get documents() {
      return current
    },
    update(documents, updateOptions) {
      const nextIncomplete = updateOptions?.incomplete ?? incomplete
      revision += 1
      // A saved refresh still advances its revision, but unrelated edits need no new model.
      if (nextIncomplete === incomplete && sameCatalogDocuments(documents, current)) return
      current = Object.freeze(documents.map(document => Object.freeze({ ...document })))
      incomplete = nextIncomplete
      state = undefined
      preparation = undefined
      const previousParses = projectionBounds.entry?.parses ?? projectionBounds.parses
      projectionBounds = previousParses === undefined ? {} : { parses: previousParses }
    },
    complete,
    /** Warm the canonical parse cache in bounded turns, then use the ordinary complete builder. */
    async prepare(signal = options.signal) {
      if (state !== undefined) return
      if (preparation === undefined || preparation.documents !== current) {
        preparation = { documents: current, parses: new Map(parses) }
      }
      const held = preparation
      parses = held.parses
      let entities = 0
      let batch = 0
      let yieldAt = performance.now() + PREPARATION_SLICE_MS
      for (const { document, documentIndex } of loadedCatalogDocuments(held.documents)) {
        if (state !== undefined) return
        signal?.throwIfAborted()
        if (current !== held.documents) throw new OperationCancelledError('Data inputs changed during preparation')
        if (isEditorCategoriesDocument(document)) continue
        const identity = keyOf(document.rootId, document.path)
        try {
          const entry = parseEntry(document, documentIndex, maxDepth, held.parses.get(identity), signal)
          held.parses.set(identity, entry)
          entities += entry.parsed.patches.length
        } catch {
          signal?.throwIfAborted()
          // The canonical aggregate reports invalid documents with their original provenance.
        }
        if (entities > maxEntities) break
        if (++batch >= PREPARATION_BATCH_DOCUMENTS || performance.now() >= yieldAt) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          batch = 0
          yieldAt = performance.now() + PREPARATION_SLICE_MS
        }
      }
      if (state !== undefined) return
      signal?.throwIfAborted()
      if (current !== held.documents) throw new OperationCancelledError('Data inputs changed during preparation')
      build(signal)
    },
    authoring(refs, authoringOptions) {
      const built = build()
      const wanted = new Map<string, DataEntityKey>()
      for (const ref of refs) {
        if (!built.resolution.has(ref.namespace, ref.entityId)) continue
        if (authoringOptions?.chains === true) {
          for (const link of built.resolution.chain(ref.namespace, ref.entityId) ?? []) {
            if (link.entityId !== '' && built.resolution.has(link.namespace, link.entityId)) {
              wanted.set(keyOf(link.namespace, link.entityId), link)
            }
          }
        }
        wanted.set(keyOf(ref.namespace, ref.entityId), ref)
      }
      const entities: AuthoringIndexEntityInput[] = []
      for (const ref of wanted.values()) {
        const entity = built.resolution.authoringEntity(ref.namespace, ref.entityId, built.parsed.structureDefaults)
        if (entity !== undefined) entities.push(entity)
      }
      const ownerMetadata = editorCategoriesMetadata(built.parsed.editorCategories)
      return buildStarcraft2AuthoringIndex({
        workspaceId: options.workspaceId,
        gameId: GAME_ID,
        analyzerId: ANALYZER_ID,
        snapshotId: `${options.workspaceId}@${revision}`,
        schemas: built.schemas,
        entities,
        patchCount: built.parsed.patches.length,
        diagnostics: [],
        ...(ownerMetadata === undefined ? {} : { ownerMetadata }),
        complete: complete(),
        maxOutputBytes: authoringOptions?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      })
    },
    ids: namespace => idsOf(build(), namespace),
    summaries(namespace) {
      const built = build()
      return idsOf(built, namespace).map(entityId => summaryOf(built, namespace, entityId))
    },
    defaults(namespace) {
      const built = build()
      return idsOf(built, namespace).filter(entityId => built.resolution.patch(namespace, entityId)?.defaultTemplate === true)
    },
    search(needle, limit) {
      const built = build()
      const namespaces = [...new Set([...built.resolution.firstPatches().values()].map(patch => patch.namespace))]
        .sort((left, right) => left.localeCompare(right))
      const found: DataEntitySummary[] = []
      for (const namespace of namespaces) {
        for (const entityId of idsOf(built, namespace)) {
          if (built.resolution.patch(namespace, entityId)?.synthetic === true || !fuzzyMatches(entityId, needle)) continue
          found.push(summaryOf(built, namespace, entityId))
          if (found.length >= limit) return Object.freeze(found)
        }
      }
      return Object.freeze(found)
    },
    exists(refs) {
      const built = build()
      return refs.map(ref => {
        const patch = built.resolution.patch(ref.namespace, ref.entityId)
        return patch === undefined
          ? Object.freeze({ known: false })
          : Object.freeze({ known: true, ...(patch.defaultTemplate === true ? { defaultTemplate: true as const } : {}) })
      })
    },
    heirs(refs) {
      const built = build()
      return refs.map(ref => heirsOf(built, ref.namespace).get(ref.entityId) ?? 0)
    },
    metadata: () => editorCategoriesMetadata(build().parsed.editorCategories),
    catalog() {
      const built = build()
      const invalid = built.diagnostics.flatMap(diagnostic => {
        const source = diagnostic.source
        if (diagnostic.code !== INVALID_DOCUMENT || source === undefined) return []
        const prefix = `${source.path}: `
        const message = diagnostic.message.startsWith(prefix) ? diagnostic.message.slice(prefix.length) : diagnostic.message
        return [Object.freeze({ rootId: source.rootId, path: source.path, message })]
      })
      return Object.freeze({ entries: built.resolution.engine.entries, invalid: Object.freeze(invalid) })
    },
    definitions(refs) {
      const built = build()
      const known = refs.filter(ref => built.resolution.has(ref.namespace, ref.entityId))
      if (known.length === 0) return Object.freeze([])
      // The common builder over the entities' flat declarations, as the full snapshot does.
      const snapshot = resolveDataCatalog({
        workspaceId: options.workspaceId,
        gameId: GAME_ID,
        analyzerId: ANALYZER_ID,
        schemas: built.schemas,
        patches: known.map(ref => built.resolution.flat(ref.namespace, ref.entityId)!),
        patchesResolved: true,
        queries: known.map(ref => ({ namespace: ref.namespace, entityId: ref.entityId })),
        includeFieldSources: true,
        maxEntities,
        maxDepth,
      })
      return Object.freeze(snapshot.entities.map(entity => built.resolution.enrich(entity, true)))
    },
    entityCount: () => build().resolution.firstPatches().size,
    parsedDocuments() {
      build()
      return parses
    },
  }
}
