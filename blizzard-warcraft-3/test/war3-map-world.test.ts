import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import War3MapDoo from '../src/lib/mdx-m3-viewer/parsers/w3x/doo/file.js'
import Doodad from '../src/lib/mdx-m3-viewer/parsers/w3x/doo/doodad.js'
import War3MapUnitsDoo from '../src/lib/mdx-m3-viewer/parsers/w3x/unitsdoo/file.js'
import Unit from '../src/lib/mdx-m3-viewer/parsers/w3x/unitsdoo/unit.js'
import War3MapW3i from '../src/lib/mdx-m3-viewer/parsers/w3x/w3i/file.js'
import War3MapW3c from '../src/lib/mdx-m3-viewer/parsers/w3x/w3c/file.js'
import Camera from '../src/lib/mdx-m3-viewer/parsers/w3x/w3c/camera.js'
import War3MapW3r from '../src/lib/mdx-m3-viewer/parsers/w3x/w3r/file.js'
import Region from '../src/lib/mdx-m3-viewer/parsers/w3x/w3r/region.js'
import War3MapW3u from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/file.js'
import { authoredMapDocuments, changedObject, objectChange } from './war3-fixtures.js'
import { extension } from './war3-harness.js'

/**
 * The world of the authored map (`war3-fixtures.ts`: 3 × 2 corners, heights `256·row + column`
 * once the cliff level is added) with a tree, a doodad, a footman, a custom unit made from it and a
 * start location, over game tables written for the test.
 */
const { planWar3Map, analyzeWar3MapWorkspace, CORNER_UNITS } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-map-world', 'world.js')).href
)) as typeof import('../dist/war3-map-world/world.js')
const { prepareWar3MapPreview } = (await import(pathToFileURL(join(extension, 'dist', 'war3-map-world', 'preview.js')).href)) as typeof import(
  '../dist/war3-map-world/preview.js'
)

const sheet = (rows: string[][]) =>
  new TextEncoder().encode(
    [
      'ID;PWXL;N;E',
      ...rows.flatMap((row, y) => row.map((value, x) => `C;X${String(x + 1)}${x === 0 ? `;Y${String(y + 1)}` : ''};K${/^-?\d+(\.\d+)?$/u.test(value) ? value : `"${value}"`}`)),
      'E',
      '',
    ].join('\r\n'),
  )

function mapDocuments() {
  const documents = authoredMapDocuments()
  const info = new War3MapW3i()
  info.load(documents.find(item => item.path === 'war3map.w3i')!.bytes)
  const build = info.getBuildVersion()
  const doo = new War3MapDoo()
  doo.version = 8
  const doodad = (id: string, variation: number, x: number, y: number) =>
    Object.assign(new Doodad(), { id, variation, location: new Float32Array([x, y, 5]), angle: 1.5, scale: new Float32Array([1, 1, 2]), life: 100 })
  doo.doodads.push(doodad('LTlt', 3, -128, -64), doodad('LOrb', 0, 0, 0))
  const units = new War3MapUnitsDoo()
  const unit = (id: string, player: number) => Object.assign(new Unit(), { id, player, location: new Float32Array([64, 32, 0]), angle: 0.5 })
  units.units.push(unit('hfoo', 0), unit('h000', 1), unit('sloc', 0))
  // A custom footman with its own model, made in the object editor.
  const mods = new War3MapW3u()
  mods.version = 2
  mods.customTable.objects.push(changedObject('hfoo', 'h000', [objectChange('umdl', 3, 'units\\human\\Knight\\Knight')]))
  // A region as the editor stores it: blue, green, red, then 0xFF.
  const regions = new War3MapW3r()
  regions.version = 5
  regions.regions.push(Object.assign(new Region(), { left: -192, right: 64, bottom: -128, top: 96, name: 'Spawn', creationNumber: 7, color: new Uint8Array([10, 20, 30, 255]) }))
  const cameras = new War3MapW3c()
  cameras.cameras.push(Object.assign(new Camera(), { targetLocation: new Float32Array([0, 0, 50]), rotation: 90, cinematicName: 'Intro' }))
  return [
    ...documents,
    { path: 'war3map.w3c', bytes: cameras.save(build) },
    { path: 'war3map.doo', bytes: doo.save(build) },
    { path: 'war3mapUnits.doo', bytes: units.save(build) },
    { path: 'war3map.w3u', bytes: mods.save() },
    { path: 'war3map.w3r', bytes: regions.save() },
  ]
}

const TABLES = [
  { path: 'TerrainArt/Terrain.slk', bytes: sheet([['tileID', 'dir', 'file'], ['Ldrt', 'TerrainArt\\LordaeronSummer', 'Lords_Dirt']]) },
  { path: 'Units/DestructableData.slk', bytes: sheet([['DestructableID', 'file', 'numVar'], ['LTlt', 'Doodads\\Terrain\\LordaeronTree\\LordaeronTree', '10']]) },
  { path: 'Doodads/Doodads.slk', bytes: sheet([['doodID', 'file', 'numVar'], ['LOrb', 'Doodads\\LordaeronSummer\\Props\\Orb\\Orb.mdl', '1']]) },
  { path: 'Units/UnitMetaData.slk', bytes: sheet([['ID', 'field', 'slk', 'index'], ['umdl', 'file', 'UnitUI', '-1']]) },
  { path: 'Units/unitUI.slk', bytes: sheet([['unitUIID', 'file', 'modelScale'], ['hfoo', 'units\\human\\Footman\\Footman', '1.5']]) },
]

async function analyzed(extra: { path: string; bytes: Uint8Array }[] = []) {
  const documents = [...mapDocuments(), ...TABLES, ...extra]
  return analyzeWar3MapWorkspace({
    workspaceId: 'war3-world-test',
    gameId: 'blizzard/warcraft-3',
    mapId: 'map',
    documents,
    maxDocuments: 32,
    maxDocumentBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    maxObjects: 100,
    maxRegions: 10,
    maxTerrainCells: 1000,
    maxTerrainSamples: 1000,
    maxDepth: 16,
    snapshotId: 'snapshot-1',
    unresolvedRequirementIds: [],
    requiredRequirementIds: ['war3-map:war3map.w3e'],
    maxDiagnostics: 100,
  })
}

/**
 * A `war3map.w3e` of `columns × rows` corners on ground height 0 and water half a level below it,
 * written byte by byte: the vendored writer mis-packs water heights and flags.
 */
function terrainBytes(
  columns: number,
  rows: number,
  corner: (x: number, y: number) => { level: number; ramp?: boolean; water?: boolean; blight?: boolean; variation?: number; groundVariation?: number; ground?: number },
  grounds = ['Ldrt'],
): Uint8Array {
  const header = 41 + grounds.length * 4
  const bytes = new Uint8Array(header + columns * rows * 7)
  const view = new DataView(bytes.buffer)
  const text = (value: string, at: number) => bytes.set(new TextEncoder().encode(value), at)
  text('W3E!', 0)
  view.setInt32(4, 11, true)
  text('L', 8)
  view.setInt32(9, 0, true)
  view.setInt32(13, grounds.length, true)
  grounds.forEach((ground, index) => text(ground, 17 + index * 4))
  const cliffs = 17 + grounds.length * 4
  view.setInt32(cliffs, 1, true)
  text('CLdi', cliffs + 4)
  view.setInt32(cliffs + 8, columns, true)
  view.setInt32(cliffs + 12, rows, true)
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const at = header + (row * columns + column) * 7
      const { level, ramp = false, water = false, blight = false, variation = 0, groundVariation = 0, ground = 0 } = corner(column, row)
      view.setInt16(at, 8192, true)
      view.setInt16(at + 2, 8192 - 256, true)
      bytes[at + 4] = (water ? 0x40 : 0) | (blight ? 0x20 : 0) | (ramp ? 0x10 : 0) | ground
      bytes[at + 5] = (variation << 5) | groundVariation
      bytes[at + 6] = level
    }
  return bytes
}

/**
 * 5 × 5 corners on cliff level 2 with the centre corner raised to 3 (so the four cells around it are
 * cliffs). The corner north-east of the centre is water; the bottom-left corner of the first cliff
 * cell asks for variation 1.
 */
const cliffTerrain = () =>
  terrainBytes(5, 5, (x, y) => ({ level: x === 2 && y === 2 ? 3 : 2, water: x === 3 && y === 3, variation: x === 1 && y === 1 ? 1 : 0 }))

/**
 * 7 × 7 corners: level 2 west of column 4, level 3 from it, and a ramp over corners 2–4 each way —
 * the slope rises east across cells 2 and 3, rows 2 and 3.
 */
const rampTerrain = () =>
  terrainBytes(7, 7, (x, y) => ({ level: x >= 4 ? 3 : 2, ramp: x >= 2 && x <= 4 && y >= 2 && y <= 4 }))

const CLIFF_TYPES = { path: 'TerrainArt/CliffTypes.slk', bytes: sheet([['cliffID', 'cliffModelDir', 'rampModelDir', 'groundTile'], ['CLdi', 'Cliffs', 'CliffTrans', 'Ldrt']]) }

async function terrainWorld(w3e: Uint8Array, snapshotId: string, terrainTable = TABLES[0]!.bytes) {
  const documents = [
    authoredMapDocuments().find(item => item.path === 'war3map.w3i')!,
    { path: 'war3map.w3e', bytes: w3e },
    { path: 'TerrainArt/Terrain.slk', bytes: terrainTable },
    CLIFF_TYPES,
    { path: 'TerrainArt/Water.slk', bytes: sheet([['waterID', 'height', 'texFile', 'Smin_R', 'Smin_G', 'Smin_B', 'Smin_A'], ['LSha', '-0.7', 'ReplaceableTextures\\Water\\Water', '51', '102', '153', '255']]) },
  ]
  return analyzeWar3MapWorkspace({
    workspaceId: 'war3-world-test', gameId: 'blizzard/warcraft-3', mapId: 'map', documents,
    maxDocuments: 32, maxDocumentBytes: 1 << 20, maxTotalBytes: 1 << 22, maxObjects: 100, maxRegions: 10,
    maxTerrainCells: 1000, maxTerrainSamples: 1000, maxDepth: 16, snapshotId,
    unresolvedRequirementIds: [], requiredRequirementIds: [], maxDiagnostics: 100,
  })
}

describe('Warcraft III map world', () => {
  it('uses map-skin object changes for placed models through the same resolved-data owner', async () => {
    const skin = new War3MapW3u()
    skin.version = 2
    skin.originalTable.objects.push(changedObject('hfoo', '\0\0\0\0', [objectChange('umdl', 3, 'units\\human\\SkinFootman\\SkinFootman')]))
    const snapshot = await analyzed([{ path: 'war3mapSkin.w3u', bytes: skin.save() }])
    expect(snapshot.semantic.objects.find(object => object.typeId === 'hfoo')?.modelResource?.logicalId)
      .toBe('units\\human\\SkinFootman\\SkinFootman.mdx')
  })
  it('places cliff pieces by their corner levels and water in zones at its level', async () => {
    const snapshot = await terrainWorld(cliffTerrain(), 'snapshot-2')
    // The four cells around the raised corner, each named by its corners from the lowest level.
    expect(snapshot.cliffs?.pieces?.map(piece => [piece.modelId, piece.position.x, piece.position.y, piece.position.z])).toEqual([
      ['CliffsAABA1', 256, 128, 0],
      ['CliffsAAAB0', 256, 256, 0],
      ['CliffsABAA0', 384, 128, 0],
      ['CliffsBAAA0', 384, 256, 0],
    ])
    // A corner's variation and every lower one: the installation has what it has.
    expect(snapshot.cliffs?.pieceModels?.find(model => model.id === 'CliffsAABA1')?.candidates.map(candidate => candidate.requirement.logicalId)).toEqual([
      'Doodads\\Terrain\\Cliffs\\CliffsAABA1.mdx',
      'Doodads\\Terrain\\Cliffs\\CliffsAABA0.mdx',
    ])
    // The four cells that touch the water corner, one zone at half a level below ground plus the tileset's offset.
    expect(snapshot.water?.zones.map(zone => [zone.minimum, zone.maximum])).toEqual([[{ x: 256, y: 256 }, { x: 512, y: 512 }]])
    expect(snapshot.water?.zones[0]?.elevation).toBeCloseTo((-0.5 - 0.7) * 128)
    expect(snapshot.water?.materials?.[0]).toMatchObject({ color: [0.2, 0.4, 0.6, 1], baseColorResource: { logicalId: 'ReplaceableTextures\\Water\\Water00.blp' } })
  })

  it("layers a cell's tilesets from the lowest, each over it by the atlas tile of its corners", async () => {
    // Dirt west of column 2, grass from it; the south-west corner asks for a ground variation.
    const w3e = terrainBytes(4, 4, (x, y) => ({ level: 2, ground: x >= 2 ? 1 : 0, groundVariation: x === 0 && y === 0 ? 1 : 0 }), ['Ldrt', 'Lgrs'])
    const snapshot = await terrainWorld(w3e, 'snapshot-4', sheet([['tileID', 'dir', 'file'], ['Ldrt', 'TerrainArt\\LordaeronSummer', 'Lords_Dirt'], ['Lgrs', 'TerrainArt\\LordaeronSummer', 'Lords_Grass']]))
    const layers = (x: number, y: number) =>
      (snapshot.terrainMaterials?.samples.find(sample => sample.x === x && sample.y === y) as { layers?: unknown } | undefined)?.layers
    // A varied corner shows the other full-ground tile; the grass covers the cell's east corners (1 + 4).
    expect(layers(0, 0)).toEqual([{ materialId: 'tile-Ldrt', tile: { column: 3, row: 3 } }])
    expect(layers(1, 1)).toEqual([
      { materialId: 'tile-Ldrt', tile: { column: 0, row: 0 } },
      { materialId: 'tile-Lgrs', tile: { column: 1, row: 1 } },
    ])
    expect(layers(3, 1)).toBeUndefined()
    expect(snapshot.terrainMaterials?.materials?.[1]).toMatchObject({ materialId: 'tile-Lgrs', atlas: { rows: 4 } })
  })

  it("draws a blighted corner's tileset blight over its ground, after the map's tilesets", async () => {
    const w3e = terrainBytes(4, 4, x => ({ level: 2, blight: x >= 2 }))
    const snapshot = await terrainWorld(w3e, 'snapshot-5')
    expect(snapshot.terrainMaterials?.materials?.[1]).toMatchObject({
      materialId: 'tile-blight',
      baseColorResource: { logicalId: 'TerrainArt\\Blight\\Lords_Blight.blp', role: 'texture' },
    })
    const layers = (x: number, y: number) =>
      (snapshot.terrainMaterials?.samples.find(sample => sample.x === x && sample.y === y) as { layers?: unknown } | undefined)?.layers
    expect(layers(1, 1)).toEqual([
      { materialId: 'tile-Ldrt', tile: { column: 0, row: 0 } },
      { materialId: 'tile-blight', tile: { column: 1, row: 1 } },
    ])
  })

  it('walls a ramp with its two-cell ramp pieces and lifts the middle of the slope half a level', async () => {
    const snapshot = await terrainWorld(rampTerrain(), 'snapshot-3')
    // Cliffs south and north of the ramp; the ramp's side walls run down the slope from its high cells.
    expect(snapshot.cliffs?.pieces?.map(piece => [piece.modelId, piece.position.x, piece.position.y, piece.position.z])).toEqual([
      ['CliffsAABB0', 512, 0, 0],
      ['CliffTransALHB0', 512, 128, 0],
      ['CliffTransLABH0', 512, 512, 0],
      ['CliffsAABB0', 512, 640, 0],
    ])
    expect(snapshot.cliffs?.pieceModels?.find(model => model.id === 'CliffTransALHB0')?.candidates.map(candidate => candidate.requirement.logicalId)).toEqual([
      'Doodads\\Terrain\\CliffTrans\\CliffTransALHB0.mdx',
    ])
    // Low end, middle and high end of the slope along row 3: the authored heights are the oracle's
    // (ADR-WORLD-003), the half level Warsmash lifts the middle by is drawn only.
    const sample = (x: number) => snapshot.semantic.terrain?.samples.find(item => item.x === x && item.y === 3)
    expect([2, 3, 4].map(x => sample(x)?.heightBase)).toEqual([0, 0, 128])
    expect([2, 3, 4].map(x => (sample(x)?.heightBase ?? 0) + (sample(x)?.presentationHeightAdjustment ?? 0))).toEqual([0, 64, 128])
  })

  it("prepares a map over the game's installation and plans its documents and the game's tables", async () => {
    const prepared = await prepareWar3MapPreview({
      subject: {
        schemaVersion: 1,
        subjectUri: 'file:///maps/Test.w3x',
        revision: 'content-hash.sha256:test',
        formatId: 'war3-map',
        traits: [],
        dataSources: [],
        operations: [],
        namespace: { state: 'complete', entries: [] },
      },
      maxCandidates: 4,
      maxRoots: 4,
      maxDepth: 4,
    })
    expect(prepared).toMatchObject({
      state: 'prepared',
      plan: {
        workspace: { activeRootId: 'map', roots: [{ rootId: 'map', sourcePath: 'map' }, { rootId: 'game', sourceId: 'local:warcraft3' }] },
        resources: { strategy: 'host-resolved', subjectNamespaceRoots: [{ rootId: 'map', namespacePrefix: '' }], roots: [{ rootId: 'game' }] },
      },
    })
    const plan = await planWar3Map({
      workspace: { workspaceId: 'w', gameId: 'blizzard/warcraft-3', activeRootId: 'map', loadOrder: [{ rootId: 'game', sourcePath: '' }, { rootId: 'map', sourcePath: 'map' }] } as never,
      maxRequirements: 64,
    })
    expect(plan.complete).toBe(true)
    expect(plan.requirements.filter(item => item.required).map(item => item.path)).toEqual(['map/war3map.w3e'])
    expect(plan.requirements.filter(item => item.scope === 'workspace').map(item => item.path)).toContain('Units/unitUI.slk')
  })

  it('turns the corners into terrain at ground height plus cliff level, in the game world frame', async () => {
    const snapshot = await analyzed()
    expect(snapshot.semantic.terrain?.samples.map(sample => sample.heightBase)).toEqual([0, 1, 2, 256, 257, 258])
    expect(snapshot.terrainTransform).toMatchObject({
      heightMap: { dim: [3, 2], offset: { x: -128, y: -64 }, scale: { x: CORNER_UNITS, y: CORNER_UNITS, z: 1 } },
      bounds: { minimum: { x: -128, y: -64, z: 0 }, maximum: { x: 128, y: 64, z: 258 } },
    })
    // The one declared tileset, its texture from Terrain.slk; corners naming undeclared ones have none.
    expect(snapshot.terrainMaterials?.materials).toMatchObject([
      { materialId: 'tile-Ldrt', baseColorResource: { logicalId: 'TerrainArt\\LordaeronSummer\\Lords_Dirt.blp', role: 'texture' } },
    ])
    expect(snapshot.terrainMaterials?.samples[0]).toMatchObject({ textureIndex: 0, weights: [{ materialId: 'tile-Ldrt', weight: 1 }], uvTransform: { offset: [-0, -0], scale: [1 / 8, 1 / 4] } })
    expect(snapshot.terrainMaterials?.samples[1]).toEqual({ x: 1, y: 0, textureIndex: 1 })
  })

  it('colours each player slot as its TeamColor texture, in linear RGB', async () => {
    const { semantic } = await analyzed()
    const red = semantic.players?.find(player => player.id === 0)?.color
    expect(red?.[0]).toBeCloseTo(1, 6)
    expect(red?.[1]).toBeCloseTo(0.000911, 5)
  })

  it("publishes the map's regions as world-unit rectangles with the editor's colour", async () => {
    const { semantic } = await analyzed()
    expect(semantic.regions).toEqual([
      { regionId: 7, name: 'Spawn', color: '255,30,20,10', shapes: [{ type: 'rect', parameters: { min: '-192,-128', max: '64,96' } }] },
    ])
  })

  it("places the map's cameras at their target above the ground, turned by their rotation in degrees", async () => {
    const { semantic } = await analyzed()
    expect(semantic.objects.find(object => object.kind === 'camera')).toMatchObject({
      sourceKey: 'camera-0',
      position: { x: 0, y: 0 },
      heightReference: 'absolute',
      rotation: 90,
      nativeRotationUnit: 'degrees',
      name: 'Intro',
    })
  })

  it("summarizes the map's pathing cells as its navigation, south row first", async () => {
    const snapshot = await analyzed()
    expect(snapshot.navigation).toMatchObject({ width: 8, height: 4, cellCount: 32, minimumFlags: 0, maximumFlags: 3 })
    expect(snapshot.navigation?.samples).toHaveLength(32)
    expect(snapshot.navigation?.samples[9]).toEqual({ x: 1, y: 1, flags: 1 })
  })

  it('places the doodads and units with the models their tables name, the custom unit with its own', async () => {
    const snapshot = await analyzed()
    expect(snapshot.semantic.objects.map(object => [object.kind, object.typeId, object.modelResource?.logicalId, object.player])).toEqual([
      // A tree with ten variations loads the model of its own; a doodad's .mdl is loaded as .mdx.
      ['feature', 'LTlt', 'Doodads\\Terrain\\LordaeronTree\\LordaeronTree3.mdx', undefined],
      ['doodad', 'LOrb', 'Doodads\\LordaeronSummer\\Props\\Orb\\Orb.mdx', undefined],
      ['unit', 'hfoo', 'units\\human\\Footman\\Footman.mdx', 0],
      ['unit', 'h000', 'units\\human\\Knight\\Knight.mdx', 1],
      ['point', 'sloc', undefined, 0],
      ['camera', undefined, undefined, undefined],
    ])
    const [tree, , footman] = snapshot.semantic.objects
    expect(tree).toMatchObject({ position: { x: -128, y: -64, z: 5 }, heightReference: 'absolute', rotation: 1.5, nativeRotationUnit: 'radians', scale: { x: 1, y: 1, z: 2 } })
    // The unit's table scale multiplies its placed scale; units stand on the ground.
    // A unit stands on the ground: its height is the terrain's at its place, not the file's.
    expect(footman).toMatchObject({ heightReference: 'absolute', sourcePositionDimensions: 3, scale: { x: 1.5, y: 1.5, z: 1.5 }, modelResource: { role: 'sidecar', scopes: ['current-mount', 'workspace-dependency-layer'] } })
    expect(snapshot.complete).toBe(true)
  })
})
