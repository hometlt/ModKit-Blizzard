/**
 * SC2 desktop content-source owner (modules/game): installation/CASC, folders, map/depot caches,
 * configured mod/zip/JSON sources and editor wizards, with native dependency precedence and
 * implicit metadata. LocalSource read/list/search/reveal/refresh and public ModContext
 * open/placement delegate to their existing owners; account/publication calls delegate to
 * BattleNetContentSources and its credential/review policy. No game parsing or new RPC here.
 * Each loaded Mod source generation shares one existing LocalArchives cache for opened host
 * folders, retaining at most 64MiB tracked MPQ bytes between actions. Input/file limits stay
 * independent; active results remain complete. Folder views do not close the shared cache;
 * captured generation disposal closes it after its loader even when initialization fails.
 * Common installation/depot sources retain their own owners. This is not a total model/RSS
 * or concurrency budget, browser support, or a change to remote authoring/permissions.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BattleNetCacheSource } from './cache-source.js'
import type { Sc2ModContextRequest, createSc2ModContexts } from '../../../mod/shared/workspace/mod-contexts.js'
import { MAX_FILE, LocalArchives, Sc2FolderSource, Sc2MapsCacheSource, type LocalFilesQuery, type LocalSource } from './local-files.js'
import type { IndexCacheSwitches } from '@modkit/sdk'
import type { ContainerEntryLayer as Layer } from '@modkit/codec-kit'
import { Sc2CascSource, type CascIndexCache } from './casc-source.js'
import { BattleNetContentSources } from './content-sources.js'
import { createPublicDepotApi } from './public-depot.js'
import { documentsDirectory, editorWizardDirectories, knownFolder, type FolderProbes } from './windows-folders.js'

export interface Sc2LocalSourceOptions {
  battleNetCacheDirectory?: string
  sc2MapsCacheDirectory?: string
  installationDirectory?: string
  documentsDirectory?: string
  /** Folders the editor loads `.BlizWiz` from; discovered when omitted, explicit on other platforms. */
  wizardDirectories?: readonly string[]
  locale?: string
  /** Host-owned cache directory; the CASC name index lay under it before the shared one. */
  cacheDirectory?: string
  /** The host's shared index cache directory (sdk `index-caches`), which keeps the CASC name index. */
  indexCacheDirectory?: string
  /** The user's index cache switches per game product (`modkit.indexCaches`); unset means on. */
  indexCaches?: IndexCacheSwitches
  /**
   * The host's language of a file by its path (sdk `ContentSourceModuleContext.languageFiles`): the
   * mod server classifies the chain's files for its language sets by it, as the host's language
   * snapshot does.
   */
  languageFiles?: (path: string) => { readonly languageId?: string; readonly candidates: readonly string[] }
  /**
   * Stock mods whose chain prefix (Core up to the last of them) keeps its Data parses in the index
   * cache directory (`Liberty`, `Void`, `VoidMulti` when unset; empty keeps none). `s2` with
   * `data: false` in `indexCaches` turns it off.
   */
  cachedMods?: readonly string[]
  /**
   * Whether a file the installed storage names but does not hold (another locale, content not yet
   * streamed in) is listed and read from Blizzard's CDN, as the game reads it. On by default.
   */
  cascOnline?: boolean
  /** Extra places packages are looked for, from the user's settings (MK2 `modkit.sources`). */
  sources?: readonly Sc2ModSourceOption[]
}

/**
 * One extra package source (parity plan 8.9): `mods` — a folder of mod folders and packed mods;
 * `zip` — a folder of zip archives holding mod folders; `json` — a folder of JSON mods; `casc` —
 * an installed game, which becomes the installation.
 */
export interface Sc2ModSourceOption {
  readonly type: 'mods' | 'zip' | 'json' | 'casc'
  readonly path: string
  readonly priority?: number
  readonly disabled?: boolean
}
const MOD_SOURCE_TYPES: readonly string[] = ['mods', 'zip', 'json', 'casc']

/**
 * MK2's rules for a source list merged across settings levels: an entry with `disabled` removes
 * every entry of the same type and path and resolves nothing itself; a path that is not absolute
 * (a token VS Code could not resolve) is skipped; lower `priority` is tried first, ties keep the
 * given order; a `casc` source, a base game, comes after every other.
 */
export function modSourceChain(sources: readonly Sc2ModSourceOption[]): Sc2ModSourceOption[] {
  const key = (source: Sc2ModSourceOption) => `${source.type}\0${resolve(source.path).toLowerCase()}`
  const dropped = new Set(sources.filter(source => source.disabled === true).map(key))
  return sources
    .map((source, order) => ({ source, order }))
    .filter(({ source }) => isAbsolute(source.path) && !dropped.has(key(source)))
    .sort((a, b) =>
      Number(a.source.type === 'casc') - Number(b.source.type === 'casc') ||
      (a.source.priority ?? 0) - (b.source.priority ?? 0) ||
      a.order - b.order)
    .map(({ source }) => source)
}

/** The folders the loader looks for packages in; a `mods` source answers under each of them. */
const PACKAGE_FOLDERS = ['Mods', 'Maps', 'Campaigns']

/**
 * A folder of packages as the loader's storage, found by name as in MK2: `Mods/Foo.SC2Mod` and
 * `Mods/any/where/Foo.SC2Mod` are both `<folder>/Foo.SC2Mod`.
 */
function packageFolderStorage(source: LocalSource) {
  const inner = (path: string) => {
    const names = path.split('/')
    if (!PACKAGE_FOLDERS.some(name => name.toLowerCase() === names[0]?.toLowerCase())) return undefined
    const at = names.findIndex(name => /\.sc2(?:mod|map|campaign)$/iu.test(name))
    return at < 0 ? '' : names.slice(at).join('/')
  }
  return {
    id: source.root.id,
    async list(path: string) {
      if (path === '') return PACKAGE_FOLDERS.map(name => ({ name, directory: true }))
      const at = inner(path)
      return at === undefined ? [] : source.list(at)
    },
    async read(path: string, maxBytes: number) {
      const at = inner(path)
      if (at === undefined) throw new Error(`${path} is not in ${source.root.id}`)
      return source.read(at, maxBytes)
    },
  }
}

const PACKAGE_NAME = /\.sc2(?:mod|map|campaign)$/iu

/**
 * A folder of zip archives holding mod folders (MK2's `zip` source) as the loader's storage: each
 * package found by name at any depth of any archive, the first archive in name order winning.
 * Archives are read by ranges when first asked, and closed with the content sources.
 */
function zipModFolderStorage(id: string, directory: string) {
  let loaded: Promise<{ packages: Map<string, { layer: Layer; root: string; name: string }>; layers: Layer[] }> | undefined
  const load = () => loaded ??= (async () => {
    const [{ readZipByRanges }, { containerEntryLayer }, { fileRangeSource }] = await Promise.all([
      import('modkit-extension-archives/formats/zip/codec'),
      import('@modkit/codec-kit'),
      import('@modkit/vfs/content-sources/node'),
    ])
    const packages = new Map<string, { layer: Layer; root: string; name: string }>()
    const layers: Layer[] = []
    for (const name of (await readdir(directory)).filter(item => /\.zip$/iu.test(item)).sort()) {
      const source = fileRangeSource(join(directory, name))
      const { containerEntries } = await readZipByRanges(source, { maxInputBytes: MAX_FILE, maxNodes: 100_000 })
      const layer = containerEntryLayer(name, containerEntries, source, () => source.close())
      layers.push(layer)
      for (const entry of layer.entries) {
        const parts = entry.path.split('/')
        const at = parts.findIndex(part => PACKAGE_NAME.test(part))
        const key = parts[at]?.toLowerCase()
        if (at >= 0 && key !== undefined && !packages.has(key)) {
          packages.set(key, { layer, root: parts.slice(0, at + 1).join('/'), name: parts[at]! })
        }
      }
    }
    return { packages, layers }
  })()
  /** The package a loader path names and the path inside it, or undefined outside the package folders. */
  const locate = async (path: string) => {
    const names = path.split('/')
    if (!PACKAGE_FOLDERS.some(name => name.toLowerCase() === names[0]?.toLowerCase())) return undefined
    const at = names.findIndex(name => PACKAGE_NAME.test(name))
    const { packages } = await load()
    if (at < 0) return { packages }
    const found = packages.get(names[at]!.toLowerCase())
    return found === undefined ? undefined : { found, inner: names.slice(at + 1).join('/').toLowerCase() }
  }
  return {
    id,
    async list(path: string) {
      if (path === '') return PACKAGE_FOLDERS.map(name => ({ name, directory: true }))
      const at = await locate(path)
      if (at === undefined) return []
      if ('packages' in at) return [...at.packages.values()].map(item => ({ name: item.name, directory: true }))
      const prefix = `${at.found.root}/${at.inner === '' ? '' : `${at.inner}/`}`.toLowerCase()
      const children = new Map<string, LocalEntryLike>()
      for (const entry of at.found.layer.entries) {
        if (!entry.path.toLowerCase().startsWith(prefix)) continue
        const [name, ...rest] = entry.path.slice(prefix.length).split('/')
        if (name === undefined || name === '') continue
        children.set(name.toLowerCase(), rest.length > 0 ? { name, directory: true } : { name, directory: false, size: Number(entry.size) })
      }
      return [...children.values()]
    },
    async read(path: string, maxBytes: number) {
      const at = await locate(path)
      if (at !== undefined && !('packages' in at)) {
        const wanted = `${at.found.root}/${at.inner}`.toLowerCase()
        const entry = at.found.layer.entries.find(item => item.path.toLowerCase() === wanted)
        if (entry !== undefined) return at.found.layer.read(entry.path, maxBytes)
      }
      throw new Error(`${path} is not in ${id}`)
    },
    async dispose() {
      const current = loaded
      loaded = undefined
      if (current !== undefined) await Promise.allSettled((await current).layers.map(layer => layer.close()))
    },
  }
}

/** A folder of JSON mods (`*.json`) as the loader's storage, read when first asked. */
function jsonModFolderStorage(id: string, directory: string) {
  let loaded: Promise<{ list(path: string): Promise<readonly LocalEntryLike[]>; read(path: string, maxBytes: number): Promise<Uint8Array> }> | undefined
  const load = () => loaded ??= (async () => {
    const { jsonModContentSource, parseJsonMod } = await import('../../../mod/shared/json-mod.js')
    const mods = new Map<string, ReturnType<typeof parseJsonMod>>()
    for (const name of (await readdir(directory)).filter(item => /\.json$/iu.test(item)).sort()) {
      const file = join(directory, name)
      if ((await stat(file)).size > MAX_FILE) throw new RangeError(`${file} is larger than ${MAX_FILE} bytes`)
      mods.set(name.replace(/\.json$/iu, ''), parseJsonMod(await readFile(file, 'utf8')))
    }
    return jsonModContentSource(id, mods)
  })()
  return {
    id,
    list: async (path: string) => (await load()).list(path),
    read: async (path: string, maxBytes: number) => (await load()).read(path, maxBytes),
  }
}
type LocalEntryLike = { readonly name: string; readonly directory: boolean; readonly size?: number }
/**
 * Where the installed game's CASC name index is kept: the host's shared index cache directory, the
 * codec's too, else this source's own `casc-index`, which the shared one replaces and removes.
 */
function cascIndexCache(options: Sc2LocalSourceOptions): CascIndexCache | undefined {
  const own = options.cacheDirectory === undefined || !isAbsolute(options.cacheDirectory)
    ? undefined : join(options.cacheDirectory, 'casc-index')
  const directory = options.indexCacheDirectory ?? own
  if (directory === undefined) return undefined
  return { directory,
    ...(options.indexCacheDirectory !== undefined && own !== undefined ? { legacy: own } : {}),
    ...(options.indexCaches === undefined ? {} : { switches: options.indexCaches }) }
}
/** Where packages are looked for, in this order: the player's install over the game's own storage. */
const PACKAGE_SOURCE_IDS = ['local:installation', 'local:casc', 'local:documents']

/** Combines independently usable local providers with the optional authenticated online catalogue. */
export class Sc2DesktopContentSources {
  private readonly locals = new Map<string, LocalSource>()
  private readonly cache: BattleNetCacheSource
  private modContexts: Promise<ReturnType<typeof createSc2ModContexts>> | undefined
  private openedArchives: LocalArchives | undefined
  /** The source that opens a ModContext also advertises its game-owned Runtime projection.
   * This is a trusted local capability: no live context or private bindings enter a worker.
   */
  readonly runtimePreparer = Object.freeze({
    major: 1 as const, gameId: 'blizzard/starcraft-2',
    adapter: Object.freeze({ id: 'blizzard.sc2/galaxy-runtime', version: '0.1.0' }),
    prepare: async (request: {
      context: unknown; selection: Record<string, unknown>; services: unknown;
      budgets: unknown; quantizeFixed64Decimal: (value: string) => string;
    }) => {
      if (!request.selection || typeof request.selection !== 'object'
          || Array.isArray(request.selection))
        throw new TypeError('SC2 Runtime requires a selected unit, map, Galaxy source and roster')
      // Keep the runtime lane out of the Battle.net/content-source TypeScript build graph.
      const runtimeModule = '@modkit/blizzard-starcraft2/runtime/subject-composition'
      const { prepareSc2RuntimeProjection } = await import(runtimeModule)
      return prepareSc2RuntimeProjection({ ...request.selection,
        context: request.context, services: request.services, budgets: request.budgets,
        quantizeFixed64Decimal: request.quantizeFixed64Decimal })
    },
  })
  constructor(private readonly options: Sc2LocalSourceOptions, private online?: BattleNetContentSources) {
    const programData = process.env['ProgramData'] ?? 'C:\\ProgramData'
    this.cache = new BattleNetCacheSource(options.battleNetCacheDirectory ?? join(programData, 'Blizzard Entertainment', 'Battle.net', 'Cache'), options.locale)
    const sources: LocalSource[] = [
      this.cache,
      new Sc2MapsCacheSource(options.sc2MapsCacheDirectory ?? join(programData, 'Blizzard Entertainment', 'StarCraft II', 'Maps', 'Cache'),
        () => this.cache.archiveDisplayNames()),
      new Sc2FolderSource(options.documentsDirectory ?? join(homedir(), 'Documents', 'StarCraft II'),
        'local:documents', 'StarCraft II — данные игрока и настройки'),
    ]
    if (options.installationDirectory) sources.splice(1, 0, new Sc2FolderSource(options.installationDirectory,
      'local:installation', 'StarCraft II — Maps, Mods и Campaigns', ['Maps', 'Mods', 'Campaigns']),
    // The stock packages (Core first of all) live in the game's CASC storage, not in `Mods`.
    ...existsSync(join(options.installationDirectory, '.build.info')) ? [new Sc2CascSource(options.installationDirectory,
      cascIndexCache(options), options.cascOnline !== false)] : [])
    for (const [index, directory] of (options.wizardDirectories ?? []).entries()) {
      const source = new Sc2FolderSource(directory, `local:editor-wizards:${index}`,
        `StarCraft II Editor — мастера (${directory})`)
      sources.push(source)
      this.wizardSourceIds.push(source.root.id)
    }
    // Configured package sources: shown like the others, tried before the installation (casc is
    // the installation itself, see `localOptions`).
    for (const [index, extra] of modSourceChain(options.sources ?? []).entries()) {
      if (extra.type === 'mods') {
        const folder = new Sc2FolderSource(extra.path, `local:mods:${index}`, `StarCraft II — моды (${extra.path})`)
        sources.push(folder)
        this.extraStorages.set(folder.root.id, packageFolderStorage(folder))
      } else if (extra.type === 'json') {
        this.extraStorages.set(`local:json:${index}`, jsonModFolderStorage(`local:json:${index}`, extra.path))
      } else if (extra.type === 'zip') {
        this.extraStorages.set(`local:zip:${index}`, zipModFolderStorage(`local:zip:${index}`, extra.path))
      }
    }
    for (const source of sources) this.locals.set(source.root.id, source)
  }
  private readonly wizardSourceIds: string[] = []
  /** The loader's view of configured package sources, in the order they are tried. */
  private readonly extraStorages = new Map<string, { id: string; list(path: string): Promise<readonly LocalEntryLike[]>; read(path: string, maxBytes: number): Promise<Uint8Array>; dispose?(): Promise<void> }>()
  async snapshot() {
    const online = await this.online?.snapshot()
    return { label: 'StarCraft II', publishing: online?.publishing ?? false, deletion: online?.deletion ?? false, regions: online?.regions ?? [], connections: online?.connections ?? [],
      roots: [...Array.from(this.locals.values(), source => source.root), ...(online?.roots ?? [])] }
  }
  private remote() { if (!this.online) throw new Error('Online Battle.net is not configured'); return this.online }
  connect(region: string, accountId?: string) { return this.remote().connect(region, accountId) }
  disconnect(id: string) { return this.remote().disconnect(id) }
  storage(id: string) { return this.remote().storage(id) }
  preparePublish(id: string, filePath: string, packagePath: string) { return this.remote().preparePublish(id, filePath, packagePath) }
  /** Compile the next revision of a publication this account owns, from a local archive. */
  prepareRevision(sourceId: string, path: string, options?: Parameters<BattleNetContentSources['prepareRevision']>[2]) {
    return this.remote().prepareRevision(sourceId, path, options)
  }
  /** Compile a document Battle.net has never seen. */
  prepareFirstPublication(connectionId: string, options: Parameters<BattleNetContentSources['prepareFirstPublication']>[1]) {
    return this.remote().prepareFirstPublication(connectionId, options)
  }
  publish(id: string) { return this.remote().publish(id) }
  deletionCandidates(id: string) { return this.remote().deletionCandidates(id) }
  deletePublication(id: string) { return this.remote().deletePublication(id) }
  prepareDeletePublication(sourceId: string, path: string) { return this.remote().prepareDeletePublication(sourceId, path) }
  download(sourceId: string, path: string) { return this.remote().download(sourceId, path) }
  clearCache(sourceId: string, path: string) { return this.remote().clearCache(sourceId, path) }
  search(id: string, name: string) { return this.remote().search(id, name) }
  add(id: string) { return this.remote().add(id) }
  remove(id: string, path: string) { return this.remote().remove(id, path) }
  async refresh(id: string) {
    // The loader caches package listings and parsed catalogs across editor documents.
    // A source refresh must invalidate those shared values before a loaded mod is reopened.
    ;(await this.modContexts)?.invalidate(id)
    if (id === 'host') return
    return this.locals.get(id)?.refresh() ?? this.remote().refresh(id)
  }
  list(id: string, path: string) { return this.locals.get(id)?.list(path) ?? this.remote().list(id, path) }
  read(id: string, path: string, maximum: number) { return this.locals.get(id)?.read(path, maximum) ?? this.remote().read(id, path, maximum) }
  /** Bulk file listing for a workspace search; a source that cannot answers undefined and is walked. */
  async files(id: string, path: string, query: LocalFilesQuery) { return this.locals.get(id)?.files?.(path, query) }
  resolveLocalPath(id: string, path: string) { return this.locals.get(id)?.resolveLocalPath(path) }
  resolveCacheHandle(handle: Parameters<BattleNetCacheSource['resolveArchive']>[0]) {
    return this.cache.resolveArchive(handle)
  }
  /**
   * Open a file, folder or package inside the mods it belongs to — the one loader every host and
   * consumer goes through (see `@modkit/vfs` `ContentSources.openModContext`).
   */
  async openModContext(request: Sc2ModContextRequest) {
    return (await this.loader()).open(request)
  }
  /**
   * Where that same loader would place a target, without opening a context (see `@modkit/vfs`
   * `ContentSources.locateModPackage`).
   */
  async locateModPackage(target: Sc2ModContextRequest['target'], signal?: AbortSignal) {
    return (await this.loader()).locateModPackage(target, signal)
  }
  /** The kept-parses cache of saved chains, when the host gives a cache directory and it is on. */
  private dataCache(create: typeof import('../../../mod/shared/workspace/data-cache-node.js').createSc2DataCache) {
    const directory = this.options.indexCacheDirectory
    const switches = this.options.indexCaches?.['s2'] as { readonly data?: boolean } | undefined
    if (directory === undefined || !isAbsolute(directory) || switches?.data === false) return {}
    const cache = create({
      directory,
      ...(this.options.cachedMods === undefined ? {} : { mods: this.options.cachedMods }),
      ...(this.options.installationDirectory === undefined ? {} : { installation: this.options.installationDirectory }),
    })
    return cache === undefined ? {} : { dataCache: cache }
  }
  private loader() {
    // Loaded on first use: a session that never opens a mod context never loads the mod reader.
    if (this.modContexts === undefined) {
      const archives = new LocalArchives(64 * 1024 * 1024)
      this.openedArchives = archives
      this.modContexts = Promise.all([
        import('../../../mod/shared/workspace/mod-contexts.js'),
        import('../../../mod/shared/workspace/data-cache-node.js'),
      ]).then(([module, cacheModule]) =>
        module.createSc2ModContexts({
          ...this.dataCache(cacheModule.createSc2DataCache),
          ...(this.options.languageFiles === undefined ? {} : { languageFiles: this.options.languageFiles }),
          // The cache last: it holds no package by name, only the archives a replay names.
          sources: () => this.storages([...this.extraStorages.keys(), ...PACKAGE_SOURCE_IDS, this.cache.root.id]),
          addOns: () => this.storages(this.wizardSourceIds),
          // A path below the installation that is no file there is a member of the game's CASC.
          storagePathOf: hostPath => {
            const root = this.options.installationDirectory
            if (root === undefined || !this.locals.has('local:casc')) return undefined
            const inside = relative(root, hostPath).replaceAll('\\', '/')
            return inside === '' || inside.startsWith('..') || isAbsolute(inside)
              ? undefined
              : { sourceId: 'local:casc', path: inside }
          },
          replayLayers: async bytes => {
            const { readReplayDependencySet } = await import('../../../replay/services/dependencies/cache-handles.js')
            const set = await readReplayDependencySet(bytes)
            const layers: { sourceId: string; path: string; fingerprint: string }[] = []
            const unresolved: string[] = []
            for (const dependency of set.dependencies) {
              const archive = await this.cache.resolveArchive(dependency.handle)
              if (archive.state === 'resolved' && archive.path !== undefined) {
                layers.push({
                  sourceId: archive.sourceId,
                  path: archive.path,
                  fingerprint: `content-hash.sha256:${dependency.handle.sha256}`,
                })
              } else unresolved.push(dependency.id)
            }
            return { layers, unresolved }
          },
          hostFolder: directory => {
            const folder = new Sc2FolderSource(directory, 'host', 'Opened package', undefined, archives)
            return {
              id: 'host',
              list: path => folder.list(path),
              read: (path, maxBytes) => folder.read(path, maxBytes),
              dispose: () => folder.dispose(),
            }
          },
        }))
    }
    return this.modContexts
  }
  /** Local sources as the mod loader's storages, in the given order; absent ones are skipped. */
  private storages(ids: readonly string[]) {
    return new Map(ids.flatMap(id => {
      const extra = this.extraStorages.get(id)
      if (extra !== undefined) return [[id, extra] as const]
      const source = this.locals.get(id)
      const revision = source?.root.revision
      return source === undefined ? [] : [[id, {
        id,
        ...(revision === undefined ? {} : { revision }),
        list: (path: string) => source.list(path),
        ...(source.listFiles === undefined ? {} : { listFiles: (path: string) => source.listFiles!(path) }),
        // A source with a revision (CASC) may list names whose bytes only its CDN holds; its file
        // pages (`files`) show the installed ones.
        ...(revision === undefined || source.files === undefined ? {} : {
          installedFiles: async (path: string, extensions: readonly string[]) => {
            const files: string[] = []
            let cursor: string | undefined
            do {
              const page = await source.files!(path, { extensions, limit: 4096, ...(cursor === undefined ? {} : { cursor }) })
              for (const item of page.items) if (item.path.startsWith(`${path}/`)) files.push(item.path.slice(path.length + 1))
              cursor = page.nextCursor
            } while (cursor !== undefined)
            return files
          },
        }),
        read: (path: string, maxBytes: number) => source.read(path, maxBytes),
      }] as const]
    }))
  }
  async dispose() {
    const contexts = this.modContexts
    const archives = this.openedArchives
    this.modContexts = undefined
    this.openedArchives = undefined
    await Promise.allSettled([...this.locals.values()].map(source => source.dispose())
      .concat([...this.extraStorages.values()].flatMap(storage => storage.dispose === undefined ? [] : [storage.dispose()]))
      .concat(this.online ? [this.online.dispose()] : [])
      .concat(contexts === undefined
        ? (archives === undefined ? [] : [archives.dispose()])
        : [contexts.then(loader => loader.dispose()).finally(() => archives?.dispose())]))
  }
}
export function localOptions(raw: Record<string, unknown>): Sc2LocalSourceOptions {
  const result: Sc2LocalSourceOptions = {}
  const wizardDirectories = raw['wizardDirectories']
  if (wizardDirectories !== undefined) {
    if (!Array.isArray(wizardDirectories) || wizardDirectories.length > 64 || !wizardDirectories.every(item =>
      typeof item === 'string' && item.length > 0 && item.length <= 4096)) throw new Error('Invalid local source option: wizardDirectories')
    result.wizardDirectories = Object.freeze([...wizardDirectories])
  }
  const cachedMods = raw['cachedMods']
  if (cachedMods !== undefined) {
    if (!Array.isArray(cachedMods) || cachedMods.length > 64 || !cachedMods.every(item =>
      typeof item === 'string' && /^[\w .-]{1,128}$/u.test(item))) throw new Error('Invalid local source option: cachedMods')
    result.cachedMods = Object.freeze([...cachedMods])
  }
  for (const key of ['battleNetCacheDirectory', 'sc2MapsCacheDirectory', 'installationDirectory', 'documentsDirectory', 'locale', 'cacheDirectory'] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || !value || value.length > 4096) throw new Error(`Invalid local source option: ${key}`)
      result[key] = value
    }
  }
  const sources = raw['sources']
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.length > 64) throw new Error('Invalid local source option: sources')
    result.sources = Object.freeze(sources.map((item: unknown, index) => {
      const source = item as Partial<Record<keyof Sc2ModSourceOption, unknown>> | null
      if (source === null || typeof source !== 'object' || !MOD_SOURCE_TYPES.includes(source.type as string) ||
        typeof source.path !== 'string' || !source.path || source.path.length > 4096 ||
        (source.priority !== undefined && !Number.isFinite(source.priority)) ||
        (source.disabled !== undefined && typeof source.disabled !== 'boolean')) {
        throw new Error(`Invalid local source option: sources[${index}]`)
      }
      return Object.freeze({ type: source.type as Sc2ModSourceOption['type'], path: source.path,
        ...(source.priority === undefined ? {} : { priority: source.priority as number }),
        ...(source.disabled === undefined ? {} : { disabled: source.disabled as boolean }) })
    }))
    // MK2's `casc` source was the base game: the first one in the chain is the installation.
    const casc = modSourceChain(result.sources).find(source => source.type === 'casc')
    if (casc !== undefined) result.installationDirectory = casc.path
  }
  return result
}
/**
 * Standalone entry point: local sources work without Python, Electron login helper or a network connection.
 * A trusted host hands its installation probes beside the options (`ContentSourceModuleContext`).
 */
export async function createContentSources(raw: Record<string, unknown>, context?: Sc2HostContext) {
  const local = await hostLocalOptions(raw, context)
  /*
   * The public half of Battle.net needs no account.
   *
   * A publication addresses its own header, the header addresses its archive, and the depot
   * serves both over HTTPS by digest — so published maps and mods are readable, and anything the
   * game already downloaded is readable with no network at all. Signing in, listing an account's
   * own publications, searching by name, publishing and deleting are a different matter: they
   * speak the game's service, which lives in the native backend. Advertising no regions is how
   * this provider says so, rather than offering a login that could only fail.
   */
  const stateDirectory = typeof raw['stateDirectory'] === 'string' ? raw['stateDirectory'] : undefined
  if (stateDirectory === undefined || !isAbsolute(stateDirectory)) {
    return new Sc2DesktopContentSources(local)
  }
  const cacheDirectory = typeof raw['cacheDirectory'] === 'string' && isAbsolute(raw['cacheDirectory'])
    ? raw['cacheDirectory']
    : join(stateDirectory, 'battlenet-depot')
  const online = new BattleNetContentSources({
    stateDirectory,
    cacheDirectory,
    publishing: false,
    deletion: false,
    authentication: {
      supportedRegions: [],
      login: () => {
        throw new Error(
          'Signing in to Battle.net needs the native runtime; only public content is available',
        )
      },
    },
    publicApi: createPublicDepotApi(
      local.battleNetCacheDirectory === undefined
        ? {}
        : { cacheDirectory: local.battleNetCacheDirectory },
    ),
  })
  return new Sc2DesktopContentSources(local, online)
}
/**
 * Fill folders the options leave open from the host's probes: the known `Documents` folder, the
 * editor's wizard folders and the Battle.net and map caches under ProgramData. Without probes the
 * constructor's defaults apply.
 */
/** What a trusted host hands a StarCraft II content-source module beside its options. */
export interface Sc2HostContext {
  readonly installationProbes?: FolderProbes
  readonly indexCacheDirectory?: string
  readonly indexCaches?: IndexCacheSwitches
  readonly languageFiles?: (path: string) => { readonly languageId?: string; readonly candidates: readonly string[] }
}

/**
 * The local sources' options from a module's raw options and the host's context: the shared index
 * cache and its switches, then what the probes discover. Every entry point (this module's and the
 * desktop backend's) takes them from here, so the CASC name index stays one copy.
 */
export function hostLocalOptions(raw: Record<string, unknown>, context?: Sc2HostContext): Promise<Sc2LocalSourceOptions> {
  const shared = context?.indexCacheDirectory
  return discoverLocalOptions({ ...localOptions(raw),
    ...(shared !== undefined && isAbsolute(shared) ? { indexCacheDirectory: shared } : {}),
    ...(context?.indexCaches === undefined ? {} : { indexCaches: context.indexCaches }),
    ...(context?.languageFiles === undefined ? {} : { languageFiles: context.languageFiles }) }, context?.installationProbes)
}

export async function discoverLocalOptions(options: Sc2LocalSourceOptions,
  probes?: FolderProbes): Promise<Sc2LocalSourceOptions> {
  const documents = options.documentsDirectory ?? join(await documentsDirectory(probes), 'StarCraft II')
  const programData = options.battleNetCacheDirectory === undefined || options.sc2MapsCacheDirectory === undefined
    ? await knownFolder(probes, 'program-data') : undefined
  const blizzard = programData === undefined ? undefined : join(programData, 'Blizzard Entertainment')
  return { ...options, documentsDirectory: documents,
    ...(options.battleNetCacheDirectory === undefined && blizzard !== undefined
      ? { battleNetCacheDirectory: join(blizzard, 'Battle.net', 'Cache') } : {}),
    ...(options.sc2MapsCacheDirectory === undefined && blizzard !== undefined
      ? { sc2MapsCacheDirectory: join(blizzard, 'StarCraft II', 'Maps', 'Cache') } : {}),
    wizardDirectories: options.wizardDirectories ?? await editorWizardDirectories(documents, probes) }
}
