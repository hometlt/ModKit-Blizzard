/**
 * Storm's adaptive Huffman on vectors derived by hand from weight table 0, whose starting tree
 * holds 0x00 (weight 10), 0xFF (2) and the two control symbols: 0x00 is `1`, 0xFF `01`, the end
 * code `001` and a new byte `000`. Bits run least significant first. The installed-game corpus
 * test proves the decoder on Warcraft III's sounds sector by sector.
 */
import { describe, expect, it } from 'vitest'
import { decompressStormHuffman, STORM_HUFFMAN_MALFORMED } from '../dist/mpq/storm/huffman.js'

describe('Storm Huffman', () => {
  it('decodes known bytes, stops at the requested size or the end code', () => {
    // Table 0, then 1 (0x00) and 01 (0xFF): bits 1,0,1 → 0x05.
    expect(decompressStormHuffman(Uint8Array.from([0x00, 0x05]), 2)).toEqual(Uint8Array.from([0x00, 0xff]))
    // 1 (0x00) and the end code 001: bits 1,0,0,1 → 0x09.
    expect(decompressStormHuffman(Uint8Array.from([0x00, 0x09]), 10)).toEqual(Uint8Array.from([0x00]))
  })

  it('grows a branch for a byte the tree lacks', () => {
    // 000 (new byte), then 0x41 least significant bit first: 0,0,0 | 1,0,0,0,0,0,1,0.
    expect(decompressStormHuffman(Uint8Array.from([0x00, 0x08, 0x02]), 1)).toEqual(Uint8Array.from([0x41]))
  })

  it('refuses a truncated stream and an unknown table', () => {
    const code = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return (error as { code?: string }).code
      }
      return undefined
    }
    expect(code(() => decompressStormHuffman(Uint8Array.from([0x00]), 4))).toBe(STORM_HUFFMAN_MALFORMED)
    expect(code(() => decompressStormHuffman(Uint8Array.from([0x0c, 0xff]), 4))).toBe(STORM_HUFFMAN_MALFORMED)
  })
})
