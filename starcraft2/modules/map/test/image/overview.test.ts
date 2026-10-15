import { describe, expect, it } from 'vitest'
import type {
  CliffLevelResult,
  HeightMapResult,
  PlacedObjectsResult,
  SC2MapData,
  TerrainInfo,
} from '../../shared/format/index.js'
import {
  TILE_FLAT,
  TILE_RAMP,
  TILE_WALL,
  analyzeCellCliffLevels,
  analyzeCliffFaces,
  analyzeCliffLattice,
  analyzeCliffLines,
  analyzeMapCatalog,
  analyzeMapMarkers,
  analyzeVertexCliffLevels,
  cellCliffLevelsToPng,
  cliffLevelColor,
  offsetStrands,
  overviewCatalogQueries,
  paintedSubCell,
  placeFootprint,
  renderMapOverview,
  smoothCliffLine,
  tileLevelField,
  vertexCliffLevelsToPng,
} from '../../shared/image/overview.js'
import { decodePng } from '../../shared/image/png.js'

const PARAMS = { quantizeScale: 0.5, quantizeBias: 8 }
const raw = { padding: new Uint8Array(16), trailing: new Uint8Array() }

it('asks the existing catalog resolver for shared footprint and resource-behavior dependencies', () => {
  const entities = [
    { namespace: 'Unit', entityId: 'Mineral', fields: {
      Footprint: { value: 'MineralFootprint' },
      BehaviorArray: [{ index: '0', value: { Link: 'MineralSupply' } }],
    } },
    { namespace: 'Actor', entityId: 'MineralActor', fields: { Footprint: 'MineralFootprint' } },
  ]
  expect(overviewCatalogQueries({ entities })).toEqual([
    { namespace: 'Footprint', entityId: 'MineralFootprint' },
    { namespace: 'Behavior', entityId: 'MineralSupply' },
  ])
  expect(overviewCatalogQueries(undefined)).toEqual([])
})

it('refuses an oversized semantic overview before allocating or reading the native grid', () => {
  const oversized = { height: { sizeX: 4097, sizeY: 4097, cells: [] }, terrain: {} } as unknown as SC2MapData
  expect(() => renderMapOverview(oversized, { publishLattice: true })).toThrow('sample budget')
})

/** A height map whose vertex cliff levels (A=0, B=4, C=8, D=12) are `levels`. */
function heightMap(levels: number[][]): HeightMapResult {
  const sizeY = levels.length
  const sizeX = levels[0]!.length
  const cells = []
  for (let y = 0; y < sizeY; y += 1)
    for (let x = 0; x < sizeX; x += 1) {
      const level = levels[sizeY - 1 - y]![x]!
      const adjustment = level === 0 ? -8 : (level - 4) / 2
      cells.push({
        heightBase: 0,
        heightAdjustments: (adjustment + PARAMS.quantizeBias) / PARAMS.quantizeScale,
        mask: 0,
      })
    }
  return { version: 0, sizeX, sizeY, cells, _raw: raw } as HeightMapResult
}

function terrain(cells: TerrainInfo['cliffCells']): TerrainInfo {
  return { ...PARAMS, standardHeight: 6, textures: [], cliffCells: cells ?? [], ramps: [] }
}

const pixel = (png: Uint8Array, x: number, y: number) => {
  const decoded = decodePng(png)
  const o = (y * decoded.width + x) * decoded.channels
  return [decoded.pixels[o], decoded.pixels[o + 1], decoded.pixels[o + 2]]
}

describe('SC2 map overview', () => {
  // Rows are listed north first. A 5x5 vertex grid holds a 2x2 tile lattice.
  const plateau = heightMap([
    [4, 4, 4, 4, 4],
    [4, 4, 4, 4, 4],
    [8, 8, 8, 8, 8],
    [8, 8, 8, 8, 8],
    [8, 8, 8, 8, 8],
  ])

  it('reads each vertex cliff level from its height adjustment', () => {
    const levels = analyzeVertexCliffLevels(plateau, PARAMS)
    expect([levels.sizeX, levels.sizeY]).toEqual([5, 5])
    expect(levels.levels[0]).toBe(8)
    expect(levels.levels[4 * 5]).toBe(4)
    const png = vertexCliffLevelsToPng(levels, { pixelsPerVertex: 2 })
    // north-up: the top-left pixel is a level B vertex
    expect(pixel(png, 0, 0)).toEqual([...cliffLevelColor(4)])
    expect(pixel(png, 0, 9)).toEqual([...cliffLevelColor(8)])
  })

  it('reads each cell cliff level from t3SyncCliffLevel', () => {
    const cliff = {
      version: 0,
      sizeX: 2,
      sizeY: 1,
      heights: [0, 128],
      _raw: raw,
    } as CliffLevelResult
    const levels = analyzeCellCliffLevels(cliff)
    expect([...levels.levels]).toEqual([0, 8])
    expect(pixel(cellCliffLevelsToPng(levels), 1, 0)).toEqual([...cliffLevelColor(8)])
  })

  it('marks wall tiles only where the cell list says so and the corners differ', () => {
    const lattice = analyzeCliffLattice(
      terrain([
        { index: 0, flags: 0, cliffSetIndex: 0, variation: 0 },
        { index: 2, flags: 1, cliffSetIndex: 0, variation: 0 },
        { index: 3, flags: 2, cliffSetIndex: 0, variation: 0 },
      ]),
      analyzeVertexCliffLevels(plateau, PARAMS),
    )
    expect([...lattice.roles]).toEqual([TILE_FLAT, 0, TILE_WALL, TILE_RAMP])
    // the top row of tiles (j = 1, centre y = 3) has C corners below and B corners above: one
    // straight wall 0.5 in from its low edge
    expect(analyzeCliffFaces(lattice)).toEqual([[0, 3.5, 2, 3.5]])
  })

  it('shapes wall tiles like their meshes', () => {
    // straight wall: high edge at the bottom, face 0.5 in from the low (top) edge
    const straight = tileLevelField([8, 8, 4, 4])
    expect(straight(0, 0.4)).toBe(8)
    expect(straight(0, 0.6)).toBe(4)
    // one high corner: cut at L1 1.5
    const corner = tileLevelField([8, 4, 4, 4])
    expect(corner(-0.3, -0.3)).toBe(8)
    expect(corner(0, 0)).toBe(4)
    // one low corner: a 0.5 wedge, not the square the edge rule alone leaves
    const notch = tileLevelField([4, 8, 8, 8])
    expect(notch(-0.8, -0.8)).toBe(4)
    expect(notch(-0.6, -0.9)).toBe(8)
    // two high corners of one level on a diagonal: one rock, low only in 0.5 wedges
    const joined = tileLevelField([12, 8, 12, 8])
    expect(joined(0, 0)).toBe(12)
    expect(joined(0.8, -0.8)).toBe(8)
    // different levels on the diagonal: a low channel between them
    const channel = tileLevelField([12, 4, 8, 4])
    expect(channel(0, 0)).toBe(4)
    expect(channel(-0.8, -0.8)).toBe(12)
    expect(channel(0.8, 0.8)).toBe(8)
  })

  it('joins face segments into cliff lines with the high level on the left', () => {
    const lattice = analyzeCliffLattice(
      terrain([
        { index: 2, flags: 1, cliffSetIndex: 1, variation: 0 },
        { index: 3, flags: 1, cliffSetIndex: 1, variation: 0 },
      ]),
      analyzeVertexCliffLevels(plateau, PARAMS),
    )
    const lines = analyzeCliffLines(lattice, index => index === 1)
    // C below, B above: walking west keeps C on the left
    expect(lines).toEqual([
      {
        points: [
          [4, 3.5],
          [2, 3.5],
          [0, 3.5],
        ],
        hi: 8,
        lo: 4,
        natural: true,
        closed: false,
      },
    ])
    const smooth = smoothCliffLine(lines[0]!)
    expect(smooth[0]).toEqual([4, 3.5])
    expect(smooth[smooth.length - 1]).toEqual([0, 3.5])
    expect(Math.max(...smooth.map(([, y]) => Math.abs(y - 3.5)))).toBeLessThan(0.15)
  })

  it('waves natural lines by position, so mirrored lines stay mirrored', () => {
    const line = {
      points: [
        [0, 5],
        [4, 5],
        [8, 5],
      ] as const,
      hi: 8,
      lo: 4,
      natural: true,
      closed: false,
    }
    // the same step mirrored about y = 0: walked the other way, high ground still on the left
    const mirrored = {
      ...line,
      points: [
        [8, -5],
        [4, -5],
        [0, -5],
      ] as const,
    }
    const a = smoothCliffLine(line)
    const b = smoothCliffLine(mirrored)
      .map(([x, y]) => [x, -y] as const)
      .reverse()
    expect(b.length).toBe(a.length)
    a.forEach(([x, y], k) => {
      expect(b[k]![0]).toBeCloseTo(x, 9)
      expect(b[k]![1]).toBeCloseTo(y, 9)
    })
  })

  const placeLayer = (value: Record<string, unknown>) => [{ index: 'Place', value }]
  // Resolved catalog entities, trimmed to the fields the overview reads (from Amphion's snapshot).
  const catalog = {
    definitions: [
      {
        namespace: 'Footprint',
        entityId: '@default:CFootprint:7:0',
        fields: {
          Layers: placeLayer({
            Sets: [
              {
                index: '0',
                value: {
                  Character: 'x',
                  Positive: [
                    { index: 'GroundNoSpawn', value: 1 },
                    { index: 'NoBuild', value: 1 },
                  ],
                },
              },
            ],
          }),
        },
      },
      {
        namespace: 'Footprint',
        entityId: 'FootprintMineralsRounded',
        fields: {
          Layers: placeLayer({
            Area: '-2,-1,2,2',
            Sets: [{ index: '0', value: { Positive: [{ index: 'NearResources', value: 1 }] } }],
            Rows: [
              { index: '0', value: 'oooo' },
              { index: '1', value: 'oxxo' },
              { index: '2', value: 'oooo' },
            ],
          }),
          Shape: { Offsets: '-1,-0.5;-1,0.5;1,0.5;1,-0.5', Borders: '3,0,2;0,1,2;1,2,2;2,3,2' },
        },
      },
      {
        namespace: 'Footprint',
        entityId: 'Footprint2x2Underground',
        fields: {
          Layers: placeLayer({
            Sets: [{ index: '0', value: { Positive: [{ index: 'GroundNoSpawn', value: 0 }] } }],
            Rows: [
              { index: '0', value: 'xx' },
              { index: '1', value: 'xx' },
            ],
          }),
        },
      },
      {
        namespace: 'Footprint',
        entityId: 'FootprintWall',
        fields: {
          Layers: placeLayer({
            Area: '-1,0,2,1',
            Sets: [{ index: '0', value: { Character: 'o', Positive: [] } }],
            Rows: [{ index: '0', value: 'oxx' }],
          }),
        },
      },
      {
        namespace: 'Unit',
        entityId: 'MineralField',
        fields: {
          Footprint: 'FootprintMineralsRounded',
          ResourceType: 'Minerals',
          EditorCategories: 'ObjectType:Resource,ObjectFamily:Melee',
          BehaviorArray: [{ index: '0', value: { Link: 'MineralFieldMinerals' } }],
          FlagArray: [{ index: 'Turnable', value: 0 }],
        },
      },
      {
        namespace: 'Unit',
        entityId: 'RichMineralField',
        fields: {
          Footprint: 'FootprintMineralsRounded',
          ResourceType: 'Minerals',
          EditorCategories: 'ObjectType:Resource,ObjectFamily:Melee',
          BehaviorArray: [{ index: '0', value: { Link: 'HighYieldMineralFieldMinerals' } }],
        },
      },
      {
        namespace: 'Behavior',
        entityId: 'MineralFieldMinerals',
        fields: { HarvestAmount: 5, Contents: 1500 },
      },
      {
        namespace: 'Footprint',
        entityId: 'ShrubFootprint1x1',
        fields: {
          Layers: placeLayer({
            Area: '0,0,1,1',
            Sets: [
              {
                index: '1',
                value: {
                  Character: 'o',
                  Positive: [
                    { index: 'NoBuild', value: 1 },
                    { index: 'ShrubVision', value: 1 },
                  ],
                },
              },
            ],
            Rows: [{ index: '0', value: 'o' }],
          }),
        },
      },
      { namespace: 'Actor', entityId: 'Curtain', fields: { Footprint: 'ShrubFootprint1x1' } },
      {
        namespace: 'Behavior',
        entityId: 'HighYieldMineralFieldMinerals',
        fields: { HarvestAmount: 7 },
      },
      {
        namespace: 'Unit',
        entityId: 'UnbuildableBricksDestructible',
        fields: {
          Footprint: 'Footprint2x2Underground',
          EditorCategories: 'ObjectType:Destructible,ObjectFamily:Melee',
        },
      },
      {
        namespace: 'Unit',
        entityId: 'Wall',
        fields: { Footprint: 'FootprintWall', EditorCategories: 'ObjectType:Destructible' },
      },
      { namespace: 'Unit', entityId: 'Lyote', fields: { EditorCategories: 'ObjectType:Unit' } },
      { namespace: 'Actor', entityId: 'Fence', fields: { Footprint: 'FootprintWall' } },
      {
        namespace: 'Cliff',
        entityId: 'ShakurasCliff0',
        fields: { EditorIcon: 'Assets/Textures/ui-editoricon-terraineditor_cliffnatural.dds' },
      },
      {
        namespace: 'Cliff',
        entityId: 'CompoundFacilityCliff1',
        fields: { EditorIcon: 'Assets/Textures/ui-editoricon-terraineditor_cliffmanmade.dds' },
      },
    ],
  }

  it('reads kinds, footprints and cliff families from the resolved catalog', () => {
    const data = analyzeMapCatalog(catalog)
    expect(data.cliffFamily('ShakurasCliff0')).toBe('natural')
    expect(data.cliffFamily('CompoundFacilityCliff1')).toBe('made')
    expect(data.cliffFamily('Unknown')).toBeUndefined()
    expect(data.unit('MineralField')).toMatchObject({ kind: 'minerals', turnable: false })
    expect(data.unit('RichMineralField')).toMatchObject({ kind: 'rich-minerals', turnable: true })
    expect(data.unit('Lyote')).toEqual({ kind: 'unit', turnable: true })
    expect(data.unit('Missing')).toBeUndefined()
    // the class default makes the body character block; a set of its own keeps `o` walkable
    expect(data.unit('MineralField')?.footprint?.blocked).toEqual([
      [-1, 0],
      [0, 0],
    ])
    expect(data.unit('Wall')?.footprint).toEqual({
      blocked: [
        [0, 0],
        [1, 0],
      ],
      noBuild: [
        [0, 0],
        [1, 0],
      ],
      vision: [],
    })
    // GroundNoSpawn 0 is walkable; rows without an `Area` sit centred on the origin cell
    expect(data.unit('UnbuildableBricksDestructible')?.footprint).toEqual({
      blocked: [],
      noBuild: [
        [-1, 0],
        [0, 0],
        [-1, -1],
        [0, -1],
      ],
      vision: [],
    })
    expect(data.doodad('Curtain')?.footprint).toMatchObject({ blocked: [], vision: [[0, 0]] })
    expect(data.unit('MineralField')?.resources).toBe(1500)
    expect(data.doodad('Fence')).toMatchObject({ kind: 'doodad', turnable: true })
  })

  it('places turned footprints and start locations', () => {
    const unit = (id: number, unitType: string, rotation?: string, player = 0) => ({
      id,
      variation: 0,
      position: '10.5,20,0',
      scale: '1,1,1',
      unitType,
      player,
      ...(rotation === undefined ? {} : { rotation }),
      textures: [],
      extra: {},
    })
    const objects: PlacedObjectsResult = {
      version: 0,
      units: [
        unit(1, 'MineralField', '1.5708'),
        unit(2, 'Wall', '1.5708'),
        unit(3, 'Lyote'),
        unit(4, 'Marine', undefined, 1),
        { ...unit(6, 'MineralField'), extra: { Resources: '10' } },
        { ...unit(7, 'MineralField'), extra: { Resources: '900' } },
      ],
      doodads: [
        {
          id: 5,
          variation: 0,
          position: '4,4,0',
          scale: '1,1,1',
          type: 'Fence',
          flags: [],
          extra: {},
        },
        {
          id: 9,
          variation: 0,
          position: '8,8,0',
          scale: '0.5,0.5,0.5',
          type: 'Fence',
          flags: [{ index: 'NoDoodadFootprint', value: '1' }],
          extra: {},
        },
      ],
      points: [
        {
          id: 8,
          position: '20.5,30.5,0',
          scale: '1,1,1',
          type: 'StartLoc',
          name: 'Start Location 001',
          extra: {},
        },
      ],
      cameras: [],
      byId: new Map(),
    }
    const markers = analyzeMapMarkers(objects, analyzeMapCatalog(catalog))
    expect(markers.map(marker => marker.kind)).toEqual([
      'minerals',
      'destructible',
      'unit',
      'unit',
      'minerals',
      'minerals',
      'doodad',
      'start-location',
    ])
    // placed amounts against the fullest field on the map: a mineral wall and a smaller field
    expect(markers.map(marker => marker.supply)).toEqual([
      'full',
      undefined,
      undefined,
      undefined,
      'depleted',
      'reduced',
      undefined,
      undefined,
    ])
    expect(markers[0]).toMatchObject({ resources: 1500 })
    // not turnable: the shape stays as authored, walked in `Borders` order (from offset 3)
    expect(markers[0]!.blocks).toEqual([
      [
        [11.5, 19.5],
        [9.5, 19.5],
        [9.5, 20.5],
        [11.5, 20.5],
      ],
    ])
    // a quarter turn about the position: the row of cells x 10..12 becomes a column
    expect(markers[1]!.blocks[0]).toEqual([
      [10.5, 19.5],
      [10.5, 20.5],
      [9.5, 20.5],
      [9.5, 19.5],
    ])
    expect(markers[3]).toMatchObject({ kind: 'unit', player: 1, blocks: [] })
    expect(markers[7]).toMatchObject({ x: 20.5, y: 30.5 })
    // without a catalog every unit is a plain unit and doodads are left out
    expect(analyzeMapMarkers(objects).map(marker => marker.kind)).toEqual([
      'unit',
      'unit',
      'unit',
      'unit',
      'unit',
      'unit',
      'start-location',
    ])
    // a half turn of the cell under the position lands on itself
    expect(
      placeFootprint({ blocked: [[0, 0]], noBuild: [], vision: [] }, 0.5, 0.5, Math.PI, true)
        .blocks,
    ).toEqual([
      [
        [1, 1],
        [0, 1],
        [0, 0],
        [1, 0],
      ],
    ])
  })

  it('draws a whole map without seams', () => {
    const map = {
      rawFiles: new Map(),
      height: plateau,
      terrain: terrain([
        { index: 2, flags: 1, cliffSetIndex: 0, variation: 0 },
        { index: 3, flags: 1, cliffSetIndex: 0, variation: 0 },
      ]),
    } as unknown as SC2MapData
    const plain = renderMapOverview(map, {pixelsPerCell:4})
    const published = renderMapOverview(map, {pixelsPerCell:4,publishLattice:true})
    expect(published.rgb).toEqual(plain.rgb)
    expect(published.latticeOverview?.raster.columns).toBe(16)
    expect(published.latticeOverview?.raster.rows).toBe(16)
    expect(published.latticeOverview?.raster.movementProfile).toBeUndefined()
    expect(published.latticeOverview?.provenance.complete).toBe(false)
    expect(published.latticeOverview?.lines.length).toBeGreaterThan(0)
    expect(published.latticeOverview?.raster.elevation.every(row => row.reduce((n,[length])=>n+length,0)===16)).toBe(true)
    const render = (pathing: boolean) => {
      const overview = renderMapOverview(map, { pixelsPerCell: 4, grid: false, pathing })
      expect([overview.width, overview.height]).toEqual([16, 16])
      return (x: number, y: number) => [
        ...overview.rgb.subarray((y * 16 + x) * 3, (y * 16 + x) * 3 + 3),
      ]
    }
    const at = render(false)
    // below the face (y 3.5, pixel row 2) the ground is C, above it B, and the face line is white
    expect(at(8, 15)).toEqual([...cliffLevelColor(8)])
    expect(at(8, 6)).toEqual([...cliffLevelColor(8)])
    expect(at(8, 0)).toEqual([...cliffLevelColor(4)])
    expect(at(8, 2)).toEqual([255, 255, 255])
    // the face owns half a cell either side of its line, which sits half a line width (a
    // quarter cell at 4 px) into C: both sides shaded; open ground is not
    const shaded = render(true)
    expect(shaded(8, 15)).toEqual([...cliffLevelColor(8)])
    expect(shaded(8, 1)[0]).toBeLessThan(cliffLevelColor(4)[0])
    expect(shaded(8, 4)[0]).toBeLessThan(cliffLevelColor(8)[0])
  })

  it('reads painted layers as 8-triangle cell masks', () => {
    // 204 is the east half of a cell, 51 the west half: Amphion's cleared cliff crossing
    expect(paintedSubCell(204, 0.75, 0.5)).toBe(true)
    expect(paintedSubCell(204, 0.25, 0.5)).toBe(false)
    expect(paintedSubCell(51, 0.25, 0.1)).toBe(true)
    // mirrored halves store mirrored masks: 142 and 212 are one mask flipped north to south
    for (let column = 0; column < 2; column += 1)
      for (let row = 0; row < 4; row += 1)
        expect(paintedSubCell(142, 0.25 + column / 2, 0.125 + row / 4)).toBe(
          paintedSubCell(212, 0.25 + column / 2, 0.875 - row / 4),
        )
    // 8 is the north-east triangle on the north edge, the notch under the cleared crossing
    expect(paintedSubCell(8, 0.55, 0.95)).toBe(true)
    expect(paintedSubCell(8, 0.95, 0.55)).toBe(false)
    expect(paintedSubCell(255, 0.9, 0.9)).toBe(true)
    expect(paintedSubCell(0, 0.1, 0.1)).toBe(false)
  })

  it('offsets lines and joins the ends that meet', () => {
    const [a, b] = offsetStrands(
      [
        {
          points: [
            [0, 0],
            [2, 0],
          ],
          closed: false,
          side: 1,
        },
        {
          points: [
            [2, 0],
            [2, 2],
          ],
          closed: false,
          side: 1,
        },
      ],
      0.25,
    )
    // each moved a quarter to its left, the shared end moved to where the two moved lines cross
    expect(a![0]).toEqual([0, 0.25])
    expect(a![1]![0]).toBeCloseTo(1.75)
    expect(a![1]![1]).toBeCloseTo(0.25)
    expect(b![0]![0]).toBeCloseTo(1.75)
    expect(b![0]![1]).toBeCloseTo(0.25)
    expect(b![1]).toEqual([1.75, 2])
  })

  it('opens painted no-pathing where clear pathing is painted', () => {
    // 4x4 cells: all painted unwalkable, the bottom-left 2x2 cells cleared again
    const layer = (painted: (x: number, y: number) => boolean) => {
      const bytes = new Uint8Array(4 + 16)
      for (let y = 0; y < 4; y += 1)
        for (let x = 0; x < 4; x += 1) bytes[4 + y * 4 + x] = painted(x, y) ? 255 : 0
      return bytes
    }
    const map = {
      rawFiles: new Map([
        ['CellAttribute_Pnp', layer(() => true)],
        ['CellAttribute_Pcl', layer((x, y) => x < 2 && y < 2)],
      ]),
      height: heightMap([
        [8, 8, 8, 8, 8],
        [8, 8, 8, 8, 8],
        [8, 8, 8, 8, 8],
        [8, 8, 8, 8, 8],
        [8, 8, 8, 8, 8],
      ]),
      terrain: terrain([]),
    } as unknown as SC2MapData
    const overview = renderMapOverview(map, { pixelsPerCell: 4, grid: false })
    const at = (x: number, y: number) => [
      ...overview.rgb.subarray((y * 16 + x) * 3, (y * 16 + x) * 3 + 3),
    ]
    // pixel rows run north first: (2, 13) is in the cleared corner, (13, 2) is not
    expect(at(2, 13)).toEqual([...cliffLevelColor(8)])
    expect(at(13, 2)[0]).toBeLessThan(cliffLevelColor(8)[0])
  })
})
