import { describe, expect, it } from 'vitest'
import { Writer } from '../shared/format/binary.js'
import { readHardTile, replaceHardTileGroups, writeHardTile, writeHardTile102 } from '../shared/format/formats/hard-tile.js'
import { definition } from '../codecs/documents/hard-tile/src/codec.js'

const limits = { maxBytes: 4096, maxGroups: 8, maxRecords: 16 }

// Independently laid out native bytes exercise opaque words, signed zero and variable names.
function fixture(): Uint8Array {
  const w = new Writer(1024)
  w.ascii('HRDT').u32(102).u32(7).u32(8).u32(9).u32(10).u32(2)
  for (const [index, name] of ['KorhalTile', 'ImportedRoad'].entries()) {
    w.u32(2)
    for (let node = 0; node < 2; node++) {
      w.f32(10 + node * 4).f32(12 + index * 3).f32(2)
      w.f32(0).f32(0).f32(1)
      for (const word of [0x80000000, 0x3f800000, 0, 0x3f000000, 0, 0]) w.u32(word)
      w.f32(1.25).u32(0x3f800000).u8(node === 0 ? 1 : 0).u8(node === 1 ? 1 : 0)
    }
    w.u8(0).u8(1).u8(0).ascii(name).u8(0).u32(4 + index * 4)
  }
  return w.done()
}

describe('sc2-hard-tile-structural-groups-v1', () => {
  it('preserves explicit native fields exactly and leaves the default raw writer unchanged', () => {
    const bytes = fixture(), decoded = readHardTile(bytes)
    expect(decoded.decodedBytes).toBe(bytes.length)
    expect(writeHardTile102(decoded, limits)).toEqual(bytes)
    expect(replaceHardTileGroups(bytes, decoded.blocks, limits)).toEqual(bytes)
    decoded.blocks[0]!.subs[0]!.x = 99
    expect(writeHardTile(decoded)).toEqual(bytes)
    const edited = replaceHardTileGroups(bytes, decoded.blocks, limits)
    expect(readHardTile(edited).blocks[0]!.subs[0]!.x).toBe(99)
    expect(edited.subarray(0, 28)).toEqual(bytes.subarray(0, 28))
    expect(readHardTile(edited).blocks[1]).toEqual(readHardTile(bytes).blocks[1])
  })

  it('refuses duplicate keys, partial inputs and trailing opaque data without implicit repair', () => {
    const bytes = fixture(), groups = readHardTile(bytes).blocks
    groups[1]!.tailWord = groups[0]!.tailWord
    expect(() => replaceHardTileGroups(bytes, groups, limits)).toThrow(/unique/)
    for (const source of [bytes.slice(0, -1), new Uint8Array([...bytes, 1]), new Uint8Array(28)])
      expect(() => replaceHardTileGroups(source, [], limits)).toThrow()
    expect(bytes).toEqual(fixture())
  })

  it('bounds allocations and rejects unrepresentable native values before writing', () => {
    const bytes = fixture()
    for (const change of [
      (g: ReturnType<typeof readHardTile>['blocks']) => { g[0]!.subs[0]!.x = Infinity },
      (g: ReturnType<typeof readHardTile>['blocks']) => { g[0]!.subs[0]!.x = Number.MAX_VALUE },
      (g: ReturnType<typeof readHardTile>['blocks']) => { g[0]!.name = 'bad\0name' },
      (g: ReturnType<typeof readHardTile>['blocks']) => { g[0]!.flags = [0, 256, 0] },
    ]) {
      const groups = readHardTile(bytes).blocks
      change(groups)
      expect(() => replaceHardTileGroups(bytes, groups, limits)).toThrow()
    }
    expect(() => replaceHardTileGroups(bytes, readHardTile(bytes).blocks, { ...limits, maxRecords: 1 })).toThrow(/budget/)
    expect(() => replaceHardTileGroups(bytes, [], { ...limits, maxBytes: 27 })).toThrow(/budget/)
    expect(readHardTile(replaceHardTileGroups(bytes, [], limits)).blocks).toEqual([])
  })

  it('checks declared group counts before parsing and record counts before allocating records', () => {
    const bytes = fixture(), excessive = bytes.slice()
    new DataView(excessive.buffer).setUint32(24, 0xffffffff, true)
    expect(() => replaceHardTileGroups(excessive, [], limits)).toThrow(/declared groups/)
    expect(() => readHardTile(bytes, { maxGroups: 8, maxRecords: 1 })).toThrow(/declared records/)
  })

  it('disables no-op repair and refuses replacements that cannot reopen in the same node budget', async () => {
    const bytes = fixture()
    const inspected = await definition.inspect(bytes, { budget: { maxNodes: 7, maxScalarBytes: 4096 } })
    expect(inspected.operationStates).toContainEqual(expect.objectContaining({ id: 'blizzard/sc2-hard-tile.repair-group-keys', state: 'disabled' }))
    await expect(inspected.handlers['repair-group-keys']({})).rejects.toThrow(/No duplicate/)
    const groups = readHardTile(bytes).blocks
    groups[0]!.subs.push({ ...groups[0]!.subs[0]! })
    await expect(inspected.handlers['replace-groups']({ groups })).rejects.toThrow(/total node budget/)
  })
})
