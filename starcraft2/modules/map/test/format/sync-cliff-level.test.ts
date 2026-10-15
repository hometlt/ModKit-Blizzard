import { describe, it, expect } from 'vitest'
import { readSyncCliffLevel, writeSyncCliffLevel } from '../../shared/format/formats/sync-cliff-level.js'
import { Build } from './helpers.js'

/** 3×1 CLIF with a 16-byte zero region and a trailing byte. */
function sample(): Uint8Array {
  return new Build()
    .ascii('CLIF')
    .u32(100) // version
    .u32(3) // sizeX
    .u32(1) // sizeY
    .pad(16, 0x00) // zero[4]
    .u16(8).u16(10).u16(12) // heights
    .bytes(0x42) // trailing
    .done()
}

describe('readSyncCliffLevel', () => {
  it('parses the uint16 height grid', () => {
    const r = readSyncCliffLevel(sample())
    expect(r.sizeX).toBe(3)
    expect(r.sizeY).toBe(1)
    expect(r.version).toBe(100)
    expect(r.heights).toEqual([8, 10, 12])
  })

  it('preserves padding and trailing bytes', () => {
    const r = readSyncCliffLevel(sample())
    expect(r._raw.padding).toHaveLength(16)
    expect(Array.from(r._raw.trailing)).toEqual([0x42])
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('CLFX').u32(100).u32(1).u32(1).pad(16).u16(0).done()
    expect(() => readSyncCliffLevel(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    expect(() => readSyncCliffLevel(sample().subarray(0, 18))).toThrow(/Truncated/)
  })
})

describe('writeSyncCliffLevel', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    const out = writeSyncCliffLevel(readSyncCliffLevel(original))
    expect(Array.from(out)).toEqual(Array.from(original))
  })
})
