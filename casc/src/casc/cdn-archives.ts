/**
 * Which CDN archive keeps a file the installation does not hold, and where in it.
 *
 * Blizzard's CDN keeps nearly every file of a build inside archives of a few hundred MB; a file is
 * read as one byte range of its archive, the way the game and the Battle.net agent fetch a file a
 * partial install lacks. The agent keeps what that needs on disk beside the local storage:
 *
 * - the build's CDN config, `<dataRoot>/config/xx/yy/<CDN Key>` (`archives` — the archive names in
 *   order; `archive-group` — the name of the merged index of all of them);
 * - that merged index, `<dataRoot>/indices/<archive-group>.index`: sorted 4 KiB blocks of
 *   `encoding key · size (BE) · archive number (BE, offsetBytes − 4 bytes) · offset (BE, 4 bytes)`,
 *   then the last key of every block, then a 28-byte footer naming those widths.
 *
 * Nothing here touches the network: {@link cdnArchiveLocator} only answers where to read. Portable
 * (no Node imports); the reader receives it as its `cdnArchives` option. An install without these
 * files answers nothing, and the reader falls back to the loose CDN object.
 */
import { parseConfig, type CascFileSource } from '@modkit/blizzard-casc'

/** One file's place on the CDN: the archive's name and the byte range of the file in it. */
export interface CdnArchivePlace {
  readonly archive: string
  readonly offset: number
  readonly size: number
}

export interface CdnArchiveLocator {
  /** The place of the file with this encoding key (32 hex digits), or nothing when no archive holds it. */
  locate(encodingKey: string, signal?: AbortSignal): Promise<CdnArchivePlace | undefined>
}

const FOOTER_BYTES = 28
const decoder = new TextDecoder()

/** A merged archive index read once into memory (18 MB for StarCraft II's ~720k files). */
interface ArchiveGroup {
  find(key: Uint8Array): CdnArchivePlace | undefined
}

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../gu) ?? [], pair => Number.parseInt(pair, 16))

/** Big-endian unsigned integer of `width` bytes (at most 6) at `at`. */
function readBE(bytes: Uint8Array, at: number, width: number): number {
  let value = 0
  for (let i = 0; i < width; i++) value = value * 256 + bytes[at + i]!
  return value
}

/** Byte order of `key` against `width` bytes of `bytes` at `at`. */
function compareKey(bytes: Uint8Array, at: number, key: Uint8Array, width: number): number {
  for (let i = 0; i < width; i++) {
    const difference = bytes[at + i]! - key[i]!
    if (difference !== 0) return difference
  }
  return 0
}

/** Parses the merged index once; refuses a footer whose widths it does not know. */
function archiveGroup(bytes: Uint8Array, archives: readonly string[]): ArchiveGroup {
  if (bytes.byteLength < FOOTER_BYTES) throw new Error('CDN archive group index is truncated')
  const footer = bytes.subarray(bytes.byteLength - FOOTER_BYTES)
  const blockBytes = footer[11]! * 1024
  const offsetBytes = footer[12]!
  const sizeBytes = footer[13]!
  const keyBytes = footer[14]!
  const hashBytes = footer[15]!
  if (footer[8] !== 1 || offsetBytes < 4 || offsetBytes > 6 || sizeBytes !== 4 || keyBytes !== 16 || blockBytes === 0) {
    throw new Error('CDN archive group index has an unknown layout')
  }
  const entryBytes = keyBytes + sizeBytes + offsetBytes
  const blocks = Math.floor((bytes.byteLength - FOOTER_BYTES) / (blockBytes + keyBytes + hashBytes))
  const tocAt = blocks * blockBytes
  return {
    find(key) {
      // The first block whose last key is not below the key.
      let low = 0
      let high = blocks
      while (low < high) {
        const middle = (low + high) >>> 1
        if (compareKey(bytes, tocAt + middle * keyBytes, key, keyBytes) < 0) low = middle + 1
        else high = middle
      }
      if (low >= blocks) return undefined
      const start = low * blockBytes
      for (let at = start; at + entryBytes <= start + blockBytes; at += entryBytes) {
        const order = compareKey(bytes, at, key, keyBytes)
        if (order > 0) return undefined
        if (order < 0) continue
        const archive = archives[readBE(bytes, at + keyBytes + sizeBytes, offsetBytes - 4)]
        if (archive === undefined) return undefined
        return {
          archive,
          size: readBE(bytes, at + keyBytes, sizeBytes),
          offset: readBE(bytes, at + keyBytes + sizeBytes + offsetBytes - 4, 4),
        }
      }
      return undefined
    },
  }
}

/** Reads the CDN config and the merged index the agent keeps; nothing when either is missing. */
async function openArchiveGroup(source: CascFileSource, dataRoot: string, cdnKey: string): Promise<ArchiveGroup | undefined> {
  const under = (path: string) => (dataRoot === '' ? path : `${dataRoot}/${path}`)
  const configPath = under(`config/${cdnKey.slice(0, 2)}/${cdnKey.slice(2, 4)}/${cdnKey}`)
  if (!(await source.exists(configPath))) return undefined
  const config = parseConfig(decoder.decode(await source.get(configPath)))
  const archives = (config.get('archives') ?? '').split(/\s+/u).filter(Boolean)
  const group = config.get('archive-group')?.trim()
  if (archives.length === 0 || !group) return undefined
  const indexPath = under(`indices/${group}.index`)
  if (!(await source.exists(indexPath))) return undefined
  return archiveGroup(await source.get(indexPath), archives)
}

/**
 * The locator the reader's `cdnArchives` option makes for one installation. The index is read on
 * the first file the install lacks, once; an install without it answers nothing from then on.
 */
export function cdnArchiveLocator(options: {
  readonly source: CascFileSource
  readonly dataRoot: string
  readonly cdnKey: string
}): CdnArchiveLocator {
  let opening: Promise<ArchiveGroup | undefined> | undefined
  return {
    async locate(encodingKey, signal) {
      opening ??= openArchiveGroup(options.source, options.dataRoot, options.cdnKey).catch(() => undefined)
      const group = await opening
      signal?.throwIfAborted()
      return /^[0-9a-f]{32}$/iu.test(encodingKey) ? group?.find(hexBytes(encodingKey)) : undefined
    },
  }
}
