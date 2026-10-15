/**
 * An MPQ archive on disk, for the games whose installation is a chain of MPQ files (Warcraft III,
 * StarCraft) — one owner for what `local:warcraft3` and the StarCraft content source both need.
 *
 * `openMpqFile` opens the file through one handle read by position and the MPQ reader over it: the
 * header, the tables and the entries asked for, never the whole archive. `openMpqArchiveLayer`
 * presents it as a layer of `createLayeredArchiveContentSources` (`@modkit/vfs/content-sources`):
 * the named entries, a lookup by path through the hash table for what no (listfile) names — a
 * patch archive carries none — and bounded reads. The limits are the caller's.
 */
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ByteRangeSource } from '@modkit/sdk'
import { openMpqReader, type MpqReader } from '@modkit/blizzard-mpq/reader'

export interface MpqFileLimits {
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly signal?: AbortSignal
}

/** An MPQ reader over a file on disk; `close` releases the reader and the file. */
export interface MpqFile extends MpqReader {
  close(): Promise<void>
}

/** A file on disk as a byte range source: one handle, positional reads. */
async function fileRanges(path: string): Promise<ByteRangeSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r')
  try {
    const size = BigInt((await handle.stat()).size)
    return {
      size: async () => size,
      async read(offset, length, signal) {
        signal?.throwIfAborted()
        const bytes = new Uint8Array(length)
        for (let done = 0; done < length; ) {
          const { bytesRead } = await handle.read(bytes, done, length - done, Number(offset) + done)
          if (bytesRead === 0) throw new RangeError(`${path} ended before byte ${String(Number(offset) + length)}`)
          done += bytesRead
        }
        return bytes
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** The MPQ archive at `path`, read by range; the file closes again when the archive does not open. */
export async function openMpqFile(path: string, limits: MpqFileLimits): Promise<MpqFile> {
  const file = await fileRanges(path)
  let reader: MpqReader
  try {
    reader = await openMpqReader(file, limits)
  } catch (error) {
    await file.close()
    throw error
  }
  return {
    entries: reader.entries,
    ...(reader.preamble === undefined ? {} : { preamble: reader.preamble }),
    get retainedBytes() {
      return reader.retainedBytes
    },
    recovered: reader.recovered,
    headerRepaired: reader.headerRepaired,
    find: wanted => reader.find(wanted),
    read: (id, signal) => reader.read(id, signal),
    dispose: () => reader.dispose(),
    close: async () => {
      reader.dispose()
      await file.close()
    },
  }
}

/** The shape of a `@modkit/vfs` `LayerArchive`, which this package does not depend on. */
export interface MpqArchiveLayer {
  readonly id: string
  readonly entries: readonly { readonly path: string; readonly size: number; readonly hidden?: true }[]
  lookup(path: string): Promise<{ readonly path: string; readonly size: number } | undefined>
  read(path: string, maxBytes: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** Entries the hash table holds without a name: readable by path, but nothing to list them by. */
const UNNAMED = /^block\/\d+$/u
const normalized = (path: string) => path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')

/** One archive as a layer: named entries, and the hash table for a path it does not name. */
export async function openMpqArchiveLayer(path: string, limits: MpqFileLimits): Promise<MpqArchiveLayer> {
  const archive = await openMpqFile(path, limits)
  const name = basename(path)
  const entry = (wanted: string) => archive.find(normalized(wanted))
  return {
    id: name,
    entries: archive.entries
      .filter(item => !UNNAMED.test(item.path))
      .map(item => ({ path: item.path, size: item.size, ...(item.hidden ? { hidden: true as const } : {}) })),
    async lookup(wanted) {
      const found = entry(wanted)
      return found === undefined ? undefined : { path: normalized(wanted), size: found.size }
    },
    async read(wanted, maxBytes) {
      const found = entry(wanted)
      if (found === undefined) throw new RangeError(`${name} has no «${wanted}»`)
      if (found.size > maxBytes) throw new RangeError(`«${wanted}» is ${String(found.size)} bytes, more than ${String(maxBytes)}`)
      return archive.read(found.id)
    },
    close: () => archive.close(),
  }
}
