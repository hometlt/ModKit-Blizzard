import type { ByteRangeSource } from '@modkit/sdk'

export interface MpqReaderEntry {
  readonly id: string
  readonly path: string
  readonly size: number
  /** The archive's own bookkeeping — `(listfile)`, `(attributes)`, `(signature)`. */
  readonly hidden?: true
}

export interface MpqReader {
  readonly entries: readonly MpqReaderEntry[]
  /** The user-data payload before the MPQ header (a StarCraft II replay's header), when present. */
  readonly preamble?: Uint8Array
  /** Bytes the reader holds: the archive when it was given in memory, plus recovered blocks. */
  readonly retainedBytes: number
  readonly recovered: boolean
  /** The declared header size and version were junk and the base layout was assumed. */
  readonly headerRepaired: boolean
  /** An entry by path: a listed one, or one the hash table holds where no (listfile) names it. */
  find(path: string): MpqReaderEntry | undefined
  /** An entry by its listed id, or by path where the archive lists no name for it (no (listfile)). */
  read(id: string, signal?: AbortSignal): Promise<Uint8Array>
  dispose(): void
}

/**
 * `input` is the archive in memory — the caller owns the bytes and must not mutate them while the
 * reader is open — or a byte range source over it, from which only the header, the hash and block
 * tables and the entries asked for are read. `maxArchiveBytes` bounds bytes held in memory (and a
 * recovery scan, which needs the whole archive); `maxEntryBytes` bounds one entry.
 */
export function openMpqReader(input: Uint8Array | ByteRangeSource, options: {
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly signal?: AbortSignal
}): Promise<MpqReader>
