import { describe, it, expect } from 'vitest'
import { readHeightMap, writeHeightMap, levelFromCell } from '../../shared/format/formats/height-map.js'
import { Build } from './helpers.js'

/** 2×1 HMAP with non-zero padding + a 3-byte trailing blob (to test preservation). */
function sample(): Uint8Array {
  return new Build()
    .ascii('HMAP')
    .u32(101) // version
    .u32(2) // sizeX
    .u32(1) // sizeY
    .pad(16, 0xab) // header padding (non-zero on purpose)
    .u16(100).u16(10).u16(1) // cell 0: heightBase, heightAdjustments, mask
    .u16(200).u16(20).u16(3) // cell 1
    .bytes(0xde, 0xad, 0xbe) // trailing
    .done()
}

describe('readHeightMap', () => {
  it('parses header and cells', () => {
    const r = readHeightMap(sample())
    expect(r.sizeX).toBe(2)
    expect(r.sizeY).toBe(1)
    expect(r.version).toBe(101)
    expect(r.cells).toHaveLength(2)
    expect(r.cells[0]).toEqual({ heightAdjustments: 10, heightBase: 100, mask: 1 })
    expect(r.cells[1]).toEqual({ heightAdjustments: 20, heightBase: 200, mask: 3 })
  })

  it('preserves padding and trailing bytes', () => {
    const r = readHeightMap(sample())
    expect(Array.from(r._raw.padding)).toEqual(new Array(16).fill(0xab))
    expect(Array.from(r._raw.trailing)).toEqual([0xde, 0xad, 0xbe])
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('NOPE').u32(101).u32(1).u32(1).pad(16).u16(0).u16(0).u16(0).done()
    expect(() => readHeightMap(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    const full = sample()
    expect(() => readHeightMap(full.subarray(0, 20))).toThrow(/Truncated/)
  })
})

describe('writeHeightMap', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    const out = writeHeightMap(readHeightMap(original))
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  it('throws when cell count disagrees with dimensions', () => {
    const r = readHeightMap(sample())
    r.cells.pop()
    expect(() => writeHeightMap(r)).toThrow(/cell count/)
  })
})

describe('levelFromCell', () => {
  it('dequantizes base and adjustments separately (engine formula)', () => {
    const cell = { heightAdjustments: 4, heightBase: 8, mask: 0 }
    // base_z = 8*2 - 1 = 15; adj = 4*2 - 1 = 7; world = 15*1 + 0 + 7 = 22
    expect(levelFromCell(cell, { quantizeScale: 2, quantizeBias: 1, standardHeight: 3 })).toBe(22)
  })

  it('applies heightMap scale/offset geometry', () => {
    const cell = { heightAdjustments: 4, heightBase: 8, mask: 0 }
    // base_z = 15; world = 15*2 + 10 + 7 = 47
    expect(
      levelFromCell(cell, { quantizeScale: 2, quantizeBias: 1, standardHeight: 3 }, { scaleZ: 2, offsetZ: 10 }),
    ).toBe(47)
  })
})
