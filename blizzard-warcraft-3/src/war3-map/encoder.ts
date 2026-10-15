/**
 * A UVW world written as a Warcraft III map (`common.map/native-encoder`, WT10): `.w3x`, the HM3W
 * header and an MPQ (`@modkit/blizzard-mpq/fresh-writer`) holding `war3map.w3e`, `war3map.w3i`,
 * `war3map.doo` and `war3mapUnits.doo`. The way there is the map world (`war3-map-world/world.ts`).
 *
 * - Frame: ADR-WORLD-003 read backwards, map-native `(x, y, z) = (X, -Z, Y)`, the heightfield's
 *   rows from the north. A world in `warcraft3-world-unit` keeps its 128-unit cells; a world of
 *   another unit is written one grid cell to one cell of the map, its lengths scaled to match.
 * - Terrain: each corner's height h and cliff level L (the `cliffs` layer, 2 without one) become
 *   the W3E ground height `h / 128 − L + 2`, so a map the world came from writes back its own
 *   heights; ground tiles come from `terrain-materials` (a material `tile-XXXX` is tileset XXXX,
 *   the heaviest weight of a corner wins), 16 at most.
 * - Objects: a game type id of four characters is required. Doodads and features go to
 *   `war3map.doo`, units, structures and start locations (`sloc`) to `war3mapUnits.doo`; the yaw
 *   about UVW +Y is the map's angle.
 * - Information (`war3map.w3i`, format 25 as 1.24 writes it): the name, the playable area as the
 *   whole grid and one player slot per start location.
 * - Lost, each kind reported once (SPEC_UVM_CONVERSION §5): water, regions, other spaces, objects
 *   without a type, and the map script (`war3map.j`), pathing and shadow maps the World Editor
 *   writes when it saves the map — until then the game does not run it.
 */
import type { Diagnostic } from '@modkit/core'
import { parseUvwProfile, type UvwCliffsLayer, type UvwHeightfieldLayer, type UvwObjectsLayer, type UvwTerrainMaterialsLayer } from '@modkit/uv/world'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import War3MapDoo from '../lib/mdx-m3-viewer/parsers/w3x/doo/file.js'
import Doodad from '../lib/mdx-m3-viewer/parsers/w3x/doo/doodad.js'
import War3MapUnitsDoo from '../lib/mdx-m3-viewer/parsers/w3x/unitsdoo/file.js'
import Unit from '../lib/mdx-m3-viewer/parsers/w3x/unitsdoo/unit.js'
import War3MapW3i from '../lib/mdx-m3-viewer/parsers/w3x/w3i/file.js'
import Player from '../lib/mdx-m3-viewer/parsers/w3x/w3i/player.js'
import { BLIGHT_MATERIAL } from './map.js'

export const WAR3_MAP_FORMAT_ID = 'war3-map'

export interface War3MapEncodeOptions {
  readonly name?: string
  /** The ground tile a corner gets without a material of its own (`Ldrt`). */
  readonly defaultTile?: string
}

const CELL = 128
/** 1.24 writes object files version 8, subversion 11, and build-dependent fields of build 6059. */
const OBJECT_VERSION = 8
const OBJECT_SUBVERSION = 11
const BUILD_VERSION = 124

const loss = (code: string, message: string): Diagnostic =>
  Object.freeze({ severity: 'warning' as const, code: `blizzard.war3/${code}` as Diagnostic['code'], message })

function options(value: unknown): War3MapEncodeOptions {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Warcraft III map encoder options must be an object')
  const { name, defaultTile, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) throw new TypeError(`Warcraft III map encoder has no option ${Object.keys(rest).join(', ')}`)
  if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be text')
  if (defaultTile !== undefined && !(typeof defaultTile === 'string' && /^[\x20-\x7e]{4}$/u.test(defaultTile))) throw new TypeError('defaultTile must be a four-character tileset id')
  return { ...(name === undefined ? {} : { name }), ...(defaultTile === undefined ? {} : { defaultTile }) }
}

/** The W3E corners: 7 bytes each, as the game reads them (Warsmash `Corner.save` field order). */
function encodeW3e(
  tileset: string,
  groundTilesets: readonly string[],
  columns: number,
  rows: number,
  centerOffset: readonly [number, number],
  corner: (column: number, row: number) => { readonly ground: number; readonly level: number; readonly texture: number; readonly blight: boolean },
): Uint8Array {
  const header = 4 + 4 + 1 + 4 + 4 + groundTilesets.length * 4 + 4 + 4 + 8 + 8
  const bytes = new Uint8Array(header + columns * rows * 7)
  const view = new DataView(bytes.buffer)
  let at = 0
  const ascii = (text: string) => {
    for (let index = 0; index < text.length; index += 1) bytes[at++] = text.charCodeAt(index)
  }
  ascii('W3E!')
  view.setInt32(at, 11, true), (at += 4)
  ascii(tileset)
  view.setInt32(at, 0, true), (at += 4)
  view.setInt32(at, groundTilesets.length, true), (at += 4)
  for (const id of groundTilesets) ascii(id)
  // One cliff set, the Lordaeron cliff the World Editor starts with.
  view.setInt32(at, 1, true), (at += 4)
  ascii('CLdi')
  view.setInt32(at, columns, true), (at += 4)
  view.setInt32(at, rows, true), (at += 4)
  view.setFloat32(at, centerOffset[0], true), (at += 4)
  view.setFloat32(at, centerOffset[1], true), (at += 4)
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const { ground, level, texture, blight } = corner(column, row)
      // Ground: 8192 at zero, 512 a level; water at the same base, map edge clear.
      view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(ground * 512 + 8192))), true)
      view.setInt16(at + 2, 8192, true)
      bytes[at + 4] = (texture & 0x0f) | (blight ? 0x20 : 0)
      bytes[at + 5] = 0
      bytes[at + 6] = level & 0x0f
      at += 7
    }
  return bytes
}

/** The HM3W header a `.w3x` starts with: name, flags and players, padded to 512 bytes. */
function hm3w(name: string, players: number): Uint8Array {
  const bytes = new Uint8Array(512)
  const view = new DataView(bytes.buffer)
  bytes.set([0x48, 0x4d, 0x33, 0x57])
  const text = new TextEncoder().encode(name).subarray(0, 400)
  bytes.set(text, 8)
  const end = 8 + text.length + 1
  view.setInt32(end, 0, true)
  view.setInt32(end + 4, players, true)
  return bytes
}

/** The yaw about UVW +Y of a unit quaternion, as the map's angle (radians, counterclockwise). */
function yawOf(rotation: readonly [number, number, number, number]): number {
  const angle = 2 * Math.atan2(rotation[1], rotation[3])
  const turn = Math.PI * 2
  return ((angle % turn) + turn) % turn
}

/** The world as a `.w3x` file's bytes and what it lost. */
export function encodeWar3Map(uvw: Uint8Array, rawOptions?: unknown, signal?: AbortSignal): { readonly bytes: Uint8Array; readonly diagnostics: readonly Diagnostic[] } {
  const settings = options(rawOptions)
  const document = parseUvwProfile(uvw, signal === undefined ? {} : { signal })
  const diagnostics: Diagnostic[] = []
  const [space, ...others] = document.spaces
  if (space === undefined) throw new TypeError('the world has no space to write')
  if (others.length > 0) diagnostics.push(loss('map-spaces-dropped', `${String(others.length)} more space(s): a map holds one`))
  const field = space.layers.find((layer): layer is UvwHeightfieldLayer => layer.kind === 'heightfield')
  if (field === undefined) throw new TypeError('the world has no heightfield to write as terrain')
  const cliffs = space.layers.find((layer): layer is UvwCliffsLayer => layer.kind === 'cliffs')
  const materials = space.layers.find((layer): layer is UvwTerrainMaterialsLayer => layer.kind === 'terrain-materials')
  const objectLayers = space.layers.filter((layer): layer is UvwObjectsLayer => layer.kind === 'objects')
  for (const layer of space.layers)
    if (!['heightfield', 'cliffs', 'terrain-materials', 'objects', 'resources', 'lighting'].includes(layer.kind))
      diagnostics.push(loss('map-layer-dropped', `layer ${layer.id} (${layer.kind}) is not written: the map has no place for it yet`))

  const { columns, rows, cellSize, origin } = field
  const native = space.basis.unit === 'source-unit' && space.basis.sourceUnit === 'warcraft3-world-unit'
  const scale = native ? 1 : CELL / cellSize
  if (!native) diagnostics.push(loss('map-world-rescaled', `one ${String(cellSize)}-unit grid cell is written as one 128-unit cell of the map`))
  // UVW row 0 is the north edge; W3E row 0 the south.
  const uvwRow = (row: number) => rows - 1 - row
  const centerOffset: [number, number] = [origin[0] * scale, -(origin[2] + (rows - 1) * cellSize) * scale]

  const tileOf = (id: string | undefined) => (id !== undefined && /^tile-[\x20-\x7e]{4}$/u.test(id) ? id.slice(5) : undefined)
  const defaultTile = settings.defaultTile ?? 'Ldrt'
  const tiles: string[] = []
  const tileIndex = (tile: string) => {
    let index = tiles.indexOf(tile)
    if (index < 0) {
      if (tiles.length >= 16) return 0
      tiles.push(tile)
      index = tiles.length - 1
    }
    return index
  }
  let tooMany = false
  const textures: number[] = []
  const blighted: boolean[] = []
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const weights = materials?.columns === columns && materials.rows === rows ? materials.samples?.[uvwRow(row)]?.[column]?.weights : undefined
      const heaviest = weights?.reduce((best, item) => (item.weight > best.weight ? item : best))
      // Blight is a flag over the corner's ground, which the world does not keep under it.
      const blight = heaviest?.materialId === `tile-${BLIGHT_MATERIAL}`
      blighted.push(blight)
      const tile = (blight ? undefined : tileOf(heaviest?.materialId)) ?? defaultTile
      if (tiles.length >= 16 && !tiles.includes(tile)) tooMany = true
      textures.push(tileIndex(tile))
    }
  if (tooMany) diagnostics.push(loss('map-tiles-dropped', 'a map holds 16 ground tilesets; corners of the others take the first'))
  if (materials === undefined) diagnostics.push(loss('map-tiles-default', `the world has no terrain materials: every corner is ${defaultTile}`))
  if (tiles.length === 0) tiles.push(defaultTile)
  if (blighted.includes(true)) diagnostics.push(loss('map-blight-ground', `blighted corners keep their blight over ${defaultTile}: the world does not hold the ground under it`))

  const w3e = encodeW3e(tiles[0]!.charAt(0), tiles, columns, rows, centerOffset, (column, row) => {
    const height = (field.samples[uvwRow(row)]?.[column] ?? 0) * scale
    const level = cliffs?.columns === columns && cliffs.rows === rows ? (cliffs.levels[uvwRow(row)]?.[column] ?? 2) : 2
    return { ground: height / CELL - level + 2, level, texture: textures[row * columns + column] ?? 0, blight: blighted[row * columns + column] ?? false }
  })

  const doo = new War3MapDoo()
  doo.version = OBJECT_VERSION
  doo.u1 = new Uint8Array([OBJECT_SUBVERSION, 0, 0, 0])
  const units = new War3MapUnitsDoo()
  units.version = OBJECT_VERSION
  units.subversion = OBJECT_SUBVERSION
  let untyped = 0
  const derivedCliffs = objectLayers.flatMap(layer => layer.instances)
    .filter(instance => instance.derivedFrom === 'cliffs').length
  if (derivedCliffs > 0)
    diagnostics.push(loss('map-derived-cliff-presentation', `${String(derivedCliffs)} generated cliff meshes are not doodad placements; target terrain regenerates geometry, source mesh appearance is not qualified`))
  const starts = new Set<number>()
  for (const layer of objectLayers)
    for (const instance of layer.instances) {
      if (instance.derivedFrom === 'cliffs') continue
      const point = instance.objectKind === 'point'
      const typeId = point && instance.typeId === undefined ? 'sloc' : instance.typeId
      if (typeId === undefined || !/^[\x20-\x7e]{4}$/u.test(typeId) || instance.objectKind === 'camera') {
        untyped += 1
        continue
      }
      const [x, y, z] = instance.position
      const location = new Float32Array([x * scale, -z * scale, y * scale])
      const angle = yawOf(instance.rotation)
      const objectScale = new Float32Array([instance.scale[0], instance.scale[2], instance.scale[1]])
      if (instance.objectKind === 'doodad' || instance.objectKind === 'feature') {
        const doodad = new Doodad()
        doodad.id = typeId
        doodad.variation = instance.variation ?? 0
        doodad.location = location
        doodad.angle = angle
        doodad.scale = objectScale
        doodad.flags = 2
        doodad.life = 100
        doodad.editorId = doo.doodads.length
        doo.doodads.push(doodad)
        continue
      }
      const unit = new Unit()
      unit.id = typeId
      unit.variation = instance.variation ?? 0
      unit.location = location
      unit.angle = angle
      unit.scale = objectScale
      unit.flags = 2
      unit.player = instance.player ?? 0
      unit.creationNumber = units.units.length
      if (typeId === 'sloc') starts.add(unit.player)
      units.units.push(unit)
    }
  if (untyped > 0) diagnostics.push(loss('map-objects-untyped', `${String(untyped)} object(s) without a four-character game type are not written`))

  const info = new War3MapW3i()
  info.version = 25
  info.name = settings.name ?? space.label ?? 'Converted world'
  info.author = 'Modkit'
  info.tileset = tiles[0]!.charAt(0)
  info.playableSize = new Int32Array([columns - 1, rows - 1])
  const left = centerOffset[0]
  const bottom = centerOffset[1]
  const right = left + (columns - 1) * CELL
  const top = bottom + (rows - 1) * CELL
  info.cameraBounds = new Float32Array([left, bottom, right, top, left, top, right, bottom])
  info.lightEnvironmentTileset = '\0'
  info.players = [...starts].sort((a, b) => a - b).map(id => {
    const player = new Player()
    player.id = id
    player.type = 1
    player.race = 0
    player.name = `Player ${String(id + 1)}`
    return player
  })
  info.recommendedPlayers = String(info.players.length)

  diagnostics.push(loss('map-script-missing', 'no map script, pathing or shadow map is written: open and save the map in the World Editor before the game runs it'))
  const mpq = encodeFreshMpq(
    [
      { path: 'war3map.w3e', bytes: w3e },
      { path: 'war3map.w3i', bytes: info.save() },
      { path: 'war3map.doo', bytes: doo.save(BUILD_VERSION) },
      { path: 'war3mapUnits.doo', bytes: units.save(BUILD_VERSION) },
    ],
    256 << 20,
    signal === undefined ? {} : { signal },
  )
  const header = hm3w(info.name, info.players.length)
  const bytes = new Uint8Array(header.byteLength + mpq.byteLength)
  bytes.set(header)
  bytes.set(mpq, header.byteLength)
  return { bytes, diagnostics: Object.freeze(diagnostics) }
}
