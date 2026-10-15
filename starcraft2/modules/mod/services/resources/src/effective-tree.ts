/** The resource tree of one loaded mod, calculated over the loader's exact dependency chain. */
import type { AssetSourceRef, TreeDataSource } from '@modkit/sdk'
import { gameDataNamespaceSummaries, isSemanticModEntry, SC2ModReader,
  type ModParseResult } from '../../../shared/core/index.js'
import type { ResolvedMod } from '../../../shared/workspace/mod-context.js'
import type { Sc2ModContextLayer } from '../../../shared/workspace/mod-contexts.js'
import { parseLayout } from '../../../../layout/shared/layout-engine/sc2-layout-core/simple-parse/index.js'
import { MOD_DOCUMENT_ROUTES } from '../../../shared/core/document-routes.js'
import { modResourceTree, type ModCardEntry } from './mod-card.js'
import type { CatalogEntity, EntitySource } from '../../../../data/shared/catalog-engine/sc2-catalog/index.js'
import type { EngineCatalogEntries } from '../../../../data/services/catalog/engine-resolution.js'
import { layerRoot } from './layer-root.js'
export { layerRoot } from './layer-root.js'

const MAX_TEXT_BYTES = 32 * 1024 * 1024
const layoutFile = (path: string): boolean => /\.sc2layout$/iu.test(path)

export interface ChainReadCache {
  readonly bytes: Map<string, Promise<Uint8Array>>
  readonly parsed: Map<string, ModParseResult>
}

/**
 * A mod chain read into one canonical SC2 mod, dependencies first: the catalog-engine view of the
 * layers the loader resolved. `lists` holds each layer's listed files in `order`.
 */
export async function readChainMod(
  order: readonly string[],
  lists: readonly (readonly string[])[],
  readFile: (base: string, path: string) => Promise<Uint8Array | undefined>,
  cache: ChainReadCache,
  /** False when the chain's server holds the catalogs: the reader then reads no GameData XML. */
  catalogs = true,
) {
  const byBase = new Map(order.map((path, index) => [path.toLowerCase(), index]))
  const bytes = cache.bytes
  const entryPath = (base: string, path: string): string => `${base.toLowerCase()}/${path.toLowerCase()}`
  const read = (base: string, path: string): Promise<Uint8Array> => {
    const key = entryPath(base, path)
    const known = bytes.get(key)
    if (known !== undefined) return known
    const opening = readFile(base, path).then(value => {
      if (value === undefined) throw new Error(`missing mod resource ${base}/${path}`)
      if (value.byteLength > MAX_TEXT_BYTES) throw new RangeError(`mod resource is too large: ${path}`)
      return value
    }).catch(error => {
      bytes.delete(key)
      throw error
    })
    bytes.set(key, opening)
    return opening
  }
  const split = (fullPath: string): { base: string; path: string } => {
    const found = [...order].reverse().find(base =>
      fullPath.toLowerCase().startsWith(`${base.toLowerCase()}/`))
    if (found === undefined) throw new Error(`unknown mod resource ${fullPath}`)
    return { base: found, path: fullPath.slice(found.length + 1) }
  }
  // CASC may list languages whose encoding keys are not installed locally. Keep every readable
  // semantic file and let the canonical reader merge those; one optional locale cannot hide a mod.
  const available = order.map(() => [] as string[])
  for (let index = 0; index < order.length; index += 1) {
    const base = order[index] as string
    const candidates = (lists[index] ?? []).filter(isSemanticModEntry)
    for (let start = 0; start < candidates.length; start += 8) {
      const batch = candidates.slice(start, start + 8)
      const results = await Promise.all(batch.map(async path =>
        read(base, path).then(() => path, () => undefined)))
      for (const path of results) if (path !== undefined) available[index]!.push(path)
    }
  }
  const reader = new SC2ModReader({
    vfs: {
      async list(base) {
        return [...(available[byBase.get(base.toLowerCase()) ?? -1] ?? [])]
      },
      async get(fullPath) {
        const { base, path } = split(fullPath)
        return read(base, path)
      },
      async getText(fullPath) {
        return new TextDecoder().decode(await this.get(fullPath))
      },
      async exists(fullPath) {
        if (byBase.has(fullPath.toLowerCase())) return true
        const { base, path } = split(fullPath)
        const index = byBase.get(base.toLowerCase()) ?? -1
        return available[index]?.some(item => item.toLowerCase() === path.toLowerCase()) ?? false
      },
    },
    includeOpaqueFile: isSemanticModEntry,
    listFiles: base => available[byBase.get(base.toLowerCase()) ?? -1],
    modParseCache: cache.parsed,
    catalogs,
  })
  const mod = await reader.read(order.at(-1) as string, { deps: order.slice(0, -1) })
  return { mod, available, read }
}

/** The chain's Data as its server's session holds it, and where each layer's documents live. */
export interface ResourceTreeData {
  readonly entries: EngineCatalogEntries
  readonly invalid: readonly { readonly rootId: string; readonly path: string; readonly message: string }[]
  /** Each layer, in load order, as the session's documents name it: their root and the layer's path. */
  readonly layers: readonly { readonly rootId: string; readonly sourcePath: string }[]
}

/**
 * The session's catalog read as the tree reads a chain: a declaration named by its layer's load-order
 * path and its layer-relative file, as the mod reader names them, so a card opens the same file.
 */
function sessionCatalog(data: ResourceTreeData, order: readonly string[]) {
  const layerOfRoot = new Map(data.layers.map((layer, index) => [layer.rootId, { base: order[index] as string, prefix: `${layer.sourcePath}/` }] as const))
  const named = (source: EntitySource): EntitySource => {
    const layer = layerOfRoot.get(source.mod)
    if (layer === undefined) return source
    return { ...source, mod: layer.base, file: source.file.startsWith(layer.prefix) ? source.file.slice(layer.prefix.length) : source.file }
  }
  const byNamespace = new Map<string, CatalogEntity[]>()
  return {
    // In the tree, Data spaces read alphabetically, whatever order the chain's files load in.
    namespaces: () => data.entries.namespaces().sort((left, right) => left.localeCompare(right)),
    all(namespace: string): CatalogEntity[] {
      let entities = byNamespace.get(namespace)
      if (entities === undefined) {
        entities = data.entries.all(namespace).map(entity => ({
          ...entity,
          ...(entity.source === undefined ? {} : { source: named(entity.source) }),
          ...(entity.sources === undefined ? {} : { sources: entity.sources.map(named) }),
        }))
        byNamespace.set(namespace, entities)
      }
      return entities
    },
    getResolved: (namespace: string, id: string) => data.entries.getResolved(namespace, id),
    structureDefaults: (namespace: string) => data.entries.getStructureDefaults(namespace),
    malformedCatalogs: data.invalid.map(item => {
      const layer = layerOfRoot.get(item.rootId)
      return {
        mod: layer?.base ?? item.rootId,
        path: layer !== undefined && item.path.startsWith(layer.prefix) ? item.path.slice(layer.prefix.length) : item.path,
        message: item.message,
      }
    }),
  }
}

export async function effectiveModResourceTree(
  /** The chain's listings and bytes; the mod server gives them with the editor's text over files. */
  resolved: Pick<ResolvedMod, 'order' | 'files' | 'read'>,
  layers: readonly Sc2ModContextLayer[],
  revision: string,
  cache: ChainReadCache,
  locale?: string,
  /** The chain's Data from its server; without it the tree reads a catalog of its own. */
  data?: () => Promise<ResourceTreeData>,
): Promise<TreeDataSource> {
  const order = resolved.order
  const listings = await Promise.all(order.map(path => resolved.files(path)))
  const byBase = new Map(order.map((path, index) => [path.toLowerCase(), index]))
  const { mod, available, read } = await readChainMod(
    order, listings.map(listing => listing.list), (base, path) => resolved.read(base, path), cache, data === undefined)
  const served = data === undefined ? undefined : sessionCatalog(await data(), order)
  const catalog = served ?? {
    namespaces: () => mod.namespaces(),
    all: (namespace: string) => mod.all(namespace),
    getResolved: (namespace: string, id: string) => mod.getResolved(namespace, id),
    structureDefaults: (namespace: string) => mod.structureDefaults(namespace),
    malformedCatalogs: mod.malformedCatalogs,
  }

  // One path denotes the last layer that supplies it. The winning bytes and source travel
  // together, so a click opens the declaration that supplied the effective value.
  const winners = new Map<string, { path: string; layer: Sc2ModContextLayer }>()
  for (let index = 0; index < order.length; index += 1) {
    const layer = layers[index]
    if (layer === undefined) continue
    for (const path of available[index] ?? []) winners.set(path.toLowerCase(), { path, layer })
  }
  const files = new Map<string, Uint8Array>()
  const roots = new Map<string, AssetSourceRef>()
  const selected = [...winners.values()]
  for (let start = 0; start < selected.length; start += 8) {
    const batch = selected.slice(start, start + 8)
    const loaded = await Promise.all(batch.map(async winner => {
      const index = layers.indexOf(winner.layer)
      return { winner, bytes: await read(order[index] as string, winner.path) }
    }))
    for (const item of loaded) {
      files.set(item.winner.path, item.bytes)
      roots.set(item.winner.path.toLowerCase(), layerRoot(item.winner.layer))
    }
  }
  const layouts = new Map(mod.layouts)
  for (const [path, value] of files) {
    if (!layoutFile(path) || layouts.has(path)) continue
    try { layouts.set(path, parseLayout(new TextDecoder().decode(value))) }
    catch { /* A broken layout remains visible under Files. */ }
  }
  const primary = layers.at(-1)
  if (primary === undefined) throw new Error('resolved mod has no primary layer')
  const root = layerRoot(primary)
  // Files lists every file each layer lists, assets included, not only what the reader loaded.
  const layerFiles = layers.map((layer, index) => ({
    path: layer.sourcePath, root: layerRoot(layer), paths: listings[index]?.list ?? [],
  }))
  const entries: ModCardEntry[] = [...files].map(([path, value]) => ({
    path, kind: 'file', size: BigInt(value.byteLength),
  }))
  const layeredSources = [] as { path: string; bytes: Uint8Array; root: AssetSourceRef }[]
  for (let index = 0; index < order.length; index += 1) {
    const layer = layers[index]
    if (layer === undefined) continue
    for (const path of available[index] ?? []) {
      if (!MOD_DOCUMENT_ROUTES.localizedStrings.pathPattern.test(path) &&
          !MOD_DOCUMENT_ROUTES.fontStyles.pathPattern.test(path) &&
          !MOD_DOCUMENT_ROUTES.editorCategories.pathPattern.test(path) &&
          !MOD_DOCUMENT_ROUTES.assetStrings.pathPattern.test(path)) continue
      layeredSources.push({ path, bytes: await read(order[index] as string, path), root: layerRoot(layer) })
    }
  }
  return modResourceTree({
    root,
    rootForPath: path => roots.get(path.toLowerCase()) ?? root,
    rootForMod: modPath => {
      const layer = layers[byBase.get(modPath.toLowerCase()) ?? -1]
      return layer === undefined ? undefined : layerRoot(layer)
    },
    revision,
    ...(locale === undefined ? {} : { locale }),
    entries,
    files,
    layeredSources,
    layerFiles,
    dependencies: [],
    dependencyChain: layers.slice(0, -1).map(layer => ({
      path: layer.sourcePath, required: true, basis: layer.provenance,
      // The loader's own address of the package: a folder on disk by its path, else in its source.
      subjectId: layer.sourceId === 'host' ? layer.sourcePath : `content-source://${layer.sourceId}/${layer.sourcePath}`,
    })),
    mod: {
      locales: mod.locales,
      loadOrder: mod.loadOrder,
      layouts,
      fontStyles: mod.fontStyles,
      fontStylesForLocale: locale => mod.fontStylesForLocale(locale),
      editorCategories: mod.editorCategories,
      assetAliases: mod.assetAliases,
      malformedCatalogs: catalog.malformedCatalogs,
      namespaces: () => catalog.namespaces(),
      all: namespace => catalog.all(namespace),
      getResolved: (namespace, id) => catalog.getResolved(namespace, id),
      structureDefaults: namespace => catalog.structureDefaults(namespace),
    },
    namespaces: gameDataNamespaceSummaries({ namespaces: catalog.namespaces, all: catalog.all, loadOrder: mod.loadOrder }),
  })
}
