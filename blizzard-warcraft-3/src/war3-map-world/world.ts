/**
 * The world of a Warcraft III map for the common map viewer (`common.map/semantic-analysis` and
 * `common.map/resolved-workspace`): the host reads the map's documents and the game's tables, this
 * provider turns them into a snapshot, and the host builds the world scene from it.
 *
 * - Terrain: the corners of `war3map.w3e`, `mapSize` of them, 128 world units apart from the
 *   centre offset; row 0 is the south edge, as the game stores it. A corner's height is its ground
 *   height plus its cliff level: `groundHeight·128 + (layerHeight − 2)·128` (the parser already
 *   divides the raw value by 512), as the accepted oracle reads it (ADR-WORLD-003). Warsmash's half
 *   level at the foot of a ramp entrance (`cliffs.ts`) is a presentation adjustment: drawn, not exported.
 *   The native frame is the game's world: x east, y north, z up. Its transform to UVW canonical,
 *   `(x, y, z) -> (x, z, -y)` with rows from the north, carries its proof against mdx-m3-viewer
 *   (`WAR3_WORLD_ORACLE`, digests recomputed from the installation by the real tier).
 * - Materials: a corner's ground tileset, the texture `Terrain.slk` names (`dir\file.blp`). A tileset
 *   texture is an atlas of 64-pixel tiles, 4×4 or 8×4 with variations, whose first tile is full
 *   ground in both; each cell samples u ∈ [0, 1/8], v ∈ [0, 1/4], which lies in that tile either
 *   way, and states its tilesets as `layers` of atlas tiles (Warsmash `getTextureVariations`).
 *   ponytail: the lowest layer draws tile 0 or 15; the variation tiles need the texture's width.
 * - Objects: the doodads and destructables of `war3map.doo` and the units and items of
 *   `war3mapUnits.doo`, each with its model: the `file` of its table (`Doodads.slk`,
 *   `DestructableData.slk`, `unitUI.slk`, `ItemData.slk`), resolved with the map's object-editor
 *   map/skin/campaign changes and scoped trigger strings by the one object-data resolver; its
 *   diagnostics also reach the map snapshot. A model with variations gets the object's variation
 *   number before `.mdx`. Start locations are points. Units, items and start locations stand on the
 *   ground: their height is the terrain's at their place, split as the oracle splits a cell.
 * - Players: the information file's slots with their names, races and forces, each with its slot
 *   colour (`TeamColorNN`), which tints the team-colour layer of its units.
 * - Cliffs and ramps (`cliffs.ts`, adapted from WarsmashModEngine): a cell whose four corners stand
 *   on different cliff levels is a cliff piece, the model `Doodads\Terrain\<dir>\<dir><levels>
 *   <variation>.mdx` of its bottom-left corner's cliff tileset (`CliffTypes.slk` `cliffModelDir`),
 *   the levels spelled A, B, C… from the lowest in the order bottom left, top left, top right,
 *   bottom right, placed at the cell's bottom-right corner on the lowest level. The game has fewer
 *   variations of some pieces than a corner may ask for, so the corner's variation and every lower
 *   one are the candidates and the installation decides. Where the ramp flags of a cliff cell split
 *   it across, the piece is the ramp wall `<rampModelDir><name>0.mdx` (L and H spell ramp corners)
 *   covering it and the cell down the slope; ramp entrances are sloped ground. The game bends each
 *   piece over the ground heights under it; here a piece stands at their mean. Corners of cliff and
 *   ramp pieces show the ground tileset the cliff set names.
 * - Water: the cells with a water corner, at the bottom-left corner's water height plus the
 *   tileset's water offset (`TerrainArt/Water.slk`, row `<tileset>Sha`), in zones of neighbouring
 *   cells at one height, coloured and textured as that row says.
 * - Regions: the `war3map.w3r` rectangles in world units.
 * - Cameras: the `war3map.w3c` cameras as camera objects at their target and yaw.
 * - Navigation: the `war3map.wpm` pathing flags as a sampled summary.
 * - Blight: a blighted corner shows its tileset's blight texture over the ground (material `tile-blight`).
 * - Not published: lighting.
 * The rules of water and of placing cliffs were read from mdx-m3-viewer (MIT), those of ramps from
 * WarsmashModEngine (AGPL-3.0, by the owner's decision of 2026-09-29).
 */
import type { DataCatalogDocument, DataResolvedEntity } from '@modkit/sdk/data'
import type {
  LogicalResourceRequirement,
} from '@modkit/sdk'
import type {
  MapCliffPiece,
  MapCliffPieceModel,
  MapCliffSummary,
  MapPlacedObject,
  MapNavigationSample,
  MapNavigationSummary,
  MapPlayer,
  MapRegion,
  MapWorldCanonicalTransform,
  MapSemanticAnalysisRequest,
  MapSemanticDiagnostic,
  MapSemanticDocument,
  MapSemanticDocumentRequirement,
  MapSemanticSnapshot,
  MapTerrainMaterialSummary,
  MapTerrainNativeTransform,
  MapTerrainSummary,
  MapWaterSummary,
  MapWaterZone,
  ResolvedMapWorkspaceAnalysisRequest,
  ResolvedMapWorkspacePlan,
  ResolvedMapWorkspacePlanRequest,
  ResolvedMapWorkspaceSnapshot,
} from '@modkit/sdk/maps'
import { srgbToLinear } from '@modkit/codec-kit/raster'
import { decodeInput, parseSylk } from '@modkit/codec-kit/text'
import { analyzeWar3ResolvedData } from '../war3-data/provider.js'
import { WAR3_OBJECT_MOD_DOCUMENTS } from '../war3-data/tables.js'
import { BLIGHT_MATERIAL, readWar3Map, war3MapText, type War3Map } from '../war3-map/map.js'
import { terrainPieces } from './cliffs.js'

export const WAR3_GAME_ID = 'blizzard/warcraft-3'
export const WAR3_MAP_ANALYZER_ID = 'blizzard.warcraft3.maps'
export const WAR3_WORLD_SCENE_SOURCE_CONTRACT = 'blizzard.warcraft3/world-scene-source'

/** World units between two terrain corners. */
export const CORNER_UNITS = 128

/**
 * The map's regions (`war3map.w3r`): world-unit rectangles, the editor's colour (stored blue, green,
 * red, then 0xFF) as `255,R,G,B` like SC2's. Weather and ambient sound are not published.
 */
function regionsOf(map: War3Map, maxRegions: number): readonly MapRegion[] {
  return Object.freeze((map.regions?.regions ?? []).slice(0, maxRegions).map(region => {
    const [b = 0, g = 0, r = 0] = region.color
    return Object.freeze({
      regionId: region.creationNumber,
      name: region.name,
      color: `255,${String(r)},${String(g)},${String(b)}`,
      shapes: Object.freeze([Object.freeze({
        type: 'rect',
        parameters: Object.freeze({ min: `${String(region.left)},${String(region.bottom)}`, max: `${String(region.right)},${String(region.top)}` }),
      })]),
    })
  }))
}

/** The map's documents the world reads, from the map root. */
const MAP_DOCUMENTS: readonly (readonly [string, MapSemanticDocumentRequirement['kind'], boolean])[] = [
  ['war3map.w3i', 'terrain-native-parameters', false],
  ['war3map.w3e', 'terrain-height', true],
  ['war3map.doo', 'objects', false],
  ['war3mapUnits.doo', 'objects', false],
  // The object editor's changes: a custom unit's or doodad's model.
  ...WAR3_OBJECT_MOD_DOCUMENTS.filter(path => !path.startsWith('war3campaign.') && /\.w3[utbd]$/u.test(path))
    .map(path => [path, 'objects', false] as const),
  // Trigger strings: the players' names in the information file.
  ['war3map.wts', 'objects', false],
  ['war3map.w3r', 'regions', false],
  ['war3map.w3c', 'objects', false],
  ['war3map.wpm', 'navigation', false],
]
/** The game's tables it reads, from the workspace: the map's own copy first, then the game's. */
const TABLES: readonly (readonly [string, MapSemanticDocumentRequirement['kind']])[] = [
  ['TerrainArt/Terrain.slk', 'terrain-resource-index'],
  ['TerrainArt/CliffTypes.slk', 'terrain-resource-index'],
  ['TerrainArt/Water.slk', 'terrain-resource-index'],
  ['Doodads/Doodads.slk', 'objects'],
  ['Doodads/DoodadMetaData.slk', 'objects'],
  ['Units/DestructableData.slk', 'objects'],
  ['Units/DestructableMetaData.slk', 'objects'],
  ['Units/unitUI.slk', 'objects'],
  ['Units/UnitMetaData.slk', 'objects'],
  ['Units/ItemData.slk', 'objects'],
  // Reforged's art (model, variations, scale) is in the skin profiles; older versions have none
  ['Doodads/DoodadSkins.txt', 'objects'],
  ['Units/DestructableSkin.txt', 'objects'],
  ['Units/UnitSkin.txt', 'objects'],
  ['Units/ItemSkin.txt', 'objects'],
  ...WAR3_OBJECT_MOD_DOCUMENTS.filter(path => path.startsWith('war3campaign.') && /\.w3[utbd]$/u.test(path))
    .map(path => [path, 'objects'] as const),
  ['war3campaign.wts', 'objects'],
]

const fold = (path: string) => path.replaceAll('\\', '/').toLowerCase()
const tail = (path: string) => fold(path).split('/').slice(-2).join('/')

function diagnostic(severity: MapSemanticDiagnostic['severity'], code: string, message: string): MapSemanticDiagnostic {
  return Object.freeze({ severity, code: `blizzard.warcraft3/${code}`, message })
}

/** The map's documents and the game's tables the host reads. */
export async function planWar3Map(request: ResolvedMapWorkspacePlanRequest): Promise<ResolvedMapWorkspacePlan> {
  request.signal?.throwIfAborted()
  const workspace = request.workspace
  if (workspace.gameId !== WAR3_GAME_ID) throw new TypeError('workspace must be a Warcraft III workspace')
  const active = workspace.loadOrder.find(root => root.rootId === workspace.activeRootId)
  const base = { schemaVersion: 1 as const, workspaceId: workspace.workspaceId, gameId: WAR3_GAME_ID, analyzerId: WAR3_MAP_ANALYZER_ID }
  if (active === undefined)
    return Object.freeze({
      ...base,
      mapId: '',
      requirements: [],
      diagnostics: [diagnostic('error', 'map-active-root-unavailable', 'the workspace names no active map root')],
      complete: false,
    })
  const under = (path: string) => (active.sourcePath === '' ? path : `${active.sourcePath.replaceAll('\\', '/')}/${path}`)
  const requirements: MapSemanticDocumentRequirement[] = [
    ...MAP_DOCUMENTS.map(([path, kind, required]) => ({ requirementId: `war3-map:${path}`, path: under(path), kind, required })),
    ...TABLES.map(([path, kind]) => ({ requirementId: `war3-table:${path}`, path, kind, required: false, scope: 'workspace' as const })),
  ]
  const complete = requirements.length <= request.maxRequirements
  return Object.freeze({
    ...base,
    mapId: active.sourcePath,
    requirements: Object.freeze(complete ? requirements : []),
    diagnostics: complete
      ? []
      : [diagnostic('error', 'map-plan-budget-exceeded', `the map needs ${String(requirements.length)} reads`)],
    complete,
  })
}

/** A game table's rows by the id in its first column, each as its fields by column name. */
function table(bytes: Uint8Array | undefined): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const rows = new Map<string, Record<string, string>>()
  if (bytes === undefined) return rows
  const parsed = parseSylk(decodeInput({ bytes }))
  if (parsed.state === 'failed') return rows
  const [header, ...body] = parsed.document.rows
  const names = new Map((header?.cells ?? []).map(cell => [cell.column, cell.value]))
  for (const row of body) {
    const id = row.cells.find(cell => cell.column === 1)?.value
    if (id === undefined || id === '') continue
    const fields: Record<string, string> = {}
    for (const cell of row.cells) {
      const name = names.get(cell.column)
      if (name !== undefined) fields[name] = cell.value
    }
    rows.set(id, fields)
  }
  return rows
}

/** The resolved object data of the tables and the map's changes, by `namespace/id`. */
async function objectData(documents: readonly MapSemanticDocument[], request: MapSemanticAnalysisRequest) {
  const decoder = new TextDecoder()
  const catalog: DataCatalogDocument[] = documents.flatMap(document => {
    const path = document.path.replaceAll('\\', '/')
    if (/\.(slk|txt|wts)$/iu.test(path)) return [{ rootId: 'map-world', path, text: decoder.decode(document.bytes) }]
    if (WAR3_OBJECT_MOD_DOCUMENTS.some(file => fold(path) === fold(file) || fold(path).endsWith(`/${fold(file)}`)))
      return [{ rootId: 'map-world', path, text: '', bytes: document.bytes }]
    return []
  })
  const snapshot = await analyzeWar3ResolvedData({
    workspaceId: request.workspaceId,
    gameId: WAR3_GAME_ID,
    documents: catalog,
    queries: [],
    maxDocuments: catalog.length,
    maxTextBytes: request.maxTotalBytes,
    maxEntities: 100_000,
    maxDepth: request.maxDepth,
    plannedDocumentCount: catalog.length,
    unresolvedRequirementIds: [],
  })
  return {
    data: new Map(snapshot.definitions.map(entity => [`${entity.namespace}/${entity.entityId}`, entity] as const)),
    diagnostics: snapshot.diagnostics.map(item => diagnostic(item.severity, 'object-data', item.message)),
  }
}

const text = (entity: DataResolvedEntity | undefined, field: string) => {
  const value = entity?.fields[field]
  return typeof value === 'string' && value !== '' && value !== '_' && value !== '-' ? value : undefined
}

/**
 * An art field of an object: Reforged's skin profile, its HD value first (`Profile.file:hd`), then
 * the profile's own (`Profile.file`), then the column the sheets of older versions keep (`sheet`).
 * ponytail: the HD art set always; an SD art-set source would take `:sd` first.
 */
const art = (entity: DataResolvedEntity | undefined, key: string, sheet: string) =>
  text(entity, `Profile.${key}:hd`) ?? text(entity, `Profile.${key}`) ?? text(entity, sheet)

/** A table's `file` as the model the game loads: variation number before `.mdx`, when it has variations. */
function modelPath(file: string, variations: number, variation: number): string {
  const stem = file.replace(/\.md[lx]$/iu, '')
  return `${stem}${variations > 1 ? String(variation) : ''}.mdx`
}

/** An object's model, as the host joins it into the world's resources (by `modelResources`). */
function model(path: string): Pick<MapPlacedObject, 'modelResource' | 'modelResources'> {
  const requirement: LogicalResourceRequirement = Object.freeze({
    id: `war3-model:${encodeURIComponent(fold(path))}`,
    logicalId: path,
    role: 'sidecar' as const,
    scopes: Object.freeze(['current-mount', 'workspace-dependency-layer'] as const),
  })
  return { modelResource: requirement, modelResources: Object.freeze([requirement]) }
}

function placedObjects(map: War3Map, data: ReadonlyMap<string, DataResolvedEntity>, maxObjects: number) {
  const objects: MapPlacedObject[] = []
  const unresolved = new Set<string>()
  const place = (object: MapPlacedObject) => {
    if (objects.length < maxObjects) objects.push(Object.freeze(object))
  }
  for (const [index, doodad] of (map.doodads?.doodads ?? []).entries()) {
    const destructable = data.get(`destructable/${doodad.id}`)
    const entity = destructable ?? data.get(`doodad/${doodad.id}`)
    const sheet = destructable === undefined ? 'Doodads' : 'DestructableData'
    const file = art(entity, 'file', `${sheet}.file`)
    if (file === undefined) unresolved.add(doodad.id)
    const [x = 0, y = 0, z = 0] = doodad.location
    const [sx = 1, sy = 1, sz = 1] = doodad.scale
    place({
      kind: destructable === undefined ? 'doodad' : 'feature',
      objectId: objects.length,
      sourceKey: `doodad-${String(index)}`,
      position: { x, y, z },
      sourcePositionDimensions: 3,
      heightReference: 'absolute',
      rotation: doodad.angle,
      nativeRotationUnit: 'radians',
      scale: { x: sx, y: sy, z: sz },
      typeId: doodad.id,
      variation: doodad.variation,
      ...(file === undefined ? {} : model(modelPath(file, Number(art(entity, 'numVar', `${sheet}.numVar`) ?? '1'), doodad.variation))),
    })
  }
  for (const [index, unit] of (map.units?.units ?? []).entries()) {
    const [x = 0, y = 0] = unit.location
    // The game stands units, items and start locations on the ground: the file's z is not authored.
    const z = map.terrain === undefined ? (unit.location[2] ?? 0) : groundHeightAt(map.terrain, x, y)
    const base = { objectId: objects.length, sourceKey: `unit-${String(index)}`, position: { x, y, z }, typeId: unit.id }
    if (unit.id === 'sloc') {
      place({ ...base, kind: 'point', sourcePositionDimensions: 3, heightReference: 'absolute', player: unit.player, name: 'Start location' })
      continue
    }
    const item = data.get(`item/${unit.id}`)
    const entity = item ?? data.get(`unit/${unit.id}`)
    const file = art(entity, 'file', item === undefined ? 'UnitUI.file' : 'ItemData.file')
    if (file === undefined) unresolved.add(unit.id)
    const modelScale = Number(art(entity, 'modelScale', 'UnitUI.modelScale') ?? '1') || 1
    const [sx = 1, sy = 1, sz = 1] = unit.scale
    place({
      ...base,
      kind: 'unit',
      sourcePositionDimensions: 3,
      heightReference: 'absolute',
      rotation: unit.angle,
      nativeRotationUnit: 'radians',
      scale: { x: sx * modelScale, y: sy * modelScale, z: sz * modelScale },
      player: unit.player,
      variation: unit.variation,
      ...(file === undefined ? {} : model(modelPath(file, 1, 0))),
    })
  }
  // The map's cameras (war3map.w3c) at their target, its height above the ground; the yaw is the
  // camera's rotation in degrees. Distance, angle of attack, roll and field of view have no field yet.
  for (const [index, camera] of (map.cameras?.cameras ?? []).entries()) {
    const [x = 0, y = 0, zOffset = 0] = camera.targetLocation
    const z = (map.terrain === undefined ? 0 : groundHeightAt(map.terrain, x, y)) + zOffset
    place({
      kind: 'camera',
      objectId: objects.length,
      sourceKey: `camera-${String(index)}`,
      position: { x, y, z },
      sourcePositionDimensions: 3,
      heightReference: 'absolute',
      rotation: camera.rotation,
      nativeRotationUnit: 'degrees',
      name: camera.cinematicName,
    })
  }
  return { objects, unresolved }
}

/**
 * The ground height at a map-native point, as the accepted oracle (mdx-m3-viewer `w3x/map.ts`) splits a
 * cell: corners at ground plus cliff level, the triangle bottom-left, bottom-right, top-left below the
 * diagonal and top-right, top-left, bottom-right above it. A point off the map takes the nearest edge.
 */
function groundHeightAt(w3e: NonNullable<War3Map['terrain']>, x: number, y: number): number {
  const [columns = 0, rows = 0] = w3e.mapSize
  const [offsetX = 0, offsetY = 0] = w3e.centerOffset
  const height = (column: number, row: number) => {
    const corner = w3e.corners[row]?.[column]
    return corner === undefined ? 0 : (corner.groundHeight + corner.layerHeight - 2) * CORNER_UNITS
  }
  if (columns < 2 || rows < 2) return height(0, 0)
  const gx = Math.min(Math.max((x - offsetX) / CORNER_UNITS, 0), columns - 1)
  const gy = Math.min(Math.max((y - offsetY) / CORNER_UNITS, 0), rows - 1)
  const column = Math.min(Math.floor(gx), columns - 2)
  const row = Math.min(Math.floor(gy), rows - 2)
  const u = gx - column
  const v = gy - row
  const bottomLeft = height(column, row)
  const bottomRight = height(column + 1, row)
  const topLeft = height(column, row + 1)
  const topRight = height(column + 1, row + 1)
  return u + v < 1
    ? bottomLeft + (bottomRight - bottomLeft) * u + (topLeft - bottomLeft) * v
    : topRight + (topLeft - topRight) * (1 - u) + (bottomRight - topRight) * (1 - v)
}

const RACES = ['selectable', 'human', 'orc', 'undead', 'night elf'] as const

/**
 * The colour of each player slot of the classic game, the solid colour of its
 * `ReplaceableTextures\TeamColor\TeamColorNN.blp` (red, blue, teal … brown), sRGB 0–255.
 * ponytail: twelve slots of 1.24; a later build's 24 need its textures, read once the world loads them.
 */
const SLOT_COLORS: readonly (readonly [number, number, number])[] = [
  [255, 3, 3], [0, 66, 255], [28, 230, 185], [84, 0, 129], [255, 252, 1], [254, 186, 14],
  [32, 192, 0], [229, 91, 176], [149, 150, 151], [126, 191, 241], [16, 98, 70], [78, 42, 4],
]

/** The map's player slots from its information file, each in the force that names it, coloured by slot. */
function playersOf(map: War3Map): MapPlayer[] | undefined {
  const info = map.info
  if (info === undefined) return undefined
  return info.players.map(player => {
    const team = info.forces.findIndex(force => (force.playerMasks & (1 << player.id)) !== 0)
    const name = war3MapText(map, player.name)
    const color = SLOT_COLORS[player.id]
    return Object.freeze({
      id: player.id,
      ...(color === undefined ? {} : { color: Object.freeze([srgbToLinear(color[0] / 255), srgbToLinear(color[1] / 255), srgbToLinear(color[2] / 255)] as const) }),
      ...(name === '' ? {} : { name }),
      race: RACES[player.race] ?? String(player.race),
      ...(team < 0 ? {} : { team }),
    })
  })
}

function terrainOf(map: War3Map, maxSamples: number): MapTerrainSummary | undefined {
  const w3e = map.terrain
  if (w3e === undefined) return undefined
  const [width = 0, height = 0] = w3e.mapSize
  const cellCount = width * height
  if (cellCount === 0) return undefined
  const pieces = terrainPieces(w3e)
  const stride = cellCount <= maxSamples ? 1 : Math.ceil(cellCount / maxSamples)
  let minimum = Infinity
  let maximum = -Infinity
  const samples = []
  for (let index = 0; index < cellCount; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    const corner = w3e.corners[y]?.[x]
    // The authored height, as the accepted oracle reads it (ADR-WORLD-003): ground plus cliff level.
    const heightBase = corner === undefined ? 0 : (corner.groundHeight + corner.layerHeight - 2) * CORNER_UNITS
    // Warsmash's half level at a ramp entrance is drawn, not authored: UVW keeps the oracle's height.
    const lift = pieces.rampLift(x, y) * CORNER_UNITS
    minimum = Math.min(minimum, heightBase)
    maximum = Math.max(maximum, heightBase)
    if (index % stride === 0)
      samples.push(Object.freeze({ x, y, heightBase, heightAdjustment: 0, ...(lift === 0 ? {} : { presentationHeightAdjustment: lift }), mask: 0 }))
  }
  return Object.freeze({
    version: 1,
    width,
    height,
    cellCount,
    minimumHeightBase: minimum,
    maximumHeightBase: maximum,
    minimumHeightAdjustment: 0,
    maximumHeightAdjustment: 0,
    trailingBytes: 0,
    samples: Object.freeze(samples),
  })
}

/** The map read once, and its semantic snapshot: terrain from `war3map.w3e`, objects with their models. */
async function readSemantic(request: MapSemanticAnalysisRequest): Promise<{ map: War3Map; semantic: MapSemanticSnapshot }> {
  request.signal?.throwIfAborted()
  const diagnostics: MapSemanticDiagnostic[] = []
  const byName = new Map(request.documents.map(document => [fold(document.path).split('/').at(-1)!, document] as const))
  const map = await readWar3Map(async name => byName.get(name.toLowerCase())?.bytes, request.signal)
  for (const failure of map.failures) diagnostics.push(diagnostic('warning', 'map-document-unreadable', `${failure.path}: ${failure.message}`))
  if (map.terrain === undefined) diagnostics.push(diagnostic('error', 'map-terrain-missing', 'the map has no readable war3map.w3e'))
  const { data, diagnostics: objectDiagnostics } = await objectData(request.documents, request)
  diagnostics.push(...objectDiagnostics)
  const { objects, unresolved } = placedObjects(map, data, request.maxObjects)
  const total = (map.doodads?.doodads.length ?? 0) + (map.units?.units.length ?? 0) + (map.cameras?.cameras.length ?? 0)
  if (objects.length < total)
    diagnostics.push(diagnostic('warning', 'map-objects-truncated', `maxObjects keeps ${String(objects.length)} of the map's ${String(total)} objects`))
  if (unresolved.size > 0)
    diagnostics.push(diagnostic('warning', 'map-object-model-unresolved', `no table names the model of ${[...unresolved].slice(0, 12).join(', ')}${unresolved.size > 12 ? ' …' : ''}`))
  const terrain = terrainOf(map, Math.min(request.maxTerrainSamples, request.maxTerrainCells))
  const players = playersOf(map)
  const regions = regionsOf(map, request.maxRegions)
  if ((map.regions?.regions.length ?? 0) > regions.length)
    diagnostics.push(diagnostic('warning', 'map-regions-truncated', `maxRegions keeps ${String(regions.length)} of the map's ${String(map.regions?.regions.length)} regions`))
  const semantic: MapSemanticSnapshot = Object.freeze({
    schemaVersion: 1,
    workspaceId: request.workspaceId,
    gameId: WAR3_GAME_ID,
    mapId: request.mapId,
    analyzerId: WAR3_MAP_ANALYZER_ID,
    documentPaths: Object.freeze(request.documents.map(document => document.path)),
    ...(terrain === undefined ? {} : { terrain }),
    regions,
    objects: Object.freeze(objects),
    ...(players === undefined ? {} : { players: Object.freeze(players) }),
    catalogQueries: Object.freeze([]),
    resolvedCatalogObjects: 0,
    diagnostics: Object.freeze(diagnostics),
    complete: terrain !== undefined && diagnostics.every(item => item.severity !== 'error'),
  })
  return { map, semantic }
}

export async function openWar3Map(request: MapSemanticAnalysisRequest): Promise<MapSemanticSnapshot> {
  return (await readSemantic(request)).semantic
}

/** A cliff tileset of the map by index; one the map does not declare draws as the second (or only) set. */
function cliffTileset(map: War3Map, index: number): string | undefined {
  const sets = map.terrain?.cliffTilesets
  return sets?.[index] ?? sets?.[1] ?? sets?.[0]
}

function cliffsOf(map: War3Map, cliffTypes: ReadonlyMap<string, Readonly<Record<string, string>>>): MapCliffSummary | undefined {
  const w3e = map.terrain
  if (w3e === undefined) return undefined
  const [columns = 0, rows = 0] = w3e.mapSize
  const [offsetX = 0, offsetY = 0] = w3e.centerOffset
  const samples = []
  for (let y = 0; y < rows; y += 1)
    for (let x = 0; x < columns; x += 1) {
      const corner = w3e.corners[y]?.[x]
      samples.push(Object.freeze({ x, y, level: corner?.layerHeight ?? 0, authored: true, ...(corner !== undefined && corner.ramp !== 0 ? { ramp: true } : {}) }))
    }
  const models = new Map<string, MapCliffPieceModel>()
  const pieces: MapCliffPiece[] = []
  for (const piece of terrainPieces(w3e).pieces) {
    const dir = cliffTypes.get(cliffTileset(map, piece.cliffTexture) ?? '')?.[piece.kind === 'ramp' ? 'rampModelDir' : 'cliffModelDir']
    if (dir === undefined) continue
    const modelId = `${dir}${piece.name}${String(piece.variation)}`
    // A cliff corner's variation and every lower one: the game has fewer of some pieces than a corner may ask for.
    if (!models.has(modelId))
      models.set(
        modelId,
        Object.freeze({
          id: modelId,
          candidates: Object.freeze(
            Array.from({ length: piece.variation + 1 }, (_, index) => {
              const path = `Doodads\\Terrain\\${dir}\\${dir}${piece.name}${String(piece.variation - index)}.mdx`
              return Object.freeze({
                requirement: Object.freeze({ id: `war3-cliff:${encodeURIComponent(fold(path))}`, logicalId: path, role: 'sidecar' as const, scopes: Object.freeze(['current-mount', 'workspace-dependency-layer'] as const) }),
                yaw: 0,
              })
            }),
          ),
        }),
      )
    // The game bends a piece over the ground heights under it; a placed piece stands at their mean.
    const under = []
    for (let dy = 0; dy <= piece.height; dy += 1)
      for (let dx = 0; dx <= piece.width; dx += 1) under.push(w3e.corners[piece.y + dy]?.[piece.x + dx]?.groundHeight ?? 0)
    const ground = under.reduce((sum, value) => sum + value, 0) / under.length
    pieces.push(Object.freeze({
      id: `${piece.kind}-${String(piece.x)}-${String(piece.y)}`,
      position: Object.freeze({
        x: offsetX + (piece.x + piece.width) * CORNER_UNITS,
        y: offsetY + piece.y * CORNER_UNITS,
        z: (piece.base - 2 + ground) * CORNER_UNITS,
      }),
      modelId,
    }))
  }
  return Object.freeze({
    version: 1,
    width: columns,
    height: rows,
    cellCount: columns * rows,
    samples: Object.freeze(samples),
    exact: true,
    pieceModels: Object.freeze([...models.values()]),
    pieces: Object.freeze(pieces),
  })
}

/** The water of the map: cells with a water corner, in zones of neighbouring cells at one height. */
function waterOf(map: War3Map, water: ReadonlyMap<string, Readonly<Record<string, string>>>): MapWaterSummary | undefined {
  const w3e = map.terrain
  if (w3e === undefined) return undefined
  const [columns = 0, rows = 0] = w3e.mapSize
  const [offsetX = 0, offsetY = 0] = w3e.centerOffset
  const row = water.get(`${w3e.tileset}Sha`)
  const offset = Number(row?.['height'] ?? '0') || 0
  const zones: MapWaterZone[] = []
  // A run of water cells along a row at one height, grown upward while the row above repeats it.
  let open = new Map<string, { index: number; start: number }>()
  for (let y = 0; y < rows - 1; y += 1) {
    const runs: { from: number; to: number; elevation: number }[] = []
    for (let x = 0; x < columns - 1; x += 1) {
      const corners = [w3e.corners[y]?.[x], w3e.corners[y]?.[x + 1], w3e.corners[y + 1]?.[x], w3e.corners[y + 1]?.[x + 1]]
      if (!corners.some(corner => corner !== undefined && corner.water !== 0)) continue
      const elevation = ((corners[0]?.waterHeight ?? 0) + offset) * CORNER_UNITS
      const last = runs.at(-1)
      if (last !== undefined && last.to === x && last.elevation === elevation) last.to = x + 1
      else runs.push({ from: x, to: x + 1, elevation })
    }
    const next = new Map<string, { index: number; start: number }>()
    for (const run of runs) {
      const key = `${String(run.from)}:${String(run.to)}:${String(run.elevation)}`
      const growing = open.get(key) ?? { index: zones.length, start: y }
      zones[growing.index] = Object.freeze({
        zoneId: growing.index,
        templateId: `${w3e.tileset}Sha`,
        minimum: Object.freeze({ x: offsetX + run.from * CORNER_UNITS, y: offsetY + growing.start * CORNER_UNITS }),
        maximum: Object.freeze({ x: offsetX + run.to * CORNER_UNITS, y: offsetY + (y + 1) * CORNER_UNITS }),
        elevation: run.elevation,
        materialId: 'water',
      })
      next.set(key, growing)
    }
    open = next
  }
  if (zones.length === 0) return undefined
  const channel = (name: string) => (Number(row?.[name] ?? '0') || 0) / 255
  const textureStem = row?.['texFile']
  const texture = textureStem === undefined ? undefined : `${textureStem}00.blp`
  return Object.freeze({
    version: 1,
    zones: Object.freeze(zones),
    materials: Object.freeze([
      Object.freeze({
        materialId: 'water',
        label: `${w3e.tileset}Sha`,
        classification: 'water' as const,
        shorelineMode: 'terrain-clipped' as const,
        color: Object.freeze([channel('Smin_R'), channel('Smin_G'), channel('Smin_B'), channel('Smin_A')]) as readonly [number, number, number, number],
        ...(texture === undefined
          ? {}
          : {
              baseColorResourceId: `war3-water-texture:${encodeURIComponent(fold(texture))}`,
              baseColorResource: Object.freeze({ id: `war3-water-texture:${encodeURIComponent(fold(texture))}`, logicalId: texture, role: 'texture' as const, scopes: Object.freeze(['current-mount', 'workspace-dependency-layer'] as const) }),
            }),
      }),
    ]),
    // A zone takes its bottom-left corner's height; the game interpolates the corners.
    exact: false,
  })
}

/** Each corner's ground tileset, over the tile of its texture that is full ground in every atlas. */
/**
 * The blight texture of each main tileset, by its letter (`TerrainArt\Blight\<name>_Blight.blp`);
 * the game names it in code, not data. Table read from mdx-m3-viewer `w3x/map.ts` (MIT).
 */
const BLIGHTS: Readonly<Record<string, string>> = {
  A: 'Ashen', B: 'Barrens', C: 'Felwood', D: 'Cave', F: 'Lordf', G: 'Dungeon', I: 'Ice', J: 'DRuins', K: 'Citadel',
  L: 'Lords', N: 'North', O: 'Outland', Q: 'VillageFall', V: 'Village', W: 'Lordw', X: 'Village', Y: 'Village', Z: 'Ruins',
}

function terrainMaterials(
  map: War3Map,
  terrain: MapTerrainSummary,
  textures: ReadonlyMap<string, string>,
  cliffTypes: ReadonlyMap<string, Readonly<Record<string, string>>>,
): MapTerrainMaterialSummary | undefined {
  const w3e = map.terrain
  if (w3e === undefined || terrain.samples.length !== terrain.cellCount) return undefined
  const blight = w3e.corners.some(row => row.some(corner => corner.blight !== 0)) ? BLIGHTS[w3e.tileset] : undefined
  const blightTexture = blight === undefined ? undefined : `TerrainArt\\Blight\\${blight}_Blight.blp`
  // Blight draws over every ground tileset, so it takes the index after them (mdx-m3-viewer).
  const tilesets = blightTexture === undefined ? w3e.groundTilesets : [...w3e.groundTilesets, BLIGHT_MATERIAL]
  const textureOf = (tileset: string) => (tileset === BLIGHT_MATERIAL ? blightTexture : textures.get(tileset))
  const pieces = terrainPieces(w3e)
  /** A corner of a cliff or ramp piece shows the ground its cliff set names, when the map declares that tileset. */
  const cornerTexture = (x: number, y: number) => {
    const cliff = pieces.groundCliff(x, y)
    const ground = cliff === undefined ? undefined : cliffTypes.get(cliffTileset(map, cliff) ?? '')?.['groundTile']
    const index = ground === undefined ? -1 : tilesets.indexOf(ground)
    if (index >= 0) return index
    const corner = w3e.corners[y]?.[x]
    return blightTexture !== undefined && (corner?.blight ?? 0) !== 0 ? tilesets.length - 1 : (corner?.groundTexture ?? 0)
  }
  const [columns = 0, rows = 0] = w3e.mapSize
  /**
   * A cell's tilesets from the lowest index up (Warsmash `getTextureVariations`): the lowest drawn
   * whole, each other one over it by the atlas tile that covers its corners — bottom right 1, bottom
   * left 2, top right 4, top left 8 — blended by that tile's alpha.
   * ponytail: the lowest draws tile 0 or 15 by its corner's variation, the full-ground tiles of both
   * atlas widths; the variation tiles of an 8 × 4 atlas need the texture's width from blizzard/blp.
   */
  const cellLayers = (x: number, y: number) => {
    if (x >= columns - 1 || y >= rows - 1) return undefined
    const bottomLeft = cornerTexture(x, y)
    const bottomRight = cornerTexture(x + 1, y)
    const topLeft = cornerTexture(x, y + 1)
    const topRight = cornerTexture(x + 1, y + 1)
    const present = [...new Set([bottomLeft, bottomRight, topLeft, topRight])].sort((a, b) => a - b)
    if (present.some(texture => tilesets[texture] === undefined)) return undefined
    return Object.freeze(
      present.map((texture, order) => {
        const tile =
          order === 0
            ? (w3e.corners[y]?.[x]?.groundVariation ?? 0) === 0 ? 0 : 15
            : (bottomRight === texture ? 1 : 0) | (bottomLeft === texture ? 2 : 0) | (topRight === texture ? 4 : 0) | (topLeft === texture ? 8 : 0)
        return Object.freeze({ materialId: `tile-${tilesets[texture]!}`, tile: Object.freeze({ column: tile % 4, row: Math.floor(tile / 4) }) })
      }),
    )
  }
  return Object.freeze({
    version: 1,
    width: terrain.width,
    height: terrain.height,
    weightEncoding: 'dominant-only' as const,
    cellCount: terrain.cellCount,
    textureNames: Object.freeze([...tilesets]),
    materials: Object.freeze(
      tilesets.map((tileset, sourceIndex) => {
        const logicalId = textureOf(tileset)
        const resourceId = logicalId === undefined ? undefined : `war3-terrain-texture:${encodeURIComponent(fold(logicalId))}`
        return Object.freeze({
          materialId: `tile-${tileset}`,
          label: tileset,
          sourceIndex,
          // 64-pixel tiles in four rows: 4 × 4, or 8 × 4 with the variations on the right.
          atlas: Object.freeze({ rows: 4 }),
          ...(logicalId === undefined || resourceId === undefined
            ? {}
            : {
                baseColorResourceId: resourceId,
                baseColorResource: Object.freeze({
                  id: resourceId,
                  logicalId,
                  role: 'texture' as const,
                  scopes: Object.freeze(['current-mount', 'workspace-dependency-layer'] as const),
                }),
              }),
        })
      }),
    ),
    samples: Object.freeze(
      terrain.samples.map(sample => {
        const textureIndex = cornerTexture(sample.x, sample.y)
        const tileset = tilesets[textureIndex]
        // A corner naming a tileset the map does not declare has no material.
        if (tileset === undefined) return Object.freeze({ x: sample.x, y: sample.y, textureIndex })
        const layers = cellLayers(sample.x, sample.y)
        return Object.freeze({
          x: sample.x,
          y: sample.y,
          textureIndex,
          textureName: tileset,
          ...(layers === undefined ? {} : { layers }),
          weights: Object.freeze([Object.freeze({ materialId: `tile-${tileset}`, weight: 1 })]),
          // The cell's own UV, less the cell position the renderer adds: the atlas's first tile.
          uvTransform: Object.freeze({
            offset: Object.freeze([-sample.x, -sample.y]) as readonly [number, number],
            scale: Object.freeze([1 / 8, 1 / 4]) as readonly [number, number],
            rotation: 0,
          }),
        })
      }),
    ),
    exact: false,
  }) as MapTerrainMaterialSummary
}

function nativeTransform(map: War3Map, terrain: MapTerrainSummary, path: string, snapshotId: string): MapTerrainNativeTransform | undefined {
  const w3e = map.terrain
  if (w3e === undefined || terrain.samples.length !== terrain.cellCount) return undefined
  const [x = 0, y = 0] = w3e.centerOffset
  return Object.freeze({
    schemaVersion: 1,
    snapshotId,
    descriptorVersion: 1,
    source: Object.freeze({ terrainDocumentPath: path, format: 'warcraft3-w3e', heightEncoding: 'int16-le-ground-and-cliff-level' }),
    heightMap: Object.freeze({
      dim: Object.freeze([terrain.width, terrain.height]) as readonly [number, number],
      offset: Object.freeze({ x, y, z: 0 }),
      scale: Object.freeze({ x: CORNER_UNITS, y: CORNER_UNITS, z: 1 }),
    }),
    mapping: Object.freeze({ horizontal: 'offset-plus-grid-index-times-scale' as const, vertical: 'direct-base-times-scale-plus-offset' as const }),
    bounds: Object.freeze({
      coordinateSpaceId: 'map-native',
      minimum: Object.freeze({ x, y, z: terrain.minimumHeightBase }),
      maximum: Object.freeze({ x: x + (terrain.width - 1) * CORNER_UNITS, y: y + (terrain.height - 1) * CORNER_UNITS, z: terrain.maximumHeightBase }),
    }),
  }) as MapTerrainNativeTransform
}

/**
 * The qualification of the map-native to UVW transform (ADR-WORLD-003): the corner positions of the
 * corpus map, read through this provider, equal the accepted MIT oracle's to the bit — mdx-m3-viewer
 * `w3x/map.ts`, height `groundHeight + layerHeight - 2` times 128, position centre offset plus index
 * times 128, without Warsmash's ramp lift. `test/war3-installed-corpus.test.ts` recomputes every
 * digest from the installation.
 */
export const WAR3_WORLD_ORACLE = Object.freeze({
  kind: 'adapter-qualification' as const,
  method: 'third-party-reference-differential' as const,
  oracle: 'references/mdx-m3-viewer src/viewer/handlers/w3x/map.ts (MIT)',
  corpus: 'Warcraft III 1.24e local:warcraft3 (2)BootyBay.w3m',
  sourceDigests: Object.freeze({
    'war3map.w3e': 'sha256:3e7529c3d633ff6f55fb50c9dd0b8583e5ac89945c32d56882f74f695e62900d' as `sha256:${string}`,
  }),
  tupleCount: 18_721,
  comparison: 'ieee-754-binary64-exact' as const,
  nativeTupleDigest: 'sha256:142bf883254904431f58a302f7977c2342f29eabe6315403100d1f5398b4d913' as `sha256:${string}`,
  canonicalTupleDigest: 'sha256:b67b53e9df5f1d3a09cbe5e933e3ea51884e7818237e8d2ebbc2da201f37dfd0' as `sha256:${string}`,
})

/**
 * The game's camera (`Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_*`, checked by the real tier): a
 * perspective lens of field of view 70 looking north (rotation 90) down 56 degrees (angle of attack
 * 304), drawing to 5000 world units. Looking north, the eye stands south of the target: +z canonical.
 */
export const WAR3_WORLD_CAMERA = Object.freeze({
  projection: 'perspective' as const,
  azimuthDegrees: 90,
  elevationDegrees: 360 - 304,
  fieldOfViewDegrees: 70,
  drawDistance: 5000,
})

/** Map-native to UVW canonical (ADR-WORLD-003): `(x, y, z) -> (x, z, -y)`, rows from the north. */
export function war3WorldCanonicalTransform(transform: MapTerrainNativeTransform): MapWorldCanonicalTransform {
  const { dim, offset } = transform.heightMap
  const canonical = (value: number) => (value === 0 ? 0 : value)
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: transform.snapshotId,
    sourceCoordinateSpaceId: 'map-native',
    targetCoordinateSpaceId: 'uvw-canonical',
    basis: Object.freeze({
      handedness: 'right',
      upAxis: 'y',
      forwardAxis: '+z',
      unit: 'source-unit',
      sourceUnit: 'warcraft3-world-unit',
      unitsPerCell: CORNER_UNITS,
    }),
    axes: Object.freeze({
      x: Object.freeze({ sourceAxis: 'x', scale: 1, offset: 0 }),
      y: Object.freeze({ sourceAxis: 'z', scale: 1, offset: 0 }),
      z: Object.freeze({ sourceAxis: 'y', scale: -1, offset: 0 }),
    }),
    heightfield: Object.freeze({
      columns: dim[0],
      rows: dim[1],
      cellSize: CORNER_UNITS,
      origin: Object.freeze([canonical(offset.x), 0, canonical(-(offset.y + (dim[1] - 1) * CORNER_UNITS))]) as readonly [number, number, number],
      sourceRowOrder: 'reverse',
    }),
    bounds: Object.freeze({
      coordinateSpaceId: 'uvw-canonical',
      minimum: Object.freeze({ x: canonical(transform.bounds.minimum.x), y: canonical(transform.bounds.minimum.z), z: canonical(-transform.bounds.maximum.y) }),
      maximum: Object.freeze({ x: canonical(transform.bounds.maximum.x), y: canonical(transform.bounds.maximum.z), z: canonical(-transform.bounds.minimum.y) }),
    }),
    proof: WAR3_WORLD_ORACLE,
  }) as MapWorldCanonicalTransform
}

/**
 * The map's pathing cells (`war3map.wpm`, four to a corner cell, south row first) as a bounded
 * navigation summary: one flags byte a cell, evenly spaced samples up to `maxSamples`.
 */
function navigationOf(map: War3Map, maxSamples: number): MapNavigationSummary | undefined {
  const wpm = map.pathing
  if (wpm === undefined) return undefined
  const [width = 0, height = 0] = wpm.size
  const cellCount = width * height
  const sampleCount = Math.min(cellCount, maxSamples)
  const samples: MapNavigationSample[] = []
  let minimumFlags = 0xff
  let maximumFlags = 0
  for (const flags of wpm.pathing) {
    minimumFlags = Math.min(minimumFlags, flags)
    maximumFlags = Math.max(maximumFlags, flags)
  }
  for (let index = 0; index < sampleCount; index += 1) {
    const cell = sampleCount === 1 ? 0 : Math.floor((index * (cellCount - 1)) / (sampleCount - 1))
    samples.push(Object.freeze({ x: cell % width, y: Math.floor(cell / width), flags: wpm.pathing[cell] ?? 0 }))
  }
  return Object.freeze({ version: wpm.version, width, height, cellCount, minimumFlags, maximumFlags, trailingBytes: 0, samples: Object.freeze(samples) })
}

/** The resolved snapshot the host turns into the map's world scene. */
export async function analyzeWar3MapWorkspace(request: ResolvedMapWorkspaceAnalysisRequest): Promise<ResolvedMapWorkspaceSnapshot> {
  const { map, semantic } = await readSemantic(request)
  const byTail = new Map(request.documents.map(document => [tail(document.path), document] as const))
  const terrainDocument = request.documents.find(document => fold(document.path).endsWith('war3map.w3e'))
  const terrainTransform =
    semantic.terrain === undefined || terrainDocument === undefined ? undefined : nativeTransform(map, semantic.terrain, terrainDocument.path, request.snapshotId)
  const uvwTransform = terrainTransform === undefined ? undefined : war3WorldCanonicalTransform(terrainTransform)
  const textures = new Map(
    [...table(byTail.get('terrainart/terrain.slk')?.bytes)].flatMap(([id, row]) =>
      row['dir'] === undefined || row['file'] === undefined ? [] : [[id, `${row['dir']}\\${row['file']}.blp`] as const],
    ),
  )
  const cliffTypes = table(byTail.get('terrainart/clifftypes.slk')?.bytes)
  const materials =
    semantic.terrain === undefined || terrainTransform === undefined ? undefined : terrainMaterials(map, semantic.terrain, textures, cliffTypes)
  const cliffs = terrainTransform === undefined ? undefined : cliffsOf(map, cliffTypes)
  const water = terrainTransform === undefined ? undefined : waterOf(map, table(byTail.get('terrainart/water.slk')?.bytes))
  const navigation = navigationOf(map, request.maxTerrainSamples)
  const required = new Set(request.requiredRequirementIds)
  const diagnostics = request.unresolvedRequirementIds.map(requirementId =>
    diagnostic(
      required.has(requirementId) ? 'error' : 'information',
      'map-planned-resource-unresolved',
      `planned map resource ${requirementId} did not resolve through the resource session`,
    ),
  )
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: semantic.workspaceId,
    gameId: semantic.gameId,
    mapId: semantic.mapId,
    analyzerId: WAR3_MAP_ANALYZER_ID,
    snapshotId: request.snapshotId,
    semantic,
    ...(terrainTransform === undefined ? {} : { terrainTransform }),
    ...(uvwTransform === undefined ? {} : { uvwTransform }),
    camera: WAR3_WORLD_CAMERA,
    ...(materials === undefined ? {} : { terrainMaterials: materials }),
    ...(cliffs === undefined ? {} : { cliffs }),
    ...(water === undefined ? {} : { water }),
    ...(navigation === undefined ? {} : { navigation }),
    worldCandidate: Object.freeze({
      contract: WAR3_WORLD_SCENE_SOURCE_CONTRACT,
      major: 1 as const,
      maturity: 'publisher-candidate' as const,
      coordinateSpaces: Object.freeze([
        Object.freeze({
          id: 'height-grid',
          horizontalAxes: Object.freeze(['column', 'row']) as readonly [string, string],
          verticalAxis: 'direct-height',
          handedness: 'array-row-major',
          linearUnit: 'grid-index',
          rotationUnit: 'not-applicable',
          origin: 'grid-zero',
        }),
        Object.freeze({
          id: 'navigation-grid',
          horizontalAxes: Object.freeze(['column', 'row']) as readonly [string, string],
          verticalAxis: 'not-applicable',
          handedness: 'array-row-major',
          linearUnit: 'grid-index',
          rotationUnit: 'not-applicable',
          origin: 'grid-zero',
        }),
        Object.freeze({
          id: 'map-native',
          horizontalAxes: Object.freeze(['x', 'y']) as readonly [string, string],
          verticalAxis: 'z',
          handedness: 'right',
          linearUnit: 'warcraft3-world-unit',
          rotationUnit: 'radian',
          origin: 'w3e-center-offset',
        }),
        Object.freeze({
          id: 'uvw-canonical',
          horizontalAxes: Object.freeze(['x', 'z']) as readonly [string, string],
          verticalAxis: 'y',
          handedness: 'right',
          linearUnit: 'warcraft3-world-unit',
          rotationUnit: 'radian',
          origin: 'adr-world-003-heightfield-origin',
        }),
      ]),
      crossSpaceTransforms: Object.freeze([
        Object.freeze({
          from: 'height-grid',
          to: 'map-native',
          state: terrainTransform === undefined ? ('unknown' as const) : ('known' as const),
          ...(terrainTransform === undefined ? { reason: 'the complete corner grid is unavailable' } : {}),
        }),
        Object.freeze({
          from: 'navigation-grid',
          to: 'map-native',
          state: 'unknown' as const,
          reason: 'a pathing cell is a quarter corner cell from the corner origin, but the sdk carries no navigation transform',
        }),
        Object.freeze({
          from: 'map-native',
          to: 'uvw-canonical',
          state: uvwTransform === undefined ? ('unknown' as const) : ('known' as const),
          ...(uvwTransform === undefined ? { reason: 'the complete corner grid is unavailable' } : {}),
        }),
      ]),
      unknownFacets: Object.freeze([
        'terrain-variations',
        'cameras',
        'lighting',
      ]),
    }),
    unresolvedRequirementIds: Object.freeze([...request.unresolvedRequirementIds]),
    diagnostics: Object.freeze(diagnostics),
    diagnosticsTruncated: false,
    complete: semantic.complete && diagnostics.every(item => item.severity !== 'error'),
  })
}

export const abiVersion = 1
export const provides = Object.freeze(['common.map/semantic-analysis', 'common.map/resolved-workspace'])

export function createProvider(selection: { readonly contract: string; readonly major: number }) {
  if (selection.major !== 1) throw new TypeError(`unsupported Warcraft III map selection ${selection.contract}@${String(selection.major)}`)
  const lease = <T>(value: T) => Object.freeze({ value, release: async () => undefined })
  if (selection.contract === 'common.map/semantic-analysis')
    return lease(
      Object.freeze({
        contract: 'common.map/semantic-analysis' as const,
        analyzerId: WAR3_MAP_ANALYZER_ID,
        gameIds: Object.freeze([WAR3_GAME_ID]),
        open: openWar3Map,
      }),
    )
  if (selection.contract === 'common.map/resolved-workspace')
    return lease(
      Object.freeze({
        contract: 'common.map/resolved-workspace' as const,
        analyzerId: WAR3_MAP_ANALYZER_ID,
        gameIds: Object.freeze([WAR3_GAME_ID]),
        plan: planWar3Map,
        analyze: analyzeWar3MapWorkspace,
      }),
    )
  throw new TypeError(`unsupported Warcraft III map selection ${selection.contract}@${String(selection.major)}`)
}
