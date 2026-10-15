/**
 * t3Water — `mapWater`, magic `WATR`.
 *
 * ```c
 * struct Header { char magic[4]; uint32 version; uint32 amount; uint32 zero[5]; }; // 32 bytes
 * struct Chunk  { char templateId[40]; float startX, startY, endX, endY; };        // 56 bytes
 * ```
 *
 * Liquid zones (water/lava). `templateId` references a `CWater` id in
 * `Base.SC2Data/GameData/WaterData.xml`.
 *
 * Byte-exact round-trip: `version`, the 20-byte zero region, the raw 40-byte
 * `templateId` field of every chunk (preserved as `templateIdBytes`, garbage
 * after the null terminator included) and any trailing bytes are all preserved.
 */

import { Cursor, Writer } from '../binary.js'

export const WATER_MAGIC = 'WATR'
const HEADER_ZERO = 20 // zero[5]
const TEMPLATE_ID_LEN = 40

const asciiDecoder = new TextDecoder('ascii')

export interface WaterZone {
  /** Decoded template id (bytes up to the first null). */
  templateId: string
  /** Raw 40-byte field, preserved for byte-exact write. */
  templateIdBytes: Uint8Array
  startX: number
  startY: number
  endX: number
  endY: number
}

export interface WaterResult {
  version: number
  zones: WaterZone[]
  _raw: { zero: Uint8Array; trailing: Uint8Array }
}

function decodeId(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0)
  return asciiDecoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul))
}

export function readWater(data: Uint8Array): WaterResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== WATER_MAGIC) {
    throw new Error(`Invalid WATR: bad magic "${magic}" (expected "${WATER_MAGIC}")`)
  }
  const version = c.u32()
  const amount = c.u32()
  const zero = c.bytesOf(HEADER_ZERO)

  const zones: WaterZone[] = new Array(amount)
  for (let i = 0; i < amount; i++) {
    const templateIdBytes = c.bytesOf(TEMPLATE_ID_LEN)
    zones[i] = {
      templateId: decodeId(templateIdBytes),
      templateIdBytes,
      startX: c.f32(),
      startY: c.f32(),
      endX: c.f32(),
      endY: c.f32(),
    }
  }
  return { version, zones, _raw: { zero, trailing: c.rest() } }
}

export function writeWater(map: WaterResult): Uint8Array {
  const w = new Writer(32 + map.zones.length * 56 + map._raw.trailing.length)
  w.ascii(WATER_MAGIC).u32(map.version).u32(map.zones.length).raw(map._raw.zero)
  for (const z of map.zones) {
    if (z.templateIdBytes.length !== TEMPLATE_ID_LEN) {
      throw new Error(`WATR templateIdBytes must be ${TEMPLATE_ID_LEN} bytes`)
    }
    w.raw(z.templateIdBytes).f32(z.startX).f32(z.startY).f32(z.endX).f32(z.endY)
  }
  return w.raw(map._raw.trailing).done()
}

/** Build a 40-byte template-id field from a string (null-padded) — for constructing new zones. */
export function encodeWaterTemplateId(id: string): Uint8Array {
  const out = new Uint8Array(TEMPLATE_ID_LEN)
  for (let i = 0; i < Math.min(id.length, TEMPLATE_ID_LEN); i++) out[i] = id.charCodeAt(i) & 0x7f
  return out
}
