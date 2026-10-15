/**
 * Parser and writer for the `t3VertCol` file (also `mapVertexColor`) embedded
 * in `.SC2Map` archives. Binary format: magic "VTCL", versions 103 and 104.
 *
 * Stores per-vertex terrain color data as a sequence of paint-stroke entries.
 * Regular layer-1 entries cover rectangular vertex patches. Other record types
 * have not been fully decoded and are preserved without applying them as AO.
 *
 * ## Format layout (little-endian)
 *
 * ```
 * [0..3]   magic     "VTCL"
 * [4..7]   version   uint32 (103 or 104)
 * [8..11]  count     uint32 — number of entries
 * [12..15] zeros     uint32
 * [16..31] prologue  16 bytes (all zeros; appears to be a section separator)
 * Repeated `count` times:
 *   header   24 bytes in v103, 32 bytes in v104 (stored verbatim)
 *   n        uint32 — number of data bytes
 *   data     n bytes
 * ```
 *
 * Headers begin with texture/layer int32 indices, then four float32 bounds.
 * Version 104 adds enabled/blend-mode int32 fields. Version 103 headers are
 * normalized to 32 bytes in memory and written back as 24 bytes.
 *
 * Browser-safe: DataView only, zero external dependencies.
 *
 * @see https://www.sc2mapster.com/wiki/sc2/file-format/t3vertcol (structure
 *      discovered via binary analysis — wiki admits the data layout was
 *      previously unknown)
 */

import { Cursor, Writer } from '../binary.js'

export const VTCL_MAGIC = 'VTCL'
export const VTCL_VERSION = 104

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded fields from a 32-byte entry header.
 *
 * Regular layer-1 headers encode bounds on the terrain mesh:
 *  - `(minX, minY)` — lower-left corner in terrain coordinates
 *  - `(maxX, maxY)` — upper-right corner
 *
 * `minZ` is retained only for compatibility; the decoded bounds are 2D.
 */
export interface VtclEntryHeader {
  /** Raw 32-byte header — preserved verbatim for byte-exact round-trip. */
  raw: Uint8Array
  textureIndex: number
  layerIndex: number
  enabled: boolean
  blendMode: number
  /** Terrain X lower bound (float at byte 8), observed on regular layer-1 entries. */
  minX: number
  /** Terrain Y lower bound (float at byte 12). */
  minY: number
  /** Deprecated compatibility field. VTCL bounds are two-dimensional. */
  minZ: number
  /** Terrain Y upper bound (float at byte 20). */
  maxY: number
  /** Terrain X upper bound (float at byte 16). */
  maxX: number
}

/**
 * One paint-stroke entry: a metadata header describing the painted area, plus
 * per-vertex color bytes for every vertex in that area.
 *
 * Each byte in `data` is the painted color value (0–255) for one terrain
 * vertex in the patch. The patch is `sqrtN × sqrtN` vertices for square
 * patches, or a non-square arrangement for edge/corner patches.
 */
export interface VtclEntry {
  header: VtclEntryHeader
  /** Per-vertex color bytes. `data.length === n` from the file. */
  data: Uint8Array
}

export interface VertexColorResult {
  version: number
  /**
   * Raw 16-byte section prologue (all zeros in all observed files).
   * Stored verbatim so the writer can reproduce it exactly.
   */
  prologue: Uint8Array
  entries: VtclEntry[]
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const ascii = new TextDecoder('ascii')

function decodeHeader(raw: Uint8Array): VtclEntryHeader {
  const v = new DataView(raw.buffer, raw.byteOffset, 32)
  return {
    raw,
    textureIndex: v.getInt32(0, true),
    layerIndex: v.getInt32(4, true),
    minX: v.getFloat32(8, true),
    minY: v.getFloat32(12, true),
    minZ: 0,
    maxX: v.getFloat32(16, true),
    maxY: v.getFloat32(20, true),
    enabled: v.getInt32(24, true) !== 0,
    blendMode: v.getInt32(28, true),
  }
}

export function readVertexColor(buf: Uint8Array): VertexColorResult {
  const cur = new Cursor(buf)

  const magic = ascii.decode(cur.bytesOf(4))
  if (magic !== VTCL_MAGIC) {
    throw new Error(`readVertexColor: expected magic "${VTCL_MAGIC}", got "${magic}"`)
  }

  const version = cur.u32()
  if (version !== 103 && version !== 104) throw new Error(`unsupported VTCL version ${version}`)
  const count = cur.u32()
  cur.u32() // zeros at [12..15]

  // 16-byte section prologue (all zeros in all observed files)
  const prologue = cur.bytesOf(16)

  const entries: VtclEntry[] = []
  const headerSize = version === 103 ? 24 : 32
  cur.require(count * (headerSize + 4), 'VTCL entry count')
  for (let i = 0; i < count; i++) {
    cur.require(headerSize + 4, `VTCL entry ${i} header+count`)
    const headerRaw = new Uint8Array(32)
    headerRaw.set(cur.bytesOf(headerSize))
    const header = decodeHeader(headerRaw)
    const n = cur.u32()
    cur.require(n, `VTCL entry ${i} data (n=${n})`)
    const data = cur.bytesOf(n)
    entries.push({ header, data })
  }

  return { version, prologue, entries }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeVertexColor(result: VertexColorResult): Uint8Array {
  if (result.version !== 103 && result.version !== 104) throw new Error(`unsupported VTCL version ${result.version}`)
  const headerSize = result.version === 103 ? 24 : 32
  // Compute total size up front for a single allocation.
  // file-header(16) + prologue(16) + count*(32+4+n_i)
  const bodySize = result.entries.reduce((s, e) => s + headerSize + 4 + e.data.length, 0)
  const totalSize = 32 + bodySize

  const w = new Writer(totalSize)
  // File header
  w.ascii(VTCL_MAGIC)
  w.u32(result.version)
  w.u32(result.entries.length)
  w.u32(0)
  // Section prologue
  w.raw(result.prologue.length === 16 ? result.prologue : new Uint8Array(16))
  // Entries
  for (const entry of result.entries) {
    w.raw(entry.header.raw.subarray(0, headerSize))
    w.u32(entry.data.length)
    w.raw(entry.data)
  }

  return w.done()
}

/** Regular layer-1 scalar lattice. Other record types remain preserved, without guessing their decode. */
export function vertexColorScalarGrid(result: VertexColorResult, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 4_194_304)
    throw new Error('VTCL grid dimensions exceed the terrain budget')
  const grid = new Uint8Array(width * height).fill(255)
  for (const { header: h, data } of result.entries) {
    if (h.textureIndex !== 0 || h.layerIndex !== 1 || h.blendMode !== 0) continue
    const values = [h.minX, h.minY, h.maxX, h.maxY]
    if (!values.every(Number.isSafeInteger) || h.minX < 0 || h.minY < 0 || h.maxX >= width || h.maxY >= height) continue
    const w = h.maxX - h.minX + 1, n = h.maxY - h.minY + 1
    if (w <= 0 || n <= 0 || data.length !== w * n) continue
    for (let y = 0; y < n; y++) grid.set(data.subarray(y * w, (y + 1) * w), (h.minY + y) * width + h.minX)
  }
  return grid
}
