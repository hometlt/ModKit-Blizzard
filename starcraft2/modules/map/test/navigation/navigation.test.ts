import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  analyzeMapNavigation,
  areaAt,
  blankSpatialData,
  canGroundStep,
  compactNavigation,
  createNavigationState,
  drawNavigation,
  descend,
  distanceField,
  clearanceField,
  labelComponents,
  partitionNavigationAreas,
  findRoute,
  findRouteAlternatives,
  parseNavigation,
  regionAt,
  removeBlockers,
  serializeNavigation,
  setRemaining,
  walkableMask,
  type MapNavigation,
  type SpatialBlocker,
} from '../../shared/navigation/index.js'
import { isCliffWalkerCrossing } from '../../shared/image/overview.js'

type Spatial = ReturnType<typeof blankSpatialData>

const rect = (x0: number, y0: number, x1: number, y1: number, width: number) => {
  const cells: number[] = []
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cells.push(y * width + x)
  return cells
}

/** Cells nothing may cross: a cliff face or painted no-pathing. */
function block(
  map: Spatial,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  kind: 'cliff' | 'painted',
) {
  for (const cell of rect(x0, y0, x1, y1, map.width)) {
    map.terrainWalkable[cell] = 0
    map.terrainBuildable[cell] = 0
    ;(kind === 'cliff' ? map.cliff : map.painted)[cell] = 1
  }
}

function setLevel(map: Spatial, x0: number, y0: number, x1: number, y1: number, level: number) {
  for (const cell of rect(x0, y0, x1, y1, map.width)) map.level[cell] = level
}

function blocker(
  map: Spatial,
  id: string,
  kind: SpatialBlocker['kind'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extra: Partial<SpatialBlocker> = {},
): SpatialBlocker {
  const cells = rect(x0, y0, x1, y1, map.width)
  const item: SpatialBlocker = {
    id,
    kind,
    type: kind,
    x: (x0 + x1 + 1) / 2,
    y: (y0 + y1 + 1) / 2,
    cells,
    placementCells: cells,
    ...extra,
  }
  map.blockers.push(item)
  return item
}

/** A 2x1 mineral field at cells `x-1..x`, row `y`, with its 3-cell town hall exclusion ring. */
function mineral(map: Spatial, id: string, x: number, y: number, resources = 1800) {
  return blocker(map, id, 'mineral', x - 1, y, x, y, {
    resources,
    nearResourceCells: rect(
      Math.max(0, x - 4),
      Math.max(0, y - 3),
      Math.min(map.width - 1, x + 3),
      Math.min(map.height - 1, y + 3),
      map.width,
    ),
  })
}

function geyser(map: Spatial, id: string, x: number, y: number) {
  return blocker(map, id, 'geyser', x - 1, y - 1, x + 1, y + 1, {
    resources: 2250,
    nearResourceCells: rect(
      Math.max(0, x - 4),
      Math.max(0, y - 4),
      Math.min(map.width - 1, x + 4),
      Math.min(map.height - 1, y + 4),
      map.width,
    ),
  })
}

/** Two rooms, level 0 and level 1, joined by a 4-cell ramp in the middle. */
function rampMap() {
  const map = blankSpatialData(40, 20)
  setLevel(map, 22, 0, 39, 19, 1)
  block(map, 18, 0, 21, 6, 'cliff')
  block(map, 18, 13, 21, 19, 'cliff')
  for (let x = 18; x <= 21; x += 1)
    for (let y = 7; y <= 12; y += 1) {
      const cell = y * map.width + x
      map.ramp[cell] = 1
      map.terrainBuildable[cell] = 0
      map.level[cell] = (x - 17.5) / 4
    }
  map.startLocations.push([5, 10])
  return map
}

/** Two rooms of one level with a wall between them and a 4-cell gap in it. */
function gapMap(fill: (map: Spatial) => void) {
  const map = blankSpatialData(40, 20)
  block(map, 19, 0, 20, 7, 'painted')
  block(map, 19, 12, 20, 19, 'painted')
  fill(map)
  map.startLocations.push([5, 10])
  return map
}

const rocksMap = () =>
  gapMap(map => blocker(map, 'rock', 'destructible', 19, 8, 20, 11, { life: 2000 }))
const mineralWallMap = () =>
  gapMap(map => {
    for (let y = 8; y <= 11; y += 1)
      blocker(map, `m${y}`, 'mineral', 19, y, 20, y, { resources: 10 })
  })

/** One room with an 8-field mineral line and a geyser. */
function baseMap() {
  const map = blankSpatialData(40, 40)
  ;[
    [14, 33],
    [16, 34],
    [18, 35],
    [20, 35],
    [22, 35],
    [24, 34],
    [26, 33],
    [20, 37],
  ].forEach(([x, y], index) => mineral(map, `min${index}`, x!, y!))
  geyser(map, 'gas', 9, 27)
  map.startLocations.push([5, 5])
  return map
}

const nodeOf = (navigation: MapNavigation, x: number, y: number) => regionAt(navigation, x, y)!

describe('map navigation analysis', () => {
  it('retains fine-grid access to a blocked expansion without moving its placement marker', () => {
    const map = baseMap()
    const position = analyzeMapNavigation(map).expansions[0]!.position
    const x = Math.floor(position[0]),
      y = Math.floor(position[1])
    blocker(map, 'base-rock', 'destructible', x - 1, y - 1, x + 1, y + 1)
    const width = map.width * 4,
      height = map.height * 4
    const current = walkableMask(map)
    const walkable = Uint8Array.from(
      { length: width * height },
      (_, cell) =>
        current[
          Math.floor(Math.floor(cell / width) / 4) * map.width + Math.floor((cell % width) / 4)
        ]!,
    )
    const navigation = analyzeMapNavigation({
      ...map,
      groundSampling: {
        width,
        height,
        cellSize: 0.25,
        walkable,
        level: new Float32Array(walkable.length),
        ramp: new Uint8Array(walkable.length),
      },
    })
    const expansion = navigation.expansions[0]!
    expect(expansion.position).toEqual(position)
    expect(expansion.placementState).toBe('BLOCKED_BY_DESTRUCTIBLE')
    expect(findRoute(navigation, 'R1', expansion.id)).toBeDefined()
    expect(navigation.nodes.find(node => node.id === expansion.id)!.position).not.toEqual(position)
  })
  it('finds a half-cell passage missed by tile centres and puts its vertex on the centreline', () => {
    const map = blankSpatialData(12, 8)
    block(map, 5, 0, 5, 7, 'painted')
    const step = 0.25,
      width = 48,
      height = 32
    const fine = {
      width,
      height,
      cellSize: step,
      walkable: new Uint8Array(width * height),
      level: new Float32Array(width * height),
      ramp: new Uint8Array(width * height),
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const wx = (x + 0.5) * step,
          wy = (y + 0.5) * step
        if (wx < 5 || wx >= 6 || (wy > 3.75 && wy < 4.25)) fine.walkable[y * width + x] = 1
      }
    expect(findRoute(analyzeMapNavigation(map), 'R1', 'R2')).toBeUndefined()
    const navigation = analyzeMapNavigation({ ...map, groundSampling: fine })
    const route = findRoute(navigation, 'R1', 'R2')!
    expect(route).toBeDefined()
    expect(route.requiredCapabilities).toEqual([])
    const passage = navigation.nodes.find(node => node.id.startsWith('NARROW'))!
    expect(passage.position).toEqual([5.5, 4])
    expect(route.nodes).toContain(passage.id)
    expect(
      navigation.edges
        .filter(edge => edge.from === passage.id || edge.to === passage.id)
        .every(edge => edge.traversalWidth === 0.5),
    ).toBe(true)
    for (const edge of navigation.edges.filter(edge => edge.type === 'GROUND')) {
      expect(edge.path![0]).toEqual(navigation.nodes.find(node => node.id === edge.from)!.position)
      expect(edge.path![edge.path!.length - 1]).toEqual(
        navigation.nodes.find(node => node.id === edge.to)!.position,
      )
    }
    for (let y = 0; y < height; y++) fine.walkable[y * width + 22] = 0
    expect(
      findRoute(analyzeMapNavigation({ ...map, groundSampling: fine }), 'R1', 'R2'),
    ).toBeUndefined()
  })
  it('draws cliff approaches in the crossing colour and short dashes at both endpoints', () => {
    const base = analyzeMapNavigation(blankSpatialData(20, 12))
    const approach = {
      ...base.edges[0]!,
      id: 'approach',
      type: 'GROUND' as const,
      entryPoint: [2.5, 4.5] as const,
      exitPoint: [5.5, 4.5] as const,
      path: [
        [2.5, 4.5],
        [5.5, 4.5],
      ] as const,
    }
    const crossing = {
      ...approach,
      id: 'crossing',
      type: 'CLIFF' as const,
      entryPoint: [5.5, 4.5] as const,
      exitPoint: [7.5, 4.5] as const,
      path: undefined,
    }
    const navigation = {
      ...base,
      edges: [approach, crossing],
      areaConnections: [
        { areaA: 'A1', areaB: 'A2', type: 'CLIFF' as const, edgeIds: ['approach', 'crossing'] },
      ],
    }
    const image = { width: 200, height: 120, rgb: new Uint8Array(200 * 120 * 3) }
    drawNavigation(image, navigation, {
      layers: {
        regions: false,
        expansions: false,
        ramps: false,
        chokes: false,
        staging: false,
        destructible: false,
        mineral: false,
        cliff: false,
        predrop: false,
        nodes: false,
        edges: true,
      },
    })
    const rgbAt = (x: number) =>
      image.rgb.slice((75 * image.width + x) * 3, (75 * image.width + x) * 3 + 3)
    const approachPixel = rgbAt(35)
    expect(approachPixel[2]).toBeGreaterThan(approachPixel[0]!)
    expect(approachPixel[0]).toBeGreaterThan(approachPixel[1]!)
    expect(rgbAt(72).some(channel => channel > 0)).toBe(true)
  })
  it('snaps a cliff landing past a tiny fringe ledge to the actual lower plateau', () => {
    const map = blankSpatialData(32, 20)
    setLevel(map, 19, 0, 31, 19, 1)
    block(map, 15, 0, 18, 19, 'cliff')
    for (const x of [17, 18]) {
      map.terrainWalkable[10 * 32 + x] = 1
      map.cliff[10 * 32 + x] = 0
    }
    map.level[10 * 32 + 18] = 0.5 // low ledge belongs to the upper component via its fringe
    const navigation = analyzeMapNavigation({
      ...map,
      cliffCrossings: [{ a: [19.5, 10.5], b: [17.5, 10.5], width: 1, levelA: 1, levelB: 0 }],
    })
    const portal = navigation.cliffPortals[0]!
    expect(portal).toBeDefined()
    expect(portal.regionA).not.toBe(portal.regionB)
    expect([portal.entryA, portal.entryB]).toContainEqual([14.5, 10.5])
    expect(findRoute(navigation, 'R1', 'R2')).toBeUndefined()
    expect(findRoute(navigation, 'R1', 'R2', { capabilities: ['cliff'] })!.classes).toEqual([
      'CLIFF',
    ])
  })
  it('does not connect neighbouring open cells across a whole cliff level without a ramp', () => {
    const map = blankSpatialData(24, 12)
    setLevel(map, 12, 0, 23, 11, 1)
    const canStep = (a: number, b: number) => canGroundStep(map, a, b)
    const navigation = analyzeMapNavigation({
      ...map,
      cliffCrossings: [{ a: [11.5, 6.5], b: [12.5, 6.5], width: 1, levelA: 0, levelB: 1 }],
    })
    expect(navigation.regions).toHaveLength(2)
    expect(findRoute(navigation, 'R1', 'R2')).toBeUndefined()
    expect(findRoute(navigation, 'R1', 'R2', { capabilities: ['cliff'] })!.classes).toEqual([
      'CLIFF',
    ])
    const field = distanceField(
      map,
      map.terrainWalkable,
      [0],
      Infinity,
      undefined,
      undefined,
      canStep,
    )
    expect(field[12]).toBe(Infinity)
    const raw = labelComponents(map, map.terrainWalkable, canStep)
    const areas = partitionNavigationAreas(
      map,
      raw.labels,
      ['R1', 'R2'],
      [],
      { maxRadius: 10, resourceRadius: 6 },
      canStep,
    )
    for (let owner = 1; owner <= areas.areas.length; owner += 1) {
      const mask = Uint8Array.from(areas.labels, label => (label === owner ? 1 : 0))
      expect(labelComponents(map, mask, canStep).count).toBe(1)
    }
  })
  it('partitions connected ground into covered, connected areas with a strict ground radius', () => {
    const map = blankSpatialData(60, 24)
    const navigation = analyzeMapNavigation(map, { area: { maxRadius: 10 } })
    expect(navigation.areas.length).toBeGreaterThan(1)
    for (const area of navigation.areas) {
      expect(area.radius).toBeLessThanOrEqual(10)
      expect(findRoute(navigation, 'R1', area.expansionId ?? area.id)).toBeDefined()
      const index = navigation.areas.indexOf(area) + 1
      const mask = new Uint8Array(map.width * map.height)
      for (let k = 0; k < navigation.areaRuns.length; k += 3)
        if (navigation.areaRuns[k + 2] === index)
          mask.fill(
            1,
            navigation.areaRuns[k]!,
            navigation.areaRuns[k]! + navigation.areaRuns[k + 1]!,
          )
      expect(labelComponents(map, mask).count).toBe(1)
    }
    for (let y = 0; y < map.height; y += 1)
      for (let x = 0; x < map.width; x += 1) expect(areaAt(navigation, x, y)).not.toBeNull()
    expect(areaAt(navigation, 60, 0)).toBeNull()
    expect(regionAt(navigation, 60, 0)).toBeNull()
    expect(
      navigation.areaConnections.every(connection => connection.areaA !== connection.areaB),
    ).toBe(true)
  })

  it('keeps the two approaches of a same-region cliff shortcut in distinct strategic areas', () => {
    const map = blankSpatialData(24, 12)
    setLevel(map, 12, 0, 23, 11, 1)
    map.level[24 + 12] = 0.5 // a legal detour joins the physical ground component
    const navigation = analyzeMapNavigation({
      ...map,
      cliffCrossings: [{ a: [11.5, 8.5], b: [12.5, 8.5], width: 1, levelA: 0, levelB: 1 }],
    })
    expect(navigation.regions).toHaveLength(1)
    const portal = navigation.cliffPortals[0]!
    expect(areaAt(navigation, ...portal.entryA)).not.toBe(areaAt(navigation, ...portal.entryB))
    expect(navigation.areaConnections.some(connection => connection.type === 'CLIFF')).toBe(true)
  })

  it('protects a resource neighbourhood from nearby passage seeds instead of meshing inside a base', () => {
    const size = { width: 40, height: 20 }
    const base = 10 * size.width + 10
    const result = partitionNavigationAreas(
      size,
      new Int32Array(800).fill(1),
      ['R1'],
      [{ cell: base, expansionId: 'E1' }, { cell: base + 2 }],
      { maxRadius: 8, resourceRadius: 6 },
    )
    expect(result.areas[0]!.expansionId).toBe('E1')
    expect(result.labels[base + 2]).toBe(1)
    expect(result.labels[base + 5]).toBe(1)
    expect(result.areas.some(area => area.center[0] === 12.5 && area.center[1] === 10.5)).toBe(
      false,
    )
    const navigation = analyzeMapNavigation(baseMap())
    const expansion = navigation.expansions[0]!
    const area = navigation.areas.find(area => area.expansionId === expansion.id)!
    expect(areaAt(navigation, ...expansion.position)).toBe(area.id)
    for (const connection of navigation.areaConnections)
      expect(connection.areaA).not.toBe(connection.areaB)
    const again = partitionNavigationAreas(
      size,
      new Int32Array(800).fill(1),
      ['R1'],
      [{ cell: base, expansionId: 'E1' }, { cell: base + 2 }],
      { maxRadius: 8, resourceRadius: 6 },
    )
    expect(result.runs).toEqual(again.runs)
    expect(() =>
      partitionNavigationAreas(size, new Int32Array(800), [], [], {
        maxRadius: 0,
        resourceRadius: 0,
      }),
    ).toThrow(RangeError)
  })

  it('retains two mirrored cliff crossings next to ground ramps even when the detour is short', () => {
    const map = rampMap()
    const crossings = [
      { a: [22.5, 5.5] as const, b: [17.5, 5.5] as const, levelA: 1, levelB: 0, width: 1 },
      { a: [22.5, 14.5] as const, b: [17.5, 14.5] as const, levelA: 1, levelB: 0, width: 1 },
    ]
    const navigation = analyzeMapNavigation({ ...map, cliffCrossings: crossings })
    expect(navigation.cliffPortals).toHaveLength(2)
    expect(findRoute(navigation, 'R1', 'R2')).toBeDefined()
    for (const portal of navigation.cliffPortals)
      expect(
        findRoute(navigation, `${portal.id}:a`, `${portal.id}:b`, {
          capabilities: ['cliff'],
        })!.steps.some(step => step.edge.type === 'CLIFF'),
      ).toBe(true)
  })
  it('reconstructs walking paths without cutting blocked diagonal corners', () => {
    const size = { width: 4, height: 4 }
    const mask = new Uint8Array(16).fill(1)
    mask[1] = 0
    const path = descend(size, distanceField(size, mask, [0]), 2).reverse()
    expect(path[0]).toBe(0)
    expect(path[path.length - 1]).toBe(2)
    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1]!,
        b = path[i]!
      if (a % 4 !== b % 4 && Math.floor(a / 4) !== Math.floor(b / 4)) {
        expect(mask[Math.floor(a / 4) * 4 + (b % 4)]).toBe(1)
        expect(mask[Math.floor(b / 4) * 4 + (a % 4)]).toBe(1)
      }
    }
  })

  it('hides transport portals and their incident ground edges in the default debug view', () => {
    const base = analyzeMapNavigation(rocksMap())
    expect(base.predropPortals.length).toBeGreaterThan(0)
    const hiddenIds = new Set(
      base.nodes.filter(node => node.type === 'PREDROP_PORTAL').map(node => node.id),
    )
    const navigation = {
      ...base,
      regions: [],
      expansions: [],
      ramps: [],
      chokes: [],
      blockers: [],
      destructiblePortals: [],
      mineralPortals: [],
      cliffPortals: [],
      regionRuns: [],
      areas: [],
      areaRuns: [],
      areaConnections: [],
      nodes: base.nodes.filter(node => hiddenIds.has(node.id)),
      edges: base.edges.filter(edge => hiddenIds.has(edge.from) || hiddenIds.has(edge.to)),
    }
    const overview = { width: 160, height: 80, rgb: new Uint8Array(160 * 80 * 3) }
    drawNavigation(overview, navigation)
    expect(overview.rgb.some(value => value !== 0)).toBe(false)
  })
  it('shares the minimap side probes and rejects tall or obstructed cliff crossings', () => {
    expect(isCliffWalkerCrossing(8, 4, 5, 5, 1, 0, () => true)).toBe(true)
    expect(isCliffWalkerCrossing(12, 4, 5, 5, 1, 0, () => true)).toBe(false)
    expect(isCliffWalkerCrossing(8, 4, 5, 5, 1, 0, x => x < 6)).toBe(false)
    for (const tall of [false, true]) {
      const map = blankSpatialData(40, 20)
      setLevel(map, 21, 0, 39, 19, tall ? 2 : 1)
      block(map, 20, 0, 20, 19, 'cliff')
      if (!tall) block(map, 19, 0, 19, 19, 'painted')
      expect(analyzeMapNavigation(map).cliffPortals).toEqual([])
    }
  })

  it('respects supplied geometric cliff crossings, including an explicitly empty set', () => {
    const map = blankSpatialData(40, 20)
    setLevel(map, 21, 0, 39, 19, 1)
    block(map, 20, 0, 20, 19, 'cliff')
    expect(analyzeMapNavigation({ ...map, cliffCrossings: [] }).cliffPortals).toEqual([])
    const navigation = analyzeMapNavigation({
      ...map,
      cliffCrossings: [{ a: [21.5, 10.5], b: [19.5, 10.5], levelA: 1, levelB: 0, width: 1 }],
    })
    expect(navigation.cliffPortals).toHaveLength(1)
  })

  it('detects centred chokes between roomy interiors, including a diagonal corridor', () => {
    const straight = blankSpatialData(40, 20)
    block(straight, 18, 0, 21, 7, 'painted')
    block(straight, 18, 12, 21, 19, 'painted')
    const navigation = analyzeMapNavigation(straight)
    expect(navigation.chokes).toHaveLength(1)
    expect(navigation.chokes[0]!.center[0]).toBeGreaterThanOrEqual(18)
    expect(navigation.chokes[0]!.center[0]).toBeLessThan(22)
    expect(navigation.nodes.some(node => node.type === 'CHOKE')).toBe(true)
    const diagonal = blankSpatialData(40, 40)
    for (let y = 0; y < 40; y += 1)
      for (let x = 0; x < 40; x += 1)
        if (!((x < 15 && y < 15) || (x >= 25 && y >= 25) || Math.abs(x - y) <= 2))
          block(diagonal, x, y, x, y, 'painted')
    const diagonalResult = analyzeMapNavigation(diagonal)
    expect(diagonalResult.chokes.length).toBeGreaterThan(0)
    for (const choke of diagonalResult.chokes)
      expect(regionAt(diagonalResult, ...choke.center)).toBe(choke.regionId)
  })

  it('retains partly obstructing rocks and validates restored crossing paths', () => {
    const map = blankSpatialData(40, 12)
    block(map, 0, 0, 39, 1, 'painted')
    block(map, 0, 10, 39, 11, 'painted')
    blocker(map, 'partial-rock', 'destructible', 19, 4, 20, 7, { life: 500 })
    const navigation = analyzeMapNavigation(map)
    expect(navigation.blockers.map(item => item.id)).toContain('partial-rock')
    const portal = navigation.destructiblePortals[0]!
    expect(portal).toMatchObject({ partial: true, connectsNewly: false })
    expect(portal.path!.some(([x, y]) => x >= 19 && x < 21 && y >= 4 && y < 8)).toBe(true)
  })

  it('finds authored ramps and conditional rock crossings even when their slope is blocked', () => {
    const map = rampMap()
    blocker(map, 'ramp-rock', 'destructible', 19, 7, 20, 12, { life: 1000 })
    const navigation = analyzeMapNavigation({
      ...map,
      rampShapes: [
        { center: [20, 10], direction: [1, 0], lower: [18, 10], upper: [22, 10], width: 6 },
      ],
    })
    expect(navigation.ramps).toHaveLength(1)
    expect(navigation.destructiblePortals).toHaveLength(1)
    expect(findRoute(navigation, 'R1', 'R2', { capabilities: ['destroy'] })!.classes).toEqual([
      'DESTRUCTIBLE',
    ])
  })

  it('connects two levels through a ramp with staging points on both sides (cases 1, 11)', () => {
    const navigation = analyzeMapNavigation(rampMap())
    expect(navigation.regions.map(region => [region.id, region.level])).toEqual([
      ['R1', 0],
      ['R2', 1],
    ])
    expect(navigation.ramps).toHaveLength(1)
    const ramp = navigation.ramps[0]!
    expect(ramp).toMatchObject({ lowerRegion: 'R1', upperRegion: 'R2', width: 6 })
    expect(ramp.direction[0]).toBeGreaterThan(0.9)
    // staging points: on the right side, off the ramp, with room
    expect(regionAt(navigation, ...ramp.lowerStagingPoint)).toBe('R1')
    expect(regionAt(navigation, ...ramp.upperStagingPoint)).toBe('R2')
    expect(ramp.lowerStagingPoint[0]).toBeLessThan(18)
    expect(ramp.upperStagingPoint[0]).toBeGreaterThan(22)
    expect(ramp.lowerStagingPoint[1]).toBeGreaterThanOrEqual(7)
    expect(ramp.lowerStagingPoint[1]).toBeLessThanOrEqual(13)
    const route = findRoute(navigation, 'R1', 'R2')!
    expect(route.classes).toEqual([])
    expect(route.steps.map(step => step.edge.type)).toContain('RAMP')
    expect(navigation.regions[1]!.access).toMatchObject({ ground: true })
  })

  it('turns rocks in a gap into a destructible passage (case 2) and opens it at runtime (case 13)', () => {
    const navigation = analyzeMapNavigation(rocksMap())
    expect(navigation.regions).toHaveLength(2)
    expect(navigation.mineralPortals).toEqual([])
    expect(navigation.destructiblePortals).toHaveLength(1)
    expect(navigation.destructiblePortals[0]).toMatchObject({
      regionA: 'R1',
      regionB: 'R2',
      blockerIds: ['rock'],
      connectsNewly: true,
      groundDistance: null,
      totalLife: 2000,
      width: 4,
    })
    expect(findRoute(navigation, 'R1', 'R2')).toBeUndefined()
    const destroy = findRoute(navigation, 'R1', 'R2', { capabilities: ['destroy'] })!
    expect(destroy.classes).toEqual(['DESTRUCTIBLE'])
    expect(destroy.destructionHP).toBe(2000)
    expect(navigation.regions[1]!.access).toEqual({
      ground: false,
      afterDestructibles: true,
      afterMineralWall: false,
      cliffWalker: false,
      // a transport simply flies over the thin wall
      preDrop: true,
    })
    // the rocks die: the same graph now has a plain ground route
    const edges = navigation.edges
    const state = removeBlockers(createNavigationState(), ['rock'])
    const open = findRoute(navigation, 'R1', 'R2', { state })!
    expect(open.classes).toEqual([])
    expect(open.destructionHP).toBe(0)
    expect(navigation.edges).toBe(edges)
  })

  it('keeps mineral walls apart from rocks (case 3) and opens them when mined out (case 14)', () => {
    const map = mineralWallMap()
    const navigation = analyzeMapNavigation(map)
    expect(navigation.destructiblePortals).toEqual([])
    expect(navigation.mineralPortals).toHaveLength(1)
    expect(navigation.mineralPortals[0]).toMatchObject({
      kind: 'mineral-wall',
      totalResources: 40,
      connectsNewly: true,
    })
    expect(navigation.expansions).toEqual([])
    const mine = findRoute(navigation, 'R1', 'R2', { capabilities: ['mine'] })!
    expect(mine.classes).toEqual(['MINERAL_WALL'])
    expect(mine.mineralAmount).toBe(40)
    let state = setRemaining(createNavigationState(), 'm8', 3)
    expect(
      findRoute(navigation, 'R1', 'R2', { capabilities: ['mine'], state })!.mineralAmount,
    ).toBe(33)
    for (const id of ['m8', 'm9', 'm10', 'm11']) state = setRemaining(state, id, 0)
    expect(findRoute(navigation, 'R1', 'R2', { state })!.classes).toEqual([])
  })

  it('ignores a destructible that does not open a passage (case 4)', () => {
    const map = blankSpatialData(30, 20)
    block(map, 0, 0, 29, 1, 'painted')
    blocker(map, 'corner-rock', 'destructible', 0, 2, 3, 5, { life: 500 })
    const navigation = analyzeMapNavigation(map)
    expect(navigation.regions).toHaveLength(1)
    expect(navigation.destructiblePortals).toEqual([])
  })

  it('finds an expansion beside its minerals and geyser (case 5)', () => {
    const navigation = analyzeMapNavigation(baseMap())
    expect(navigation.expansions).toHaveLength(1)
    const expansion = navigation.expansions[0]!
    expect(expansion).toMatchObject({
      id: 'E1',
      placementState: 'AVAILABLE',
      placementBlockers: [],
      regionId: 'R1',
      minerals: 8 * 1800,
      gas: 2250,
      geyserIds: ['gas'],
    })
    expect(expansion.mineralIds).toHaveLength(8)
    const [x, y] = expansion.position
    expect(Math.hypot(x - 20, y - 34)).toBeLessThan(10)
    // no hall cell inside a mineral's exclusion ring
    expect(y + 2.5).toBeLessThanOrEqual(30)
  })

  it('keeps an expansion whose spot is covered by rocks, marked blocked (case 6)', () => {
    const free = analyzeMapNavigation(baseMap()).expansions[0]!.position
    const map = baseMap()
    const [x, y] = [Math.floor(free[0]), Math.floor(free[1])]
    blocker(map, 'base-rock', 'destructible', x - 1, y - 1, x + 1, y + 1, { life: 1500 })
    const expansion = analyzeMapNavigation(map).expansions[0]!
    expect(expansion.position).toEqual(free)
    expect(expansion.placementState).toBe('BLOCKED_BY_DESTRUCTIBLE')
    expect(expansion.placementBlockers).toEqual(['base-rock'])
  })

  it('tells a true island from one a transport reaches (cases 7, 8)', () => {
    const island = (gap: number) => {
      const map = blankSpatialData(40 + gap, 30)
      block(map, 20, 0, 19 + gap, 29, 'painted')
      ;[
        [28 + gap, 22],
        [30 + gap, 23],
        [32 + gap, 24],
        [34 + gap, 24],
        [36 + gap, 23],
      ].forEach(([x, y], index) => mineral(map, `i${index}`, x!, y!))
      map.startLocations.push([5, 15])
      return analyzeMapNavigation(map)
    }
    const far = island(30)
    expect(far.regions).toHaveLength(2)
    expect(far.predropPortals).toEqual([])
    expect(far.expansions[0]!.access).toEqual({
      ground: false,
      afterDestructibles: false,
      afterMineralWall: false,
      cliffWalker: false,
      preDrop: false,
    })
    const near = island(8)
    expect(near.predropPortals.length).toBeGreaterThan(0)
    expect(near.predropPortals[0]).toMatchObject({
      regionA: 'R1',
      regionB: 'R2',
      groundDistance: null,
      groundShortcutRatio: null,
    })
    expect(near.expansions[0]!.access).toEqual({
      ground: false,
      afterDestructibles: false,
      afterMineralWall: false,
      cliffWalker: false,
      preDrop: true,
    })
    const flight = findRoute(near, 'R1', near.expansions[0]!.id, { capabilities: ['transport'] })!
    expect(flight.classes).toEqual(['PREDROP'])
  })

  it('lets cliff walkers cross a cliff between two levels (case 9)', () => {
    const map = blankSpatialData(40, 20)
    setLevel(map, 21, 0, 39, 19, 1)
    block(map, 20, 0, 20, 19, 'cliff')
    map.startLocations.push([5, 10])
    const navigation = analyzeMapNavigation(map)
    expect(navigation.regions).toHaveLength(2)
    expect(navigation.cliffPortals.length).toBeGreaterThan(0)
    // long cliffs become a few portals, not one per cell
    expect(navigation.cliffPortals.length).toBeLessThanOrEqual(4)
    expect(navigation.cliffPortals[0]).toMatchObject({
      regionA: 'R1',
      regionB: 'R2',
      cliffLevelDelta: 1,
    })
    expect(navigation.regions[1]!.access).toMatchObject({ ground: false, cliffWalker: true })
    expect(findRoute(navigation, 'R1', 'R2', { capabilities: ['cliff'] })!.classes).toEqual([
      'CLIFF',
    ])
  })

  it('finds a transport shortcut over a wall that ground units walk around (case 10)', () => {
    // A U: two arms split by a wall, joined at the far end.
    const map = blankSpatialData(60, 24)
    block(map, 0, 10, 50, 13, 'painted')
    map.startLocations.push([3, 5])
    const navigation = analyzeMapNavigation(map)
    expect(navigation.regions).toHaveLength(1)
    const shortcut = navigation.predropPortals.find(
      portal => (portal.groundShortcutRatio ?? 0) >= 2,
    )
    expect(shortcut).toBeDefined()
    expect(shortcut!.groundDistance! - shortcut!.airDistance).toBeGreaterThanOrEqual(16)
    // a transport crossing the wall beats walking around it
    const route = findRoute(navigation, `${shortcut!.id}:a`, `${shortcut!.id}:b`, {
      capabilities: ['transport'],
    })!
    expect(route.classes).toEqual(['PREDROP'])
  })

  it('returns alternative route classes between the same regions (case 12)', () => {
    // Rocks in a gap near the start, the long way round through the far end.
    const map = blankSpatialData(70, 30)
    block(map, 34, 0, 36, 22, 'painted')
    blocker(map, 'rock', 'destructible', 34, 2, 36, 5, { life: 2000 })
    for (const cell of rect(34, 2, 36, 5, 70)) {
      map.terrainWalkable[cell] = 1
      map.painted[cell] = 0
    }
    map.startLocations.push([5, 5])
    const navigation = analyzeMapNavigation(map)
    const from = nodeOf(navigation, 5, 3)
    const expansionLess = navigation.nodes.find(node => node.type === 'REGION')!.id
    expect(from).toBe(expansionLess)
    const pick = (x: number, y: number) =>
      navigation.nodes
        .filter(node => node.region === from)
        .reduce((best, node) =>
          Math.hypot(node.position[0] - x, node.position[1] - y) <
          Math.hypot(best.position[0] - x, best.position[1] - y)
            ? node
            : best,
        )
    const start = pick(31, 4).id
    const goal = pick(40, 4).id
    const routes = findRouteAlternatives(navigation, start, goal)
    const classes = routes.map(route => route.classes.join('+'))
    expect(classes).toContain('')
    expect(classes).toContain('DESTRUCTIBLE')
    expect(new Set(classes).size).toBe(classes.length)
    const ground = routes.find(route => route.classes.length === 0)!
    for (const route of routes)
      if (route !== ground) expect(route.distance).toBeLessThan(ground.distance)
  })

  it('serializes deterministically, compacts and draws', () => {
    const first = serializeNavigation(analyzeMapNavigation(rocksMap()))
    const second = serializeNavigation(analyzeMapNavigation(rocksMap()))
    expect(first).toBe(second)
    const navigation = parseNavigation(first)
    const compact = compactNavigation(navigation)
    expect(compact.nodeIds).toHaveLength(navigation.nodes.length)
    expect(compact.edges).toHaveLength(navigation.edges.length * 9)
    expect(compact.blockers).toContain('rock')
    const overview = { width: 160, height: 80, rgb: new Uint8Array(160 * 80 * 3) }
    const route = findRoute(navigation, 'R1', 'R2', { capabilities: ['destroy'] })!
    drawNavigation(overview, navigation, { routes: [route], spatial: rocksMap() })
    expect(overview.rgb.some(value => value !== 0)).toBe(true)
  })
})

it('preserves the frozen pre-extraction weighted navigation corpus including callback order', () => {
  const hash = createHash('sha256')
  let seed = 38721
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  for (let k = 0; k < 256; k++) {
    const size = { width: 3 + (next() % 7), height: 3 + (next() % 6) },
      n = size.width * size.height
    const mask = Uint8Array.from({ length: n }, () => (next() % 5 ? 1 : 0))
    const costs = Float32Array.from({ length: n }, () => [0, 0.25, 1, 2][next() % 4]!)
    const owners = new Int32Array(n)
    const protectedOwners = Int32Array.from({ length: n }, () =>
      next() % 7 === 0 ? 1 + (next() % 3) : 0,
    )
    const trace: number[][] = [],
      sources = [-1, next() % n, next() % n, n + 1, 0, 0]
    const field = distanceField(
      size,
      mask,
      sources,
      k % 3 === 0 ? 2 : Infinity,
      k % 2 ? costs : undefined,
      { owners, protected: protectedOwners },
      (a, b) => {
        trace.push([a, b])
        return (a * 7 + b) % 13 !== 0
      },
    )
    const clearance = clearanceField(size, mask)
    const path = descend(size, field, n - 1, k % 2 ? costs : undefined)
    hash.update(
      JSON.stringify({
        field: [...field].map(String),
        owners: [...owners],
        clearance: [...clearance].map(String),
        path,
        trace,
      }),
    )
  }
  // Saved untouched grid.ts at Blizzard bb0c7cf0, independently compared before replacing the kernel.
  expect(hash.digest('hex')).toBe(
    'bdfdb66d3f7a2471188781e8293f1ec4bfc9c7728f8a094b71b14e77827c0e31',
  )
})
