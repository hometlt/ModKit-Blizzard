/**
 * StarCraft II map → `MapSpatialData`, from the documents the map overview already reads:
 *
 * - `t3HeightMap` + `t3Terrain.xml`: cliff level per vertex (`heightAdjustments`). A cell whose
 *   corners span a cliff step is a cliff face; a walkable cell with fractional or uneven corners
 *   is a ramp slope.
 * - `CellAttribute_Pnp` / `CellAttribute_Pnb`: painted no-pathing / no-building, one byte a cell
 *   (any non-zero value: mirrored brush strokes store `v` or `255 - v`).
 * - `CellAttribute_Pcl`: painted "clear pathing": walkable even across a cliff face.
 * - `MapInfo`: the playable bounds; everything outside is unwalkable.
 * - `Objects` + the resolved catalog: placed units and doodads with their turned `CFootprint`
 *   cells (`GroundNoSpawn` blocks walking, `NoBuild` building, `NearResources` town halls), kinds
 *   from `EditorCategories` / `ResourceType`, `LifeMax`, resource amounts.
 */

import type { SC2MapData } from '../format/index.js'
import { readCellAttribute } from '../format/index.js'
import {
  analyzeMapCatalog,
  analyzeCliffLattice,
  analyzeCliffFaces,
  analyzeCliffLines,
  analyzeRamps,
  latticeCorners,
  tileLevelField,
  smoothCliffLine,
  paintedSubCell,
  isCliffWalkerCrossing,
  analyzeMapMarkers,
  analyzePlayableBounds,
  analyzeVertexCliffLevels,
  type CatalogSnapshot,
  type MapMarker,
} from '../image/overview.js'
import { pointInPolygon, rasterizePolygon, type GridSize, type Point } from './grid.js'
import type { BlockerKind, MapSpatialData, SpatialBlocker } from './spatial.js'

/** CLIF units per cliff level. */
const LEVEL_UNITS = 4
/** Corners spanning at least this many CLIF units are a cliff face, not a slope. */
const CLIFF_SPAN = 3
/** Quantized heights sit this close to a whole level; a slope is further off or uneven. */
const LEVEL_TOLERANCE = 0.5

function rawEntry(map: SC2MapData, name: string): Uint8Array | undefined {
  const wanted = name.toLowerCase()
  for (const [path, bytes] of map.rawFiles ?? new Map<string, Uint8Array>())
    if (path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() === wanted) return bytes
  return undefined
}

function blockerKind(marker: MapMarker): BlockerKind | undefined {
  switch (marker.kind) {
    case 'minerals':
    case 'rich-minerals':
      return 'mineral'
    case 'geyser':
    case 'rich-geyser':
      return 'geyser'
    case 'destructible':
      return 'destructible'
    case 'unit':
      // A placed unit with a blocking footprint that is neither a resource nor destructible.
      return marker.blocks.length > 0 ? 'neutral' : undefined
    default:
      return undefined
  }
}

export function sc2MapSpatialData(
  map: SC2MapData,
  catalog?: CatalogSnapshot,
  options: { readonly groundCellSize?: number } = {},
): MapSpatialData {
  if (map.height === undefined || map.terrain === undefined)
    throw new RangeError('Map navigation needs t3HeightMap and t3Terrain.xml')
  const vertices = analyzeVertexCliffLevels(map.height, map.terrain)
  const width = vertices.sizeX - 1
  const height = vertices.sizeY - 1
  const size: GridSize = { width, height }
  const cells = width * height
  const level = new Float32Array(cells)
  const cliff = new Uint8Array(cells)
  const rampish = new Uint8Array(cells)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (dx: number, dy: number) => vertices.levels[(y + dy) * vertices.sizeX + x + dx]!
      const corners = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)]
      const low = Math.min(...corners)
      const high = Math.max(...corners)
      const cell = y * width + x
      level[cell] = (corners[0]! + corners[1]! + corners[2]! + corners[3]!) / 4 / LEVEL_UNITS
      if (high - low >= CLIFF_SPAN) cliff[cell] = 1
      else if (
        high - low > LEVEL_TOLERANCE ||
        corners.some(
          value =>
            Math.abs(value - Math.round(value / LEVEL_UNITS) * LEVEL_UNITS) > LEVEL_TOLERANCE,
        )
      )
        rampish[cell] = 1
    }

  const bounds = (map.info === undefined ? undefined : analyzePlayableBounds(map.info)) ?? {
    left: 0,
    bottom: 0,
    right: width,
    top: height,
  }
  const painted = new Uint8Array(cells)
  const noBuild = new Uint8Array(cells)
  const paintedMask = (name: string, target: Uint8Array) => {
    const bytes = rawEntry(map, name)
    if (bytes === undefined) return
    const mask = readCellAttribute(bytes, { sizeX: width, sizeY: height })
    for (let cell = 0; cell < Math.min(cells, mask.cells.length); cell += 1)
      if (mask.cells[cell]! !== 0) target[cell] = 1
  }
  paintedMask('CellAttribute_Pnp', painted)
  paintedMask('CellAttribute_Pnb', noBuild)
  const cleared = new Uint8Array(cells)
  paintedMask('CellAttribute_Pcl', cleared)
  for (let cell = 0; cell < cells; cell += 1)
    if (cleared[cell] === 1) {
      cliff[cell] = 0
      painted[cell] = 0
    }
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (
        x + 0.5 < bounds.left ||
        x + 0.5 > bounds.right ||
        y + 0.5 < bounds.bottom ||
        y + 0.5 > bounds.top
      )
        painted[y * width + x] = 1

  const resolved = catalog === undefined ? undefined : analyzeMapCatalog(catalog)
  const markers = map.objects === undefined ? [] : analyzeMapMarkers(map.objects, resolved)
  const lattice = analyzeCliffLattice(map.terrain, vertices)
  const shapes = analyzeRamps(map.terrain, vertices, analyzeCliffFaces(lattice))
  const rampShapes = shapes.map(shape => {
    const at = (a: number): Point => [
      shape.center[0] + shape.up[0] * a,
      shape.center[1] + shape.up[1] * a,
    ]
    return {
      center: at((shape.slopeBottom + shape.slopeTop) / 2),
      direction: shape.up,
      lower: at(shape.slopeBottom - 0.5),
      upper: at(shape.slopeTop + 0.5),
      width: Math.max(1, Math.abs(shape.sides[0].lateral - shape.sides[1].lateral) - 1),
      lowerLevel: shape.lo / LEVEL_UNITS,
      upperLevel: shape.hi / LEVEL_UNITS,
    }
  })
  // Keep the authored slope continuous even when quantized height corners resemble cliff cells.
  for (let cell = 0; cell < cells; cell += 1) {
    const x = (cell % width) + 0.5
    const y = Math.floor(cell / width) + 0.5
    for (const shape of shapes) {
      const dx = x - shape.center[0],
        dy = y - shape.center[1]
      const a = dx * shape.up[0] + dy * shape.up[1]
      const l = dx * shape.right[0] + dy * shape.right[1]
      if (
        a >= shape.slopeBottom &&
        a <= shape.slopeTop &&
        l > Math.min(...shape.sides.map(side => side.lateral)) + 0.5 &&
        l < Math.max(...shape.sides.map(side => side.lateral)) - 0.5
      ) {
        cliff[cell] = 0
        rampish[cell] = 1
      }
    }
  }
  const paintedBytes = rawEntry(map, 'CellAttribute_Pnp')
  const paintedCells =
    paintedBytes === undefined
      ? undefined
      : readCellAttribute(paintedBytes, { sizeX: width, sizeY: height }).cells
  const clearBytes = rawEntry(map, 'CellAttribute_Pcl')
  const clearCells =
    clearBytes === undefined
      ? undefined
      : readCellAttribute(clearBytes, { sizeX: width, sizeY: height }).cells
  const levelAt = (x: number, y: number) => {
    const i = Math.floor(x / 2),
      j = Math.floor(y / 2)
    return tileLevelField(latticeCorners(lattice, i, j))(x - (2 * i + 1), y - (2 * j + 1))
  }
  const walkableAt = (x: number, y: number, wanted: number) => {
    if (x < bounds.left || x >= bounds.right || y < bounds.bottom || y >= bounds.top) return false
    const cell = Math.floor(y) * width + Math.floor(x)
    const fx = x - Math.floor(x),
      fy = y - Math.floor(y)
    const clear = clearCells !== undefined && paintedSubCell(clearCells[cell]!, fx, fy)
    return (
      (clear || paintedCells === undefined || !paintedSubCell(paintedCells[cell]!, fx, fy)) &&
      wanted > 0 &&
      Math.abs(levelAt(x, y) - wanted) < 0.5 &&
      !markers.some(marker => marker.blocks.some(polygon => pointInPolygon(x, y, polygon)))
    )
  }
  const cliffCrossings: { a: Point; b: Point; width: number; levelA: number; levelB: number }[] = []
  const lines = analyzeCliffLines(lattice, index => {
    const id = map.terrain!.cliffSets?.[index]
    return id !== undefined && resolved?.cliffFamily(id) === 'natural'
  })
  for (const line of lines) {
    if (line.hi - line.lo !== LEVEL_UNITS) continue
    const points = line.natural
      ? smoothCliffLine(line, [(bounds.left + bounds.right) / 2, (bounds.bottom + bounds.top) / 2])
      : line.points
    const n = line.closed ? points.length : points.length - 1
    for (let k = 0; k < n; k += 1) {
      const a = points[k]!,
        b = points[(k + 1) % points.length]!
      const length = Math.hypot(b[0] - a[0], b[1] - a[1])
      const nx = -(b[1] - a[1]) / (length || 1),
        ny = (b[0] - a[0]) / (length || 1)
      const count = Math.max(1, Math.ceil(length / 0.25))
      for (let step = 0; step < count; step += 1) {
        const t = (step + 0.5) / count
        const x = a[0] + (b[0] - a[0]) * t,
          y = a[1] + (b[1] - a[1]) * t
        if (!isCliffWalkerCrossing(line.hi, line.lo, x, y, nx, ny, walkableAt)) continue
        cliffCrossings.push({
          a: [x + nx, y + ny],
          b: [x - nx, y - ny],
          width: length / count,
          levelA: line.hi / LEVEL_UNITS,
          levelB: line.lo / LEVEL_UNITS,
        })
      }
    }
  }
  const cellsOf = (polygons: readonly (readonly Point[])[] | undefined) =>
    [...new Set((polygons ?? []).flatMap(polygon => rasterizePolygon(size, polygon)))].sort(
      (a, b) => a - b,
    )
  const blockers: SpatialBlocker[] = []
  const startLocations: Point[] = []
  markers.forEach((marker, index) => {
    if (marker.kind === 'start-location') {
      startLocations.push([marker.x, marker.y])
      return
    }
    if (marker.kind === 'doodad') {
      for (const cell of cellsOf(marker.blocks)) painted[cell] = 1
      for (const cell of cellsOf(marker.noBuild)) noBuild[cell] = 1
      return
    }
    const kind = blockerKind(marker)
    if (kind === undefined) return
    const nearResourceCells = cellsOf(marker.nearResources)
    blockers.push({
      id: marker.objectId === undefined ? `object-${index}` : String(marker.objectId),
      kind,
      type: marker.type,
      x: marker.x,
      y: marker.y,
      cells: cellsOf(marker.blocks),
      placementCells: cellsOf(marker.noBuild),
      ...(nearResourceCells.length === 0 ? {} : { nearResourceCells }),
      ...(marker.life === undefined ? {} : { life: marker.life }),
      ...(marker.resources === undefined ? {} : { resources: marker.resources }),
      ...(marker.kind === 'rich-minerals' || marker.kind === 'rich-geyser' ? { rich: true } : {}),
    })
  })

  const terrainWalkable = new Uint8Array(cells)
  const terrainBuildable = new Uint8Array(cells)
  const ramp = new Uint8Array(cells)
  for (let cell = 0; cell < cells; cell += 1) {
    if (cliff[cell] === 1 || painted[cell] === 1) continue
    terrainWalkable[cell] = 1
    if (rampish[cell] === 1) ramp[cell] = 1
    else if (noBuild[cell] !== 1) terrainBuildable[cell] = 1
  }
  const step = options.groundCellSize ?? 0.25
  const samples = 1 / step
  if (!Number.isInteger(samples) || samples < 1 || samples > 16)
    throw new RangeError('Ground cell size must divide one world unit, with 1–16 samples per axis')
  const fineSize = { width: width * samples, height: height * samples }
  const groundSampling = {
    ...fineSize,
    cellSize: step,
    walkable: new Uint8Array(fineSize.width * fineSize.height),
    level: new Float32Array(fineSize.width * fineSize.height),
    ramp: new Uint8Array(fineSize.width * fineSize.height),
  }
  for (let y = 0; y < fineSize.height; y++)
    for (let x = 0; x < fineSize.width; x++) {
      const wx = (x + 0.5) * step,
        wy = (y + 0.5) * step
      if (wx < bounds.left || wx >= bounds.right || wy < bounds.bottom || wy >= bounds.top) continue
      const cell = Math.floor(wy) * width + Math.floor(wx),
        fineCell = y * fineSize.width + x
      const fx = wx - Math.floor(wx),
        fy = wy - Math.floor(wy)
      const clear = clearCells !== undefined && paintedSubCell(clearCells[cell]!, fx, fy)
      if (!clear && paintedCells !== undefined && paintedSubCell(paintedCells[cell]!, fx, fy))
        continue
      let ground = levelAt(wx, wy) / LEVEL_UNITS
      for (const shape of shapes) {
        const dx = wx - shape.center[0],
          dy = wy - shape.center[1]
        const a = dx * shape.up[0] + dy * shape.up[1],
          l = dx * shape.right[0] + dy * shape.right[1]
        if (
          a >= shape.slopeBottom &&
          a <= shape.slopeTop &&
          l > Math.min(...shape.sides.map(side => side.lateral)) + 0.5 &&
          l < Math.max(...shape.sides.map(side => side.lateral)) - 0.5
        ) {
          ground =
            (shape.lo +
              ((shape.hi - shape.lo) * (a - shape.slopeBottom)) /
                Math.max(0.001, shape.slopeTop - shape.slopeBottom)) /
            LEVEL_UNITS
          groundSampling.ramp[fineCell] = 1
          break
        }
      }
      if (ground <= 0) continue
      groundSampling.walkable[fineCell] = 1
      groundSampling.level[fineCell] = ground
    }
  for (const marker of markers)
    for (const polygon of marker.blocks)
      for (const cell of rasterizePolygon(
        fineSize,
        polygon.map(([x, y]) => [x / step, y / step]),
      ))
        groundSampling.walkable[cell] = 0
  return {
    width,
    height,
    bounds,
    terrainWalkable,
    terrainBuildable,
    ramp,
    cliff,
    painted,
    level,
    blockers,
    startLocations,
    ...(rampShapes.length === 0 ? {} : { rampShapes }),
    cliffCrossings,
    groundSampling,
  }
}
