/**
 * MPQ tables the way StarCraft map protectors leave them, read the way the game reads them.
 *
 * - A table count with high bits set: Storm sizes a table as count × 16 in 32-bit arithmetic, so a
 *   1024-entry hash table declared as 0x10000400 is 1024 entries to the game (SC:R ladder maps).
 * - A hash table whose size is not a power of two: Storm finds a name at `hash & (size - 1)` and
 *   steps with the same mask (Blizzard's own Jacobs Ladder has 1000 slots).
 */
import { describe, expect, it } from 'vitest'
import { HASH_TYPE, mpqEncrypt, mpqHash } from '@modkit/codec-kit/crypto'
import { openMpqReader } from '../src/mpq/codec.js'

const FILE_SINGLE_UNIT = 0x01000000
const FILE_EXISTS = 0x80000000
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const limits = { maxArchiveBytes: 1_048_576, maxEntries: 100, maxEntryBytes: 1_048_576 }

/** Stored files behind a version-0 header, hashed into `hashSlots` slots the way Storm probes. */
function archive(files: readonly { name: string; text: string }[], hashSlots: number, declaredHashEntries = hashSlots) {
  const bodies = files.map(file => encoder.encode(file.text))
  const blocks = new Uint8Array(files.length * 16)
  const blockView = new DataView(blocks.buffer)
  let offset = 32
  bodies.forEach((body, index) => {
    blockView.setUint32(index * 16, offset, true)
    blockView.setUint32(index * 16 + 4, body.byteLength, true)
    blockView.setUint32(index * 16 + 8, body.byteLength, true)
    blockView.setUint32(index * 16 + 12, (FILE_EXISTS | FILE_SINGLE_UNIT) >>> 0, true)
    offset += body.byteLength
  })
  const hashes = new Uint8Array(hashSlots * 16).fill(0xff)
  const hashView = new DataView(hashes.buffer)
  const mask = hashSlots - 1
  files.forEach((file, blockIndex) => {
    let slot = (mpqHash(file.name, HASH_TYPE.TABLE_OFFSET) & mask) >>> 0
    while (hashView.getUint32(slot * 16 + 12, true) !== 0xffffffff) slot = ((slot + 1) & mask) >>> 0
    hashView.setUint32(slot * 16, mpqHash(file.name, HASH_TYPE.HASH_A), true)
    hashView.setUint32(slot * 16 + 4, mpqHash(file.name, HASH_TYPE.HASH_B), true)
    hashView.setUint32(slot * 16 + 8, 0, true)
    hashView.setUint32(slot * 16 + 12, blockIndex, true)
  })
  const hashAt = offset
  const blockAt = hashAt + hashes.byteLength
  const total = blockAt + blocks.byteLength
  const out = new Uint8Array(total)
  const header = new DataView(out.buffer)
  out.set([0x4d, 0x50, 0x51, 0x1a])
  header.setUint32(4, 32, true)
  header.setUint32(8, total, true)
  header.setUint16(12, 0, true)
  header.setUint16(14, 3, true)
  header.setUint32(16, hashAt, true)
  header.setUint32(20, blockAt, true)
  header.setUint32(24, declaredHashEntries >>> 0, true)
  header.setUint32(28, files.length, true)
  let at = 32
  for (const body of bodies) {
    out.set(body, at)
    at += body.byteLength
  }
  out.set(mpqEncrypt(hashes, mpqHash('(hash table)', HASH_TYPE.TABLE)), hashAt)
  out.set(mpqEncrypt(blocks, mpqHash('(block table)', HASH_TYPE.TABLE)), blockAt)
  return out
}

const files = [
  { name: 'staredit\\scenario.chk', text: 'scenario data' },
  { name: '(listfile)', text: 'staredit\\scenario.chk\r\n' },
]

describe('protected MPQ tables', () => {
  it('reads a hash table count with its high bits set as the game does', async () => {
    const reader = await openMpqReader(archive(files, 16, 0x10000010), limits)
    try {
      expect(decoder.decode(await reader.read('staredit/scenario.chk'))).toBe(files[0]!.text)
      expect(reader.entries.map(entry => entry.path)).toContain('staredit/scenario.chk')
    } finally {
      reader.dispose()
    }
  })

  it('finds a name in a hash table whose size is not a power of two', async () => {
    // A name whose masked slot differs from its modulo slot, so a modulo walk would miss it.
    const name = Array.from({ length: 64 }, (_, index) => `staredit\\probe${index}.chk`).find(
      candidate => {
        const hash = mpqHash(candidate, HASH_TYPE.TABLE_OFFSET)
        return ((hash & 11) >>> 0) !== hash % 12
      },
    )
    expect(name).toBeDefined()
    const reader = await openMpqReader(archive([{ name: name!, text: 'masked' }], 12), limits)
    try {
      expect(decoder.decode(await reader.read(name!.replaceAll('\\', '/')))).toBe('masked')
    } finally {
      reader.dispose()
    }
  })
})
