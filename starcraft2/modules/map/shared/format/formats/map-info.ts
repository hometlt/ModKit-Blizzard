/**
 * MapInfo — `MapInfo`, magic `MapI`.
 *
 * MapInfo is a large, **version-dependent** variable struct (theme/planet
 * strings, playable boundaries, loader image, and a per-player table). The
 * published wiki spec is only partially accurate and disagrees with real files
 * (e.g. width/height are not at the documented offsets). Rather than guess the
 * deeper layout, this is an honest **partial** codec.
 *
 * Note: unlike the `char[4]` terrain formats (HMAP, SMAP, …), MapInfo stores its
 * FourCC as a little-endian **DWORD**, so on disk the first four bytes read
 * "IpaM" — i.e. "MapI" byte-reversed. The codec handles this transparently.
 *
 * Reliably parsed (verified across map versions 31 and 39):
 * ```
 *   0  uint32 magic      // FourCC "MapI" (stored byte-reversed as "IpaM")
 *   4  uint32 version    // 31, 39, …
 *   8  uint32 unknown1
 *  12  uint32 unknown2
 *  16  uint32 width      // map cells
 *  20  uint32 height     // map cells
 * ```
 * Everything from offset 24 to EOF is kept verbatim in `body` (version-specific:
 * theme/planet strings, boundaries, player slots). This guarantees a byte-exact
 * round-trip and lets callers read/edit dimensions, while the irregular tail is
 * preserved untouched. `strings` surfaces null-terminated ASCII runs found in the
 * body as a heuristic convenience (no structural guarantees).
 * An opt-in v39 editor-context writer admits only the observed 18-byte-prefix,
 * fog-style/string/boundary layout, with an expected-old-context guard. Other
 * versions/layouts remain opaque; runtime tileset semantics are not inferred.
 */

import { Cursor, Writer } from '../binary.js'

export const MAP_INFO_MAGIC = 'MapI'
/** On-disk byte order: "MapI" stored as a little-endian DWORD → "IpaM". */
const MAP_INFO_MAGIC_ONDISK = 'IpaM'
const FIXED_HEADER = 24

export interface MapInfoResult {
  version: number
  /** Map width in cells (offset 16). */
  width: number
  /** Map height in cells (offset 20). */
  height: number
  unknown1: number
  unknown2: number
  /** Bytes from offset 24 to EOF — version-dependent, preserved verbatim. */
  body: Uint8Array
  /** Heuristic: null-terminated ASCII runs (>=3 chars) found in `body`. */
  strings: string[]
  /**
   * Playable/camera boundary in cells (the region the game's minimap covers):
   * after the two body strings (theme, planet) come `boundaryLeft/Bottom/
   * Right/Top` as u32 (SC2-MAP-FORMATS.md). Undefined when the body doesn't
   * parse to sane values (bounds inside the map, left<right, bottom<top).
   */
  boundary?: { left: number; bottom: number; right: number; top: number }
}

const asciiDecoder = new TextDecoder('ascii')

function extractStrings(body: Uint8Array, min = 3): string[] {
  const out: string[] = []
  let start = -1
  for (let i = 0; i <= body.length; i++) {
    const b = i < body.length ? body[i]! : 0
    const printable = b >= 0x20 && b < 0x7f
    if (printable) {
      if (start === -1) start = i
    } else {
      if (start !== -1 && i - start >= min) {
        out.push(asciiDecoder.decode(body.subarray(start, i)))
      }
      start = -1
    }
  }
  return out
}

export function readMapInfo(data: Uint8Array): MapInfoResult {
  const c = new Cursor(data)
  const magic = c.ascii(4)
  if (magic !== MAP_INFO_MAGIC_ONDISK) {
    throw new Error(
      `Invalid MapInfo: bad magic "${magic}" (expected "${MAP_INFO_MAGIC_ONDISK}", FourCC "${MAP_INFO_MAGIC}")`,
    )
  }
  const version = c.u32()
  const unknown1 = c.u32()
  const unknown2 = c.u32()
  const width = c.u32()
  const height = c.u32()
  const body = c.rest()
  const result: MapInfoResult = { version, width, height, unknown1, unknown2, body, strings: extractStrings(body) }
  const boundary = parseBoundary(body, width, height)
  if (boundary) result.boundary = boundary
  return result
}

/**
 * Body layout (SC2-MAP-FORMATS.md): `char theme[]`, `char planet[]` (both
 * null-terminated, printable), then `u32 boundaryLeft, boundaryBottom,
 * boundaryRight, boundaryTop`. The bytes BEFORE the strings are
 * version-dependent flags (18 bytes on v39/Void maps), so the parser scans for
 * the first position where two consecutive printable strings are followed by a
 * sane in-map rectangle — defensive by construction.
 */
function locateBoundary(
  body: Uint8Array,
  width: number,
  height: number,
): { offset: number; stringStart: number; secondStringStart: number;
  boundary: NonNullable<MapInfoResult['boundary']> } | undefined {
  const printable = (b: number): boolean => b >= 0x20 && b < 0x7f
  const scanLimit = Math.min(64, body.length)
  for (let start = 0; start < scanLimit; start++) {
    let offset = start
    let secondStringStart = -1
    let ok = true
    for (let s = 0; s < 2 && ok; s++) {
      if (s === 1) secondStringStart = offset
      const runStart = offset
      while (offset < body.length && printable(body[offset]!)) offset++
      // A real theme/planet name: ≥2 printable chars, null-terminated.
      if (offset - runStart < 2 || offset >= body.length || body[offset] !== 0) ok = false
      else offset++ // skip the terminator
    }
    if (!ok || offset + 16 > body.length) continue
    const view = new DataView(body.buffer, body.byteOffset + offset, 16)
    const left = view.getUint32(0, true)
    const bottom = view.getUint32(4, true)
    const right = view.getUint32(8, true)
    const top = view.getUint32(12, true)
    const sane =
      left < right && bottom < top && right <= width && top <= height && (right - left) * 4 >= width
    if (sane) return { offset, stringStart: start, secondStringStart, boundary: { left, bottom, right, top } }
  }
  return undefined
}

function parseBoundary(
  body: Uint8Array,
  width: number,
  height: number,
): MapInfoResult['boundary'] | undefined {
  return locateBoundary(body, width, height)?.boundary
}

/** Read the second string in the admitted v39 Editor context profile, never heuristic runs.
 * Native UI use is qualified by the caller; this is not a general runtime tileset lookup. */
export function mapInfoEditorTerrainContext(source: MapInfoResult): string | undefined {
  if (source.version !== 39) return undefined
  const located = locateBoundary(source.body, source.width, source.height)
  if (!located || located.stringStart !== 18) return undefined
  const fog = asciiDecoder.decode(source.body.subarray(located.stringStart, located.secondStringStart - 1))
  const context = asciiDecoder.decode(source.body.subarray(located.secondStringStart, located.offset - 1))
  return ['None', 'Dark', 'Black'].includes(fog) && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(context)
    ? context : undefined
}

/** Replace only the admitted Editor context string, preserving flags and the entire opaque tail.
 * The expected old ID guards caller intent; catalog existence is checked by the Data owner/caller. */
export function setMapInfoEditorTerrainContext(
  source: MapInfoResult, expectedContext: string, context: string,
): MapInfoResult {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{1,127}$/u.test(context))
    throw new TypeError('MapInfo Editor terrain context must be a bounded ASCII catalog ID')
  const current = mapInfoEditorTerrainContext(source)
  if (current === undefined || current !== expectedContext)
    throw new TypeError('MapInfo Editor terrain context requires the admitted v39 layout and expected old ID')
  const located = locateBoundary(source.body, source.width, source.height)!
  const replacement = new TextEncoder().encode(context)
  const body = new Uint8Array(located.secondStringStart + replacement.length + 1 + source.body.length - located.offset)
  body.set(source.body.subarray(0, located.secondStringStart))
  body.set(replacement, located.secondStringStart)
  body.set(source.body.subarray(located.offset), located.secondStringStart + replacement.length + 1)
  const result = readMapInfo(writeMapInfo({ ...source, body }))
  if (mapInfoEditorTerrainContext(result) !== context)
    throw new TypeError('MapInfo Editor terrain context failed readback')
  return result
}

/** Resize the reliable MapInfo header and, when present, rewrite its proven playable rectangle.
 * A dimension change with an existing boundary is refused unless the caller supplies the target
 * rectangle; silently preserving coordinates from a differently sized map is not semantic. */
export function resizeMapInfo(
  source: MapInfoResult,
  width: number,
  height: number,
  requestedBoundary?: MapInfoResult['boundary'] | 'full-map',
): MapInfoResult {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 0xffffffff ||
    height > 0xffffffff
  )
    throw new RangeError('MapInfo width and height must be positive uint32 values')
  const located = locateBoundary(source.body, source.width, source.height)
  if (
    requestedBoundary === undefined &&
    located !== undefined &&
    (source.width !== width || source.height !== height)
  )
    throw new TypeError('MapInfo resize requires an explicit playable boundary')
  const boundary =
    requestedBoundary === 'full-map'
      ? { left: 0, bottom: 0, right: width, top: height }
      : requestedBoundary
  let body = source.body
  if (boundary !== undefined) {
    if (
      located === undefined ||
      ![boundary.left, boundary.bottom, boundary.right, boundary.top].every(Number.isSafeInteger) ||
      boundary.left < 0 ||
      boundary.bottom < 0 ||
      boundary.left >= boundary.right ||
      boundary.bottom >= boundary.top ||
      boundary.right > width ||
      boundary.top > height
    )
      throw new RangeError('MapInfo playable boundary must be a proven in-map uint32 rectangle')
    body = source.body.slice()
    const view = new DataView(body.buffer, body.byteOffset + located.offset, 16)
    view.setUint32(0, boundary.left, true)
    view.setUint32(4, boundary.bottom, true)
    view.setUint32(8, boundary.right, true)
    view.setUint32(12, boundary.top, true)
  }
  return readMapInfo(writeMapInfo({ ...source, width, height, body }))
}

export function writeMapInfo(m: MapInfoResult): Uint8Array {
  const w = new Writer(FIXED_HEADER + m.body.length)
  w.ascii(MAP_INFO_MAGIC_ONDISK)
    .u32(m.version)
    .u32(m.unknown1)
    .u32(m.unknown2)
    .u32(m.width)
    .u32(m.height)
  return w.raw(m.body).done()
}
