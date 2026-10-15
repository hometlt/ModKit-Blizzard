import { describe, it, expect } from 'vitest'
import { readFluffDoodad, writeFluffDoodad } from '../../shared/format/formats/fluff-doodad.js'
import { Build } from './helpers.js'

function f32(v: number): number[] {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, v, true)
  return [...b]
}

/** DLFT with 2 doodads + trailing byte. */
function sample(): Uint8Array {
  return new Build()
    .ascii('DLFT')
    .u32(103) // version
    .pad(16, 0x00) // zero[4]
    .u32(2) // amount
    .bytes(...f32(22.0)).bytes(...f32(10.5)).u8(1) // doodad 0
    .bytes(...f32(124.25)).bytes(...f32(153.75)).u8(5) // doodad 1
    .bytes(0x77) // trailing
    .done()
}

describe('readFluffDoodad', () => {
  it('parses doodad positions and types', () => {
    const r = readFluffDoodad(sample())
    expect(r.version).toBe(103)
    expect(r.doodads).toHaveLength(2)
    expect(r.doodads[0]).toEqual({ x: 22.0, y: 10.5, type: 1 })
    expect(r.doodads[1]).toEqual({ x: 124.25, y: 153.75, type: 5 })
  })

  it('handles an empty list (amount=0)', () => {
    const empty = new Build().ascii('DLFT').u32(103).pad(16).u32(0).done()
    const r = readFluffDoodad(empty)
    expect(r.doodads).toHaveLength(0)
    expect(Array.from(writeFluffDoodad(r))).toEqual(Array.from(empty))
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('TFLD').u32(103).pad(16).u32(0).done()
    expect(() => readFluffDoodad(bad)).toThrow(/bad magic/)
  })

  it('throws on truncated data', () => {
    expect(() => readFluffDoodad(sample().subarray(0, 30))).toThrow(/Truncated/)
  })
})

describe('writeFluffDoodad', () => {
  it('round-trips byte-exact', () => {
    const original = sample()
    expect(Array.from(writeFluffDoodad(readFluffDoodad(original)))).toEqual(Array.from(original))
  })
})
