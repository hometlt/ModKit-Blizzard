/**
 * StarCraft string table (`.tbl`: `rez\stat_txt.tbl`, `arr\images.tbl` and the other `arr` tables):
 * a u16 count, that many u16 offsets from the start of the file, and the strings they point at.
 *
 * The game reads a string up to its NUL. `stat_txt.tbl` keeps more after it for the editors: a unit's
 * name is followed by its group and subgroup (`Terran Marine\0Terran\0Ground Units\0`). An entry is
 * therefore everything from its offset to the next offset any entry starts at, split at NULs; the
 * first part is what the game shows. Offsets may repeat and need not be in order.
 */

export interface TblEntry {
  readonly index: number
  /** The NUL-separated parts, the game's string first; empty when the offset is out of the file. */
  readonly parts: readonly string[]
}

export interface StringTable {
  readonly entries: readonly TblEntry[]
  readonly diagnostics: readonly string[]
}

export function readTbl(bytes: Uint8Array, decode: (bytes: Uint8Array) => string): StringTable {
  if (bytes.byteLength < 2) throw new RangeError('a string table starts with a 2-byte count')
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = data.getUint16(0, true)
  if (2 + 2 * count > bytes.byteLength) throw new RangeError(`the table names ${String(count)} strings, more offsets than the file has`)
  const offsets = Array.from({ length: count }, (_, index) => data.getUint16(2 + 2 * index, true))
  const starts = [...new Set(offsets)].sort((left, right) => left - right)
  const diagnostics: string[] = []
  const entries = offsets.map((offset, index) => {
    if (offset < 2 + 2 * count || offset >= bytes.byteLength) {
      diagnostics.push(`string ${String(index + 1)} points at byte ${String(offset)}, outside the strings`)
      return { index, parts: [] }
    }
    const end = starts.find(start => start > offset) ?? bytes.byteLength
    const span = bytes.subarray(offset, end)
    const parts: string[] = []
    for (let from = 0; from < span.byteLength; ) {
      const nul = span.indexOf(0, from)
      const to = nul === -1 ? span.byteLength : nul
      parts.push(decode(span.subarray(from, to)))
      from = to + 1
    }
    // The terminator of the last part leaves no part of its own.
    while (parts.length > 1 && parts.at(-1) === '') parts.pop()
    return { index, parts }
  })
  return { entries, diagnostics }
}
