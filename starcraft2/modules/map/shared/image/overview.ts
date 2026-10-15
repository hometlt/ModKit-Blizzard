import type { MapLatticeOverview } from '@modkit/sdk/maps'
import { encodeLatticeRunRows } from '@modkit/codec-kit/maps/lattice-overview'
import { validateLatticeOverview } from '@modkit/sdk/maps'

/**
 * Top-down overview of a StarCraft II map: cliff levels, cliff faces, ramps, pathing, resources,
 * start locations and the playable boundary, drawn from the map's own documents.
 *
 * Every document has its own analysis function that returns plain data, and the grid documents
 * have their own image as well, so a per-document preview codec can reuse them:
 *
 * | Document | Analysis | Image |
 * |---|---|---|
 * | `t3HeightMap` | `analyzeVertexCliffLevels` | `vertexCliffLevelsToPng` |
 * | `t3SyncCliffLevel` | `analyzeCellCliffLevels` | `cellCliffLevelsToPng` |
 * | `t3Terrain.xml` `<cliffCellList>` | `analyzeCliffLattice`, `analyzeCliffFaces` | |
 * | `t3Terrain.xml` `<rampList>` | `analyzeRamps` | |
 * | `CellAttribute_Pnp` | `analyzeNoPathing` | |
 * | `Objects` | `analyzeMapMarkers` | |
 * | `MapInfo` | `analyzePlayableBounds` | |
 *
 * `renderMapOverview` / `mapOverviewToPng` compose them. Coordinates are terrain cells with the
 * origin at the map's lower-left; images are drawn north-up.
 *
 * Wall tiles are drawn by the shape of the cliff mesh they carry, measured on Amphion's shipped
 * `CliffMade20` meshes: a level's region is the L1 dilation by 1.5 of the tile corners and edges at
 * or above it, so a straight wall stands 0.5 in from its low edge, a single high corner is cut by a
 * 45° line 1.5 from it and a single low corner keeps a 0.5 wedge. Two high corners of one level on a
 * diagonal join into one rock (the mesh is high over 94 % of the tile). The fill and the face lines
 * come from that one rule, so the surface has no seams between tiles.
 */

import type {
  CellAttributeResult,
  CliffLevelResult,
  HeightMapResult,
  MapInfoResult,
  PlacedObjectsResult,
  SC2MapData,
  TerrainInfo,
} from '../format/index.js'
import { dequantizeCliffLevel, readCellAttribute } from '../format/index.js'
import { encodeRGB8 } from './png.js'

/**
 * The documents `renderMapOverview` reads, by lower-case basename. A caller that opens the archive
 * itself can read and parse only these: the rest of a map (texture masks alone are megabytes) is not
 * needed.
 */
export const MAP_OVERVIEW_DOCUMENTS: ReadonlySet<string> = new Set([
  't3heightmap',
  't3terrain.xml',
  't3syncclifflevel',
  'objects',
  'mapinfo',
  'cellattribute_pnp',
  'cellattribute_pnb',
  'cellattribute_pcl',
])

export type Rgb = readonly [number, number, number]

/** A point in terrain cells. */
export type Point = readonly [number, number]

/** A line segment in terrain cells. */
export type Segment = readonly [number, number, number, number]

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

/** Cliff level (A=0 … D=12) to colour: level A dark blue, ground darker the lower it is. */
const LEVEL_ANCHORS: readonly (readonly [number, Rgb])[] = [
  [0, [30, 45, 100]],
  [4, [95, 55, 30]],
  [8, [165, 110, 65]],
  [12, [230, 205, 165]],
]

export function cliffLevelColor(level: number): Rgb {
  const last = LEVEL_ANCHORS[LEVEL_ANCHORS.length - 1]!
  const clamped = Math.min(last[0], Math.max(0, level))
  for (let k = 1; k < LEVEL_ANCHORS.length; k += 1) {
    const [lo, a] = LEVEL_ANCHORS[k - 1]!
    const [hi, b] = LEVEL_ANCHORS[k]!
    if (clamped <= hi) {
      const t = (clamped - lo) / (hi - lo)
      return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
      ]
    }
  }
  return last[1]
}

// ---------------------------------------------------------------------------------------------
// t3HeightMap: cliff level of every vertex
// ---------------------------------------------------------------------------------------------

/** Cliff level per height vertex in CLIF units (A=0, B=4, C=8, D=12), fractional on ramps. */
export interface VertexCliffLevels {
  readonly sizeX: number
  readonly sizeY: number
  /** Row-major, `y * sizeX + x`. */
  readonly levels: Float32Array
}

/** World units a level A vertex sits below level B; B and up rise half a unit per level. */
const LEVEL_A_OFFSET = -8

/**
 * `heightAdjustments` holds each vertex's cliff offset (A −8, B 0, C +2, D +4, ramps between).
 * It, not the per-cell `t3SyncCliffLevel`, is what the cliff meshes are built on.
 */
export function analyzeVertexCliffLevels(
  height: HeightMapResult,
  params: { readonly quantizeScale: number; readonly quantizeBias: number },
): VertexCliffLevels {
  const levels = new Float32Array(height.sizeX * height.sizeY)
  for (let index = 0; index < levels.length; index += 1) {
    const adjustment =
      height.cells[index]!.heightAdjustments * params.quantizeScale - params.quantizeBias
    levels[index] = adjustment <= LEVEL_A_OFFSET / 2 ? 0 : 4 + Math.max(0, adjustment * 2)
  }
  return { sizeX: height.sizeX, sizeY: height.sizeY, levels }
}

/** `t3HeightMap` preview: one square per vertex in its cliff level's colour. */
export function vertexCliffLevelsToPng(
  levels: VertexCliffLevels,
  options: { pixelsPerVertex?: number } = {},
): Uint8Array {
  return gridToPng(levels.sizeX, levels.sizeY, options.pixelsPerVertex, index =>
    cliffLevelColor(levels.levels[index]!),
  )
}

// ---------------------------------------------------------------------------------------------
// t3SyncCliffLevel: cliff level of every cell
// ---------------------------------------------------------------------------------------------

export interface CellCliffLevels {
  readonly sizeX: number
  readonly sizeY: number
  /** Row-major, `y * sizeX + x`, CLIF units. */
  readonly levels: Uint8Array
}

export function analyzeCellCliffLevels(cliff: CliffLevelResult): CellCliffLevels {
  const levels = new Uint8Array(cliff.sizeX * cliff.sizeY)
  for (let index = 0; index < levels.length; index += 1)
    levels[index] = Math.min(255, dequantizeCliffLevel(cliff.heights[index]!))
  return { sizeX: cliff.sizeX, sizeY: cliff.sizeY, levels }
}

/** `t3SyncCliffLevel` preview: one square per cell in its cliff level's colour. */
export function cellCliffLevelsToPng(
  levels: CellCliffLevels,
  options: { pixelsPerCell?: number } = {},
): Uint8Array {
  return gridToPng(levels.sizeX, levels.sizeY, options.pixelsPerCell, index =>
    cliffLevelColor(levels.levels[index]!),
  )
}

// ---------------------------------------------------------------------------------------------
// t3Terrain.xml <cliffCellList>: the tile lattice and its wall shapes
// ---------------------------------------------------------------------------------------------

export const TILE_NONE = 0
export const TILE_FLAT = 1
export const TILE_WALL = 2
export const TILE_RAMP = 3

/**
 * The 2×2-cell tile lattice. Tile `(i, j)` covers cells `2i, 2i+1` × `2j, 2j+1`; its corners are the
 * vertices `(2i, 2j)`, `(2i+2, 2j)`, `(2i+2, 2j+2)`, `(2i, 2j+2)`, stored as base levels (ramp
 * sub-levels rounded to the nearest full level).
 */
export interface CliffLattice {
  readonly sizeX: number
  readonly sizeY: number
  /** `TILE_*` per tile, row-major. A wall tile has corners at more than one level. */
  readonly roles: Uint8Array
  /** Four corner levels per tile, bottom-left, bottom-right, top-right, top-left. */
  readonly corners: Uint8Array
  /** `<cliffSetList>` index per tile (`cid`), 0 where the map lists none. */
  readonly sets: Uint8Array
}

const baseLevel = (level: number) => Math.min(12, Math.max(0, Math.round(level / 4) * 4))

export function analyzeCliffLattice(
  terrain: TerrainInfo,
  vertices: VertexCliffLevels,
): CliffLattice {
  const sizeX = (vertices.sizeX - 1) >> 1
  const sizeY = (vertices.sizeY - 1) >> 1
  const roles = new Uint8Array(sizeX * sizeY)
  const corners = new Uint8Array(sizeX * sizeY * 4)
  const sets = new Uint8Array(sizeX * sizeY)
  const at = (x: number, y: number) => baseLevel(vertices.levels[y * vertices.sizeX + x]!)
  for (let j = 0; j < sizeY; j += 1)
    for (let i = 0; i < sizeX; i += 1) {
      const tile = j * sizeX + i
      corners[tile * 4] = at(2 * i, 2 * j)
      corners[tile * 4 + 1] = at(2 * i + 2, 2 * j)
      corners[tile * 4 + 2] = at(2 * i + 2, 2 * j + 2)
      corners[tile * 4 + 3] = at(2 * i, 2 * j + 2)
    }
  for (const cell of terrain.cliffCells ?? []) {
    if (cell.index < 0 || cell.index >= roles.length) continue
    const c = cell.index * 4
    const varied =
      corners[c] !== corners[c + 1] ||
      corners[c] !== corners[c + 2] ||
      corners[c] !== corners[c + 3]
    roles[cell.index] =
      cell.flags === 0 ? TILE_FLAT : cell.flags === 2 ? TILE_RAMP : varied ? TILE_WALL : TILE_FLAT
    sets[cell.index] = cell.cliffSetIndex
  }
  return { sizeX, sizeY, roles, corners, sets }
}

export function latticeCorners(lattice: CliffLattice, i: number, j: number): readonly number[] {
  const c = (j * lattice.sizeX + i) * 4
  return [
    lattice.corners[c]!,
    lattice.corners[c + 1]!,
    lattice.corners[c + 2]!,
    lattice.corners[c + 3]!,
  ]
}

const CORNER_AT = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const
const MADE_RADIUS = 1.5
const LOW_WEDGE = 2 - MADE_RADIUS

/**
 * The level field of one wall tile, in tile-local coordinates (`-1..1` both ways). The thresholds are
 * worked out once per tile, so the returned function is cheap per pixel.
 */
export function tileLevelField(corners: readonly number[]): (lx: number, ly: number) => number {
  const thresholds = [...new Set(corners)].sort((a, b) => a - b)
  const lowest = thresholds[0]!
  const steps = thresholds.slice(1).map(threshold => {
    const high = corners.map(value => value >= threshold)
    const diagonal = high[0] === high[2] && high[1] === high[3] && high[0] !== high[1]
    const pair = high[0] ? [0, 2] : [1, 3]
    // Three high corners, or two of one level on a diagonal: high but for 0.5 wedges at the low
    // corners, as the face lines draw it.
    const merged =
      high.filter(Boolean).length === 3 || (diagonal && corners[pair[0]!] === corners[pair[1]!])
    return { threshold, high, merged }
  })
  return (lx, ly) => {
    let result = lowest
    for (const { threshold, high, merged } of steps) {
      if (merged) {
        let inWedge = false
        for (let k = 0; k < 4; k += 1)
          if (
            !high[k] &&
            Math.abs(lx - CORNER_AT[k]![0]) + Math.abs(ly - CORNER_AT[k]![1]) < LOW_WEDGE
          )
            inWedge = true
        if (!inWedge) result = threshold
        continue
      }
      let inside = false
      for (let k = 0; k < 4 && !inside; k += 1) {
        const [cx, cy] = CORNER_AT[k]!
        if (!high[k]) continue
        if (Math.abs(lx - cx) + Math.abs(ly - cy) < MADE_RADIUS) inside = true
        const next = (k + 1) % 4
        if (high[next]) {
          const [nx, ny] = CORNER_AT[next]!
          if (cy === ny && Math.abs(ly - cy) < MADE_RADIUS) inside = true
          if (cx === nx && Math.abs(lx - cx) < MADE_RADIUS) inside = true
        }
      }
      if (inside) result = threshold
    }
    return result
  }
}

/** The cliff face lines of one wall tile, in tile-local coordinates. */
export function tileFaceSegments(corners: readonly number[]): Segment[] {
  const wedge = (corner: readonly [number, number], radius: number): Segment => [
    corner[0],
    corner[1] - corner[1] * radius,
    corner[0] - corner[0] * radius,
    corner[1],
  ]
  const segments: Segment[] = []
  for (const threshold of [...new Set(corners)].sort((a, b) => a - b).slice(1)) {
    const high = corners.map(value => value >= threshold)
    const highCorners = high.flatMap((value, index) => (value ? [index] : []))
    if (highCorners.length === 1) segments.push(wedge(CORNER_AT[highCorners[0]!]!, MADE_RADIUS))
    else if (highCorners.length === 3)
      segments.push(wedge(CORNER_AT[high.indexOf(false)]!, LOW_WEDGE))
    else if (highCorners.length === 2) {
      const [a, b] = highCorners as [number, number]
      if ((a + 2) % 4 === b) {
        if (corners[a] === corners[b]) {
          for (let index = 0; index < 4; index += 1)
            if (index !== a && index !== b) segments.push(wedge(CORNER_AT[index]!, LOW_WEDGE))
        } else for (const index of [a, b]) segments.push(wedge(CORNER_AT[index]!, MADE_RADIUS))
      } else {
        const [ax, ay] = CORNER_AT[a]!
        const [bx, by] = CORNER_AT[b]!
        if (ay === by) segments.push([-1, ay - ay * MADE_RADIUS, 1, ay - ay * MADE_RADIUS])
        else if (ax === bx) segments.push([ax - ax * MADE_RADIUS, -1, ax - ax * MADE_RADIUS, 1])
      }
    }
  }
  return segments
}

/** Every wall tile's face lines, in terrain cells. */
export function analyzeCliffFaces(lattice: CliffLattice): Segment[] {
  const faces: Segment[] = []
  for (let j = 0; j < lattice.sizeY; j += 1)
    for (let i = 0; i < lattice.sizeX; i += 1) {
      if (lattice.roles[j * lattice.sizeX + i] !== TILE_WALL) continue
      const cx = 2 * i + 1
      const cy = 2 * j + 1
      for (const [ax, ay, bx, by] of tileFaceSegments(latticeCorners(lattice, i, j)))
        faces.push([cx + ax, cy + ay, cx + bx, cy + by])
    }
  return faces
}

/**
 * A cliff line: the face segments of one level step joined end to end, the high level on the left
 * of the walking direction.
 */
export interface CliffLine {
  readonly points: readonly Point[]
  readonly hi: number
  readonly lo: number
  /** Natural rock (drawn rounded and slightly wavy) rather than a made wall. */
  readonly natural: boolean
  /** The last point joins the first. */
  readonly closed: boolean
}

/** How far across a face its two levels are sampled, tile-local. */
const FACE_PROBE = 0.05

export function analyzeCliffLines(
  lattice: CliffLattice,
  isNatural: (setIndex: number) => boolean = () => false,
): CliffLine[] {
  interface Piece {
    readonly a: Point
    readonly b: Point
    readonly key: string
    used: boolean
  }
  const pointKey = (point: Point) => `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)}`
  const pieces: Piece[] = []
  const starts = new Map<string, Piece[]>()
  const ends = new Set<string>()
  // A tile can give the same face for two level steps (a corner diamond at both); keep one.
  const seen = new Set<string>()
  for (let j = 0; j < lattice.sizeY; j += 1)
    for (let i = 0; i < lattice.sizeX; i += 1) {
      const tile = j * lattice.sizeX + i
      if (lattice.roles[tile] !== TILE_WALL) continue
      const corners = latticeCorners(lattice, i, j)
      const field = tileLevelField(corners)
      const natural = isNatural(lattice.sets[tile]!)
      for (const [ax, ay, bx, by] of tileFaceSegments(corners)) {
        const length = Math.hypot(bx - ax, by - ay) || 1
        const nx = (-(by - ay) / length) * FACE_PROBE
        const ny = ((bx - ax) / length) * FACE_PROBE
        const left = field((ax + bx) / 2 + nx, (ay + by) / 2 + ny)
        const right = field((ax + bx) / 2 - nx, (ay + by) / 2 - ny)
        if (left === right) continue
        const from: Point = [2 * i + 1 + ax, 2 * j + 1 + ay]
        const to: Point = [2 * i + 1 + bx, 2 * j + 1 + by]
        const key = `${Math.max(left, right)}/${Math.min(left, right)}/${natural}`
        const face = [pointKey(from), pointKey(to)].sort().join('|')
        if (seen.has(face)) continue
        seen.add(face)
        const piece: Piece =
          left > right ? { a: from, b: to, key, used: false } : { a: to, b: from, key, used: false }
        pieces.push(piece)
        const start = `${key}@${pointKey(piece.a)}`
        starts.set(start, [...(starts.get(start) ?? []), piece])
        ends.add(`${key}@${pointKey(piece.b)}`)
      }
    }
  const lines: CliffLine[] = []
  const walk = (first: Piece) => {
    const points: Point[] = [first.a]
    for (let piece: Piece | undefined = first; piece !== undefined;) {
      piece.used = true
      points.push(piece.b)
      piece = starts.get(`${piece.key}@${pointKey(piece.b)}`)?.find(next => !next.used)
    }
    const [hi, lo, natural] = first.key.split('/')
    const closed = pointKey(points[0]!) === pointKey(points[points.length - 1]!)
    lines.push({
      points: closed ? points.slice(0, -1) : points,
      hi: Number(hi),
      lo: Number(lo),
      natural: natural === 'true',
      closed,
    })
  }
  for (const piece of pieces)
    if (!piece.used && !ends.has(`${piece.key}@${pointKey(piece.a)}`)) walk(piece)
  for (const piece of pieces) if (!piece.used) walk(piece)
  return lines
}

const WAVE_AMPLITUDE = 0.12
const WAVE_LENGTH = 3

/**
 * A natural cliff line as drawn: corners rounded off (three Chaikin passes) and a slight wave along
 * it. Open ends stay where they are, so the line still meets the ramp or map edge it ran into.
 *
 * The wave is a function of the position relative to `centre`, pushed towards the high ground, so
 * a map mirrored or turned about `centre` gets mirrored lines whichever end a line starts from.
 */
export function smoothCliffLine(line: CliffLine, centre: Point = [0, 0]): Point[] {
  let points: Point[] = [...line.points]
  const count = () => (line.closed ? points.length : points.length - 1)
  for (let pass = 0; pass < 3 && points.length > 1; pass += 1) {
    const next: Point[] = line.closed ? [] : [points[0]!]
    for (let k = 0; k < count(); k += 1) {
      const [px, py] = points[k]!
      const [qx, qy] = points[(k + 1) % points.length]!
      next.push([px * 0.75 + qx * 0.25, py * 0.75 + qy * 0.25])
      next.push([px * 0.25 + qx * 0.75, py * 0.25 + qy * 0.75])
    }
    if (!line.closed) next.push(points[points.length - 1]!)
    points = next
  }
  const along = [0]
  for (let k = 1; k <= count(); k += 1) {
    const [px, py] = points[k - 1]!
    const [qx, qy] = points[k % points.length]!
    along.push(along[k - 1]! + Math.hypot(qx - px, qy - py))
  }
  const total = along[along.length - 1]!
  const k = (2 * Math.PI) / WAVE_LENGTH
  const wave = (x: number, y: number) =>
    (Math.cos(k * (x - centre[0])) + Math.cos(k * (y - centre[1]))) / 2
  return points.map(([x, y], index) => {
    const [px, py] =
      points[line.closed ? (index - 1 + points.length) % points.length : Math.max(0, index - 1)]!
    const [qx, qy] =
      points[line.closed ? (index + 1) % points.length : Math.min(points.length - 1, index + 1)]!
    const length = Math.hypot(qx - px, qy - py) || 1
    const s = along[index]!
    const taper = line.closed ? 1 : Math.min(1, s, total - s)
    const offset = WAVE_AMPLITUDE * taper * wave(x, y)
    return [x - ((qy - py) / length) * offset, y + ((qx - px) / length) * offset] as const
  })
}

// ---------------------------------------------------------------------------------------------
// t3Terrain.xml <rampList>: ramp slopes and side walls
// ---------------------------------------------------------------------------------------------

export interface RampSide {
  /** Offset from the axis along `right`. */
  readonly lateral: number
  /** Where the side's wall begins, along `up` (the end of the cliff line it continues). */
  readonly lineTop: number
}

/**
 * A ramp in its own frame: `up` points uphill, `right` across, both from the `mid` frame; `along`
 * and `lateral` distances are measured from `center`.
 */
export interface RampShape {
  readonly center: readonly [number, number]
  readonly up: readonly [number, number]
  readonly right: readonly [number, number]
  /** Full cliff levels the ramp joins. */
  readonly hi: number
  readonly lo: number
  /** The stretch of the axis where the height map lies strictly between `lo` and `hi`. */
  readonly slopeTop: number
  readonly slopeBottom: number
  /** The drawn low end: `slopeBottom`, or one cell higher on diagonal ramps (the owner's call). */
  readonly drawnBottom: number
  readonly sides: readonly [RampSide, RampSide]
}

/** Diagonal ramps are drawn one cell (half a tile) shorter at their low end. */
const DIAGONAL_RAMP_TRIM = 1

export function vertexLevelAt(vertices: VertexCliffLevels, x: number, y: number): number {
  const ix = Math.min(vertices.sizeX - 2, Math.max(0, Math.floor(x)))
  const iy = Math.min(vertices.sizeY - 2, Math.max(0, Math.floor(y)))
  const fx = Math.min(1, Math.max(0, x - ix))
  const fy = Math.min(1, Math.max(0, y - iy))
  const at = (dx: number, dy: number) => vertices.levels[(iy + dy) * vertices.sizeX + ix + dx]!
  return (
    (1 - fx) * (1 - fy) * at(0, 0) +
    fx * (1 - fy) * at(1, 0) +
    fx * fy * at(1, 1) +
    (1 - fx) * fy * at(0, 1)
  )
}

/**
 * Slope from the height map along the ramp's axis. Side lateral: where the side mesh stands,
 * `w + 1.5 * max(|right.x|, |right.y|)` off the axis (measured on Amphion's diagonal and straight
 * ramps), moved to the end of the cliff line the side continues when one lies within a cell of it
 * anywhere along the slope. Without such an end the side runs uphill until it meets a cliff line.
 */
export function analyzeRamps(
  terrain: TerrainInfo,
  vertices: VertexCliffLevels,
  faces: readonly Segment[],
): RampShape[] {
  const unit = (v: readonly [number, number]) => {
    const length = Math.hypot(v[0], v[1]) || 1
    return [v[0] / length, v[1] / length] as const
  }
  const shapes: RampShape[] = []
  for (const ramp of terrain.ramps ?? []) {
    const mid = ramp.frames.mid
    const hi = ramp.hi * 4
    const lo = ramp.lo * 4
    if (mid === undefined || mid.width <= 0 || !(hi > lo)) continue
    const up = unit(mid.up)
    const right = unit(mid.right)
    const center = mid.center
    const point = (a: number, l: number) =>
      [center[0] + up[0] * a + right[0] * l, center[1] + up[1] * a + right[1] * l] as const
    const along = (x: number, y: number) => (x - center[0]) * up[0] + (y - center[1]) * up[1]
    const lateral = (x: number, y: number) =>
      (x - center[0]) * right[0] + (y - center[1]) * right[1]
    let slopeTop = -Infinity
    let slopeBottom = Infinity
    const reach = mid.height + 4
    for (let a = -reach; a <= reach; a += 0.05) {
      const level = vertexLevelAt(vertices, ...point(a, 0))
      if (level < hi - 0.05 && level > lo + 0.05) {
        slopeTop = Math.max(slopeTop, a)
        slopeBottom = Math.min(slopeBottom, a)
      }
    }
    if (!(slopeTop > slopeBottom)) continue
    const diagonal = Math.abs(up[0]) > 0.1 && Math.abs(up[1]) > 0.1
    const drawnBottom = diagonal
      ? Math.min(slopeTop - 0.1, slopeBottom + DIAGONAL_RAMP_TRIM)
      : slopeBottom
    const nominal = mid.width + 1.5 * Math.max(Math.abs(right[0]), Math.abs(right[1]))
    const side = (sign: number): RampSide => {
      let best: RampSide | undefined
      let bestScore = Infinity
      for (const [ax, ay, bx, by] of faces)
        for (const [x, y] of [
          [ax, ay],
          [bx, by],
        ] as const) {
          const offset = Math.abs(lateral(x, y) - sign * nominal)
          const a = along(x, y)
          if (offset > 1 || a < slopeBottom || a > slopeTop + 0.5) continue
          const score = offset + 0.1 * Math.abs(slopeTop - a)
          if (score < bestScore) {
            bestScore = score
            best = { lateral: lateral(x, y), lineTop: a }
          }
        }
      if (best !== undefined) return best
      for (let a = slopeTop; a <= slopeTop + 4; a += 0.05) {
        const [px, py] = point(a, sign * nominal)
        if (faces.some(face => distanceToSegment(px, py, face) < 0.1))
          return { lateral: sign * nominal, lineTop: a }
      }
      return { lateral: sign * nominal, lineTop: slopeTop }
    }
    shapes.push({
      center,
      up,
      right,
      hi,
      lo,
      slopeTop,
      slopeBottom,
      drawnBottom,
      sides: [side(1), side(-1)],
    })
  }
  return shapes
}

// ---------------------------------------------------------------------------------------------
// CellAttribute_Pnp: painted no-pathing
// ---------------------------------------------------------------------------------------------

export interface PathingMask {
  readonly sizeX: number
  readonly sizeY: number
  /** Row-major; 0 walkable … 255 no pathing (the void past the map edge, painted blockers). */
  readonly blocked: Uint8Array
}

export function analyzeNoPathing(attribute: CellAttributeResult): PathingMask {
  return { sizeX: attribute.sizeX, sizeY: attribute.sizeY, blocked: attribute.cells }
}

// ---------------------------------------------------------------------------------------------
// Catalog: resolved unit, actor, behavior, footprint and cliff entities
// ---------------------------------------------------------------------------------------------

/** A resolved catalog entity, as Modkit's data service hands it over (inheritance applied). */
export interface CatalogEntity {
  readonly namespace: string
  readonly entityId: string
  readonly fields?: Readonly<Record<string, unknown>>
}

/** A resolved catalog snapshot: the same one the map's 3D scene is built from. */
export interface CatalogSnapshot {
  readonly definitions?: readonly CatalogEntity[]
  readonly entities?: readonly CatalogEntity[]
}

/** Catalog closure required by this owner for footprint bodies and rich/resource behavior data. */
export function overviewCatalogQueries(snapshot: CatalogSnapshot | undefined): readonly Readonly<{namespace:string;entityId:string}>[] {
  const queries = new Map<string,{namespace:string;entityId:string}>()
  const add=(namespace:string,entityId:string)=>{if(entityId)queries.set(`${namespace}/${entityId}`,{namespace,entityId})}
  for(const entity of snapshot?.definitions ?? snapshot?.entities ?? []) {
    if(entity.namespace!=='Unit' && entity.namespace!=='Actor')continue
    const fields=entity.fields ?? {}
    add('Footprint',text(fields['Footprint']))
    if(entity.namespace==='Unit')for(const [,item] of indexed(fields['BehaviorArray']))
      add('Behavior',text(isRecord(item)?item['Link']:item))
  }
  return [...queries.values()]
}

export interface Footprint {
  /**
   * `Place` layer cells that block ground pathing, as lower-left corners relative to the footprint
   * origin (the cell that holds the object's position).
   */
  readonly blocked: readonly Point[]
  /** `Place` cells where nothing can be built (`NoBuild`). */
  readonly noBuild: readonly Point[]
  /** `Place` cells that block sight (`BlockVision`, or `ShrubVision` of shrubs and curtains). */
  readonly vision: readonly Point[]
  /** `Place` cells where no town hall may stand (`NearResources`, around resource fields). */
  readonly nearResources?: readonly Point[]
  /** `Shape`: the footprint outline around the object's position. */
  readonly outline?: readonly Point[]
}

export type ObjectKind =
  'minerals' | 'rich-minerals' | 'geyser' | 'rich-geyser' | 'destructible' | 'unit' | 'doodad'

export interface ObjectData {
  readonly kind: ObjectKind
  readonly footprint?: Footprint
  /** `FlagArray[Turnable]`: the footprint turns with the object. */
  readonly turnable: boolean
  /** `CUnit.Radius`. */
  readonly radius?: number
  /** Starting contents of the unit's resource behaviour (`CBehaviorResource.Contents`). */
  readonly resources?: number
  /** `CUnit.LifeMax`. */
  readonly life?: number
}

export interface MapCatalog {
  /** A `CUnit` by id. */
  unit(id: string): ObjectData | undefined
  /** A doodad's `CActor` by id. */
  doodad(id: string): ObjectData | undefined
  /** A `<cliffSetList>` id's family, from the set's editor icon. */
  cliffFamily(setId: string): 'natural' | 'made' | undefined
}

/** Harvest per trip of a standard field; a rich one yields more (SC2 rules: 5 minerals, 4 gas). */
const STANDARD_HARVEST: Readonly<Record<string, number>> = { Minerals: 5, Vespene: 4 }

/** `<CFootprint default="1">` in core.sc2mod: the body character blocks ground and building. */
const CORE_PLACE_DEFAULT: readonly (readonly [string, string, number])[] = [
  ['x', 'GroundNoSpawn', 1],
  ['x', 'NoBuild', 1],
]

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A field value, unwrapped from a `{ value }` record. */
const fieldValue = (value: unknown): unknown =>
  isRecord(value) && Object.hasOwn(value, 'value') ? value['value'] : value

const text = (value: unknown): string => {
  const unwrapped = fieldValue(value)
  return typeof unwrapped === 'string' || typeof unwrapped === 'number' ? String(unwrapped) : ''
}

/** An indexed array field (`[{ index, value }]`) as entries, in authored order. */
function indexed(value: unknown): (readonly [string, unknown])[] {
  const unwrapped = fieldValue(value)
  if (!Array.isArray(unwrapped)) return []
  return unwrapped.flatMap((item: unknown) =>
    isRecord(item) && item['index'] !== undefined
      ? [[String(item['index']), item['value']] as const]
      : [],
  )
}

/** Flag values per footprint character. */
type CharacterFlags = Map<string, Map<string, number>>

/** A `Sets` list over `flags`; a set without a `Character` is the body character `x`. */
function applyFootprintSets(flags: CharacterFlags, sets: unknown): void {
  for (const [, set] of indexed(sets)) {
    if (!isRecord(set)) continue
    const character = text(set['Character']) || 'x'
    const own = flags.get(character) ?? new Map<string, number>()
    flags.set(character, own)
    for (const [flag, value] of indexed(set['Positive'])) own.set(flag, Number(fieldValue(value)))
  }
}

function placeLayer(fields: Readonly<Record<string, unknown>> | undefined) {
  const layer = indexed(fields?.['Layers']).find(([index]) => index === 'Place')?.[1]
  return isRecord(layer) ? layer : undefined
}

function parseFootprintShape(shape: unknown): Point[] | undefined {
  if (!isRecord(shape)) return undefined
  const offsets = text(shape['Offsets'])
    .split(';')
    .filter(Boolean)
    .map(pair => pair.split(',').map(Number))
  if (offsets.length < 3 || offsets.some(pair => pair.length !== 2 || !pair.every(Number.isFinite)))
    return undefined
  // `Borders` lists the outline's edges as `from,to,…` offset indices.
  const next = new Map<number, number>()
  for (const border of text(shape['Borders']).split(';').filter(Boolean)) {
    const [from, to] = border.split(',').map(Number)
    if (from !== undefined && to !== undefined) next.set(from, to)
  }
  const order: number[] = []
  for (let k = next.keys().next().value; k !== undefined && !order.includes(k); k = next.get(k))
    order.push(k)
  const ring = order.length === offsets.length ? order : offsets.map((_, index) => index)
  return ring.map(index => [offsets[index]![0]!, offsets[index]![1]!] as const)
}

function parseFootprint(entity: CatalogEntity, defaults: CharacterFlags): Footprint {
  const place = placeLayer(entity.fields)
  const rows = indexed(place?.['Rows'])
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, row]) => text(row))
  const width = Math.max(0, ...rows.map(row => row.length))
  const area = text(place?.['Area']).split(',').map(Number)
  // Without an `Area` the rows are centred on the origin cell (`Footprint2x2Underground`).
  const [left, top] =
    area.length === 4 && area.every(Number.isFinite)
      ? [area[0]!, area[3]!]
      : [-Math.floor(width / 2), rows.length - Math.floor(rows.length / 2)]
  const flags: CharacterFlags = new Map(
    [...defaults].map(([character, values]) => [character, new Map(values)]),
  )
  applyFootprintSets(flags, place?.['Sets'])
  const blocked: Point[] = []
  const noBuild: Point[] = []
  const vision: Point[] = []
  const nearResources: Point[] = []
  rows.forEach((row, r) => {
    for (let column = 0; column < row.length; column += 1) {
      const own = flags.get(row[column]!)
      const cell: Point = [left + column, top - 1 - r]
      if (own?.get('GroundNoSpawn') === 1) blocked.push(cell)
      if (own?.get('NoBuild') === 1) noBuild.push(cell)
      if (own?.get('BlockVision') === 1 || own?.get('ShrubVision') === 1) vision.push(cell)
      if (own?.get('NearResources') === 1) nearResources.push(cell)
    }
  })
  const outline = parseFootprintShape(entity.fields?.['Shape'])
  return {
    blocked,
    noBuild,
    vision,
    ...(nearResources.length === 0 ? {} : { nearResources }),
    ...(outline === undefined ? {} : { outline }),
  }
}

export function analyzeMapCatalog(snapshot: CatalogSnapshot): MapCatalog {
  const all = snapshot.definitions ?? snapshot.entities ?? []
  const byKey = new Map(all.map(entity => [`${entity.namespace}/${entity.entityId}`, entity]))
  const get = (namespace: string, id: string) => byKey.get(`${namespace}/${id}`)
  // The class default is not merged into nested `Sets`, so it is applied here.
  const template = all.find(
    entity => entity.namespace === 'Footprint' && entity.entityId.startsWith('@default:'),
  )
  const defaults: CharacterFlags = new Map()
  if (template === undefined)
    for (const [character, flag, value] of CORE_PLACE_DEFAULT)
      defaults.set(
        character,
        (defaults.get(character) ?? new Map<string, number>()).set(flag, value),
      )
  else applyFootprintSets(defaults, placeLayer(template.fields)?.['Sets'])
  const footprints = new Map<string, Footprint | undefined>()
  const footprint = (id: string) => {
    if (!footprints.has(id)) {
      const entity = id === '' ? undefined : get('Footprint', id)
      footprints.set(id, entity === undefined ? undefined : parseFootprint(entity, defaults))
    }
    return footprints.get(id)
  }
  const turnable = (fields: Readonly<Record<string, unknown>>) =>
    !indexed(fields['FlagArray']).some(
      ([flag, value]) => flag === 'Turnable' && Number(fieldValue(value)) === 0,
    )
  const behaviors = (fields: Readonly<Record<string, unknown>>) =>
    indexed(fields['BehaviorArray']).flatMap(([, item]) => {
      const behavior = get('Behavior', text(isRecord(item) ? item['Link'] : item))
      return behavior?.fields === undefined ? [] : [behavior.fields]
    })
  const numberField = (fields: Readonly<Record<string, unknown>>, name: string) => {
    const value = Number(text(fields[name]))
    return text(fields[name]) !== '' && Number.isFinite(value) ? value : undefined
  }
  const rich = (fields: Readonly<Record<string, unknown>>, resource: string) =>
    behaviors(fields).some(
      behavior =>
        (numberField(behavior, 'HarvestAmount') ?? 0) > (STANDARD_HARVEST[resource] ?? Infinity),
    )
  const kindOf = (fields: Readonly<Record<string, unknown>>): ObjectKind => {
    const categories = text(fields['EditorCategories']).split(',')
    if (categories.includes('ObjectType:Destructible')) return 'destructible'
    if (!categories.includes('ObjectType:Resource')) return 'unit'
    const resource = text(fields['ResourceType'])
    if (resource === 'Minerals') return rich(fields, resource) ? 'rich-minerals' : 'minerals'
    if (resource === 'Vespene') return rich(fields, resource) ? 'rich-geyser' : 'geyser'
    return 'unit'
  }
  const units = new Map<string, ObjectData | undefined>()
  const doodads = new Map<string, ObjectData | undefined>()
  return {
    unit(id) {
      if (!units.has(id)) {
        const fields = get('Unit', id)?.fields
        if (fields === undefined) units.set(id, undefined)
        else {
          const own = footprint(text(fields['Footprint']))
          const radius = numberField(fields, 'Radius')
          const life = numberField(fields, 'LifeMax')
          const resources = behaviors(fields)
            .map(behavior => numberField(behavior, 'Contents'))
            .find(value => value !== undefined)
          units.set(id, {
            kind: kindOf(fields),
            turnable: turnable(fields),
            ...(own === undefined ? {} : { footprint: own }),
            ...(radius === undefined ? {} : { radius }),
            ...(life === undefined ? {} : { life }),
            ...(resources === undefined ? {} : { resources }),
          })
        }
      }
      return units.get(id)
    },
    doodad(id) {
      if (!doodads.has(id)) {
        const own = footprint(text(get('Actor', id)?.fields?.['Footprint']))
        doodads.set(
          id,
          own === undefined ? undefined : { kind: 'doodad', turnable: true, footprint: own },
        )
      }
      return doodads.get(id)
    },
    cliffFamily(setId) {
      const icon = text(get('Cliff', setId)?.fields?.['EditorIcon']).toLowerCase()
      if (icon.includes('cliffnatural')) return 'natural'
      return icon.includes('cliffmanmade') ? 'made' : undefined
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Objects: resources, blockers, start locations, units
// ---------------------------------------------------------------------------------------------

export type MapMarkerKind = ObjectKind | 'start-location'

/** A resource field's amount against the fullest field of its kind on the map. */
export type ResourceSupply = 'full' | 'reduced' | 'depleted'

export interface MapMarker {
  readonly kind: MapMarkerKind
  readonly x: number
  readonly y: number
  readonly type: string
  /** The placed object's `Id`. */
  readonly objectId?: number
  readonly player?: number
  /** `CUnit.LifeMax`. */
  readonly life?: number
  /** The footprint's outline in terrain cells, turned with the object. */
  readonly outline?: readonly Point[]
  /** Polygons in terrain cells that the object makes unwalkable. */
  readonly blocks: readonly (readonly Point[])[]
  /** Cells, as polygons, where the object forbids building. */
  readonly noBuild: readonly (readonly Point[])[]
  /** Cells, as polygons, where the object blocks sight. */
  readonly vision: readonly (readonly Point[])[]
  /** Cells, as polygons, where no town hall may stand. */
  readonly nearResources?: readonly (readonly Point[])[]
  /** `CUnit.Radius`, for units without a footprint. */
  readonly radius?: number
  /** Resource fields: the placed `Resources` amount, or the unit's starting contents. */
  readonly resources?: number
  readonly supply?: ResourceSupply
}

type PlacedShape = Pick<MapMarker, 'outline' | 'blocks' | 'noBuild' | 'vision' | 'nearResources'>

const NO_SHAPE: PlacedShape = { blocks: [], noBuild: [], vision: [] }

/** A field holding less than this share of the fullest one of its kind is a depleted one. */
const DEPLETED_SHARE = 0.1

function parsePosition(text: string): readonly [number, number] | undefined {
  const [x, y] = text.split(',').map(Number)
  return x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)
    ? undefined
    : [x, y]
}

/**
 * A footprint placed at `(x, y)`. Footprints turn in quarter turns, as the game's placement grid
 * does; objects that are not turnable keep the authored one whatever their rotation.
 */
export function placeFootprint(
  footprint: Footprint,
  x: number,
  y: number,
  rotation: number,
  turnable: boolean,
): PlacedShape {
  const quarters = turnable ? ((Math.round(rotation / (Math.PI / 2)) % 4) + 4) % 4 : 0
  const place = ([u, v]: Point): Point => {
    let [a, b] = [u, v]
    for (let k = 0; k < quarters; k += 1) [a, b] = [-b, a]
    return [x + a, y + b]
  }
  const ox = Math.floor(x) - x
  const oy = Math.floor(y) - y
  const squares = (cells: readonly Point[]) =>
    cells.map(([cx, cy]) =>
      (
        [
          [ox + cx, oy + cy],
          [ox + cx + 1, oy + cy],
          [ox + cx + 1, oy + cy + 1],
          [ox + cx, oy + cy + 1],
        ] as const
      ).map(place),
    )
  const outline = footprint.outline?.map(place)
  const blocks =
    footprint.blocked.length === 0
      ? []
      : outline === undefined
        ? squares(footprint.blocked)
        : [outline]
  return {
    ...(outline === undefined ? {} : { outline }),
    blocks,
    noBuild: squares(footprint.noBuild),
    vision: squares(footprint.vision),
    ...(footprint.nearResources === undefined
      ? {}
      : { nearResources: squares(footprint.nearResources) }),
  }
}

/**
 * Placed units, doodads with a footprint, and start locations. Kinds and footprints come from the
 * resolved catalog; without one every unit is a plain unit with no footprint.
 */
export function analyzeMapMarkers(objects: PlacedObjectsResult, catalog?: MapCatalog): MapMarker[] {
  const markers: MapMarker[] = []
  const place = (data: ObjectData | undefined, [x, y]: Point, rotation: string | undefined) =>
    data?.footprint === undefined
      ? NO_SHAPE
      : placeFootprint(data.footprint, x, y, Number(rotation ?? 0) || 0, data.turnable)
  for (const unit of objects.units) {
    const position = parsePosition(unit.position)
    if (position === undefined) continue
    const data = catalog?.unit(unit.unitType)
    const placed = Number(unit.extra['Resources'])
    const resources =
      unit.extra['Resources'] !== undefined && Number.isFinite(placed) ? placed : data?.resources
    markers.push({
      kind: data?.kind ?? 'unit',
      x: position[0],
      y: position[1],
      type: unit.unitType,
      objectId: unit.id,
      player: unit.player,
      ...place(data, position, unit.rotation),
      ...(data?.radius === undefined ? {} : { radius: data.radius }),
      ...(data?.life === undefined ? {} : { life: data.life }),
      ...(resources === undefined ? {} : { resources }),
    })
  }
  for (const doodad of objects.doodads) {
    // The editor's "no doodad footprint" placement flag drops the footprint altogether.
    if (doodad.flags.some(flag => flag.index === 'NoDoodadFootprint' && flag.value === '1'))
      continue
    const data = catalog?.doodad(doodad.type)
    const position = parsePosition(doodad.position)
    if (position === undefined || data?.footprint === undefined) continue
    const shape = place(data, position, doodad.rotation)
    if (shape.blocks.length + shape.noBuild.length + shape.vision.length === 0) continue
    markers.push({
      kind: 'doodad',
      x: position[0],
      y: position[1],
      type: doodad.type,
      objectId: doodad.id,
      ...shape,
    })
  }
  for (const point of objects.points) {
    if (point.type !== 'StartLoc') continue
    const position = parsePosition(point.position)
    if (position === undefined) continue
    markers.push({
      kind: 'start-location',
      x: position[0],
      y: position[1],
      type: point.name ?? point.type,
      ...NO_SHAPE,
    })
  }
  // Supply against the fullest field of the same kind on this map.
  const fullest = new Map<MapMarkerKind, number>()
  for (const marker of markers)
    if (marker.resources !== undefined)
      fullest.set(marker.kind, Math.max(fullest.get(marker.kind) ?? 0, marker.resources))
  return markers.map(marker => {
    const most = fullest.get(marker.kind)
    if (marker.resources === undefined || most === undefined || most <= 0) return marker
    const supply: ResourceSupply =
      marker.resources >= most
        ? 'full'
        : marker.resources < most * DEPLETED_SHARE
          ? 'depleted'
          : 'reduced'
    return { ...marker, supply }
  })
}

// ---------------------------------------------------------------------------------------------
// MapInfo: playable boundary
// ---------------------------------------------------------------------------------------------

export interface PlayableBounds {
  readonly left: number
  readonly bottom: number
  readonly right: number
  readonly top: number
}

export function analyzePlayableBounds(info: MapInfoResult): PlayableBounds | undefined {
  return info.boundary
}

// ---------------------------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------------------------

export interface MapOverviewOptions {
  /** Publish semantic overview fields alongside the native PNG; no RGB image is transported. */
  publishLattice?: boolean
  /** Pixels per terrain cell, 1 … 32 (default 8). */
  pixelsPerCell?: number
  /**
   * Unwalkable ground (painted no-pathing, blocking footprints of unmarked objects, cliff faces,
   * pockets too narrow for a unit) and, fainter, ground where nothing can be built, shaded dark;
   * vision blockers in yellow (default true).
   */
  pathing?: boolean
  /**
   * On a map without start locations, walkable patches smaller than this, in cells², are drawn
   * unwalkable (default 1). With start locations everything no path joins to them is.
   */
  minWalkableArea?: number
  /** Resources, destructibles, units and start locations (default true). */
  markers?: boolean
  /** Dim everything outside the playable area from `MapInfo` (default true). */
  bounds?: boolean
  /**
   * The `<cliffCellList>` tile lattice: a green dot at the centre of every flat tile, a cyan one
   * on every ramp tile (default false).
   */
  latticeDots?: boolean
  /** A faint cell grid over the ground, from 4 pixels per cell (default true). */
  grid?: boolean
  /**
   * The map's resolved catalog: object kinds and footprints, cliff families. Without it placed
   * units are dots, only painted pathing is shaded and every cliff is drawn as a made wall.
   */
  catalog?: CatalogSnapshot
}

export interface MapOverview {
  readonly latticeOverview?: MapLatticeOverview
  readonly width: number
  readonly height: number
  /** RGB, row 0 is the map's north edge. */
  readonly rgb: Uint8Array
}

const FACE: Rgb = [255, 255, 255]
const FLAT_DOT: Rgb = [0, 200, 0]
const RAMP_DOT: Rgb = [0, 230, 230]
const SHADE: Rgb = [0, 0, 0]
const UNWALKABLE_ALPHA = 0.45
const NO_BUILD_ALPHA = 0.2
const VISION: Rgb = [255, 215, 0]
const VISION_ALPHA = 0.55
const GRID_ALPHA = 0.08
/** A ramp's top and bottom edge: a thin white line a little brighter than the grid. */
const RAMP_EDGE_ALPHA = 0.3
const OUTLINE: Rgb = [0, 0, 0]
const OBSTACLE: Rgb = [255, 255, 255]
/** A destructible that can be walked over (a build blocker) is a see-through white. */
const BUILD_BLOCKER_ALPHA = 0.45
/** Ground at or below this level is water or abyss: never shaded. */
const WATER_LEVEL = 2
const RESOURCE_COLORS: Readonly<Record<string, Readonly<Record<ResourceSupply, Rgb>>>> = {
  minerals: { full: [60, 160, 255], reduced: [150, 205, 255], depleted: [150, 160, 175] },
  'rich-minerals': { full: [255, 195, 30], reduced: [255, 225, 140], depleted: [175, 170, 150] },
  geyser: { full: [40, 210, 100], reduced: [150, 230, 170], depleted: [150, 170, 155] },
  'rich-geyser': { full: [190, 90, 255], reduced: [220, 175, 255], depleted: [165, 155, 175] },
}
const NEUTRAL_UNIT: Rgb = [200, 200, 200]
const PLAYER_UNIT: Rgb = [255, 120, 40]
/** Players 0 and 15 are neutral and hostile; 16 is the editor's "any". */
const NEUTRAL_PLAYERS = new Set([0, 15, 16])
const START_COLORS: readonly Rgb[] = [
  [255, 60, 60],
  [60, 130, 255],
  [40, 220, 200],
  [170, 80, 230],
  [255, 230, 50],
  [255, 140, 30],
  [60, 220, 60],
  [255, 120, 200],
]
/** A start location is a town hall's 5×5 cells. */
const START_SIZE = 5
const UNIT_RADIUS = 0.4

function distanceToSegment(px: number, py: number, [ax, ay, bx, by]: Segment): number {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/** The segments of a polyline. */
function polylineSegments(points: readonly Point[], closed: boolean): Segment[] {
  const segments: Segment[] = []
  const count = closed ? points.length : points.length - 1
  for (let k = 0; k < count; k += 1) {
    const [ax, ay] = points[k]!
    const [bx, by] = points[(k + 1) % points.length]!
    segments.push([ax, ay, bx, by])
  }
  return segments
}

function circle(x: number, y: number, radius: number): Point[] {
  return Array.from({ length: 24 }, (_, k) => [
    x + radius * Math.cos((k * Math.PI) / 12),
    y + radius * Math.sin((k * Math.PI) / 12),
  ])
}

const SUBSAMPLES = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const

function pointInPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false
  for (let k = 0, previous = polygon.length - 1; k < polygon.length; previous = k, k += 1) {
    const [ax, ay] = polygon[k]!
    const [bx, by] = polygon[previous]!
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

const NO_SQUARE_CAPS = { squareStart: false, squareEnd: false } as const

/**
 * An RGB canvas addressed in terrain cells, north-up, that remembers the ground level it drew.
 * Pass an overview's `rgb` to draw on top of it (the navigation overlay does).
 */
export class OverviewCanvas {
  readonly rgb: Uint8Array
  /** Ground level per pixel. */
  readonly levels: Float32Array
  constructor(
    readonly width: number,
    readonly height: number,
    readonly scale: number,
    rgb?: Uint8Array,
  ) {
    this.rgb = rgb ?? new Uint8Array(width * height * 3)
    this.levels = new Float32Array(width * height)
  }
  pixelX(x: number) {
    return x * this.scale
  }
  pixelY(y: number) {
    return this.height - y * this.scale
  }
  /** The terrain point at a pixel's centre. */
  pointAt(px: number, py: number): Point {
    return [(px + 0.5) / this.scale, (this.height - py - 0.5) / this.scale]
  }
  put(px: number, py: number, color: Rgb) {
    const x = Math.round(px)
    const y = Math.round(py)
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.set((y * this.width + x) * 3, color)
  }
  set(o: number, color: Rgb) {
    this.rgb[o] = color[0]
    this.rgb[o + 1] = color[1]
    this.rgb[o + 2] = color[2]
  }
  /** Paint pixel `o` (not an RGB offset) with the colour of ground `level`. */
  ground(o: number, level: number) {
    this.levels[o] = level
    this.set(o * 3, cliffLevelColor(level))
  }
  blendAt(o: number, color: Rgb, alpha: number) {
    this.rgb[o] = Math.round(this.rgb[o]! * (1 - alpha) + color[0] * alpha)
    this.rgb[o + 1] = Math.round(this.rgb[o + 1]! * (1 - alpha) + color[1] * alpha)
    this.rgb[o + 2] = Math.round(this.rgb[o + 2]! * (1 - alpha) + color[2] * alpha)
  }
  /** Ground of one `level` over cells `x0..x1` × `y0..y1` (terrain units). */
  fillCells(x0: number, y0: number, x1: number, y1: number, level: number) {
    const px0 = Math.max(0, Math.round(this.pixelX(x0)))
    const px1 = Math.min(this.width, Math.round(this.pixelX(x1)))
    const py0 = Math.max(0, Math.round(this.pixelY(y1)))
    const py1 = Math.min(this.height, Math.round(this.pixelY(y0)))
    for (let py = py0; py < py1; py += 1)
      for (let px = px0; px < px1; px += 1) this.ground(py * this.width + px, level)
  }
  /** The pixel window around terrain points, grown by `margin` cells, clipped to the canvas. */
  window(points: readonly Point[], margin: number) {
    const xs = points.map(point => point[0])
    const ys = points.map(point => point[1])
    return {
      px0: Math.max(0, Math.floor(this.pixelX(Math.min(...xs) - margin))),
      px1: Math.min(this.width - 1, Math.ceil(this.pixelX(Math.max(...xs) + margin))),
      py0: Math.max(0, Math.floor(this.pixelY(Math.max(...ys) + margin))),
      py1: Math.min(this.height - 1, Math.ceil(this.pixelY(Math.min(...ys) - margin))),
    }
  }
  ink() {
    return new Float32Array(this.width * this.height)
  }
  /** Anti-aliased coverage of a line `halfWidth` pixels either side, kept as the maximum in `ink`. */
  stroke(
    ink: Float32Array,
    segment: Segment,
    halfWidth: number,
    caps: { readonly squareStart: boolean; readonly squareEnd: boolean } = NO_SQUARE_CAPS,
  ) {
    const [ax, ay, bx, by] = segment
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy || 1
    const { px0, px1, py0, py1 } = this.window(
      [
        [ax, ay],
        [bx, by],
      ],
      (halfWidth + 1) / this.scale,
    )
    for (let py = py0; py <= py1; py += 1)
      for (let px = px0; px <= px1; px += 1) {
        const [x, y] = this.pointAt(px, py)
        const t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared
        if ((caps.squareStart && t < 0) || (caps.squareEnd && t > 1)) continue
        const coverage = halfWidth + 0.5 - distanceToSegment(x, y, segment) * this.scale
        const o = py * this.width + px
        if (coverage > ink[o]!) ink[o] = Math.min(1, coverage)
      }
  }
  /** Every pixel a polygon covers, with its coverage (2×2 samples per pixel). */
  cover(polygon: readonly Point[], visit: (o: number, coverage: number) => void) {
    if (polygon.length < 3) return
    const { px0, px1, py0, py1 } = this.window(polygon, 0)
    for (let py = py0; py <= py1; py += 1)
      for (let px = px0; px <= px1; px += 1) {
        let inside = 0
        for (const [sx, sy] of SUBSAMPLES)
          if (pointInPolygon((px + sx) / this.scale, (this.height - py - sy) / this.scale, polygon))
            inside += 1
        if (inside > 0) visit(py * this.width + px, inside / 4)
      }
  }
  /** A polygon's coverage, kept as the maximum in `ink`. */
  fill(ink: Float32Array, polygon: readonly Point[]) {
    this.cover(polygon, (o, coverage) => {
      if (coverage > ink[o]!) ink[o] = coverage
    })
  }
  /** A polygon painted straight onto the canvas. */
  paint(polygon: readonly Point[], color: Rgb, alpha = 1) {
    this.cover(polygon, (o, coverage) => this.blendAt(o * 3, color, coverage * alpha))
  }
  /** Blend `color` over the canvas by `ink` coverage. */
  composite(ink: Float32Array, color: Rgb, alpha = 1) {
    for (let o = 0; o < ink.length; o += 1)
      if (ink[o]! > 0) this.blendAt(o * 3, color, Math.min(1, ink[o]!) * alpha)
  }
}

/** How far from a natural cliff line its own two levels replace the made-wall shape, in cells. */
const NATURAL_BAND = 1

/**
 * Fill each pixel near a natural cliff line with the level on its side of the nearest line
 * segment, so the ground meets the rounded line exactly. Pixels nearest an open end of a line keep
 * the tile shape underneath.
 */
function fillAlongLines(
  canvas: OverviewCanvas,
  lines: readonly { readonly line: CliffLine; readonly points: readonly Point[] }[],
): void {
  const size = canvas.width * canvas.height
  const distance = new Float32Array(size).fill(NATURAL_BAND)
  const across = new Float32Array(size)
  const level = new Int8Array(size).fill(-1)
  for (const { line, points } of lines) {
    const segments = polylineSegments(points, line.closed)
    segments.forEach(([ax, ay, bx, by], index) => {
      const dx = bx - ax
      const dy = by - ay
      const length = Math.hypot(dx, dy)
      if (length === 0) return
      const { px0, px1, py0, py1 } = canvas.window(
        [
          [ax, ay],
          [bx, by],
        ],
        NATURAL_BAND,
      )
      for (let py = py0; py <= py1; py += 1)
        for (let px = px0; px <= px1; px += 1) {
          const [x, y] = canvas.pointAt(px, py)
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (length * length)))
          const d = Math.hypot(x - ax - dx * t, y - ay - dy * t)
          const side = (dx * (y - ay) - dy * (x - ax)) / length
          const o = py * canvas.width + px
          // Where two segments share the nearest point, the one the pixel lies more squarely
          // beside decides the side.
          if (d > distance[o]! + 1e-6) continue
          if (d > distance[o]! - 1e-6 && Math.abs(side) <= Math.abs(across[o]!)) continue
          distance[o] = d
          across[o] = side
          const openEnd =
            !line.closed && ((index === 0 && t === 0) || (index === segments.length - 1 && t === 1))
          level[o] = openEnd ? -1 : side >= 0 ? line.hi : line.lo
        }
    })
  }
  for (let o = 0; o < size; o += 1) if (level[o]! >= 0) canvas.ground(o, level[o]!)
}

/**
 * Whether a painted layer covers a point `(fx, fy)` inside cell `value`, both fractions from the
 * cell's south-west corner. A cell is cut into 8 triangles by its two diagonals and its two
 * middle lines, one bit each (255 is the whole cell). Bits 0–3 are the north quadrants, 4–7 the
 * south, west before east; in a north quadrant the triangle on the side edge comes first, in a
 * south quadrant the one on the south edge. Amphion's mirrored halves store exactly the mirrored
 * masks, its cleared cliff crossings (204 | 51) make one cell-wide strip centred on a vertex,
 * and the partial row below (8 | 2) the notch the editor draws under it.
 */
export function paintedSubCell(value: number, fx: number, fy: number): boolean {
  if (value === 0 || value === 255) return value === 255
  const dx = fx - 0.5
  const dy = fy - 0.5
  const east = dx >= 0 ? 1 : 0
  const side = Math.abs(dx) > Math.abs(dy)
  const bit = dy >= 0 ? 2 * east + (side ? 0 : 1) : 4 + 2 * east + (side ? 1 : 0)
  return ((value >> bit) & 1) === 1
}

/** A painted cell mask as pixel coverage, sub-cell for sub-cell, with no smoothing. */
function paintedMaskInk(canvas: OverviewCanvas, mask: PathingMask, ink: Float32Array): void {
  for (let py = 0; py < canvas.height; py += 1) {
    const y = (canvas.height - py - 0.5) / canvas.scale
    const cy = Math.floor(y)
    if (cy < 0 || cy >= mask.sizeY) continue
    for (let px = 0; px < canvas.width; px += 1) {
      const x = (px + 0.5) / canvas.scale
      const cx = Math.floor(x)
      if (cx < mask.sizeX && paintedSubCell(mask.blocked[cy * mask.sizeX + cx]!, x - cx, y - cy))
        ink[py * canvas.width + px] = 1
    }
  }
}

/** Cliff faces own the cells either side of their line: half a cell each way. */
const CLIFF_BAND = 0.5
/** One cliff level in CLIF units. */
const LEVEL_STEP = 4
/**
 * Where beside a one-level step, in cells, the ground must be walkable for cliff walkers to climb
 * it: right past the cliff's own cells and a little further, so a sliver between the cliff and
 * painted no-pathing does not count.
 */
const CLIFF_WALK_PROBES = [0.75, 1] as const
/** Shared by minimap rendering and topology: one step and usable terrain on both sides. */
export function isCliffWalkerCrossing(
  hi: number,
  lo: number,
  x: number,
  y: number,
  nx: number,
  ny: number,
  walkableAt: (x: number, y: number, level: number) => boolean,
): boolean {
  return (
    hi - lo === LEVEL_STEP &&
    CLIFF_WALK_PROBES.every(
      d => walkableAt(x + nx * d, y + ny * d, hi) && walkableAt(x - nx * d, y - ny * d, lo),
    )
  )
}
/** Cliff lines are judged climbable in pieces no longer than this, in cells. */
const CLIMB_PIECE = 0.25
/** Walkable patches smaller than this, in cells², are drawn unwalkable when the caller gives none. */
const DEFAULT_MIN_WALKABLE_AREA = 1
/** Vision blockers are a disc per cell, no wider than the cell; the closing merges neighbours. */
const VISION_RADIUS = 0.5
/** Waists between neighbouring vision blockers narrower than this, in cells, are filled. */
const VISION_CLOSING = 0.6
const OUTSIDE_ALPHA = 0.5

/** A polyline moved `distance` to its left (right when negative), mitred at its corners. */
function offsetPolyline(points: readonly Point[], closed: boolean, distance: number): Point[] {
  const n = points.length
  const normal = (k: number): Point | undefined => {
    if (!closed && (k < 0 || k >= n - 1)) return undefined
    const [ax, ay] = points[(k + n) % n]!
    const [bx, by] = points[(k + 1) % n]!
    const length = Math.hypot(bx - ax, by - ay) || 1
    return [-(by - ay) / length, (bx - ax) / length]
  }
  return points.map(([x, y], k) => {
    const a = normal(k - 1) ?? normal(k) ?? [0, 0]
    const b = normal(k) ?? a
    const sum = Math.hypot(a[0] + b[0], a[1] + b[1])
    const [mx, my] = sum < 1e-9 ? a : [(a[0] + b[0]) / sum, (a[1] + b[1]) / sum]
    const reach = distance / Math.max(0.5, mx * a[0] + my * a[1])
    return [x + mx * reach, y + my * reach] as const
  })
}

/** A polyline to draw offset: `side` 1 moves it to its left, -1 to its right. */
export interface Strand {
  readonly points: readonly Point[]
  readonly closed: boolean
  readonly side: 1 | -1
}

/**
 * Strands moved `distance` to their side, joined where they meet. At a point where an open end
 * meets other strands, a horizontal or vertical end sets the joint: its moved end (or, for two
 * such ends at a right angle, where their moved lines cross), and every other strand through the
 * point, diagonal ends and the corners of closed outlines alike, is drawn from there. Where only
 * diagonal ends meet, each moves to where its moved line crosses the one beside it.
 */
export function offsetStrands(strands: readonly Strand[], distance: number): Point[][] {
  const moved = strands.map(strand =>
    offsetPolyline(strand.points, strand.closed, distance * strand.side),
  )
  interface Vertex {
    readonly strand: number
    readonly index: number
    /** Unit direction from an open end into its strand; undefined for any other vertex. */
    readonly into?: Point
    /** Where the vertex moves by itself. */
    readonly alone: Point
  }
  const key = ([x, y]: Point) => `${Math.round(x * 100)},${Math.round(y * 100)}`
  const groups = new Map<string, Vertex[]>()
  strands.forEach((strand, index) => {
    const n = strand.points.length
    strand.points.forEach((at, k) => {
      const open = !strand.closed && n >= 2 && (k === 0 || k === n - 1)
      let into: Point | undefined
      if (open) {
        const to = strand.points[k === 0 ? 1 : n - 2]!
        const length = Math.hypot(to[0] - at[0], to[1] - at[1]) || 1
        into = [(to[0] - at[0]) / length, (to[1] - at[1]) / length]
      }
      const vertex: Vertex = {
        strand: index,
        index: k,
        alone: moved[index]![k]!,
        ...(into === undefined ? {} : { into }),
      }
      groups.set(key(at), [...(groups.get(key(at)) ?? []), vertex])
    })
  })
  const axial = (into: Point) => Math.abs(into[0]) < 1e-6 || Math.abs(into[1]) < 1e-6
  /** Where the moved lines of two open ends cross, if they do near the point. */
  const crossing = (end: Vertex, other: Vertex): Point | undefined => {
    const u = end.into!
    const v = other.into!
    const cross = u[0] * v[1] - u[1] * v[0]
    if (Math.abs(cross) < 0.2) return undefined
    const dx = other.alone[0] - end.alone[0]
    const dy = other.alone[1] - end.alone[1]
    const t = (dx * v[1] - dy * v[0]) / cross
    if (Math.abs(t) > 4 * Math.abs(distance)) return undefined
    return [end.alone[0] + u[0] * t, end.alone[1] + u[1] * t]
  }
  for (const vertices of groups.values()) {
    const ends = vertices.filter(vertex => vertex.into !== undefined)
    if (ends.length === 0 || vertices.length < 2) continue
    const axes = ends.filter(end => axial(end.into!))
    if (axes.length > 0) {
      const square = axes.find(
        other =>
          Math.abs(axes[0]!.into![0] * other.into![0] + axes[0]!.into![1] * other.into![1]) < 1e-6,
      )
      const joint =
        (square === undefined ? undefined : crossing(axes[0]!, square)) ?? axes[0]!.alone
      for (const vertex of vertices) moved[vertex.strand]![vertex.index] = joint
      continue
    }
    // an end on the corner of another line or outline starts from that corner
    const corner = vertices.find(vertex => vertex.into === undefined)
    if (corner !== undefined) {
      for (const end of ends) moved[end.strand]![end.index] = moved[corner.strand]![corner.index]!
      continue
    }
    // only diagonal ends here: each meets the end whose own moved point lies nearest
    const joins = ends.map(end => {
      let partner: Vertex | undefined
      let nearest = Infinity
      for (const other of ends) {
        if (other === end) continue
        const gap = Math.hypot(other.alone[0] - end.alone[0], other.alone[1] - end.alone[1])
        if (gap < nearest) {
          nearest = gap
          partner = other
        }
      }
      return (partner === undefined ? undefined : crossing(end, partner)) ?? end.alone
    })
    ends.forEach((end, k) => {
      moved[end.strand]![end.index] = joins[k]!
    })
  }
  return moved
}

/** Each ramp side, walked so that its left is the wall beside the ramp. */
function rampSides(ramps: readonly RampShape[]): Segment[] {
  return ramps.flatMap(ramp =>
    ramp.sides.map(side => {
      const point = (a: number) =>
        [
          ramp.center[0] + ramp.up[0] * a + ramp.right[0] * side.lateral,
          ramp.center[1] + ramp.up[1] * a + ramp.right[1] * side.lateral,
        ] as const
      const [ax, ay] = point(side.lineTop)
      const [bx, by] = point(ramp.drawnBottom)
      // walking down the ramp, the left is (up.y, -up.x); the wall is on the side's own side
      const outward = (ramp.up[1] * ramp.right[0] - ramp.up[0] * ramp.right[1]) * side.lateral
      return (outward >= 0 ? [ax, ay, bx, by] : [bx, by, ax, ay]) as Segment
    }),
  )
}

function polygonCentre(polygon: readonly Point[]): Point {
  let x = 0
  let y = 0
  for (const [px, py] of polygon) {
    x += px
    y += py
  }
  return [x / polygon.length, y / polygon.length]
}

function splatDisk(
  target: Uint8Array,
  canvas: OverviewCanvas,
  x: number,
  y: number,
  radius: number,
) {
  const { px0, px1, py0, py1 } = canvas.window([[x, y]], radius)
  for (let py = py0; py <= py1; py += 1)
    for (let px = px0; px <= px1; px += 1) {
      const [cx, cy] = canvas.pointAt(px, py)
      if (Math.hypot(cx - x, cy - y) <= radius) target[py * canvas.width + px] = 1
    }
}

/** Squared distance from every pixel to the nearest set one (Felzenszwalb and Huttenlocher). */
function distanceField(feature: Uint8Array, width: number, height: number): Float64Array {
  const far = 1e20
  const out = new Float64Array(width * height)
  for (let o = 0; o < out.length; o += 1) out[o] = feature[o] === 1 ? 0 : far
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (length: number, offset: number, stride: number) => {
    for (let i = 0; i < length; i += 1) f[i] = out[offset + i * stride]!
    const cut = (q: number, p: number) => (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p)
    let k = 0
    v[0] = 0
    z[0] = -far
    z[1] = far
    for (let q = 1; q < length; q += 1) {
      let s = cut(q, v[k]!)
      while (s <= z[k]!) {
        k -= 1
        s = cut(q, v[k]!)
      }
      k += 1
      v[k] = q
      z[k] = s
      z[k + 1] = far
    }
    k = 0
    for (let q = 0; q < length; q += 1) {
      while (z[k + 1]! < q) k += 1
      d[q] = (q - v[k]!) ** 2 + f[v[k]!]!
    }
    for (let i = 0; i < length; i += 1) out[offset + i * stride] = d[i]!
  }
  for (let x = 0; x < width; x += 1) pass(height, x, width)
  for (let y = 0; y < height; y += 1) pass(width, y * width, 1)
  return out
}

/** `mask` closed by a disc of `radius` pixels: gaps and waists narrower than it filled. */
function closeMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const limit = radius * radius
  const fromMask = distanceField(mask, width, height)
  const outside = new Uint8Array(mask.length)
  for (let o = 0; o < mask.length; o += 1) if (fromMask[o]! > limit) outside[o] = 1
  const fromOutside = distanceField(outside, width, height)
  const closed = new Uint8Array(mask.length)
  for (let o = 0; o < mask.length; o += 1) if (fromOutside[o]! > limit) closed[o] = 1
  return closed
}

/** Free pixels that no path of free pixels (4-neighbour) joins to any of `seeds`. */
function unreachable(blocked: Uint8Array, width: number, seeds: readonly number[]) {
  const reached = new Uint8Array(blocked.length)
  const stack: number[] = []
  for (const seed of seeds)
    if (blocked[seed] === 0 && reached[seed] === 0) {
      reached[seed] = 1
      stack.push(seed)
    }
  while (stack.length > 0) {
    const o = stack.pop()!
    const x = o % width
    for (const next of [
      x > 0 ? o - 1 : -1,
      x < width - 1 ? o + 1 : -1,
      o >= width ? o - width : -1,
      o + width < blocked.length ? o + width : -1,
    ])
      if (next >= 0 && blocked[next] === 0 && reached[next] === 0) {
        reached[next] = 1
        stack.push(next)
      }
  }
  const out = new Uint8Array(blocked.length)
  for (let o = 0; o < out.length; o += 1) if (blocked[o] === 0 && reached[o] === 0) out[o] = 1
  return out
}

/**
 * Free pixels in connected patches (4-neighbour) smaller than `limit` pixels: walkable scraps
 * nothing can reach or stand on, such as a corner left between a cliff band and painted
 * no-pathing.
 */
function smallPatches(blocked: Uint8Array, width: number, height: number, limit: number) {
  const patches = new Uint8Array(blocked.length)
  if (limit <= 0) return patches
  const seen = new Uint8Array(blocked.length)
  const stack: number[] = []
  const members: number[] = []
  for (let start = 0; start < blocked.length; start += 1) {
    if (blocked[start] === 1 || seen[start] === 1) continue
    seen[start] = 1
    stack.push(start)
    members.length = 0
    while (stack.length > 0) {
      const o = stack.pop()!
      members.push(o)
      const x = o % width
      for (const next of [
        x > 0 ? o - 1 : -1,
        x < width - 1 ? o + 1 : -1,
        o >= width ? o - width : -1,
        o + width < blocked.length ? o + width : -1,
      ])
        if (next >= 0 && blocked[next] === 0 && seen[next] === 0) {
          seen[next] = 1
          stack.push(next)
        }
    }
    if (members.length < limit) for (const o of members) patches[o] = 1
  }
  return patches
}

/** Find a raw map entry by basename, case-insensitively. */
function rawEntry(map: SC2MapData, name: string): Uint8Array | undefined {
  const wanted = name.toLowerCase()
  for (const [path, bytes] of map.rawFiles ?? new Map<string, Uint8Array>())
    if (path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() === wanted) return bytes
  return undefined
}

export function renderMapOverview(map: SC2MapData, options: MapOverviewOptions = {}): MapOverview {
  if (map.height === undefined || map.terrain === undefined)
    throw new RangeError('A map overview needs t3HeightMap and t3Terrain.xml')
  const scale = Math.min(32, Math.max(1, Math.round(options.pixelsPerCell ?? 8)))
  if (options.publishLattice) {
    const columns = (map.height.sizeX - 1) * scale
    const rows = (map.height.sizeY - 1) * scale
    if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) ||
      columns <= 0 || rows <= 0 || columns * rows > 4_194_304)
      throw new RangeError('Semantic lattice overview sample budget exceeded')
  }
  const catalog = options.catalog === undefined ? undefined : analyzeMapCatalog(options.catalog)
  const vertices = analyzeVertexCliffLevels(map.height, map.terrain)
  const lattice = analyzeCliffLattice(map.terrain, vertices)
  const faces = analyzeCliffFaces(lattice)
  const ramps = analyzeRamps(map.terrain, vertices, faces)
  const natural = (map.terrain.cliffSets ?? []).map(
    id => id !== undefined && catalog?.cliffFamily(id) === 'natural',
  )
  // Melee maps are mirrored or turned about the middle of their playable area.
  const playable = map.info === undefined ? undefined : analyzePlayableBounds(map.info)
  const centre: Point =
    playable === undefined
      ? [(vertices.sizeX - 1) / 2, (vertices.sizeY - 1) / 2]
      : [(playable.left + playable.right) / 2, (playable.bottom + playable.top) / 2]
  const lines = analyzeCliffLines(lattice, index => natural[index] === true).map(line => ({
    line,
    points: line.natural ? smoothCliffLine(line, centre) : line.points,
  }))
  const cellsX = vertices.sizeX - 1
  const cellsY = vertices.sizeY - 1
  const canvas = new OverviewCanvas(cellsX * scale, cellsY * scale, scale)
  const halfLine = Math.max(1, scale / 8)

  // Ground: one colour per level tile, the cliff mesh's shape on every tile with uneven corners.
  for (let j = 0; j < lattice.sizeY; j += 1)
    for (let i = 0; i < lattice.sizeX; i += 1) {
      const corners = latticeCorners(lattice, i, j)
      if (corners.every(corner => corner === corners[0])) {
        canvas.fillCells(2 * i, 2 * j, 2 * i + 2, 2 * j + 2, corners[0]!)
        continue
      }
      const field = tileLevelField(corners)
      const px0 = 2 * i * scale
      const py0 = canvas.height - (2 * j + 2) * scale
      const size = 2 * scale
      for (let dy = 0; dy < size; dy += 1)
        for (let dx = 0; dx < size; dx += 1)
          if (py0 + dy >= 0 && px0 + dx < canvas.width)
            canvas.ground(
              (py0 + dy) * canvas.width + px0 + dx,
              field((dx + 0.5) / scale - 1, 1 - (dy + 0.5) / scale),
            )
    }
  // A map an odd number of cells wide keeps a last column/row outside the lattice.
  for (let y = 0; y < cellsY; y += 1)
    for (let x = 0; x < cellsX; x += 1)
      if (x >= 2 * lattice.sizeX || y >= 2 * lattice.sizeY)
        canvas.fillCells(x, y, x + 1, y + 1, baseLevel(vertexLevelAt(vertices, x + 0.5, y + 0.5)))
  // Natural rock: the ground follows the rounded line.
  fillAlongLines(
    canvas,
    lines.filter(({ line }) => line.natural),
  )

  // Ramps: a gradient over the whole slope, from the hi colour at its top to the lo colour at the
  // drawn bottom, between the two sides.
  for (const ramp of ramps) {
    const [left, right] = ramp.sides
    const top = (side: RampSide) => Math.max(side.lineTop, ramp.slopeTop)
    const corner = (a: number, l: number): Point => [
      ramp.center[0] + ramp.up[0] * a + ramp.right[0] * l,
      ramp.center[1] + ramp.up[1] * a + ramp.right[1] * l,
    ]
    const { px0, px1, py0, py1 } = canvas.window(
      [
        corner(top(left), left.lateral),
        corner(top(right), right.lateral),
        corner(ramp.slopeBottom, right.lateral),
        corner(ramp.slopeBottom, left.lateral),
      ],
      0,
    )
    for (let py = py0; py <= py1; py += 1)
      for (let px = px0; px <= px1; px += 1) {
        const [wx, wy] = canvas.pointAt(px, py)
        const x = wx - ramp.center[0]
        const y = wy - ramp.center[1]
        const l = x * ramp.right[0] + y * ramp.right[1]
        const t = (l - right.lateral) / (left.lateral - right.lateral)
        if (t < 0 || t > 1) continue
        const a = x * ramp.up[0] + y * ramp.up[1]
        if (a < ramp.slopeBottom || a > top(right) + (top(left) - top(right)) * t) continue
        const share = Math.min(
          1,
          Math.max(0, (a - ramp.drawnBottom) / (ramp.slopeTop - ramp.drawnBottom)),
        )
        canvas.ground(py * canvas.width + px, ramp.lo + (ramp.hi - ramp.lo) * share)
      }
  }

  if (options.grid !== false && scale >= 4)
    for (let py = 0; py < canvas.height; py += 1)
      for (let px = 0; px < canvas.width; px += 1)
        if (px % scale === 0 || (canvas.height - py) % scale === 0)
          canvas.blendAt((py * canvas.width + px) * 3, FACE, GRID_ALPHA)

  // Ramp edges: where the slope leaves the high ground and where it reaches the low ground.
  const rampEdges = canvas.ink()
  for (const ramp of ramps) {
    const [left, right] = ramp.sides
    const at = (a: number, l: number) =>
      [
        ramp.center[0] + ramp.up[0] * a + ramp.right[0] * l,
        ramp.center[1] + ramp.up[1] * a + ramp.right[1] * l,
      ] as const
    for (const a of [ramp.slopeTop, ramp.drawnBottom])
      canvas.stroke(rampEdges, [...at(a, left.lateral), ...at(a, right.lateral)], 0.5)
    // and along its left and right sides, from the bottom up to where each side's wall begins
    for (const side of ramp.sides)
      canvas.stroke(
        rampEdges,
        [
          ...at(ramp.drawnBottom, side.lateral),
          ...at(Math.max(side.lineTop, ramp.slopeTop), side.lateral),
        ],
        0.5,
      )
  }
  canvas.composite(rampEdges, FACE, RAMP_EDGE_ALPHA)

  const markers = map.objects === undefined ? [] : analyzeMapMarkers(map.objects, catalog)
  // Objects drawn with a body of their own need no shading under it.
  const marked = (marker: MapMarker) => marker.kind !== 'doodad' && marker.kind !== 'start-location'
  const size = canvas.width * canvas.height
  const water = (o: number) => canvas.levels[o]! <= WATER_LEVEL

  // Ground nothing can walk on, from the terrain alone: painted no-pathing, doodad footprints,
  // the cliff faces' own cells and every pocket too narrow for the smallest unit. Objects drawn
  // with a body of their own (resources, destructibles, units) only block their own shape and
  // make no pockets: the cells beside them stay open.
  const terrainBlocked = new Uint8Array(size)
  const objectBlocked = new Uint8Array(size)
  const noBuild = new Uint8Array(size)
  const vision = new Uint8Array(size)
  const mark = (target: Uint8Array, ink: Float32Array) => {
    for (let o = 0; o < size; o += 1) if (ink[o]! >= 0.5) target[o] = 1
  }
  const painted = (name: string) => {
    const bytes = rawEntry(map, name)
    const ink = canvas.ink()
    if (bytes !== undefined)
      paintedMaskInk(
        canvas,
        analyzeNoPathing(readCellAttribute(bytes, { sizeX: cellsX, sizeY: cellsY })),
        ink,
      )
    return ink
  }
  mark(terrainBlocked, painted('CellAttribute_Pnp'))
  for (const marker of markers) {
    const blocks = canvas.ink()
    for (const polygon of marker.blocks) canvas.fill(blocks, polygon)
    mark(marked(marker) ? objectBlocked : terrainBlocked, blocks)
  }
  // Painted "clear pathing" (`CellAttribute_Pcl`) opens ground, cliffs included: Amphion's
  // passages beside the centre pits cross a cliff there.
  const cleared = new Uint8Array(size)
  mark(cleared, painted('CellAttribute_Pcl'))
  const clear = () => {
    for (let o = 0; o < size; o += 1) if (cleared[o] === 1) terrainBlocked[o] = 0
  }
  const clearedAt = (x: number, y: number) => {
    const px = Math.floor(x * scale)
    const py = Math.floor(canvas.height - y * scale)
    return (
      px >= 0 &&
      py >= 0 &&
      px < canvas.width &&
      py < canvas.height &&
      cleared[py * canvas.width + px] === 1
    )
  }
  clear()
  /** Walkable ground of cliff `level` at a terrain point. */
  const walkableAt = (x: number, y: number, level: number) => {
    const px = Math.floor(x * scale)
    const py = Math.floor(canvas.height - y * scale)
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false
    const o = py * canvas.width + px
    return (
      terrainBlocked[o] === 0 &&
      objectBlocked[o] === 0 &&
      !water(o) &&
      Math.abs(canvas.levels[o]! - level) < 0.5
    )
  }
  // Lines are drawn half a line width into their high ground, ramp sides into their ramp, and
  // meet in one point where their ends meet.
  const sides = rampSides(ramps)
  const drawn = offsetStrands(
    [
      ...lines.map(({ line, points }) => ({ points, closed: line.closed, side: 1 as const })),
      ...sides.map(([ax, ay, bx, by]) => ({
        points: [
          [ax, ay],
          [bx, by],
        ] as Point[],
        closed: false,
        side: -1 as const,
      })),
    ],
    halfLine / scale,
  )
  const drawnSides = drawn.slice(lines.length).map(([a, b]) => [...a!, ...b!] as Segment)
  // A one-level step with walkable ground on both sides is where cliff walkers climb: its line
  // is solid with a gap at either end of the stretch, and its cells are not shaded.
  const lineFaces = lines.map(({ line, points }, lineIndex) => {
    const moved = polylineSegments(drawn[lineIndex]!, line.closed)
    return {
      closed: line.closed,
      pieces: polylineSegments(points, line.closed).flatMap(([ax, ay, bx, by], index) => {
        const [mx0, my0, mx1, my1] = moved[index]!
        const length = Math.hypot(bx - ax, by - ay)
        const nx = -(by - ay) / (length || 1)
        const ny = (bx - ax) / (length || 1)
        // Each short piece on its own: the high ground beside it on the left and the low ground on
        // the right. A probe that crosses into another arm of the cliff (near a V-shaped tip) lands
        // on the wrong level, so only the pieces there are ruled out.
        const count = Math.max(1, Math.ceil(length / CLIMB_PIECE))
        return Array.from({ length: count }, (_, piece) => {
          const from = piece / count
          const to = (piece + 1) / count
          const x = ax + (bx - ax) * ((from + to) / 2)
          const y = ay + (by - ay) * ((from + to) / 2)
          // A cliff crossing cleared ground is walkable like a climbable one.
          const open = clearedAt(x, y)
          const climbable =
            open ||
            isCliffWalkerCrossing(line.hi, line.lo, x, y, nx, ny, walkableAt)
          const segment: Segment = [
            mx0 + (mx1 - mx0) * from,
            my0 + (my1 - my0) * from,
            mx0 + (mx1 - mx0) * to,
            my0 + (my1 - my0) * to,
          ]
          return { segment, walkable: climbable, open }
        })
      }),
    }
  })
  /** Pieces of a line with their neighbours, and whether each ends a walkable stretch. */
  const walkOf = ({ closed, pieces }: (typeof lineFaces)[number]) => {
    const at = (k: number) => pieces[closed ? (k + pieces.length) % pieces.length : k]
    const walkable = (k: number) => at(k)?.walkable === true
    const gap = (k: number) => walkable(k) && (!walkable(k - 1) || !walkable(k + 1))
    return { at, walkable, gap }
  }
  const faceInk = canvas.ink()
  // A cliff's own cells; they stop square where a walkable stretch begins.
  for (const face of lineFaces) {
    const { at, walkable } = walkOf(face)
    face.pieces.forEach(({ segment }, k) => {
      if (walkable(k)) return
      canvas.stroke(faceInk, segment, CLIFF_BAND * scale, {
        squareStart: walkable(k - 1),
        squareEnd: walkable(k + 1) && at(k + 1) !== undefined,
      })
    })
  }
  for (const side of drawnSides) canvas.stroke(faceInk, side, CLIFF_BAND * scale)
  mark(terrainBlocked, faceInk)
  clear()
  // Walkable ground no player can walk to from a start location is unwalkable too, such as a lone
  // rise between cliffs. Every cliff is a barrier here, climbable ones included, unless cleared.
  // A map without start locations only loses scraps smaller than `minWalkableArea`.
  const barrier = terrainBlocked.map((value, o) => (value === 1 || water(o) ? 1 : 0))
  const climbInk = canvas.ink()
  for (const { pieces } of lineFaces)
    for (const face of pieces)
      if (face.walkable && !face.open) canvas.stroke(climbInk, face.segment, CLIFF_BAND * scale)
  for (let o = 0; o < size; o += 1) if (climbInk[o]! >= 0.5 && cleared[o] === 0) barrier[o] = 1
  const seeds = markers
    .filter(marker => marker.kind === 'start-location')
    .map(marker => {
      const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(marker.x * scale)))
      const py = Math.min(
        canvas.height - 1,
        Math.max(0, Math.floor(canvas.height - marker.y * scale)),
      )
      return py * canvas.width + px
    })
  const patchArea = Math.max(0, options.minWalkableArea ?? DEFAULT_MIN_WALKABLE_AREA)
  const pockets =
    seeds.length > 0
      ? unreachable(barrier, canvas.width, seeds)
      : smallPatches(barrier, canvas.width, canvas.height, patchArea * scale * scale)
  for (let o = 0; o < size; o += 1) if (pockets[o] === 1) terrainBlocked[o] = 1
  clear()

  let visionArea = vision
  if (options.pathing !== false) {
    mark(noBuild, painted('CellAttribute_Pnb'))
    for (const marker of markers) {
      if (!marked(marker)) {
        const ink = canvas.ink()
        for (const polygon of marker.noBuild) canvas.fill(ink, polygon)
        mark(noBuild, ink)
      }
      for (const polygon of marker.vision) {
        const [cx, cy] = polygonCentre(polygon)
        splatDisk(vision, canvas, cx, cy, VISION_RADIUS)
      }
    }
    for (let o = 0; o < size; o += 1) {
      if (water(o)) continue
      if (terrainBlocked[o] === 1) canvas.blendAt(o * 3, SHADE, UNWALKABLE_ALPHA)
      else if (noBuild[o] === 1) canvas.blendAt(o * 3, SHADE, NO_BUILD_ALPHA)
    }
    visionArea = closeMask(vision, canvas.width, canvas.height, VISION_CLOSING * scale)
    for (let o = 0; o < size; o += 1)
      if (visionArea[o] === 1) canvas.blendAt(o * 3, VISION, VISION_ALPHA)
  }

  // Cliff lines and ramp sides; a walkable stretch loses its first and last piece.
  const ink = canvas.ink()
  for (const face of lineFaces) {
    const { at, gap } = walkOf(face)
    face.pieces.forEach(({ segment }, k) => {
      if (gap(k)) return
      canvas.stroke(ink, segment, halfLine, {
        squareStart: at(k - 1) !== undefined && gap(k - 1),
        squareEnd: at(k + 1) !== undefined && gap(k + 1),
      })
    })
  }
  for (const side of drawnSides) canvas.stroke(ink, side, halfLine)
  canvas.composite(ink, FACE)

  if (options.latticeDots === true)
    for (let j = 0; j < lattice.sizeY; j += 1)
      for (let i = 0; i < lattice.sizeX; i += 1) {
        const role = lattice.roles[j * lattice.sizeX + i]
        if (role === TILE_FLAT)
          canvas.put(canvas.pixelX(2 * i + 1), canvas.pixelY(2 * j + 1), FLAT_DOT)
        else if (role === TILE_RAMP)
          canvas.put(canvas.pixelX(2 * i + 1), canvas.pixelY(2 * j + 1), RAMP_DOT)
      }

  const semanticMarkers: MapLatticeOverview['markers'][number][] = []
  let currentMarker: MapMarker | undefined
  let markerOrdinal = 0
  /** Record the same resolved body the native renderer draws, without reclassifying catalogs. */
  const recordBody = (polygon: readonly Point[], color: Rgb, opacity: number) => {
    if (!options.publishLattice || currentMarker === undefined) return
    const marker = currentMarker
    const resource = ['minerals','rich-minerals','geyser','rich-geyser'].includes(marker.kind)
    semanticMarkers.push({
      id: `marker:${marker.objectId ?? marker.type}:${markerOrdinal++}`,
      role: resource ? 'resource' : marker.kind === 'destructible' ? 'destructible' : 'unit',
      point: [marker.x,marker.y], outline: polygon, color, opacity,
      ...(resource ? {resourceKind:marker.kind, resourceVariant:marker.kind.startsWith('rich-') ? 'rich' as const : 'ordinary' as const,
        resourceState:marker.supply ?? 'full'} : {}),
      ...(marker.player === undefined ? {} : {player:marker.player}),
    })
  }

  // Placed units: a body with a black outline. Doodads stay part of the shaded ground.
  if (options.markers !== false) {
    const outlines = canvas.ink()
    const body = (polygon: readonly Point[], color: Rgb, alpha = 1) => {
      recordBody(polygon, color, alpha)
      canvas.paint(polygon, color, alpha)
      for (const segment of polylineSegments(polygon, true)) canvas.stroke(outlines, segment, 0.5)
    }
    const starts: MapMarker[] = []
    for (const marker of markers) {
      currentMarker = marker
      switch (marker.kind) {
        case 'start-location':
          starts.push(marker)
          break
        case 'minerals':
        case 'rich-minerals':
        case 'geyser':
        case 'rich-geyser':
          body(
            marker.outline ?? circle(marker.x, marker.y, marker.radius ?? UNIT_RADIUS),
            RESOURCE_COLORS[marker.kind]![marker.supply ?? 'full'],
          )
          break
        case 'destructible': {
          // An obstacle is solid white; one that only stops building is see-through.
          const alpha = marker.blocks.length > 0 ? 1 : BUILD_BLOCKER_ALPHA
          if (marker.outline !== undefined) body(marker.outline, OBSTACLE, alpha)
          else if (marker.blocks.length > 0)
            for (const polygon of marker.blocks) body(polygon, OBSTACLE, alpha)
          else if (marker.noBuild.length > 0)
            for (const polygon of marker.noBuild) body(polygon, OBSTACLE, alpha)
          else body(circle(marker.x, marker.y, marker.radius ?? UNIT_RADIUS), OBSTACLE, alpha)
          break
        }
        case 'unit':
          body(
            marker.outline ?? circle(marker.x, marker.y, marker.radius ?? UNIT_RADIUS),
            NEUTRAL_PLAYERS.has(marker.player ?? 0) ? NEUTRAL_UNIT : PLAYER_UNIT,
          )
          break
        case 'doodad':
          break
      }
    }
    canvas.composite(outlines, OUTLINE, 0.9)
    // Start locations: the town hall's cells in the player's colour, on top.
    starts.forEach((marker, index) => {
      const color = START_COLORS[index % START_COLORS.length]!
      const half = START_SIZE / 2
      const square = canvas.ink()
      const corners: Point[] = [
        [marker.x - half, marker.y - half],
        [marker.x + half, marker.y - half],
        [marker.x + half, marker.y + half],
        [marker.x - half, marker.y + half],
      ]
      if (options.publishLattice) semanticMarkers.push({
        id:`start:${index}`, role:'start', point:[marker.x,marker.y], outline:corners,
        color, opacity:1, ...(marker.player === undefined ? {} : {player:marker.player}),
      })
      for (const segment of polylineSegments(corners, true))
        canvas.stroke(square, segment, Math.max(1, scale / 6))
      canvas.composite(square, color)
      canvas.paint(circle(marker.x, marker.y, 0.75), color)
    })
  }

  // Outside the playable area everything is dimmed, lines and markers included.
  if (options.bounds !== false && map.info !== undefined) {
    const bounds = analyzePlayableBounds(map.info)
    if (bounds !== undefined)
      for (let py = 0; py < canvas.height; py += 1)
        for (let px = 0; px < canvas.width; px += 1) {
          const [x, y] = canvas.pointAt(px, py)
          if (x < bounds.left || x > bounds.right || y < bounds.bottom || y > bounds.top)
            canvas.blendAt((py * canvas.width + px) * 3, SHADE, OUTSIDE_ALPHA)
        }
  }
  const overviewEntities = new Set((options.catalog?.definitions ?? options.catalog?.entities ?? []).map(entity=>`${entity.namespace}/${entity.entityId}`))
  const catalogReady = options.catalog !== undefined && overviewCatalogQueries(options.catalog).every(ref=>overviewEntities.has(`${ref.namespace}/${ref.entityId}`)) &&
    (map.objects?.units.every(unit=>catalog?.unit(unit.unitType)!==undefined) ?? true)
  const latticeOverview: MapLatticeOverview | undefined = options.publishLattice ? validateLatticeOverview({
    provenance:{method:'native-terrain-overview',quality:'derived',complete:catalogReady},
    raster:{columns:canvas.width,rows:canvas.height,origin:[0,cellsY],columnStep:[1/scale,0],rowStep:[0,-1/scale],
      elevation:encodeLatticeRunRows(canvas.width,canvas.height,(x,y)=>canvas.levels[y*canvas.width+x]!),
      palette:LEVEL_ANCHORS.map(([value,color])=>({value,color})),
      ...(catalogReady ? {
      movementProfile:'blizzard/starcraft-2:standard-ground',
      blocked:encodeLatticeRunRows(canvas.width,canvas.height,(x,y)=>water(y*canvas.width+x)?0:terrainBlocked[y*canvas.width+x]!),
      noBuild:encodeLatticeRunRows(canvas.width,canvas.height,(x,y)=>water(y*canvas.width+x)?0:noBuild[y*canvas.width+x]!),
      vision:encodeLatticeRunRows(canvas.width,canvas.height,(x,y)=>water(y*canvas.width+x)?0:visionArea[y*canvas.width+x]!),
      } : {}),
    },
    lines:[...lineFaces.flatMap(face=>{
      const {gap}=walkOf(face)
      return face.pieces.flatMap(({segment},i)=>gap(i)?[]:[{role:'cliff',points:[[segment[0],segment[1]],[segment[2],segment[3]]],closed:false}])
    }),...drawnSides.map(segment=>({role:'cliff',points:[[segment[0],segment[1]],[segment[2],segment[3]]],closed:false})),
    ...ramps.flatMap(ramp=>{
      const [left,right]=ramp.sides
      const at=(a:number,l:number):Point=>[ramp.center[0]+ramp.up[0]*a+ramp.right[0]*l,ramp.center[1]+ramp.up[1]*a+ramp.right[1]*l]
      return [ramp.slopeTop,ramp.drawnBottom].map(a=>({role:'ramp',points:[at(a,left.lateral),at(a,right.lateral)],closed:false}))
    })],
    markers:semanticMarkers,
    ...(playable===undefined?{}:{playableArea:[[playable.left,playable.bottom],[playable.right,playable.bottom],[playable.right,playable.top],[playable.left,playable.top]]}),
  }) : undefined
  return { width: canvas.width, height: canvas.height, rgb: canvas.rgb, ...(latticeOverview === undefined ? {} : {latticeOverview}) }
}

export function mapOverviewToPng(map: SC2MapData, options: MapOverviewOptions = {}): Uint8Array {
  const overview = renderMapOverview(map, options)
  return encodeRGB8(overview.width, overview.height, overview.rgb)
}

// ---------------------------------------------------------------------------------------------

function gridToPng(
  sizeX: number,
  sizeY: number,
  pixelsPerItem: number | undefined,
  colorAt: (index: number) => Rgb,
): Uint8Array {
  const scale = Math.min(32, Math.max(1, Math.round(pixelsPerItem ?? 1)))
  const width = sizeX * scale
  const height = sizeY * scale
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < sizeY; y += 1)
    for (let x = 0; x < sizeX; x += 1) {
      const color = colorAt(y * sizeX + x)
      for (let dy = 0; dy < scale; dy += 1) {
        let o = (((sizeY - 1 - y) * scale + dy) * width + x * scale) * 3
        for (let dx = 0; dx < scale; dx += 1, o += 3) {
          rgb[o] = color[0]
          rgb[o + 1] = color[1]
          rgb[o + 2] = color[2]
        }
      }
    }
  return encodeRGB8(width, height, rgb)
}

/** Shared owner projection used by the native overview and world/UVW publication. */
export function analyzeMapOverview(map: SC2MapData, options: Omit<MapOverviewOptions,'publishLattice'> = {}): MapLatticeOverview {
  return renderMapOverview(map,{...options,publishLattice:true}).latticeOverview!
}
