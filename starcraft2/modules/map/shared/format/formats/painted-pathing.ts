/**
 * PaintedPathingLayer — editor-authored per-cell pathing paint overlay.
 *
 * Format (verified against `TerrainLayers__ReadPaintedLayer`, layer_index 0;
 * PaintedCreepLayer shares the layout with a different lookup-table block):
 *
 * ```c
 * struct Header {                       // 16 bytes
 *   int32 boundsMinX; int32 boundsMinY; // painted region, cell coordinates
 *   int32 boundsMaxX; int32 boundsMaxY; // clamped to center ± 256 if range > 512
 * };
 * uint8 paint[512 * 512 * 2];           // fixed 512×512 grid, 2 bytes per cell
 * ```
 *
 * Each cell stores a primary and secondary paint byte at
 * `paint[2 * (x + y * 512)]`. Paint bytes map to terrain layer flags through
 * an engine lookup table; the raw values are exposed here and the
 * flag derivation stays with the pathing/runtime layer.
 *
 * Byte-exact round-trip: the original bytes are preserved verbatim; files that
 * do not match the documented size are still carried as raw bytes.
 */

import { Cursor } from '../binary.js'

export const PAINTED_GRID_SIZE = 512
const HEADER_BYTES = 16
const CELL_BYTES = PAINTED_GRID_SIZE * PAINTED_GRID_SIZE * 2
export const PAINTED_LAYER_BYTE_LENGTH = HEADER_BYTES + CELL_BYTES

export interface PaintedPathingResult {
  /** Painted region bounds in cell coordinates (undefined when unstructured). */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
  /**
   * Fixed 512×512 paint grid, 2 bytes per cell (primary, secondary), or
   * undefined when the file does not match the documented layout.
   */
  paint?: Uint8Array
  /** Complete file bytes verbatim (round-trip source of truth). */
  raw: Uint8Array
}

/** Primary (or secondary) paint byte at cell (x, y); 0 outside the grid. */
export function paintedValueAt(result: PaintedPathingResult, x: number, y: number, secondary = false): number {
  if (!result.paint) return 0
  if (x < 0 || y < 0 || x >= PAINTED_GRID_SIZE || y >= PAINTED_GRID_SIZE) return 0
  return result.paint[2 * (x + y * PAINTED_GRID_SIZE) + (secondary ? 1 : 0)] ?? 0
}

export function readPaintedPathing(bytes: Uint8Array): PaintedPathingResult {
  if (bytes.length < PAINTED_LAYER_BYTE_LENGTH) {
    return { raw: bytes } // unknown/truncated variant: raw pass-through only
  }
  const c = new Cursor(bytes)
  const minX = c.i32()
  const minY = c.i32()
  const maxX = c.i32()
  const maxY = c.i32()
  return {
    bounds: { minX, minY, maxX, maxY },
    paint: bytes.subarray(HEADER_BYTES, HEADER_BYTES + CELL_BYTES),
    raw: bytes,
  }
}

/** Serialize — returns the original bytes verbatim. */
export function writePaintedPathing(data: PaintedPathingResult): Uint8Array {
  return data.raw
}
