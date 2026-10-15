/**
 * t3SyncCliffLevel — `mapSyncCliffLevel`, magic `CLIF`.
 *
 * ```c
 * struct Header { char magic[4]; uint32 version; uint32 sizeX; uint32 sizeY; uint32 zero[4]; };
 * uint16 height[sizeX * sizeY];   // unsigned, row-major
 * ```
 *
 * Simplified cliff-level integer map (companion to the height maps).
 * Byte-exact round-trip: `version`, the 16-byte zero region (`_raw.padding`)
 * and any trailing bytes are preserved verbatim.
 */

import { Cursor, Writer } from '../binary.js'

export const SYNC_CLIFF_MAGIC = 'CLIF'
const HEADER_PADDING = 16 // zero[4]

export interface CliffLevelResult {
  sizeX: number
  sizeY: number
  version: number
  /** uint16, row-major (`y * sizeX + x`). */
  heights: number[]
  _raw: { padding: Uint8Array; trailing: Uint8Array }
}

export function readSyncCliffLevel(data: Uint8Array): CliffLevelResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== SYNC_CLIFF_MAGIC) {
    throw new Error(`Invalid CLIF: bad magic "${magic}" (expected "${SYNC_CLIFF_MAGIC}")`)
  }
  const version = c.u32()
  const sizeX = c.u32()
  const sizeY = c.u32()
  const padding = c.bytesOf(HEADER_PADDING)

  const count = sizeX * sizeY
  const heights: number[] = new Array(count)
  for (let i = 0; i < count; i++) heights[i] = c.u16()

  return { sizeX, sizeY, version, heights, _raw: { padding, trailing: c.rest() } }
}

/**
 * Engine dequantization (`t3SyncCliffLevel__Read`): the raw uint16 is clamped
 * up to the map's base cliff level (`base << 6`), then rounded to a 4-bit
 * cliff level: `(clamped + 8) >> 4`.
 */
export function dequantizeCliffLevel(raw: number, baseCliffLevel = 0): number {
  const floor = baseCliffLevel << 6
  const clamped = Math.max(raw, floor)
  return ((clamped + 8) >> 4) & 0xffff
}

export function writeSyncCliffLevel(map: CliffLevelResult): Uint8Array {
  const expected = map.sizeX * map.sizeY
  if (map.heights.length !== expected) {
    throw new Error(`CLIF height count ${map.heights.length} ≠ sizeX*sizeY (${expected})`)
  }
  const w = new Writer(32 + expected * 2 + map._raw.trailing.length)
  w.ascii(SYNC_CLIFF_MAGIC).u32(map.version).u32(map.sizeX).u32(map.sizeY).raw(map._raw.padding)
  for (const h of map.heights) w.u16(h)
  return w.raw(map._raw.trailing).done()
}
