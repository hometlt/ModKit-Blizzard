/**
 * Warcraft III Reforged storage as the layers the game reads, over the shared CASC installation
 * reader of `@modkit/blizzard-casc`.
 *
 * Reforged keeps every file of the game in one CASC storage, named by nested `.w3mod` manifests:
 * `war3.w3mod:units/...` is the base, `war3.w3mod:_hd.w3mod:units/...` the Reforged (HD) art that
 * replaces it, `war3.w3mod:_locales/enus.w3mod:...` and `war3.w3mod:_hd.w3mod:_locales/enus.w3mod:...`
 * the localized files over each. The game resolves a path such as `Units\Human\Footman\Footman.mdx`
 * through those overlays, highest first; this module gives each overlay as one `LayerArchive` whose
 * entries are the overlay's own paths, so the layered-archive helper of `@modkit/vfs` shows the
 * game's view: each path once, served by the overlay the game reads it from.
 *
 * Choices the game makes from its settings are options here: the art set (`hd`, the default, or
 * `sd` — the classic art, base overlays only) and the locale (`enus` unless set). The tileset
 * overlays a map applies (`_tilesets/<letter>.w3mod`, under the HD overlay and the base: the cliffs,
 * splats and bridges of the map's tileset) are given apart, by `openReforgedView`'s `tileset` and
 * `tilesets`: the content source serves them under `_tilesets/<letter>/` and a map's context reads
 * its own over the game. Overlays the game applies per mode are not in the tree: the teen art
 * (`_teen.w3mod`), balance sets (`_balance/*.w3mod`) and the retired `_deprecated.w3mod`. Their files stay readable through the storage itself (`local:casc`
 * style `storageOf` mounting) but are not merged into this view.
 *
 * A model keeps naming the classic texture: `Textures\Black32.blp`, while Reforged ships
 * `textures/black32.dds`, and some files moved (`SharedModels\Dust3.blp` → `Textures\Dust3.blp`,
 * the `filealiases.json` of the base manifest). An overlay answers such a path as the game does:
 * the path itself, else its alias, each tried as written and with `.dds` for `.blp`, `.tga`, `.tif` or `.png`. That
 * answer is `lookup` (a path the overlay does not list) and `read` by the asked path; the bytes are
 * the stored file's, so a `.blp` path can carry DDS bytes, which the texture codecs tell by magic.
 * The manifests themselves (`*.w3mod` entries) are not files of the view.
 *
 * The reader is opened once and shared by every overlay; closing the base overlay closes it, as
 * the helper closes all of a root's archives together.
 */
import type { LayerArchive, LayerArchiveEntry } from '@modkit/vfs/content-sources'

/** What `cascInstallationArchive` gives: every name of the storage and a reader by full name. */
export interface StorageArchive {
  readonly entries: readonly { readonly path: string; readonly size: number }[]
  read(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}

export type Warcraft3ArtSet = 'hd' | 'sd'

/** An overlay; `resolve` names the stored file the game reads for a path, as the view lists it. */
export interface ReforgedLayer extends LayerArchive {
  resolve(path: string): string | undefined
}

export interface ReforgedViewOptions {
  readonly artSet?: Warcraft3ArtSet
  /** The game's locale folder name, `enus`, `dede`, `ruru` … */
  readonly locale?: string
}

const BASE = 'war3.w3mod:'
const HD = `${BASE}_hd.w3mod:`
const ALIASES = 'filealiases.json'
const MAX_ALIASES_BYTES = 4 << 20

const keyOf = (path: string) => path.replace(/\\/gu, '/').replace(/^\/+/u, '').toLowerCase()
/**
 * The spellings the game tries for a texture: as written, then the Reforged `.dds`. HD models name
 * their art by the source file (`Human_Footman_Main_Diffuse.tif`), classic ones by `.blp`/`.tga`.
 */
const spellings = (path: string): readonly string[] => {
  const key = keyOf(path)
  return /\.(?:blp|tga|tif|tiff|png)$/u.test(key) ? [key, key.replace(/\.[a-z]+$/u, '.dds')] : [key]
}

/** `filealiases.json`: `[{ src, dest }]`, the old path the game still accepts and the file it reads. */
export function parseFileAliases(text: string): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) return aliases
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const { src, dest } = item as { src?: unknown; dest?: unknown }
    if (typeof src === 'string' && typeof dest === 'string' && !aliases.has(keyOf(src))) aliases.set(keyOf(src), keyOf(dest))
  }
  return aliases
}

/** The overlay prefixes the game reads, highest first. */
export function reforgedOverlays(options: ReforgedViewOptions = {}): readonly string[] {
  const locale = (options.locale ?? 'enus').toLowerCase()
  const localized = (prefix: string) => `${prefix}_locales/${locale}.w3mod:`
  const sd = [localized(BASE), BASE]
  return options.artSet === 'sd' ? sd : [localized(HD), HD, ...sd]
}

/** Whether a storage holds a Warcraft III Reforged tree (its base manifest names files). */
export function isReforgedStorage(storage: StorageArchive): boolean {
  return storage.entries.some(entry => entry.path.startsWith(BASE))
}

/**
 * One `LayerArchive` per overlay, highest first. An overlay's entries are the paths directly in
 * it — a path with another `:` belongs to a manifest nested inside it, which is its own overlay or
 * one the view leaves out. `aliases` is the game's `filealiases.json` (`parseFileAliases`).
 */
export function reforgedLayers(
  storage: StorageArchive,
  options: ReforgedViewOptions = {},
  aliases: ReadonlyMap<string, string> = new Map(),
): readonly ReforgedLayer[] {
  return overlayLayers(storage, reforgedOverlays(options), aliases)
}

/** The overlays of a tileset (`l` for Lordaeron Summer …), highest first: HD over the base's. */
export function reforgedTilesetOverlays(tileset: string, options: ReforgedViewOptions = {}): readonly string[] {
  const own = (prefix: string) => `${prefix}_tilesets/${tileset.toLowerCase()}.w3mod:`
  return options.artSet === 'sd' ? [own(BASE)] : [own(HD), own(BASE)]
}

/** One layer per overlay of `overlays`, highest first, each answering paths as the game reads them. */
function overlayLayers(
  storage: StorageArchive,
  overlays: readonly string[],
  aliases: ReadonlyMap<string, string>,
): readonly ReforgedLayer[] {
  const byOverlay = new Map<string, Map<string, LayerArchiveEntry>>(overlays.map(prefix => [prefix, new Map()]))
  for (const entry of storage.entries) {
    for (const prefix of overlays) {
      if (!entry.path.startsWith(prefix)) continue
      const path = entry.path.slice(prefix.length)
      if (!path.includes(':') && !path.endsWith('.w3mod')) byOverlay.get(prefix)!.set(keyOf(path), { path, size: entry.size })
      break
    }
  }
  return overlays.map(prefix => {
    const own = byOverlay.get(prefix)!
    /** The overlay's file the game reads for `path`, if any. */
    const resolve = (path: string): LayerArchiveEntry | undefined => {
      const alias = aliases.get(keyOf(path))
      for (const candidate of [...spellings(path), ...(alias === undefined ? [] : spellings(alias))]) {
        const found = own.get(candidate)
        if (found !== undefined) return found
      }
      return undefined
    }
    return {
      id: prefix.slice(0, -1),
      entries: [...own.values()],
      resolve: (path: string) => resolve(path)?.path,
      lookup: async (path: string) => {
        const found = resolve(path)
        return found === undefined ? undefined : { path, ...(found.size === undefined ? {} : { size: found.size }) }
      },
      read: (path: string, maxBytes: number, signal?: AbortSignal) => {
        const found = resolve(path)
        if (found === undefined) return Promise.reject(new RangeError(`${prefix.slice(0, -1)} has no «${path}»`))
        return storage.read(`${prefix}${found.path}`, maxBytes, signal)
      },
      // The base overlay owns the shared reader; the helper closes every archive of the root together.
      close: () => (prefix === BASE ? storage.close() : undefined),
    }
  })
}

/** The overlays of `storage` with the game's file aliases read from it (the base manifest's). */
export async function openReforgedLayers(storage: StorageArchive, options: ReforgedViewOptions = {}): Promise<readonly ReforgedLayer[]> {
  return (await openReforgedView(storage, options)).layers
}

/**
 * The game's overlays of `storage` (`layers`) and, for a map, its tileset's (`tileset`, made when
 * asked, over the same reader and file aliases; they never close the reader).
 */
export async function openReforgedView(
  storage: StorageArchive,
  options: ReforgedViewOptions = {},
): Promise<{
  readonly layers: readonly ReforgedLayer[]
  /** The tilesets the storage has overlays for, lower-case letters. */
  readonly tilesets: readonly string[]
  tileset(tileset: string): readonly ReforgedLayer[]
}> {
  const aliasesPath = `${BASE}${ALIASES}`
  const aliases = storage.entries.some(entry => entry.path === aliasesPath)
    ? parseFileAliases(new TextDecoder().decode(await storage.read(aliasesPath, MAX_ALIASES_BYTES)))
    : new Map<string, string>()
  const tilesets = new Set<string>()
  for (const entry of storage.entries) {
    const found = /^war3\.w3mod:(?:_hd\.w3mod:)?_tilesets\/([a-z])\.w3mod:/iu.exec(entry.path)
    if (found !== null) tilesets.add(found[1]!.toLowerCase())
  }
  return {
    layers: reforgedLayers(storage, options, aliases),
    tilesets: [...tilesets].sort(),
    tileset: tileset => overlayLayers(storage, reforgedTilesetOverlays(tileset, options), aliases),
  }
}
