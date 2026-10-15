/**
 * StarCraft scenario (`scenario.chk`, `staredit\scenario.chk` inside `.scm`/`.scx`): a run of
 * sections, each a four-byte name, a signed 32-bit size and that many bytes.
 *
 * Read the way the game reads it, because protected maps rely on it: a later section of the same
 * name replaces an earlier one, a section running past the end of the file keeps the bytes that are
 * there, and a negative size moves the reader back (a "jump" section) without data. The typed view
 * below takes the sections the game uses; everything else stays as raw sections, so nothing is lost.
 */

import { sc1TextDecoder } from '../text.js'

export interface ChkSection {
  readonly name: string
  /** Offset of the section's data in the scenario. */
  readonly offset: number
  /** Bytes the section has: its declared size, or fewer when the file ends first. */
  readonly bytes: Uint8Array
  readonly declaredSize: number
}

export interface ChkDiagnostic {
  readonly code: string
  readonly message: string
  readonly section?: string
}

export interface ChkPlayer {
  readonly index: number
  readonly owner: number
  readonly race: number
  readonly force: number
}

export interface ChkForce {
  readonly name: string
  readonly flags: number
}

export interface ChkUnit {
  readonly instance: number
  readonly x: number
  readonly y: number
  readonly unitId: number
  readonly owner: number
  readonly hitPoints: number
  readonly shields: number
  readonly energy: number
  readonly resources: number
  readonly hangar: number
  readonly stateFlags: number
  readonly relatedInstance: number
}

/** A THG2 entry: a sprite, or a unit drawn as a doodad (flag 0x1000 clear). */
export interface ChkDoodad {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly owner: number
  readonly flags: number
}

export interface ChkLocation {
  readonly index: number
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly name: string
  readonly elevation: number
}

export interface Scenario {
  readonly sections: readonly ChkSection[]
  readonly diagnostics: readonly ChkDiagnostic[]
  readonly version: number | undefined
  readonly tileset: number
  readonly width: number
  readonly height: number
  /** MTXM: the tiles the game draws, `width × height`, row 0 at the top. */
  readonly tiles: Uint16Array
  readonly strings: readonly (string | undefined)[]
  readonly name: string
  readonly description: string
  readonly players: readonly ChkPlayer[]
  readonly forces: readonly ChkForce[]
  readonly units: readonly ChkUnit[]
  readonly doodads: readonly ChkDoodad[]
  readonly locations: readonly ChkLocation[]
  /** Every MRGN slot's name, by slot: a trigger names location `n` as slot `n - 1`. */
  readonly locationNames: readonly string[]
  readonly triggers: number
  readonly briefings: number
}

/** ERA values, as the game names its tileset files (`tileset\<name>.cv5`). */
export const TILESET_FILES = Object.freeze(['badlands', 'platform', 'install', 'ashworld', 'jungle', 'desert', 'ice', 'twilight'])
export const TILESET_NAMES = Object.freeze(['Badlands', 'Space Platform', 'Installation', 'Ash World', 'Jungle', 'Desert', 'Ice', 'Twilight'])
/** OWNR slot kinds. */
export const OWNERS = Object.freeze(['inactive', 'computer (game)', 'human (occupied)', 'rescue passive', 'unused', 'computer', 'human', 'neutral', 'closed'])
/** SIDE races. */
export const RACES = Object.freeze(['Zerg', 'Terran', 'Protoss', 'independent', 'neutral', 'user select', 'random', 'inactive'])
/** VER: the game and editor a scenario was saved for. */
export const VERSIONS: Readonly<Record<number, string>> = Object.freeze({
  57: 'StarCraft 1.00',
  59: 'StarCraft 1.04',
  61: 'StarCraft Remastered',
  63: 'StarCraft 1.04 hybrid',
  64: 'StarCraft Remastered hybrid',
  205: 'Brood War',
  206: 'Brood War Remastered',
})

const UNIT_BYTES = 36
const DOODAD_BYTES = 10
const LOCATION_BYTES = 20
const TRIGGER_BYTES = 2400
/** More sections than any map has: a loop of jump sections ends here. */
const MAXIMUM_SECTIONS = 65_536

export function readSections(chk: Uint8Array): { sections: ChkSection[]; diagnostics: ChkDiagnostic[] } {
  const view = new DataView(chk.buffer, chk.byteOffset, chk.byteLength)
  const sections: ChkSection[] = []
  const diagnostics: ChkDiagnostic[] = []
  const visited = new Set<number>()
  for (let at = 0; at + 8 <= chk.byteLength; ) {
    if (visited.has(at) || sections.length >= MAXIMUM_SECTIONS) {
      diagnostics.push({ code: 'chk/section-loop', message: `sections loop back to byte ${String(at)}` })
      break
    }
    visited.add(at)
    const name = String.fromCharCode(...chk.subarray(at, at + 4))
    const size = view.getInt32(at + 4, true)
    const offset = at + 8
    if (size < 0) {
      at = offset + size
      if (at < 0) {
        diagnostics.push({ code: 'chk/jump-before-start', message: `section ${name} jumps before the scenario`, section: name })
        break
      }
      continue
    }
    const end = Math.min(chk.byteLength, offset + size)
    if (end < offset + size)
      diagnostics.push({ code: 'chk/section-truncated', message: `section ${name} declares ${String(size)} bytes, ${String(end - offset)} remain`, section: name })
    sections.push({ name, offset, bytes: chk.subarray(offset, end), declaredSize: size })
    at = offset + size
  }
  return { sections, diagnostics }
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** STR (u16 count and offsets) or Remastered's STRx (u32): 1-based string ids. */
function readStrings(section: ChkSection | undefined, wide: boolean, decode: (bytes: Uint8Array) => string): (string | undefined)[] {
  if (section === undefined) return []
  const bytes = section.bytes
  const data = view(bytes)
  const width = wide ? 4 : 2
  if (bytes.byteLength < width) return []
  const count = wide ? data.getUint32(0, true) : data.getUint16(0, true)
  const strings: (string | undefined)[] = []
  for (let index = 0; index < count && width * (index + 2) <= bytes.byteLength; index += 1) {
    const offset = wide ? data.getUint32(width * (index + 1), true) : data.getUint16(width * (index + 1), true)
    if (offset >= bytes.byteLength) {
      strings.push(undefined)
      continue
    }
    const end = bytes.indexOf(0, offset)
    strings.push(decode(bytes.subarray(offset, end === -1 ? bytes.byteLength : end)))
  }
  return strings
}

function records<T>(section: ChkSection | undefined, size: number, read: (data: DataView, at: number, index: number) => T): T[] {
  if (section === undefined) return []
  const data = view(section.bytes)
  const found: T[] = []
  for (let at = 0, index = 0; at + size <= section.bytes.byteLength; at += size, index += 1) found.push(read(data, at, index))
  return found
}

export function readScenario(chk: Uint8Array, decode = sc1TextDecoder()): Scenario {
  const { sections, diagnostics } = readSections(chk)
  const last = (name: string) => sections.findLast(section => section.name === name)
  const u16 = (section: ChkSection | undefined, at: number) =>
    section !== undefined && at + 2 <= section.bytes.byteLength ? view(section.bytes).getUint16(at, true) : undefined
  const u8s = (section: ChkSection | undefined, count: number) =>
    Array.from({ length: count }, (_, index) => section?.bytes[index] ?? 0)

  const strx = last('STRx')
  const strings = strx !== undefined ? readStrings(strx, true, decode) : readStrings(last('STR '), false, decode)
  const text = (id: number | undefined) => (id === undefined || id === 0 ? '' : (strings[id - 1] ?? ''))

  const dimensions = last('DIM ')
  const width = u16(dimensions, 0) ?? 0
  const height = u16(dimensions, 2) ?? 0
  if (dimensions === undefined) diagnostics.push({ code: 'chk/missing-section', message: 'no DIM section', section: 'DIM ' })
  const tiles = new Uint16Array(width * height)
  const mtxm = last('MTXM')
  if (mtxm === undefined) diagnostics.push({ code: 'chk/missing-section', message: 'no MTXM section', section: 'MTXM' })
  else {
    // A short MTXM fills what it has; the game leaves the rest at tile 0.
    const data = view(mtxm.bytes)
    for (let index = 0; index < tiles.length && 2 * index + 2 <= mtxm.bytes.byteLength; index += 1) tiles[index] = data.getUint16(2 * index, true)
  }

  const owners = u8s(last('OWNR'), 12)
  const races = u8s(last('SIDE'), 12)
  const forceSection = last('FORC')
  const playerForces = u8s(forceSection, 8)
  const players = owners.map((owner, index) => ({ index, owner, race: races[index] ?? 0, force: index < 8 ? (playerForces[index] ?? 0) : 0 }))
  const forces = [0, 1, 2, 3].map(index => ({ name: text(u16(forceSection, 8 + 2 * index)), flags: forceSection?.bytes[16 + index] ?? 0 }))

  const allLocations = records(last('MRGN'), LOCATION_BYTES, (data, at, index) => ({
    index,
    left: data.getUint32(at, true),
    top: data.getUint32(at + 4, true),
    right: data.getUint32(at + 8, true),
    bottom: data.getUint32(at + 12, true),
    name: text(data.getUint16(at + 16, true)),
    elevation: data.getUint16(at + 18, true),
  }))
  const scenarioProperties = last('SPRP')
  const trig = last('TRIG')
  const mbrf = last('MBRF')
  return {
    sections,
    diagnostics,
    version: u16(last('VER '), 0),
    tileset: (u16(last('ERA '), 0) ?? 0) & 7,
    width,
    height,
    tiles,
    strings,
    name: text(u16(scenarioProperties, 0)),
    description: text(u16(scenarioProperties, 2)),
    players,
    forces,
    units: records(last('UNIT'), UNIT_BYTES, (data, at) => ({
      instance: data.getUint32(at, true),
      x: data.getUint16(at + 4, true),
      y: data.getUint16(at + 6, true),
      unitId: data.getUint16(at + 8, true),
      owner: data.getUint8(at + 16),
      hitPoints: data.getUint8(at + 17),
      shields: data.getUint8(at + 18),
      energy: data.getUint8(at + 19),
      resources: data.getUint32(at + 20, true),
      hangar: data.getUint16(at + 24, true),
      stateFlags: data.getUint16(at + 26, true),
      relatedInstance: data.getUint32(at + 32, true),
    })),
    doodads: records(last('THG2'), DOODAD_BYTES, (data, at) => ({
      id: data.getUint16(at, true),
      x: data.getUint16(at + 2, true),
      y: data.getUint16(at + 4, true),
      owner: data.getUint8(at + 6),
      flags: data.getUint16(at + 8, true),
    })),
    locations: allLocations.filter(location => location.name !== '' || location.right !== location.left || location.bottom !== location.top),
    locationNames: allLocations.map(location => location.name),
    triggers: trig === undefined ? 0 : Math.floor(trig.bytes.byteLength / TRIGGER_BYTES),
    briefings: mbrf === undefined ? 0 : Math.floor(mbrf.bytes.byteLength / TRIGGER_BYTES),
  }
}

/**
 * The scenario with its terrain replaced by `tiles`: MTXM (what the game draws) and TILE (what the
 * editors edit) get the same tiles; every other byte, section and section order stays. The last
 * section of each name is the one read, so that one is rewritten; a scenario without MTXM gets one
 * at the end. A section whose size must change moves the sections after it, which a scenario with
 * jump sections (negative sizes, protected maps) cannot survive: that write is refused.
 */
export function writeScenarioTiles(chk: Uint8Array, tiles: Uint16Array): Uint8Array {
  const payload = new Uint8Array(tiles.byteLength)
  const data = view(payload)
  tiles.forEach((tile, index) => data.setUint16(2 * index, tile, true))
  const read = readSections(chk)
  const targets = ['MTXM', 'TILE']
    .map(name => read.sections.findLast(section => section.name === name))
    .filter(section => section !== undefined)
    .sort((left, right) => right.offset - left.offset)
  const resizes = targets.some(target => target.declaredSize !== payload.byteLength || target.bytes.byteLength !== payload.byteLength)
  if (resizes && jumps(chk)) throw new RangeError('the scenario has jump sections: its terrain cannot change size')
  let out: Uint8Array = chk.slice()
  // From the last section back, so the earlier offsets still hold.
  for (const target of targets) {
    if (!resizes) {
      out.set(payload, target.offset)
      continue
    }
    const header = chk.slice(target.offset - 8, target.offset)
    view(header).setUint32(4, payload.byteLength, true)
    out = concat(out.subarray(0, target.offset - 8), header, payload, out.subarray(target.offset + target.bytes.byteLength))
  }
  if (!targets.some(target => target.name === 'MTXM')) {
    const header = new Uint8Array([0x4d, 0x54, 0x58, 0x4d, 0, 0, 0, 0])
    view(header).setUint32(4, payload.byteLength, true)
    out = concat(out, header, payload)
  }
  return out
}

/** Whether any section has a negative size. */
function jumps(chk: Uint8Array): boolean {
  const data = view(chk)
  for (let at = 0, count = 0; at + 8 <= chk.byteLength && count < MAXIMUM_SECTIONS; count += 1) {
    const size = data.getInt32(at + 4, true)
    if (size < 0) return true
    at += 8 + size
  }
  return false
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** Bytes of a scenario's start that hold its ERA: editors write it within the first two kilobytes. */
export const ERA_PREFIX_BYTES = 64 * 1024

/**
 * The tileset a scenario names, read from its first bytes only — what a codec asks the host for
 * before the scenario is open. `undefined` when the prefix names none (a protected scenario that
 * moves ERA past it, or a jump section): the caller then asks for every tileset.
 */
export function eraOfPrefix(prefix: Uint8Array): number | undefined {
  let era: number | undefined
  for (const section of readSections(prefix).sections)
    if (section.name === 'ERA ' && section.bytes.byteLength >= 2) era = (section.bytes[0]! | (section.bytes[1]! << 8)) & 7
  return era
}
