/**
 * A Warcraft III map (.w3x/.w3m) keeps a 512-byte `HM3W` header before its MPQ; Storm finds the
 * archive at the next 512-byte boundary, and so must the reader and the codec's detection.
 */
import { describe, expect, it } from 'vitest'
import { createCodec, openMpqReader } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'

const encoder = new TextEncoder()

function warcraftMap(): Uint8Array {
  const archive = encodeFreshMpq([
    { path: 'war3map.j', bytes: encoder.encode('function main takes nothing returns nothing\nendfunction\n') },
    { path: 'war3map.w3i', bytes: Uint8Array.from([25, 0, 0, 0]) },
  ])
  const map = new Uint8Array(0x200 + archive.byteLength)
  map.set(encoder.encode('HM3W'))
  map.set(encoder.encode('Test Map'), 8)
  map.set(archive, 0x200)
  return map
}

describe('Warcraft III map header', () => {
  it('reads the archive after the HM3W header', async () => {
    const reader = await openMpqReader(warcraftMap(), { maxArchiveBytes: 1_048_576, maxEntries: 100, maxEntryBytes: 1_048_576 })
    try {
      const script = reader.entries.find(entry => entry.path === 'war3map.j')
      expect(script).toBeDefined()
      expect(new TextDecoder().decode(await reader.read(script!.id))).toContain('function main')
    } finally {
      reader.dispose()
    }
  })

  it('is detected as an MPQ container by its header', async () => {
    const bytes = warcraftMap()
    const uri = 'memory://Test.w3x'
    const source = {
      kind: 'bytes' as const,
      ref: { id: uri, uri },
      revision: 'content-hash.sha256:w3x-header',
      size: BigInt(bytes.length),
      async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) },
      async *stream() { yield bytes },
    }
    const plan = { kind: 'bytes' as const, ranges: [{ from: 'start' as const, length: 4096 }], maxBytes: 4096 }
    const codec = await createCodec()
    expect(await codec.probe({ source, plan } as never, undefined)).toMatchObject({
      evidence: [{ note: 'Warcraft III map header before its MPQ' }],
    })
  })
})
