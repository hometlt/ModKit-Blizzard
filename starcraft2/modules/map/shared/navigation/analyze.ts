/**
 * Map topology analysis over a `MapSpatialData`: ground regions, ramps with staging points,
 * destructible and mineral-wall passages, expansions, cliff-walker and transport (pre-drop)
 * portals, and one multimodal navigation graph over all of them. Game-agnostic: everything comes
 * from the normalized masks and blockers, nothing from names or known coordinates.
 */

import {
  centreOf,
  clearanceField,
  clusterPoints,
  DisjointSets,
  distanceField,
  descend,
  inside,
  labelComponents,
  SpatialHash,
  type GridSize,
  type Point,
} from './grid.js'
import {
  walkableMask,
  canGroundStep,
  type BlockerKind,
  type MapSpatialData,
  type SpatialBlocker,
} from './spatial.js'
import {
  partitionNavigationAreas,
  type AreaOptions,
  type AreaSeed,
  type NavigationArea,
} from './areas.js'
import { refineGroundNavigation } from './refine.js'

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface NavigationOptions {
  readonly area: AreaOptions
  /** Walkable areas smaller than this many cells are not regions. */
  readonly minRegionArea: number
  /** Removable blockers this close (cells) form one barrier. */
  readonly blockerGroupGap: number
  /** A crossing is a shortcut when the ground route is at least this many times longer … */
  readonly shortcutRatio: number
  /** … and at least this many cells longer. */
  readonly minShortcutSaving: number
  /** Staging points stand this far from a ramp's end, with at least this clearance. */
  readonly stagingDistance: number
  readonly stagingClearance: number
  readonly expansion: {
    /** Mineral fields this close belong to one resource cluster. */
    readonly mineralLink: number
    /** A geyser joins the nearest cluster within this distance. */
    readonly geyserLink: number
    readonly minMinerals: number
    /** Town hall centres are searched this far from the cluster centre. */
    readonly searchRadius: number
    /** The town hall footprint, cells a side. */
    readonly hallSize: number
    /** Fields holding less than this share of the fullest field are a wall, not a base … */
    readonly depletedShare: number
    /** … and so are fields holding less than this. */
    readonly minFieldResources: number
    readonly geyserWeight: number
  }
  readonly cliff: {
    /** Unwalkable cells a cliff walker may cross in one go. */
    readonly maxGap: number
    /** Painted no-pathing between the two sides still allows a crossing. */
    readonly crossesPainted: boolean
    readonly maxPortalWidth: number
    readonly minSpacing: number
  }
  readonly preDrop: {
    readonly maxAirDistance: number
    readonly minAirDistance: number
    /** Clearance a pickup or drop point needs (cells). */
    readonly landingClearance: number
    /** One boundary sample per this many cells. */
    readonly sampleSpacing: number
    readonly minRatio: number
    readonly minSaving: number
    /** Pairs this close on both ends are one portal. */
    readonly clusterRadius: number
    readonly maxPerRegionPair: number
  }
  /** @deprecated Retained for compatibility; connected strategic areas replace the anchor mesh. */
  readonly nearestAnchors: number
  readonly choke: {
    readonly roomClearance: number
    readonly minRoomArea: number
    readonly maxWidth: number
  }
}

export const DEFAULT_NAVIGATION_OPTIONS: NavigationOptions = {
  area: { maxRadius: 18, resourceRadius: 11 },
  minRegionArea: 8,
  blockerGroupGap: 2,
  shortcutRatio: 1.5,
  minShortcutSaving: 6,
  stagingDistance: 3,
  stagingClearance: 2,
  expansion: {
    mineralLink: 6,
    geyserLink: 11,
    minMinerals: 4,
    searchRadius: 12,
    hallSize: 5,
    depletedShare: 0.1,
    minFieldResources: 50,
    geyserWeight: 1.5,
  },
  cliff: { maxGap: 3, crossesPainted: false, maxPortalWidth: 8, minSpacing: 6 },
  preDrop: {
    maxAirDistance: 16,
    minAirDistance: 4,
    landingClearance: 2,
    sampleSpacing: 4,
    minRatio: 2,
    minSaving: 16,
    clusterRadius: 6,
    maxPerRegionPair: 2,
  },
  nearestAnchors: 6,
  choke: { roomClearance: 3, minRoomArea: 24, maxWidth: 8 },
}

export type NavigationOptionsInput = Partial<
  Omit<NavigationOptions, 'expansion' | 'cliff' | 'preDrop' | 'choke' | 'area'>
> & {
  readonly expansion?: Partial<NavigationOptions['expansion']>
  readonly cliff?: Partial<NavigationOptions['cliff']>
  readonly preDrop?: Partial<NavigationOptions['preDrop']>
  readonly choke?: Partial<NavigationOptions['choke']>
  readonly area?: Partial<AreaOptions>
}

function resolveOptions(input: NavigationOptionsInput = {}): NavigationOptions {
  const base = DEFAULT_NAVIGATION_OPTIONS
  const area = { ...base.area, ...input.area }
  if (input.area?.resourceRadius === undefined)
    area.resourceRadius = Math.min(area.resourceRadius, area.maxRadius)
  return {
    ...base,
    ...input,
    expansion: { ...base.expansion, ...input.expansion },
    cliff: { ...base.cliff, ...input.cliff },
    preDrop: { ...base.preDrop, ...input.preDrop },
    choke: { ...base.choke, ...input.choke },
    area,
  }
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

/** How a region or expansion can be reached from the start regions, per movement class. */
export interface Access {
  readonly ground: boolean
  readonly afterDestructibles: boolean
  readonly afterMineralWall: boolean
  readonly cliffWalker: boolean
  readonly preDrop: boolean
}

export interface GroundRegion {
  readonly id: string
  readonly level: number
  readonly area: number
  /** `[x0, y0, x1, y1]` in cells, end exclusive. */
  readonly bounds: readonly [number, number, number, number]
  readonly centroid: Point
  readonly portalIds: readonly string[]
  readonly access: Access
}

export interface ChokeInfo {
  readonly id: string
  readonly center: Point
  readonly entryA: Point
  readonly entryB: Point
  readonly regionId: string
  readonly width: number
}

export interface RampInfo {
  readonly id: string
  readonly center: Point
  readonly width: number
  /** Unit vector from the lower to the upper end. */
  readonly direction: Point
  readonly lowerRegion: string
  readonly upperRegion: string
  readonly lowerEntry: Point
  readonly upperEntry: Point
  readonly lowerStagingPoint: Point
  readonly upperStagingPoint: Point
}

export interface BlockerPortal {
  readonly id: string
  readonly kind: 'destructible' | 'mineral-wall'
  readonly blockerIds: readonly string[]
  readonly regionA: string
  readonly regionB: string
  readonly entryA: Point
  readonly entryB: Point
  /** Walking distance from A to B once the blockers are gone. */
  readonly crossing: number
  readonly path?: readonly Point[]
  /** Current ground distance between the entries; `null` when there is no ground route. */
  readonly groundDistance: number | null
  /** Removing the blockers connects regions that are otherwise not connected by ground. */
  readonly connectsNewly: boolean
  readonly width: number
  readonly totalLife?: number
  /** Removal widens an existing passage rather than opening a closed one. */
  readonly partial?: boolean
  readonly totalResources?: number
}

export type PlacementState =
  'AVAILABLE' | 'BLOCKED_BY_DESTRUCTIBLE' | 'BLOCKED_BY_MINERALS' | 'BLOCKED_BY_NEUTRAL' | 'INVALID'

export interface Expansion {
  readonly id: string
  /** Town hall centre. */
  readonly position: Point
  readonly mineralIds: readonly string[]
  readonly geyserIds: readonly string[]
  readonly regionId: string | null
  readonly placementState: PlacementState
  readonly placementBlockers: readonly string[]
  readonly minerals: number
  readonly gas: number
  /** Index into the map's start locations when a player starts here. */
  readonly startLocation?: number
  readonly access: Access
}

export interface CliffPortal {
  readonly id: string
  readonly regionA: string
  readonly regionB: string
  readonly entryA: Point
  readonly entryB: Point
  readonly cliffLevelDelta: number
  readonly width: number
  readonly crossing: number
}

export interface PreDropPortal {
  readonly id: string
  readonly regionA: string
  readonly regionB: string
  readonly pickupA: Point
  readonly dropB: Point
  readonly pickupB: Point
  readonly dropA: Point
  readonly airDistance: number
  readonly groundDistance: number | null
  readonly groundShortcutRatio: number | null
  readonly landingClearance: number
}

export type NavigationNodeType =
  | 'REGION'
  | 'AREA'
  | 'CHOKE'
  | 'EXPANSION'
  | 'RAMP'
  | 'STAGING_POINT'
  | 'DESTRUCTIBLE_PORTAL'
  | 'MINERAL_PORTAL'
  | 'CLIFF_PORTAL'
  | 'PREDROP_PORTAL'

export type NavigationEdgeType =
  'GROUND' | 'RAMP' | 'DESTRUCTIBLE' | 'MINERAL_WALL' | 'CLIFF' | 'PREDROP'

export type Capability = 'destroy' | 'mine' | 'cliff' | 'transport'

export interface NavigationNode {
  readonly id: string
  readonly type: NavigationNodeType
  readonly position: Point
  /** The ground region the node stands in (ramp nodes stand in none). */
  readonly region: string | null
  readonly area?: string
  /** The ramp, portal or expansion the node belongs to. */
  readonly ref?: string
}

/** An undirected edge: routes may use it either way. */
export interface NavigationEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: NavigationEdgeType
  readonly distance: number
  /** A validated walking polyline; absent for flight or cliff jumps. */
  readonly path?: readonly Point[]
  readonly entryPoint: Point
  readonly exitPoint: Point
  readonly blockerIds: readonly string[]
  readonly destructionHP: number
  readonly mineralAmount: number
  readonly requiredCapabilities: readonly Capability[]
  readonly traversalWidth: number
  /**
   * `always`; `capability` (usable with the required capabilities); `blockers` (usable with the
   * capabilities, and by everyone once all `blockerIds` are gone).
   */
  readonly enabledCondition: 'always' | 'capability' | 'blockers'
}

export interface MapNavigation {
  readonly version: 1
  readonly width: number
  readonly height: number
  readonly regions: readonly GroundRegion[]
  readonly expansions: readonly Expansion[]
  readonly ramps: readonly RampInfo[]
  readonly chokes: readonly ChokeInfo[]
  /** All removable blockers, including ones that do not open a strategic passage. */
  readonly blockers: readonly SpatialBlocker[]
  readonly destructiblePortals: readonly BlockerPortal[]
  readonly mineralPortals: readonly BlockerPortal[]
  readonly cliffPortals: readonly CliffPortal[]
  readonly predropPortals: readonly PreDropPortal[]
  readonly nodes: readonly NavigationNode[]
  readonly edges: readonly NavigationEdge[]
  /** Region cells as `[firstCell, length, regionIndex]` runs (region index 1-based). */
  readonly regionRuns: readonly number[]
  readonly areas: readonly NavigationArea[]
  readonly areaRuns: readonly number[]
  /** Contracted inter-area connections, referencing the full graph's validated edge paths. */
  readonly areaConnections: readonly AreaConnection[]
}

export interface AreaConnection {
  readonly areaA: string
  readonly areaB: string
  readonly type: NavigationEdgeType
  readonly edgeIds: readonly string[]
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const round2 = (value: number) => Math.round(value * 100) / 100
const roundPoint = ([x, y]: Point): Point => [round2(x), round2(y)]
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

const NEIGHBOURS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const NEIGHBOURS_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
] as const

function neighbours(
  size: GridSize,
  cell: number,
  steps: typeof NEIGHBOURS_8 | typeof NEIGHBOURS_4 = NEIGHBOURS_8,
): number[] {
  const x = cell % size.width
  const y = (cell - x) / size.width
  const found: number[] = []
  for (const [dx, dy] of steps)
    if (inside(size, x + dx, y + dy)) found.push((y + dy) * size.width + x + dx)
  return found
}

/** The accepted cell nearest `target` within `radius` (ties: lower cell index). */
function nearestCell(
  size: GridSize,
  target: Point,
  radius: number,
  accept: (cell: number) => boolean,
): number | undefined {
  let best: number | undefined
  let bestDistance = Infinity
  const x0 = Math.max(0, Math.floor(target[0] - radius))
  const x1 = Math.min(size.width - 1, Math.floor(target[0] + radius))
  const y0 = Math.max(0, Math.floor(target[1] - radius))
  const y1 = Math.min(size.height - 1, Math.floor(target[1] + radius))
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      const cell = y * size.width + x
      const d = Math.hypot(x + 0.5 - target[0], y + 0.5 - target[1])
      if (d <= radius && d < bestDistance && accept(cell)) {
        best = cell
        bestDistance = d
      }
    }
  return best
}

function mean(points: readonly Point[]): Point {
  let x = 0
  let y = 0
  for (const point of points) {
    x += point[0]
    y += point[1]
  }
  return [x / points.length, y / points.length]
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

interface Context {
  readonly canStep: (from: number, to: number) => boolean
  readonly data: MapSpatialData
  readonly size: GridSize
  readonly options: NavigationOptions
  /** Walkable now, every blocker in place. */
  readonly walkable: Uint8Array
  readonly clearance: Float64Array
  /** Region index per cell (0 = none). */
  readonly labels: Int32Array
  readonly regionIds: readonly string[]
  /** Full ground distance fields by source cell. */
  readonly fields: Map<number, Float64Array>
}

function groundField(context: Context, source: number): Float64Array {
  let field = context.fields.get(source)
  if (field === undefined) {
    field = distanceField(
      context.size,
      context.walkable,
      [source],
      Infinity,
      undefined,
      undefined,
      context.canStep,
    )
    context.fields.set(source, field)
  }
  return field
}

/** Is there a ground route from `a` to `b` no longer than `limit`? */
function groundWithin(context: Context, a: number, b: number, limit: number): boolean {
  const cached = context.fields.get(a)
  if (cached !== undefined) return cached[b]! <= limit
  return (
    distanceField(
      context.size,
      context.walkable,
      [a],
      limit,
      undefined,
      undefined,
      context.canStep,
    )[b]! <= limit
  )
}

function regionOf(context: Context, cell: number): string | undefined {
  const label = context.labels[cell]!
  return label === 0 ? undefined : context.regionIds[label - 1]
}

/** A region cell near `target` with the wanted clearance, else the roomiest one close by. */
function snapToRegion(
  context: Context,
  target: Point,
  label: number,
  clearance: number,
  radius = 4,
) {
  const inRegion = (cell: number) => context.labels[cell] === label
  return (
    nearestCell(
      context.size,
      target,
      radius,
      cell => inRegion(cell) && context.clearance[cell]! >= clearance,
    ) ?? nearestCell(context.size, target, radius * 3, inRegion)
  )
}

function buildRegions(data: MapSpatialData, walkable: Uint8Array, options: NavigationOptions) {
  const size = { width: data.width, height: data.height }
  const mask = new Uint8Array(walkable.length)
  for (let cell = 0; cell < mask.length; cell += 1)
    if (walkable[cell] === 1 && data.ramp[cell] !== 1) mask[cell] = 1
  const components = labelComponents(size, mask, (a, b) => canGroundStep(data, a, b))
  const remap = new Int32Array(components.count + 1)
  let count = 0
  for (let label = 1; label <= components.count; label += 1)
    if (components.areas[label]! >= options.minRegionArea) remap[label] = ++count
  const labels = new Int32Array(mask.length)
  for (let cell = 0; cell < mask.length; cell += 1) labels[cell] = remap[components.labels[cell]!]!
  return { labels, count, regionIds: Array.from({ length: count }, (_, index) => `R${index + 1}`) }
}

function analyzeRampShapes(context: Context): RampInfo[] {
  const { data, size, labels, options } = context
  if (data.rampShapes !== undefined) {
    const result: RampInfo[] = []
    for (const shape of data.rampShapes) {
      const end = (point: Point, sign: number, wantedLevel?: number) => {
        const target: Point = [
          point[0] + sign * shape.direction[0],
          point[1] + sign * shape.direction[1],
        ]
        const cell = nearestCell(
          size,
          target,
          4,
          next =>
            labels[next]! > 0 &&
            (wantedLevel === undefined || Math.abs(data.level[next]! - wantedLevel) < 0.25) &&
            (centreOf(size, next)[0] - shape.center[0]) * shape.direction[0] * sign +
              (centreOf(size, next)[1] - shape.center[1]) * shape.direction[1] * sign >
              0,
        )
        if (cell === undefined) return undefined
        const label = labels[cell]!
        const entry = centreOf(size, cell)
        const stagingTarget: Point = [
          entry[0] + sign * shape.direction[0] * options.stagingDistance,
          entry[1] + sign * shape.direction[1] * options.stagingDistance,
        ]
        const staged =
          snapToRegion(context, stagingTarget, label, options.stagingClearance, 4) ?? cell
        return { cell, entry, staging: centreOf(size, staged), region: regionOf(context, cell)! }
      }
      const low = end(shape.lower, -1, shape.lowerLevel),
        high = end(shape.upper, 1, shape.upperLevel)
      if (
        low === undefined ||
        high === undefined ||
        Math.abs(data.level[high.cell]! - data.level[low.cell]!) < 0.5
      )
        continue
      const centerCell = nearestCell(
        size,
        shape.center,
        3,
        next => data.terrainWalkable[next] === 1 && data.ramp[next] === 1,
      )
      if (centerCell === undefined) continue
      result.push({
        id: `RAMP${result.length + 1}`,
        center: centreOf(size, centerCell),
        width: round2(shape.width),
        direction: shape.direction,
        lowerRegion: low.region,
        upperRegion: high.region,
        lowerEntry: low.entry,
        upperEntry: high.entry,
        lowerStagingPoint: low.staging,
        upperStagingPoint: high.staging,
      })
    }
    return result
  }
  const mask = new Uint8Array(labels.length)
  for (let cell = 0; cell < mask.length; cell += 1)
    if (context.walkable[cell] === 1 && data.ramp[cell] === 1) mask[cell] = 1
  const components = labelComponents(size, mask)
  const cellsByRamp: number[][] = Array.from({ length: components.count + 1 }, () => [])
  for (let cell = 0; cell < mask.length; cell += 1)
    if (components.labels[cell]! > 0) cellsByRamp[components.labels[cell]!]!.push(cell)
  const ramps: RampInfo[] = []
  for (let label = 1; label <= components.count; label += 1) {
    const cells = cellsByRamp[label]!
    const contacts = new Map<number, Set<number>>()
    for (const cell of cells)
      for (const next of neighbours(size, cell, NEIGHBOURS_4)) {
        const region = labels[next]!
        if (region === 0) continue
        const set = contacts.get(region) ?? new Set<number>()
        set.add(next)
        contacts.set(region, set)
      }
    if (contacts.size < 2) continue
    const levelOf = (region: number) => {
      const list = [...contacts.get(region)!]
      return list.reduce((sum, cell) => sum + data.level[cell]!, 0) / list.length
    }
    const regions = [...contacts.keys()].sort((a, b) => levelOf(a) - levelOf(b) || a - b)
    const lower = regions[0]!
    const upper = regions[regions.length - 1]!
    if (levelOf(upper) - levelOf(lower) < 0.5) continue
    const side = (region: number) => {
      const list = [...contacts.get(region)!].sort((a, b) => a - b)
      const centre = mean(list.map(cell => centreOf(size, cell)))
      const entry = list.reduce((best, cell) =>
        distance(centreOf(size, cell), centre) < distance(centreOf(size, best), centre)
          ? cell
          : best,
      )
      return { list, centre, entry }
    }
    const low = side(lower)
    const high = side(upper)
    const along = [high.centre[0] - low.centre[0], high.centre[1] - low.centre[1]] as const
    const length = Math.hypot(along[0], along[1]) || 1
    const direction: Point = [along[0] / length, along[1] / length]
    const staging = (entry: number, region: number, sign: number) => {
      const [ex, ey] = centreOf(size, entry)
      const target: Point = [
        ex + sign * direction[0] * options.stagingDistance,
        ey + sign * direction[1] * options.stagingDistance,
      ]
      const cell = snapToRegion(context, target, region, options.stagingClearance, 3) ?? entry
      return centreOf(size, cell)
    }
    const centre = mean(cells.map(cell => centreOf(size, cell)))
    const centreCell = cells.reduce((best, cell) =>
      distance(centreOf(size, cell), centre) < distance(centreOf(size, best), centre) ? cell : best,
    )
    ramps.push({
      id: `RAMP${ramps.length + 1}`,
      center: centreOf(size, centreCell),
      width: Math.min(low.list.length, high.list.length),
      direction: roundPoint(direction),
      lowerRegion: context.regionIds[lower - 1]!,
      upperRegion: context.regionIds[upper - 1]!,
      lowerEntry: centreOf(size, low.entry),
      upperEntry: centreOf(size, high.entry),
      lowerStagingPoint: staging(low.entry, lower, -1),
      upperStagingPoint: staging(high.entry, upper, 1),
    })
  }
  return ramps
}

/** Removable blockers of `kind` that close off a passage or a meaningful shortcut. */
function analyzeBlockerPortals(context: Context, blockerKind: BlockerKind): BlockerPortal[] {
  const { data, size, options } = context
  const blockers = data.blockers.filter(
    blocker => blocker.kind === blockerKind && blocker.cells.length > 0,
  )
  if (blockers.length === 0) return []
  // One barrier: blockers whose cells come within the group gap of each other.
  const points: Point[] = []
  const owner: number[] = []
  blockers.forEach((blocker, index) =>
    blocker.cells.forEach(cell => {
      points.push(centreOf(size, cell))
      owner.push(index)
    }),
  )
  const sets = new DisjointSets(blockers.length)
  const hash = new SpatialHash(points, Math.max(1, options.blockerGroupGap + 1))
  points.forEach(([x, y], index) => {
    for (const other of hash.near(x, y, options.blockerGroupGap + 1))
      sets.union(owner[index]!, owner[other]!)
  })
  const kind = blockerKind === 'destructible' ? 'destructible' : 'mineral-wall'
  const portals: BlockerPortal[] = []
  for (const group of sets.groups()) {
    const members = group.map(index => blockers[index]!)
    const ids = new Set(members.map(member => member.id))
    const reopened = walkableMask(data, blocker => !ids.has(blocker.id))
    const freed = new Uint8Array(context.walkable.length)
    for (const blocker of members)
      for (const cell of blocker.cells) if (reopened[cell] === 1) freed[cell] = 1
    const contacts: number[] = []
    const seen = new Set<number>()
    const approaches = new Set<number>()
    for (const blocker of members)
      for (const cell of blocker.cells) {
        if (freed[cell] !== 1) continue
        const queue = neighbours(size, cell, NEIGHBOURS_4)
        for (let head = 0; head < queue.length; head += 1) {
          const next = queue[head]!
          if (freed[next] === 1 || context.walkable[next] !== 1 || seen.has(next)) continue
          seen.add(next)
          if (context.labels[next]! > 0) contacts.push(next)
          else if (data.ramp[next] === 1) {
            approaches.add(next)
            queue.push(...neighbours(size, next, NEIGHBOURS_4))
          }
        }
      }
    contacts.sort((a, b) => a - b)
    if (contacts.length === 0) continue
    // Contact stretches: each is one side of the barrier.
    let clusters = clusterPoints(
      contacts.map(cell => centreOf(size, cell)),
      1.5,
    ).map(indices => indices.map(index => contacts[index]!))
    const freedCells = [...freed.keys()].filter(cell => freed[cell] === 1)
    if (freedCells.length === 0) continue
    const xs = freedCells.map(cell => cell % size.width),
      ys = freedCells.map(cell => Math.floor(cell / size.width))
    const x0 = Math.min(...xs),
      x1 = Math.max(...xs),
      y0 = Math.min(...ys),
      y1 = Math.max(...ys)
    const horizontal = x1 - x0 <= y1 - y0
    const center = mean(freedCells.map(cell => centreOf(size, cell)))
    const cx = Math.floor(center[0]),
      cy = Math.floor(center[1])
    // Width of the terrain corridor through this group, before removable objects.
    let corridorWidth = 1
    for (const sign of [-1, 1])
      for (let step = 1; step <= 17; step += 1) {
        const x = cx + (horizontal ? 0 : step * sign),
          y = cy + (horizontal ? step * sign : 0)
        if (!inside(size, x, y) || data.terrainWalkable[y * size.width + x] !== 1) break
        corridorWidth += 1
      }
    const occupiedWidth = horizontal ? y1 - y0 + 1 : x1 - x0 + 1
    const narrowing =
      corridorWidth <= 16 &&
      occupiedWidth >= corridorWidth * 0.3 &&
      (blockerKind === 'destructible' ||
        members.every(
          member => (member.resources ?? Infinity) < options.expansion.minFieldResources,
        ))
    let localObstruction = false
    if (
      clusters.length < 2 &&
      (blockerKind === 'destructible' ||
        members.every(
          member => (member.resources ?? Infinity) < options.expansion.minFieldResources,
        ))
    ) {
      let xx = 0,
        xy = 0,
        yy = 0
      for (const cell of freedCells) {
        const p = centreOf(size, cell),
          dx = p[0] - center[0],
          dy = p[1] - center[1]
        xx += dx * dx
        xy += dx * dy
        yy += dy * dy
      }
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
      const normal: Point = [-Math.sin(angle), Math.cos(angle)]
      const project = (cell: number) => {
        const p = centreOf(size, cell)
        return (p[0] - center[0]) * normal[0] + (p[1] - center[1]) * normal[1]
      }
      const low = Math.min(...freedCells.map(project)),
        high = Math.max(...freedCells.map(project))
      const sideA = contacts.filter(cell => project(cell) < low - 0.1)
      const sideB = contacts.filter(cell => project(cell) > high + 0.1)
      if (sideA.length > 0 && sideB.length > 0) clusters = [sideA, sideB]
      localObstruction = sideA.length > 0 && sideB.length > 0
    }
    if (clusters.length < 2) continue
    const through = new Uint8Array(context.walkable.length)
    for (let cell = 0; cell < through.length; cell += 1)
      if (freed[cell] === 1 || context.walkable[cell] === 1) through[cell] = 1
    const reps = clusters.map(cluster => {
      const centre = mean(cluster.map(cell => centreOf(size, cell)))
      return cluster.reduce((best, cell) =>
        distance(centreOf(size, cell), centre) < distance(centreOf(size, best), centre)
          ? cell
          : best,
      )
    })
    const best = new Map<string, BlockerPortal>()
    // Crossing through the freed cells only (plus the contacts themselves).
    const crossingMask = freed.slice()
    for (const cell of approaches) crossingMask[cell] = 1
    for (const cluster of clusters) for (const cell of cluster) crossingMask[cell] = 1
    for (let i = 0; i < clusters.length; i += 1) {
      const across = distanceField(
        size,
        crossingMask,
        [reps[i]!],
        Infinity,
        undefined,
        undefined,
        context.canStep,
      )
      for (let j = i + 1; j < clusters.length; j += 1) {
        const crossing = across[reps[j]!]!
        if (!Number.isFinite(crossing)) continue
        const limit = crossing * options.shortcutRatio + options.minShortcutSaving
        const shortcut = !groundWithin(context, reps[i]!, reps[j]!, limit)
        const localSaving =
          localObstruction && !groundWithin(context, reps[i]!, reps[j]!, crossing * 1.15 + 0.5)
        if (!shortcut && !narrowing && !localSaving) continue
        const labelA = context.labels[reps[i]!]!
        const labelB = context.labels[reps[j]!]!
        const ground = groundField(context, reps[i]!)[reps[j]!]!
        const [a, b] = labelA <= labelB ? [i, j] : [j, i]
        const regionA = regionOf(context, reps[a]!)!
        const regionB = regionOf(context, reps[b]!)!
        const entry = (index: number) =>
          centreOf(
            size,
            snapToRegion(
              context,
              centreOf(size, reps[index]!),
              context.labels[reps[index]!]!,
              1.5,
              2,
            ) ?? reps[index]!,
          )
        const entryA = entry(a),
          entryB = entry(b)
        const cellA = Math.floor(entryA[1]) * size.width + Math.floor(entryA[0])
        const cellB = Math.floor(entryB[1]) * size.width + Math.floor(entryB[0])
        const restoredField = distanceField(
          size,
          through,
          [cellA],
          Infinity,
          undefined,
          undefined,
          context.canStep,
        )
        const walked = restoredField[cellB]!
        if (!Number.isFinite(walked)) continue
        const path = descend(size, restoredField, cellB, undefined, context.canStep)
          .reverse()
          .map(cell => centreOf(size, cell))
        const life = members.reduce((sum, blocker) => sum + (blocker.life ?? 0), 0)
        const resources = members.reduce((sum, blocker) => sum + (blocker.resources ?? 0), 0)
        const portal: BlockerPortal = {
          id: '',
          kind,
          blockerIds: members.map(blocker => blocker.id),
          regionA,
          regionB,
          entryA,
          entryB,
          path,
          crossing: round2(Number.isFinite(walked) ? walked : crossing),
          groundDistance: Number.isFinite(ground) ? round2(ground) : null,
          connectsNewly: !Number.isFinite(ground),
          width: Math.min(clusters[i]!.length, clusters[j]!.length),
          ...(!shortcut ? { partial: true } : {}),
          ...(kind === 'destructible' && members.some(blocker => blocker.life !== undefined)
            ? { totalLife: life }
            : {}),
          ...(members.some(blocker => blocker.resources !== undefined)
            ? { totalResources: resources }
            : {}),
        }
        const key = `${regionA}|${regionB}`
        const saving = (ground: number | null, value: number) => (ground ?? Infinity) - value
        const previous = best.get(key)
        if (
          previous === undefined ||
          saving(portal.groundDistance, portal.crossing) >
            saving(previous.groundDistance, previous.crossing)
        )
          best.set(key, portal)
      }
    }
    portals.push(...best.values())
  }
  const prefix = kind === 'destructible' ? 'D' : 'M'
  return portals.map((portal, index) => ({ ...portal, id: `${prefix}${index + 1}` }))
}

interface ResourceCluster {
  readonly minerals: SpatialBlocker[]
  readonly geysers: SpatialBlocker[]
}

function resourceClusters(data: MapSpatialData, options: NavigationOptions): ResourceCluster[] {
  const minerals = data.blockers.filter(blocker => blocker.kind === 'mineral')
  const fullest = Math.max(0, ...minerals.map(blocker => blocker.resources ?? 0))
  const fields = minerals.filter(
    blocker =>
      blocker.resources === undefined ||
      (blocker.resources >= fullest * options.expansion.depletedShare &&
        blocker.resources >= options.expansion.minFieldResources),
  )
  const clusters = clusterPoints(
    fields.map(blocker => [blocker.x, blocker.y] as const),
    options.expansion.mineralLink,
  )
    .map(indices => ({
      minerals: indices.map(index => fields[index]!),
      geysers: [] as SpatialBlocker[],
    }))
    .filter(cluster => cluster.minerals.length >= options.expansion.minMinerals)
  for (const geyser of data.blockers.filter(blocker => blocker.kind === 'geyser')) {
    let best: ResourceCluster | undefined
    let bestDistance = options.expansion.geyserLink
    for (const cluster of clusters) {
      const d = Math.min(
        ...cluster.minerals.map(mineral => Math.hypot(mineral.x - geyser.x, mineral.y - geyser.y)),
      )
      if (d <= bestDistance) {
        best = cluster
        bestDistance = d
      }
    }
    best?.geysers.push(geyser)
  }
  return clusters
}

function analyzeExpansions(context: Context): Omit<Expansion, 'access'>[] {
  const { data, size, options } = context
  const hall = options.expansion.hallSize
  const half = Math.floor(hall / 2)
  const allResources = new Uint8Array(context.walkable.length)
  for (const blocker of data.blockers)
    if (blocker.kind === 'mineral' || blocker.kind === 'geyser')
      for (const cell of blocker.cells) allResources[cell] = 1
  const workerGround = new Uint8Array(context.walkable.length)
  for (let cell = 0; cell < workerGround.length; cell += 1)
    if (data.terrainWalkable[cell] === 1 && allResources[cell] !== 1) workerGround[cell] = 1
  const expansions: Omit<Expansion, 'access'>[] = []
  for (const cluster of resourceClusters(data, options)) {
    const resources = [...cluster.minerals, ...cluster.geysers]
    const centre = mean(resources.map(blocker => [blocker.x, blocker.y] as const))
    const excluded = new Uint8Array(context.walkable.length)
    for (const blocker of resources)
      for (const cell of [...blocker.cells, ...(blocker.nearResourceCells ?? [])])
        excluded[cell] = 1
    const reach = options.expansion.searchRadius * 2 + hall
    const fieldsByResource = resources.map(blocker => {
      const sources = new Set<number>()
      for (const cell of blocker.cells)
        for (const next of neighbours(size, cell)) if (workerGround[next] === 1) sources.add(next)
      return distanceField(
        size,
        workerGround,
        [...sources].sort((a, b) => a - b),
        reach,
        undefined,
        undefined,
        context.canStep,
      )
    })
    const fits = (cx: number, cy: number) => {
      for (let dy = -half; dy < hall - half; dy += 1)
        for (let dx = -half; dx < hall - half; dx += 1) {
          const x = cx + dx
          const y = cy + dy
          if (!inside(size, x, y)) return false
          const cell = y * size.width + x
          if (data.terrainBuildable[cell] !== 1 || excluded[cell] === 1) return false
        }
      return true
    }
    let bestCell: number | undefined
    let bestScore = Infinity
    const radius = options.expansion.searchRadius
    for (let cy = Math.floor(centre[1] - radius); cy <= Math.floor(centre[1] + radius); cy += 1)
      for (let cx = Math.floor(centre[0] - radius); cx <= Math.floor(centre[0] + radius); cx += 1) {
        if (
          !inside(size, cx, cy) ||
          Math.hypot(cx + 0.5 - centre[0], cy + 0.5 - centre[1]) > radius
        )
          continue
        if (!fits(cx, cy)) continue
        // Worker trips: from the ring of cells around the hall to each resource.
        let score = 0
        for (let r = 0; r < resources.length && score < Infinity; r += 1) {
          let nearest = Infinity
          for (let dy = -half - 1; dy <= hall - half; dy += 1)
            for (let dx = -half - 1; dx <= hall - half; dx += 1) {
              const onRing =
                dy === -half - 1 || dy === hall - half || dx === -half - 1 || dx === hall - half
              if (!onRing || !inside(size, cx + dx, cy + dy)) continue
              nearest = Math.min(nearest, fieldsByResource[r]![(cy + dy) * size.width + cx + dx]!)
            }
          const weight = resources[r]!.kind === 'geyser' ? options.expansion.geyserWeight : 1
          score += nearest * weight
        }
        if (score < bestScore) {
          bestScore = score
          bestCell = cy * size.width + cx
        }
      }
    const minerals = cluster.minerals.reduce((sum, blocker) => sum + (blocker.resources ?? 0), 0)
    const gas = cluster.geysers.reduce((sum, blocker) => sum + (blocker.resources ?? 0), 0)
    const base = {
      mineralIds: cluster.minerals.map(blocker => blocker.id),
      geyserIds: cluster.geysers.map(blocker => blocker.id),
      minerals,
      gas,
    }
    if (bestCell === undefined) {
      const cell = Math.floor(centre[1]) * size.width + Math.floor(centre[0])
      expansions.push({
        id: '',
        position: roundPoint(centre),
        regionId: regionOf(context, cell) ?? null,
        placementState: 'INVALID',
        placementBlockers: [],
        ...base,
      })
      continue
    }
    const cx = bestCell % size.width
    const cy = (bestCell - cx) / size.width
    const footprint = new Set<number>()
    for (let dy = -half; dy < hall - half; dy += 1)
      for (let dx = -half; dx < hall - half; dx += 1)
        footprint.add((cy + dy) * size.width + cx + dx)
    const own = new Set(resources.map(blocker => blocker.id))
    const blocking = data.blockers.filter(
      blocker =>
        !own.has(blocker.id) &&
        [...blocker.cells, ...blocker.placementCells, ...(blocker.nearResourceCells ?? [])].some(
          cell => footprint.has(cell),
        ),
    )
    const placementState: PlacementState = blocking.some(blocker => blocker.kind === 'destructible')
      ? 'BLOCKED_BY_DESTRUCTIBLE'
      : blocking.some(blocker => blocker.kind === 'mineral' || blocker.kind === 'geyser')
        ? 'BLOCKED_BY_MINERALS'
        : blocking.some(blocker => blocker.kind === 'neutral')
          ? 'BLOCKED_BY_NEUTRAL'
          : 'AVAILABLE'
    const position: Point = [cx + (hall % 2 === 1 ? 0.5 : 0), cy + (hall % 2 === 1 ? 0.5 : 0)]
    const regionCell =
      context.labels[bestCell]! > 0
        ? bestCell
        : nearestCell(size, position, hall, cell => context.labels[cell]! > 0)
    const startLocation = data.startLocations.findIndex(start => distance(start, position) <= 3)
    expansions.push({
      id: '',
      position,
      regionId: regionCell === undefined ? null : regionOf(context, regionCell)!,
      placementState,
      placementBlockers: blocking.map(blocker => blocker.id),
      ...base,
      ...(startLocation < 0 ? {} : { startLocation }),
    })
  }
  return expansions.map((expansion, index) => ({ ...expansion, id: `E${index + 1}` }))
}

function analyzeCliffPortals(context: Context): CliffPortal[] {
  const { data, size, options, labels } = context
  interface Candidate {
    readonly a: number
    readonly b: number
    readonly crossing: number
    readonly mid: Point
  }
  const candidates: Candidate[] = []
  // A mixed-height fringe can attach a tiny low ledge to the upper ground component. Do not
  // mistake that ledge for the landing plateau: snap to connected ground at the expected level.
  const plateauMask = Uint8Array.from(labels, (label, cell) =>
    label > 0 && Math.abs(data.level[cell]! - Math.round(data.level[cell]!)) < 0.25 ? 1 : 0,
  )
  const plateaus = labelComponents(
    size,
    plateauMask,
    (a, b) => Math.round(data.level[a]!) === Math.round(data.level[b]!),
  )
  const landingAt = (position: Point, level: number) =>
    nearestCell(
      size,
      position,
      Math.max(2, options.cliff.maxGap),
      cell =>
        labels[cell]! > 0 &&
        Math.abs(data.level[cell]! - level) < 0.25 &&
        plateaus.areas[plateaus.labels[cell]!]! >= options.minRegionArea,
    )
  for (const crossing of data.cliffCrossings ?? []) {
    const a = landingAt(crossing.a, crossing.levelA)
    const b = landingAt(crossing.b, crossing.levelB)
    if (a === undefined || b === undefined || a === b) continue
    if (distance(centreOf(size, a), centreOf(size, b)) > options.cliff.maxGap + 2) continue
    const [p, q] = labels[a]! <= labels[b]! ? [a, b] : [b, a]
    candidates.push({
      a: p,
      b: q,
      crossing: distance(centreOf(size, p), centreOf(size, q)),
      mid: mean([crossing.a, crossing.b]),
    })
  }
  for (let a = 0; data.cliffCrossings === undefined && a < labels.length; a += 1) {
    const labelA = labels[a]!
    if (labelA === 0) continue
    const x = a % size.width
    const y = (a - x) / size.width
    for (const [dx, dy] of NEIGHBOURS_8) {
      let cliffSeen = false
      for (let k = 1; k <= options.cliff.maxGap + 1; k += 1) {
        const nx = x + dx * k
        const ny = y + dy * k
        if (!inside(size, nx, ny)) break
        const cell = ny * size.width + nx
        if (context.walkable[cell] === 1) {
          const labelB = labels[cell]!
          // Each unordered pair once, from its lower region.
          if (
            k > 1 &&
            cliffSeen &&
            labelB >= labelA &&
            Math.abs(Math.abs(data.level[cell]! - data.level[a]!) - 1) < 0.25
          )
            candidates.push({
              a,
              b: cell,
              crossing: k * Math.hypot(dx, dy),
              mid: [x + 0.5 + (dx * k) / 2, y + 0.5 + (dy * k) / 2],
            })
          break
        }
        if (data.terrainWalkable[cell] === 1) break // a blocker, not a cliff
        if (data.cliff[cell] === 1) cliffSeen = true
        else if (!(options.cliff.crossesPainted && data.painted[cell] === 1)) break
      }
    }
  }
  // Group by region pair and place, then cut long cliffs into portal-sized pieces.
  const byPair = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const key = `${labels[candidate.a]}|${labels[candidate.b]}`
    const list = byPair.get(key)
    if (list === undefined) byPair.set(key, [candidate])
    else list.push(candidate)
  }
  const portals: Omit<CliffPortal, 'id'>[] = []
  for (const [, list] of [...byPair].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const remaining = [...list]
    const chosen: Candidate[] = []
    while (remaining.length > 0) {
      const seed = remaining[0]!
      const chunk = remaining.filter(
        item => distance(item.mid, seed.mid) <= options.cliff.maxPortalWidth / 2,
      )
      const chunkSet = new Set(chunk)
      for (let index = remaining.length - 1; index >= 0; index -= 1)
        if (chunkSet.has(remaining[index]!)) remaining.splice(index, 1)
      const centre = mean(chunk.map(item => item.mid))
      const rep = chunk.reduce((best, item) => {
        const score = item.crossing + distance(item.mid, centre)
        const bestScore = best.crossing + distance(best.mid, centre)
        return score < bestScore ? item : best
      })
      if (chosen.some(item => distance(item.mid, rep.mid) < options.cliff.minSpacing)) continue
      // Geometry remains available even beside a ramp; the route planner decides its value.
      chosen.push(rep)
      portals.push({
        regionA: regionOf(context, rep.a)!,
        regionB: regionOf(context, rep.b)!,
        entryA: centreOf(size, rep.a),
        entryB: centreOf(size, rep.b),
        cliffLevelDelta: Math.round(Math.abs(data.level[rep.b]! - data.level[rep.a]!)),
        width: new Set(chunk.map(item => item.a)).size,
        crossing: round2(rep.crossing),
      })
    }
  }
  return portals.map((portal, index) => ({ id: `C${index + 1}`, ...portal }))
}

/** Centres of narrow cross-sections with roomy approach terrain on both ends. */
function analyzeChokes(context: Context): ChokeInfo[] {
  const { size, labels, clearance, data, options } = context
  const coreMask = Uint8Array.from(labels, (label, cell) =>
    label > 0 && clearance[cell]! >= options.choke.roomClearance ? 1 : 0,
  )
  const cores = labelComponents(
    size,
    coreMask,
    (a, b) => context.labels[a] === context.labels[b] && context.canStep(a, b),
  )
  const owners = new Int32Array(labels.length)
  const queue: number[] = []
  const roomCells = new Map<number, number[]>()
  for (let cell = 0; cell < labels.length; cell += 1) {
    const core = cores.labels[cell]!
    if (core === 0 || cores.areas[core]! < options.choke.minRoomArea) continue
    owners[cell] = core
    queue.push(cell)
    const cells = roomCells.get(core) ?? []
    cells.push(cell)
    roomCells.set(core, cells)
  }
  // Expand roomy interiors to a watershed in linear time, including diagonal corridors.
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head]!
    for (const next of neighbours(size, cell, NEIGHBOURS_4))
      if (labels[next] === labels[cell] && owners[next] === 0) {
        owners[next] = owners[cell]!
        queue.push(next)
      }
  }
  const resourceMargin = new Uint8Array(labels.length)
  for (const blocker of data.blockers)
    if (blocker.kind === 'mineral' || blocker.kind === 'geyser')
      for (const cell of blocker.cells) {
        const x = cell % size.width,
          y = Math.floor(cell / size.width)
        for (let dy = -3; dy <= 3; dy += 1)
          for (let dx = -3; dx <= 3; dx += 1)
            if (inside(size, x + dx, y + dy)) resourceMargin[(y + dy) * size.width + x + dx] = 1
      }
  const seams = new Map<string, number[]>()
  for (let cell = 0; cell < owners.length; cell += 1) {
    if (
      owners[cell] === 0 ||
      resourceMargin[cell] === 1 ||
      clearance[cell]! * 2 - 1 > options.choke.maxWidth
    )
      continue
    for (const next of neighbours(size, cell, NEIGHBOURS_4)) {
      if (owners[next] === 0 || owners[next] === owners[cell] || labels[next] !== labels[cell])
        continue
      const key = [owners[cell]!, owners[next]!].sort((a, b) => a - b).join('|')
      const seam = seams.get(key) ?? []
      seam.push(cell)
      seams.set(key, seam)
    }
  }
  const chokes: ChokeInfo[] = []
  for (const [key, cells] of seams) {
    const [roomA, roomB] = key.split('|').map(Number)
    for (const cluster of clusterPoints(
      cells.map(cell => centreOf(size, cell)),
      1.5,
    )) {
      const center = mean(cluster.map(i => centreOf(size, cells[i]!)))
      const cell = cluster
        .map(i => cells[i]!)
        .sort(
          (a, b) =>
            clearance[b]! - clearance[a]! ||
            distance(centreOf(size, a), center) - distance(centreOf(size, b), center),
        )[0]!
      const entry = (room: number) =>
        roomCells
          .get(room)!
          .reduce((best, next) =>
            distance(centreOf(size, next), centreOf(size, cell)) <
            distance(centreOf(size, best), centreOf(size, cell))
              ? next
              : best,
          )
      chokes.push({
        id: `CHOKE${chokes.length + 1}`,
        center: centreOf(size, cell),
        entryA: centreOf(size, entry(roomA!)),
        entryB: centreOf(size, entry(roomB!)),
        regionId: regionOf(context, cell)!,
        width: round2(clearance[cell]! * 2 - 1),
      })
    }
  }
  return chokes
}

function analyzePreDrops(context: Context): PreDropPortal[] {
  const { size, options, labels, clearance } = context
  const settings = options.preDrop
  // Landing samples: region cells just inside the edge with enough room, one per bucket.
  const samples: number[] = []
  const buckets = new Set<string>()
  for (let cell = 0; cell < labels.length; cell += 1) {
    const label = labels[cell]!
    const room = clearance[cell]!
    if (label === 0 || room < settings.landingClearance || room >= settings.landingClearance + 1)
      continue
    const x = cell % size.width
    const y = (cell - x) / size.width
    const key = `${label}:${Math.floor(x / settings.sampleSpacing)},${Math.floor(y / settings.sampleSpacing)}`
    if (buckets.has(key)) continue
    buckets.add(key)
    samples.push(cell)
  }
  const points = samples.map(cell => centreOf(size, cell))
  const hash = new SpatialHash(points, settings.maxAirDistance)
  const limit = settings.maxAirDistance * settings.minRatio + settings.minSaving
  interface Pair {
    readonly a: number
    readonly b: number
    readonly air: number
  }
  const pairs: Pair[] = []
  points.forEach(([x, y], i) => {
    const partners = hash.near(x, y, settings.maxAirDistance).filter(j => j > i)
    if (partners.length === 0) return
    const field = distanceField(
      size,
      context.walkable,
      [samples[i]!],
      limit,
      undefined,
      undefined,
      context.canStep,
    )
    for (const j of partners) {
      const air = distance(points[i]!, points[j]!)
      if (air < settings.minAirDistance) continue
      const ground = field[samples[j]!]!
      const useful =
        !Number.isFinite(ground) ||
        (ground >= air * settings.minRatio && ground - air >= settings.minSaving)
      if (useful) pairs.push({ a: samples[i]!, b: samples[j]!, air })
    }
  })
  // One portal per bundle of pairs with both ends close together, a few per region pair.
  const byPair = new Map<string, Pair[]>()
  for (const pair of pairs) {
    const [la, lb] = [labels[pair.a]!, labels[pair.b]!]
    const oriented = la <= lb ? pair : { a: pair.b, b: pair.a, air: pair.air }
    const key = `${Math.min(la, lb)}|${Math.max(la, lb)}`
    const list = byPair.get(key)
    if (list === undefined) byPair.set(key, [oriented])
    else list.push(oriented)
  }
  const portals: Omit<PreDropPortal, 'id'>[] = []
  for (const [, list] of [...byPair].sort(([a], [b]) => {
    const [a1, a2] = a.split('|').map(Number)
    const [b1, b2] = b.split('|').map(Number)
    return a1! - b1! || a2! - b2!
  })) {
    const sorted = [...list].sort((p, q) => p.air - q.air || p.a - q.a || p.b - q.b)
    const kept: Pair[] = []
    for (const pair of sorted) {
      if (kept.length >= settings.maxPerRegionPair) break
      const near = kept.some(
        other =>
          distance(centreOf(size, other.a), centreOf(size, pair.a)) <= settings.clusterRadius ||
          distance(centreOf(size, other.b), centreOf(size, pair.b)) <= settings.clusterRadius,
      )
      if (near) continue
      kept.push(pair)
      const ground = groundField(context, pair.a)[pair.b]!
      const a = centreOf(size, pair.a)
      const b = centreOf(size, pair.b)
      portals.push({
        regionA: regionOf(context, pair.a)!,
        regionB: regionOf(context, pair.b)!,
        pickupA: a,
        dropB: b,
        pickupB: b,
        dropA: a,
        airDistance: round2(pair.air),
        groundDistance: Number.isFinite(ground) ? round2(ground) : null,
        groundShortcutRatio: Number.isFinite(ground) ? round2(ground / pair.air) : null,
        landingClearance: round2(Math.min(clearance[pair.a]!, clearance[pair.b]!)),
      })
    }
  }
  return portals.map((portal, index) => ({ id: `P${index + 1}`, ...portal }))
}

// ---------------------------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------------------------

const MODE_EDGES: Readonly<Record<keyof Access, readonly NavigationEdgeType[]>> = {
  ground: ['GROUND', 'RAMP'],
  afterDestructibles: ['GROUND', 'RAMP', 'DESTRUCTIBLE'],
  afterMineralWall: ['GROUND', 'RAMP', 'MINERAL_WALL'],
  cliffWalker: ['GROUND', 'RAMP', 'CLIFF'],
  preDrop: ['GROUND', 'RAMP', 'PREDROP'],
}

export function analyzeMapNavigation(
  data: MapSpatialData,
  input?: NavigationOptionsInput,
): MapNavigation {
  const options = resolveOptions(input)
  const size: GridSize = { width: data.width, height: data.height }
  const walkable = walkableMask(data)
  const regions = buildRegions(data, walkable, options)
  const context: Context = {
    canStep: (a, b) => canGroundStep(data, a, b),
    data,
    size,
    options,
    walkable,
    clearance: clearanceField(size, walkable),
    labels: regions.labels,
    regionIds: regions.regionIds,
    fields: new Map(),
  }

  const regionCells: number[][] = Array.from({ length: regions.count + 1 }, () => [])
  for (let cell = 0; cell < regions.labels.length; cell += 1)
    if (regions.labels[cell]! > 0) regionCells[regions.labels[cell]!]!.push(cell)

  const ramps = analyzeRampShapes(context)
  const chokes = analyzeChokes(context)
  const destructiblePortals = analyzeBlockerPortals(context, 'destructible')
  const mineralPortals = analyzeBlockerPortals(context, 'mineral')
  const expansionShapes = analyzeExpansions(context)
  const cliffPortals = analyzeCliffPortals(context)
  const predropPortals = analyzePreDrops(context)
  const areaSeeds: AreaSeed[] = []
  for (const expansion of expansionShapes) {
    const cell = nearestCell(
      size,
      expansion.position,
      options.expansion.hallSize,
      next => regionOf(context, next) === expansion.regionId,
    )
    if (cell !== undefined) areaSeeds.push({ cell, expansionId: expansion.id })
  }
  for (const point of chokes.flatMap(choke => [choke.entryA, choke.entryB])) {
    const cell = nearestCell(size, point, 2, next => regions.labels[next]! > 0)
    if (cell !== undefined) areaSeeds.push({ cell })
  }
  // A shortcut inside one physical component still needs two strategic approaches. Otherwise
  // both endpoints collapse to one hub and its capability edge is just an unusable positive loop.
  for (const portal of cliffPortals)
    if (portal.regionA === portal.regionB)
      for (const point of [portal.entryA, portal.entryB]) {
        const cell = nearestCell(size, point, 2, next => regionOf(context, next) === portal.regionA)
        if (cell !== undefined) areaSeeds.push({ cell })
      }
  const partition = partitionNavigationAreas(
    size,
    regions.labels,
    regions.regionIds,
    areaSeeds,
    options.area,
    context.canStep,
  )
  const areaConnections: AreaConnection[] = []
  const hubId = (area: NavigationArea) => area.expansionId ?? area.id

  // Nodes: region centres, then everything that stands in a region.
  const nodes: NavigationNode[] = []
  const regionCentre = regionCells.slice(1).map((cells, index) => {
    const centre = mean(cells.map(cell => centreOf(size, cell)))
    const cell = snapToRegion(context, centre, index + 1, 2, 6) ?? cells[0]!
    return cell
  })
  regions.regionIds.forEach((id, index) =>
    nodes.push({ id, type: 'REGION', position: centreOf(size, regionCentre[index]!), region: id }),
  )
  for (const expansion of expansionShapes)
    nodes.push({
      id: expansion.id,
      type: 'EXPANSION',
      position: expansion.position,
      region: expansion.regionId,
      ref: expansion.id,
    })
  for (const area of partition.areas)
    if (area.expansionId === undefined)
      nodes.push({
        id: area.id,
        type: 'AREA',
        position: area.center,
        region: area.regionId,
        area: area.id,
      })
  for (const ramp of ramps) {
    nodes.push({ id: ramp.id, type: 'RAMP', position: ramp.center, region: null, ref: ramp.id })
    nodes.push({
      id: `${ramp.id}:lower`,
      type: 'STAGING_POINT',
      position: ramp.lowerStagingPoint,
      region: ramp.lowerRegion,
      ref: ramp.id,
    })
    nodes.push({
      id: `${ramp.id}:upper`,
      type: 'STAGING_POINT',
      position: ramp.upperStagingPoint,
      region: ramp.upperRegion,
      ref: ramp.id,
    })
  }
  for (const choke of chokes)
    nodes.push({
      id: choke.id,
      type: 'CHOKE',
      position: choke.center,
      region: choke.regionId,
      ref: choke.id,
    })
  const portalNodes = (
    id: string,
    type: NavigationNodeType,
    a: Point,
    regionA: string,
    b: Point,
    regionB: string,
  ) => {
    nodes.push({ id: `${id}:a`, type, position: a, region: regionA, ref: id })
    nodes.push({ id: `${id}:b`, type, position: b, region: regionB, ref: id })
  }
  for (const portal of destructiblePortals)
    portalNodes(
      portal.id,
      'DESTRUCTIBLE_PORTAL',
      portal.entryA,
      portal.regionA,
      portal.entryB,
      portal.regionB,
    )
  for (const portal of mineralPortals)
    portalNodes(
      portal.id,
      'MINERAL_PORTAL',
      portal.entryA,
      portal.regionA,
      portal.entryB,
      portal.regionB,
    )
  for (const portal of cliffPortals)
    portalNodes(
      portal.id,
      'CLIFF_PORTAL',
      portal.entryA,
      portal.regionA,
      portal.entryB,
      portal.regionB,
    )
  for (const portal of predropPortals)
    portalNodes(
      portal.id,
      'PREDROP_PORTAL',
      portal.pickupA,
      portal.regionA,
      portal.dropB,
      portal.regionB,
    )

  const edges: NavigationEdge[] = []
  const addEdge = (edge: Omit<NavigationEdge, 'id'>) => {
    const value = { id: `G${edges.length + 1}`, ...edge }
    edges.push(value)
    return value
  }
  const nodeCells = new Map<string, number>()
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!
    if (node.region === null) continue
    let cell = nearestCell(
      size,
      node.position,
      options.expansion.hallSize,
      next => regionOf(context, next) === node.region && partition.labels[next]! > 0,
    )
    if (cell === undefined) continue
    const area = partition.areas[partition.labels[cell]! - 1]!
    if (node.type === 'REGION') {
      cell = Math.floor(area.center[1]) * size.width + Math.floor(area.center[0])
      nodes[i] = { ...node, position: area.center, area: area.id }
      regionCentre[regions.regionIds.indexOf(node.id)] = cell
    } else nodes[i] = { ...node, area: area.id }
    nodeCells.set(node.id, cell)
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const plain = {
    blockerIds: [],
    destructionHP: 0,
    mineralAmount: 0,
    requiredCapabilities: [],
    enabledCondition: 'always',
  } as const

  const localEdges = new Map<string, string>()
  const costs = Float32Array.from(context.clearance, value => 1 + 2 / Math.max(1, value))
  const walkingEdge = (
    from: NavigationNode,
    to: NavigationNode,
    mask: Uint8Array,
    field?: Float64Array,
  ) => {
    const source = nodeCells.get(from.id),
      target = nodeCells.get(to.id)
    if (source === undefined || target === undefined) return undefined
    const distances =
      field ?? distanceField(size, mask, [source], Infinity, costs, undefined, context.canStep)
    if (!Number.isFinite(distances[target]!)) return undefined
    const cells = descend(size, distances, target, costs, context.canStep).reverse()
    if (cells[0] !== source) return undefined
    const path = cells.map(cell => centreOf(size, cell))
    let length = 0
    for (let k = 1; k < path.length; k += 1) length += distance(path[k - 1]!, path[k]!)
    return addEdge({
      from: from.id,
      to: to.id,
      type: 'GROUND',
      distance: round2(length),
      path,
      entryPoint: from.position,
      exitPoint: to.position,
      traversalWidth: round2(Math.min(...cells.map(cell => context.clearance[cell]!)) * 2 - 1),
      ...plain,
    })
  }
  // Only local spokes to an area's representative; no complete/nearest-neighbour base mesh.
  for (let index = 0; index < partition.areas.length; index += 1) {
    const area = partition.areas[index]!
    const hub = byId.get(hubId(area))!
    const anchors = nodes.filter(node => node.area === area.id && node.id !== hub.id)
    const mask = new Uint8Array(walkable.length)
    for (let cell = 0; cell < mask.length; cell += 1)
      if (partition.labels[cell] === index + 1) mask[cell] = 1
    const field = distanceField(
      size,
      mask,
      [nodeCells.get(hub.id)!],
      Infinity,
      costs,
      undefined,
      context.canStep,
    )
    for (const anchor of anchors) {
      const edge = walkingEdge(hub, anchor, mask, field)
      if (edge !== undefined) localEdges.set(anchor.id, edge.id)
    }
  }
  const areaPairs = new Map<string, readonly [number, number]>()
  for (let cell = 0; cell < partition.labels.length; cell += 1)
    for (const next of neighbours(size, cell, NEIGHBOURS_4)) {
      const a = partition.labels[cell]!,
        b = partition.labels[next]!
      if (a === 0 || b <= a || regions.labels[cell] !== regions.labels[next]) continue
      areaPairs.set(`${a}|${b}`, [a, b])
    }
  for (const [a, b] of areaPairs.values()) {
    const areaA = partition.areas[a - 1]!,
      areaB = partition.areas[b - 1]!
    const mask = Uint8Array.from(partition.labels, label => (label === a || label === b ? 1 : 0))
    const edge = walkingEdge(byId.get(hubId(areaA))!, byId.get(hubId(areaB))!, mask)
    if (edge !== undefined)
      areaConnections.push({ areaA: areaA.id, areaB: areaB.id, type: 'GROUND', edgeIds: [edge.id] })
  }

  for (const ramp of ramps) {
    const centre = Math.floor(ramp.center[1]) * size.width + Math.floor(ramp.center[0])
    const field = groundField(context, centre)
    for (const end of ['lower', 'upper'] as const) {
      const staging = byId.get(`${ramp.id}:${end}`)!
      const cell = Math.floor(staging.position[1]) * size.width + Math.floor(staging.position[0])
      const walked = field[cell]!
      if (!Number.isFinite(walked)) continue
      const path = descend(size, field, cell, undefined, context.canStep).map(next =>
        centreOf(size, next),
      )
      addEdge({
        from: staging.id,
        to: ramp.id,
        type: 'RAMP',
        distance: round2(
          Number.isFinite(walked) ? walked : distance(staging.position, ramp.center),
        ),
        entryPoint: staging.position,
        exitPoint: ramp.center,
        traversalWidth: ramp.width,
        path,
        ...plain,
      })
    }
  }
  for (const [portals, type, capability] of [
    [destructiblePortals, 'DESTRUCTIBLE', 'destroy'],
    [mineralPortals, 'MINERAL_WALL', 'mine'],
  ] as const)
    for (const portal of portals)
      addEdge({
        from: `${portal.id}:a`,
        to: `${portal.id}:b`,
        type,
        distance: portal.crossing,
        ...(portal.path === undefined ? {} : { path: portal.path }),
        entryPoint: portal.entryA,
        exitPoint: portal.entryB,
        blockerIds: portal.blockerIds,
        destructionHP: type === 'DESTRUCTIBLE' ? (portal.totalLife ?? 0) : 0,
        mineralAmount: type === 'MINERAL_WALL' ? (portal.totalResources ?? 0) : 0,
        requiredCapabilities: [capability],
        traversalWidth: portal.width,
        enabledCondition: 'blockers',
      })
  for (const portal of cliffPortals)
    addEdge({
      from: `${portal.id}:a`,
      to: `${portal.id}:b`,
      type: 'CLIFF',
      distance: portal.crossing,
      entryPoint: portal.entryA,
      exitPoint: portal.entryB,
      blockerIds: [],
      destructionHP: 0,
      mineralAmount: 0,
      requiredCapabilities: ['cliff'],
      traversalWidth: portal.width,
      enabledCondition: 'capability',
    })
  for (const portal of predropPortals)
    addEdge({
      from: `${portal.id}:a`,
      to: `${portal.id}:b`,
      type: 'PREDROP',
      distance: portal.airDistance,
      entryPoint: portal.pickupA,
      exitPoint: portal.dropB,
      blockerIds: [],
      destructionHP: 0,
      mineralAmount: 0,
      requiredCapabilities: ['transport'],
      traversalWidth: round2(portal.landingClearance * 2),
      enabledCondition: 'capability',
    })

  const connection = (
    type: NavigationEdgeType,
    from: string,
    to: string,
    crossingEdges: readonly string[],
  ) => {
    const areaA = byId.get(from)?.area,
      areaB = byId.get(to)?.area
    if (areaA === undefined || areaB === undefined || areaA === areaB) return
    areaConnections.push({
      areaA,
      areaB,
      type,
      edgeIds: [
        ...(localEdges.has(from) ? [localEdges.get(from)!] : []),
        ...crossingEdges,
        ...(localEdges.has(to) ? [localEdges.get(to)!] : []),
      ],
    })
  }
  for (const edge of edges)
    if (edge.type !== 'GROUND' && edge.type !== 'RAMP')
      connection(edge.type, edge.from, edge.to, [edge.id])
  for (const ramp of ramps) {
    const ends = edges.filter(edge => edge.type === 'RAMP' && edge.to === ramp.id)
    const low = ends.find(edge => edge.from === `${ramp.id}:lower`),
      high = ends.find(edge => edge.from === `${ramp.id}:upper`)
    if (low !== undefined && high !== undefined)
      connection('RAMP', low.from, high.from, [low.id, high.id])
  }

  refineGroundNavigation(
    data,
    partition.labels,
    partition.areas.map(hubId),
    nodes,
    edges,
    areaConnections,
    nodeCells,
  )
  if (data.groundSampling !== undefined) {
    const refined = new Map(nodes.map(node => [node.id, node.position]))
    for (const portals of [cliffPortals, destructiblePortals, mineralPortals])
      for (let index = 0; index < portals.length; index++) {
        const portal = portals[index]!
        const entryA = refined.get(`${portal.id}:a`)!,
          entryB = refined.get(`${portal.id}:b`)!
        portals[index] = {
          ...portal,
          entryA,
          entryB,
          ...(cliffPortals === portals ? { crossing: round2(distance(entryA, entryB)) } : {}),
        }
      }
    for (let index = 0; index < ramps.length; index++) {
      const ramp = ramps[index]!
      ramps[index] = {
        ...ramp,
        center: refined.get(ramp.id)!,
        lowerStagingPoint: refined.get(`${ramp.id}:lower`)!,
        upperStagingPoint: refined.get(`${ramp.id}:upper`)!,
      }
    }
    for (let index = 0; index < chokes.length; index++)
      chokes[index] = { ...chokes[index]!, center: refined.get(chokes[index]!.id)! }
    for (let index = 0; index < predropPortals.length; index++) {
      const portal = predropPortals[index]!
      const a = refined.get(`${portal.id}:a`)!,
        b = refined.get(`${portal.id}:b`)!
      predropPortals[index] = {
        ...portal,
        pickupA: a,
        dropA: a,
        pickupB: b,
        dropB: b,
        airDistance: round2(distance(a, b)),
      }
    }
    for (let index = 0; index < partition.areas.length; index++)
      partition.areas[index] = {
        ...partition.areas[index]!,
        center: refined.get(hubId(partition.areas[index]!))!,
      }
  }

  // Accessibility from the start regions, per movement class.
  const startRegions = new Set(
    data.startLocations.flatMap(start => {
      const cell = nearestCell(size, start, 6, next => regions.labels[next]! > 0)
      return cell === undefined ? [] : [regionOf(context, cell)!]
    }),
  )
  if (startRegions.size === 0 && regions.count > 0) {
    const largest = regionCells.reduce(
      (best, cells, label) => (cells.length > regionCells[best]!.length ? label : best),
      1,
    )
    startRegions.add(regions.regionIds[largest - 1]!)
  }
  const adjacency = new Map<string, NavigationEdge[]>()
  for (const edge of edges)
    for (const end of [edge.from, edge.to]) {
      const list = adjacency.get(end)
      if (list === undefined) adjacency.set(end, [edge])
      else list.push(edge)
    }
  const reached = (types: readonly NavigationEdgeType[]) => {
    const seen = new Set<string>(
      nodes
        .filter(node => node.region !== null && startRegions.has(node.region))
        .map(node => node.id),
    )
    const queue = [...seen]
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const edge of adjacency.get(id) ?? []) {
        if (!types.includes(edge.type)) continue
        const next = edge.from === id ? edge.to : edge.from
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return seen
  }
  const modes = Object.keys(MODE_EDGES) as (keyof Access)[]
  const reach = Object.fromEntries(modes.map(mode => [mode, reached(MODE_EDGES[mode])])) as Record<
    keyof Access,
    Set<string>
  >
  const accessOf = (nodeId: string): Access =>
    Object.fromEntries(modes.map(mode => [mode, reach[mode].has(nodeId)])) as unknown as Access

  const portalIdsByRegion = new Map<string, string[]>()
  for (const node of nodes)
    if (node.region !== null && node.ref !== undefined && node.type !== 'EXPANSION') {
      const list = portalIdsByRegion.get(node.region) ?? []
      if (!list.includes(node.ref)) list.push(node.ref)
      portalIdsByRegion.set(node.region, list)
    }

  const regionList: GroundRegion[] = regions.regionIds.map((id, index) => {
    const cells = regionCells[index + 1]!
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let level = 0
    for (const cell of cells) {
      const x = cell % size.width
      const y = (cell - x) / size.width
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x + 1)
      y1 = Math.max(y1, y + 1)
      level += data.level[cell]!
    }
    return {
      id,
      level: Math.round(level / cells.length),
      area: cells.length,
      bounds: [x0, y0, x1, y1],
      centroid: centreOf(size, regionCentre[index]!),
      portalIds: portalIdsByRegion.get(id) ?? [],
      access: accessOf(id),
    }
  })

  const regionRuns: number[] = []
  for (let cell = 0; cell < regions.labels.length;) {
    const label = regions.labels[cell]!
    let end = cell + 1
    while (end < regions.labels.length && regions.labels[end] === label && end % size.width !== 0)
      end += 1
    if (label > 0) regionRuns.push(cell, end - cell, label)
    cell = end
  }

  return {
    version: 1,
    width: data.width,
    height: data.height,
    regions: regionList,
    expansions: expansionShapes.map(expansion => ({
      ...expansion,
      access: accessOf(expansion.id),
    })),
    ramps,
    chokes,
    blockers: data.blockers.filter(
      blocker => blocker.kind === 'destructible' || blocker.kind === 'mineral',
    ),
    destructiblePortals,
    mineralPortals,
    cliffPortals,
    predropPortals,
    nodes,
    edges,
    regionRuns,
    areas: partition.areas,
    areaRuns: partition.runs,
    areaConnections,
  }
}

/** The region id at a world position, from the serialized runs (what runtime code would use). */
export function regionAt(navigation: MapNavigation, x: number, y: number): string | null {
  const label = runLabelAt(navigation, navigation.regionRuns, x, y)
  return label === 0 ? null : (navigation.regions[label - 1]?.id ?? null)
}

export function areaAt(navigation: MapNavigation, x: number, y: number): string | null {
  const label = runLabelAt(navigation, navigation.areaRuns, x, y)
  return label === 0 ? null : (navigation.areas[label - 1]?.id ?? null)
}

function runLabelAt(size: GridSize, runs: readonly number[], x: number, y: number): number {
  if (!inside(size, x, y)) return 0
  const cell = Math.floor(y) * size.width + Math.floor(x)
  let low = 0
  let high = runs.length / 3 - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const start = runs[middle * 3]!
    if (cell < start) high = middle - 1
    else if (cell >= start + runs[middle * 3 + 1]!) low = middle + 1
    else return runs[middle * 3 + 2]!
  }
  return 0
}
