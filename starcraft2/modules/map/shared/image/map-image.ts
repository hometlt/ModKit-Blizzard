/**
 * Map data ↔ PNG.
 *
 * - Height map and cliff level → 16-bit grayscale PNG (lossless per channel),
 *   and back. `pngToHeight` / `pngToCliffLevel` take an optional `ref` to carry
 *   the fields a single grayscale channel can't hold (height adjustments, masks,
 *   version, padding) so the result re-serializes byte-exact.
 * - Texture masks → 8-bit RGB false-color blend (visualization only).
 */

import type {
  HeightMapResult,
  HeightCell,
  CellFlagsResult,
  CliffLevelResult,
  PaintedPathingResult,
  PathingInfoResult,
  SC2MapData,
  TextureMasksResult,
  VertexColorResult,
  CircleShape,
  DiamondShape,
  RectShape,
  RegionShape,
} from '../format/index.js'
import { PAINTED_GRID_SIZE, paintedValueAt, textureMaskWeight } from '../format/index.js'
import { encodeGray16, decodeGray16, encodeRGB8, decodePng } from './png.js'

const clamp16 = (v: number): number => (v < 0 ? 0 : v > 0xffff ? 0xffff : v | 0)

// --- Height map ---

export type HeightChannel = 'base' | 'adjustments' | 'sum'

/**
 * 16-bit grayscale PNG of a height map. The `channel` selects which uint16 to
 * encode (default `base`, the plateau level). Only `base` and `adjustments`
 * invert losslessly via {@link pngToHeight}; `sum` is a visualization.
 */
export function heightToPng(map: HeightMapResult, channel: HeightChannel = 'base'): Uint8Array {
  // Image convention: PNG row 0 = map north (world y max). Grids store row 0 =
  // south, so rows are flipped here (and symmetrically in pngToHeight) — this is
  // what keeps overlays (project()) and world-anchored renderers aligned.
  const samples = new Uint16Array(map.sizeX * map.sizeY)
  for (let y = 0; y < map.sizeY; y++) {
    for (let x = 0; x < map.sizeX; x++) {
      const c = map.cells[y * map.sizeX + x]!
      samples[(map.sizeY - 1 - y) * map.sizeX + x] =
        channel === 'sum'
          ? clamp16(c.heightAdjustments + c.heightBase)
          : channel === 'adjustments'
            ? c.heightAdjustments
            : c.heightBase
    }
  }
  return encodeGray16(map.sizeX, map.sizeY, samples)
}

/**
 * Rebuild a height map from a 16-bit grayscale PNG. Decoded pixels become the
 * `channel` (default `base`); every other per-cell field comes from `ref` when
 * provided (so `writeHeightMap` reproduces the original bytes), else defaults.
 */
export function pngToHeight(
  png: Uint8Array,
  ref?: HeightMapResult,
  channel: Exclude<HeightChannel, 'sum'> = 'base',
): HeightMapResult {
  const { width, height, samples } = decodeGray16(png)
  const cells: HeightCell[] = new Array(samples.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x // grid index (row 0 = south)
      const sample = samples[(height - 1 - y) * width + x]! // PNG row 0 = north
      const r = ref?.cells[i]
      const base = channel === 'base' ? sample : (r?.heightBase ?? 0)
      const adj = channel === 'adjustments' ? sample : (r?.heightAdjustments ?? 0)
      cells[i] = { heightAdjustments: adj, heightBase: base, mask: r?.mask ?? 0 }
    }
  }
  return {
    sizeX: width,
    sizeY: height,
    version: ref?.version ?? 101,
    cells,
    _raw: ref?._raw ?? { padding: new Uint8Array(16), trailing: new Uint8Array(0) },
  }
}

// --- Cliff level (single channel → fully lossless with ref) ---

export function cliffLevelToPng(cliff: CliffLevelResult): Uint8Array {
  const samples = new Uint16Array(cliff.sizeX * cliff.sizeY)
  for (let y = 0; y < cliff.sizeY; y++) {
    for (let x = 0; x < cliff.sizeX; x++) {
      samples[(cliff.sizeY - 1 - y) * cliff.sizeX + x] = cliff.heights[y * cliff.sizeX + x]!
    }
  }
  return encodeGray16(cliff.sizeX, cliff.sizeY, samples)
}

export function pngToCliffLevel(png: Uint8Array, ref?: CliffLevelResult): CliffLevelResult {
  const { width, height, samples } = decodeGray16(png)
  const heights: number[] = new Array(samples.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      heights[y * width + x] = samples[(height - 1 - y) * width + x]!
    }
  }
  return {
    sizeX: width,
    sizeY: height,
    version: ref?.version ?? 100,
    heights,
    _raw: ref?._raw ?? { padding: new Uint8Array(16), trailing: new Uint8Array(0) },
  }
}

// --- Pathing info (visualization) ---

export interface PathingToPngOptions {
  /** Color for block value `0x0000`, normally passable. */
  passable?: [number, number, number]
  /** Color for block value `0x0002`, normally ramp. */
  ramp?: [number, number, number]
  /** Color for block value `0x0023`, normally impassable. */
  impassable?: [number, number, number]
  /** Color for any other block value. */
  unknown?: [number, number, number]
}

const DEFAULT_PATHING_COLORS: Required<PathingToPngOptions> = {
  passable: [42, 154, 99],
  ramp: [230, 181, 70],
  impassable: [45, 49, 57],
  unknown: [177, 82, 178],
}

/**
 * The known `t3SyncPathingInfo` values with the preview's colours; the map's layer legend reads the
 * same table. Other values are drawn in the `unknown` colour.
 */
export const PATHING_VALUES: readonly {
  readonly value: number
  readonly label: string
  readonly color: readonly [number, number, number]
}[] = Object.freeze([
  Object.freeze({ value: 0x00, label: 'Passable', color: DEFAULT_PATHING_COLORS.passable }),
  Object.freeze({ value: 0x02, label: 'Ramp', color: DEFAULT_PATHING_COLORS.ramp }),
  Object.freeze({ value: 0x23, label: 'Impassable', color: DEFAULT_PATHING_COLORS.impassable }),
])
export const PATHING_UNKNOWN_COLOR: readonly [number, number, number] = DEFAULT_PATHING_COLORS.unknown

/**
 * False-color pathing visualization. Known SC2 values render as passable
 * (`0x00`), ramp (`0x02`), and impassable (`0x23`); all other preserved values
 * use the unknown color.
 */
export function pathingToPng(pathing: PathingInfoResult, options: PathingToPngOptions = {}): Uint8Array {
  const colors = { ...DEFAULT_PATHING_COLORS, ...options }
  const rgb = new Uint8Array(pathing.sizeX * pathing.sizeY * 3)
  for (let y = 0; y < pathing.sizeY; y++) {
    for (let x = 0; x < pathing.sizeX; x++) {
      const value = pathing.blocks[y * pathing.sizeX + x]!
      const col =
        value === 0x00 ? colors.passable :
        value === 0x02 ? colors.ramp :
        value === 0x23 ? colors.impassable :
        colors.unknown
      const o = ((pathing.sizeY - 1 - y) * pathing.sizeX + x) * 3
      rgb[o] = col[0]
      rgb[o + 1] = col[1]
      rgb[o + 2] = col[2]
    }
  }
  return encodeRGB8(pathing.sizeX, pathing.sizeY, rgb)
}

// --- Cell flags (visualization) ---

export interface CellFlagsToPngOptions {
  /** Color for `0x00` (normal terrain). */
  normal?: [number, number, number]
  /** Color for `0x01` (near-ramp marker). */
  nearRamp?: [number, number, number]
  /** Color for `0x02` (secondary marker). */
  marker?: [number, number, number]
  /** Color for `0x03` (cliff hole — terrain punched out for cliff models). */
  cliffHole?: [number, number, number]
  /** Color for any other flag byte. */
  unknown?: [number, number, number]
}

const DEFAULT_CELL_FLAG_COLORS: Required<CellFlagsToPngOptions> = {
  normal: [42, 154, 99],
  nearRamp: [214, 69, 65],
  marker: [230, 181, 70],
  cliffHole: [45, 49, 57],
  unknown: [177, 82, 178],
}

/** False-color t3CellFlags visualization (PNG row 0 = map north). */
export function cellFlagsToPng(flags: CellFlagsResult, options: CellFlagsToPngOptions = {}): Uint8Array {
  const colors = { ...DEFAULT_CELL_FLAG_COLORS, ...options }
  const rgb = new Uint8Array(flags.sizeX * flags.sizeY * 3)
  for (let y = 0; y < flags.sizeY; y++) {
    for (let x = 0; x < flags.sizeX; x++) {
      const value = flags.types[y * flags.sizeX + x]!
      const col =
        value === 0x00 ? colors.normal :
        value === 0x01 ? colors.nearRamp :
        value === 0x02 ? colors.marker :
        value === 0x03 ? colors.cliffHole :
        colors.unknown
      const o = ((flags.sizeY - 1 - y) * flags.sizeX + x) * 3
      rgb[o] = col[0]
      rgb[o + 1] = col[1]
      rgb[o + 2] = col[2]
    }
  }
  return encodeRGB8(flags.sizeX, flags.sizeY, rgb)
}

// --- Painted pathing layer (visualization) ---

export interface PaintedPathingToPngOptions {
  /** Render the secondary paint byte instead of the primary. Default: primary. */
  secondary?: boolean
  /** Crop to the painted bounds header instead of the full 512×512 grid. Default: true when bounds exist. */
  cropToBounds?: boolean
}

/**
 * PaintedPathingLayer paint bytes as 16-bit grayscale (0 = unpainted, 255 =
 * full no-path stroke; intermediate values are brush strengths). PNG row 0 =
 * map north. Returns null for files that only round-trip as raw bytes.
 */
export function paintedPathingToPng(
  painted: PaintedPathingResult,
  options: PaintedPathingToPngOptions = {},
): Uint8Array | null {
  if (!painted.paint) return null
  const secondary = options.secondary ?? false
  const bounds = painted.bounds
  const crop = (options.cropToBounds ?? true) && bounds !== undefined &&
    bounds.maxX > bounds.minX && bounds.maxY > bounds.minY
  const minX = crop ? Math.max(0, bounds.minX) : 0
  const minY = crop ? Math.max(0, bounds.minY) : 0
  const maxX = crop ? Math.min(PAINTED_GRID_SIZE, bounds.maxX) : PAINTED_GRID_SIZE
  const maxY = crop ? Math.min(PAINTED_GRID_SIZE, bounds.maxY) : PAINTED_GRID_SIZE
  const width = maxX - minX
  const height = maxY - minY
  if (width <= 0 || height <= 0) return null

  const samples = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = paintedValueAt(painted, minX + x, minY + y, secondary)
      samples[(height - 1 - y) * width + x] = value * 257 // 8-bit → 16-bit full range
    }
  }
  return encodeGray16(width, height, samples)
}

// --- Vertex color (visualization) ---

export interface VertexColorToPngOptions {
  /** Output pixels per map coordinate unit when width/height are not supplied. Default: 4. */
  cellScale?: number
  /** Map width in coordinate units. Defaults to the max vertex-color bound. */
  mapWidth?: number
  /** Map height in coordinate units. Defaults to the max vertex-color bound. */
  mapHeight?: number
  /** Override output width in pixels. Defaults to mapWidth * cellScale. */
  width?: number
  /** Override output height in pixels. Defaults to mapHeight * cellScale. */
  height?: number
  /** RGB background representing "no vertex-color paint". Default: white. */
  background?: [number, number, number]
}

const DEFAULT_VERTEX_COLOR_BACKGROUND: [number, number, number] = [255, 255, 255]

/**
 * Render `t3VertCol` paint strokes as an 8-bit RGB debug PNG.
 *
 * SC2 stores one intensity byte per painted terrain vertex. Observed values
 * treat `0xFF` as no visible darkening and `0x00` as fully dark; this renderer
 * multiplies the background by that intensity and places each stroke using the
 * entry bounding-box metadata. If a patch's byte count does not match its
 * decoded bounds exactly, the bytes are fit into the bounds as a near-square
 * grid for visualization.
 */
export function vertexColorToPng(vertexColor: VertexColorResult, options: VertexColorToPngOptions = {}): Uint8Array {
  const geom = vertexColorGeometry(vertexColor, options)
  const bg = options.background ?? DEFAULT_VERTEX_COLOR_BACKGROUND
  const rgb = new Uint8Array(geom.imageWidth * geom.imageHeight * 3)
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = bg[0]
    rgb[i + 1] = bg[1]
    rgb[i + 2] = bg[2]
  }

  for (const entry of vertexColor.entries) {
    if (entry.header.layerIndex !== undefined && (entry.header.textureIndex !== 0 || entry.header.layerIndex !== 1 || entry.header.blendMode !== 0)) continue
    if (entry.data.length === 0 || !saneVertexEntry(entry)) continue
    const minX = Math.min(entry.header.minX, entry.header.maxX)
    const maxX = Math.max(entry.header.minX, entry.header.maxX)
    const minY = Math.min(entry.header.minY, entry.header.maxY)
    const maxY = Math.max(entry.header.minY, entry.header.maxY)
    const patch = inferVertexPatchGrid(entry.data.length, minX, maxX, minY, maxY)

    const a = project(geom, minX, minY)
    const b = project(geom, maxX, maxY)
    const left = Math.min(a.x, b.x)
    const right = Math.max(a.x, b.x)
    const top = Math.min(a.y, b.y)
    const bottom = Math.max(a.y, b.y)

    for (let py = 0; py < patch.height; py++) {
      const y0 = partitionStart(top, bottom, py, patch.height)
      const y1 = partitionEnd(top, bottom, py, patch.height)
      for (let px = 0; px < patch.width; px++) {
        const value = entry.data[Math.min(entry.data.length - 1, py * patch.width + px)]!
        const shade: [number, number, number] = [
          Math.round(bg[0] * value / 255),
          Math.round(bg[1] * value / 255),
          Math.round(bg[2] * value / 255),
        ]
        const x0 = partitionStart(left, right, px, patch.width)
        const x1 = partitionEnd(left, right, px, patch.width)
        fillRect(rgb, geom.imageWidth, geom.imageHeight, x0, y0, x1, y1, shade)
      }
    }
  }

  return encodeRGB8(geom.imageWidth, geom.imageHeight, rgb)
}

// --- Map overlays (visualization) ---

export interface OverlayToPngOptions {
  /** Output pixels per map cell. Default: 4. */
  cellScale?: number
  /** Override output width in pixels. Defaults to map width * cellScale. */
  width?: number
  /** Override output height in pixels. Defaults to map height * cellScale. */
  height?: number
  /** RGB background. Default: near-black. */
  background?: [number, number, number]
  /** Draw placed units from Objects. Default: true. */
  units?: boolean
  /** Draw ObjectDoodad entries from Objects. Default: true. */
  doodads?: boolean
  /** Draw ObjectPoint entries from Objects. Default: true. */
  points?: boolean
  /** Draw ObjectCamera entries from Objects. Default: true. */
  cameras?: boolean
  /** Draw Regions shapes. Default: true. */
  regions?: boolean
  /** Draw Water zones. Default: true. */
  water?: boolean
}

export type ComposeOverlayOptions = Omit<OverlayToPngOptions, 'background' | 'width' | 'height'>

const DEFAULT_OVERLAY_BACKGROUND: [number, number, number] = [18, 20, 24]
const UNIT_COLOR: [number, number, number] = [91, 173, 255]
const DOODAD_COLOR: [number, number, number] = [179, 126, 74]
const POINT_COLOR: [number, number, number] = [255, 215, 92]
const CAMERA_COLOR: [number, number, number] = [228, 99, 99]
const REGION_COLOR: [number, number, number] = [115, 238, 151]
const WATER_COLOR: [number, number, number] = [74, 161, 255]
const REGION_FILL_ALPHA = 0.18
const WATER_FILL_ALPHA = 0.35

interface OverlayGeometry {
  mapWidth: number
  mapHeight: number
  imageWidth: number
  imageHeight: number
}

/**
 * Render a debug overlay PNG for map objects, regions, and water zones.
 *
 * Coordinates are interpreted in map-cell/world units and scaled into the
 * output image. This is for visual debugging, not a Blizzard minimap renderer.
 */
export function overlayToPng(map: SC2MapData, options: OverlayToPngOptions = {}): Uint8Array {
  const geom = overlayGeometry(map, options)
  const bg = options.background ?? DEFAULT_OVERLAY_BACKGROUND
  const rgb = new Uint8Array(geom.imageWidth * geom.imageHeight * 3)
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = bg[0]
    rgb[i + 1] = bg[1]
    rgb[i + 2] = bg[2]
  }
  drawOverlay(rgb, geom, map, options)
  return encodeRGB8(geom.imageWidth, geom.imageHeight, rgb)
}

/**
 * Draw the same map overlay onto an existing 8-bit RGB PNG and return a new PNG.
 * Useful for rendering objects/regions/water over `textureToPng()` or
 * `pathingToPng()` output.
 */
export function composeOverlayToPng(
  basePng: Uint8Array,
  map: SC2MapData,
  options: ComposeOverlayOptions = {},
): Uint8Array {
  const base = decodePng(basePng)
  if (base.bitDepth !== 8 || base.colorType !== 2) {
    throw new Error(`composeOverlayToPng: expected 8-bit RGB PNG, got bitDepth ${base.bitDepth} colorType ${base.colorType}`)
  }
  const geom = overlayGeometry(map, { ...options, width: base.width, height: base.height })
  const rgb = base.pixels.slice()
  drawOverlay(rgb, geom, map, options)
  return encodeRGB8(base.width, base.height, rgb)
}

function drawOverlay(
  rgb: Uint8Array,
  geom: OverlayGeometry,
  map: SC2MapData,
  options: OverlayToPngOptions | ComposeOverlayOptions,
): void {
  if (options.water !== false && map.water) {
    for (const z of map.water.zones) {
      const a = project(geom, z.startX, z.startY)
      const b = project(geom, z.endX, z.endY)
      fillRectBlend(rgb, geom.imageWidth, geom.imageHeight, a.x, a.y, b.x, b.y, WATER_COLOR, WATER_FILL_ALPHA)
      drawRect(rgb, geom.imageWidth, geom.imageHeight, a.x, a.y, b.x, b.y, WATER_COLOR)
    }
  }

  if (options.regions !== false && map.regions) {
    for (const r of map.regions.regions) {
      for (const shape of r.shapes) {
        if (isCircleShape(shape)) {
          const c = parsePair(shape.center)
          const radius = Number(shape.radius)
          if (c && Number.isFinite(radius)) {
            const p = project(geom, c.x, c.y)
            const rPx = Math.max(1, Math.round(radius * geom.imageWidth / geom.mapWidth))
            fillDiskBlend(rgb, geom.imageWidth, geom.imageHeight, p.x, p.y, rPx, REGION_COLOR, REGION_FILL_ALPHA)
            drawCircle(rgb, geom.imageWidth, geom.imageHeight, p.x, p.y, rPx, REGION_COLOR)
          }
        } else if ((isRectShape(shape) || isDiamondShape(shape)) && shape.min && shape.max) {
          const min = parsePair(shape.min)
          const max = parsePair(shape.max)
          if (!min || !max) continue
          const a = project(geom, min.x, min.y)
          const b = project(geom, max.x, max.y)
          if (shape.type === 'rect') {
            fillRectBlend(rgb, geom.imageWidth, geom.imageHeight, a.x, a.y, b.x, b.y, REGION_COLOR, REGION_FILL_ALPHA)
            drawRect(rgb, geom.imageWidth, geom.imageHeight, a.x, a.y, b.x, b.y, REGION_COLOR)
          } else {
            const cx = Math.round((a.x + b.x) / 2)
            const cy = Math.round((a.y + b.y) / 2)
            fillDiamondBlend(rgb, geom.imageWidth, geom.imageHeight, a.x, a.y, b.x, b.y, REGION_COLOR, REGION_FILL_ALPHA)
            drawLine(rgb, geom.imageWidth, geom.imageHeight, cx, a.y, b.x, cy, REGION_COLOR)
            drawLine(rgb, geom.imageWidth, geom.imageHeight, b.x, cy, cx, b.y, REGION_COLOR)
            drawLine(rgb, geom.imageWidth, geom.imageHeight, cx, b.y, a.x, cy, REGION_COLOR)
            drawLine(rgb, geom.imageWidth, geom.imageHeight, a.x, cy, cx, a.y, REGION_COLOR)
          }
        }
      }
    }
  }

  if (map.objects) {
    if (options.units !== false) {
      for (const u of map.objects.units) drawMarkerAt(rgb, geom, u.position, UNIT_COLOR, 2)
    }
    if (options.doodads !== false) {
      for (const d of map.objects.doodads) drawMarkerAt(rgb, geom, d.position, DOODAD_COLOR, 1)
    }
    if (options.points !== false) {
      for (const p of map.objects.points) drawMarkerAt(rgb, geom, p.position, POINT_COLOR, 1)
    }
    if (options.cameras !== false) {
      for (const c of map.objects.cameras) drawMarkerAt(rgb, geom, c.position, CAMERA_COLOR, 2)
    }
  }
}

function overlayGeometry(map: SC2MapData, options: OverlayToPngOptions): OverlayGeometry {
  // Prefer cell dimensions; the height grid is the vertex grid (cells + 1) and
  // would skew world-coordinate projection by one cell across the map.
  const mapWidth = map.info?.width ?? map.pathing?.sizeX ?? map.cliffLevel?.sizeX ?? (map.height ? map.height.sizeX - 1 : 1)
  const mapHeight = map.info?.height ?? map.pathing?.sizeY ?? map.cliffLevel?.sizeY ?? (map.height ? map.height.sizeY - 1 : 1)
  const cellScale = options.cellScale ?? 4
  return {
    mapWidth,
    mapHeight,
    imageWidth: options.width ?? Math.max(1, Math.round(mapWidth * cellScale)),
    imageHeight: options.height ?? Math.max(1, Math.round(mapHeight * cellScale)),
  }
}

/**
 * Largest coordinate we treat as real. A desynced/corrupt vertex-color entry can carry
 * a garbage float (e.g. ~3e20) in its bounds; left unbounded that explodes the output
 * buffer (`Invalid typed array length`). Real map coordinates are far below this.
 */
const MAX_MAP_COORD = 1 << 16

/** A coordinate is usable only if finite and within sane map bounds. */
function saneCoord(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= MAX_MAP_COORD
}

/** A vertex-color entry has trustworthy bounds (skip garbage from a parse desync). */
function saneVertexEntry(entry: VertexColorResult['entries'][number]): boolean {
  return saneCoord(entry.header.minX) && saneCoord(entry.header.maxX)
    && saneCoord(entry.header.minY) && saneCoord(entry.header.maxY)
}

function vertexColorGeometry(vertexColor: VertexColorResult, options: VertexColorToPngOptions): OverlayGeometry {
  let maxX = 1
  let maxY = 1
  for (const entry of vertexColor.entries) {
    if (!saneVertexEntry(entry)) continue
    maxX = Math.max(maxX, entry.header.minX, entry.header.maxX)
    maxY = Math.max(maxY, entry.header.minY, entry.header.maxY)
  }
  const cellScale = options.cellScale ?? 4
  const mapWidth = clampDim(options.mapWidth ?? Math.ceil(maxX))
  const mapHeight = clampDim(options.mapHeight ?? Math.ceil(maxY))
  return {
    mapWidth,
    mapHeight,
    imageWidth: clampDim(options.width ?? Math.round(mapWidth * cellScale)),
    imageHeight: clampDim(options.height ?? Math.round(mapHeight * cellScale)),
  }
}

/** Keep a derived image dimension within [1, MAX_MAP_COORD] so allocation can't overflow. */
function clampDim(v: number): number {
  return Number.isFinite(v) ? Math.max(1, Math.min(MAX_MAP_COORD, Math.round(v))) : 1
}

function inferVertexPatchGrid(count: number, minX: number, maxX: number, minY: number, maxY: number): { width: number; height: number } {
  const boxWidth = Math.max(1, Math.round(Math.abs(maxX - minX)) + 1)
  const boxHeight = Math.max(1, Math.round(Math.abs(maxY - minY)) + 1)
  if (boxWidth * boxHeight === count) return { width: boxWidth, height: boxHeight }

  const square = Math.sqrt(count)
  if (Number.isInteger(square)) return { width: square, height: square }

  const ratio = boxHeight > 0 ? boxWidth / boxHeight : 1
  const width = Math.min(count, Math.max(1, Math.round(Math.sqrt(count * ratio))))
  return { width, height: Math.max(1, Math.ceil(count / width)) }
}

function parsePair(s: string): { x: number; y: number } | undefined {
  const parts = s.split(',').map(Number)
  const x = parts[0]
  const y = parts[1]
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

function isCircleShape(shape: RegionShape): shape is CircleShape {
  return shape.type === 'circle'
}

function isRectShape(shape: RegionShape): shape is RectShape {
  return shape.type === 'rect'
}

function isDiamondShape(shape: RegionShape): shape is DiamondShape {
  return shape.type === 'diamond'
}

function project(geom: OverlayGeometry, x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(Math.round((x / geom.mapWidth) * (geom.imageWidth - 1)), 0, geom.imageWidth - 1),
    y: clamp(Math.round((1 - y / geom.mapHeight) * (geom.imageHeight - 1)), 0, geom.imageHeight - 1),
  }
}

function drawMarkerAt(
  rgb: Uint8Array,
  geom: OverlayGeometry,
  pos: string,
  color: [number, number, number],
  radius: number,
): void {
  const p = parsePair(pos)
  if (!p) return
  const xy = project(geom, p.x, p.y)
  drawDisk(rgb, geom.imageWidth, geom.imageHeight, xy.x, xy.y, radius, color)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function setPixel(rgb: Uint8Array, width: number, height: number, x: number, y: number, color: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const o = (y * width + x) * 3
  rgb[o] = color[0]
  rgb[o + 1] = color[1]
  rgb[o + 2] = color[2]
}

function blendPixel(rgb: Uint8Array, width: number, height: number, x: number, y: number, color: [number, number, number], alpha: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const a = clamp(alpha, 0, 1)
  const inv = 1 - a
  const o = (y * width + x) * 3
  rgb[o] = Math.round(rgb[o]! * inv + color[0] * a)
  rgb[o + 1] = Math.round(rgb[o + 1]! * inv + color[1] * a)
  rgb[o + 2] = Math.round(rgb[o + 2]! * inv + color[2] * a)
}

function drawDisk(rgb: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, color: [number, number, number]): void {
  const r2 = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r2) setPixel(rgb, width, height, x, y, color)
    }
  }
}

function fillDiskBlend(rgb: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, color: [number, number, number], alpha: number): void {
  const r2 = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r2) blendPixel(rgb, width, height, x, y, color, alpha)
    }
  }
}

function drawLine(rgb: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  while (true) {
    setPixel(rgb, width, height, x0, y0, color)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
}

function drawRect(rgb: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  drawLine(rgb, width, height, left, top, right, top, color)
  drawLine(rgb, width, height, right, top, right, bottom, color)
  drawLine(rgb, width, height, right, bottom, left, bottom, color)
  drawLine(rgb, width, height, left, bottom, left, top, color)
}

function fillRect(rgb: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  const left = clamp(Math.min(x0, x1), 0, width - 1)
  const right = clamp(Math.max(x0, x1), 0, width - 1)
  const top = clamp(Math.min(y0, y1), 0, height - 1)
  const bottom = clamp(Math.max(y0, y1), 0, height - 1)
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      setPixel(rgb, width, height, x, y, color)
    }
  }
}

function fillRectBlend(rgb: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number], alpha: number): void {
  const left = clamp(Math.min(x0, x1), 0, width - 1)
  const right = clamp(Math.max(x0, x1), 0, width - 1)
  const top = clamp(Math.min(y0, y1), 0, height - 1)
  const bottom = clamp(Math.max(y0, y1), 0, height - 1)
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      blendPixel(rgb, width, height, x, y, color, alpha)
    }
  }
}

function fillDiamondBlend(rgb: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: [number, number, number], alpha: number): void {
  const left = clamp(Math.min(x0, x1), 0, width - 1)
  const right = clamp(Math.max(x0, x1), 0, width - 1)
  const top = clamp(Math.min(y0, y1), 0, height - 1)
  const bottom = clamp(Math.max(y0, y1), 0, height - 1)
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const halfW = Math.max(1, (right - left) / 2)
  const halfH = Math.max(1, (bottom - top) / 2)
  for (let y = top; y <= bottom; y++) {
    const dy = Math.abs(y - cy) / halfH
    const span = Math.max(0, halfW * (1 - dy))
    const rowLeft = Math.ceil(cx - span)
    const rowRight = Math.floor(cx + span)
    for (let x = rowLeft; x <= rowRight; x++) {
      blendPixel(rgb, width, height, x, y, color, alpha)
    }
  }
}

function partitionStart(a: number, b: number, index: number, count: number): number {
  const size = Math.abs(b - a) + 1
  return Math.min(a, b) + Math.floor(size * index / count)
}

function partitionEnd(a: number, b: number, index: number, count: number): number {
  const size = Math.abs(b - a) + 1
  return Math.min(a, b) + Math.floor(size * (index + 1) / count) - 1
}

function drawCircle(rgb: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, color: [number, number, number]): void {
  let x = radius
  let y = 0
  let err = 0
  while (x >= y) {
    setPixel(rgb, width, height, cx + x, cy + y, color)
    setPixel(rgb, width, height, cx + y, cy + x, color)
    setPixel(rgb, width, height, cx - y, cy + x, color)
    setPixel(rgb, width, height, cx - x, cy + y, color)
    setPixel(rgb, width, height, cx - x, cy - y, color)
    setPixel(rgb, width, height, cx - y, cy - x, color)
    setPixel(rgb, width, height, cx + y, cy - x, color)
    setPixel(rgb, width, height, cx + x, cy - y, color)
    y++
    if (err <= 0) err += 2 * y + 1
    if (err > 0) {
      x--
      err -= 2 * x + 1
    }
  }
}

// --- Texture masks (visualization) ---

/** Distinct base colors per layer; layers beyond the palette wrap around. */
const DEFAULT_LAYER_COLORS: [number, number, number][] = [
  [220, 60, 60],
  [60, 200, 80],
  [70, 110, 230],
  [230, 200, 50],
  [200, 90, 210],
  [60, 200, 210],
  [235, 140, 50],
  [150, 150, 150],
]

export interface TextureToPngOptions {
  /** Per-layer RGB colors; defaults to an 8-color palette (wraps for more layers). */
  colors?: [number, number, number][]
}

/**
 * Mask-only false-color blend of the texture layers — each layer tinted and
 * weighted by its 4-bit value, summed and clamped. Visualization only (not
 * invertible); real-texture compositing needs DDS decode (out of scope, see m3).
 */
export function textureToPng(masks: TextureMasksResult, options: TextureToPngOptions = {}): Uint8Array {
  const colors = options.colors ?? DEFAULT_LAYER_COLORS
  const { sizeX, sizeY, layers } = masks
  const rgb = new Uint8Array(sizeX * sizeY * 3)
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let l = 0; l < layers; l++) {
        const w = textureMaskWeight(masks, l, x, y) / 15
        if (w === 0) continue
        const col = colors[l % colors.length]!
        r += col[0] * w
        g += col[1] * w
        b += col[2] * w
      }
      const o = ((sizeY - 1 - y) * sizeX + x) * 3 // PNG row 0 = map north
      rgb[o] = r > 255 ? 255 : r
      rgb[o + 1] = g > 255 ? 255 : g
      rgb[o + 2] = b > 255 ? 255 : b
    }
  }
  return encodeRGB8(sizeX, sizeY, rgb)
}
