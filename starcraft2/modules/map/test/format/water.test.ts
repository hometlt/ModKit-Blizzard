import { describe, it, expect } from 'vitest'
import { readWater, writeWater, encodeWaterTemplateId } from '../../shared/format/formats/water.js'
import { Build } from './helpers.js'

function f32(v: number): number[] {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, v, true)
  return [...b]
}

/** A 40-byte template id: "CWaterBlue" + a null + non-zero garbage after it. */
function idField(): number[] {
  const out = new Array(40).fill(0)
  const s = 'CWaterBlue'
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  out[s.length] = 0x00
  out[s.length + 1] = 0xde // garbage after terminator (must be preserved)
  out[s.length + 2] = 0xad
  return out
}

/** WATR with one zone + trailing byte. */
function sample(): Uint8Array {
  return new Build()
    .ascii('WATR')
    .u32(110) // version
    .u32(1) // amount
    .pad(20, 0x00) // zero[5]
    .bytes(...idField())
    .bytes(...f32(1.0)).bytes(...f32(2.0)).bytes(...f32(3.0)).bytes(...f32(4.0))
    .bytes(0x66) // trailing
    .done()
}

describe('readWater', () => {
  it('parses an empty file (amount=0)', () => {
    const empty = new Build().ascii('WATR').u32(110).u32(0).pad(20).done()
    const r = readWater(empty)
    expect(r.zones).toHaveLength(0)
    expect(r.version).toBe(110)
    expect(Array.from(writeWater(r))).toEqual(Array.from(empty))
  })

  it('decodes templateId up to the null and keeps the raw bytes', () => {
    const r = readWater(sample())
    expect(r.zones).toHaveLength(1)
    const z = r.zones[0]!
    expect(z.templateId).toBe('CWaterBlue')
    expect(z.templateIdBytes).toHaveLength(40)
    expect([z.startX, z.startY, z.endX, z.endY]).toEqual([1, 2, 3, 4])
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('RTAW').u32(110).u32(0).pad(20).done()
    expect(() => readWater(bad)).toThrow(/bad magic/)
  })
})

describe('writeWater', () => {
  it('round-trips byte-exact, preserving garbage after the id terminator', () => {
    const original = sample()
    expect(Array.from(writeWater(readWater(original)))).toEqual(Array.from(original))
  })
})

describe('encodeWaterTemplateId', () => {
  it('null-pads to 40 bytes', () => {
    const f = encodeWaterTemplateId('CWaterLava')
    expect(f).toHaveLength(40)
    expect(f[0]).toBe('C'.charCodeAt(0))
    expect(f[10]).toBe(0)
  })
})
