/**
 * Minimal, dependency-free reader for `t3Terrain.xml`.
 *
 * `t3Terrain.xml` is plain XML, but `@modkitx/maps-processing/sc2-map-core` stays zero-dependency and
 * browser-safe, so we extract only the handful of fields the binary codecs need
 * via attribute regex rather than pulling in an XML parser:
 *
 *   - `quantizeScale` / `quantizeBias` / `standardHeight` — decode t3HeightMap levels
 *   - the `<textureList>` index → name map — label t3TextureMasks layers
 *   - height-map `dim` (cells) and `tileSet`, when present
 *
 * For full XML access use `@modkitx/xml` in a higher layer.
 */

import type { TerrainParams } from './formats/height-map.js'

export interface TerrainTexture {
  index: number
  name: string
}

/** `<cc f="…">` — what the editor painted on this tile. */
export const CLIFF_CELL_FLAT = 0
export const CLIFF_CELL_WALL = 1
export const CLIFF_CELL_RAMP = 2

/**
 * One `<cc>` row of `<cliffCellList>`: the map's OWN record of a 2x2-cell cliff
 * tile. Cliff tiles are authored, not derived — the level field supplies the
 * mesh code, but which cliff set and which variation to use is stored here.
 */
export interface CliffCell {
  /** Index into the `(cliffSizeX/2) × (cliffSizeY/2)` tile lattice, row-major. */
  index: number
  /** `f` — `CLIFF_CELL_FLAT` / `_WALL` / `_RAMP`. */
  flags: number
  /** `cid` — index into `cliffSets`. */
  cliffSetIndex: number
  /** `cvar` — authored mesh variation (`_00`…`_03`). */
  variation: number
}

/** One positioned frame of a `<ramp>`: `u(..) r(..) c=(..) w=.. h=..`. */
export interface TerrainRampFrame {
  /** Unit "up" vector along the ramp. */
  up: [number, number]
  /** Unit "right" vector across the ramp. */
  right: [number, number]
  /** Centre, in cliff-cell coordinates. */
  center: [number, number]
  width: number
  height: number
}

/**
 * One `<ramp>` of `<rampList>`. Ramps are authored objects with their own
 * geometry — no lattice rule derives them from the level field, which is why
 * ramp tiles have codes that ship in none of the cliff mesh sets.
 */
export interface TerrainRamp {
  /** Direction code, 3–7 observed. */
  dir: number
  /** Upper / lower cliff level, in units of four (`lo=2 hi=3` is the C→D ramp). */
  hi: number
  lo: number
  /** `cid` — index into `cliffSets`. */
  cliffSetIndex: number
  frames: {
    leftLo?: TerrainRampFrame
    leftHi?: TerrainRampFrame
    rightLo?: TerrainRampFrame
    rightHi?: TerrainRampFrame
    base?: TerrainRampFrame
    mid?: TerrainRampFrame
  }
  /** Per-corner variation; absent corners are `0xffffffff` in the file. */
  variations: {
    leftLo?: number
    leftHi?: number
    rightLo?: number
    rightHi?: number
  }
}

export interface TerrainInfo extends TerrainParams {
  tileSet?: string
  dimX?: number
  dimY?: number
  /** World-space grid origin from `<heightMap offset="x y z">` (default 0 0 0). */
  offsetX?: number
  offsetY?: number
  offsetZ?: number
  /** World units per cell from `<heightMap scale="x y z">` (default 1 1 1). */
  scaleX?: number
  scaleY?: number
  scaleZ?: number
  /** Textures in declaration order (index from the `i=` attribute). */
  textures: TerrainTexture[]
  /** Map-selected CCliff ids, in editor cliff-set order. */
  cliffSets?: string[]
  /** `<cliffCellList num>` — size of the tile lattice (`cliffSize/2` squared). */
  cliffCellCount?: number
  /** Authored cliff tiles (`<cc>` rows), sparse: only occupied lattice cells. */
  cliffCells?: CliffCell[]
  /** Authored ramps (`<rampList>`). */
  ramps?: TerrainRamp[]
}

/** `u(x, y) r(x, y) c=(x, y) w=W h=H` — one positioned ramp frame. */
function parseRampFrame(text: string | undefined): TerrainRampFrame | undefined {
  if (!text) return undefined
  const n = '([-\\d.eE+]+)'
  const m = new RegExp(
    `u\\(\\s*${n}\\s*,\\s*${n}\\s*\\)\\s*r\\(\\s*${n}\\s*,\\s*${n}\\s*\\)\\s*` +
      `c=\\(\\s*${n}\\s*,\\s*${n}\\s*\\)\\s*w=${n}\\s*h=${n}`,
  ).exec(text)
  if (!m) return undefined
  const v = m.slice(1, 11).map(Number.parseFloat)
  if (v.some(Number.isNaN)) return undefined
  const frame: TerrainRampFrame = {
    up: [v[0]!, v[1]!],
    right: [v[2]!, v[3]!],
    center: [v[4]!, v[5]!],
    width: v[6]!,
    height: v[7]!,
  }
  // An unused corner is written as an all-zero frame; report it as absent so
  // callers do not place geometry at the map origin.
  const allZero = v.slice(0, 8).every(value => value === 0)
  return allZero ? undefined : frame
}

/** `0xffffffff` is the file's "no variation" sentinel. */
const RAMP_VARIATION_NONE = 4294967295

function parseRampList(xml: string): TerrainRamp[] {
  const section = /<rampList\b[^>]*>([\s\S]*?)<\/rampList>/.exec(xml)?.[1]
  if (!section) return []
  const out: TerrainRamp[] = []
  const rampRe = /<ramp\b([^>]*)\/?>/g
  for (let m = rampRe.exec(section); m !== null; m = rampRe.exec(section)) {
    const body = m[1]!
    const attr = (name: string): string | undefined =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(body)?.[1]
    const int = (name: string): number => Number.parseInt(attr(name) ?? '', 10) || 0
    const variation = (name: string): number | undefined => {
      const value = Number.parseInt(attr(name) ?? '', 10)
      return Number.isFinite(value) && value !== RAMP_VARIATION_NONE ? value : undefined
    }
    const frames: TerrainRamp['frames'] = {}
    for (const key of ['leftLo', 'leftHi', 'rightLo', 'rightHi', 'base', 'mid'] as const) {
      const frame = parseRampFrame(attr(key))
      if (frame) frames[key] = frame
    }
    const variations: TerrainRamp['variations'] = {}
    for (const key of ['leftLo', 'leftHi', 'rightLo', 'rightHi'] as const) {
      const value = variation(`${key}Var`)
      if (value !== undefined) variations[key] = value
    }
    out.push({
      dir: int('dir'),
      hi: int('hi'),
      lo: int('lo'),
      cliffSetIndex: int('cid'),
      frames,
      variations,
    })
  }
  return out
}

function attrNumber(xml: string, name: string): number | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml)
  if (!m || m[1] === undefined) return undefined
  const v = Number.parseFloat(m[1])
  return Number.isNaN(v) ? undefined : v
}

/** Parse the terrain fields needed by the binary codecs from `t3Terrain.xml` text. */
export function parseTerrainXml(xml: string): TerrainInfo {
  const quantizeScale = attrNumber(xml, 'quantizeScale') ?? 0
  const quantizeBias = attrNumber(xml, 'quantizeBias') ?? 0
  const standardHeight = attrNumber(xml, 'standardHeight') ?? 0

  const tileSetMatch = /\btileSet="([^"]*)"/.exec(xml)
  const tileSet = tileSetMatch?.[1]

  let dimX: number | undefined
  let dimY: number | undefined
  const dimMatch = /\bdim="\s*(\d+)\s+(\d+)/.exec(xml)
  if (dimMatch?.[1] && dimMatch[2]) {
    dimX = Number.parseInt(dimMatch[1], 10)
    dimY = Number.parseInt(dimMatch[2], 10)
  }

  // <heightMap offset="x y z"> / <heightMap scale="x y z"> — world-space grid
  // geometry (engine defaults: offset 0 0 0, scale 1 1 1).
  const vec3 = (name: string): [number, number, number] | undefined => {
    const m = new RegExp(`\\b${name}="\\s*([-\\d.eE]+)\\s+([-\\d.eE]+)\\s+([-\\d.eE]+)`).exec(xml)
    if (!m) return undefined
    const v = [Number.parseFloat(m[1]!), Number.parseFloat(m[2]!), Number.parseFloat(m[3]!)]
    return v.some(Number.isNaN) ? undefined : (v as [number, number, number])
  }
  const offset = vec3('offset')
  const scale = vec3('scale')

  const textures: TerrainTexture[] = []
  const texRe = /<texture\s+i="(\d+)"\s+name="([^"]*)"/g
  for (let m = texRe.exec(xml); m !== null; m = texRe.exec(xml)) {
    textures.push({ index: Number.parseInt(m[1]!, 10), name: m[2]! })
  }

  const cliffSets: string[] = []
  const cliffSection = /<cliffSetList\b[^>]*>([\s\S]*?)<\/cliffSetList>/.exec(xml)?.[1]
  if (cliffSection) {
    const cliffRe = /<cliffSet\s+i="(\d+)"\s+name="([^"]*)"/g
    for (let m = cliffRe.exec(cliffSection); m !== null; m = cliffRe.exec(cliffSection)) {
      cliffSets[Number.parseInt(m[1]!, 10)] = m[2]!
    }
  }

  // <cliffCellList num="7744" numOccupied="4394"><cc i="1" f="0" cid="1" cvar="0"/>…
  // Scoped to the element so a stray <cc> elsewhere can't leak in.
  const cliffCellSection = /<cliffCellList\b([^>]*)>([\s\S]*?)<\/cliffCellList>/.exec(xml)
  const cliffCellCount = cliffCellSection
    ? Number.parseInt(/\bnum="(\d+)"/.exec(cliffCellSection[1]!)?.[1] ?? '', 10)
    : Number.NaN
  const cliffCells: CliffCell[] = []
  if (cliffCellSection?.[2]) {
    const ccRe = /<cc\b([^>]*)\/?>/g
    for (let m = ccRe.exec(cliffCellSection[2]); m !== null; m = ccRe.exec(cliffCellSection[2])) {
      const body = m[1]!
      const int = (name: string): number | undefined => {
        const value = Number.parseInt(new RegExp(`\\b${name}="(\\d+)"`).exec(body)?.[1] ?? '', 10)
        return Number.isFinite(value) ? value : undefined
      }
      const index = int('i')
      const flags = int('f')
      const cliffSetIndex = int('cid')
      const variation = int('cvar')
      if (
        index === undefined ||
        flags === undefined ||
        cliffSetIndex === undefined ||
        variation === undefined
      ) {
        continue
      }
      cliffCells.push({
        index,
        flags,
        cliffSetIndex,
        variation,
      })
    }
  }

  const ramps = parseRampList(xml)

  const info: TerrainInfo = { quantizeScale, quantizeBias, standardHeight, textures }
  if (tileSet !== undefined) info.tileSet = tileSet
  if (cliffSets.some(Boolean)) info.cliffSets = cliffSets
  if (Number.isFinite(cliffCellCount)) info.cliffCellCount = cliffCellCount
  if (cliffCells.length > 0) info.cliffCells = cliffCells
  if (ramps.length > 0) info.ramps = ramps
  if (dimX !== undefined) info.dimX = dimX
  if (dimY !== undefined) info.dimY = dimY
  if (offset) {
    info.offsetX = offset[0]
    info.offsetY = offset[1]
    info.offsetZ = offset[2]
  }
  if (scale) {
    info.scaleX = scale[0]
    info.scaleY = scale[1]
    info.scaleZ = scale[2]
  }
  return info
}
