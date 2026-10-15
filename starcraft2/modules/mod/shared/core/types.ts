import type { SchemaRegistry } from '../../../data/shared/catalog-engine/sc2-schema/index.js'
import type { ParsedCatalogFile } from '../../../data/shared/catalog-engine/xml/index.js'
import type { EditorCategoriesData } from '../../../data/shared/catalog-engine/sc2-editor-core/index.js'
import type { LocaleStrings } from './mod.js'
import type { SC2TextStyleSheet } from '../../../style/shared/font-styles.js'
import type { CatalogStructureDefaultEntry } from '../../../data/shared/format/structure-defaults.js'

/**
 * One mod's own contribution to a load — everything `SC2ModReader` reads/parses straight
 * from that mod's files, before merging into the shared catalog/locale/font-style state.
 * Cacheable per mod (see `ModReaderOptions.modParseCache`) because it depends only on that
 * mod's own files, not on load order or which other mods are in the chain.
 */
/** A listed GameData file the catalog could not read: its path and the XML parser's reason. */
export interface MalformedCatalogFile {
  /** The mod that lists it (VFS base path). */
  readonly mod: string
  /** Path inside that mod, e.g. `Base.SC2Data/GameData/UnitData.xml`. */
  readonly path: string
  readonly message: string
}

export interface ModParseResult {
  catalogFiles: ParsedCatalogFile[]
  /**
   * This mod's root-level structure defaults (`<SCost>` in AbilData.xml …), bound to the catalog
   * namespace they apply to, in catalog file order.
   */
  structureDefaults: CatalogStructureDefaultEntry[]
  /** This mod's own locale contributions (localeCode -> canonical file name -> key -> value). */
  locales: LocaleStrings
  /** This mod's own non-localized `FontStyles.SC2Style` contributions, merged (undefined if none). */
  fontStyles: SC2TextStyleSheet | undefined
  /** This mod's own per-locale font-style overlay contributions. */
  localizedFontStyleOverrides: Map<string, SC2TextStyleSheet>
  /** This mod's own `EditorData/EditorCategories.xml` contribution, unmerged (empty if none). */
  editorCategories: EditorCategoriesData
  /**
   * This mod's own localized `Editor/EditorCategoryStrings.txt` display names, keyed by
   * lower-cased locale code (e.g. `enus`). Only the reader's requested locales (plus `enus`
   * as the fallback) are read; empty map for a mod that ships none.
   */
  editorCategoryStrings: Map<string, Map<string, string>>
  /**
   * This mod's own non-localized asset-alias tables (`GameData/Assets.txt`,
   * `AssetsProduct.txt`), keyed by canonical stem (`Assets` / `AssetsProduct`) → alias → path.
   */
  assetStrings: Map<string, Map<string, string>>
  /** Catalog files this mod lists whose XML is malformed: left out of the catalog, with the reason. */
  malformedCatalogs: MalformedCatalogFile[]
}

/** The files a mod is read from, addressed as `<layer>/<relative path>` (see `workspace/vfs.ts`). */
export interface ModFiles {
  list(path: string): Promise<string[]>
  get(path: string): Promise<Uint8Array>
  getText(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

export interface ModReaderOptions {
  vfs: ModFiles
  /** Custom schema registry. Defaults to createBuiltinRegistry() if omitted. */
  schema?: SchemaRegistry
  /**
   * Cache of each mod's own parsed contribution (GameData XML, locale strings, font styles),
   * keyed by its lower-cased VFS base path. Shared and mutated across `read()` calls by the
   * caller (e.g. one per session), so an unchanged dependency (the base game, other mods) is
   * read + parsed once and reused instead of redoing that work on every reload of the mod that
   * depends on it — the dominant cost for a base-game-sized dependency chain. The caller is
   * responsible for invalidating a mod's entry when its files change.
   */
  modParseCache?: Map<string, ModParseResult>
  /**
   * False when the chain's server holds the catalogs (the mod's Resources): GameData XML is not
   * read into this reader's catalog, which then stays empty. A `modParseCache` must only be shared
   * between readers with the same setting.
   */
  catalogs?: boolean
  /**
   * Optional predicate deciding which non-catalog/non-locale files are read into `opaqueFiles`
   * (returns true to read the bytes). Defaults to reading every file, for verbatim round-trip
   * export. A consumer that never re-exports a mod (e.g. an editor loading the base game just to
   * read its data) can skip large binary assets — reading all of `base.sc2assets/`
   * (textures/models, ~1 GB for the base game) otherwise dominates load time by ~100×.
   */
  includeOpaqueFile?: (relPath: string) => boolean
  /**
   * Read only these locale codes' string files and font-style overlays (lower-cased,
   * e.g. `['enus']`). Omit to read every locale. The base game ships 10+ full locales
   * and each is megabytes of strings — a consumer that only ever queries one locale
   * (e.g. the GameData LSP server) skips ~90% of the locale read/parse work.
   * NOTE: `modParseCache` entries depend on this filter — a cache must only ever be
   * shared between readers using the SAME filter.
   */
  localeFilter?: readonly string[]
  /** Optional cached file list for a mod root, used to avoid re-listing read-only base mods. */
  listFiles?: (modPath: string) => readonly string[] | undefined
  /** Called when the reader obtains a file list, so callers can cache it. */
  onFileList?: (modPath: string, files: readonly string[]) => void
  /** Optional per-stage timing hook (stage label + elapsed ms) for load profiling. */
  onStage?: (stage: string, ms: number) => void
}

export interface LoadModOptions {
  /**
   * Explicitly specify dependency mod paths (VFS paths) in load order.
   * If provided, ComponentList.SC2Components is ignored.
   */
  deps?: string[]
  /**
   * Root VFS path for resolving relative dependency entries in ComponentList.
   * e.g. 'file:C:/Program Files/StarCraft II/'
   * If not provided, entries are resolved relative to the mod's parent directory.
   */
  rootPath?: string
}

