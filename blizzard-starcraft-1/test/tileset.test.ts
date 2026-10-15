import { describe, expect, it } from 'vitest'
import { megatileOf, readTileset } from '../dist/tileset/tileset.js'

describe('StarCraft tileset lookup', () => {
  it('reads the group of a creep tile without its creep bit', () => {
    const cv5 = new Uint8Array(2 * 52)
    new DataView(cv5.buffer).setUint16(52 + 20 + 2 * 3, 7, true) // group 1, variant 3 → megatile 7
    const tileset = readTileset({
      cv5,
      vx4: new Uint8Array(8 * 16 * 4),
      wide: true,
      vr4: new Uint8Array(64),
      vf4: new Uint8Array(8 * 32),
      colors: new Uint8Array(256 * 4),
    })
    expect(megatileOf(tileset, (1 << 4) | 3)).toBe(7)
    expect(megatileOf(tileset, 0x8000 | (1 << 4) | 3)).toBe(7)
    expect(megatileOf(tileset, (2 << 4) | 3)).toBe(0) // a group the tileset lacks
  })
})
