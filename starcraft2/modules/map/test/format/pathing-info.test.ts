import { describe, it, expect } from 'vitest'
import { readPathingInfo, writePathingInfo } from '../../shared/format/formats/pathing-info.js'
import { Build } from './helpers.js'

/** 2×2 PATH with passable/ramp/impassable values + trailing byte. */
function sample(): Uint8Array {
  return new Build()
    .ascii('PATH')
    .u32(100) // version
    .u32(2) // sizeX
    .u32(2) // sizeY
    .pad(16, 0x7f) // padding
    .u16(0x00).u16(0x02).u16(0x23).u16(0x00) // blocks
    .bytes(0x99) // trailing
    .done()
}

describe('readPathingInfo', () => {
  it('parses the uint16 grid', () => {
    const r = readPathingInfo(sample())
    expect(r.sizeX).toBe(2)
    expect(r.sizeY).toBe(2)
    expect(r.version).toBe(100)
    expect(r.blocks).toEqual([0x00, 0x02, 0x23, 0x00])
  })

  it('preserves padding and trailing', () => {
    const r = readPathingInfo(sample())
    expect(Array.from(r._raw.padding)).toEqual(new Array(16).fill(0x7f))
    expect(Array.from(r._raw.trailing)).toEqual([0x99])
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('PXTH').u32(100).u32(1).u32(1).pad(16).u16(0).done()
    expect(() => readPathingInfo(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    expect(() => readPathingInfo(sample().subarray(0, 24))).toThrow(/Truncated/)
  })
})

describe('writePathingInfo', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    expect(Array.from(writePathingInfo(readPathingInfo(original)))).toEqual(Array.from(original))
  })
})
