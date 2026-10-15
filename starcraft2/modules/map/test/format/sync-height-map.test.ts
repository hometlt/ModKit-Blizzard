import { describe, it, expect } from 'vitest'
import { readSyncHeightMap, writeSyncHeightMap } from '../../shared/format/formats/sync-height-map.js'
import { Build } from './helpers.js'

/** 2×1 SMAP with a signed-negative height cell and preserved 48-byte header extra. */
function sample(): Uint8Array {
  return new Build()
    .ascii('SMAP')
    .u32(102) // version
    .u32(2) // sizeX
    .u32(1) // sizeY
    .pad(48, 0xcd) // headerExtra (padding[12]+unknown[3]+padding2[24])
    .i16(-256).u16(0) // cell 0: height -256 -> level -1.0
    .i16(512).u16(2) // cell 1: height 512 -> level 2.0
    .done()
}

describe('readSyncHeightMap', () => {
  it('parses signed heights and masks', () => {
    const r = readSyncHeightMap(sample())
    expect(r.sizeX).toBe(2)
    expect(r.sizeY).toBe(1)
    expect(r.version).toBe(102)
    expect(r.cells[0]).toEqual({ height: -256, mask: 0 })
    expect(r.cells[1]).toEqual({ height: 512, mask: 2 })
    // /256 gives the fractional level offset
    expect(r.cells[0]!.height / 256).toBe(-1)
  })

  it('preserves the 48-byte header extra', () => {
    const r = readSyncHeightMap(sample())
    expect(r._raw.headerExtra).toHaveLength(48)
    expect(Array.from(r._raw.headerExtra)).toEqual(new Array(48).fill(0xcd))
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('XMAP').u32(102).u32(1).u32(1).pad(48).i16(0).u16(0).done()
    expect(() => readSyncHeightMap(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    expect(() => readSyncHeightMap(sample().subarray(0, 30))).toThrow(/Truncated/)
  })
})

describe('writeSyncHeightMap', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    const out = writeSyncHeightMap(readSyncHeightMap(original))
    expect(Array.from(out)).toEqual(Array.from(original))
  })
})
