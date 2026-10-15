/**
 * A Warcraft III map's documents (`war3map.*` inside a `.w3m`/`.w3x`), read through the vendored
 * mdx-m3-viewer parsers (MIT, `src/lib/mdx-m3-viewer`), and its terrain grids as the common map
 * layers of `@modkit/sdk/maps`.
 *
 * - Corners of `war3map.w3e` and cells of `war3map.wpm` both run from the map's south edge; a layer's
 *   row 0 is the north edge, so rows are flipped. On the 32 installed melee and campaign maps the
 *   pathing cells agree with the water of the corners in this order more often than flipped
 *   (never less), which is how the pathing order was checked.
 * - A sample is the number the file stores: a height is the 16-bit corner height, 512 per cliff
 *   level of 128 world units around 8192, so world = (sample − 8192) / 4.
 */
import type { MapLayerDescriptor, MapLayerGrid, MapLayerReadRequest } from '@modkit/sdk/maps'
import { mapLayerWindow } from '@modkit/sdk/maps'
import War3MapDoo from '../lib/mdx-m3-viewer/parsers/w3x/doo/file.js'
import War3MapImp from '../lib/mdx-m3-viewer/parsers/w3x/imp/file.js'
import War3MapUnitsDoo from '../lib/mdx-m3-viewer/parsers/w3x/unitsdoo/file.js'
import War3MapW3c from '../lib/mdx-m3-viewer/parsers/w3x/w3c/file.js'
import War3MapW3e from '../lib/mdx-m3-viewer/parsers/w3x/w3e/file.js'
import War3MapW3i from '../lib/mdx-m3-viewer/parsers/w3x/w3i/file.js'
import War3MapW3r from '../lib/mdx-m3-viewer/parsers/w3x/w3r/file.js'
import War3MapW3s from '../lib/mdx-m3-viewer/parsers/w3x/w3s/file.js'
import War3MapWpm from '../lib/mdx-m3-viewer/parsers/w3x/wpm/file.js'
import { parseWts } from '../wts/format.js'

/** An entry of the map by its path, or `undefined` when the map has none. */
export type EntryReader = (path: string) => Promise<Uint8Array | undefined>

export interface War3Map {
  readonly info?: War3MapW3i
  readonly terrain?: War3MapW3e
  readonly pathing?: War3MapWpm
  readonly doodads?: War3MapDoo
  readonly units?: War3MapUnitsDoo
  readonly regions?: War3MapW3r
  readonly cameras?: War3MapW3c
  readonly sounds?: War3MapW3s
  readonly imports?: War3MapImp
  /** `war3map.wts`: what `TRIGSTR_n` in the other documents stands for. */
  readonly strings: ReadonlyMap<number, string>
  /** Documents present but not readable, with why. */
  readonly failures: readonly { readonly path: string; readonly message: string }[]
}

export const WAR3_MAP_INFO = 'war3map.w3i'

/** The terrain material of a blighted corner, after the map's own tilesets (world and its writer). */
export const BLIGHT_MATERIAL = 'blight'

export async function readWar3Map(read: EntryReader, signal?: AbortSignal): Promise<War3Map> {
  const failures: { path: string; message: string }[] = []
  const load = async <T>(path: string, parse: (bytes: Uint8Array) => T): Promise<T | undefined> => {
    signal?.throwIfAborted()
    const bytes = await read(path)
    if (bytes === undefined) return undefined
    try {
      return parse(bytes)
    } catch (error) {
      failures.push({ path, message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }
  const w3i = await load(WAR3_MAP_INFO, bytes => withLoad(new War3MapW3i(), item => item.load(bytes)))
  // Documents written from 1.32 carry more fields; the build comes from the information file.
  const build = w3i?.getBuildVersion() ?? 0
  const terrain = await load('war3map.w3e', bytes => {
    const w3e = withLoad(new War3MapW3e(), item => item.load(bytes))
    if (w3e.version === 0) throw new TypeError('war3map.w3e has no W3E! signature')
    return w3e
  })
  const stringsText = await load('war3map.wts', bytes => new TextDecoder().decode(bytes))
  const strings = new Map<number, string>()
  for (const entry of stringsText === undefined ? [] : parseWts(stringsText).entries) strings.set(entry.id, entry.text)
  return {
    ...(w3i === undefined ? {} : { info: w3i }),
    ...optional('terrain', terrain),
    ...optional('pathing', await load('war3map.wpm', bytes => {
      const wpm = withLoad(new War3MapWpm(), item => item.load(bytes))
      if (wpm.pathing.byteLength === 0) throw new TypeError('war3map.wpm has no MP3W signature or no cells')
      return wpm
    })),
    ...optional('doodads', await load('war3map.doo', bytes => withLoad(new War3MapDoo(), item => item.load(bytes, build)))),
    ...optional('units', await load('war3mapUnits.doo', bytes => withLoad(new War3MapUnitsDoo(), item => item.load(bytes, build)))),
    ...optional('regions', await load('war3map.w3r', bytes => withLoad(new War3MapW3r(), item => item.load(bytes)))),
    ...optional('cameras', await load('war3map.w3c', bytes => withLoad(new War3MapW3c(), item => item.load(bytes, build)))),
    ...optional('sounds', await load('war3map.w3s', bytes => withLoad(new War3MapW3s(), item => item.load(bytes)))),
    ...optional('imports', await load('war3map.imp', bytes => withLoad(new War3MapImp(), item => item.load(bytes)))),
    strings,
    failures,
  }
}

const withLoad = <T>(item: T, load: (item: T) => void): T => (load(item), item)
const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

/** A `TRIGSTR_n` reference replaced by its trigger string; other text unchanged. */
export function war3MapText(map: War3Map, text: string): string {
  const match = /^TRIGSTR_(\d+)$/u.exec(text)
  return match === null ? text : (map.strings.get(Number(match[1])) ?? text)
}

interface Layer {
  readonly descriptor: MapLayerDescriptor
  /** The document the layer is stored in. */
  readonly document: 'war3map.w3e' | 'war3map.wpm'
  /** The sample at `column` from the west edge and `row` from the north edge. */
  sample(column: number, row: number): number
  /** Writes one sample into a copy of the document, leaving the corner's or cell's other bits. */
  put(bytes: Uint8Array, column: number, row: number, value: number): void
}

const WORLD_HEIGHT = { valueScale: 0.25, valueOffset: -2048, unit: 'war3-world-unit' } as const

export function war3MapLayers(map: War3Map): ReadonlyMap<string, Layer> {
  const layers = new Map<string, Layer>()
  const add = (
    document: Layer['document'],
    descriptor: Omit<MapLayerDescriptor, 'editable'>,
    sample: Layer['sample'],
    put: Layer['put'],
  ) => layers.set(descriptor.id, { descriptor: Object.freeze({ ...descriptor, editable: true }), document, sample, put })
  const setU16 = (bytes: Uint8Array, offset: number, value: number) => {
    bytes[offset] = value & 0xff
    bytes[offset + 1] = (value >>> 8) & 0xff
  }
  const u16 = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8)
  const terrain = map.terrain
  if (terrain !== undefined) {
    const [width = 0, height = 0] = terrain.mapSize
    const corner = (column: number, row: number) => terrain.corners[height - 1 - row]![column]!
    // A corner is 7 bytes after the header: height (i16), water level with the edge bit (i16), the
    // texture and flags byte, variations, cliff texture and level.
    const first = war3MapTerrainHeaderBytes(terrain)
    const at = (column: number, row: number) => first + ((height - 1 - row) * width + column) * 7
    const lowNibble = (bytes: Uint8Array, offset: number, value: number) => {
      bytes[offset] = (bytes[offset]! & 0xf0) | value
    }
    const grid = { width, height, minimum: 0, sampling: 'vertex' } as const
    add('war3map.w3e', { id: 'height', label: 'Ground height (w3e, without cliff levels)', meaning: 'height', ...grid, maximum: 0xffff, ...WORLD_HEIGHT },
      (column, row) => (corner(column, row).groundHeight * 512 + 8192) & 0xffff,
      (bytes, column, row, value) => setU16(bytes, at(column, row), value))
    add('war3map.w3e', { id: 'cliff-level', label: 'Cliff level (w3e)', meaning: 'cliff-level', ...grid, maximum: 15, valueScale: 128, valueOffset: -256, unit: 'war3-world-unit' },
      (column, row) => corner(column, row).layerHeight,
      (bytes, column, row, value) => lowNibble(bytes, at(column, row) + 6, value))
    add('war3map.w3e', { id: 'water', label: 'Water level (w3e)', meaning: 'water', ...grid, maximum: 0x3fff, ...WORLD_HEIGHT },
      (column, row) => corner(column, row).waterHeight * 512 + 8192,
      (bytes, column, row, value) => setU16(bytes, at(column, row) + 2, (u16(bytes, at(column, row) + 2) & 0xc000) | value))
    add('war3map.w3e', { id: 'ground-texture', label: 'Ground tileset index (w3e)', meaning: 'other', ...grid, maximum: 15 },
      (column, row) => corner(column, row).groundTexture,
      (bytes, column, row, value) => lowNibble(bytes, at(column, row) + 4, value))
    // Bits: 1 ramp, 2 blight, 4 water, 8 boundary (the flags nibble), 16 map edge (the water word).
    add('war3map.w3e', { id: 'corner-flags', label: 'Corner flags: ramp, blight, water, boundary, map edge (w3e)', meaning: 'flags', ...grid, maximum: 31 },
      (column, row) => {
        const item = corner(column, row)
        return (item.ramp ? 1 : 0) | (item.blight ? 2 : 0) | (item.water ? 4 : 0) | (item.boundary ? 8 : 0) | (item.mapEdge ? 16 : 0)
      },
      (bytes, column, row, value) => {
        const offset = at(column, row)
        bytes[offset + 4] = (bytes[offset + 4]! & 0x0f) | ((value & 15) << 4)
        setU16(bytes, offset + 2, (u16(bytes, offset + 2) & ~0x4000) | (value & 16 ? 0x4000 : 0))
      })
  }
  const pathing = map.pathing
  if (pathing !== undefined) {
    const [width = 0, height = 0] = pathing.size
    add('war3map.wpm', { id: 'pathing', label: 'Pathing flags: 2 no walk, 4 no fly, 8 no build, 32 blight, 64 no water (wpm)', meaning: 'pathing', width, height, minimum: 0, maximum: 255, sampling: 'cell' },
      (column, row) => pathing.pathing[(height - 1 - row) * width + column] ?? 0,
      (bytes, column, row, value) => {
        bytes[16 + (height - 1 - row) * width + column] = value
      })
  }
  return layers
}

/** Bytes of `war3map.w3e` before its first corner. */
function war3MapTerrainHeaderBytes(terrain: NonNullable<War3Map['terrain']>): number {
  return 37 + 4 * terrain.groundTilesets.length + 4 * terrain.cliffTilesets.length
}

/**
 * A layer write as the new bytes of the one document that stores the layer: a copy of `document`
 * with the window's samples written and every other byte kept — the other fields of each corner,
 * the header, the tilesets, anything after the grid.
 */
export function writeWar3MapLayer(
  map: War3Map,
  document: Uint8Array,
  grid: MapLayerGrid,
): { readonly path: Layer['document']; readonly bytes: Uint8Array } {
  const layer = war3MapLayers(map).get(grid.layer)
  if (layer === undefined) throw new RangeError(`the map has no layer ${String(grid.layer)}`)
  const window = mapLayerWindow(layer.descriptor, grid)
  const cells = layer.descriptor.width * layer.descriptor.height
  const need = layer.document === 'war3map.wpm' ? 16 + cells : war3MapTerrainHeaderBytes(map.terrain!) + cells * 7
  if (document.byteLength < need)
    throw new RangeError(`${layer.document} is ${String(document.byteLength)} bytes, shorter than its ${String(need)}-byte grid`)
  const bytes = document.slice()
  for (let row = 0; row < window.height; row += 1)
    for (let column = 0; column < window.width; column += 1)
      layer.put(bytes, window.x + column, window.y + row, grid.values[row * window.width + column]!)
  return { path: layer.document, bytes }
}

export function readWar3MapLayer(map: War3Map, request: MapLayerReadRequest): MapLayerGrid {
  const layer = war3MapLayers(map).get(request.layer)
  if (layer === undefined) throw new RangeError(`the map has no layer ${String(request.layer)}`)
  const window = mapLayerWindow(layer.descriptor, request)
  const values: number[] = []
  for (let row = window.y; row < window.y + window.height; row += 1)
    for (let column = window.x; column < window.x + window.width; column += 1) values.push(layer.sample(column, row))
  return {
    layer: layer.descriptor.id,
    ...(request.x === undefined ? {} : { x: window.x, y: window.y }),
    width: window.width,
    height: window.height,
    values,
  }
}
