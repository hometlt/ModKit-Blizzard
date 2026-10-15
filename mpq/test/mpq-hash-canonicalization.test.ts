import { describe, expect, it } from 'vitest'
import { HASH_TYPE, mpqHash } from '@modkit/codec-kit/crypto'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'
import { readNativeMpqSnapshot } from '../src/mpq/native-preserving.js'

const encoder = new TextEncoder()

describe('canonical MPQ hashing', () => {
  it('pins ASCII case, separator and non-ASCII byte behavior', () => {
    expect(mpqHash('replay.details', HASH_TYPE.HASH_A)).toBe(0xd383c29c)
    expect(mpqHash('REPLAY.DETAILS', HASH_TYPE.HASH_A)).toBe(0xd383c29c)
    expect(mpqHash('Base.SC2Data/GameData', HASH_TYPE.HASH_A)).toBe(0xd621e5a7)
    expect(mpqHash('Base.SC2Data\\GameData', HASH_TYPE.HASH_A)).toBe(0xd39a597a)
    expect(mpqHash('Café/Ünit', HASH_TYPE.HASH_A)).toBe(0x3974cb8c)
  })

  it('normalizes namespace separators at the MPQ writer and reader boundary', async () => {
    const bytes = encodeFreshMpq([
      { path: 'Base.SC2Data/GameData/UnitData.xml', bytes: encoder.encode('<Catalog/>') },
    ])
    const snapshot = await readNativeMpqSnapshot({
      sourceBytes: bytes,
      maxArchiveBytes: 1_048_576,
      maxBlocks: 32,
      maxEntries: 32,
      maxEntryBytes: 1_048_576,
      maxTotalBytes: 1_048_576,
    })

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        path: 'Base.SC2Data/GameData/UnitData.xml',
        bytes: encoder.encode('<Catalog/>'),
      }),
    ])
  })
})
