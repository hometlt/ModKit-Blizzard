import { describe, it, expect } from 'vitest'
import { readCellFlags, writeCellFlags } from '../../shared/format/formats/cell-flags.js'
import { Build } from './helpers.js'

/** 3×1 LFCT — note dimensions come AFTER the 16-byte zero region. */
function sample(): Uint8Array {
  return new Build()
    .ascii('LFCT')
    .u32(101) // version
    .pad(16, 0x00) // zero[4]
    .u32(3) // sizeX
    .u32(1) // sizeY
    .bytes(0x00, 0x03, 0x02) // types: normal, cliff-hole, yellow
    .bytes(0x55) // trailing
    .done()
}

describe('readCellFlags', () => {
  it('parses dimensions placed after the zero region', () => {
    const r = readCellFlags(sample())
    expect(r.sizeX).toBe(3)
    expect(r.sizeY).toBe(1)
    expect(r.version).toBe(101)
    expect(Array.from(r.types)).toEqual([0x00, 0x03, 0x02])
  })

  it('preserves zero region and trailing', () => {
    const r = readCellFlags(sample())
    expect(r._raw.zero).toHaveLength(16)
    expect(Array.from(r._raw.trailing)).toEqual([0x55])
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('TCFL').u32(101).pad(16).u32(1).u32(1).bytes(0).done()
    expect(() => readCellFlags(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    expect(() => readCellFlags(sample().subarray(0, 26))).toThrow(/Truncated/)
  })
})

describe('writeCellFlags', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    expect(Array.from(writeCellFlags(readCellFlags(original)))).toEqual(Array.from(original))
  })
})
