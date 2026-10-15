/**
 * Loading an SC2 GameData catalog document.
 *
 * All parsing is delegated: `parseCatalogXml` (`@modkitx/xml`) produces the raw entries and
 * `TypedCatalog` (`@modkitx/data-processing/sc2-catalog`) owns the entity store, inheritance resolution, and token
 * substitution. This module adds only two things neither of them has:
 *
 * 1. a bytes -> `ParsedCatalogFile` bridge;
 * 2. an honest account of what a **single** source cannot resolve.
 *
 * Point 2 is the load-bearing one. `TypedCatalog` is a *chain* store: the production loader
 * (`@modkitx/mods-processing/sc2-mod-core`'s `SC2ModReader`) walks a mod's whole dependency chain and calls
 * `loadFromFiles(files, { mod })` once per mod, in load order, into **one** catalog. Inheritance
 * (`parent=`), cross-file id overrides, and `CConst` token substitution are all resolved against
 * that merged store, and `buildChain` "stops silently on dangling parent references" — a missing
 * ancestor degrades quietly instead of raising. Opening one `AssetSource` therefore yields a
 * structurally correct but semantically *partial* catalog whenever an entity inherits from
 * outside its own file, which in real SC2 data is the common case.
 *
 * Rather than hide that, {@link loadCatalogDocument} measures it ({@link CatalogStats.unresolvedParents},
 * {@link CatalogStats.constEntityCount}) and `describe()` reports it as degraded traits plus
 * diagnostics. A whole chain opens through the multi-file entry point, from the layers the one mod
 * loader resolved.
 */

import { parseCatalogXml, type ParsedCatalogFile } from '../catalog-engine/xml/index.js'
import { TypedCatalog } from '../catalog-engine/sc2-catalog/index.js'
import {
  createBuiltinRegistry,
  type SchemaRegistry,
} from '../catalog-engine/sc2-schema/index.js'
import { inspectCatalogStructure, type CatalogStructure, type Sc2DataSource } from './detect.js'
import { dataBasename } from './identity.js'
import {
  catalogStructureDefaultEntries,
  STARCRAFT2_STRUCTURE_DEFAULT_RULES,
} from './structure-defaults.js'

export {
  catalogStructureDefaults,
  STARCRAFT2_STRUCTURE_DEFAULT_RULES,
  type CatalogStructureDefault,
} from './structure-defaults.js'

/** Raised when a source cannot be read as a catalog document at all. */
export class UnsupportedDataSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedDataSourceError'
  }
}

/** One parsed GameData file backing a document, in load order. */
export interface LoadedCatalogFile {
  /** Logical path of the originating source, forward-slashed. */
  readonly path: string
  /**
   * `AssetSourceDescriptor.id` of the source this file was read from, when it was read through
   * one. Edit plans need it to address the right source: a multi-file catalog document has one
   * descriptor per file, and only the primary one is reachable through `Sc2DataDocument.source`.
   */
  readonly sourceId?: string
  /** Mod root this file was attributed to, or `''` when unknown. */
  readonly modPath: string
  /** Decoded source text, retained so language operations run without a second read. */
  readonly text: string
  readonly parsed: ParsedCatalogFile
  /** Why the text is not a readable catalog (malformed XML); `parsed` is then empty. */
  readonly malformed?: string
}

/** An entity whose `parent=` names no entity present in the loaded set. */
export interface UnresolvedParent {
  readonly namespace: string
  readonly id: string
  readonly parent: string
}

export interface CatalogStats {
  readonly namespaces: readonly string[]
  readonly entityCount: number
  /** Root entry types seen across the loaded files, e.g. `CUnit`, `CActorUnit`. */
  readonly rootTypes: readonly string[]
  /**
   * Entities inheriting from an ancestor that is not in this document set. Non-empty means the
   * dependency chain was not supplied and `getResolved()` returns partially-merged fields.
   */
  readonly unresolvedParents: readonly UnresolvedParent[]
  /** `CConst` entities available to drive `##token##` substitution. */
  readonly constEntityCount: number
}

/** What a document needs from detection; legacy `DetectionResult` values satisfy it too. */
export interface Sc2DataDetectionLike {
  readonly confidence: number
}

export interface Sc2DataDocument<
  Source extends Sc2DataSource = Sc2DataSource,
  Detection extends Sc2DataDetectionLike = Sc2DataDetectionLike,
> {
  readonly source: Source
  readonly detection: Detection
  readonly context: { readonly gameId?: string; readonly parentArtifactIds?: readonly string[] }
  /** The loaded store. Every query operation is a projection of this. */
  readonly catalog: TypedCatalog
  readonly schema: SchemaRegistry
  readonly files: readonly LoadedCatalogFile[]
  /** Structure of the primary (first) file, as `detect()` saw it. */
  readonly structure: CatalogStructure
  readonly stats: CatalogStats
}

export interface LoadCatalogDocumentInit<
  Source extends Sc2DataSource = Sc2DataSource,
  Detection extends Sc2DataDetectionLike = Sc2DataDetectionLike,
> {
  readonly files: readonly LoadedCatalogFile[]
  readonly source: Source
  readonly detection: Detection
  readonly context?: { readonly gameId?: string; readonly parentArtifactIds?: readonly string[] }
  /** Reuse a host's registry; defaults to `createBuiltinRegistry()`. */
  readonly schema?: SchemaRegistry
}

/** UTF-8 decode with BOM stripping, matching what the SC2 XML parser expects. */
export function decodeCatalogText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Mod root a GameData file belongs to: everything before its `GameData/` segment. Returns `''`
 * when the path is not laid out that way, which is honest — a loose `.xml` has no mod.
 */
export function modRootOfDataPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = /^(.*?)\/gamedata\/[^/]+$/i.exec(normalized)
  return match?.[1] ?? ''
}

/** Parse bytes already owned by an inspection session into one catalog file. */
export function catalogFileFromBytes(
  source: Pick<Sc2DataSource, 'id' | 'path'>,
  bytes: Uint8Array,
): LoadedCatalogFile {
  const path = source.path
  const text = decodeCatalogText(bytes)
  const modPath = modRootOfDataPath(path)
  try {
    const parsed = parseCatalogXml(text, {
      filePath: dataBasename(path),
      trackSource: true,
    })
    return { path, sourceId: source.id, modPath, text, parsed }
  } catch (error) {
    // The document still opens — its text stays readable and editable — as an empty catalog
    // that carries the parser's reason.
    return {
      path, sourceId: source.id, modPath, text,
      parsed: { rootTypes: [], entries: new Map() },
      malformed: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Load files into `catalog` in dependency order, including their structure defaults. */
export function loadCatalogFiles(catalog: TypedCatalog, files: readonly LoadedCatalogFile[]): void {
  for (const file of files) {
    catalog.loadFromFiles([file.parsed], file.modPath ? { mod: file.modPath } : {})
    for (const item of catalogStructureDefaultEntries(file.text, file.path, file.parsed.rootTypes)) {
      catalog.addStructureDefault(item.namespace, item.structureType, item.fields)
    }
  }
}

/** Entities whose declared parent is absent from the loaded store. */
function collectUnresolvedParents(catalog: TypedCatalog): UnresolvedParent[] {
  const unresolved: UnresolvedParent[] = []
  for (const namespace of catalog.namespaces()) {
    for (const entity of catalog.all(namespace)) {
      const parent = entity.parent
      if (parent === undefined) continue
      if (catalog.get(namespace, parent) === undefined) {
        unresolved.push({ namespace, id: entity.id, parent })
      }
    }
  }
  return unresolved
}

/**
 * Build a document from already-read files.
 *
 * Files are loaded in array order, which is the dependency-chain load order `TypedCatalog`
 * expects: a later file patching an earlier entity of the same id is a legal SC2 override, not a
 * conflict.
 */
export function loadCatalogDocument<
  Source extends Sc2DataSource,
  Detection extends Sc2DataDetectionLike,
>(init: LoadCatalogDocumentInit<Source, Detection>): Sc2DataDocument<Source, Detection> {
  const primary = init.files[0]
  if (primary === undefined) {
    throw new UnsupportedDataSourceError('A GameData document needs at least one catalog file.')
  }
  const schema = init.schema ?? createBuiltinRegistry()
  const catalog = new TypedCatalog({ schema, structureDefaults: STARCRAFT2_STRUCTURE_DEFAULT_RULES })
  loadCatalogFiles(catalog, init.files)

  const namespaces = catalog.namespaces()
  let entityCount = 0
  for (const namespace of namespaces) entityCount += catalog.all(namespace).length

  const rootTypes: string[] = []
  for (const file of init.files) {
    for (const type of file.parsed.rootTypes) if (!rootTypes.includes(type)) rootTypes.push(type)
  }

  const stats: CatalogStats = {
    namespaces,
    entityCount,
    rootTypes,
    unresolvedParents: collectUnresolvedParents(catalog),
    constEntityCount: catalog.all('Const').length,
  }

  return {
    source: init.source,
    detection: init.detection,
    context: init.context ?? {},
    catalog,
    schema,
    files: init.files,
    structure: inspectCatalogStructure(primary.text),
    stats,
  }
}
