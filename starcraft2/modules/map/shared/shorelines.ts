/**
 * SC2 water shorelines for presentation. The engine lines every water zone's waterline with its
 * `CWater.BeachShoreline` model, or `CliffShoreline` where the ground climbs a cliff. Those models are
 * particle emitters only (Liberty's `ShorelineWavesBeach.m3`: foam crests lying on the water and
 * travelling along the model's +X, spray near its origin), so the small waves the editor shows along
 * a shore are part of the water, not placed objects. Where the engine puts them is not stored in the
 * map; this lays one copy on every height-field cell the waterline crosses, at the crossing's middle
 * on the water surface, turned so its +X runs up the ground.
 *
 * Built only from the shared sc2-map-core readers (`parseTerrainXml`, `readHeightMap` with
 * `levelFromCell`, `readSyncCliffLevel`, `readWater`); the water templates come from the resolved
 * catalog through the caller.
 */
import {
  levelFromCell,
  parseTerrainXml,
  readHeightMap,
  readSyncCliffLevel,
  readWater,
} from './format/index.js'

/** A `CWater` template as the shoreline needs it: its surface height and its two shoreline models. */
export interface Sc2ShorelineTemplate {
  /** `State.Height`, map-native world units. */
  readonly elevation: number
  /** `BeachShoreline`: a `CModel` id. */
  readonly beachModel?: string
  /** `CliffShoreline`: a `CModel` id. */
  readonly cliffModel?: string
}

export interface Sc2ShorelinePlacement {
  /** Map-native position on the water surface. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** Radians, counter-clockwise in the map-native horizontal plane: the model's +X points uphill. */
  readonly yaw: number
  /** The `CModel` id drawn here. */
  readonly modelId: string
  readonly cliff: boolean
  /** The water zone (its index in `t3Water`) this waterline belongs to. */
  readonly zoneIndex: number
}

export interface Sc2Shorelines {
  readonly placements: readonly Sc2ShorelinePlacement[]
  /** Crossings left out because `maxPlacements` was reached. */
  readonly dropped: number
}

/** Water template ids the map's zones name (`t3Water`), for the catalog queries that resolve them. */
export function sc2WaterTemplateIds(water: Uint8Array): readonly string[] {
  return [...new Set(readWater(water).zones.map(zone => zone.templateId))].filter(id => id.length > 0)
}

export function buildSc2Shorelines(input: {
  readonly terrainXml: string
  readonly heightMap: Uint8Array
  /** `t3SyncCliffLevel`: a crossing whose cell spans two cliff levels takes the cliff model. */
  readonly cliffLevel?: Uint8Array
  readonly water: Uint8Array
  readonly templateFor: (templateId: string) => Sc2ShorelineTemplate | undefined
  readonly maxPlacements: number
}): Sc2Shorelines {
  const terrain = parseTerrainXml(input.terrainXml)
  const heights = readHeightMap(input.heightMap)
  const levels = input.cliffLevel === undefined ? undefined : readSyncCliffLevel(input.cliffLevel)
  const zones = readWater(input.water).zones
  const originX = terrain.offsetX ?? 0
  const originY = terrain.offsetY ?? 0
  const scaleX = terrain.scaleX ?? 1
  const scaleY = terrain.scaleY ?? 1
  const geometry = { offsetZ: terrain.offsetZ ?? 0, scaleZ: terrain.scaleZ ?? 1 }
  const heightAt = (x: number, y: number) =>
    levelFromCell(heights.cells[y * heights.sizeX + x]!, terrain, geometry)
  const cliffLevelAt = (x: number, y: number) =>
    levels !== undefined && x < levels.sizeX && y < levels.sizeY
      ? levels.heights[y * levels.sizeX + x]
      : undefined
  const placements: Sc2ShorelinePlacement[] = []
  let dropped = 0
  // Zones may overlap; a cell's waterline is laid once, by the first zone that reaches it.
  const laid = new Set<number>()
  zones.forEach((zone, zoneIndex) => {
    const template = input.templateFor(zone.templateId)
    if (template === undefined || (template.beachModel === undefined && template.cliffModel === undefined))
      return
    const minimumX = Math.min(zone.startX, zone.endX)
    const maximumX = Math.max(zone.startX, zone.endX)
    const minimumY = Math.min(zone.startY, zone.endY)
    const maximumY = Math.max(zone.startY, zone.endY)
    const x0 = Math.max(0, Math.floor((minimumX - originX) / scaleX))
    const x1 = Math.min(heights.sizeX - 2, Math.ceil((maximumX - originX) / scaleX))
    const y0 = Math.max(0, Math.floor((minimumY - originY) / scaleY))
    const y1 = Math.min(heights.sizeY - 2, Math.ceil((maximumY - originY) / scaleY))
    const surface = template.elevation
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const key = y * heights.sizeX + x
        if (laid.has(key)) continue
        // Corners counter-clockwise from (x, y); the waterline crosses every edge whose ends lie on
        // either side of the surface.
        const corners = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ] as const
        const height = corners.map(([dx, dy]) => heightAt(x + dx, y + dy))
        const crossings: (readonly [number, number])[] = []
        for (let edge = 0; edge < 4; edge += 1) {
          const next = (edge + 1) % 4
          const from = height[edge]! - surface
          const to = height[next]! - surface
          if ((from < 0) === (to < 0)) continue
          const t = from / (from - to)
          crossings.push([
            corners[edge]![0] + (corners[next]![0] - corners[edge]![0]) * t,
            corners[edge]![1] + (corners[next]![1] - corners[edge]![1]) * t,
          ])
        }
        if (crossings.length === 0) continue
        const u = crossings.reduce((sum, point) => sum + point[0], 0) / crossings.length
        const v = crossings.reduce((sum, point) => sum + point[1], 0) / crossings.length
        const worldX = originX + (x + u) * scaleX
        const worldY = originY + (y + v) * scaleY
        if (worldX < minimumX || worldX > maximumX || worldY < minimumY || worldY > maximumY) continue
        // Up the ground: the bilinear height's gradient at the crossing.
        const [a, b, c, d] = height as [number, number, number, number]
        const slopeX = ((b - a) * (1 - v) + (c - d) * v) / scaleX
        const slopeY = ((d - a) * (1 - u) + (c - b) * u) / scaleY
        if (Math.hypot(slopeX, slopeY) < 1e-6) continue
        const cornerLevels = corners.map(([dx, dy]) => cliffLevelAt(x + dx, y + dy))
        const cliff = cornerLevels.some(level => level !== undefined && level !== cornerLevels[0])
        const modelId = cliff
          ? (template.cliffModel ?? template.beachModel)
          : (template.beachModel ?? template.cliffModel)
        if (modelId === undefined) continue
        if (placements.length >= input.maxPlacements) {
          dropped += 1
          continue
        }
        laid.add(key)
        placements.push({
          x: worldX,
          y: worldY,
          z: surface,
          yaw: Math.atan2(slopeY, slopeX),
          modelId,
          cliff,
          zoneIndex,
        })
      }
  })
  return { placements, dropped }
}

/** A `CWater` template as its lava needs it: the surface height and the lava model. */
export interface Sc2LavaTemplate {
  /** `State.Height`, map-native world units. */
  readonly elevation: number
  /** `LavaModel` of a template with `IsLava`: a `CModel` id (Core's default: `DefaultLava`). */
  readonly lavaModel?: string
}

export interface Sc2LavaPlacement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly modelId: string
  readonly zoneIndex: number
}

/** Side of the lava model's tile: `CharLavaPlane.m3` spans -4..4 in X and Y. */
const LAVA_TILE = 8

/**
 * SC2 draws a lava zone (`CWater.IsLava`) with its `LavaModel` — `DefaultLava` is
 * `Assets\Water\Lavas\CharLavaPlane\CharLavaPlane.m3`, an 8×8 plane of glowing lava under a
 * masked rock crust whose UVs flow — tiled over the zone at the surface height, not with the water
 * surface. The tiles sit on the map's 8-unit lattice so neighbouring zones continue one another;
 * a tile is laid where it overlaps a zone, once, by the first zone that reaches it.
 */
export function buildSc2LavaPlanes(input: {
  readonly water: Uint8Array
  readonly templateFor: (templateId: string) => Sc2LavaTemplate | undefined
  readonly maxPlacements: number
}): { readonly placements: readonly Sc2LavaPlacement[]; readonly dropped: number } {
  const placements: Sc2LavaPlacement[] = []
  let dropped = 0
  const laid = new Set<string>()
  readWater(input.water).zones.forEach((zone, zoneIndex) => {
    const template = input.templateFor(zone.templateId)
    if (template?.lavaModel === undefined) return
    const x0 = Math.floor(Math.min(zone.startX, zone.endX) / LAVA_TILE)
    const x1 = Math.ceil(Math.max(zone.startX, zone.endX) / LAVA_TILE)
    const y0 = Math.floor(Math.min(zone.startY, zone.endY) / LAVA_TILE)
    const y1 = Math.ceil(Math.max(zone.startY, zone.endY) / LAVA_TILE)
    for (let ty = y0; ty < y1; ty += 1)
      for (let tx = x0; tx < x1; tx += 1) {
        const key = `${tx}:${ty}`
        if (laid.has(key)) continue
        if (placements.length >= input.maxPlacements) {
          dropped += 1
          continue
        }
        laid.add(key)
        placements.push({
          x: (tx + 0.5) * LAVA_TILE,
          y: (ty + 0.5) * LAVA_TILE,
          z: template.elevation,
          modelId: template.lavaModel,
          zoneIndex,
        })
      }
  })
  return { placements, dropped }
}
