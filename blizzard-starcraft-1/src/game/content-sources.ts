/**
 * StarCraft content sources: an installed StarCraft: Remastered as the one tree its CASC storage
 * holds (`arr`, `rez`, `tileset`, `unit`, the campaigns, the HD assets), through the layered-archive
 * helper of `@modkit/vfs` over the shared CASC installation reader of `@modkit/blizzard-casc`. The
 * root declares `storageOf`, so opening the installation folder mounts this root instead of a second
 * reader through the container codec. The name index is kept between windows in the host's shared
 * index cache directory, as the `blizzard/casc` codec keeps it.
 *
 * A map (`.scm`, `.scx`) or a loose scenario (`.chk`) opens inside the game it is played with: the
 * installation's tree first — its tilesets, data tables and strings — the opened subject last. That
 * context is what the host projects as a subject's `workspace-dependency-layer`, where the map
 * codec finds its tileset.
 *
 * A classic 1.x installation is the same root over its MPQ chain — `patch_rt.mpq` over `BrooDat.mpq`
 * over `StarDat.mpq` — each archive read by range through `@modkit/blizzard-mpq/layer-node`. Those
 * archives carry no (listfile): the files the game opens by name (tilesets, strings, data tables)
 * are found through their hash tables and named in the tree.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { cascInstallationArchive, installationBuild, openCascInstallation } from '@modkit/blizzard-casc/installation-node'
import { openMpqArchiveLayer } from '@modkit/blizzard-mpq/layer-node'
import { openMpqReader, type MpqReader } from '@modkit/blizzard-mpq/reader'
import { indexCacheEnabled, type ContentSourceModuleContext } from '@modkit/sdk'
import {
  HOST_LAYER_SOURCE_ID,
  createLayeredArchiveContentSources,
  type LayerArchive,
  type LayerArchiveEntry,
  type LayeredArchiveContentSources,
  type LayeredRoot,
  type ModContext,
  type ModContextLayer,
  type ModContextRequest,
  type ModContextTarget,
  type ModPackagePlacement,
} from '@modkit/vfs/content-sources'
import { TILESET_FILES } from '../chk/scenario.js'
import { DAT_LAYOUTS } from '../dat/dat.js'
import { STAT_TXT } from '../tbl/companion.js'
import { STARCRAFT1_GAME_ID, discoverStarcraft1Installations } from './installation.js'

export const STARCRAFT1_ROOT_ID = 'local:starcraft1'
const GAME_LAYER = 'starcraft1-game'
const PRIMARY_LAYER = 'primary'
/** A map is read whole: the largest melee and use-map-settings maps are a few MiB. */
const MAX_MAP_BYTES = 64 << 20
const MAP_LIMITS = Object.freeze({ maxArchiveBytes: MAX_MAP_BYTES, maxEntries: 65_536, maxEntryBytes: MAX_MAP_BYTES })
/** Entries a hash table holds without a name: readable by path, but nothing to list them by. */
const UNNAMED = /^block\/\d+$/u

const normalized = (path: string) => path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
const key = (path: string) => normalized(path).toLowerCase()

/** The 1.x load order, lowest first; names are matched without case, as installers vary them. */
const CLASSIC_CHAIN = Object.freeze(['stardat.mpq', 'broodat.mpq', 'patch_rt.mpq'])
const CLASSIC_LIMITS = Object.freeze({ maxArchiveBytes: 1 << 30, maxEntries: 65_536, maxEntryBytes: MAX_MAP_BYTES })
/** Files the game opens by name, which a 1.x archive without (listfile) cannot list. */
const KNOWN_PATHS = Object.freeze([
  ...TILESET_FILES.flatMap(era => ['cv5', 'vx4', 'vr4', 'vf4', 'wpe'].map(extension => `tileset/${era}.${extension}`)),
  STAT_TXT,
  ...DAT_LAYOUTS.flatMap(layout => [
    `arr/${layout.file}`,
    ...(layout.names?.kind === 'own-tbl' ? [`arr/${layout.file.replace(/\.dat$/u, '.tbl')}`] : []),
  ]),
])

/** An archive of the chain, its names completed by the known paths its hash table finds. */
export async function withKnownNames(archive: LayerArchive): Promise<LayerArchive> {
  const named = new Set(archive.entries.map(entry => key(entry.path)))
  const found: LayerArchiveEntry[] = []
  for (const path of KNOWN_PATHS) {
    if (named.has(key(path))) continue
    const entry = await archive.lookup?.(path)
    if (entry !== undefined) found.push(entry)
  }
  if (found.length === 0) return archive
  return Object.freeze({
    id: archive.id,
    entries: Object.freeze([...archive.entries, ...found]),
    ...(archive.lookup === undefined ? {} : { lookup: archive.lookup.bind(archive) }),
    read: archive.read.bind(archive),
    close: archive.close.bind(archive),
  })
}

/** The chain's archives present in `installation`, lowest first; none without `StarDat.mpq`. */
async function classicChain(installation: string): Promise<readonly string[]> {
  const names = new Map((await readdir(installation).catch(() => [])).map(name => [name.toLowerCase(), name]))
  if (!names.has('stardat.mpq')) return []
  return CLASSIC_CHAIN.flatMap(name => {
    const found = names.get(name)
    return found === undefined ? [] : [join(installation, found)]
  })
}

/** The chain as the helper takes it, highest priority (the patch) first. */
async function openClassicChain(chain: readonly string[]): Promise<readonly LayerArchive[]> {
  const opened: LayerArchive[] = []
  try {
    for (const path of [...chain].reverse()) {
      opened.push(await openMpqArchiveLayer(path, CLASSIC_LIMITS))
      opened[opened.length - 1] = await withKnownNames(opened[opened.length - 1]!)
    }
    return opened
  } catch (error) {
    await Promise.all(opened.map(layer => layer.close()))
    throw error
  }
}

class Starcraft1Placement {
  constructor(
    private readonly installation: string | undefined,
    private readonly game: LayeredArchiveContentSources,
  ) {}

  /** A map is a package of this game; a scenario outside one opens loose; anything else is not StarCraft's. */
  async locateModPackage(target: ModContextTarget): Promise<ModPackagePlacement> {
    if (typeof target !== 'string' && target.sourceId !== STARCRAFT1_ROOT_ID) return { kind: 'foreign' }
    const path = typeof target === 'string' ? target : target.path
    const lower = path.toLowerCase()
    const map = /\.sc[mx]$/u.test(lower)
    if (!map && !lower.endsWith('.chk')) return { kind: 'foreign' }
    if (typeof target === 'string' && !(await stat(target).then(item => item.isFile(), () => false))) return { kind: 'missing' }
    return map
      ? { kind: 'package', sourceId: typeof target === 'string' ? HOST_LAYER_SOURCE_ID : target.sourceId, path, displayName: basename(path) }
      : { kind: 'loose' }
  }

  async openModContext(request: ModContextRequest): Promise<ModContext> {
    const target = request.target
    const placement = await this.locateModPackage(target)
    if (placement.kind === 'foreign' || placement.kind === 'missing')
      throw new TypeError(`StarCraft cannot open «${typeof target === 'string' ? target : target.path}» (${placement.kind})`)
    const onHost = typeof target === 'string'
    const path = onHost ? target : target.path
    const layers: ModContextLayer[] = []
    if (this.installation !== undefined)
      layers.push({ id: GAME_LAYER, displayName: 'StarCraft', sourceId: STARCRAFT1_ROOT_ID, sourcePath: '', role: 'dependency', provenance: 'implicit', kind: 'files' })
    layers.push({
      id: PRIMARY_LAYER,
      displayName: basename(path),
      sourceId: onHost ? HOST_LAYER_SOURCE_ID : target.sourceId,
      sourcePath: path,
      role: 'primary',
      provenance: 'opened',
      kind: placement.kind === 'package' ? 'package' : 'files',
    })
    const bytesOf = async (): Promise<Uint8Array> => {
      if (!onHost) return this.game.read(target.sourceId, path, MAX_MAP_BYTES)
      const bytes = new Uint8Array(await readFile(path))
      if (bytes.byteLength > MAX_MAP_BYTES) throw new RangeError(`«${path}» is more than ${String(MAX_MAP_BYTES)} bytes`)
      return bytes
    }
    // A map is read through the MPQ library, from its bytes; a scenario is its own one file.
    let map: Promise<MpqReader> | undefined
    const mapReader = () => (map ??= bytesOf().then(bytes => openMpqReader(bytes, MAP_LIMITS)))
    /** A layer's files by lower-case path: the game matches names without case. */
    const byKey = (paths: Iterable<string>) => new Map([...paths].map(item => [key(item), normalized(item)]))
    let primary: Promise<ReadonlyMap<string, string>> | undefined
    const primaryFiles = () =>
      (primary ??= (async () =>
        byKey(
          placement.kind === 'package'
            ? (await mapReader()).entries.filter(entry => !UNNAMED.test(entry.path) && entry.hidden !== true).map(entry => entry.path)
            : [basename(normalized(path))],
        ))())
    // The installation's files, listed once for the context's life.
    let listed: Promise<ReadonlyMap<string, string>> | undefined
    const gameFiles = () =>
      (listed ??= (async () => {
        const paths: string[] = []
        let cursor: string | undefined
        do {
          const page = await this.game.files(STARCRAFT1_ROOT_ID, '', { limit: 10_000, ...(cursor === undefined ? {} : { cursor }) })
          for (const item of page.items) if (item.hidden !== true) paths.push(item.path)
          cursor = page.nextCursor
        } while (cursor !== undefined)
        return byKey(paths)
      })())
    const filesOf = (layerId: string): Promise<ReadonlyMap<string, string>> =>
      layerId === GAME_LAYER && this.installation !== undefined
        ? gameFiles()
        : layerId === PRIMARY_LAYER
          ? primaryFiles()
          : Promise.reject(new RangeError(`no StarCraft context layer «${layerId}»`))
    const has = async (layerId: string, file: string) => (await filesOf(layerId)).has(key(file))
    return {
      schemaVersion: 1,
      gameId: STARCRAFT1_GAME_ID,
      contextId: `sc1:${this.installation ?? '-'}:${onHost ? path : `${target.sourceId}/${path}`}`,
      layers,
      unresolved: this.installation === undefined ? ['StarCraft installation'] : [],
      diagnostics: [],
      files: async (layerId, page) => {
        const prefix = key(page.prefix ?? '')
        const all = [...(await filesOf(layerId)).values()].filter(item => key(item).startsWith(prefix)).sort()
        const start = page.cursor === undefined ? 0 : Number(page.cursor)
        const items = all.slice(start, start + page.limit)
        return start + items.length < all.length ? { items, nextCursor: String(start + items.length) } : { items }
      },
      read: async (layerId, file, maxBytes) => {
        if (!(await has(layerId, file))) throw new RangeError(`«${file}» is not a file of layer «${layerId}»`)
        if (layerId === GAME_LAYER) return this.game.read(STARCRAFT1_ROOT_ID, normalized(file), maxBytes)
        if (placement.kind !== 'package') {
          const bytes = await bytesOf()
          if (bytes.byteLength > maxBytes) throw new RangeError(`«${file}» is more than ${String(maxBytes)} bytes`)
          return bytes
        }
        const reader = await mapReader()
        const entry = reader.find(normalized(file))
        if (entry === undefined) throw new RangeError(`the map has no «${file}»`)
        if (entry.size > maxBytes) throw new RangeError(`«${file}» is ${String(entry.size)} bytes, more than ${String(maxBytes)}`)
        return reader.read(entry.id)
      },
      locate: async file => {
        for (const layer of [...layers].reverse())
          if (await has(layer.id, file).catch(() => false)) return { layerId: layer.id, path: normalized(file) }
        return undefined
      },
      dispose: async () => {
        ;(await map?.catch(() => undefined))?.dispose()
      },
    }
  }
}

/**
 * The installation comes from the host — the one the user selected, `installationDirectory` — or
 * else from this extension's own discovery. A Remastered storage or a classic MPQ chain gets a root.
 */
export async function createContentSources(
  options: Readonly<Record<string, unknown>>,
  context: ContentSourceModuleContext = {},
): Promise<LayeredArchiveContentSources> {
  const selected = options['installationDirectory']
  let installation = typeof selected === 'string' && isAbsolute(selected) ? selected : undefined
  if (installation === undefined) {
    const discovery = await discoverStarcraft1Installations({ gameId: STARCRAFT1_GAME_ID, maxCandidates: 16 }, context.installationProbes)
    installation = discovery.installations.find(found =>
      found.evidence.some(item => (item.kind === 'starcraft1-build-identity' || item.kind === 'starcraft1-classic-archive') && item.found),
    )?.installPath
  }
  const build = installation === undefined ? undefined : installationBuild(installation)
  const remastered = build?.product === 's1' ? build : undefined
  const chain = installation === undefined || remastered !== undefined ? [] : await classicChain(installation)
  const cacheDirectory = context.indexCacheDirectory
  const cache =
    cacheDirectory === undefined
      ? undefined
      : { directory: cacheDirectory, names: (product: string) => indexCacheEnabled(context.indexCaches, product, 'names') }
  const storage = installation
  const roots: LayeredRoot[] = []
  if (storage !== undefined && remastered !== undefined)
    roots.push({
      root: {
        id: STARCRAFT1_ROOT_ID,
        label: 'StarCraft: Remastered — CASC',
        region: 'local',
        kind: 'local',
        storageOf: storage,
        game: remastered.game,
        revision: remastered.buildKey,
        product: remastered.product,
      },
      open: async () => [cascInstallationArchive(await openCascInstallation(storage, cache), 'storage')],
    })
  else if (storage !== undefined && chain.length > 0)
    roots.push({
      root: { id: STARCRAFT1_ROOT_ID, label: 'StarCraft — MPQ', region: 'local', kind: 'local', storageOf: storage, game: 'starcraft1' },
      open: () => openClassicChain(chain),
    })
  const game = createLayeredArchiveContentSources('StarCraft', roots)
  const placement = new Starcraft1Placement(roots.length === 0 ? undefined : storage, game)
  return {
    ...game,
    locateModPackage: target => placement.locateModPackage(target),
    openModContext: request => placement.openModContext(request),
  }
}
