/**
 * The normalized map a navigation analysis runs on, independent of any game's file layout: cell
 * masks for the terrain alone and a list of removable or permanent blockers with their cells.
 * Current walkability and buildability are derived from them, so every question of the kind
 * "walkable if these rocks were gone?" is a mask with some blockers left out.
 */

import type { GridSize, Point } from './grid.js'

export type BlockerKind = 'destructible' | 'mineral' | 'geyser' | 'neutral'

export interface SpatialBlocker {
  /** Stable id, e.g. the placed object's id. */
  readonly id: string
  readonly kind: BlockerKind
  /** The object's type id (data only, never used to classify it). */
  readonly type: string
  readonly x: number
  readonly y: number
  /** Cells the object keeps ground units off. */
  readonly cells: readonly number[]
  /** Cells the object keeps buildings off. */
  readonly placementCells: readonly number[]
  /** Cells where no town hall may stand because of this resource. */
  readonly nearResourceCells?: readonly number[]
  /** Hit points to destroy it, when known. */
  readonly life?: number
  /** Resources left in a mineral field or geyser. */
  readonly resources?: number
  /** A field yielding more per trip than a standard one. */
  readonly rich?: boolean
}

export interface MapSpatialData extends GridSize {
  /** Optional current ground sampling at finer world resolution, for narrow passages and paths. */
  readonly groundSampling?: GridSize & {
    readonly cellSize: number
    readonly walkable: Uint8Array
    readonly level: Float32Array
    readonly ramp: Uint8Array
  }
  /** Authored ramp frames, when the source format supplies them. */
  readonly rampShapes?: readonly {
    readonly center: Point
    readonly direction: Point
    readonly lower: Point
    readonly upper: Point
    readonly width: number
    readonly lowerLevel?: number
    readonly upperLevel?: number
  }[]
  /** Crossings tested against the same cliff geometry and side probes as the minimap. */
  readonly cliffCrossings?: readonly {
    readonly a: Point
    readonly b: Point
    readonly width: number
    readonly levelA: number
    readonly levelB: number
  }[]
  /** The playable area, in cells. */
  readonly bounds: {
    readonly left: number
    readonly bottom: number
    readonly right: number
    readonly top: number
  }
  /** Ground a unit can walk on with every removable blocker gone (painted pathing, cliffs, doodads). */
  readonly terrainWalkable: Uint8Array
  /** Ground a building can stand on with every removable blocker gone. */
  readonly terrainBuildable: Uint8Array
  /** Walkable slope cells between two cliff levels. */
  readonly ramp: Uint8Array
  /** Cells unwalkable because a cliff face runs through them (not painted, not doodads). */
  readonly cliff: Uint8Array
  /** Cells kept unwalkable by painted pathing or permanent doodads. */
  readonly painted: Uint8Array
  /** Cliff level per cell (0, 1, 2, …; fractional on ramps). */
  readonly level: Float32Array
  readonly blockers: readonly SpatialBlocker[]
  readonly startLocations: readonly Point[]
}

/** Terrain walkability minus every blocker whose id `present` accepts. */
export function walkableMask(
  data: MapSpatialData,
  present: (blocker: SpatialBlocker) => boolean = () => true,
): Uint8Array {
  const mask = data.terrainWalkable.slice()
  for (const blocker of data.blockers)
    if (present(blocker)) for (const cell of blocker.cells) mask[cell] = 0
  return mask
}

/** Open neighbouring cells are not necessarily connected: a cliff needs a slope or capability. */
export function canGroundStep(data: MapSpatialData, from: number, to: number): boolean {
  return (
    Math.abs(data.level[from]! - data.level[to]!) < 0.75 ||
    data.ramp[from] === 1 ||
    data.ramp[to] === 1
  )
}

/** Terrain buildability minus every blocker whose id `present` accepts. */
export function buildableMask(
  data: MapSpatialData,
  present: (blocker: SpatialBlocker) => boolean = () => true,
): Uint8Array {
  const mask = data.terrainBuildable.slice()
  for (const blocker of data.blockers)
    if (present(blocker))
      for (const cell of [...blocker.cells, ...blocker.placementCells]) mask[cell] = 0
  return mask
}

/** A mask of the cells of the given blocker kinds. */
export function blockerMask(data: MapSpatialData, kinds: readonly BlockerKind[]): Uint8Array {
  const mask = new Uint8Array(data.width * data.height)
  for (const blocker of data.blockers)
    if (kinds.includes(blocker.kind)) for (const cell of blocker.cells) mask[cell] = 1
  return mask
}

/**
 * An empty spatial map, all walkable and buildable at level 0: the starting point for synthetic
 * maps (tests) and for adapters that fill masks in themselves.
 */
export function blankSpatialData(
  width: number,
  height: number,
): MapSpatialData & {
  terrainWalkable: Uint8Array
  terrainBuildable: Uint8Array
  blockers: SpatialBlocker[]
  startLocations: Point[]
} {
  const cells = width * height
  return {
    width,
    height,
    bounds: { left: 0, bottom: 0, right: width, top: height },
    terrainWalkable: new Uint8Array(cells).fill(1),
    terrainBuildable: new Uint8Array(cells).fill(1),
    ramp: new Uint8Array(cells),
    cliff: new Uint8Array(cells),
    painted: new Uint8Array(cells),
    level: new Float32Array(cells),
    blockers: [],
    startLocations: [],
  }
}
