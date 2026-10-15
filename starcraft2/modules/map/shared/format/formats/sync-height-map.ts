/**
 * t3SyncHeightMap — `mapSyncHeightMap`, magic `SMAP`.
 *
 * ```c
 * struct Header {
 *   char magic[4]; uint32 version; uint32 sizeX; uint32 sizeY;
 *   uint8 padding[12]; uint32 unknown[3]; uint8 padding2[24];   // 48 bytes total, preserved
 * };
 * struct Chunk { int16 height; uint16 mask; };   // height is SIGNED, /256 = fractional level
 * ```
 *
 * Byte-exact round-trip: `version`, the 48-byte post-dimension header region
 * (`_raw.headerExtra`) and any trailing bytes are preserved verbatim.
 */

import { Cursor, Writer } from '../binary.js'

export const SYNC_HEIGHT_MAGIC = 'SMAP'
const HEADER_EXTRA = 48 // padding[12] + unknown[3]*4 + padding2[24]

export interface SyncHeightCell {
  height: number // int16 (signed); divide by 256 for fractional level offset
  mask: number // uint16
}

export interface SyncHeightResult {
  sizeX: number
  sizeY: number
  version: number
  cells: SyncHeightCell[]
  _raw: { headerExtra: Uint8Array; trailing: Uint8Array }
}

export function readSyncHeightMap(data: Uint8Array): SyncHeightResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== SYNC_HEIGHT_MAGIC) {
    throw new Error(`Invalid SMAP: bad magic "${magic}" (expected "${SYNC_HEIGHT_MAGIC}")`)
  }
  const version = c.u32()
  const sizeX = c.u32()
  const sizeY = c.u32()
  const headerExtra = c.bytesOf(HEADER_EXTRA)

  const count = sizeX * sizeY
  const cells: SyncHeightCell[] = new Array(count)
  for (let i = 0; i < count; i++) {
    cells[i] = { height: c.i16(), mask: c.u16() }
  }
  return { sizeX, sizeY, version, cells, _raw: { headerExtra, trailing: c.rest() } }
}

export function writeSyncHeightMap(map: SyncHeightResult): Uint8Array {
  const expected = map.sizeX * map.sizeY
  if (map.cells.length !== expected) {
    throw new Error(`SMAP cell count ${map.cells.length} ≠ sizeX*sizeY (${expected})`)
  }
  const w = new Writer(64 + expected * 4 + map._raw.trailing.length)
  w.ascii(SYNC_HEIGHT_MAGIC).u32(map.version).u32(map.sizeX).u32(map.sizeY).raw(map._raw.headerExtra)
  for (const cell of map.cells) {
    w.i16(cell.height).u16(cell.mask)
  }
  return w.raw(map._raw.trailing).done()
}
