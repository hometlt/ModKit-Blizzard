/**
 * The content sources a host configured — the installation folder, the game's CASC storage, the
 * player's documents, editor add-on folders — as storage for the mod loader.
 *
 * The loader reads nothing on its own: every layer comes out of one of these sources, by the path
 * that source gives it (`Mods/Core.SC2Mod` in CASC, `Mods/AllRaces2-Data.SC2Mod` in the
 * installation folder). That path is what a context reports, so a file is always traceable to the
 * place it came from.
 *
 * A packed package (an `.SC2Mod` or `.SC2Map` file rather than a folder) needs nothing here: the
 * content sources already list and read inside it as a folder, through the MPQ codec's reader.
 * The Mod owner retains recoverable source listings through loader-metadata-cache: at most 4096
 * pending/settled directories and 8MiB of accounted UTF-16 names/slots across an environment's
 * sources, add-ons and host folders. A standalone reader owns 256 directories/8MiB privately.
 * Oversized/evicted listings remain complete; forget/close release only this reader's namespace.
 * These are metadata limits, not raw file, active model or process heap/RSS budgets.
 * Point reads resolve native spelling through directory entries, without enumerating a whole
 * package after its complete listing was evicted. Missing/unlisted paths remain unreadable.
 * A source keeping a sorted name index (CASC) lists a package in one pass (`listFiles`), the same
 * names a folder walk finds; a rebuilt layer table then costs a scan, not a walk of every folder.
 */
import type { ResolverSource } from './resolver.js'
import type { BaseReader, Protocol } from './vfs.js'
import { LoaderMetadataCache } from './loader-metadata-cache.js'

/** What the loader needs of a content source: list a folder, read a file, both by source path. */
export interface ContentSourceStorage {
  readonly id: string
  /**
   * Names all of the source's content: while it is the same, so is every file (CASC — the
   * installation's build). Its layers get a fingerprint, which lets a host call a language snapshot
   * over them complete; a folder on disk has none.
   */
  readonly revision?: string
  list(
    path: string,
  ): Promise<readonly { readonly name: string; readonly directory: boolean; readonly size?: number }[]>
  /**
   * Every file under `path`, relative to it, as walking `list` would find them, in one pass over an
   * index the source keeps (CASC); undefined where it cannot answer. Sources without one are walked.
   */
  listFiles?(path: string): Promise<readonly string[] | undefined>
  /**
   * The files under `path` (relative to it, spelled as `listFiles` spells them) with one of these
   * extensions (lower case, no dot) whose bytes the source holds; undefined where every listed file
   * is held. CASC lists names only its CDN holds (another locale), and reading one downloads it: the
   * mod server's language sets keep to the installed files, as the host's language snapshot does.
   */
  installedFiles?(path: string, extensions: readonly string[]): Promise<readonly string[] | undefined>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  /** Called when the loader drops the source; only sources the loader made itself have one. */
  dispose?(): Promise<void>
}

const PACKAGE = /\.(sc2mod|sc2map|sc2campaign)$/iu
/** Packages are found where the game keeps them; the rest of a source is not searched for them. */
const PACKAGE_FOLDERS = ['Mods', 'Maps', 'Campaigns']
/** The content sources refuse a single read past 64 MiB; nothing a package holds is larger. */
const MAXIMUM_FILE = 64 * 1024 * 1024

const trim = (path: string): string => path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The Mod owner's one directory-retention policy, shared by a loader generation or owned alone. */
export function createSourceListingCache(maximumEntries = 256): LoaderMetadataCache<Awaited<ReturnType<ContentSourceStorage['list']>>> {
  return new LoaderMetadataCache(
    maximumEntries, 8 * 1024 * 1024,
    entries => entries.reduce((weight, entry) => weight + entry.name.length * 2 + 32, 0),
  )
}

/** A content source as a loader file system; recoverable names use bounded LRU retention. */
export class ContentSourceReader implements BaseReader {
  constructor(
    private readonly storage: ContentSourceStorage,
    private readonly listings = createSourceListingCache(),
    private readonly namespace = '',
  ) {}

  /** Drop the kept listings: the source changed (a file added to an open package). */
  forget(): void {
    this.listings.deletePrefix(this.namespace)
  }

  entries(path: string): ReturnType<ContentSourceStorage['list']> {
    const key = trim(path)
    return this.listings.get(`${this.namespace}${key}`, () => this.storage.list(key))
  }

  /** Every file under `path`, relative to it: from the source's index when it keeps one, else walked. */
  async list(path: string): Promise<string[]> {
    const indexed = await this.storage.listFiles?.(trim(path))
    if (indexed !== undefined) return [...indexed]
    const files: string[] = []
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await this.entries(directory)) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.directory) await walk(directory === '' ? entry.name : `${directory}/${entry.name}`, relative)
        else files.push(relative)
      }
    }
    await walk(trim(path), '')
    return files
  }

  async get(path: string): Promise<Uint8Array> {
    return this.storage.read(trim(path), MAXIMUM_FILE)
  }

  /** Read only a listed file, resolving each segment's native spelling within its layer root. */
  async readListed(root: string, filePath: string): Promise<Uint8Array | undefined> {
    const names = filePath.replace(/\\/gu, '/').replace(/^\/+/u, '').split('/')
    if (names.some(name => name === '' || name === '.' || name === '..')) return undefined
    let directory = trim(root)
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!.toLowerCase(), last = index === names.length - 1
      const hit = (await this.entries(directory))
        .filter(entry => entry.name.toLowerCase() === name && entry.directory !== last)
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0).at(-1)
      if (hit === undefined) return undefined
      directory = directory === '' ? hit.name : `${directory}/${hit.name}`
    }
    return this.get(directory)
  }

  async getText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.get(path))
  }

  async exists(path: string): Promise<boolean> {
    const key = trim(path)
    if (key === '') return true
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    const name = baseName(key).toLowerCase()
    const entries = await this.entries(parent).catch(() => [])
    return entries.some(entry => entry.name.toLowerCase() === name)
  }

  async close(): Promise<void> {
    this.forget()
    await this.storage.dispose?.()
  }
}

/**
 * Finds a package in one content source: a qualified reference (`Mods/Void.SC2Mod`) in its own
 * folder, a bare name in `Mods`, `Maps` and `Campaigns`. A name with a package extension matches
 * only that kind — `Void.SC2Campaign` is never `Mods/Void.SC2Mod`; one without matches any kind.
 */
export function contentSourceResolver(
  protocol: Protocol,
  reader: ContentSourceReader,
  label: string,
): ResolverSource {
  return {
    label,
    async resolve(name) {
      const wanted = trim(name)
      const target = baseName(wanted).toLowerCase()
      const matches = (entry: string): boolean =>
        PACKAGE.test(target)
          ? entry.toLowerCase() === target
          : PACKAGE.test(entry) && entry.toLowerCase().replace(PACKAGE, '') === target
      const folders = wanted.includes('/') ? [wanted.slice(0, wanted.lastIndexOf('/'))] : PACKAGE_FOLDERS
      for (const folder of folders) {
        const hit = (await reader.entries(folder).catch(() => [])).find(entry => matches(entry.name))
        // Every SC2 storage is case-insensitive; a named package keeps the reference's spelling
        // (CASC lists `core.sc2mod`, the game and its files say `Core.SC2Mod`).
        if (hit !== undefined) return `${protocol}${folder}/${PACKAGE.test(target) ? baseName(wanted) : hit.name}`
      }
      return undefined
    },
  }
}
