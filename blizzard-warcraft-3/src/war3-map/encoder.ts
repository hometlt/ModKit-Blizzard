import { pureYawQuaternion } from '@modkit/codec-kit/model-math/transform'
/**
 * A UVW world written as a Warcraft III map (`common.map/native-encoder`, WT10): `.w3x`, the HM3W
 * header and an MPQ (`@modkit/blizzard-mpq/fresh-writer`) holding `war3map.w3e`, `war3map.w3i`,
 * `war3map.doo`, `war3mapUnits.doo` and optional qualified `war3map.wpm`.
 * The way there is the map world (`war3-map-world/world.ts`).
 *
 * - Frame: ADR-WORLD-003 read backwards, map-native `(x, y, z) = (X, -Z, Y)`, the heightfield's
 *   rows from the north. A world in `warcraft3-world-unit` keeps its 128-unit cells; a world of
 *   another unit is written one grid cell to one cell of the map, its lengths scaled to match.
 * - Terrain: each corner's height h and cliff level L (the `cliffs` layer, 2 without one) become
 *   the W3E ground height `h / 128 − L + 2`, so a map the world came from writes back its own
 *   heights; ground tiles come from `terrain-materials` (a material `tile-XXXX` is tileset XXXX,
 *   the heaviest weight of a corner wins), 16 at most.
 * - Navigation: qualified `blizzard/war3-wpm@1` byte flags on the exact 32-unit cell-centre grid
 *   are written by the existing WPM writer. Foreign vocabularies and geometry are refused.
 * - Objects: a game type id of four characters is required. Doodads and features go to
 *   `war3map.doo`, units, structures and start locations (`sloc`) to `war3mapUnits.doo`; the yaw
 *   about UVW +Y is the map's angle.
 * - Information (`war3map.w3i`, format 25 as 1.24 writes it): the name, the playable area as the
 *   whole grid and one player slot per start location.
 * - Omitted layers and authored placement/roster fields are reported (SPEC_UVM_CONVERSION §5):
 *   water, regions, other spaces, objects without a type, and the map script (`war3map.j`) and shadow maps the World Editor
 *   writes when it saves the map — until then the game does not run it.
 */
import type { Diagnostic } from '@modkit/core'
import { parseUvwProfile, unretainedWorldFields, type UvwGameRasterLayer, type UvwCliffsLayer, type UvwHeightfieldLayer, type UvwObjectsLayer, type UvwTerrainMaterialsLayer } from '@modkit/uv/world'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import War3MapDoo from '../lib/mdx-m3-viewer/parsers/w3x/doo/file.js'
import Doodad from '../lib/mdx-m3-viewer/parsers/w3x/doo/doodad.js'
import War3MapUnitsDoo from '../lib/mdx-m3-viewer/parsers/w3x/unitsdoo/file.js'
import Unit from '../lib/mdx-m3-viewer/parsers/w3x/unitsdoo/unit.js'
import War3MapW3i from '../lib/mdx-m3-viewer/parsers/w3x/w3i/file.js'
import Player from '../lib/mdx-m3-viewer/parsers/w3x/w3i/player.js'
import War3MapWpm from '../lib/mdx-m3-viewer/parsers/w3x/wpm/file.js'
import War3MapW3e from '../lib/mdx-m3-viewer/parsers/w3x/w3e/file.js'
import { BLIGHT_MATERIAL, WAR3_PATHING_FLAG_ENCODING, WAR3_TERRAIN_RASTERS, war3MapLayers, writeWar3MapLayer } from './map.js'

export const WAR3_MAP_FORMAT_ID = 'war3-map'

export interface War3MapEncodeOptions {
  readonly name?: string
  /** The ground tile a corner gets without a material of its own (`Ldrt`). */
  readonly defaultTile?: string
  /** Explicit canonical UVW material id to case-sensitive native tileset id (or blight). */
  readonly materialMappings?: Readonly<Record<string, string>>
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
  const { name, defaultTile, materialMappings, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) throw new TypeError(`Warcraft III map encoder has no option ${Object.keys(rest).join(', ')}`)
  if (name !== undefined && typeof name !== 'string') throw new TypeError('name must be text')
  if (defaultTile !== undefined && !(typeof defaultTile === 'string' && /^[\x20-\x7e]{4}$/u.test(defaultTile))) throw new TypeError('defaultTile must be a four-character tileset id')
  const mappings: Record<string, string> = Object.create(null) as Record<string, string>
  if (materialMappings !== undefined) {
    if (materialMappings === null || typeof materialMappings !== 'object' || Array.isArray(materialMappings))
      throw new TypeError('materialMappings must be an object of canonical material ids to native tileset ids')
    for (const [id, tile] of Object.entries(materialMappings)) {
      if (!/^[a-z][a-z0-9-]*$/u.test(id) || typeof tile !== 'string' ||
          (tile !== BLIGHT_MATERIAL && !/^[\x20-\x7e]{4}$/u.test(tile)))
        throw new TypeError('materialMappings requires canonical material ids and four-character native tileset ids or blight')
      mappings[id] = tile
    }
  }
  return { ...(name === undefined ? {} : { name }), ...(defaultTile === undefined ? {} : { defaultTile }),
    ...(materialMappings === undefined ? {} : { materialMappings: Object.freeze(mappings) }) }

}

/** The W3E corners: 7 bytes each, as the game reads them (Warsmash `Corner.save` field order). */
function encodeW3e(
  tileset: string,
  groundTilesets: readonly string[],
  columns: number,
  rows: number,
  centerOffset: readonly [number, number],
  diagnostics: Diagnostic[],
  corner: (column: number, row: number) => { readonly ground: number; readonly level: number; readonly texture: number; readonly blight: boolean },
  cliffTilesets: readonly string[] = ['CLdi'],
): Uint8Array {
  const header = 4 + 4 + 1 + 4 + 4 + groundTilesets.length * 4 + 4 + cliffTilesets.length * 4 + 8 + 8
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
  // An explicit native raster catalogue, or the default Lordaeron cliff set.
  view.setInt32(at, cliffTilesets.length, true), (at += 4)
  for (const id of cliffTilesets) ascii(id)
  view.setInt32(at, columns, true), (at += 4)
  view.setInt32(at, rows, true), (at += 4)
  view.setFloat32(at, centerOffset[0], true), (at += 4)
  view.setFloat32(at, centerOffset[1], true), (at += 4)
  let roundedHeights = 0
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const { ground, level, texture, blight } = corner(column, row)
      // Ground: 8192 at zero, 512 a level; water at the same base, map edge clear.
      const encodedHeight = ground * 512 + 8192
      if (!Number.isFinite(encodedHeight) || encodedHeight < -32768 || encodedHeight > 32767)
        throw new TypeError(`terrain corner ${String(column)},${String(row)} height is outside the native signed int16 range`)
      if (!Number.isInteger(level) || level < 0 || level > 15)
        throw new TypeError(`terrain corner ${String(column)},${String(row)} cliff level is outside the native 4-bit range`)
      if (encodedHeight !== Math.round(encodedHeight)) roundedHeights += 1
      view.setInt16(at, Math.round(encodedHeight), true)
      view.setInt16(at + 2, 8192, true)
      bytes[at + 4] = (texture & 0x0f) | (blight ? 0x20 : 0)
      bytes[at + 5] = 0
      bytes[at + 6] = level & 0x0f
      at += 7
    }
  if (roundedHeights > 0) diagnostics.push(loss('map-terrain-height-quantized', `${String(roundedHeights)} terrain corner(s) rounded to the native quarter-unit height quantum`))
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
  const angle = pureYawQuaternion(rotation)
  if (angle === undefined) throw new TypeError('Warcraft III placed objects support only canonical yaw')
  const turn = Math.PI * 2
  return ((angle % turn) + turn) % turn
}

/** Admit the actual native placement scalar before Float32Array can erase its value. */
function nativeFloat32(value: number, field: string, diagnostics: Diagnostic[], code = 'map-object-value-quantized'): number {
  const encoded = Math.fround(value)
  if (!Number.isFinite(encoded) || (encoded === 0 && value !== 0))
    throw new TypeError(`${field} is outside the finite nonzero native float32 range`)
  if (encoded !== value) diagnostics.push(loss(code, `${field} is rounded from ${String(value)} to ${String(encoded)} for native float32 storage`))
  return encoded
}

/** The world as a `.w3x` file's bytes and what it lost. */
export function encodeWar3Map(uvw: Uint8Array, rawOptions?: unknown, signal?: AbortSignal): { readonly bytes: Uint8Array; readonly diagnostics: readonly Diagnostic[] } {
  const settings = options(rawOptions)
  const document = parseUvwProfile(uvw, signal === undefined ? {} : { signal })
  const diagnostics: Diagnostic[] = []
  const [space, ...others] = document.spaces
  if (space === undefined) throw new TypeError('the world has no space to write')
  const retainedSpaceFields = new Set(['id', 'topology', 'basis', 'bounds', 'layers',
    ...(settings.name === undefined || settings.name === space.label ? ['label'] : [])])
  for (const field of unretainedWorldFields(space, field => retainedSpaceFields.has(field)))
    diagnostics.push(loss('map-field-dropped', `spaces[0].${field} is not written; generated map metadata is not a preserved source roster/preset`))
  if (others.length > 0) diagnostics.push(loss('map-spaces-dropped', `${String(others.length)} more space(s): a map holds one`))
  const field = space.layers.find((layer): layer is UvwHeightfieldLayer => layer.kind === 'heightfield' && layer.role !== 'query')
  if (field === undefined) throw new TypeError('the world has no rendered ground heightfield to write as terrain')
  const cliffs = space.layers.find((layer): layer is UvwCliffsLayer => layer.kind === 'cliffs')
  const materials = space.layers.find((layer): layer is UvwTerrainMaterialsLayer => layer.kind === 'terrain-materials')
  const navigationLayers = space.layers.filter(layer => layer.kind === 'navigation')
  if (navigationLayers.length > 1) throw new TypeError('Warcraft III has one WPM grid; multiple navigation layers need an explicit mapping')
  const navigation = navigationLayers[0]
  const objectLayers = space.layers.filter((layer): layer is UvwObjectsLayer => layer.kind === 'objects')
  const nativeRasters = space.layers.filter((layer): layer is UvwGameRasterLayer =>
    layer.kind === 'game-raster' && Object.values(WAR3_TERRAIN_RASTERS).some(metadata => metadata.valueMeaning === layer.valueMeaning))
  const retainedLayers = new Set<object | undefined>([field, cliffs, materials, navigation, ...objectLayers, ...nativeRasters])
  for (const layer of space.layers)
    if (!retainedLayers.has(layer))
      diagnostics.push(loss('map-layer-dropped', `layer ${layer.id} (${layer.kind}) is not written: the map has no place for it yet`))

  const { columns, rows, cellSize, origin } = field
  const native = space.basis.unit === 'source-unit' && space.basis.sourceUnit === 'warcraft3-world-unit'
  if (native && cellSize !== CELL)
    throw new TypeError('Warcraft III native terrain requires 128-unit cells; an explicit coordinate mapping is needed')
  if (cliffs !== undefined && (cliffs.columns !== columns || cliffs.rows !== rows ||
      cliffs.cellSize !== cellSize || cliffs.origin[0] !== origin[0] || cliffs.origin[2] !== origin[2]))
    throw new TypeError('Warcraft III cliff levels require the same horizontal grid as rendered ground')
  if (materials !== undefined && (materials.columns !== columns || materials.rows !== rows ||
      materials.cellSize !== cellSize || materials.origin[0] !== origin[0] || materials.origin[2] !== origin[2]))
    throw new TypeError('Warcraft III terrain materials require the same horizontal grid as rendered ground')
  const noteTerrainFields = (record: object, retained: readonly string[], path: string) => {
    const fields = new Set(retained)
    for (const key of unretainedWorldFields(record, key => fields.has(key)))
      diagnostics.push(loss('map-terrain-field-dropped', `${path}.${key} is not written by the native terrain writer`))
  }
  const gridFields = ['id', 'kind', 'columns', 'rows', 'cellSize', 'origin']
  noteTerrainFields(field, [...gridFields, 'role', 'samples'], `layers.${field.id}`)
  if (cliffs !== undefined) noteTerrainFields(cliffs, [...gridFields, 'schemaVersion', 'levels'], `layers.${cliffs.id}`)
  if (materials !== undefined) noteTerrainFields(materials, [...gridFields, 'schemaVersion', 'materials', 'samples'], `layers.${materials.id}`)
  const scale = native ? 1 : CELL / cellSize
  if (!native) diagnostics.push(loss('map-world-rescaled', `one ${String(cellSize)}-unit grid cell is written as one 128-unit cell of the map`))
  // UVW row 0 is the north edge; W3E row 0 the south.
  const uvwRow = (row: number) => rows - 1 - row
  const terrainScalar = (value: number, field: string) => nativeFloat32(value, `terrain.${field}`, diagnostics, 'map-terrain-coordinate-quantized')
  const centerOffset: [number, number] = [terrainScalar(origin[0] * scale, 'origin.x'), terrainScalar(-(origin[2] + (rows - 1) * cellSize) * scale, 'origin.z')]

  const tileOf = (id: string | undefined): string | undefined => id === undefined ? undefined
    : settings.materialMappings?.[id] ?? (id === `tile-${BLIGHT_MATERIAL}` ? BLIGHT_MATERIAL
      : /^tile-[\x20-\x7e]{4}$/u.test(id) ? id.slice(5) : undefined)
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
  let reducedWeights = 0
  let defaultedMaterials = 0
  const sampleFieldLosses = new Map<string, number>()
  let tooMany = false
  const textures: number[] = []
  const blighted: boolean[] = []
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const sample = materials?.samples?.[uvwRow(row)]?.[column]
      const weights = sample?.weights
      if (sample !== undefined)
        for (const key of unretainedWorldFields(sample, key => key === 'weights'))
          sampleFieldLosses.set(key, (sampleFieldLosses.get(key) ?? 0) + 1)
      if (weights !== undefined && weights.length > 0 && (weights.length !== 1 || weights[0]!.weight !== 1)) reducedWeights += 1
      const heaviest = weights?.reduce((best, item) => (item.weight > best.weight ? item : best))
      // Blight is a flag over the corner's ground, which the world does not keep under it.
      const mappedTile = tileOf(heaviest?.materialId)
      const blight = mappedTile === BLIGHT_MATERIAL
      blighted.push(blight)
      if (materials !== undefined && !blight && mappedTile === undefined) defaultedMaterials += 1
      const tile = (blight ? undefined : mappedTile) ?? defaultTile
      if (tiles.length >= 16 && !tiles.includes(tile)) tooMany = true
      textures.push(tileIndex(tile))
    }
  if (reducedWeights > 0) diagnostics.push(loss('map-material-weights-reduced', `${String(reducedWeights)} terrain sample(s) keep only the dominant material id; authored weights are not written`))
  if (defaultedMaterials > 0) diagnostics.push(loss('map-material-defaulted', `${String(defaultedMaterials)} terrain sample(s) have no mapped native tile id and use ${defaultTile}`))
  for (const [key, count] of sampleFieldLosses)
    diagnostics.push(loss('map-material-sample-field-dropped', `${String(count)} terrain sample(s): layers.${materials!.id}.samples[].${key} is not written`))
  for (const material of materials?.materials ?? []) {
    const tile = tileOf(material.id)
    const retained = (tile !== undefined && tiles.includes(tile)) ||
      (tile === BLIGHT_MATERIAL && blighted.includes(true))
    noteTerrainFields(material, retained ? ['id'] : [], `layers.${materials!.id}.materials.${material.id}`)
  }
  if (tooMany) diagnostics.push(loss('map-tiles-dropped', 'a map holds 16 ground tilesets; corners of the others take the first'))
  if (materials === undefined) diagnostics.push(loss('map-tiles-default', `the world has no terrain materials: every corner is ${defaultTile}`))
  if (tiles.length === 0) tiles.push(defaultTile)
  if (blighted.includes(true)) diagnostics.push(loss('map-blight-ground', `blighted corners keep their blight over ${defaultTile}: the world does not hold the ground under it`))

  const terrainCorner = (column: number, row: number) => {
    const sample = field.samples[uvwRow(row)]?.[column]
    if (sample === undefined || sample === field.noDataValue)
      throw new TypeError(`terrain corner ${String(column)},${String(row)} has NoData; native W3E requires a height`)
    const height = sample * scale
    const level = cliffs?.columns === columns && cliffs.rows === rows ? (cliffs.levels[uvwRow(row)]?.[column] ?? 2) : 2
    return { ground: height / CELL - level + 2, level, texture: textures[row * columns + column] ?? 0, blight: blighted[row * columns + column] ?? false }
 }

  let rasterMap: { terrain: War3MapW3e; strings: Map<number, string>; failures: [] } | undefined
  if (nativeRasters.length > 0) {
    if (!native) throw new TypeError('W3E native rasters require a Warcraft III source-unit frame; foreign policy needs an explicit mapping')
    const nativeTerrain = new War3MapW3e()
    nativeTerrain.mapSize = new Int32Array([columns, rows])
    nativeTerrain.groundTilesets = [...tiles]
    nativeTerrain.cliffTilesets = ['CLdi']
    const map = { terrain: nativeTerrain, strings: new Map<number, string>(), failures: [] as [] }
    rasterMap = map
    const seen = new Set<string>()
    const categories = (layer: UvwGameRasterLayer): string[] => {
      if (layer.categories === undefined || layer.categories.length < 1 || layer.categories.length > 16)
        throw new TypeError('W3E native tileset rasters require one to sixteen declared native categories')
      return layer.categories.map((category, index) => {
        if (category.value !== index || !/^[\x20-\x7e]{4}$/u.test(category.label) || category.color !== undefined)
          throw new TypeError('W3E native categories must be consecutive indices and exact four-character tileset ids without colour inference')
        return category.label
      })
    }
    for (const layer of nativeRasters) {
      if (seen.has(layer.valueMeaning)) throw new TypeError('duplicate W3E native raster vocabulary')
      seen.add(layer.valueMeaning)
      const id = Object.keys(WAR3_TERRAIN_RASTERS).find(id => WAR3_TERRAIN_RASTERS[id]!.valueMeaning === layer.valueMeaning)!
      const descriptor = war3MapLayers(map).get(id)!.descriptor
      if (layer.columns !== columns || layer.rows !== rows || layer.cellSize !== cellSize ||
          layer.origin[0] !== origin[0] || layer.origin[2] !== origin[2])
        throw new TypeError('W3E native raster requires the same horizontal grid as rendered ground')
      if (layer.valueType !== WAR3_TERRAIN_RASTERS[id]!.valueType || layer.sampling !== 'vertex' || layer.minimum !== descriptor.minimum || layer.maximum !== descriptor.maximum ||
          layer.unit !== descriptor.unit || layer.valueScale !== descriptor.valueScale || layer.valueOffset !== descriptor.valueOffset || layer.noDataValue !== undefined)
        throw new TypeError('W3E native raster metadata must use the exact native vertex vocabulary')
      if (id === 'ground-texture') {
        nativeTerrain.groundTilesets = categories(layer)
        if (materials !== undefined) diagnostics.push(loss('map-material-native-overridden', `layers.${materials.id} is superseded by the authored native ground-texture raster`))
      } else if (id === 'cliff-texture') nativeTerrain.cliffTilesets = categories(layer)
      else if (layer.categories !== undefined) throw new TypeError('W3E scalar flags/variation rasters have no tileset category dictionary')
      noteTerrainFields(layer, ['schemaVersion', 'id', 'kind', 'columns', 'rows', 'cellSize', 'origin', 'samples',
        'valueMeaning', 'valueType', 'sampling', 'minimum', 'maximum', 'categories', 'unit', 'valueScale', 'valueOffset'], `layers.${layer.id}`)
    }
  }
  let w3e = encodeW3e(tiles[0]!.charAt(0), rasterMap?.terrain.groundTilesets ?? tiles,
    columns, rows, centerOffset, diagnostics, terrainCorner, rasterMap?.terrain.cliffTilesets)
  if (rasterMap !== undefined)
    for (const layer of nativeRasters) {
      const id = Object.keys(WAR3_TERRAIN_RASTERS).find(id => WAR3_TERRAIN_RASTERS[id]!.valueMeaning === layer.valueMeaning)!
      w3e = writeWar3MapLayer(rasterMap, w3e, { layer: id, width: columns, height: rows, values: layer.samples.flat() }).bytes
    }

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
      const isDoodad = instance.objectKind === 'doodad' || instance.objectKind === 'feature'
      const retained = new Set(['objectKind', 'position', 'rotation', 'scale', 'typeId', 'variation',
        ...(isDoodad ? [] : ['player'])])
      for (const field of unretainedWorldFields(instance, (field, value) => retained.has(field) ||
        (field === 'resourceIds' && Array.isArray(value) && value.length === 0)))
        diagnostics.push(loss('map-object-field-dropped', `objects.${layer.id}.${instance.id}.${field} is not written by the native placement writer`))
      const [x, y, z] = instance.position
      const path = `objects.${layer.id}.${instance.id}`
      const variation = instance.variation ?? 0
      if (!Number.isInteger(variation) || variation < 0 || variation > 0x7fffffff)
        throw new TypeError(`${path}.variation is outside the native nonnegative int32 range`)
      const scalar = (value: number, field: string) => nativeFloat32(value, `${path}.${field}`, diagnostics)
      const location = new Float32Array([scalar(x * scale, 'position.x'), scalar(-z * scale, 'position.z'), scalar(y * scale, 'position.y')])
      const angle = scalar(yawOf(instance.rotation), 'rotation.yaw')
      const objectScale = new Float32Array([scalar(instance.scale[0], 'scale.x'), scalar(instance.scale[2], 'scale.z'), scalar(instance.scale[1], 'scale.y')])
      if (instance.objectKind === 'doodad' || instance.objectKind === 'feature') {
        const doodad = new Doodad()
        doodad.id = typeId
        doodad.variation = variation
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
      unit.variation = variation
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

  let pathingBytes: Uint8Array | undefined
  if (navigation?.kind === 'navigation') {
    if (navigation.flagEncoding !== WAR3_PATHING_FLAG_ENCODING)
      throw new TypeError('Warcraft III pathing refuses a foreign or unknown navigation flagEncoding')
    if (cellSize * scale !== CELL || navigation.columns !== (columns - 1) * 4 || navigation.rows !== (rows - 1) * 4 ||
      navigation.cellSize * scale !== CELL / 4 || navigation.origin[1] !== 0 ||
      navigation.origin[0] !== origin[0] + cellSize / 8 || navigation.origin[2] !== origin[2] + cellSize / 8)
      throw new TypeError('Warcraft III pathing requires its exact 32-unit cell-centre grid')
    const pathing = new War3MapWpm()
    pathing.size = new Int32Array([navigation.columns, navigation.rows])
    pathing.pathing = new Uint8Array(navigation.columns * navigation.rows)
    for (let row = 0; row < navigation.rows; row += 1) {
      for (let column = 0; column < navigation.columns; column += 1) {
        const flags = navigation.samples[navigation.rows - 1 - row]![column]!
        if (!Number.isSafeInteger(flags) || flags < 0 || flags > 255)
          throw new TypeError('Warcraft III pathing flags must fit native uint8 without truncation')
        pathing.pathing[row * navigation.columns + column] = flags
      }
    }
    pathingBytes = pathing.save()
  } else diagnostics.push(loss('map-pathing-missing', 'no qualified native WPM navigation grid was supplied'))
  diagnostics.push(loss('map-script-missing', 'no map script or shadow map is written: open and save the map in the World Editor before the game runs it'))
  const mpq = encodeFreshMpq(
    [
      { path: 'war3map.w3e', bytes: w3e },
      { path: 'war3map.w3i', bytes: info.save() },
      ...(pathingBytes === undefined ? [] : [{ path: 'war3map.wpm', bytes: pathingBytes }]),
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
