/**
 * Storm's ADPCM on vectors derived by hand from the IMA step sizes (index 0x2C → 494, 43 → 449,
 * 50 → 876, 51 → 963) and Storm's step-index table. The installed-game corpus test proves the
 * decoder on Warcraft III's unit sounds, where it runs after Huffman (mask 0x41).
 */
import { describe, expect, it } from 'vitest'
import { IMA_STEP_TABLE } from '@modkit/codec-kit/audio'
import { expandStormAdpcm } from '../dist/mpq/storm/adpcm.js'

const samples = (bytes: Uint8Array): number[] =>
  Array.from({ length: bytes.byteLength / 2 }, (_, index) => new DataView(bytes.buffer, bytes.byteOffset).getInt16(index * 2, true))

describe('Storm ADPCM', () => {
  it('starts from the step sizes it was derived from', () => {
    expect([IMA_STEP_TABLE[43], IMA_STEP_TABLE[44], IMA_STEP_TABLE[50], IMA_STEP_TABLE[51]]).toEqual([449, 494, 876, 963])
  })

  it('decodes mono: add, subtract, repeat, raise the step', () => {
    // Zero byte, shift 0, first sample 100, then 0x00 (+494), 0x41 (−449−449), 0x80 (repeat),
    // 0x81 (step index +8, no sample), 0x00 (+876).
    const input = Uint8Array.from([0x00, 0x00, 100, 0x00, 0x00, 0x41, 0x80, 0x81, 0x00])
    expect(samples(expandStormAdpcm(input, 64, 1))).toEqual([100, 594, -304, -304, 572])
  })

  it('interleaves stereo, and 0x81 keeps the same channel for the next byte', () => {
    // Left 0, right 1000; 0x00 left +494, 0x40 right −494, 0x81 left +8, 0x00 left +963, 0x80 right repeat.
    const input = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x00, 0x40, 0x81, 0x00, 0x80])
    expect(samples(expandStormAdpcm(input, 64, 2))).toEqual([0, 1000, 494, 506, 1457, 506])
  })

  it('applies the bit shift to the base difference and clamps to 16 bits', () => {
    // Shift 2: base 494 >> 2 = 123; 0x01 adds 494 → 100 + 617.
    expect(samples(expandStormAdpcm(Uint8Array.from([0x00, 0x02, 100, 0x00, 0x01]), 64, 1))).toEqual([100, 717])
    // All six magnitude bits from 32000 overflow to 32767; with the sign bit from −32000, to −32768.
    expect(samples(expandStormAdpcm(Uint8Array.from([0x00, 0x00, 0x00, 0x7d, 0x3f]), 64, 1))).toEqual([32000, 32767])
    expect(samples(expandStormAdpcm(Uint8Array.from([0x00, 0x00, 0x00, 0x83, 0x7f]), 64, 1))).toEqual([-32000, -32768])
  })

  it('stops at the sector size and at a short stream', () => {
    const input = Uint8Array.from([0x00, 0x00, 100, 0x00, 0x00, 0x00, 0x00, 0x00])
    expect(expandStormAdpcm(input, 4, 1).byteLength).toBe(4)
    expect(expandStormAdpcm(Uint8Array.from([0x00, 0x00, 100]), 64, 1).byteLength).toBe(0)
    expect(() => expandStormAdpcm(input, -1, 1)).toThrow(TypeError)
  })
})
