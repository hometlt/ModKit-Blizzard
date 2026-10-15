import { describe, it, expect } from 'vitest'
import {
  readTextureMasks,
  writeTextureMasks,
  textureMaskWeight,
  extractLayerWeights,
} from '../../shared/format/formats/texture-masks.js'
import { Build } from './helpers.js'

/** Build a 64×64 (single-tile) MASK with `layers` blocks. Optionally patch body bytes. */
function sample(layers: number, patch: (body: Uint8Array) => void = () => {}): Uint8Array {
  const header = new Build()
    .ascii('MASK')
    .u32(102) // version
    .u32(0) // unk
    .u32(64) // sizeX (px)
    .u32(64) // sizeY (px)
    .pad(44, 0x00) // zero[11]
    .done()
  const body = new Uint8Array(layers * 2048)
  patch(body)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

describe('readTextureMasks', () => {
  it('parses header and derives tiling/layers', () => {
    const r = readTextureMasks(sample(3))
    expect(r.sizeX).toBe(64)
    expect(r.sizeY).toBe(64)
    expect(r.version).toBe(102)
    expect(r.tilesX).toBe(1)
    expect(r.tilesY).toBe(1)
    expect(r.blocksPerLayer).toBe(1)
    expect(r.layers).toBe(3)
    expect(r.body).toHaveLength(3 * 2048)
  })

  it('decodes nibble weights, high nibble first', () => {
    // body[0] = 0xAB -> pixel(0,0)=0xA, pixel(1,0)=0xB ; body[32] (row 1) = 0x5C
    const r = readTextureMasks(
      sample(1, (b) => {
        b[0] = 0xab
        b[32] = 0x5c
      }),
    )
    expect(textureMaskWeight(r, 0, 0, 0)).toBe(0xa)
    expect(textureMaskWeight(r, 0, 1, 0)).toBe(0xb)
    expect(textureMaskWeight(r, 0, 0, 1)).toBe(0x5)
    expect(textureMaskWeight(r, 0, 1, 1)).toBe(0xc)
  })

  it('extractLayerWeights returns a full row-major grid', () => {
    const r = readTextureMasks(sample(2, (b) => (b[0] = 0xf0)))
    const w = extractLayerWeights(r, 0)
    expect(w).toHaveLength(64 * 64)
    expect(w[0]).toBe(0xf)
    expect(w[1]).toBe(0x0)
  })

  it('throws on bad magic', () => {
    const bad = new Build().ascii('MSKX').u32(102).u32(0).u32(64).u32(64).pad(44).done()
    expect(() => readTextureMasks(bad)).toThrow(/bad magic/)
  })
})

describe('writeTextureMasks', () => {
  it('round-trips byte-exact', () => {
    const original = sample(4, (b) => {
      b[0] = 0x12
      b[2047] = 0x99
      b[4096] = 0x7e
    })
    expect(Array.from(writeTextureMasks(readTextureMasks(original)))).toEqual(Array.from(original))
  })
})
