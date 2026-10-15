/**
 * t3TextureMasks — `mapTextureMasks`, magic `MASK`.
 *
 * ```c
 * struct Header {
 *   char magic[4]; uint32 version; uint32 unk; uint32 sizeX; uint32 sizeY; uint32 zero[11];
 * };  // 64 bytes total
 * // Body = per-layer weight maps, tiled into 64×64-pixel blocks.
 * struct Block { uint8 data[64 * 32]; }   // 2048 bytes: 64 rows × 32 bytes, 2 pixels per byte
 * ```
 *
 * `sizeX`/`sizeY` are in **pixels** (terrain texel resolution, 8× the cliff grid).
 * Each byte packs two horizontally-adjacent 4-bit weights, **high nibble first**.
 * The body is split into 64×64-pixel tiles, row-major; each layer is a full grid
 * of tiles, and layers are stored consecutively:
 *
 *   blocksPerLayer = ceil(sizeX/64) * ceil(sizeY/64)
 *   layers         = totalBlocks / blocksPerLayer
 *
 * (The number of mask layers is derived from the file size — it is independent of
 * the texture count in `t3Terrain.xml`; real maps observed with 8 layers.)
 *
 * Byte-exact round-trip: `version`, `unk`, the 44-byte zero region, the raw body
 * and any leftover trailing bytes are preserved verbatim.
 */

import { Cursor, Writer } from '../binary.js'

export const TEXTURE_MASKS_MAGIC = 'MASK'
const HEADER_ZERO = 44 // zero[11]
const TILE = 64 // pixels per tile edge
const ROW_BYTES = TILE / 2 // 32 bytes per pixel row (2 px/byte)
export const TEXTURE_BLOCK_SIZE = TILE * ROW_BYTES // 2048

export interface TextureMasksResult {
  sizeX: number // pixels
  sizeY: number // pixels
  version: number
  unk: number
  tilesX: number
  tilesY: number
  blocksPerLayer: number
  layers: number
  /** Raw mask body after the 64-byte header. */
  body: Uint8Array
  _raw: { zero: Uint8Array; trailing: Uint8Array }
}

export function readTextureMasks(data: Uint8Array): TextureMasksResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== TEXTURE_MASKS_MAGIC) {
    throw new Error(`Invalid MASK: bad magic "${magic}" (expected "${TEXTURE_MASKS_MAGIC}")`)
  }
  const version = c.u32()
  const unk = c.u32()
  const sizeX = c.u32()
  const sizeY = c.u32()
  const zero = c.bytesOf(HEADER_ZERO)

  const tilesX = Math.ceil(sizeX / TILE)
  const tilesY = Math.ceil(sizeY / TILE)
  const blocksPerLayer = tilesX * tilesY

  const rest = c.rest()
  const totalBlocks = Math.floor(rest.length / TEXTURE_BLOCK_SIZE)
  if (blocksPerLayer === 0) {
    throw new Error(`Invalid MASK: zero dimensions (${sizeX}×${sizeY})`)
  }
  const layers = Math.floor(totalBlocks / blocksPerLayer)
  const bodyLen = layers * blocksPerLayer * TEXTURE_BLOCK_SIZE
  const body = rest.subarray(0, bodyLen)
  const trailing = rest.slice(bodyLen)

  return {
    sizeX,
    sizeY,
    version,
    unk,
    tilesX,
    tilesY,
    blocksPerLayer,
    layers,
    body: body.slice(),
    _raw: { zero, trailing },
  }
}

export function writeTextureMasks(m: TextureMasksResult): Uint8Array {
  const w = new Writer(64 + m.body.length + m._raw.trailing.length)
  w.ascii(TEXTURE_MASKS_MAGIC).u32(m.version).u32(m.unk).u32(m.sizeX).u32(m.sizeY).raw(m._raw.zero)
  return w.raw(m.body).raw(m._raw.trailing).done()
}

/** Author a bounded north-first weight window; never mutate the source or unedited nibbles.
 * Native MASK rows are south-first. Weights remain raw 0..15; no palette inference or normalization. */
export function setTextureMaskWindow(
  map: TextureMasksResult,
  layer: number,
  window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly values: readonly number[] },
  options: { readonly maxSamples?: number; readonly signal?: AbortSignal } = {},
): TextureMasksResult {
  const bounded = (value: number, min: number, max: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid texture mask ${label}`)
  }
  options.signal?.throwIfAborted()
  bounded(layer, 0, map.layers - 1, 'layer')
  bounded(window.x, 0, map.sizeX - 1, 'x'); bounded(window.y, 0, map.sizeY - 1, 'y')
  bounded(window.width, 1, map.sizeX - window.x, 'width'); bounded(window.height, 1, map.sizeY - window.y, 'height')
  const count = window.width * window.height, limit = options.maxSamples ?? 1_048_576
  bounded(limit, 1, 16_777_216, 'sample budget')
  if (count > limit || !Array.isArray(window.values) || window.values.length !== count)
    throw new RangeError('Texture mask window exceeds sample budget or has the wrong value count')
  for (let index = 0; index < count; index++) bounded(window.values[index]!, 0, 15, 'weight')
  const next = { ...map, body: map.body.slice(), _raw: { zero: map._raw.zero.slice(), trailing: map._raw.trailing.slice() } }
  for (let row = 0; row < window.height; row++) {
    options.signal?.throwIfAborted()
    const y = map.sizeY - 1 - (window.y + row)
    for (let column = 0; column < window.width; column++) {
      const x = window.x + column
      const block = layer * map.blocksPerLayer + Math.floor(y / TILE) * map.tilesX + Math.floor(x / TILE)
      const offset = block * TEXTURE_BLOCK_SIZE + (y % TILE) * ROW_BYTES + ((x % TILE) >> 1)
      if (offset >= next.body.length) throw new RangeError('Texture mask block is missing')
      const before = next.body[offset]!, weight = window.values[row * window.width + column]!
      next.body[offset] = (x & 1) === 0 ? (weight << 4) | (before & 15) : (before & 240) | weight
    }
  }
  return next
}

/**
 * Weight (0–15) of a texture `layer` at pixel (`x`, `y`).
 *
 * Tile/layer ordering assumption: layers are consecutive; within a layer, tiles
 * are row-major (`ty * tilesX + tx`); within a tile, rows are top-to-bottom and
 * each byte holds the even pixel in its high nibble, the odd pixel in its low nibble.
 */
export function textureMaskWeight(
  m: TextureMasksResult,
  layer: number,
  x: number,
  y: number,
): number {
  const tx = Math.floor(x / TILE)
  const ty = Math.floor(y / TILE)
  const ix = x % TILE
  const iy = y % TILE
  const block = layer * m.blocksPerLayer + (ty * m.tilesX + tx)
  const off = block * TEXTURE_BLOCK_SIZE + iy * ROW_BYTES + (ix >> 1)
  const b = m.body[off] ?? 0
  return (ix & 1) === 0 ? (b >> 4) & 0x0f : b & 0x0f
}

/** Extract a full row-major (`y * sizeX + x`) weight grid (0–15) for one layer. */
export function extractLayerWeights(m: TextureMasksResult, layer: number): Uint8Array {
  const out = new Uint8Array(m.sizeX * m.sizeY)
  for (let y = 0; y < m.sizeY; y++) {
    for (let x = 0; x < m.sizeX; x++) {
      out[y * m.sizeX + x] = textureMaskWeight(m, layer, x, y)
    }
  }
  return out
}
