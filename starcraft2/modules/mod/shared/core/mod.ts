import type { RawFields, RawValue } from '../../../data/shared/catalog-engine/xml/index.js'
import type { TypedCatalog, TypedNamespace, CatalogEntity, EntitySource } from '../../../data/shared/catalog-engine/sc2-catalog/index.js'
import type { SchemaRegistry } from '../../../data/shared/catalog-engine/sc2-schema/index.js'
import type { SC2LayoutFile } from '../../../layout/shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import type { SC2BankList } from '../../../banks/shared/core/types.js'
import type { DocumentHeaderData, VersionFileData } from '../../codecs/document-metadata/core/index.js'
import { EMPTY_EDITOR_CATEGORIES } from '../../../data/shared/catalog-engine/sc2-editor-core/index.js'
import type { EditorCategoriesData } from '../../../data/shared/catalog-engine/sc2-editor-core/index.js'
import { createTextStyleSheet, resolveTextConstant, resolveTextStyle } from '../../../style/shared/font-styles.js'
import type { SC2ResolvedTextStyle, SC2TextStyleSheet } from '../../../style/shared/font-styles.js'
import type { MalformedCatalogFile } from './types.js'

/**
 * Locale string data keyed by locale code → file name → key → value.
 * e.g. strings.get('enUS')?.get('GameStrings')?.get('Unit/Name/Marine') === 'Marine'
 *
 * Multiple mods are merged: later mod entries overwrite earlier ones (same locale+file+key).
 * File name keys are normalised to PascalCase without extension:
 *   gamestrings.txt → GameStrings
 *   gamehotkeys.txt → GameHotkeys
 */
export type LocaleStrings = Map<string, Map<string, Map<string, string>>>

/**
 * A loaded SC2 mod — merged catalog of all dependency + own entries.
 * Exposes typed namespace accessors for common SC2 catalogs.
 */
export class SC2Mod {
  constructor(
    private readonly catalog: TypedCatalog,
    public readonly loadOrder: ReadonlyArray<string>,
    public readonly locales: LocaleStrings = new Map(),
    /** Verbatim files from the primary mod that are not catalog XML or locale strings */
    public readonly opaqueFiles: ReadonlyMap<string, Uint8Array> = new Map(),
    /**
     * Parsed `.SC2Layout` UI files from the primary mod, keyed by relative path
     * (e.g. `Base.SC2Data/UI/Layout/Custom/Foo.SC2Layout`). The raw bytes also
     * remain in {@link opaqueFiles} for verbatim round-trip export.
     */
    public readonly layouts: ReadonlyMap<string, SC2LayoutFile> = new Map(),
    /**
     * Parsed `BankList.xml` metadata from the primary map/mod, when present.
     * The raw file also remains in {@link opaqueFiles} for verbatim round-trip
     * export. BankList declares which player bank files SC2 should preload.
     */
    public readonly bankList: SC2BankList | undefined = undefined,
    /**
     * Parsed `DocumentHeader` metadata from the primary mod/map (format markers,
     * build number, flags, dependency list, and the DocInfo/MapInfo/LoadingScreen
     * key-value entries), when present and parseable. The raw bytes also remain
     * in {@link opaqueFiles}; on export the structured value (if set) is written
     * back via `writeDocumentHeader`, so edits to it round-trip.
     */
    public readonly documentHeader: DocumentHeaderData | undefined = undefined,
    /**
     * Parsed `<file>.version` sidecars from the primary mod/map, keyed by the
     * archive entry path without the `.version` suffix (e.g. `Triggers` or
     * `Base.SC2Data/UI/Layout/DescIndex`). Empty sidecars parse to `null`.
     */
    public readonly versionFiles: ReadonlyMap<string, VersionFileData | null> = new Map(),
    /**
     * Merged non-localized `FontStyles.SC2Style` data across the dependency
     * chain. Later mods override earlier constants/styles.
     */
    public readonly fontStyles: SC2TextStyleSheet = createTextStyleSheet(),
    /**
     * Locale-specific font-style overlays. Each entry is already merged over
     * {@link fontStyles}; use {@link fontStylesForLocale} for lookup.
     */
    public readonly localizedFontStyles: ReadonlyMap<string, SC2TextStyleSheet> = new Map(),
    /**
     * Merged `EditorData/EditorCategories.xml` metadata across the dependency
     * chain (editor-only object/field categorisation). Later mods extend/override
     * earlier ones, same as catalog. Defaults to {@link EMPTY_EDITOR_CATEGORIES}.
     */
    public readonly editorCategories: EditorCategoriesData = EMPTY_EDITOR_CATEGORIES,
    /**
     * Merged `@@` asset-alias table (`GameData/Assets.txt` + `AssetsProduct.txt`)
     * across the dependency chain — alias name → path, later mods winning. Empty
     * when no mod in the chain declares aliases.
     */
    public readonly assetAliases: ReadonlyMap<string, string> = new Map(),
    /** Listed GameData files left out because their XML is malformed, in load order. */
    public readonly malformedCatalogs: readonly MalformedCatalogFile[] = [],
  ) {}

  get schema(): SchemaRegistry {
    return this.catalog.schema
  }

  get units(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Unit')
  }
  get weapons(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Weapon')
  }
  get abils(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Abil')
  }
  get effects(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Effect')
  }
  get behaviors(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Behavior')
  }
  get actors(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Actor')
  }
  get buttons(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Button')
  }
  get upgrades(): TypedNamespace<RawFields> {
    return this.catalog.namespace('Upgrade')
  }

  namespace<T = RawFields>(ns: string): TypedNamespace<T> {
    return this.catalog.namespace<T>(ns)
  }

  getResolved(namespace: string, id: string): RawFields | undefined {
    return this.catalog.getResolved(namespace, id)
  }

  /** The declaration that supplied each resolved field (see `TypedCatalog.getResolvedSources`). */
  getResolvedSources(namespace: string, id: string): Readonly<Record<string, EntitySource>> | undefined {
    return this.catalog.getResolvedSources(namespace, id)
  }

  structureDefaults(namespace: string): ReadonlyMap<string, RawValue> {
    return this.catalog.getStructureDefaults(namespace)
  }

  get(namespace: string, id: string): CatalogEntity | undefined {
    return this.catalog.get(namespace, id)
  }

  all(namespace: string): CatalogEntity[] {
    return this.catalog.all(namespace)
  }

  namespaces(): string[] {
    return this.catalog.namespaces()
  }

  fontStylesForLocale(locale?: string): SC2TextStyleSheet {
    if (!locale) return this.fontStyles
    return this.localizedFontStyles.get(locale.toLowerCase()) ?? this.fontStyles
  }

  getTextConstant(name: string, locale?: string): string | undefined {
    return resolveTextConstant(this.fontStylesForLocale(locale), name)
  }

  getTextStyle(name: string, locale?: string): SC2ResolvedTextStyle | undefined {
    return resolveTextStyle(this.fontStylesForLocale(locale), name)
  }

  /** Whether `id` is a `<const>` alias declared for field `path` anywhere in the load order. */
  hasConstAlias(path: string, id: string): boolean {
    return this.catalog.hasConstAlias(path, id)
  }

  /** Re-key an entity in the catalog store (used by ops/rename). */
  renameEntry(namespace: string, oldId: string, newId: string): void {
    this.catalog.renameEntry(namespace, oldId, newId)
  }
}


