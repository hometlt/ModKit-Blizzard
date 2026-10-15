/**
 * CellAttribute_Pnp / CellAttribute_Pgr — per-cell attribute masks (no ASCII magic).
 *
 * ```c
 * struct { uint8 header[4]; uint8 cells[sizeX * sizeY]; };   // row-major, y=0 = south
 * ```
 *
 * Unlike the `t3*` grids these files carry **no self-describing dimensions** — the
 * 4-byte header (`00 c8 03 00` on Amphion) is fixed/version-like, and the cell grid
 * that follows must be sized from the map (`MapInfo.width/height`). When dimensions
 * are not supplied the reader infers a **square** grid from the payload length.
 *
 * Semantics (verified on Amphion 2026-07-04, `CellAttribute_Pnp`): a per-cell
 * *no-pathing* mask — `0xFF` marks unwalkable (the entire off-map void, borders,
 * and painted no-path patches), `0x00` marks walkable (plateaus **and** ramps),
 * intermediate values are anti-aliased brush strengths. This is the "painted
 * pathing layer" track T3 needs; the `_Pgr` twin (ground-pathing paint) follows the
 * same layout. Real runtime walkability derivation still belongs to track T3 — this
 * codec just reads/writes the bytes losslessly.
 *
 * Byte-exact round-trip: the 4-byte header and any trailing bytes are preserved.
 */

import { Cursor, Writer } from '../binary.js'

const HEADER_BYTES = 4

export interface CellAttributeResult {
  sizeX: number
  sizeY: number
  /** One byte per cell, row-major (`y * sizeX + x`); `0xFF` = no-path, `0x00` = path. */
  cells: Uint8Array
  _raw: { header: Uint8Array; trailing: Uint8Array }
}

export interface CellAttributeOptions {
  /** Grid width in cells (e.g. `MapInfo.width`). Defaults to a square inference. */
  sizeX?: number
  /** Grid height in cells (e.g. `MapInfo.height`). Defaults to a square inference. */
  sizeY?: number
}

export function readCellAttribute(data: Uint8Array, options: CellAttributeOptions = {}): CellAttributeResult {
  const c = new Cursor(data)
  const header = c.bytesOf(HEADER_BYTES)
  const payload = data.length - HEADER_BYTES

  let sizeX = options.sizeX ?? 0
  let sizeY = options.sizeY ?? 0
  if (sizeX <= 0 || sizeY <= 0) {
    const side = Math.sqrt(payload)
    if (!Number.isInteger(side)) {
      throw new Error(
        `CellAttribute: ${payload} cell bytes are not a perfect square; pass { sizeX, sizeY } from MapInfo`,
      )
    }
    sizeX = side
    sizeY = side
  }

  const count = sizeX * sizeY
  if (count > payload) {
    throw new Error(`CellAttribute: sizeX*sizeY (${count}) exceeds ${payload} available cell bytes`)
  }
  const cells = c.bytesOf(count)
  return { sizeX, sizeY, cells, _raw: { header, trailing: c.rest() } }
}

export function writeCellAttribute(map: CellAttributeResult): Uint8Array {
  const expected = map.sizeX * map.sizeY
  if (map.cells.length !== expected) {
    throw new Error(`CellAttribute cell count ${map.cells.length} ≠ sizeX*sizeY (${expected})`)
  }
  const w = new Writer(HEADER_BYTES + expected + map._raw.trailing.length)
  return w.raw(map._raw.header).raw(map.cells).raw(map._raw.trailing).done()
}
