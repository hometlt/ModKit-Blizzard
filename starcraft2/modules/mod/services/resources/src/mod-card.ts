/**
 * The Mod card: what a reader wants to know about a mod before opening any of its files.
 *
 * Identity comes from the package's own documents (the localized names in DocumentHeader, the icon
 * in DocumentInfo), then what it depends on, what the component list says the game loads, how
 * much data, text and art it carries, and links to the documents a modder opens next. Every entity
 * of the mod is lent through the selector the entity cards use, so a unit listed here opens its own
 * card, resolved against the whole mod and its strings.
 */
import { getAttr, provenanceOf, scanXml } from '@modkit/codec-kit'
import { starcraft2NamespaceForType } from '@modkit/blizzard-starcraft2/schema'
import {
  catalogConstantNamespace,
  type CatalogEntity,
} from '../../../../data/shared/catalog-engine/sc2-catalog/index.js'
import { galaxySymbols, type GalaxyResourceSymbol } from './galaxy-symbols.js'
import { resolveTextConstant, resolveTextStyle } from '../../../../style/shared/font-styles.js'
import { parseFontStyles } from '../../../../style/shared/font-styles.js'
import { parseEditorCategories } from '../../../../data/shared/catalog-engine/sc2-editor-core/index.js'
import { parseSc2Strings } from '../../../../strings/shared/core/text-file.js'
import { MOD_DOCUMENT_ROUTES } from '../../../shared/core/document-routes.js'
import { localeFromFontStylePath } from '../../../shared/core/reader.js'
import type { SC2Mod } from '../../../shared/core/index.js'
import { isOwnEntity, parseEditorCats, plainName } from '../../../shared/core/entities.js'
import type {
  AssetSourceRef,
  JsonValue,
  RelatedSubjectFact,
  PageRequest,
  SubjectCatalogPort,
  SubjectFact,
  TreeDataSource,
  TreeNodeFacts,
  TreeQuery,
  TreeNodeRef,
} from '@modkit/sdk'
import { entitySubjectId } from '../../../../data/codecs/sc2data/src/entity-cards.js'
import { parseComponentListEntries } from '../../../codecs/document-metadata/core/component-list.js'
import { parseDependency, entryLocale } from '../../../codecs/document-metadata/facts.js'
import { sc2NamespaceEntrySubjectId } from '../../../../../shared/package-namespace/runtime.js'
import { createSc2LayoutResourceResolver } from './layout-resource.js'
import { modEntitySelector } from './entity-selector.js'

export interface ModCardEntry {
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly size?: bigint
}

/**
 * One package of the load chain, in the order the engine loads it — Core first, the active package
 * last. `declared` is what this package's own DocumentInfo names; `engine-implicit` is what the
 * engine loads underneath it regardless.
 */
export interface ModDependencyLink {
  readonly path: string
  readonly required: boolean
  readonly basis: string
  /** The loaded package itself, as the loader addresses it (`content-source://local:casc/mods/liberty.sc2mod`). */
  readonly subjectId?: string
}

export interface ModCardInput {
  readonly root: AssetSourceRef
  /** The winning layer of each effective file; omitted for a single package. */
  readonly rootForPath?: (path: string) => AssetSourceRef
  /** The original package of a resolved Data declaration. */
  readonly rootForMod?: (mod: string) => AssetSourceRef | undefined
  readonly revision: string
  /** The package's mod context, when the host placed it in one: entity cards carry the whole chain (5.7). */
  readonly catalog?: SubjectCatalogPort
  /** The locale entity names are shown in (the context's first requested one); enUS when absent. */
  readonly locale?: string
  readonly entries: readonly ModCardEntry[]
  readonly files: ReadonlyMap<string, Uint8Array>
  /** Localized documents in load order, including shadowed paths for key-level provenance. */
  readonly layeredSources?: readonly {
    readonly path: string
    readonly bytes: Uint8Array
    readonly root: AssetSourceRef
  }[]
  /**
   * Every listed file of each loaded package, in load order and this package last: what Files shows,
   * assets included. Without it Files shows this package's entries and loaded documents.
   */
  readonly layerFiles?: readonly {
    readonly path: string
    readonly root: AssetSourceRef
    readonly paths: readonly string[]
  }[]
  readonly dependencies: readonly string[]
  /** The resolved load chain. Falls back to the declared references when the owner has none. */
  readonly dependencyChain?: readonly ModDependencyLink[]
  readonly mod: {
    readonly locales: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>
    /** Packages in load order, this one last; tells an entity of this package from an inherited one. */
    readonly loadOrder?: readonly string[]
    readonly documentHeader?: {
      readonly entries: readonly { key: string; type: string; value: string }[]
      /** The game build the package was saved with. */
      readonly timestamp1?: number
      readonly flags?: number
    }
    readonly layouts?: SC2Mod['layouts']
    readonly fontStyles?: SC2Mod['fontStyles']
    fontStylesForLocale?(locale?: string): SC2Mod['fontStyles']
    readonly editorCategories?: SC2Mod['editorCategories']
    readonly assetAliases?: SC2Mod['assetAliases']
    readonly malformedCatalogs?: SC2Mod['malformedCatalogs']
    namespaces(): string[]
    all(namespace: string): readonly unknown[]
    getResolved?(namespace: string, id: string): Readonly<Record<string, unknown>> | undefined
    structureDefaults?(namespace: string): ReadonlyMap<string, unknown>
  }
  readonly namespaces: readonly {
    readonly ns: string
    readonly own: number
    readonly total: number
  }[]
}

const utf8 = new TextDecoder('utf-8', { fatal: false })

function fileText(files: ReadonlyMap<string, Uint8Array>, name: string): string | undefined {
  const lower = name.toLowerCase()
  const found = [...files].find(([path]) => path.toLowerCase() === lower)
  return found === undefined ? undefined : utf8.decode(found[1])
}

/** Documents a modder opens next, in the order they are usually wanted. */
const MAIN_DOCUMENTS: readonly RegExp[] = [
  /^documentinfo$/iu,
  /^documentheader$/iu,
  /^componentlist\.sc2components$/iu,
  /(^|\/)gamedata\.xml$/iu,
  /(^|\/)gamedata\/[^/]+\.xml$/iu,
  /(^|\/)localizeddata\/gamestrings\.txt$/iu,
  /(^|\/)gametext\//iu,
  /(^|\/)triggers$/iu,
]

const ASSET = /\.(dds|tga|png|jpg|m3|m3a|m3h|ogg|wav|mp3|ogv|webm|fx)$/iu

type ResourceCategory = Readonly<{
  id: string
  label: string
  kind: string
}>

const encode = (value: string): string => encodeURIComponent(value)
const decode = (value: string): string => decodeURIComponent(value)

function resourcePage(items: readonly TreeNodeRef[], cursor: string | undefined, limit: number) {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new TypeError('tree page limit must be positive')
  const start = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isSafeInteger(start) || start < 0 || start > items.length) {
    throw new RangeError('tree page cursor is invalid')
  }
  const page = items.slice(start, start + limit)
  return Object.freeze({
    items: Object.freeze(page),
    ...(start + page.length < items.length ? { nextCursor: String(start + page.length) } : {}),
  })
}

/** The resource family a file belongs to, as Files groups them and the mod card counts them. */
const fileTypeOf = (path: string): string => {
  const name = path.split('/').at(-1)?.toLowerCase() ?? path.toLowerCase()
  if (name.endsWith('.galaxy') || name === 'triggers' || name === 'mapscript') return 'Galaxy'
  if (name.endsWith('.sc2layout')) return 'Layouts'
  if (name === 'gamedata.xml' || /(?:^|\/)gamedata\/[^/]+\.xml$/iu.test(path)) return 'Catalogs'
  if (/\/localizeddata\/[^/]+\.txt$/iu.test(path)) return 'Strings'
  if (
    /^(?:documentinfo|documentheader|componentlist\.sc2components|banklist\.xml|preload\.xml|objects|regions)$/u.test(
      name,
    ) ||
    /\.(?:version|sc2style|sc2gameinfo)$/u.test(name)
  )
    return 'Documents'
  if (/\.(?:dds|tga|png|jpe?g)$/u.test(name)) return 'Images'
  if (/\.(?:m3|m3a|m3h)$/u.test(name)) return 'Models'
  if (/\.(?:ogg|wav|mp3|flac)$/u.test(name)) return 'Audio'
  if (/\.(?:otf|ttf|fnt)$/u.test(name)) return 'Fonts'
  if (/\.(?:ogv|webm)$/u.test(name)) return 'Video'
  return 'Other'
}
const FILE_TYPES = [
  'Galaxy', 'Layouts', 'Catalogs', 'Images', 'Models', 'Audio', 'Fonts', 'Video', 'Strings', 'Documents', 'Other',
]

/** One package's parsed resources, exposed through the common tree ABI. */
export function modResourceTree(input: ModCardInput): TreeDataSource {
  const files = Object.freeze(input.entries.filter(entry => entry.kind === 'file'))
  const fileByPath = new Map(files.map(entry => [entry.path, entry]))
  const fileSubject = (path: string): string =>
    sc2NamespaceEntrySubjectId(input.rootForPath?.(path) ?? input.root, path)
  const entryByLowerPath = new Map(files.map(entry => [entry.path.toLowerCase(), entry]))
  /*
   * Files, as MK2's tree had them: every file of the package by resource family, assets included,
   * and per family what the loaded dependencies bring, under «From dependencies». An installed
   * package holds tens of thousands of files, so each family is a folder tree, built for one family
   * and layer the first time it is opened.
   */
  const loadedPaths = Object.freeze([...input.files.keys()].sort())
  const resourcePaths = Object.freeze([...new Set(
    input.layerFiles?.at(-1)?.paths ?? [...loadedPaths, ...files.map(entry => entry.path)],
  )].sort())
  const resourcePathSet = new Set(resourcePaths)
  /** Load order, this package last; a single package has only itself. */
  const fileLayers = Object.freeze([
    ...(input.layerFiles ?? []).slice(0, -1).map(layer => ({
      label: layer.path.split(/[\\/]/u).at(-1) ?? layer.path, root: layer.root, paths: layer.paths,
    })),
    { label: 'This package', root: input.root, paths: resourcePaths },
  ])
  const ownLayer = fileLayers.length - 1
  const layerTypes = new Map<number, ReadonlyMap<string, readonly string[]>>()
  const pathsOf = (layer: number, type: string): readonly string[] => {
    let types = layerTypes.get(layer)
    if (types === undefined) {
      const grouped = new Map<string, string[]>()
      for (const path of fileLayers[layer]?.paths ?? []) {
        const type = fileTypeOf(path)
        const known = grouped.get(type)
        if (known === undefined) grouped.set(type, [path])
        else known.push(path)
      }
      layerTypes.set(layer, (types = grouped))
    }
    return types.get(type) ?? []
  }
  const dependencyLayersWith = (type: string): number[] =>
    fileLayers.map((_, layer) => layer).filter(layer => layer !== ownLayer && pathsOf(layer, type).length > 0)
  const typeCount = (type: string): number =>
    fileLayers.reduce((sum, _, layer) => sum + pathsOf(layer, type).length, 0)
  interface Folder {
    readonly dirs: Map<string, Folder>
    readonly files: string[]
    count: number
  }
  const folderRoots = new Map<string, Folder>()
  const folderAt = (type: string, layer: number, path: string): Folder | undefined => {
    const key = `${type}\u0000${layer}`
    let folder = folderRoots.get(key)
    if (folder === undefined) {
      const root: Folder = { dirs: new Map(), files: [], count: 0 }
      for (const file of pathsOf(layer, type)) {
        let at = root
        at.count += 1
        for (const segment of file.split('/').slice(0, -1)) {
          let next = at.dirs.get(segment)
          if (next === undefined) at.dirs.set(segment, (next = { dirs: new Map(), files: [], count: 0 }))
          at = next
          at.count += 1
        }
        at.files.push(file)
      }
      folderRoots.set(key, (folder = root))
    }
    for (const segment of path === '' ? [] : path.split('/')) {
      folder = folder.dirs.get(segment)
      if (folder === undefined) return undefined
    }
    return folder
  }
  const folderRef = (type: string, layer: number, parent: string, path: string): TreeNodeRef =>
    ref(`folder/${encode(type)}/${layer}/${parent === '' ? 0 : parent.length + 1}/${encode(path)}`, true)
  const folderChildren = (type: string, layer: number, path: string): readonly TreeNodeRef[] => {
    const folder = folderAt(type, layer, path)
    if (folder === undefined) return []
    const nodes: TreeNodeRef[] = []
    for (const name of [...folder.dirs.keys()].sort()) {
      let child = path === '' ? name : `${path}/${name}`
      let at = folder.dirs.get(name) as Folder
      // A chain of lone folders reads as one row (`Base.SC2Data/UI/Layout`), as MK2 showed it.
      while (at.files.length === 0 && at.dirs.size === 1) {
        const [only, next] = [...at.dirs][0] as [string, Folder]
        child = `${child}/${only}`
        at = next
      }
      nodes.push(folderRef(type, layer, path, child))
    }
    for (const file of [...folder.files].sort()) {
      nodes.push(layer === ownLayer ? ref(`file/${encode(file)}`) : ref(`layerfile/${layer}/${encode(file)}`))
    }
    return nodes
  }
  /*
   * Dependencies shows the whole chain the engine loads, Core first, not only what this package
   * declares: a package that names Void alone still loads Core, Liberty and Swarm underneath it,
   * and an author who cannot see that cannot reason about where a value comes from.
   */
  const chain: readonly ModDependencyLink[] =
    input.dependencyChain !== undefined && input.dependencyChain.length > 0
      ? input.dependencyChain
      : Object.freeze(
          input.dependencies.map(value =>
            Object.freeze({ path: value, required: true, basis: 'declared' }),
          ),
        )
  const documentInfoPath = loadedPaths.find(path => path.toLowerCase() === 'documentinfo')
  const layouts: SC2Mod['layouts'] = input.mod.layouts ?? new Map()
  const fontStyles = input.mod.fontStylesForLocale?.(input.locale ?? 'enUS') ?? input.mod.fontStyles
  const editorCategories = input.mod.editorCategories?.categories ?? new Map()
  const assetAliases = input.mod.assetAliases ?? new Map()
  const malformedCatalogs = input.mod.malformedCatalogs ?? []
  const ownModPath = input.mod.loadOrder?.at(-1)
  const entityName = (namespace: string, id: string): string => plainName(input.mod, input.locale ?? 'enUS', namespace, id)
  const entitiesByNamespace = new Map<string, readonly CatalogEntity[]>()
  const entityByNamespaceAndId = new Map<string, ReadonlyMap<string, CatalogEntity>>()
  const entities = (namespace: string): readonly CatalogEntity[] => {
    let found = entitiesByNamespace.get(namespace)
    if (found === undefined) {
      found = input.mod.all(namespace) as readonly CatalogEntity[]
      entitiesByNamespace.set(namespace, found)
    }
    return found
  }
  const entityById = (namespace: string, id: string): CatalogEntity | undefined => {
    let found = entityByNamespaceAndId.get(namespace)
    if (found === undefined) {
      found = new Map(entities(namespace).map(entity => [entity.id, entity]))
      entityByNamespaceAndId.set(namespace, found)
    }
    return found.get(id)
  }
  type ResourceOrigin = { readonly path: string; readonly root: AssetSourceRef }
  const sourceOf = (origin: ResourceOrigin | undefined): string | undefined => origin === undefined
    ? undefined : sc2NamespaceEntrySubjectId(origin.root, origin.path)
  const layeredSources = input.layeredSources ?? [...input.files].map(([path, bytes]) => ({
    path, bytes, root: input.rootForPath?.(path) ?? input.root,
  }))
  const styleOrigins = new Map<string, ResourceOrigin>()
  const editorOrigins = new Map<string, ResourceOrigin>()
  const editorValueOrigins = new Map<string, ResourceOrigin>()
  const aliasOrigins = new Map<string, ResourceOrigin>()
  let layeredOriginsIndexed = false
  const indexLayeredOrigins = (): void => {
    if (layeredOriginsIndexed) return
    layeredOriginsIndexed = true
    const indexStyles = (source: { readonly path: string; readonly bytes: Uint8Array; readonly root: AssetSourceRef }): void => {
      const origin = { path: source.path, root: source.root }
      const sheet = parseFontStyles(utf8.decode(source.bytes))
      for (const name of sheet.styles.keys()) styleOrigins.set(`styles\0${name}`, origin)
      for (const name of sheet.constants.keys()) styleOrigins.set(`constants\0${name}`, origin)
      for (const name of sheet.fontGroups.keys()) styleOrigins.set(`font-groups\0${name}`, origin)
    }
    for (const source of layeredSources) {
      const origin = { path: source.path, root: source.root }
      if (MOD_DOCUMENT_ROUTES.fontStyles.pathPattern.test(source.path) &&
          localeFromFontStylePath(source.path) === undefined) {
        indexStyles(source)
      } else if (MOD_DOCUMENT_ROUTES.editorCategories.pathPattern.test(source.path)) {
        for (const [name, values] of parseEditorCategories(utf8.decode(source.bytes)).categories) {
          editorOrigins.set(name, origin)
          for (const value of values) {
            const key = `${name}\0${value}`
            if (!editorValueOrigins.has(key)) editorValueOrigins.set(key, origin)
          }
        }
      } else if (MOD_DOCUMENT_ROUTES.assetStrings.pathPattern.test(source.path)) {
        for (const name of parseSc2Strings(utf8.decode(source.bytes)).keys())
          aliasOrigins.set(name, origin)
      }
    }
    // The canonical reader applies locale overrides after the complete base sheet.
    for (const source of layeredSources) {
      if (MOD_DOCUMENT_ROUTES.fontStyles.pathPattern.test(source.path) &&
          localeFromFontStylePath(source.path) === (input.locale ?? 'enUS').toLowerCase()) indexStyles(source)
    }
  }
  /*
   * Preload: what the package asks the game to load up front, entry by entry, as MK2's tree showed
   * it; an entry opens its file at the element. Only a file with entries makes the category — the
   * file itself stays under Files either way.
   */
  interface PreloadRow {
    readonly path: string
    readonly tag: string
    readonly name: string
    readonly range: NonNullable<TreeNodeFacts['range']>
  }
  let preloadRows: readonly PreloadRow[] | undefined
  const preload = (): readonly PreloadRow[] => {
    if (preloadRows !== undefined) return preloadRows
    const rows: PreloadRow[] = []
    for (const [path, bytes] of input.files) {
      if (!/(?:^|\/)preload\.xml$/iu.test(path)) continue
      const text = utf8.decode(bytes)
      let line = 0
      let lineStart = 0
      let scanned = 0
      for (const element of scanXml(text).filter(root => root.tag === 'Preload').flatMap(root => root.children)) {
        for (; scanned < element.start; scanned += 1) {
          if (text.charCodeAt(scanned) === 10) {
            line += 1
            lineStart = scanned + 1
          }
        }
        rows.push(Object.freeze({
          path,
          tag: element.tag,
          name: getAttr(element, 'id')?.value ?? getAttr(element, 'path')?.value ?? '',
          range: Object.freeze({
            utf16Offset: element.start,
            utf16Length: element.openEnd - element.start,
            line,
            column: element.start - lineStart,
          }),
        }))
      }
    }
    return (preloadRows = Object.freeze(rows))
  }
  const galaxyFiles = files.filter(
    entry => /\.galaxy$/iu.test(entry.path) && input.files.has(entry.path),
  )
  const constants = new Map<string, CatalogEntity[]>()
  for (const entity of entities('Const')) {
    const namespace = catalogConstantNamespace(entity) ?? 'Const'
    const bucket = constants.get(namespace) ?? []
    bucket.push(entity)
    constants.set(namespace, bucket)
  }
  const namespaces = input.namespaces.flatMap(item => {
    if (item.ns !== 'Const') return [item]
    const unclassified = constants.get('Const')?.length ?? 0
    return unclassified === 0 ? [] : [{ ns: 'Const', own: unclassified, total: unclassified }]
  })
  for (const namespace of constants.keys()) {
    if (!namespaces.some(item => item.ns === namespace)) {
      const count = namespace === 'Const' ? (constants.get('Const')?.length ?? 0) : 0
      namespaces.push({ ns: namespace, own: count, total: count })
    }
  }

  /**
   * Declaration locations from the loaded catalog documents, indexed once on first use. Catalog
   * filenames may be custom and contain several namespaces; the Data schema owns classification.
   * Map insertion order is the reader's load order, not the sorted order used to display Files.
   */
  interface Declaration {
    readonly path: string
    readonly root?: AssetSourceRef
    readonly utf16Offset: number
    readonly utf16Length: number
    readonly line: number
    readonly column: number
  }
  const DEFAULT_KEY_PREFIX = 'default/'
  const declarationCache = new Map<string, Map<string, Declaration>>()
  let declarationsIndexed = false
  const declarationsOf = (namespace: string): ReadonlyMap<string, Declaration> => {
    if (declarationsIndexed) return declarationCache.get(namespace) ?? new Map()
    for (const [path, bytes] of input.files) {
      if (!/\.xml$/iu.test(path)) continue
      const text = utf8.decode(bytes)
      let line = 0
      let lineStart = 0
      let scanned = 0
      const entities = scanXml(text)
        .filter(root => root.tag === 'Catalog')
        .flatMap(root => root.children)
      for (const element of entities) {
        const entityNamespace =
          element.tag === 'const' ? 'Const' : starcraft2NamespaceForType(element.tag)
        if (entityNamespace === undefined) continue
        const at = element.start
        for (let index = scanned; index < at; index += 1) {
          if (text.charCodeAt(index) === 10) {
            line += 1
            lineStart = index + 1
          }
        }
        scanned = at
        const id = getAttr(element, 'id')?.value
        const key =
          id !== undefined && id !== '' ? `entity/${id}` : `${DEFAULT_KEY_PREFIX}${element.tag}`
        let found = declarationCache.get(entityNamespace)
        if (found === undefined) declarationCache.set(entityNamespace, (found = new Map()))
        // Later loaded declarations override earlier ones, including repeats within a document.
        found.set(
          key,
          Object.freeze({
            path,
            utf16Offset: at,
            utf16Length: element.openEnd - at,
            line,
            column: at - lineStart,
          }),
        )
      }
    }
    declarationsIndexed = true
    return declarationCache.get(namespace) ?? new Map()
  }
  const categories: readonly ResourceCategory[] = Object.freeze([
    { id: 'gamedata', label: 'GameData', kind: 'data-category' },
    { id: 'strings', label: 'Strings', kind: 'strings-category' },
    { id: 'galaxy', label: 'Galaxy', kind: 'script-category' },
    { id: 'layouts', label: 'Layouts', kind: 'layout-category' },
    { id: 'asset-aliases', label: 'Asset aliases', kind: 'asset-alias-category' },
    { id: 'editor-categories', label: 'EditorCategories', kind: 'editor-category' },
    { id: 'font-styles', label: 'FontStyles', kind: 'style-category' },
    { id: 'preload', label: 'Preload', kind: 'preload-category' },
    { id: 'files', label: 'Files', kind: 'files-category' },
    { id: 'dependencies', label: 'Dependencies', kind: 'dependency-category' },
  ])
  const categoryById = new Map(categories.map(category => [category.id, category]))
  const namespaceByName = new Map(namespaces.map(item => [item.ns, item]))
  const ref = (id: string, hasChildren = false): TreeNodeRef => Object.freeze({ id, hasChildren })
  const categoryCount = (category: ResourceCategory): number => {
    switch (category.id) {
      case 'gamedata':
        return input.namespaces.reduce((sum, item) => sum + item.total, 0)
      case 'strings':
        return [...input.mod.locales.values()].reduce((sum, catalogs) =>
          sum + [...catalogs.values()].reduce((count, values) => count + values.size, 0), 0)
      case 'galaxy':
        return galaxyFiles.length
      case 'layouts':
        return layouts.size
      case 'asset-aliases':
        return assetAliases.size
      case 'editor-categories':
        return editorCategories.size
      case 'font-styles':
        return fontStyles?.styles.size ?? 0
      case 'preload':
        return preload().length
      case 'files':
        return fileLayers.reduce((sum, layer) => sum + layer.paths.length, 0)
      case 'dependencies':
        return chain.length
      default:
        return 0
    }
  }
  const categoryRef = (category: ResourceCategory): TreeNodeRef =>
    ref(
      `category/${category.id}`,
      category.id === 'font-styles'
        ? (fontStyles?.styles.size ?? 0) +
            (fontStyles?.constants.size ?? 0) +
            (fontStyles?.fontGroups.size ?? 0) >
            0
        : categoryCount(category) > 0 || (category.id === 'gamedata' && malformedCatalogs.length > 0),
    )
  const fileTypeRef = (type: string): TreeNodeRef => ref(`filetype/${encode(type)}`, true)
  const namespaceRef = (namespace: string): TreeNodeRef =>
    ref(`namespace/${encode(namespace)}`, true)
  const entityRef = (namespace: string, id: string): TreeNodeRef =>
    ref(`entity/${encode(namespace)}/${encode(id)}`, input.mod.getResolved !== undefined)
  const fieldRef = (namespace: string, id: string, path: readonly string[], value: unknown): TreeNodeRef =>
    ref(`field/${encode(namespace)}/${encode(id)}/${path.map(encode).join('/')}`,
      typeof value === 'object' && value !== null && Object.keys(value).length > 0)
  const fieldValue = (namespace: string, id: string, path: readonly string[]): unknown => {
    let value: unknown = input.mod.getResolved?.(namespace, id)
    for (const part of path) {
      if (value === null || typeof value !== 'object') return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }
  const defaultsRef = (namespace: string): TreeNodeRef => ref(`defaults/${encode(namespace)}`, true)
  const defaultRef = (namespace: string, className: string): TreeNodeRef => {
    const value = defaultValue(namespace, className, [])
    return ref(`default/${encode(namespace)}/${encode(className)}`,
      typeof value === 'object' && value !== null && Object.keys(value).length > 0)
  }
  const defaultFieldRef = (namespace: string, className: string, path: readonly string[], value: unknown): TreeNodeRef =>
    ref(`default-field/${encode(namespace)}/${encode(className)}/${path.map(encode).join('/')}`,
      typeof value === 'object' && value !== null && Object.keys(value).length > 0)
  const defaultValue = (namespace: string, className: string, path: readonly string[]): unknown => {
    const entity = entities(namespace)
      .find(item => !item.id && (item.class ?? `C${namespace}`) === className)
    let value: unknown = entity === undefined ? undefined :
      input.mod.getResolved?.(namespace, '') ?? entity.data
    for (const part of path) {
      if (value === null || typeof value !== 'object') return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }
  const structureDefaultRef = (namespace: string, type: string, value: unknown): TreeNodeRef =>
    ref(`structure-default/${encode(namespace)}/${encode(type)}`,
      typeof value === 'object' && value !== null && Object.keys(value).length > 0)
  const structureFieldRef = (namespace: string, type: string, path: readonly string[], value: unknown): TreeNodeRef =>
    ref(`structure-field/${encode(namespace)}/${encode(type)}/${path.map(encode).join('/')}`,
      typeof value === 'object' && value !== null && Object.keys(value).length > 0)
  const structureValue = (namespace: string, type: string, path: readonly string[]): unknown => {
    let value: unknown = input.mod.structureDefaults?.(namespace).get(type)
    for (const part of path) {
      if (value === null || typeof value !== 'object') return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }
  /*
   * A namespace's entities grouped by their resolved `EditorCategories` (`ObjectType:Unit ·
   * ObjectFamily:Melee`), uncategorized last — the grouping MK2's mod card offered. Offered when any
   * entity names categories itself, and resolved only when someone opens it.
   */
  const editorGroups = new Map<string, ReadonlyMap<string, readonly string[]>>()
  const hasEditorCategories = (namespace: string): boolean =>
    namespace !== 'Const' && input.mod.getResolved !== undefined &&
    entities(namespace).some(entity => entity.data?.['EditorCategories'] !== undefined)
  const editorGroupsOf = (namespace: string): ReadonlyMap<string, readonly string[]> => {
    let groups = editorGroups.get(namespace)
    if (groups === undefined) {
      const grouped = new Map<string, string[]>()
      for (const entity of entities(namespace)) {
        if (typeof entity.id !== 'string' || entity.id === '') continue
        const categories = parseEditorCats(input.mod.getResolved?.(namespace, entity.id)?.['EditorCategories'])
        const key = categories?.map(([name, value]) => `${name}:${value}`).join(' · ') ?? ''
        const known = grouped.get(key)
        if (known === undefined) grouped.set(key, [entity.id])
        else known.push(entity.id)
      }
      groups = new Map([...grouped].sort(([left], [right]) =>
        left === '' ? 1 : right === '' ? -1 : left.localeCompare(right)))
      editorGroups.set(namespace, groups)
    }
    return groups
  }
  const constantsRef = (namespace: string): TreeNodeRef =>
    ref(`constants/${encode(namespace)}`, true)
  const constantRef = (namespace: string, id: string): TreeNodeRef =>
    ref(`constant/${encode(namespace)}/${encode(id)}`)
  const layoutRef = (path: string): TreeNodeRef => ref(`layout/${encode(path)}`, true)
  const layoutSectionRef = (path: string, section: string): TreeNodeRef =>
    ref(`layout-section/${encode(path)}/${section}`, true)
  const layoutItemRef = (path: string, section: string, index: number): TreeNodeRef =>
    ref(`layout-item/${encode(path)}/${section}/${index}`)
  const layoutFrameRef = (
    path: string,
    indices: readonly number[],
    hasChildren: boolean,
  ): TreeNodeRef => ref(`layout-frame/${encode(path)}/${indices.join('/')}`, hasChildren)
  const layoutFrameAt = (path: string, indices: readonly number[]) => {
    let frame = layouts.get(path)?.frames[indices[0] ?? -1]
    for (const index of indices.slice(1)) frame = frame?.children[index]
    return frame
  }
  const layoutFrameHasChildren = (frame: NonNullable<ReturnType<typeof layoutFrameAt>>): boolean =>
    frame.children.length > 0 || frame.properties.length > 0 || frame.template !== undefined
  let layoutResolver: ReturnType<typeof createSc2LayoutResourceResolver> | undefined
  // The frame resolved last: a frame's children and then each of its properties ask for the same
  // frame in a row (the tree, and a search walking it), and resolving templates is the costly part.
  let lastResolvedFrame: { readonly key: string; readonly frame: ReturnType<typeof resolveLayoutFrameAt> } | undefined
  const resolvedLayoutFrameAt = (path: string, indices: readonly number[]) => {
    const key = JSON.stringify([path, indices])
    if (lastResolvedFrame?.key !== key) lastResolvedFrame = { key, frame: resolveLayoutFrameAt(path, indices) }
    return lastResolvedFrame.frame
  }
  const resolveLayoutFrameAt = (path: string, indices: readonly number[]) => {
    const root = layouts.get(path)?.frames[indices[0] ?? -1]
    if (root === undefined) return undefined
    const descendants: string[] = []
    let current = root
    for (const index of indices.slice(1)) {
      const child = current.children[index]
      if (child === undefined) return undefined
      descendants.push(child.name)
      current = child
    }
    layoutResolver ??= createSc2LayoutResourceResolver(
      [...layouts.keys()].flatMap(uri => {
        const text = fileText(input.files, uri)
        return text === undefined ? [] : [{ uri, text }]
      }),
    )
    return layoutResolver.frame(path, root.name, descendants)
  }
  const layoutPropertyRef = (path: string, indices: readonly number[], key: string): TreeNodeRef =>
    ref(`layout-property/${encode(path)}/${indices.join('.')}/${encode(key)}`)
  const styleSectionRef = (section: string): TreeNodeRef => ref(`style-section/${section}`, true)
  const styleItemRef = (section: string, name: string): TreeNodeRef =>
    ref(`style-item/${section}/${encode(name)}`, section === 'styles')
  const styleAttributeRef = (name: string, attribute: string): TreeNodeRef =>
    ref(`style-attribute/${encode(name)}/${encode(attribute)}`)
  const editorCategoryRef = (name: string): TreeNodeRef =>
    ref(`editor-category/${encode(name)}`, true)
  const editorValueRef = (name: string, index: number): TreeNodeRef =>
    ref(`editor-value/${encode(name)}/${index}`)
  const defaultClasses = (namespace: string): readonly string[] => {
    const all = entities(namespace) as readonly {
      readonly class?: string
      readonly id?: string
    }[]
    return [
      ...new Set(all.filter(entity => !entity.id).map(entity => entity.class ?? `C${namespace}`)),
    ]
  }
  const localeRef = (locale: string): TreeNodeRef => ref(`locale/${encode(locale)}`, true)
  const stringCatalogRef = (locale: string, catalog: string): TreeNodeRef =>
    ref(`strings/${encode(locale)}/${encode(catalog)}`, true)
  const stringRef = (locale: string, catalog: string, key: string): TreeNodeRef =>
    ref(`string/${encode(locale)}/${encode(catalog)}/${encode(key)}`)
  const stringGroupRef = (locale: string, catalog: string, group: string): TreeNodeRef =>
    ref(`stringgroup/${encode(locale)}/${encode(catalog)}/${encode(group)}`, true)

  /**
   * String keys are a path namespace — `Unit/Name/Zealot`, `Button/Tooltip/Attack` — so a flat list
   * of thousands is unusable. The leading segment is the grouping the game itself uses; a key with
   * no separator has none and is listed on its own.
   */
  const UNGROUPED = '(no category)'
  const stringGroupOf = (key: string): string => {
    const cut = key.indexOf('/')
    return cut <= 0 ? UNGROUPED : key.slice(0, cut)
  }
  const stringGroupCache = new Map<string, ReadonlyMap<string, readonly string[]>>()
  const groupedStrings = (locale: string, catalog: string): ReadonlyMap<string, readonly string[]> => {
    const cacheKey = `${locale}\0${catalog}`
    const known = stringGroupCache.get(cacheKey)
    if (known !== undefined) return known
    const groups = new Map<string, string[]>()
    for (const key of input.mod.locales.get(locale)?.get(catalog)?.keys() ?? []) {
      const group = stringGroupOf(key)
      const keys = groups.get(group) ?? []
      keys.push(key)
      groups.set(group, keys)
    }
    for (const keys of groups.values()) keys.sort()
    stringGroupCache.set(cacheKey, groups)
    return groups
  }
  const stringGroups = (locale: string, catalog: string): readonly string[] =>
    [...groupedStrings(locale, catalog).keys()].sort()
  const stringKeysIn = (locale: string, catalog: string, group: string): readonly string[] =>
    groupedStrings(locale, catalog).get(group) ?? []

  /** Where each key of one locale's catalog is written, built once per catalog on first use. */
  const stringDeclarationCache = new Map<string, ReadonlyMap<string, Declaration>>()
  const stringDeclarationsOf = (
    locale: string,
    catalog: string,
  ): ReadonlyMap<string, Declaration> => {
    const cacheKey = `${locale.toLowerCase()}|${catalog.toLowerCase()}`
    const known = stringDeclarationCache.get(cacheKey)
    if (known !== undefined) return known
    const wanted = `${locale.toLowerCase()}.sc2data/localizeddata/${catalog.toLowerCase()}.txt`
    const found = new Map<string, Declaration>()
    for (const { path, bytes, root } of layeredSources) {
      if (!path.toLowerCase().endsWith(wanted)) continue
      const text = utf8.decode(bytes)
      let offset = 0
      let line = 0
      for (const raw of text.split('\n')) {
        const separator = raw.indexOf('=')
        const key = separator <= 0 ? undefined : raw.slice(0, separator).trim()
        if (key !== undefined && key !== '' && !key.startsWith('//')) {
          found.set(
            key,
            Object.freeze({ path, root, utf16Offset: offset, utf16Length: key.length, line, column: 0 }),
          )
        }
        offset += raw.length + 1
        line += 1
      }
    }
    stringDeclarationCache.set(cacheKey, found)
    return found
  }
  const dependencyRef = (index: number): TreeNodeRef => ref(`dependency/${index}`)

  // Galaxy is analyzed only when expanded. The Galaxy module owns the parser and symbol model.
  const galaxyByKind = new Map<string, TreeNodeRef[]>()
  const galaxyNodes = new Map<
    string,
    { symbol: GalaxyResourceSymbol; path: string; text: string; children: readonly TreeNodeRef[] }
  >()
  let galaxyIndexed = false
  const indexGalaxy = (): void => {
    if (galaxyIndexed) return
    galaxyIndexed = true
    let serial = 0
    const add = (symbol: GalaxyResourceSymbol, path: string, text: string): TreeNodeRef => {
      const id = `galaxy-symbol/${serial++}`
      const children = (symbol.children ?? []).map(child => add(child, path, text))
      galaxyNodes.set(id, { symbol, path, text, children })
      return ref(id, children.length > 0)
    }
    for (const entry of galaxyFiles) {
      const text = utf8.decode(input.files.get(entry.path))
      try {
        for (const symbol of galaxySymbols(text, entry.path)) {
          const items = galaxyByKind.get(symbol.kind) ?? []
          items.push(add(symbol, entry.path, text))
          galaxyByKind.set(symbol.kind, items)
        }
      } catch {
        // A malformed script stays available under Files; one file must not hide other symbols.
      }
    }
    for (const items of galaxyByKind.values()) {
      items.sort((left, right) =>
        (galaxyNodes.get(left.id)?.symbol.name ?? '').localeCompare(
          galaxyNodes.get(right.id)?.symbol.name ?? '',
        ),
      )
    }
  }
  const galaxyKinds = [
    'function',
    'variable',
    'struct',
    'typedef',
    'include',
    'property',
    'parameter',
  ]
  const galaxyKindLabel = (kind: string): string =>
    (
      ({
        function: 'Functions',
        variable: 'Variables',
        struct: 'Structs',
        typedef: 'Typedefs',
        include: 'Includes',
        property: 'Properties',
        parameter: 'Parameters',
      }) as Record<string, string>
    )[kind] ?? kind

  const children = (node: TreeNodeRef): readonly TreeNodeRef[] => {
    if (node.id === 'root')
      return categories.filter(category => category.id !== 'preload' || preload().length > 0).map(categoryRef)
    const parts = node.id.split('/')
    if (parts[0] === 'category') {
      const category = categoryById.get(parts[1] ?? '')
      if (category === undefined) return []
      if (category.id === 'gamedata') {
        // A listed catalog whose XML is malformed is left out of the entities; say which and why.
        return [...namespaces.map(item => namespaceRef(item.ns)),
          ...malformedCatalogs.map((_, index) => ref(`data-error/${index}`))]
      }
      if (category.id === 'strings') return [...input.mod.locales.keys()].sort().map(localeRef)
      if (category.id === 'dependencies') return chain.map((_, index) => dependencyRef(index))
      if (category.id === 'files') return FILE_TYPES.filter(type => typeCount(type) > 0).map(fileTypeRef)
      if (category.id === 'preload') return preload().map((_, index) => ref(`preload/${index}`))
      if (category.id === 'galaxy') {
        indexGalaxy()
        return [...galaxyByKind.keys()]
          .sort((left, right) => galaxyKinds.indexOf(left) - galaxyKinds.indexOf(right))
          .map(kind => ref(`galaxy-kind/${encode(kind)}`, true))
      }
      if (category.id === 'layouts') return [...layouts.keys()].sort().map(layoutRef)
      if (category.id === 'asset-aliases')
        return [...assetAliases.keys()].sort().map(name => ref(`asset-alias/${encode(name)}`))
      if (category.id === 'editor-categories')
        return [...editorCategories.keys()].sort().map(editorCategoryRef)
      if (category.id === 'font-styles')
        return ['styles', 'constants', 'font-groups']
          .filter(section =>
            section === 'styles'
              ? fontStyles?.styles.size
              : section === 'constants'
                ? fontStyles?.constants.size
                : fontStyles?.fontGroups.size,
          )
          .map(styleSectionRef)
      return []
    }
    if (parts[0] === 'galaxy-kind') {
      indexGalaxy()
      return galaxyByKind.get(decode(parts[1] ?? '')) ?? []
    }
    if (parts[0] === 'galaxy-symbol') {
      indexGalaxy()
      return galaxyNodes.get(node.id)?.children ?? []
    }
    if (parts[0] === 'layout') {
      const path = decode(parts[1] ?? '')
      const layout = layouts.get(path)
      if (layout === undefined) return []
      return (['frames', 'templates', 'constants', 'includes'] as const)
        .filter(section => layout[section].length > 0)
        .map(section => layoutSectionRef(path, section))
    }
    if (parts[0] === 'layout-section') {
      const path = decode(parts[1] ?? '')
      const section = parts[2] as 'frames' | 'templates' | 'constants' | 'includes'
      const items = layouts.get(path)?.[section]
      return items === undefined
        ? []
        : Array.from({ length: items.length }, (_item, index) =>
            section === 'frames'
              ? layoutFrameRef(
                  path,
                  [index],
                  layouts.get(path)?.frames[index] === undefined
                    ? false : layoutFrameHasChildren(layouts.get(path)!.frames[index]!),
                )
              : layoutItemRef(path, section, index),
          )
    }
    if (parts[0] === 'layout-frame') {
      const path = decode(parts[1] ?? '')
      const indices = parts.slice(2).map(Number)
      const frames = (layoutFrameAt(path, indices)?.children ?? []).map((frame, index) =>
        layoutFrameRef(path, [...indices, index], layoutFrameHasChildren(frame)),
      )
      try {
        const properties = resolvedLayoutFrameAt(path, indices)?.properties
        return [...frames, ...[...(properties?.keys() ?? [])].sort()
          .map(key => layoutPropertyRef(path, indices, key))]
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return [...frames, ref(`layout-error/${encode(path)}/${indices.join('.')}/${encode(message)}`)]
      }
    }
    if (parts[0] === 'style-section') {
      const section = parts[1]
      const entries =
        section === 'styles'
          ? fontStyles?.styles
          : section === 'constants'
            ? fontStyles?.constants
            : fontStyles?.fontGroups
      return [...(entries?.keys() ?? [])].sort().map(name => styleItemRef(section ?? '', name))
    }
    if (parts[0] === 'style-item' && parts[1] === 'styles') {
      const name = decode(parts[2] ?? '')
      return Object.keys(resolveTextStyle(fontStyles!, name)?.attrs ?? {}).sort()
        .map(attribute => styleAttributeRef(name, attribute))
    }
    if (parts[0] === 'editor-category') {
      const name = decode(parts[1] ?? '')
      return Array.from({ length: editorCategories.get(name)?.length ?? 0 }, (_value, index) =>
        editorValueRef(name, index),
      )
    }
    if (parts[0] === 'filetype') {
      const type = decode(parts[1] ?? '')
      return [
        ...folderChildren(type, ownLayer, ''),
        ...(dependencyLayersWith(type).length === 0 ? [] : [ref(`filedeps/${encode(type)}`, true)]),
      ]
    }
    if (parts[0] === 'filedeps') {
      const type = decode(parts[1] ?? '')
      return dependencyLayersWith(type).map(layer => folderRef(type, layer, '', ''))
    }
    if (parts[0] === 'folder') {
      return folderChildren(decode(parts[1] ?? ''), Number(parts[2]), decode(parts[4] ?? ''))
    }
    if (parts[0] === 'namespace') {
      const namespace = decode(parts[1] ?? '')
      const all = (
        namespace === 'Const' ? (constants.get('Const') ?? []) : entities(namespace)
      ) as readonly { readonly id?: string }[]
      /*
       * A catalog's declaration defaults — `<CAlert default="1">` with no id — are entities of the
       * data space, and the count includes them. Dropping them silently left a namespace that
       * reads «1» and opens to nothing, which is how Accumulator and Achievement looked.
       */
      const defaults = all.filter(entity => typeof entity.id !== 'string' || entity.id === '')
      return [
        ...(defaults.length === 0 && (input.mod.structureDefaults?.(namespace).size ?? 0) === 0
          ? [] : [defaultsRef(namespace)]),
        ...((constants.get(namespace)?.length ?? 0) === 0 || namespace === 'Const'
          ? []
          : [constantsRef(namespace)]),
        ...(hasEditorCategories(namespace) ? [ref(`editor-groups/${encode(namespace)}`, true)] : []),
        ...all
          .filter(entity => typeof entity.id === 'string' && entity.id !== '')
          .map(entity => entityRef(namespace, entity.id as string)),
      ]
    }
    if (parts[0] === 'editor-groups') {
      const namespace = decode(parts[1] ?? '')
      return [...editorGroupsOf(namespace).keys()].map(key => ref(`editor-group/${encode(namespace)}/${encode(key)}`, true))
    }
    if (parts[0] === 'editor-group') {
      const namespace = decode(parts[1] ?? '')
      return (editorGroupsOf(namespace).get(decode(parts[2] ?? '')) ?? []).map(id => entityRef(namespace, id))
    }
    if (parts[0] === 'entity' || parts[0] === 'field') {
      const namespace = decode(parts[1] ?? '')
      const id = decode(parts[2] ?? '')
      const path = parts[0] === 'field' ? parts.slice(3).map(decode) : []
      const value = fieldValue(namespace, id, path)
      if (value === null || typeof value !== 'object') return []
      return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => fieldRef(namespace, id, [...path, key], child))
    }
    if (parts[0] === 'defaults') {
      const namespace = decode(parts[1] ?? '')
      return [
        ...defaultClasses(namespace).map(className => defaultRef(namespace, className)),
        ...[...(input.mod.structureDefaults?.(namespace) ?? new Map())]
          .map(([type, value]) => structureDefaultRef(namespace, type, value)),
      ]
    }
    if (parts[0] === 'default' || parts[0] === 'default-field') {
      const namespace = decode(parts[1] ?? '')
      const className = decode(parts[2] ?? '')
      const path = parts[0] === 'default-field' ? parts.slice(3).map(decode) : []
      const value = defaultValue(namespace, className, path)
      if (value === null || typeof value !== 'object') return []
      return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => defaultFieldRef(namespace, className, [...path, key], child))
    }
    if (parts[0] === 'structure-default' || parts[0] === 'structure-field') {
      const namespace = decode(parts[1] ?? '')
      const type = decode(parts[2] ?? '')
      const path = parts[0] === 'structure-field' ? parts.slice(3).map(decode) : []
      const value = structureValue(namespace, type, path)
      if (value === null || typeof value !== 'object') return []
      return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => structureFieldRef(namespace, type, [...path, key], child))
    }
    if (parts[0] === 'constants') {
      const namespace = decode(parts[1] ?? '')
      return (constants.get(namespace) ?? [])
        .filter(entity => entity.id)
        .map(entity => constantRef(namespace, entity.id))
    }
    if (parts[0] === 'locale') {
      const locale = decode(parts[1] ?? '')
      return [...(input.mod.locales.get(locale)?.keys() ?? [])]
        .sort()
        .map(catalog => stringCatalogRef(locale, catalog))
    }
    if (parts[0] === 'strings') {
      const locale = decode(parts[1] ?? '')
      const catalog = decode(parts[2] ?? '')
      return stringGroups(locale, catalog).map(group => stringGroupRef(locale, catalog, group))
    }
    if (parts[0] === 'stringgroup') {
      const locale = decode(parts[1] ?? '')
      const catalog = decode(parts[2] ?? '')
      const group = decode(parts.slice(3).join('/'))
      return stringKeysIn(locale, catalog, group).map(key => stringRef(locale, catalog, key))
    }
    return []
  }

  const facts = (node: TreeNodeRef): TreeNodeFacts => {
    if (node.id === 'root')
      return Object.freeze({
        kind: 'resources',
        label: 'Resources',
        preview: `${resourcePaths.length} files`,
      })
    const parts = node.id.split('/')
    if (parts[0] === 'category') {
      const category = categoryById.get(parts[1] ?? '')
      if (category === undefined) throw new TypeError(`unknown resource category ${node.id}`)
      const count = categoryCount(category)
      // This count describes this package only. The chain labels sums as declarations because
      // overrides can make them differ from effective resource counts.
      return Object.freeze({
        kind: category.kind,
        label: category.label,
        preview: category.id === 'strings'
          ? `${input.mod.locales.size} locales · ${count} keys`
          : category.id === 'galaxy' ? `${count} files`
          : category.id === 'font-styles' ? `${count} styles` : String(count),
        value: count,
      })
    }
    if (parts[0] === 'filetype') {
      const type = decode(parts[1] ?? '')
      const count = typeCount(type)
      if (count === 0) throw new TypeError(`unknown resource file type ${type}`)
      return Object.freeze({ kind: 'file-type', label: type, preview: String(count) })
    }
    if (parts[0] === 'filedeps') {
      const type = decode(parts[1] ?? '')
      const count = dependencyLayersWith(type).reduce((sum, layer) => sum + pathsOf(layer, type).length, 0)
      return Object.freeze({ kind: 'file-dependencies', label: 'From dependencies', preview: String(count) })
    }
    if (parts[0] === 'folder') {
      const type = decode(parts[1] ?? '')
      const layer = Number(parts[2])
      const path = decode(parts[4] ?? '')
      const folder = folderAt(type, layer, path)
      if (folder === undefined) throw new TypeError(`unknown resource folder ${node.id}`)
      return path === ''
        ? Object.freeze({ kind: 'file-source', label: fileLayers[layer]?.label ?? '', preview: String(folder.count) })
        : Object.freeze({ kind: 'folder', label: path.slice(Number(parts[3])), preview: String(folder.count) })
    }
    if (parts[0] === 'layerfile') {
      const layer = fileLayers[Number(parts[1])]
      const path = decode(parts.slice(2).join('/'))
      if (layer === undefined) throw new TypeError(`unknown resource file ${node.id}`)
      return Object.freeze({
        kind: 'file',
        label: path.slice(path.lastIndexOf('/') + 1),
        preview: `${path} · ${layer.label}`,
        subjectId: sc2NamespaceEntrySubjectId(layer.root, path),
      })
    }
    if (parts[0] === 'galaxy-kind') {
      indexGalaxy()
      const kind = decode(parts[1] ?? '')
      const count = galaxyByKind.get(kind)?.length ?? 0
      return Object.freeze({
        kind: 'script-symbol-kind',
        label: galaxyKindLabel(kind),
        preview: String(count),
        value: count,
      })
    }
    if (parts[0] === 'galaxy-symbol') {
      indexGalaxy()
      const item = galaxyNodes.get(node.id)
      if (item === undefined) throw new TypeError(`unknown Galaxy symbol ${node.id}`)
      const offset = item.symbol.selectionStart
      const lineStart = offset === undefined ? -1 : item.text.lastIndexOf('\n', offset - 1) + 1
      const line = offset === undefined ? -1 : item.text.slice(0, offset).split('\n').length - 1
      return Object.freeze({
        kind: `galaxy-${item.symbol.kind}`,
        label: item.symbol.name,
        // The Galaxy owner supplies declaration text; do not evaluate an initializer as live state.
        preview: item.symbol.declaration ?? item.symbol.detail ?? item.path,
        subjectId: fileSubject(item.path),
        ...(offset === undefined
          ? {}
          : {
              range: Object.freeze({
                utf16Offset: offset,
                utf16Length: item.symbol.name.length,
                line,
                column: offset - lineStart,
              }),
            }),
      })
    }
    if (parts[0] === 'layout') {
      const path = decode(parts[1] ?? '')
      const layout = layouts.get(path)
      if (layout === undefined) throw new TypeError(`unknown layout ${path}`)
      return Object.freeze({
        kind: 'layout-file',
        label: path.split('/').at(-1) ?? path,
        preview: `${layout.frames.length} frames · ${path}`,
        subjectId: fileSubject(path),
      })
    }
    if (parts[0] === 'layout-section') {
      const path = decode(parts[1] ?? '')
      const section = parts[2] as 'frames' | 'templates' | 'constants' | 'includes'
      const count = layouts.get(path)?.[section]?.length ?? 0
      return Object.freeze({
        kind: 'layout-section',
        label: section[0]!.toUpperCase() + section.slice(1),
        preview: String(count),
        value: count,
      })
    }
    if (parts[0] === 'layout-item') {
      const path = decode(parts[1] ?? '')
      const section = parts[2] as 'frames' | 'templates' | 'constants' | 'includes'
      const item = layouts.get(path)?.[section]?.[Number(parts[3])]
      if (item === undefined) throw new TypeError(`unknown layout item ${node.id}`)
      const label = typeof item === 'string' ? item : item.name
      const preview =
        typeof item === 'string'
          ? path
          : 'val' in item
            ? item.val
            : 'type' in item
              ? item.type
              : path
      return Object.freeze({
        kind: `layout-${section}`,
        label,
        preview,
        subjectId: fileSubject(path),
      })
    }
    if (parts[0] === 'layout-frame') {
      const path = decode(parts[1] ?? '')
      const frame = layoutFrameAt(path, parts.slice(2).map(Number))
      if (frame === undefined) throw new TypeError(`unknown layout frame ${node.id}`)
      return Object.freeze({
        kind: 'layout-frame',
        label: frame.name,
        preview: frame.type,
        subjectId: fileSubject(path),
      })
    }
    if (parts[0] === 'layout-property') {
      const path = decode(parts[1] ?? '')
      const indices = (parts[2] ?? '').split('.').map(Number)
      const key = decode(parts[3] ?? '')
      const property = resolvedLayoutFrameAt(path, indices)?.properties.get(key)
      if (property === undefined) throw new TypeError(`unknown resolved layout property ${node.id}`)
      const raw = property.val ?? JSON.stringify(property.attrs)
      const value = layoutResolver?.value(raw) ?? raw
      return Object.freeze({
        kind: 'layout-property', label: property.tag, preview: value, value,
        subjectId: fileSubject(property.source.uri),
        semanticPath: [path, ...indices.map(String), key],
      })
    }
    if (parts[0] === 'data-error') {
      const malformed = malformedCatalogs[Number(parts[1])]
      if (malformed === undefined) throw new TypeError(`unknown data error ${node.id}`)
      const root = input.rootForMod?.(malformed.mod)
      return Object.freeze({ kind: 'data-diagnostic', label: `Malformed XML: ${malformed.path}`,
        preview: malformed.message,
        subjectId: root === undefined ? fileSubject(malformed.path)
          : sc2NamespaceEntrySubjectId(root, malformed.path) })
    }
    if (parts[0] === 'layout-error') {
      return Object.freeze({ kind: 'layout-diagnostic', label: 'Resolution incomplete',
        preview: decode(parts[3] ?? ''), subjectId: fileSubject(decode(parts[1] ?? '')) })
    }
    if (parts[0] === 'editor-groups') {
      return Object.freeze({ kind: 'editor-category-groups', label: 'By editor category' })
    }
    if (parts[0] === 'editor-group') {
      const key = decode(parts[2] ?? '')
      const ids = editorGroupsOf(decode(parts[1] ?? '')).get(key)
      if (ids === undefined) throw new TypeError(`unknown editor category group ${node.id}`)
      return Object.freeze({ kind: 'editor-category-group', label: key || 'Uncategorized', preview: String(ids.length) })
    }
    if (parts[0] === 'preload') {
      const row = preload()[Number(parts[1])]
      if (row === undefined) throw new TypeError(`unknown preload entry ${node.id}`)
      return Object.freeze({
        kind: 'preload-entry',
        label: row.tag,
        preview: row.name,
        subjectId: fileSubject(row.path),
        range: row.range,
      })
    }
    if (parts[0] === 'asset-alias') {
      indexLayeredOrigins()
      const name = decode(parts[1] ?? '')
      const path = assetAliases.get(name)
      if (path === undefined) throw new TypeError(`unknown asset alias ${name}`)
      const subjectId = sourceOf(aliasOrigins.get(name))
      return Object.freeze({ kind: 'asset-alias', label: name, preview: path,
        ...(subjectId === undefined ? {} : { subjectId }) })
    }
    if (parts[0] === 'editor-category') {
      indexLayeredOrigins()
      const name = decode(parts[1] ?? '')
      const values = editorCategories.get(name)
      if (values === undefined) throw new TypeError(`unknown editor category ${name}`)
      const subjectId = sourceOf(editorOrigins.get(name))
      return Object.freeze({
        kind: 'editor-category',
        label: name,
        preview: String(values.length),
        value: values.length,
        ...(subjectId === undefined ? {} : { subjectId }),
      })
    }
    if (parts[0] === 'editor-value') {
      indexLayeredOrigins()
      const name = decode(parts[1] ?? '')
      const value = editorCategories.get(name)?.[Number(parts[2])]
      if (value === undefined) throw new TypeError(`unknown editor category value ${node.id}`)
      const subjectId = sourceOf(editorValueOrigins.get(`${name}\0${value}`))
      return Object.freeze({ kind: 'editor-value', label: value, preview: name,
        ...(subjectId === undefined ? {} : { subjectId }) })
    }
    if (parts[0] === 'style-section') {
      const section = parts[1]
      const count =
        section === 'styles'
          ? fontStyles?.styles.size
          : section === 'constants'
            ? fontStyles?.constants.size
            : fontStyles?.fontGroups.size
      return Object.freeze({
        kind: 'style-section',
        label:
          section === 'font-groups' ? 'Font groups' : section === 'styles' ? 'Styles' : 'Constants',
        preview: String(count ?? 0),
        value: count ?? 0,
      })
    }
    if (parts[0] === 'style-item') {
      indexLayeredOrigins()
      const section = parts[1]
      const name = decode(parts[2] ?? '')
      const item =
        section === 'styles'
          ? fontStyles?.styles.get(name)
          : section === 'constants'
            ? fontStyles?.constants.get(name)
            : fontStyles?.fontGroups.get(name)
      if (item === undefined) throw new TypeError(`unknown font style ${node.id}`)
      const resolved = section === 'styles' ? resolveTextStyle(fontStyles!, name) : undefined
      const constant = section === 'constants' ? resolveTextConstant(fontStyles!, name) : undefined
      const preview = section === 'constants'
        ? constant ?? String(item)
        : resolved === undefined
          ? typeof item === 'string' ? item : (item.attrs['template'] ?? item.attrs['font'] ?? '')
          : Object.entries(resolved.attrs).slice(0, 3).map(([key, value]) => `${key}=${value}`).join(' · ')
      const subjectId = sourceOf(styleOrigins.get(`${section}\0${name}`))
      return Object.freeze({
        kind: `font-${section}`,
        label: name,
        ...(preview === '' ? {} : { preview }),
        ...(resolved === undefined ? {} : { value: resolved.attrs }),
        ...(constant === undefined ? {} : { value: constant }),
        ...(subjectId === undefined ? {} : { subjectId }),
      })
    }
    if (parts[0] === 'style-attribute') {
      indexLayeredOrigins()
      const name = decode(parts[1] ?? '')
      const attribute = decode(parts[2] ?? '')
      const value = resolveTextStyle(fontStyles!, name)?.attrs[attribute]
      if (value === undefined) throw new TypeError(`unknown style attribute ${node.id}`)
      const subjectId = sourceOf(styleOrigins.get(`styles\0${name}`))
      return Object.freeze({ kind: 'style-attribute', label: attribute, preview: value, value,
        ...(subjectId === undefined ? {} : { subjectId }) })
    }
    if (parts[0] === 'namespace') {
      const namespace = decode(parts[1] ?? '')
      const summary = namespaceByName.get(namespace)
      if (summary === undefined) throw new TypeError(`unknown data namespace ${namespace}`)
      return Object.freeze({
        kind: 'data-namespace',
        label: namespace,
        preview: `${summary.total} · ${summary.own} own${namespace === 'Const' ? '' : ` · ${constants.get(namespace)?.length ?? 0} constants`}`,
        value:
          summary.total + (namespace === 'Const' ? 0 : (constants.get(namespace)?.length ?? 0)),
      })
    }
    if (parts[0] === 'constants') {
      const namespace = decode(parts[1] ?? '')
      const count = constants.get(namespace)?.length ?? 0
      return Object.freeze({
        kind: 'data-constants',
        label: 'Constants',
        preview: String(count),
        value: count,
      })
    }
    if (parts[0] === 'constant') {
      const namespace = decode(parts[1] ?? '')
      const id = decode(parts[2] ?? '')
      const entity = constants.get(namespace)?.find(item => item.id === id)
      if (entity === undefined) throw new TypeError(`unknown constant ${node.id}`)
      const declaration = declarationsOf('Const').get(`entity/${id}`)
      const data = entity.data as Record<string, unknown>
      // Catalog constants carry XML strings, including empty strings; missing is not empty.
      const value = data['value']
      return Object.freeze({
        kind: 'data-constant',
        label: id,
        preview: [data['path'], data['value']].filter(value => value !== undefined).join(' = '),
        ...(typeof value === 'string' ? { value } : {}),
        ...(declaration === undefined
          ? {}
          : {
              subjectId: fileSubject(declaration.path),
              range: Object.freeze({
                utf16Offset: declaration.utf16Offset,
                utf16Length: declaration.utf16Length,
                line: declaration.line,
                column: declaration.column,
              }),
            }),
      })
    }
    if (parts[0] === 'defaults') {
      const namespace = decode(parts[1] ?? '')
      const count = defaultClasses(namespace).length +
        (input.mod.structureDefaults?.(namespace).size ?? 0)
      return Object.freeze({
        kind: 'data-defaults',
        label: 'Defaults',
        preview: String(count),
        value: count,
      })
    }
    if (parts[0] === 'default') {
      const namespace = decode(parts[1] ?? '')
      const className = decode(parts[2] ?? '')
      if (!defaultClasses(namespace).includes(className))
        throw new TypeError(`unknown default ${node.id}`)
      const declaration = declarationsOf(namespace).get(`${DEFAULT_KEY_PREFIX}${className}`)
      return Object.freeze({
        kind: 'data-default',
        label: className,
        preview: declaration?.path ?? namespace,
        ...(declaration === undefined
          ? {}
          : {
              subjectId: fileSubject(declaration.path),
              range: Object.freeze({
                utf16Offset: declaration.utf16Offset,
                utf16Length: declaration.utf16Length,
                line: declaration.line,
                column: declaration.column,
              }),
            }),
      })
    }
    if (parts[0] === 'default-field') {
      const namespace = decode(parts[1] ?? '')
      const className = decode(parts[2] ?? '')
      const path = parts.slice(3).map(decode)
      const value = defaultValue(namespace, className, path)
      if (value === undefined) throw new TypeError(`unknown default field ${node.id}`)
      const scalar = typeof value === 'string'
      const declaration = facts(defaultRef(namespace, className))
      return Object.freeze({
        kind: 'data-default-field',
        label: path.at(-1) ?? '',
        preview: scalar ? value : Array.isArray(value)
          ? `${value.length} items` : `${Object.keys(value as object).length} fields`,
        ...(scalar ? { value } : {}),
        semanticPath: [namespace, className, ...path],
        ...(declaration.subjectId === undefined ? {} : { subjectId: declaration.subjectId }),
        ...(declaration.range === undefined ? {} : { range: declaration.range }),
      })
    }
    if (parts[0] === 'structure-default' || parts[0] === 'structure-field') {
      const namespace = decode(parts[1] ?? '')
      const type = decode(parts[2] ?? '')
      const path = parts[0] === 'structure-field' ? parts.slice(3).map(decode) : []
      const value = structureValue(namespace, type, path)
      if (value === undefined) throw new TypeError(`unknown structure default ${node.id}`)
      const scalar = typeof value === 'string'
      return Object.freeze({
        kind: parts[0] === 'structure-default' ? 'data-structure-default' : 'data-structure-field',
        label: path.at(-1) ?? type,
        preview: scalar ? value : Array.isArray(value)
          ? `${value.length} items` : `${Object.keys(value as object).length} fields`,
        ...(scalar ? { value } : {}),
        semanticPath: [namespace, type, ...path],
      })
    }
    if (parts[0] === 'entity') {
      const namespace = decode(parts[1] ?? '')
      const id = decode(parts[2] ?? '')
      const entity = entityById(namespace, id)
      const source = entity?.sources?.at(-1) ?? entity?.source
      // The entity's name beside its id, `↑` when only a dependency declares it (as MK2's tree did).
      const inherited = ownModPath !== undefined && entity !== undefined && !isOwnEntity(entity, ownModPath)
      const named = [inherited ? '↑' : '', entityName(namespace, id)].filter(Boolean).join(' ')
      const described = (where?: string) => {
        const preview = [named, where].filter(Boolean).join(' · ')
        return preview === '' ? {} : { preview }
      }
      // Opening an entity shows its card (parity plan 5.29); the document that declares it is the
      // node's declaration, for "Go to declaration". An entity only a dependency declares has none here.
      const card = { kind: namespace, label: id, subjectId: entitySubjectId(namespace, id) }
      if (source !== undefined && input.rootForMod !== undefined) {
        const root = input.rootForMod(source.mod)
        if (root !== undefined) return Object.freeze({
          ...card,
          ...described(`${source.file} · ${source.mod}`),
          declaration: Object.freeze({
            subjectId: sc2NamespaceEntrySubjectId(root, source.file),
            ...(source.line === undefined ? {} : { range: Object.freeze({
              utf16Offset: 0, utf16Length: 0, line: Math.max(0, source.line - 1), column: 0,
            }) }),
          }),
        })
      }
      const declaration = declarationsOf(namespace).get(`entity/${id}`)
      if (declaration === undefined) return Object.freeze({ ...card, ...described() })
      return Object.freeze({
        ...card,
        ...described(declaration.path),
        declaration: Object.freeze({
          subjectId: fileSubject(declaration.path),
          range: Object.freeze({
            utf16Offset: declaration.utf16Offset,
            utf16Length: declaration.utf16Length,
            line: declaration.line,
            column: declaration.column,
          }),
        }),
      })
    }
    if (parts[0] === 'field') {
      const namespace = decode(parts[1] ?? '')
      const id = decode(parts[2] ?? '')
      const path = parts.slice(3).map(decode)
      const value = fieldValue(namespace, id, path)
      if (value === undefined) throw new TypeError(`unknown resolved field ${node.id}`)
      const scalar = typeof value === 'string'
      const declaration = facts(entityRef(namespace, id))
      return Object.freeze({
        kind: 'data-field',
        label: path.at(-1) ?? '',
        preview: scalar ? value : Array.isArray(value)
          ? `${value.length} items` : `${Object.keys(value as object).length} fields`,
        ...(scalar ? { value } : {}),
        semanticPath: [namespace, id, ...path],
        ...(declaration.subjectId === undefined ? {} : { subjectId: declaration.subjectId }),
        ...(declaration.range === undefined ? {} : { range: declaration.range }),
      })
    }
    if (parts[0] === 'locale') {
      const locale = decode(parts[1] ?? '')
      const catalogs = input.mod.locales.get(locale)
      const count = [...(catalogs?.values() ?? [])].reduce((sum, values) => sum + values.size, 0)
      const label = /^[a-z]{4}$/iu.test(locale)
        ? `${locale.slice(0, 2).toLowerCase()}${locale.slice(2).toUpperCase()}`
        : locale
      return Object.freeze({ kind: 'locale', label, preview: String(count) })
    }
    if (parts[0] === 'strings') {
      const locale = decode(parts[1] ?? '')
      const catalog = decode(parts[2] ?? '')
      return Object.freeze({
        kind: 'string-catalog',
        label: catalog,
        preview: String(input.mod.locales.get(locale)?.get(catalog)?.size ?? 0),
      })
    }
    if (parts[0] === 'stringgroup') {
      const locale = decode(parts[1] ?? '')
      const catalog = decode(parts[2] ?? '')
      const group = decode(parts.slice(3).join('/'))
      return Object.freeze({
        kind: 'string-group',
        label: group,
        preview: String(stringKeysIn(locale, catalog, group).length),
      })
    }
    if (parts[0] === 'string') {
      const locale = decode(parts[1] ?? '')
      const catalog = decode(parts[2] ?? '')
      const key = decode(parts.slice(3).join('/'))
      const preview = input.mod.locales.get(locale)?.get(catalog)?.get(key)
      const declaration = stringDeclarationsOf(locale, catalog).get(key)
      return Object.freeze({
        kind: 'string',
        label: key,
        ...(preview === undefined ? {} : { preview }),
        ...(declaration === undefined
          ? {}
          : {
              subjectId: declaration.root === undefined
                ? fileSubject(declaration.path)
                : sc2NamespaceEntrySubjectId(declaration.root, declaration.path),
              range: Object.freeze({
                utf16Offset: declaration.utf16Offset,
                utf16Length: declaration.utf16Length,
                line: declaration.line,
                column: declaration.column,
              }),
            }),
      })
    }
    if (parts[0] === 'file') {
      const path = decode(parts.slice(1).join('/'))
      // A loaded file is addressed by the reader's normalized path; the namespace entry that
      // carries its size may be spelled differently, and its absence is not a missing resource.
      const entry = fileByPath.get(path) ?? entryByLowerPath.get(path.toLowerCase())
      const size = entry?.size ?? input.files.get(path)?.byteLength
      if (entry === undefined && !input.files.has(path) && !resourcePathSet.has(path)) {
        throw new TypeError(`unknown resource file ${path}`)
      }
      const cut = path.lastIndexOf('/')
      return Object.freeze({
        kind: 'file',
        label: cut === -1 ? path : path.slice(cut + 1),
        preview: size === undefined ? path : `${path} · ${String(size)} bytes`,
        subjectId: fileSubject(path),
      })
    }
    if (parts[0] === 'dependency') {
      const index = Number(parts[1])
      const link = chain[index]
      if (link === undefined) throw new TypeError(`unknown dependency ${node.id}`)
      const parsed = parseDependency(link.path)
      return Object.freeze({
        kind: 'dependency',
        label: parsed.name,
        preview: `${index + 1}. ${link.path}${link.basis === 'declared' ? '' : ` · ${link.basis}`}`,
        // A loaded dependency opens as its own package, as MK2 opened its card (parity plan 5.29);
        // without the package a declared one opens the DocumentInfo that declares it, an
        // engine-implicit one opens nothing rather than a file that does not say it.
        ...(link.subjectId !== undefined
          ? { subjectId: link.subjectId }
          : link.basis === 'declared' && documentInfoPath !== undefined
            ? { subjectId: fileSubject(documentInfoPath) }
            : {}),
      })
    }
    throw new TypeError(`unknown resource node ${node.id}`)
  }

  const source: TreeDataSource = Object.freeze({
    async root() {
      return ref('root', true)
    },
    async children(node: TreeNodeRef, page: PageRequest, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return resourcePage(children(node), page.cursor, page.limit)
    },
    async facts(node: TreeNodeRef) {
      return facts(node)
    },
    async *search(query: TreeQuery, signal?: AbortSignal) {
      const needle = query.pattern.toLocaleLowerCase()
      const pending: TreeNodeRef[] = [ref('root', true)]
      let authoredContentMayMatch: boolean | undefined
      const mayMatchAuthoredContent = (): boolean => {
        if (authoredContentMayMatch !== undefined) return authoredContentMayMatch
        if (needle.length < 3 || /[\r\n\\"]/u.test(needle)) return (authoredContentMayMatch = true)
        for (const [path, bytes] of input.files) {
          signal?.throwIfAborted()
          if (path.toLocaleLowerCase().includes(needle) || utf8.decode(bytes).toLocaleLowerCase().includes(needle))
            return (authoredContentMayMatch = true)
        }
        for (const source of layeredSources) {
          signal?.throwIfAborted()
          if (utf8.decode(source.bytes).toLocaleLowerCase().includes(needle))
            return (authoredContentMayMatch = true)
        }
        // A later file with the same path can patch, not replace, an earlier Data declaration.
        // The reader has already merged those; include the underlying entries in the guard.
        for (const namespace of input.mod.namespaces()) {
          for (const entity of entities(namespace)) {
            signal?.throwIfAborted()
            if (JSON.stringify([entity.id, entity.data, entity.tokens, entity.source, entity.sources])
              .toLocaleLowerCase().includes(needle) ||
              // A name is matched without its markup, which the raw strings above still carry.
              entityName(namespace, entity.id ?? '').toLocaleLowerCase().includes(needle))
              return (authoredContentMayMatch = true)
          }
        }
        return (authoredContentMayMatch = false)
      }
      /** Whether the term is in one of these loaded files, by path or text. */
      const filesMayMatch = (paths: Iterable<string>): boolean => {
        if (needle.length < 3 || /[\r\n\\"]/u.test(needle)) return true
        for (const path of paths) {
          signal?.throwIfAborted()
          if (path.toLocaleLowerCase().includes(needle)) return true
          const text = fileText(input.files, path)
          if (text !== undefined && text.toLocaleLowerCase().includes(needle)) return true
        }
        return false
      }
      let rawFieldsMayMatch: boolean | undefined
      const mayMatchFields = (): boolean => {
        if (rawFieldsMayMatch !== undefined) return rawFieldsMayMatch
        // Effective fields inherit and substitute authored values. If the term is absent from
        // every authored entity and structure default, resolving every entity cannot add a
        // matching field label or ordinary value. Avoid filling the entire resolved cache for a
        // miss; common searches still inspect the calculated values of matching candidates.
        if (needle.length < 3 || /[\r\n\\"]/u.test(needle)) return (rawFieldsMayMatch = true)
        for (const namespace of input.mod.namespaces()) {
          for (const entity of entities(namespace)) {
            signal?.throwIfAborted()
            if (JSON.stringify([entity.id, entity.data, entity.tokens]).toLocaleLowerCase().includes(needle))
              return (rawFieldsMayMatch = true)
          }
          for (const value of input.mod.structureDefaults?.(namespace).values() ?? []) {
            if (JSON.stringify(value).toLocaleLowerCase().includes(needle))
              return (rawFieldsMayMatch = true)
          }
        }
        return (rawFieldsMayMatch = false)
      }
      function* matchingFields(namespace: string, id: string, value: object,
        path: readonly string[] = []): Generator<TreeNodeRef> {
        for (const [key, child] of Object.entries(value)) {
          const nextPath = [...path, key]
          const preview = typeof child === 'string' ? child : Array.isArray(child)
            ? `${child.length} items` : child === null ? '' : `${Object.keys(child as object).length} fields`
          if (`${key}\n${preview}`.toLocaleLowerCase().includes(needle))
            yield fieldRef(namespace, id, nextPath, child)
          if (child !== null && typeof child === 'object')
            yield* matchingFields(namespace, id, child, nextPath)
        }
      }
      // An entity whose id or name is the term comes first, then one they start with, then the walk
      // in tree order: a reader caps the hits, and the 200 of «SCV» filled up on Abil, Actor and
      // Button before the walk reached Unit SCV.
      const ranked = new Set<string>()
      if (needle !== '') {
        const prefixed: TreeNodeRef[] = []
        for (const { ns } of namespaces) {
          const all = (ns === 'Const' ? (constants.get('Const') ?? []) : entities(ns)) as readonly { readonly id?: string }[]
          for (const entity of all) {
            signal?.throwIfAborted()
            if (typeof entity.id !== 'string' || entity.id === '') continue
            const id = entity.id.toLocaleLowerCase()
            const name = entityName(ns, entity.id).toLocaleLowerCase()
            if (id === needle || name === needle) {
              const node = entityRef(ns, entity.id)
              ranked.add(node.id)
              yield node
            } else if (id.startsWith(needle) || name.startsWith(needle)) prefixed.push(entityRef(ns, entity.id))
          }
        }
        for (const node of prefixed) {
          ranked.add(node.id)
          yield node
        }
      }
      // The walk is synchronous work between results; it gives the thread back now and then, so a
      // host serving the tree from this thread still answers the expansions queued behind it.
      let workingSince = Date.now()
      while (pending.length > 0) {
        signal?.throwIfAborted()
        if (Date.now() - workingSince > 50) {
          await new Promise(resolve => setTimeout(resolve, 0))
          workingSince = Date.now()
        }
        const node = pending.pop() as TreeNodeRef
        const parts = node.id.split('/')
        if (parts[0] === 'entity') {
          const namespace = decode(parts[1] ?? '')
          const id = decode(parts[2] ?? '')
          const entity = entityById(namespace, id)
          const origin = entity?.sources?.at(-1) ?? entity?.source
          if (!ranked.has(node.id) &&
            `${id}\n${entityName(namespace, id)}\n${origin?.file ?? ''} · ${origin?.mod ?? ''}`.toLocaleLowerCase().includes(needle))
            yield node
          const value = mayMatchFields() ? input.mod.getResolved?.(namespace, id) : undefined
          if (value !== undefined && JSON.stringify(value).toLocaleLowerCase().includes(needle))
            yield* matchingFields(namespace, id, value)
          continue
        }
        if (parts[0] === 'stringgroup') {
          const locale = decode(parts[1] ?? '')
          const catalog = decode(parts[2] ?? '')
          const group = decode(parts.slice(3).join('/'))
          if (`${group}\n${stringKeysIn(locale, catalog, group).length}`.toLocaleLowerCase().includes(needle))
            yield node
          const values = input.mod.locales.get(locale)?.get(catalog)
          for (const key of stringKeysIn(locale, catalog, group)) {
            if (`${key}\n${values?.get(key) ?? ''}`.toLocaleLowerCase().includes(needle))
              yield stringRef(locale, catalog, key)
          }
          continue
        }
        // The groups repeat the namespace's own entities; walking them would find each twice.
        if (parts[0] === 'editor-groups') continue
        const value = facts(node)
        if (`${value.label}\n${value.preview ?? ''}`.toLocaleLowerCase().includes(needle))
          yield node
        if (parts[0] === 'category' && parts[1] !== 'files' &&
            parts[1] !== 'dependencies' && !mayMatchAuthoredContent()) continue
        // A layout's frames and their computed properties come from the layout files alone
        // (templates and constants included), and Galaxy symbols from the scripts: a term in none
        // of those files spares resolving every frame — 49 of 57 s of a Liberty search for a
        // model path that only Data names.
        if (parts[0] === 'category' && parts[1] === 'layouts' && !filesMayMatch(layouts.keys())) continue
        if (parts[0] === 'category' && parts[1] === 'galaxy' && !filesMayMatch(galaxyFiles.map(entry => entry.path))) continue
        // The same within Layouts, a file at a time: a term written in a template or a constant is
        // found where it is written, not again under every frame that inherits it (resolving every
        // frame of Liberty's layouts for a term some of them hold took 87 s).
        if (parts[0] === 'layout' && !filesMayMatch([decode(parts[1] ?? '')])) continue
        // Every row under Files shows a path, a part of one or a fixed label, so a term in none of
        // them spares the walk over every file of every loaded package.
        if (parts[0] === 'category' && parts[1] === 'files' && needle.length >= 3 &&
            ![...FILE_TYPES, 'From dependencies', ...fileLayers.map(layer => layer.label)]
              .some(label => label.toLocaleLowerCase().includes(needle)) &&
            !fileLayers.some(layer => layer.paths.some(path => path.toLocaleLowerCase().includes(needle)))) continue
        pending.push(...[...children(node)].reverse())
      }
    },
  })
  return source
}

export function modCardFacts(input: ModCardInput) {
  const fact = (
    id: string,
    label: string,
    value: JsonValue,
    extra: { locale?: string; note?: string; path?: readonly string[] } = {},
  ): SubjectFact =>
    Object.freeze({
      id,
      label,
      value,
      provenance: provenanceOf(input.root, extra.path ?? [id]),
      ...(extra.locale === undefined ? {} : { locale: extra.locale }),
      ...(extra.note === undefined ? {} : { note: extra.note }),
    }) as SubjectFact

  const identity: SubjectFact[] = []
  for (const entry of input.mod.documentHeader?.entries ?? []) {
    if (!entry.key.startsWith('DocInfo/')) continue
    const locale = entryLocale(entry.type)
    const key = entry.key.slice('DocInfo/'.length)
    const id = key === 'Name' ? 'name' : key === 'DescShort' ? 'description' : key
    identity.push(
      fact(id, key, entry.value, {
        ...(locale === undefined ? {} : { locale }),
        path: ['DocumentHeader', entry.key],
      }),
    )
  }
  const icon = /<Icon>\s*<Value>([^<]+)<\/Value>/iu
    .exec(fileText(input.files, 'DocumentInfo') ?? '')?.[1]
    ?.trim()
  if (icon !== undefined)
    identity.push(fact('icon', 'Icon', icon, { path: ['DocumentInfo', 'Icon'] }))
  // MK2's chips: the build the package was saved with and its header flags.
  const header = input.mod.documentHeader
  if (header?.timestamp1 !== undefined && header.timestamp1 > 0)
    identity.push(fact('build', 'Game build', header.timestamp1, { path: ['DocumentHeader', 'timestamp1'] }))
  if (header?.flags !== undefined)
    identity.push(fact('flags', 'Flags', `0x${header.flags.toString(16)}`, { path: ['DocumentHeader', 'flags'] }))

  const dependencies = input.dependencies.map((value, index) => {
    const parsed = parseDependency(value)
    return fact(
      `dependency-${index}`,
      parsed.name,
      {
        ...(parsed.bnetId === undefined ? {} : { 'Battle.net id': parsed.bnetId }),
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        ...(parsed.file === undefined ? {} : { file: parsed.file }),
      },
      { path: ['DocumentInfo', 'Dependencies', String(index)] },
    )
  })

  const componentText = fileText(input.files, 'ComponentList.SC2Components')
  const components = (
    componentText === undefined ? [] : parseComponentListEntries(componentText)
  ).map((component, index) =>
    fact(
      `component-${index}`,
      component.locale === undefined ? component.type : `${component.type} (${component.locale})`,
      component.path,
      { path: ['ComponentList.SC2Components', String(index)] },
    ),
  )

  const files = input.entries.filter(entry => entry.kind === 'file')
  const locales = [...input.mod.locales.keys()].sort()
  const total = input.namespaces.reduce((sum, item) => sum + item.total, 0)
  const own = input.namespaces.reduce((sum, item) => sum + item.own, 0)
  const counts: SubjectFact[] = [
    // A card read from the package alone has no inherited entities to count; saying "including
    // inherited" there was a claim about a chain nobody loaded (parity plan 5.27).
    ...(total === own
      ? []
      : [fact('entities', 'Entities', total, { note: 'Including entities inherited from dependencies' })]),
    fact('own-entities', 'Own entities', own),
    fact(
      'namespaces',
      'Data namespaces',
      input.namespaces.filter(item => item.own > 0).map(item => `${item.ns}: ${item.own}`),
    ),
    ...locales.map(locale => {
      const size = [...(input.mod.locales.get(locale)?.values() ?? [])].reduce(
        (sum, file) => sum + file.size,
        0,
      )
      return fact(`strings-${locale}`, `Strings (${locale})`, size)
    }),
    fact('assets', 'Asset files', files.filter(entry => ASSET.test(entry.path)).length),
    // Assets by family, as MK2's card listed them; the files themselves are under Resources → Files.
    ...['Images', 'Models', 'Audio', 'Fonts', 'Video'].flatMap(family => {
      const count = files.filter(entry => fileTypeOf(entry.path) === family).length
      return count === 0 ? [] : [fact(`assets-${family.toLowerCase()}`, family, count)]
    }),
    fact('files', 'Files', files.length),
  ]

  const relations: RelatedSubjectFact[] = []
  for (const pattern of MAIN_DOCUMENTS) {
    for (const entry of files) {
      if (!pattern.test(entry.path)) continue
      const subjectId = sc2NamespaceEntrySubjectId(input.root, entry.path) as string
      if (relations.some(item => item.subjectId === subjectId)) continue
      relations.push(
        Object.freeze({ role: 'Documents', subjectId, label: entry.path, kind: 'file' }),
      )
    }
  }
  const unitIds = input.namespaces.some(item => item.ns === 'Unit' && item.own > 0)
  if (unitIds) {
    for (const entity of input.mod.all('Unit') as readonly {
      readonly id: string
      readonly source?: { readonly mod?: string }
    }[]) {
      if (entity.id === '') continue
      relations.push(
        Object.freeze({
          role: 'Units',
          subjectId: entitySubjectId('Unit', entity.id),
          label: entity.id,
          kind: 'Unit',
        }),
      )
    }
  }
  // Dependency links are the package namespace's own (`depends-on`), published beside these.
  return {
    factGroups: [
      { id: 'overview', label: 'Mod', facts: identity },
      { id: 'mod-dependencies', label: 'Dependencies', facts: dependencies },
      { id: 'components', label: 'Components', facts: components },
      { id: 'mod-contents', label: 'Contents', facts: counts },
    ].filter(group => group.facts.length > 0),
    factRelations: relations,
    // A field of an entity card writes through this mod's own edit.field (plan 5.3).
    selector: modEntitySelector({ ...input, editOperation: 'edit.field' }),
  }
}
