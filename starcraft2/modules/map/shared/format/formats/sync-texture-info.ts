/**
 * Parser and writer for the `t3SyncTextureInfo` file (also `mapSyncTextureInfo`)
 * embedded in `.SC2Map` archives.
 *
 * Binary format (RTXT):
 *   - 4-byte ASCII magic: "RTXT"
 *   - uint32 LE version (observed: 100)
 *   - uint32 LE sizeX  — map width in cells
 *   - uint32 LE sizeY  — map height in cells
 *   - Null-terminated ASCII texture name strings (no count; the section occupies
 *     all bytes from offset 16 to `fileSize − sizeX × sizeY × 4`)
 *   - Per-cell uint32 LE data: sizeX × sizeY entries, one per map cell
 *     (observed values appear to be 0-based texture layer indices)
 *
 * Round-trip is byte-exact: texture names and raw cell bytes are both stored
 * verbatim and reproduced identically on write.
 *
 * Browser-safe: DataView only, zero external dependencies.
 */

import { Cursor, Writer } from '../binary.js'

export const SYNC_TEXTURE_INFO_MAGIC = 'RTXT'

export interface SyncTextureInfoResult {
  version: number
  sizeX: number
  sizeY: number
  /** Texture names in declaration order. */
  textureNames: string[]
  /**
   * Per-cell data: `sizeX × sizeY` uint32 values.
   * Cell `(x, y)` is at index `y * sizeX + x`.
   */
  cells: Uint32Array
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8')

export function readSyncTextureInfo(buf: Uint8Array): SyncTextureInfoResult {
  const cur = new Cursor(buf)

  const magic = cur.ascii(4)
  if (magic !== SYNC_TEXTURE_INFO_MAGIC) {
    throw new Error(`readSyncTextureInfo: expected magic "${SYNC_TEXTURE_INFO_MAGIC}", got "${magic}"`)
  }

  const version = cur.u32()
  const sizeX = cur.u32()
  const sizeY = cur.u32()

  // The per-cell section is exactly sizeX * sizeY * 4 bytes at the end of the
  // file. Everything between the 16-byte header and that section is texture names.
  const cellByteCount = sizeX * sizeY * 4
  const cellDataStart = buf.length - cellByteCount
  if (cellDataStart < 16) {
    throw new Error(
      `readSyncTextureInfo: file too small (${buf.length} bytes) for ${sizeX}×${sizeY} cell grid`,
    )
  }

  // Decode null-terminated texture names
  const textureNames: string[] = []
  const nameSection = buf.subarray(16, cellDataStart)
  let offset = 0
  while (offset < nameSection.length) {
    let end = offset
    while (end < nameSection.length && nameSection[end] !== 0) end++
    const name = utf8.decode(nameSection.subarray(offset, end))
    if (name) textureNames.push(name)
    offset = end + 1
  }

  // Per-cell uint32 array
  const cellView = new DataView(buf.buffer, buf.byteOffset + cellDataStart, cellByteCount)
  const cells = new Uint32Array(sizeX * sizeY)
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cellView.getUint32(i * 4, true)
  }

  return { version, sizeX, sizeY, textureNames, cells }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const utf8enc = new TextEncoder()

export function writeSyncTextureInfo(data: SyncTextureInfoResult): Uint8Array {
  // Encode texture names to bytes
  const nameBytes: Uint8Array[] = data.textureNames.map((n) => {
    const enc = utf8enc.encode(n)
    const withNull = new Uint8Array(enc.length + 1)
    withNull.set(enc)
    return withNull
  })
  const nameSectionSize = nameBytes.reduce((s, b) => s + b.length, 0)

  const cellByteCount = data.sizeX * data.sizeY * 4
  const totalSize = 16 + nameSectionSize + cellByteCount

  const w = new Writer(totalSize)
  // Magic
  w.ascii(SYNC_TEXTURE_INFO_MAGIC)
  w.u32(data.version)
  w.u32(data.sizeX)
  w.u32(data.sizeY)
  // Texture names
  for (const nb of nameBytes) w.raw(nb)
  // Cell data
  for (let i = 0; i < data.cells.length; i++) w.u32(data.cells[i]!)

  return w.done()
}
