/**
 * A packed map or mod listed by a content source hides the archive's own bookkeeping the way the
 * MPQ codec does: the reader marks `(listfile)`, the source passes the mark on.
 */
import { describe, expect, it } from 'vitest'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import { archiveList } from '../battlenet/content-sources/local-files.js'

describe('content source archive listing', () => {
  it('hides the MPQ bookkeeping entries and nothing else', async () => {
    const encoder = new TextEncoder()
    const reader = await openMpqReader(encodeFreshMpq([
      { path: 'MapInfo', bytes: encoder.encode('<MapInfo/>') },
      { path: 'Base.SC2Data/GameData/UnitData.xml', bytes: encoder.encode('<Catalog/>') },
    ]), { maxArchiveBytes: 1_048_576, maxEntries: 100, maxEntryBytes: 1_048_576 })
    try {
      const listed = archiveList(reader, 'Maps/Test.SC2Map', '')
      const hidden = (name: string) => listed.find(item => item.name === name)?.hidden
      expect(hidden('(listfile)')).toBe(true)
      expect(hidden('MapInfo')).toBeUndefined()
      expect(hidden('Base.SC2Data')).toBeUndefined()
    } finally {
      reader.dispose()
    }
  })
})
