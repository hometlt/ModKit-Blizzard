/**
 * An installed game's CASC storage opened from its folder, for content sources of any CASC game
 * (StarCraft II, StarCraft: Remastered, Diablo III…): the files, the name index kept between
 * windows, and the whole storage as one archive of `createLayeredArchiveContentSources`.
 *
 * Online (the default), a file the install names but does not hold — another locale, content the
 * agent streams in later — is read from Blizzard's CDN as the game reads it: the archive and range
 * from the install's own archive index (`cdn-archives.ts`), then kept in the cache directory's
 * `cdn` folder, so each file is downloaded once. Offline such a read is refused as before.
 */
import { readFileSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CascReader, cascProductOf, cdnFetch, getActiveBuild, parseBuildInfo, type CascCdnCache, type CascFileSource, type CascReaderOptions } from '@modkit/blizzard-casc'
import {
  canonicalInstallation, cascGameOf, createInstallationRootCache, installationCacheFolder, removeLegacyCache,
} from '@modkit/blizzard-casc/root-cache-node'
import { cdnArchiveLocator } from './cdn-archives.js'

/** Where the name index is kept between windows. */
export interface CascInstallationCache {
  /** The host's shared index cache directory; the `blizzard/casc` codec keeps the same installation's index there. */
  readonly directory: string
  /** Where the index lay before the shared directory, removed on first use. */
  readonly legacy?: string
  /** Whether the user keeps the name index of a product (sdk `indexCacheEnabled(switches, product, 'names')`); on without it. */
  readonly names?: (product: string) => boolean
}

/** What a content source root says of the installation: `revision`, `product` and `game`. */
export interface CascInstallationBuild {
  readonly buildKey: string
  readonly product: string
  readonly game: string
}

/** The active build of `.build.info`, or nothing while the file is missing or being rewritten. */
export function installationBuild(installation: string, wanted?: string): CascInstallationBuild | undefined {
  try {
    const build = getActiveBuild(parseBuildInfo(readFileSync(join(installation, '.build.info'), 'utf8')), wanted)
    const product = cascProductOf(build)
    return { buildKey: build.buildKey, product, game: cascGameOf(product) }
  } catch {
    return undefined
  }
}

/** Installation-relative reads for the CASC reader; data files stay open between range reads. */
export function installationFiles(root: string): CascFileSource {
  const handles = new Map<string, Promise<FileHandle>>()
  const at = (path: string) => join(root, ...path.split(/[\\/]+/u).filter(Boolean))
  const handle = (path: string) => {
    let opened = handles.get(path)
    if (opened === undefined) {
      opened = open(at(path), 'r')
      opened.catch(() => handles.delete(path))
      handles.set(path, opened)
    }
    return opened
  }
  return {
    async list(path) {
      return (await readdir(at(path), { withFileTypes: true })).filter(item => item.isFile()).map(item => item.name).sort()
    },
    async get(path) { return new Uint8Array(await readFile(at(path))) },
    async getRange(path, offset, length) {
      const file = await handle(path), bytes = new Uint8Array(length)
      for (let done = 0; done < length;) {
        const { bytesRead } = await file.read(bytes, done, length - done, offset + done)
        if (!bytesRead) throw new Error(`${path} ended before byte ${offset + length}`)
        done += bytesRead
      }
      return bytes
    },
    exists: path => lstat(at(path)).then(() => true, () => false),
    async close() {
      const pending = [...handles.values()]
      handles.clear()
      await Promise.allSettled(pending.map(async file => (await file).close()))
    },
  }
}

/**
 * Files read from the CDN, one per encoding key (BLTE bytes as downloaded). Content-addressed, so a
 * game update does not stale them; written through a temporary file so a reader never sees half.
 */
function downloads(directory: string): CascCdnCache {
  const fileOf = (key: string) => {
    if (!/^[0-9a-f]{32}$/iu.test(key)) throw new Error('CASC encoding key must be 32 hex digits')
    return join(directory, key.slice(0, 2).toLowerCase(), key.toLowerCase())
  }
  return {
    load: async key => new Uint8Array(await readFile(fileOf(key))),
    async store(key, bytes) {
      const target = fileOf(key)
      await mkdir(join(target, '..'), { recursive: true })
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, bytes)
      await rename(temporary, target)
    },
  }
}

/**
 * The installed storage at `installation` (an absolute folder). With `cache` the parsed name index
 * is kept between windows until the game updates: ~2 s of MNDX parsing, 10–17 s of Diablo III
 * names, become a file read. `online: false` keeps every read local; `product` picks one of the
 * products a folder holds (World of Warcraft: `wow`, `wow_classic`…), the active row without it;
 * `wowListfile` names a WoW root's files, `encryptionKeys` are TACT keys by name.
 */
export async function openCascInstallation(
  installation: string,
  cache?: CascInstallationCache,
  options: {
    readonly online?: boolean
    readonly product?: string
    readonly wowListfile?: CascReaderOptions['wowListfile']
    readonly encryptionKeys?: CascReaderOptions['encryptionKeys']
  } = {},
): Promise<CascReader> {
  if (!isAbsolute(installation)) throw new Error('CASC installation must be an absolute folder')
  const log = { info: () => {}, warn: (message: string) => console.warn(message) }
  const identity = canonicalInstallation(installation)
  const rootCache = cache === undefined ? undefined : (product: string) =>
    cache.names?.(product) === false ? undefined
      : createInstallationRootCache(cache.directory, installation, log,
        { game: cascGameOf(product), product, kind: 'names', installation: identity })
  if (cache?.legacy !== undefined) await removeLegacyCache(cache.legacy, installation)
  const files = installationFiles(installation)
  try {
    return await CascReader.open(files, {
      ...(rootCache === undefined ? {} : { rootCache }),
      ...(options.product === undefined ? {} : { product: options.product }),
      ...(options.wowListfile === undefined ? {} : { wowListfile: options.wowListfile }),
      ...(options.encryptionKeys === undefined ? {} : { encryptionKeys: options.encryptionKeys }),
      ...(options.online === false ? {} : {
        cdnFetch,
        cdnArchives: cdnArchiveLocator,
        ...(cache === undefined ? {} : { cdnCache: downloads(join(cache.directory, installationCacheFolder(identity), 'cdn')) }),
      }),
    })
  } catch (error) {
    await files.close?.()
    throw error
  }
}

/**
 * The whole storage as one archive for `createLayeredArchiveContentSources` (`@modkit/vfs`): every
 * name of the index, lower-case as the index keeps it, with its size; `lookup` finds a path the
 * reader resolves without listing it. Closing it closes the reader.
 */
export function cascInstallationArchive(reader: CascReader, id: string): {
  readonly id: string
  readonly entries: readonly { readonly path: string; readonly size: number }[]
  lookup(path: string): Promise<{ readonly path: string; readonly size: number } | undefined>
  read(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
} {
  const index = reader.entryIndex
  const entries = Array.from({ length: index.size }, (_, row) => ({ path: index.keyAt(row), size: index.contentSizeAt(row) }))
  return {
    id,
    entries,
    // A path the reader resolves but does not list: WoW's `filedataid/<id>` of a named file.
    async lookup(path) {
      const size = reader.contentSizeOf(path)
      return size === undefined ? undefined : { path, size }
    },
    async read(path, maxBytes, signal) {
      const size = reader.contentSizeOf(path)
      if (size === undefined) throw new Error(`CASC file was not found: ${path}`)
      if (size > maxBytes) throw new Error(`CASC file ${path} exceeds the read limit (${size} > ${maxBytes} bytes)`)
      return reader.readPath(path, signal)
    },
    close: () => reader.close(),
  }
}
