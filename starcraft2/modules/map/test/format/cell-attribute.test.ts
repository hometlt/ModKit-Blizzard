import { describe, it, expect } from 'vitest'
import { readCellAttribute, writeCellAttribute } from '../../shared/format/formats/cell-attribute.js'
import { Build } from './helpers.js'

/** 3×2 CellAttribute_Pnp: 4-byte header + 6 cell bytes + trailing. */
function sample(): Uint8Array {
  return new Build()
    .bytes(0x00, 0xc8, 0x03, 0x00) // fixed header (as on Amphion)
    .bytes(0xff, 0x00, 0x8e, 0x00, 0xff, 0x00) // cells: no-path / path / brush / path / no-path / path
    .bytes(0x42) // trailing
    .done()
}

describe('readCellAttribute', () => {
  it('reads cells with explicit dimensions and preserves the header', () => {
    const r = readCellAttribute(sample(), { sizeX: 3, sizeY: 2 })
    expect(r.sizeX).toBe(3)
    expect(r.sizeY).toBe(2)
    expect(Array.from(r.cells)).toEqual([0xff, 0x00, 0x8e, 0x00, 0xff, 0x00])
    expect(Array.from(r._raw.header)).toEqual([0x00, 0xc8, 0x03, 0x00])
    expect(Array.from(r._raw.trailing)).toEqual([0x42])
  })

  it('infers a square grid when dimensions are omitted', () => {
    // 4-byte header + 4 cell bytes (2×2), no trailing.
    const square = new Build().bytes(0, 0xc8, 3, 0).bytes(0xff, 0x00, 0x00, 0xff).done()
    const r = readCellAttribute(square)
    expect(r.sizeX).toBe(2)
    expect(r.sizeY).toBe(2)
    expect(Array.from(r.cells)).toEqual([0xff, 0x00, 0x00, 0xff])
  })

  it('throws when a non-square payload is given without dimensions', () => {
    expect(() => readCellAttribute(sample())).toThrow(/perfect square/)
  })
})

describe('writeCellAttribute', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    const encoded = writeCellAttribute(readCellAttribute(original, { sizeX: 3, sizeY: 2 }))
    expect(Array.from(encoded)).toEqual(Array.from(original))
  })

  it('rejects a cell/dimension mismatch on write', () => {
    const r = readCellAttribute(sample(), { sizeX: 3, sizeY: 2 })
    r.sizeY = 3 // now claims 9 cells but holds 6
    expect(() => writeCellAttribute(r)).toThrow(/cell count/)
  })
})
