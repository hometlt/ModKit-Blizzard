/**
 * Game-agnostic grid algorithms for map navigation analysis: connected components, distance
 * fields, clearance, polygon rasterization and spatial clustering. Cells are row-major
 * (`y * width + x`), `y = 0` at the map's bottom, one cell per world unit.
 *
 * Every routine visits cells and neighbours in a fixed order, so results are deterministic.
 */

import { weightedDistanceField } from '@modkit/codec-kit/graph/weighted-distance'

export type Point = readonly [number, number]

export interface GridSize {
  readonly width: number
  readonly height: number
}

/** 8-neighbourhood: 4 straight neighbours first, then the diagonals. */
const STEPS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
]

export const cellOf = (size: GridSize, x: number, y: number): number =>
  Math.floor(y) * size.width + Math.floor(x)

/** The centre of a cell in world units. */
export const centreOf = (size: GridSize, cell: number): Point => [
  (cell % size.width) + 0.5,
  Math.floor(cell / size.width) + 0.5,
]

export const inside = (size: GridSize, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < size.width && y < size.height

/**
 * 4-connected components of the set cells of `mask`. Labels start at 1 and follow the row-major
 * order of each component's first cell; 0 is "not in the mask".
 */
export function labelComponents(
  size: GridSize,
  mask: Uint8Array,
  canStep?: (from: number, to: number) => boolean,
): { labels: Int32Array; count: number; areas: number[] } {
  const labels = new Int32Array(mask.length)
  const areas: number[] = [0]
  const stack: number[] = []
  let count = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || labels[start] !== 0) continue
    count += 1
    labels[start] = count
    let area = 0
    stack.push(start)
    while (stack.length > 0) {
      const cell = stack.pop()!
      area += 1
      const x = cell % size.width
      const y = (cell - x) / size.width
      for (let k = 0; k < 4; k += 1) {
        const nx = x + STEPS[k]![0]
        const ny = y + STEPS[k]![1]
        if (!inside(size, nx, ny)) continue
        const next = ny * size.width + nx
        if (mask[next] === 1 && labels[next] === 0 && (canStep?.(cell, next) ?? true)) {
          labels[next] = count
          stack.push(next)
        }
      }
    }
    areas.push(area)
  }
  return { labels, count, areas }
}

/**
 * Octile ground distance from `sources` to every cell `passable` allows (diagonal steps may not
 * cut a blocked corner). Unreached cells are `Infinity`. `limit` stops the search early.
 */
export function distanceField(
  size: GridSize,
  passable: Uint8Array,
  sources: readonly number[],
  limit = Infinity,
  costs?: Float32Array,
  partition?: { readonly owners: Int32Array; readonly protected?: Int32Array },
  canStep?: (from: number, to: number) => boolean,
): Float64Array {
  return weightedDistanceField(
    passable.length,
    sources,
    (cell, emit) => {
      const x = cell % size.width
      const y = (cell - x) / size.width
      for (const [dx, dy, cost] of STEPS) {
        const nx = x + dx
        const ny = y + dy
        if (!inside(size, nx, ny)) continue
        const next = ny * size.width + nx
        if (passable[next] !== 1) continue
        if (canStep !== undefined && !canStep(cell, next)) continue
        if (partition?.protected?.[next] && partition.protected[next] !== partition.owners[cell])
          continue
        if (
          dx !== 0 &&
          dy !== 0 &&
          (passable[y * size.width + nx] !== 1 ||
            passable[ny * size.width + x] !== 1 ||
            (canStep !== undefined &&
              (!canStep(cell, y * size.width + nx) ||
                !canStep(y * size.width + nx, next) ||
                !canStep(cell, ny * size.width + x) ||
                !canStep(ny * size.width + x, next))))
        )
          continue
        emit(next, cost * (costs?.[next] ?? 1))
      }
    },
    {
      limit,
      acceptSource: cell => passable[cell] === 1,
      onSource: (cell, source) => {
        if (partition !== undefined) partition.owners[cell] = source + 1
      },
      onImprove: (cell, next) => {
        if (partition !== undefined) partition.owners[next] = partition.owners[cell]!
      },
    },
  ).distances
}

/** Walk down a distance field from `cell` to a source: the cells of a shortest path. */
export function descend(
  size: GridSize,
  distance: Float64Array,
  cell: number,
  costs?: Float32Array,
  canStep?: (from: number, to: number) => boolean,
): number[] {
  const path = [cell]
  let current = cell
  while (distance[current]! > 0 && Number.isFinite(distance[current]!)) {
    const x = current % size.width
    const y = (current - x) / size.width
    let best = current
    for (const [dx, dy, cost] of STEPS) {
      const nx = x + dx
      const ny = y + dy
      if (!inside(size, nx, ny)) continue
      const next = ny * size.width + nx
      if (canStep !== undefined && !canStep(next, current)) continue
      if (
        dx !== 0 &&
        dy !== 0 &&
        (!Number.isFinite(distance[y * size.width + nx]!) ||
          !Number.isFinite(distance[ny * size.width + x]!) ||
          (canStep !== undefined &&
            (!canStep(current, y * size.width + nx) ||
              !canStep(y * size.width + nx, next) ||
              !canStep(current, ny * size.width + x) ||
              !canStep(ny * size.width + x, next))))
      )
        continue
      if (
        Math.abs(distance[next]! + cost * (costs?.[current] ?? 1) - distance[current]!) < 1e-6 &&
        distance[next]! < distance[best]!
      )
        best = next
    }
    if (best === current) break
    path.push(best)
    current = best
  }
  return path
}

/**
 * Clearance of every set cell of `mask`: the octile distance to the nearest unset cell or the
 * grid edge (a lone cell has clearance 1).
 */
export function clearanceField(size: GridSize, mask: Uint8Array): Float64Array {
  const open = new Uint8Array(mask.length).fill(1)
  const sources: number[] = []
  for (let cell = 0; cell < mask.length; cell += 1) {
    const x = cell % size.width
    const y = (cell - x) / size.width
    const edge = x === 0 || y === 0 || x === size.width - 1 || y === size.height - 1
    if (mask[cell] !== 1) sources.push(cell)
    else if (edge) sources.push(cell)
  }
  const distance = distanceField(size, open, sources)
  for (let cell = 0; cell < mask.length; cell += 1) {
    if (mask[cell] !== 1) distance[cell] = 0
    else {
      const x = cell % size.width
      const y = (cell - x) / size.width
      const edge = x === 0 || y === 0 || x === size.width - 1 || y === size.height - 1
      distance[cell] = edge ? 1 : distance[cell]!
    }
  }
  return distance
}

export function pointInPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let within = false
  for (let k = 0, previous = polygon.length - 1; k < polygon.length; previous = k, k += 1) {
    const [ax, ay] = polygon[k]!
    const [bx, by] = polygon[previous]!
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within
  }
  return within
}

/** The cells whose centre lies inside `polygon`, in row-major order. */
export function rasterizePolygon(size: GridSize, polygon: readonly Point[]): number[] {
  if (polygon.length < 3) return []
  const xs = polygon.map(point => point[0])
  const ys = polygon.map(point => point[1])
  const x0 = Math.max(0, Math.floor(Math.min(...xs)))
  const x1 = Math.min(size.width - 1, Math.ceil(Math.max(...xs)))
  const y0 = Math.max(0, Math.floor(Math.min(...ys)))
  const y1 = Math.min(size.height - 1, Math.ceil(Math.max(...ys)))
  const cells: number[] = []
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1)
      if (pointInPolygon(x + 0.5, y + 0.5, polygon)) cells.push(y * size.width + x)
  return cells
}

/** Disjoint sets over `0 … count-1`. */
export class DisjointSets {
  private readonly parent: Int32Array
  constructor(count: number) {
    this.parent = Int32Array.from({ length: count }, (_, index) => index)
  }
  find(item: number): number {
    let root = item
    while (this.parent[root] !== root) root = this.parent[root]!
    while (this.parent[item] !== root) {
      const next = this.parent[item]!
      this.parent[item] = root
      item = next
    }
    return root
  }
  union(a: number, b: number) {
    const ra = this.find(a)
    const rb = this.find(b)
    // The smaller index is the root, so group order follows item order.
    if (ra < rb) this.parent[rb] = ra
    else if (rb < ra) this.parent[ra] = rb
  }
  /** Groups of item indices, ordered by their first item. */
  groups(): number[][] {
    const byRoot = new Map<number, number[]>()
    for (let item = 0; item < this.parent.length; item += 1) {
      const root = this.find(item)
      const group = byRoot.get(root)
      if (group === undefined) byRoot.set(root, [item])
      else group.push(item)
    }
    return [...byRoot.values()]
  }
}

/** A uniform spatial hash of points, for neighbour queries without comparing every pair. */
export class SpatialHash {
  private readonly buckets = new Map<string, number[]>()
  constructor(
    private readonly points: readonly Point[],
    private readonly bucket: number,
  ) {
    points.forEach((point, index) => {
      const key = this.key(point[0], point[1])
      const list = this.buckets.get(key)
      if (list === undefined) this.buckets.set(key, [index])
      else list.push(index)
    })
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.bucket)},${Math.floor(y / this.bucket)}`
  }
  /** Indices of the points within `radius` of `(x, y)`, in index order. */
  near(x: number, y: number, radius: number): number[] {
    const found: number[] = []
    const reach = Math.ceil(radius / this.bucket)
    const bx = Math.floor(x / this.bucket)
    const by = Math.floor(y / this.bucket)
    for (let dy = -reach; dy <= reach; dy += 1)
      for (let dx = -reach; dx <= reach; dx += 1)
        for (const index of this.buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          const [px, py] = this.points[index]!
          if (Math.hypot(px - x, py - y) <= radius) found.push(index)
        }
    return found.sort((a, b) => a - b)
  }
}

/** Single-linkage clusters of points closer than `link`, ordered by their first point. */
export function clusterPoints(points: readonly Point[], link: number): number[][] {
  const sets = new DisjointSets(points.length)
  const hash = new SpatialHash(points, Math.max(1, link))
  points.forEach(([x, y], index) => {
    for (const other of hash.near(x, y, link)) if (other > index) sets.union(index, other)
  })
  return sets.groups()
}
