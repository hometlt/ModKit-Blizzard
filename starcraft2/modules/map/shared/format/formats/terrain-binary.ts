/**
 * Parser and writer for the `Terrain` (non-XML) file embedded in `.SC2Map`
 * archives. This file is distinct from `t3Terrain.xml`.
 *
 * **No public spec exists for this format.** Its purpose is undocumented —
 * it may contain terrain mesh geometry, cliff model placement, or similar
 * spatial data that complements the other terrain binary files.
 *
 * This codec is a **raw pass-through**: reads verbatim, writes verbatim.
 * Byte-exact round-trips are guaranteed for maps that contain the file.
 *
 * Browser-safe: pure Uint8Array operations, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerrainBinaryResult {
  /**
   * The first 4 bytes as an ASCII string for quick identification.
   * Empty if the file is shorter than 4 bytes.
   */
  magic: string
  /**
   * Bytes 4–7 as a little-endian uint32 (likely a version field).
   * `undefined` if the file is shorter than 8 bytes.
   */
  version?: number
  /** Complete file bytes verbatim. */
  raw: Uint8Array
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse (read) the `Terrain` binary file — wraps bytes verbatim. */
export function readTerrainBinary(bytes: Uint8Array): TerrainBinaryResult {
  const magic =
    bytes.length >= 4
      ? String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
      : ''

  let version: number | undefined
  if (bytes.length >= 8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    version = view.getUint32(4, true)
  }

  return version === undefined ? { magic, raw: bytes } : { magic, version, raw: bytes }
}

/** Serialize — returns the original bytes verbatim. */
export function writeTerrainBinary(data: TerrainBinaryResult): Uint8Array {
  return data.raw
}
