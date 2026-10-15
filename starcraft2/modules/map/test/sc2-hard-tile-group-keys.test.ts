import { describe, expect, it } from 'vitest'
import { Writer } from '../shared/format/binary.js'
import { readHardTile, repairHardTileGroupKeys, writeHardTile } from '../shared/format/formats/hard-tile.js'

/** Synthetic complete v102 groups isolate key bookkeeping without claiming spline geometry. */
function fixture(words: number[]): Uint8Array {
  const writer = new Writer(28 + words.length * 14)
  writer.ascii('HRDT').u32(102).u32(7).u32(8).u32(9).u32(10).u32(words.length)
  for (const word of words) writer.u32(0).u8(0).u8(1).u8(0).ascii('AB').u8(0).u32(word)
  return writer.done()
}

describe('sc2-hard-tile-group-key-repair-v1', () => {
  it('reserves later keys, preserves first occurrences and patches only duplicate words', () => {
    const input = fixture([4, 4, 8, 0, 0])
    const original = input.slice()
    const result = repairHardTileGroupKeys(input)
    expect(readHardTile(result.bytes).blocks.map(block => block.tailWord)).toEqual([4, 12, 8, 0, 16])
    expect(result.changes.map(change => change.blockIndex)).toEqual([1, 4])
    const offsets = new Set(result.changes.flatMap(change => [0, 1, 2, 3].map(n => change.byteOffset + n)))
    for (let index = 0; index < input.length; index++) if (!offsets.has(index)) expect(result.bytes[index]).toBe(input[index])
    expect(input).toEqual(original)
    expect(writeHardTile(readHardTile(input))).toEqual(input)
    expect(repairHardTileGroupKeys(input).bytes).toEqual(result.bytes)
    expect(repairHardTileGroupKeys(result.bytes)).toEqual({ bytes: result.bytes, changes: [] })
  })

  it('keeps an already unique document byte-exact, including zero and opaque header words', () => {
    const input = fixture([0, 4, 0xffffffff])
    expect(repairHardTileGroupKeys(input)).toEqual({ bytes: input, changes: [] })
    expect(repairHardTileGroupKeys(fixture([])).changes).toEqual([])
  })

  it('refuses unsupported, unfinished and trailing data rather than dropping unknown bytes', () => {
    const valid = fixture([4, 4])
    const unsupported = valid.slice()
    new DataView(unsupported.buffer).setUint32(4, 103, true)
    for (const bytes of [new Uint8Array(), unsupported, valid.slice(0, -1), new Uint8Array([...valid, 1])])
      expect(() => repairHardTileGroupKeys(bytes)).toThrow('complete bounded version102')
  })
})
