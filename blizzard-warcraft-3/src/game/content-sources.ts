/**
 * Warcraft III content sources: a classic installation's archives as the one tree the game reads.
 *
 * The game loads its MPQ archives as a chain — the base archive, the expansion, their localized
 * archives, then the patch — and a file in a later archive replaces the same path in an earlier
 * one. This root shows that result through the layered-archive helper of `@modkit/vfs`: every
 * named file once, served by the archive the game would read it from. The archives are read
 * through the MPQ library by range (tables, then entries asked for), never whole; the chain is
 * opened on first use and kept.
 *
 * A patch archive carries no (listfile): its files are named by the archives below it, and a path
 * none of them names is still read by the patch's hash table, though it cannot be listed.
 *
 * Reforged is a CASC product: the same root serves its storage through the shared CASC installation
 * reader, as the overlays the game reads (`reforged.ts`: HD art over the base, the locale over each).
 * Options `artSet` (`hd` or `sd`) and `locale` choose them as the game's settings do. The root
 * declares `storageOf`, so opening the installation folder mounts it, and its name index is kept
 * in the host's shared index cache directory.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { cascInstallationArchive, installationBuild, openCascInstallation } from '@modkit/blizzard-casc/installation-node'
import { openMpqArchiveLayer, openMpqFile, type MpqFile } from '@modkit/blizzard-mpq/layer-node'
import { indexCacheEnabled, type ContentSourceModuleContext } from '@modkit/sdk'
import {
  HOST_LAYER_SOURCE_ID,
  createLayeredArchiveContentSources,
  type ContentSources,
  type LayerArchive,
  type LayeredArchiveContentSources,
  type ModContext,
  type ModContextLayer,
  type ModContextRequest,
  type ModContextTarget,
  type ModPackagePlacement,
} from '@modkit/vfs/content-sources'
import { discoverWarcraft3Installations } from './installation.js'
import { openReforgedView, type ReforgedLayer, type Warcraft3ArtSet } from './reforged.js'

const ROOT_ID = 'local:warcraft3'
const GAME_LAYER = 'war3-game'
const PRIMARY_LAYER = 'primary'
const TILESET_LAYER = 'war3-tileset'
/** Where a Reforged root serves the tileset overlays, a folder per tileset letter, hidden. */
const TILESETS = '_tilesets'

/**
 * A Reforged overlay served under `prefix/` of the root: its entries, lookups and reads by the
 * prefixed path, the same files and answers (`.dds` for `.blp`, aliases). It never closes the reader.
 */
function underPrefix(layer: ReforgedLayer, prefix: string): ReforgedLayer {
  const inner = (path: string) => {
    const normal = path.replaceAll('\\', '/').replace(/^\/+/u, '')
    return normal.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) ? normal.slice(prefix.length + 1) : undefined
  }
  return {
    id: `${prefix}/${layer.id}`,
    entries: layer.entries.map(entry => ({ ...entry, path: `${prefix}/${entry.path}` })),
    resolve: path => {
      const own = inner(path)
      const stored = own === undefined ? undefined : layer.resolve(own)
      return stored === undefined ? undefined : `${prefix}/${stored}`
    },
    lookup: async path => {
      const own = inner(path)
      return own === undefined ? undefined : (await layer.lookup?.(own)) === undefined ? undefined : { path }
    },
    read: (path, maxBytes, signal) => {
      const own = inner(path)
      return own === undefined ? Promise.reject(new RangeError(`no «${path}» under ${prefix}`)) : layer.read(own, maxBytes, signal)
    },
    close: async () => undefined,
  }
}

/**
 * A map's tileset, the letter its `war3map.w3e` header stores after the magic and version
 * (`W3E!`, int32, then the tileset: `L` Lordaeron Summer …); undefined without a readable header.
 */
async function mapTileset(reader: () => Promise<MpqFile>): Promise<string | undefined> {
  const file = await reader().catch(() => undefined)
  const entry = file?.find('war3map.w3e')
  if (file === undefined || entry === undefined) return undefined
  const bytes = await file.read(entry.id).catch(() => undefined)
  if (bytes === undefined || bytes.byteLength < 9 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'W3E!') return undefined
  const letter = String.fromCharCode(bytes[8]!)
  return /^[A-Za-z]$/u.test(letter) ? letter : undefined
}
/** The game's load order, lowest first; names are matched without case, as installers vary them. */
const CHAIN = Object.freeze(['war3.mpq', 'war3local.mpq', 'war3x.mpq', 'war3xlocal.mpq', 'war3patch.mpq'])
const LIMITS = Object.freeze({
  maxArchiveBytes: 1_073_741_824,
  maxEntries: 262_144,
  maxEntryBytes: 268_435_456,
})
/** Entries the hash table holds without a name: readable by path, but nothing to list them by. */
const UNNAMED = /^block\/\d+$/u

const normalized = (path: string) => path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
const key = (path: string) => normalized(path).toLowerCase()
/** A host path under the installation directory — a member of one of its archives included. */
const inside = (directory: string, path: string) => {
  const root = `${key(directory)}/`
  return key(path).startsWith(root)
}

/** The chain's archives present in `installation`, lowest first, by their names on disk. */
async function chainArchives(installation: string): Promise<readonly string[]> {
  const names = new Map((await readdir(installation)).map(name => [name.toLowerCase(), name]))
  return CHAIN.flatMap(name => {
    const found = names.get(name)
    return found === undefined ? [] : [join(installation, found)]
  })
}

/** The chain's archives, highest priority (the patch) first, as the helper takes them. */
async function openChain(installation: string): Promise<readonly LayerArchive[]> {
  const opened: LayerArchive[] = []
  try {
    for (const path of [...(await chainArchives(installation))].reverse()) opened.push(await openMpqArchiveLayer(path, LIMITS))
    return opened
  } catch (error) {
    for (const layer of opened) await layer.close()
    throw error
  }
}

class Warcraft3Placement {
  constructor(
    private readonly installation: string | undefined,
    private readonly game: LayeredArchiveContentSources,
    /** The path an archive of the root reads for one it does not list (its own lookup), if any. */
    private readonly answers: (path: string) => Promise<string | undefined> = async () => undefined,
    /** Reforged: the overlays of a tileset (`l` …), highest first; absent for a classic installation. */
    private readonly tileset?: (tileset: string) => Promise<readonly ReforgedLayer[]>,
  ) {}

  /**
   * A map (`.w3x`, `.w3m`) is a package of this game; a script or strings file outside one opens
   * loose, and so does a model (`.mdx`, `.mdl`) wherever it lies and any file of the installation
   * itself — each inside the whole installation, which is where a model's shared textures live:
   * `TeamColor`, `TeamGlow` and most of `Textures\` are in war3.mpq whichever archive holds the model.
   * Anything else — and any other game's source — is not Warcraft III's to place.
   */
  async locateModPackage(target: ModContextTarget): Promise<ModPackagePlacement> {
    if (typeof target !== 'string' && target.sourceId !== ROOT_ID) return { kind: 'foreign' }
    const path = typeof target === 'string' ? target : target.path
    const lower = path.toLowerCase()
    const map = /\.w3[mx]$/u.test(lower)
    const ownFile =
      /\.(?:j|ai|wts|mdx|mdl)$/u.test(lower) ||
      typeof target !== 'string' ||
      (this.installation !== undefined && inside(this.installation, path))
    if (!map && !ownFile) return { kind: 'foreign' }
    if (typeof target === 'string' && map && !(await stat(target).then(item => item.isFile(), () => false)))
      return { kind: 'missing' }
    return map
      ? { kind: 'package', sourceId: typeof target === 'string' ? HOST_LAYER_SOURCE_ID : target.sourceId, path, displayName: basename(path) }
      : { kind: 'loose' }
  }

  /**
   * A map, script or strings file inside the game it is read with: the installation's tree first —
   * its `Scripts` (common.j, Blizzard.j, the AI scripts) and its `Units` tables — the opened
   * subject last. In Reforged a map on disk also gets its tileset's overlays between the two (the
   * `tileset` layer: the trees, cliffs and bridges the game loads for it), the tileset read from its
   * `war3map.w3e` header. Without an installation the context names what it misses instead of
   * pretending to be whole.
   */
  async openModContext(request: ModContextRequest): Promise<ModContext> {
    const target = request.target
    const placement = await this.locateModPackage(target)
    if (placement.kind === 'foreign' || placement.kind === 'missing')
      throw new TypeError(`Warcraft III cannot open «${typeof target === 'string' ? target : target.path}» (${placement.kind})`)
    const onHost = typeof target === 'string'
    const path = onHost ? target : target.path
    const layers: ModContextLayer[] = []
    if (this.installation !== undefined)
      layers.push({
        id: GAME_LAYER,
        displayName: 'Warcraft III',
        sourceId: ROOT_ID,
        sourcePath: '',
        role: 'dependency',
        provenance: 'implicit',
        kind: 'files',
      })
    // A map on disk is read through the MPQ library by range, like the installation's archives.
    let map: Promise<MpqFile> | undefined
    const mapReader = () => (map ??= openMpqFile(path, LIMITS))
    const tilesetLetter =
      this.installation !== undefined && this.tileset !== undefined && placement.kind === 'package' && onHost
        ? await mapTileset(mapReader)
        : undefined
    const tilesetLayers = tilesetLetter === undefined ? undefined : await this.tileset!(tilesetLetter)
    if (tilesetLayers !== undefined && tilesetLayers.length > 0)
      layers.push({
        id: TILESET_LAYER,
        displayName: `Tileset ${tilesetLetter!.toUpperCase()}`,
        sourceId: ROOT_ID,
        // the root serves a tileset's overlays under `_tilesets/<letter>` (hidden in its tree)
        sourcePath: `${TILESETS}/${tilesetLetter!.toLowerCase()}`,
        role: 'dependency',
        provenance: 'implicit',
        kind: 'files',
      })
    layers.push({
      id: PRIMARY_LAYER,
      displayName: basename(path),
      sourceId: onHost ? HOST_LAYER_SOURCE_ID : target.sourceId,
      sourcePath: path,
      role: 'primary',
      provenance: 'opened',
      kind: placement.kind === 'package' ? 'package' : 'files',
    })
    // The tileset's file the game reads for `file`, from its highest overlay that has it.
    const tilesetFile = (file: string) => {
      for (const layer of tilesetLayers ?? []) {
        const stored = layer.resolve(normalized(file))
        if (stored !== undefined) return { layer, stored }
      }
      return undefined
    }
    const primaryFiles = async (): Promise<readonly string[]> => {
      if (placement.kind !== 'package') return [basename(normalized(path))]
      if (!onHost) return []
      return (await mapReader()).entries.filter(entry => !UNNAMED.test(entry.path) && entry.hidden !== true).map(entry => entry.path)
    }
    // The installation's files, listed once for the context's life.
    let listed: Promise<readonly string[]> | undefined
    const gameFiles = () =>
      (listed ??= (async () => {
        const paths: string[] = []
        let cursor: string | undefined
        do {
          const page = await this.game.files(ROOT_ID, '', { limit: 10_000, ...(cursor === undefined ? {} : { cursor }) })
          for (const item of page.items) if (item.hidden !== true) paths.push(item.path)
          cursor = page.nextCursor
        } while (cursor !== undefined)
        return paths
      })())
    const filesOf = (layerId: string): Promise<readonly string[]> =>
      layerId === GAME_LAYER && this.installation !== undefined
        ? gameFiles()
        : layerId === PRIMARY_LAYER
          ? primaryFiles()
          : layerId === TILESET_LAYER && tilesetLayers !== undefined
            ? Promise.resolve([...new Set(tilesetLayers.flatMap(layer => layer.entries.map(entry => entry.path)))])
            : Promise.reject(new RangeError(`no Warcraft III context layer «${layerId}»`))
    // A read asks whether its layer names the file: one set of names a layer, not a scan a read.
    const named = new Map<string, Promise<ReadonlySet<string>>>()
    // The installation also answers paths it does not list: a patch file only its hash table names,
    // and in Reforged the path a model writes for a texture it ships as `.dds` (`reforged.ts`).
    // `place` gives the file's own path in the layer: the stored `.dds`, which is what a codec reads.
    const place = async (layerId: string, file: string): Promise<string | undefined> => {
      let names = named.get(layerId)
      if (names === undefined) named.set(layerId, (names = filesOf(layerId).then(items => new Set(items.map(key)))))
      if (layerId === TILESET_LAYER) return tilesetFile(file)?.stored
      if ((await names).has(key(file))) return normalized(file)
      return layerId === GAME_LAYER && this.installation !== undefined ? this.answers(normalized(file)) : undefined
    }
    const has = async (layerId: string, file: string) => (await place(layerId, file)) !== undefined
    return {
      schemaVersion: 1,
      gameId: 'blizzard/warcraft-3',
      contextId: `war3:${this.installation ?? '-'}:${onHost ? path : `${target.sourceId}/${path}`}`,
      layers,
      unresolved: this.installation === undefined ? ['Warcraft III installation'] : [],
      diagnostics: [],
      files: async (layerId, page) => {
        const prefix = key(page.prefix ?? '')
        const all = [...(await filesOf(layerId))].filter(item => key(item).startsWith(prefix)).sort()
        const start = page.cursor === undefined ? 0 : Number(page.cursor)
        const items = all.slice(start, start + page.limit)
        return start + items.length < all.length ? { items, nextCursor: String(start + items.length) } : { items }
      },
      read: async (layerId, file, maxBytes) => {
        if (!(await has(layerId, file))) throw new RangeError(`«${file}» is not a file of layer «${layerId}»`)
        if (layerId === GAME_LAYER) return this.game.read(ROOT_ID, normalized(file), maxBytes)
        if (layerId === TILESET_LAYER) return tilesetFile(file)!.layer.read(normalized(file), maxBytes)
        if (placement.kind === 'package') {
          const reader = await mapReader()
          const entry = reader.find(normalized(file))
          if (entry === undefined) throw new RangeError(`the map has no «${file}»`)
          if (entry.size > maxBytes) throw new RangeError(`«${file}» is ${String(entry.size)} bytes, more than ${String(maxBytes)}`)
          return reader.read(entry.id)
        }
        if (!onHost) return this.game.read(target.sourceId, path, maxBytes)
        const bytes = new Uint8Array(await readFile(path))
        if (bytes.byteLength > maxBytes) throw new RangeError(`«${file}» is more than ${String(maxBytes)} bytes`)
        return bytes
      },
      locate: async file => {
        for (const layer of [...layers].reverse()) {
          const path = await place(layer.id, file).catch(() => undefined)
          if (path !== undefined) return { layerId: layer.id, path }
        }
        return undefined
      },
      dispose: async () => {
        await (await map?.catch(() => undefined))?.close()
      },
    }
  }

}

/**
 * The installation comes from the host — the one the user selected, `installationDirectory` — or
 * else from this extension's own discovery (the environment root, the registry through the host's
 * probes). A classic installation (with `war3.mpq`) is served from its MPQ chain, a Reforged one
 * (the `w3` CASC product) from its storage; anything else gets no root.
 */
export async function createContentSources(
  options: Readonly<Record<string, unknown>>,
  context: ContentSourceModuleContext = {},
): Promise<ContentSources> {
  const selected = options['installationDirectory']
  let installation = typeof selected === 'string' && isAbsolute(selected) ? selected : undefined
  if (installation === undefined) {
    const discovery = await discoverWarcraft3Installations(
      { gameId: 'blizzard/warcraft-3', maxCandidates: 16 },
      context.installationProbes,
    )
    installation = discovery.installations.find(found =>
      found.evidence.some(
        item => (item.kind === 'warcraft3-classic-archive' || item.kind === 'warcraft3-build-identity') && item.found,
      ),
    )?.installPath
  }
  const build = installation === undefined ? undefined : installationBuild(installation)
  const reforged = build?.product === 'w3' || build?.product === 'w3t' ? build : undefined
  const classic =
    installation !== undefined &&
    reforged === undefined &&
    (await readdir(installation).catch(() => [] as string[])).some(name => name.toLowerCase() === CHAIN[0])
  if (reforged === undefined && !classic) installation = undefined
  const artSet: Warcraft3ArtSet = options['artSet'] === 'sd' ? 'sd' : 'hd'
  const locale = typeof options['locale'] === 'string' && /^[a-z]{4}$/iu.test(options['locale']) ? options['locale'] : 'enus'
  const cacheDirectory = context.indexCacheDirectory
  const cache =
    cacheDirectory === undefined
      ? undefined
      : { directory: cacheDirectory, names: (product: string) => indexCacheEnabled(context.indexCaches, product, 'names') }
  const storage = installation
  // The root's archives as last opened: the context asks them for paths they answer but do not list.
  let opened: readonly (LayerArchive & { resolve?(path: string): string | undefined })[] = []
  // Reforged: the storage's view, which also gives a map's tileset overlays.
  let view: Awaited<ReturnType<typeof openReforgedView>> | undefined
  const answers = async (path: string): Promise<string | undefined> => {
    if (opened.length === 0) await game.list(ROOT_ID, '').catch(() => undefined)
    for (const archive of opened) {
      if (archive.resolve !== undefined) {
        const stored = archive.resolve(path)
        if (stored !== undefined) return stored
      } else if ((await archive.lookup?.(path)) !== undefined) return path
    }
    return undefined
  }
  const game = createLayeredArchiveContentSources(
    'Warcraft III',
    storage === undefined
      ? []
      : reforged !== undefined
        ? [
            {
              root: {
                id: ROOT_ID,
                label: `Warcraft III: Reforged — ${artSet === 'hd' ? 'HD' : 'SD'}, ${locale}`,
                region: 'local',
                kind: 'local',
                storageOf: storage,
                game: 'warcraft3',
                revision: `${reforged.buildKey}:${artSet}:${locale}`,
                product: reforged.product,
                hiddenPaths: [TILESETS],
              },
              open: async () => {
                view = await openReforgedView(cascInstallationArchive(await openCascInstallation(storage, cache), 'storage'), { artSet, locale })
                const tilesets = view.tilesets.flatMap(letter => view!.tileset(letter).map(layer => underPrefix(layer, `${TILESETS}/${letter}`)))
                return (opened = [...view.layers, ...tilesets])
              },
            },
          ]
        : [
            {
              root: { id: ROOT_ID, label: 'Warcraft III — MPQ', region: 'local', kind: 'local', storageOf: storage, game: 'warcraft3' },
              open: async () => (opened = await openChain(storage)),
            },
          ],
  )
  const placement = new Warcraft3Placement(
    installation,
    game,
    answers,
    reforged === undefined
      ? undefined
      : async tileset => {
          if (view === undefined) await game.list(ROOT_ID, '').catch(() => undefined)
          return view?.tileset(tileset) ?? []
        },
  )
  return {
    ...game,
    locateModPackage: target => placement.locateModPackage(target),
    openModContext: request => placement.openModContext(request),
  }
}
