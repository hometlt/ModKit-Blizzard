/**
 * Debug drawing of a `MapNavigation` over the map overview (the minimap): regions, expansions,
 * ramps and staging points, every portal kind, graph edges and a selected route, each a layer
 * that can be switched off.
 */

import type { SC2MapData } from '../format/index.js'
import {
  OverviewCanvas,
  renderMapOverview,
  type MapOverview,
  type MapOverviewOptions,
  type Rgb,
} from '../image/overview.js'
import { encodeRGB8 } from '../image/png.js'
import type { MapNavigation, NavigationEdgeType } from './analyze.js'
import { descend, distanceField, type Point } from './grid.js'
import type { Route } from './routes.js'
import { canGroundStep, walkableMask, type MapSpatialData } from './spatial.js'

export type NavigationLayer =
  | 'regions'
  | 'expansions'
  | 'ramps'
  | 'chokes'
  | 'staging'
  | 'destructible'
  | 'mineral'
  | 'cliff'
  | 'predrop'
  | 'edges'
  | 'nodes'

export interface NavigationRenderOptions {
  /** Layers to draw; transport portals and individual graph nodes are hidden by default. */
  readonly layers?: Partial<Readonly<Record<NavigationLayer, boolean>>>
  /** Routes to draw on top, the first most prominent. */
  readonly routes?: readonly Route[]
  /** With the spatial map, ground steps of a route follow the real walking path. */
  readonly spatial?: MapSpatialData
}

const LAYER_DEFAULTS: Readonly<Record<NavigationLayer, boolean>> = {
  regions: true,
  expansions: true,
  ramps: true,
  chokes: true,
  staging: true,
  destructible: true,
  mineral: true,
  cliff: true,
  predrop: false,
  edges: true,
  nodes: false,
}

const COLORS = {
  expansion: [0, 230, 255] as Rgb,
  blocked: [255, 80, 80] as Rgb,
  invalid: [150, 150, 150] as Rgb,
  ramp: [255, 0, 200] as Rgb,
  staging: [255, 240, 0] as Rgb,
  destructible: [255, 140, 0] as Rgb,
  mineral: [70, 160, 255] as Rgb,
  cliff: [190, 90, 255] as Rgb,
  predrop: [60, 255, 120] as Rgb,
  edge: [230, 230, 230] as Rgb,
  node: [255, 255, 255] as Rgb,
  outline: [0, 0, 0] as Rgb,
}

/** Special route steps in their portal colour; ground steps in the route's own colour. */
const ROUTE_COLORS: Readonly<Record<Exclude<NavigationEdgeType, 'GROUND' | 'RAMP'>, Rgb>> = {
  DESTRUCTIBLE: [255, 140, 0],
  MINERAL_WALL: [70, 160, 255],
  CLIFF: [190, 90, 255],
  PREDROP: [60, 255, 120],
}

function hue(index: number): Rgb {
  // Golden-angle hues, fixed saturation and value.
  const h = ((index * 137.508) % 360) / 60
  const c = 0.85
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x]
  return [Math.round((r + 0.15) * 255), Math.round((g + 0.15) * 255), Math.round((b + 0.15) * 255)]
}

function circle([x, y]: Point, radius: number): Point[] {
  return Array.from({ length: 16 }, (_, k) => [
    x + radius * Math.cos((k * Math.PI) / 8),
    y + radius * Math.sin((k * Math.PI) / 8),
  ])
}

class Overlay {
  constructor(readonly canvas: OverviewCanvas) {}
  line(a: Point, b: Point, color: Rgb, halfWidth: number, alpha = 1, dashed = false) {
    const ink = this.canvas.ink()
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    // An odd dash count keeps ink at both ends, including short portal crossings.
    const pieces = dashed ? Math.max(1, Math.floor(length / 1) | 1) : 1
    for (let k = 0; k < pieces; k += dashed ? 2 : 1) {
      const t0 = k / pieces
      const t1 = Math.min(1, (k + 1) / pieces)
      this.canvas.stroke(
        ink,
        [
          a[0] + (b[0] - a[0]) * t0,
          a[1] + (b[1] - a[1]) * t0,
          a[0] + (b[0] - a[0]) * t1,
          a[1] + (b[1] - a[1]) * t1,
        ],
        halfWidth,
      )
    }
    this.canvas.composite(ink, color, alpha)
  }
  polyline(points: readonly Point[], color: Rgb, halfWidth: number, alpha = 1) {
    const ink = this.canvas.ink()
    for (let k = 1; k < points.length; k += 1)
      this.canvas.stroke(
        ink,
        [points[k - 1]![0], points[k - 1]![1], points[k]![0], points[k]![1]],
        halfWidth,
      )
    this.canvas.composite(ink, color, alpha)
  }
  dot(point: Point, radius: number, color: Rgb) {
    const shape = circle(point, radius)
    this.canvas.paint(shape, color)
    this.polyline([...shape, shape[0]!], COLORS.outline, 0.5, 0.9)
  }
  square(centre: Point, half: number, color: Rgb, halfWidth: number) {
    const [x, y] = centre
    this.polyline(
      [
        [x - half, y - half],
        [x + half, y - half],
        [x + half, y + half],
        [x - half, y + half],
        [x - half, y - half],
      ],
      color,
      halfWidth,
    )
  }
}

/** Draw the navigation layers and routes onto a rendered overview (changes `overview.rgb`). */
export function drawNavigation(
  overview: MapOverview,
  navigation: MapNavigation,
  options: NavigationRenderOptions = {},
): MapOverview {
  const scale = overview.width / navigation.width
  const canvas = new OverviewCanvas(overview.width, overview.height, scale, overview.rgb)
  const overlay = new Overlay(canvas)
  const on = (layer: NavigationLayer) => options.layers?.[layer] ?? LAYER_DEFAULTS[layer]
  const thick = Math.max(1, scale / 5)
  const thin = Math.max(0.5, scale / 10)
  const nodeTypes = new Map(navigation.nodes.map(node => [node.id, node.type]))

  if (on('regions')) {
    // A translucent tint per region, and its centre.
    const runs = navigation.areaRuns ?? navigation.regionRuns
    for (let k = 0; k < runs.length; k += 3) {
      const start = runs[k]!
      const length = runs[k + 1]!
      const color = hue(runs[k + 2]!)
      const x0 = start % navigation.width
      const y = (start - x0) / navigation.width
      for (let py = Math.round(canvas.pixelY(y + 1)); py < Math.round(canvas.pixelY(y)); py += 1)
        for (let px = Math.round(x0 * scale); px < Math.round((x0 + length) * scale); px += 1)
          canvas.blendAt((py * canvas.width + px) * 3, color, 0.18)
    }
    if (navigation.areas !== undefined)
      navigation.areas.forEach((area, index) => {
        if (area.expansionId === undefined) overlay.dot(area.center, 0.45, hue(index + 1))
      })
    else
      navigation.regions.forEach((region, index) =>
        overlay.dot(region.centroid, 0.7, hue(index + 1)),
      )
  }
  if (on('edges') && navigation.areaConnections !== undefined) {
    const edges = new Map(navigation.edges.map(edge => [edge.id, edge]))
    for (const connection of navigation.areaConnections) {
      if (connection.type === 'PREDROP' && !on('predrop')) continue
      for (const id of connection.edgeIds) {
        const edge = edges.get(id)
        if (edge === undefined) continue
        const color =
          connection.type === 'GROUND' || connection.type === 'RAMP'
            ? COLORS.edge
            : ROUTE_COLORS[connection.type]
        if (edge.path !== undefined)
          overlay.polyline(edge.path, color, thin, edge.type === 'GROUND' ? 0.6 : 0.8)
        else overlay.line(edge.entryPoint, edge.exitPoint, color, thin, 0.8, edge.type === 'CLIFF')
      }
    }
  } else if (on('edges'))
    for (const edge of navigation.edges) {
      if (edge.type === 'PREDROP' && !on('predrop')) continue
      if (
        !on('predrop') &&
        (nodeTypes.get(edge.from) === 'PREDROP_PORTAL' ||
          nodeTypes.get(edge.to) === 'PREDROP_PORTAL')
      )
        continue
      const color =
        edge.type === 'GROUND' || edge.type === 'RAMP' ? COLORS.edge : ROUTE_COLORS[edge.type]
      if (edge.path !== undefined)
        overlay.polyline(edge.path, color, thin, edge.type === 'GROUND' ? 0.35 : 0.8)
      else overlay.line(edge.entryPoint, edge.exitPoint, color, thin, 0.7, edge.type === 'CLIFF')
    }
  if (on('chokes'))
    for (const choke of navigation.chokes ?? []) {
      overlay.line(choke.entryA, choke.entryB, COLORS.edge, thin, 0.8)
      overlay.dot(choke.center, 0.6, COLORS.edge)
    }
  if (on('chokes')) {
    const drawn = new Set(navigation.chokes.map(choke => choke.id))
    for (const node of navigation.nodes)
      if (node.type === 'CHOKE' && !drawn.has(node.id)) overlay.dot(node.position, 0.6, COLORS.edge)
  }
  if (on('destructible'))
    for (const blocker of navigation.blockers ?? [])
      if (blocker.kind === 'destructible' && blocker.cells.length > 0)
        overlay.square([blocker.x, blocker.y], 0.6, COLORS.destructible, thin)
  if (on('ramps'))
    for (const ramp of navigation.ramps) {
      if (on('staging')) {
        overlay.line(ramp.lowerStagingPoint, ramp.center, COLORS.ramp, thin, 0.8)
        overlay.line(ramp.center, ramp.upperStagingPoint, COLORS.ramp, thin, 0.8)
      }
      overlay.dot(ramp.center, 0.8, COLORS.ramp)
    }
  if (on('staging'))
    for (const ramp of navigation.ramps) {
      overlay.dot(ramp.lowerStagingPoint, 0.5, COLORS.staging)
      overlay.dot(ramp.upperStagingPoint, 0.5, COLORS.staging)
    }
  const portalLayer = (
    layer: NavigationLayer,
    list: readonly { entryA: Point; entryB: Point }[],
    color: Rgb,
    dashed: boolean,
  ) => {
    if (!on(layer)) return
    for (const portal of list) {
      overlay.line(portal.entryA, portal.entryB, color, thick, 1, dashed)
      overlay.dot(portal.entryA, 0.55, color)
      overlay.dot(portal.entryB, 0.55, color)
    }
  }
  portalLayer('destructible', navigation.destructiblePortals, COLORS.destructible, false)
  portalLayer('mineral', navigation.mineralPortals, COLORS.mineral, false)
  portalLayer('cliff', navigation.cliffPortals, COLORS.cliff, true)
  if (on('predrop'))
    for (const portal of navigation.predropPortals) {
      overlay.line(portal.pickupA, portal.dropB, COLORS.predrop, thin, 0.9, true)
      overlay.dot(portal.pickupA, 0.55, COLORS.predrop)
      overlay.dot(portal.dropB, 0.55, COLORS.predrop)
    }
  if (on('expansions'))
    for (const expansion of navigation.expansions) {
      const color =
        expansion.placementState === 'AVAILABLE'
          ? COLORS.expansion
          : expansion.placementState === 'INVALID'
            ? COLORS.invalid
            : COLORS.blocked
      overlay.square(expansion.position, 2.5, color, thick)
      overlay.dot(expansion.position, 0.6, color)
    }
  if (on('nodes'))
    for (const node of navigation.nodes)
      if (node.type !== 'PREDROP_PORTAL' || on('predrop'))
        overlay.dot(node.position, 0.35, COLORS.node)

  // Routes: every step in its movement colour; ground steps along the walking path.
  const walkable = options.spatial === undefined ? undefined : walkableMask(options.spatial)
  const byId = new Map(navigation.nodes.map(node => [node.id, node]))
  const size = { width: navigation.width, height: navigation.height }
  const groundPath = (a: Point, b: Point): Point[] => {
    if (walkable === undefined) return [a, b]
    const cellA = Math.floor(a[1]) * size.width + Math.floor(a[0])
    const cellB = Math.floor(b[1]) * size.width + Math.floor(b[0])
    const canStep = (from: number, to: number) => canGroundStep(options.spatial!, from, to)
    const field = distanceField(size, walkable, [cellA], Infinity, undefined, undefined, canStep)
    if (!Number.isFinite(field[cellB]!)) return [a, b]
    return descend(size, field, cellB, undefined, canStep)
      .reverse()
      .map(cell => [(cell % size.width) + 0.5, Math.floor(cell / size.width) + 0.5] as const)
  }
  const routes = options.routes ?? []
  ;[...routes].reverse().forEach((route, reverseIndex) => {
    const index = routes.length - 1 - reverseIndex
    const primary = index === 0
    const width = primary ? thick * 1.5 : thick
    const alpha = primary ? 1 : 0.8
    const routeColor =
      route.classes.length === 1
        ? (ROUTE_COLORS[route.classes[0] as keyof typeof ROUTE_COLORS] ?? COLORS.edge)
        : COLORS.edge
    for (const step of route.steps) {
      const a = byId.get(step.from)!.position
      const b = byId.get(step.to)!.position
      if (step.edge.type === 'PREDROP' && !on('predrop')) continue
      if (step.edge.type === 'GROUND' || step.edge.type === 'RAMP')
        overlay.polyline(step.edge.path ?? groundPath(a, b), routeColor, width, alpha)
      else {
        const color = ROUTE_COLORS[step.edge.type]
        if (step.edge.path !== undefined) {
          overlay.polyline(step.edge.path, color, width * 1.3, 1)
          continue
        }
        overlay.line(
          a,
          b,
          color,
          width * 1.3,
          1,
          step.edge.type === 'PREDROP' || step.edge.type === 'CLIFF',
        )
      }
      if (step.edge.type === 'PREDROP') {
        overlay.square(a, 0.8, ROUTE_COLORS.PREDROP, thin) // pickup
        overlay.square(b, 0.8, ROUTE_COLORS.PREDROP, thin) // drop
      }
    }
    if (primary && route.nodes.length > 0) {
      overlay.dot(byId.get(route.nodes[0]!)!.position, 1, [255, 255, 255])
      overlay.dot(byId.get(route.nodes[route.nodes.length - 1]!)!.position, 1, [255, 50, 50])
    }
  })
  return overview
}

/** The overview with the navigation drawn on top, as a PNG. */
export function navigationToPng(
  map: SC2MapData,
  navigation: MapNavigation,
  options: NavigationRenderOptions & { readonly overview?: MapOverviewOptions } = {},
): Uint8Array {
  const overview = drawNavigation(renderMapOverview(map, options.overview), navigation, options)
  return encodeRGB8(overview.width, overview.height, overview.rgb)
}
