/** Files written for the StarCraft suites: a scenario, the map that carries it, a string table, a sprite. */
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'

export const ascii = (text: string) => Uint8Array.from(text, character => character.charCodeAt(0))

export function section(name: string, data: Uint8Array | number[], size = data.length): Uint8Array {
  const out = new Uint8Array(8 + data.length)
  out.set(ascii(name))
  new DataView(out.buffer).setInt32(4, size, true)
  out.set(data, 8)
  return out
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) out.set(part, (at += part.length) - part.length)
  return out
}

export const u16s = (...values: number[]) => new Uint8Array(new Uint16Array(values).buffer)

/** A STR section: count, offsets from the section start, NUL-terminated strings. */
export function strings(...items: Uint8Array[]): Uint8Array {
  const table = 2 + 2 * items.length
  const offsets: number[] = []
  let at = table
  for (const item of items) {
    offsets.push(at)
    at += item.length + 1
  }
  return concat(u16s(items.length, ...offsets), ...items.flatMap(item => [item, new Uint8Array(1)]))
}

/** A 4 × 2 Jungle scenario, a unit and a location, as an editor writes it. */
export function authoredScenario(): Uint8Array {
  const unit = new Uint8Array(36)
  const data = new DataView(unit.buffer)
  data.setUint32(0, 7, true)
  data.setUint16(4, 48, true)
  data.setUint16(6, 80, true)
  data.setUint16(8, 0, true) // Terran Marine
  data.setUint8(16, 0)
  data.setUint8(17, 100)
  const location = new Uint8Array(20)
  new DataView(location.buffer).setUint32(8, 64, true)
  new DataView(location.buffer).setUint32(12, 32, true)
  new DataView(location.buffer).setUint16(16, 3, true)
  const tiles = u16s(16, 17, 18, 19, 32, 33, 34, 35)
  return concat(
    section('TYPE', ascii('RAWB')),
    section('VER ', u16s(205)),
    section('ERA ', u16s(4)),
    section('DIM ', u16s(4, 2)),
    section('OWNR', [6, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]),
    section('SIDE', [1, 0, 7, 7, 7, 7, 7, 7, 7, 7, 7, 4]),
    section('MTXM', tiles),
    section('TILE', tiles),
    section('UNIT', unit),
    section('MRGN', location),
    section('SPRP', u16s(1, 2)),
    section('STR ', strings(ascii('Lantern Isle'), new TextEncoder().encode('Остров'), ascii('Home'))),
  )
}

/** The scenario as a map: an MPQ with `staredit\scenario.chk`, as the editors save it. */
// The writer takes portable `/` paths and hashes them as the game's `\`.
export const authoredMap = async (): Promise<Uint8Array> => encodeFreshMpq([{ path: 'staredit/scenario.chk', bytes: authoredScenario() }])

/** A string table as `stat_txt.tbl` keeps a unit: name, then group and subgroup after NULs. */
export function authoredTbl(): Uint8Array {
  const items = [concat(ascii('Terran Marine'), Uint8Array.of(0), ascii('Terran'), Uint8Array.of(0), ascii('Ground Units')), concat(ascii('M'), Uint8Array.of(1, 3), ascii('M'), Uint8Array.of(1), ascii('arine'))]
  return strings(...items)
}

/**
 * A 4 × 2 sprite with one coded frame at (1, 0), 2 × 2: its first line copies indices 5 and 6, its
 * second skips one pixel and repeats index 7 once.
 */
export function authoredGrp(): Uint8Array {
  const header = [1, 0, 4, 0, 2, 0, /* frame */ 1, 0, 2, 2, 14, 0, 0, 0]
  const lines = [4, 0, 7, 0]
  const pixels = [0x02, 5, 6, /* line 2 */ 0x81, 0x41, 7]
  return Uint8Array.from([...header, ...lines, ...pixels])
}

/**
 * A Jungle tileset as the game lays it out, small enough to reason about: every tile of the
 * authored scenario draws megatile 1, whose minitiles are all minitile 1 (the first one mirrored),
 * minitile 1's pixels are its column plus one, colour `i` is `(10 i, 20 i, 30 i)`, and every
 * minitile is walkable middle ground (flags 3).
 */
export function authoredTileset(): Record<'cv5' | 'vx4ex' | 'vr4' | 'vf4' | 'wpe', Uint8Array> {
  const cv5 = new Uint8Array(52 * 3)
  const groups = new DataView(cv5.buffer)
  for (let group = 0; group < 3; group += 1) for (let variant = 0; variant < 16; variant += 1) groups.setUint16(group * 52 + 20 + 2 * variant, 1, true)
  const references = new Uint32Array(32)
  references.fill(2, 16)
  references[16] = 3
  const vr4 = new Uint8Array(128)
  for (let pixel = 0; pixel < 64; pixel += 1) vr4[64 + pixel] = (pixel % 8) + 1
  const flags = new Uint16Array(32)
  flags.fill(3, 16)
  const wpe = new Uint8Array(1024)
  for (let index = 0; index < 256; index += 1) wpe.set([(index * 10) & 255, (index * 20) & 255, (index * 30) & 255, 0], index * 4)
  return { cv5, vx4ex: new Uint8Array(references.buffer), vr4, vf4: new Uint8Array(flags.buffer), wpe }
}
