/**
 * Warcraft III files written for the tests, byte by byte from their formats, so every suite (and
 * the K1 audit receipts) reads the same real bytes rather than a stub.
 */
import { constants, deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { extension } from './war3-harness.js'
import War3MapW3u from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/file.js'
import Modification from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/modification.js'
import ModifiedObject from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/modifiedobject.js'

class Bytes {
  readonly parts: number[] = []
  u8(...values: number[]) {
    this.parts.push(...values)
    return this
  }
  u16(value: number) {
    return this.u8(value & 0xff, value >>> 8)
  }
  u32(value: number) {
    return this.u8(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24)
  }
  text(value: string) {
    return this.u8(...new TextEncoder().encode(value), 0)
  }
  get bytes() {
    return Uint8Array.from(this.parts)
  }
}

/** The map string's encoding: a mask byte, then seven bytes, each even one raised by one. */
function encodeMapString(decoded: Uint8Array): number[] {
  const encoded: number[] = []
  for (let start = 0; start < decoded.length; start += 7) {
    const group = [...decoded.subarray(start, start + 7)]
    let mask = 1
    const out = group.map((value, index) => {
      if (value % 2 === 0) return value + 1
      mask |= 1 << (index + 1)
      return value
    })
    encoded.push(mask, ...out)
  }
  return encoded
}

/**
 * A replay: two players, a lobby slot table, two time slots with commands, a chat line and a
 * player leaving. The block is compressed with node:zlib only to make the fixture.
 */
export function authoredReplay(): Uint8Array {
  const map = new Bytes().u8(2, 0, 0, 0, 0, 0, 0, 0, 0).u32(0xdeadbeef).text('Maps\\Test.w3x').text('Creator').bytes
  const record = new Bytes()
    .u32(0x110)
    .u8(0x00, 1)
    .text('Host')
    .u8(1, 0)
    .text('Test Game')
    .u8(0)
    .u8(...encodeMapString(map), 0)
    .u32(2)
    .u32(1)
    .u32(0)
    .u8(0x16, 2)
    .text('Guest')
    .u8(1, 0)
    .u32(0)
    .u8(0x19)
    .u16(25)
    .u8(2)
    .u8(1, 100, 2, 0, 0, 0, 0x01, 1, 100)
    .u8(2, 100, 2, 0, 1, 1, 0x08, 1, 90)
    .u32(42)
    .u8(0, 2)
    .u8(0x1a)
    .u32(1)
    // A time slot of 250 ms: player 1 trains a peasant ('hpea', stored last-first), player 2
    // reselects a unit — the game's own deselect-then-select pair, one action in the APM.
    .u8(0x1f)
    .u16(47)
    .u16(250)
    .u8(1)
    .u16(15)
    .u8(0x10)
    .u16(0x40)
    .u8(...new TextEncoder().encode('aeph'))
    .u32(0xffffffff)
    .u32(0xffffffff)
    .u8(2)
    .u16(24)
    .u8(0x16, 0x02)
    .u16(1)
    .u32(7)
    .u32(7)
    .u8(0x16, 0x01)
    .u16(1)
    .u32(9)
    .u32(9)
    .u8(0x20, 1)
    .u16(8)
    .u8(0x20)
    .u32(0)
    .text('gg')
    .u8(0x1f)
    .u16(2)
    .u16(750)
    .u8(0x17)
    .u32(1)
    .u8(2)
    .u32(9)
    .u32(0)
    .u8(0, 0, 0, 0).bytes
  // As the game writes it: the stream stops at a sync flush, with no final block or Adler-32.
  const block = deflateSync(record, { finishFlush: constants.Z_SYNC_FLUSH })
  const body = new Bytes().u16(block.byteLength).u16(record.byteLength).u32(0).u8(...block).bytes
  const header = new Bytes()
    .u8(...new TextEncoder().encode('Warcraft III recorded game\u001a'), 0)
    .u32(0x44)
    .u32(0x44 + body.byteLength)
    .u32(1)
    .u32(record.byteLength)
    .u32(1)
    .u8(...new TextEncoder().encode('PX3W'))
    .u32(24)
    .u16(6059)
    .u16(0x8000)
    .u32(1000)
    .u32(0).bytes
  const file = new Uint8Array(header.byteLength + body.byteLength)
  file.set(header)
  file.set(body, header.byteLength)
  return file
}

const viewer = (path: string) =>
  import(pathToFileURL(join(extension, 'dist', 'lib', 'mdx-m3-viewer', 'parsers', 'w3x', path)).href)
const { default: War3MapW3i } = (await viewer('w3i/file.js')) as typeof import('../dist/lib/mdx-m3-viewer/parsers/w3x/w3i/file.js')
const { default: Player } = (await viewer('w3i/player.js')) as typeof import('../dist/lib/mdx-m3-viewer/parsers/w3x/w3i/player.js')

const text = (value: string) => new TextEncoder().encode(value)

/** 3 × 2 corners (2 × 1 tiles): heights rise by 4 eastward and 512 (one cliff level) northward. */
function terrain(): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 1 + 4 + 4 + 4 + 4 + 4 + 8 + 8 + 6 * 7)
  const view = new DataView(bytes.buffer)
  bytes.set(text('W3E!'), 0)
  view.setInt32(4, 11, true)
  bytes.set(text('L'), 8)
  view.setInt32(9, 0, true)
  view.setInt32(13, 1, true)
  bytes.set(text('Ldrt'), 17)
  view.setInt32(21, 1, true)
  bytes.set(text('CLdi'), 25)
  view.setInt32(29, 3, true)
  view.setInt32(33, 2, true)
  view.setFloat32(37, -128, true)
  view.setFloat32(41, -64, true)
  for (let row = 0; row < 2; row += 1)
    for (let column = 0; column < 3; column += 1) {
      const at = 45 + (row * 3 + column) * 7
      const corner = column === 0 && row === 0
      view.setInt16(at, 8192 + row * 512 + column * 4, true)
      // The south-west corner is water at the map edge.
      view.setInt16(at + 2, 8000 | (corner ? 0x4000 : 0), true)
      bytes[at + 4] = (corner ? 0x40 : 0) | column
      bytes[at + 6] = 2 + row
    }
  return bytes
}

/** 8 × 4 pathing cells, each the number of its row from the south. */
function pathing(): Uint8Array {
  const bytes = new Uint8Array(16 + 32)
  const view = new DataView(bytes.buffer)
  bytes.set(text('MP3W'), 0)
  view.setInt32(8, 8, true)
  view.setInt32(12, 4, true)
  for (let row = 0; row < 4; row += 1) bytes.fill(row, 16 + row * 8, 16 + row * 8 + 8)
  return bytes
}

function information(): Uint8Array {
  const info = new War3MapW3i()
  info.version = 25
  info.name = 'TRIGSTR_001'
  info.author = 'Modkit'
  info.tileset = 'L'
  info.playableSize.set([2, 1])
  const player = Object.assign(new Player(), { id: 0, type: 1, race: 2, name: 'TRIGSTR_002' })
  player.startLocation.set([-64, 0])
  info.players.push(player)
  return info.save()
}

/**
 * A `.w3x`: 3 × 2 terrain corners, 8 × 4 pathing cells, one player, and the trigger strings its
 * information names.
 */
export function authoredMapDocuments(): { readonly path: string; readonly bytes: Uint8Array }[] {
  return [
    { path: 'war3map.w3i', bytes: information() },
    { path: 'war3map.w3e', bytes: terrain() },
    { path: 'war3map.wpm', bytes: pathing() },
    { path: 'war3map.wts', bytes: text('STRING 1\n{\nLantern Isle\n}\n\nSTRING 2\n{\nRed\n}\n') },
  ]
}

export async function authoredMap(): Promise<Uint8Array> {
  return encodeFreshMpq(authoredMapDocuments())
}

/** One object-editor change: field id, value type (0 int, 1 real, 3 string), value, level and data column. */
export function objectChange(id: string, variableType: number, value: number | string, level = 0, data = 0): Modification {
  return Object.assign(new Modification(), { id, variableType, value, levelOrVariation: level, dataPointer: data })
}
export function changedObject(oldId: string, newId: string, changes: Modification[]): ModifiedObject {
  return Object.assign(new ModifiedObject(), { oldId, newId, modifications: changes })
}

/** Unit changes as the World Editor saves them: a changed footman and a custom unit made from the peasant. */
export function authoredUnitChanges(): Uint8Array {
  const file = new War3MapW3u()
  file.version = 2
  file.originalTable.objects.push(changedObject('hfoo', '\0\0\0\0', [objectChange('uhpm', 0, 999), objectChange('unam', 3, 'Guard')]))
  file.customTable.objects.push(changedObject('hpea', 'h000', [objectChange('umvs', 1, 1.5)]))
  return file.save()
}
