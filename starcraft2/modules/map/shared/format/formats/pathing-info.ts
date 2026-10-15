/**
 * t3SyncPathingInfo — `mapPathingInfo`, magic `PATH`.
 *
 * ```c
 * struct Header { char magic[4]; uint32 version; uint32 sizeX; uint32 sizeY; uint8 padding[16]; };
 * uint16 block[sizeX * sizeY];   // row-major
 * ```
 *
 * Static pathing-hint grid. Common cell values: 0x00 passable, 0x02 ramp,
 * 0x23 impassable. (Note: editing these has no observed in-game effect.)
 *
 * Byte-exact round-trip: `version`, the 16-byte header padding and any trailing
 * bytes are preserved verbatim.
 */

import { Cursor, Writer } from '../binary.js'

export const PATHING_INFO_MAGIC = 'PATH'
const HEADER_PADDING = 16

export interface PathingInfoResult {
  sizeX: number
  sizeY: number
  version: number
  /** uint16 per cell, row-major (`y * sizeX + x`). */
  blocks: number[]
  _raw: { padding: Uint8Array; trailing: Uint8Array }
}

export function readPathingInfo(data: Uint8Array): PathingInfoResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== PATHING_INFO_MAGIC) {
    throw new Error(`Invalid PATH: bad magic "${magic}" (expected "${PATHING_INFO_MAGIC}")`)
  }
  const version = c.u32()
  const sizeX = c.u32()
  const sizeY = c.u32()
  const padding = c.bytesOf(HEADER_PADDING)

  const count = sizeX * sizeY
  const blocks: number[] = new Array(count)
  for (let i = 0; i < count; i++) blocks[i] = c.u16()

  return { sizeX, sizeY, version, blocks, _raw: { padding, trailing: c.rest() } }
}

export function writePathingInfo(map: PathingInfoResult): Uint8Array {
  const expected = map.sizeX * map.sizeY
  if (map.blocks.length !== expected) {
    throw new Error(`PATH block count ${map.blocks.length} ≠ sizeX*sizeY (${expected})`)
  }
  const w = new Writer(32 + expected * 2 + map._raw.trailing.length)
  w.ascii(PATHING_INFO_MAGIC).u32(map.version).u32(map.sizeX).u32(map.sizeY).raw(map._raw.padding)
  for (const b of map.blocks) w.u16(b)
  return w.raw(map._raw.trailing).done()
}
