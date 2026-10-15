import { describe, it, expect } from 'vitest'
import { encodeGray16, decodeGray16, encodeRGB8, decodePng } from '../../shared/image/png.js'

describe('PNG gray16 codec', () => {
  it('round-trips 16-bit samples (incl. full-range values)', () => {
    const w = 4
    const h = 3
    const samples = Uint16Array.from({ length: w * h }, (_, i) => (i * 5000) % 65536)
    samples[0] = 0
    samples[1] = 65535
    const png = encodeGray16(w, h, samples)
    // valid PNG signature
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    const d = decodeGray16(png)
    expect(d.width).toBe(w)
    expect(d.height).toBe(h)
    expect(Array.from(d.samples)).toEqual(Array.from(samples))
  })

  it('encodes big-endian 16-bit samples', () => {
    const png = encodeGray16(1, 1, Uint16Array.of(0x1234))
    const d = decodePng(png)
    expect(d.bitDepth).toBe(16)
    expect(d.colorType).toBe(0)
    expect(d.pixels[0]).toBe(0x12) // high byte first
    expect(d.pixels[1]).toBe(0x34)
  })

  it('rejects mismatched sample counts', () => {
    expect(() => encodeGray16(2, 2, Uint16Array.of(1, 2))).toThrow(/expected 4 samples/)
  })
})

describe('PNG rgb8 codec', () => {
  it('produces a decodable RGB image of the right size', () => {
    const w = 2
    const h = 2
    const rgb = Uint8Array.from({ length: w * h * 3 }, (_, i) => i * 10)
    const png = encodeRGB8(w, h, rgb)
    const d = decodePng(png)
    expect(d.width).toBe(w)
    expect(d.height).toBe(h)
    expect(d.colorType).toBe(2)
    expect(Array.from(d.pixels)).toEqual(Array.from(rgb))
  })
})

describe('decodePng errors', () => {
  it('throws on a non-PNG buffer', () => {
    expect(() => decodePng(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(/not a PNG/)
  })
})
