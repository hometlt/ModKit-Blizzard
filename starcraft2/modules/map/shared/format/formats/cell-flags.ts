/**
 * t3CellFlags — `mapCellFlags`, magic `LFCT`.
 *
 * ```c
 * struct Header {
 *   char magic[4]; uint32 version; uint32 zero[4];   // <- 16-byte zero region
 *   uint32 sizeX; uint32 sizeY;                       // dimensions come AFTER the zeros
 * };
 * uint8 types[sizeX * sizeY];   // 0x00 normal, 0x01 red (near ramps), 0x02 yellow, 0x03 cliff hole
 * ```
 *
 * `0x03` punches holes in terrain for cliff models. Byte-exact round-trip:
 * `version`, the 16-byte zero region and any trailing bytes are preserved.
 */

import { Cursor, Writer } from '../binary.js'

export const CELL_FLAGS_MAGIC = 'LFCT'
const HEADER_ZERO = 16 // zero[4]

export interface CellFlagsResult {
  sizeX: number
  sizeY: number
  version: number
  /** One byte per cell, row-major (`y * sizeX + x`). */
  types: Uint8Array
  _raw: { zero: Uint8Array; trailing: Uint8Array }
}

export function readCellFlags(data: Uint8Array): CellFlagsResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== CELL_FLAGS_MAGIC) {
    throw new Error(`Invalid LFCT: bad magic "${magic}" (expected "${CELL_FLAGS_MAGIC}")`)
  }
  const version = c.u32()
  const zero = c.bytesOf(HEADER_ZERO)
  const sizeX = c.u32()
  const sizeY = c.u32()

  const types = c.bytesOf(sizeX * sizeY)
  return { sizeX, sizeY, version, types, _raw: { zero, trailing: c.rest() } }
}

export function writeCellFlags(map: CellFlagsResult): Uint8Array {
  const expected = map.sizeX * map.sizeY
  if (map.types.length !== expected) {
    throw new Error(`LFCT type count ${map.types.length} ≠ sizeX*sizeY (${expected})`)
  }
  const w = new Writer(32 + expected + map._raw.trailing.length)
  w.ascii(CELL_FLAGS_MAGIC).u32(map.version).raw(map._raw.zero).u32(map.sizeX).u32(map.sizeY)
  return w.raw(map.types).raw(map._raw.trailing).done()
}
