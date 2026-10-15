/**
 * The MPQ reader over a byte range source reads the header, the two tables and the entries asked
 * for — never the whole archive — and answers as the reader over the same bytes in memory does.
 * The installed-game corpus test opens Warcraft III's archives this way.
 */
import { describe, expect, it } from 'vitest'
import { openMpqReader } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'

const encoder = new TextEncoder()
const limits = { maxArchiveBytes: 4_194_304, maxEntries: 100, maxEntryBytes: 4_194_304 }

/** A range source over `bytes` that records every read. */
function recordingSource(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = []
  return {
    reads,
    source: {
      async size() {
        return BigInt(bytes.byteLength)
      },
      async read(offset: bigint, length: number) {
        reads.push({ offset: Number(offset), length })
        return bytes.slice(Number(offset), Number(offset) + length)
      },
    },
  }
}

function archive(): Uint8Array {
  const large = new Uint8Array(1_500_000)
  for (let index = 0; index < large.byteLength; index += 1) large[index] = (index * 31) & 0xff
  return encodeFreshMpq([
    { path: 'war3map.j', bytes: encoder.encode('function main takes nothing returns nothing\nendfunction\n') },
    { path: 'Units/Footman.mdx', bytes: large },
    { path: 'Sound/Yes.wav', bytes: encoder.encode('RIFF....WAVE') },
  ], 4_194_304)
}

describe('MPQ reader over a byte range source', () => {
  it('reads entries by range and matches the in-memory reader', async () => {
    const bytes = archive()
    const { source, reads } = recordingSource(bytes)
    const ranged = await openMpqReader(source, limits)
    const held = await openMpqReader(bytes, limits)
    try {
      expect(ranged.entries).toEqual(held.entries)
      expect(ranged.retainedBytes).toBe(0)
      const opened = reads.reduce((sum, read) => sum + read.length, 0)
      // Header and tables (and the listfile) only: the 1.5 MB entry is not read to list the archive.
      expect(opened).toBeLessThan(64 * 1024)
      for (const entry of held.entries) expect(await ranged.read(entry.id)).toEqual(await held.read(entry.id))
      expect(Math.max(...reads.map(read => read.length))).toBeLessThan(bytes.byteLength)
    } finally {
      ranged.dispose()
      held.dispose()
    }
  })

  it('finds a path by hash and opens a Warcraft III map behind its HM3W header', async () => {
    const inner = archive()
    const map = new Uint8Array(0x200 + inner.byteLength)
    map.set(encoder.encode('HM3W'))
    map.set(inner, 0x200)
    const reader = await openMpqReader(recordingSource(map).source, limits)
    try {
      expect(reader.find('Units\\Footman.mdx')).toMatchObject({ path: 'Units/Footman.mdx', size: 1_500_000 })
      expect(reader.find('Units/Missing.mdx')).toBeUndefined()
      expect(new TextDecoder().decode(await reader.read('war3map.j'))).toContain('function main')
    } finally {
      reader.dispose()
    }
  })

  it('refuses a source that returns fewer bytes than asked', async () => {
    const bytes = archive()
    const short = {
      async size() {
        return BigInt(bytes.byteLength)
      },
      async read(offset: bigint, length: number) {
        return bytes.slice(Number(offset), Number(offset) + Math.max(0, length - 1))
      },
    }
    await expect(openMpqReader(short, limits)).rejects.toThrow(/truncated/u)
  })
})
