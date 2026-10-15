/**
 * t3FluffDoodad — `mapFluffDoodad`, magic `DLFT`.
 *
 * ```c
 * struct Header { char magic[4]; uint32 version; uint32 zero[4]; uint32 amount; }; // 28 bytes
 * struct Chunk  { float x; float y; uint8 type; };  // 9 bytes; type 0x00–0x07 (scrub/fluff variety)
 * ```
 *
 * Positions of auto-placed scrub/fluff decorations.
 * Byte-exact round-trip: `version`, the 16-byte zero region and any trailing bytes are preserved.
 */

import { Cursor, Writer } from '../binary.js'

export const FLUFF_DOODAD_MAGIC = 'DLFT'
const HEADER_ZERO = 16 // zero[4]

export interface FluffDoodad {
  x: number
  y: number
  type: number // 0x00–0x07
}

export interface FluffDoodadResult {
  version: number
  doodads: FluffDoodad[]
  _raw: { zero: Uint8Array; trailing: Uint8Array }
}

export function readFluffDoodad(data: Uint8Array): FluffDoodadResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== FLUFF_DOODAD_MAGIC) {
    throw new Error(`Invalid DLFT: bad magic "${magic}" (expected "${FLUFF_DOODAD_MAGIC}")`)
  }
  const version = c.u32()
  const zero = c.bytesOf(HEADER_ZERO)
  const amount = c.u32()

  const doodads: FluffDoodad[] = new Array(amount)
  for (let i = 0; i < amount; i++) {
    doodads[i] = { x: c.f32(), y: c.f32(), type: c.u8() }
  }
  return { version, doodads, _raw: { zero, trailing: c.rest() } }
}

export function writeFluffDoodad(map: FluffDoodadResult): Uint8Array {
  const w = new Writer(28 + map.doodads.length * 9 + map._raw.trailing.length)
  w.ascii(FLUFF_DOODAD_MAGIC).u32(map.version).raw(map._raw.zero).u32(map.doodads.length)
  for (const d of map.doodads) w.f32(d.x).f32(d.y).u8(d.type)
  return w.raw(map._raw.trailing).done()
}
