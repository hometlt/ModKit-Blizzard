/**
 * Classic MPQs (Warcraft III, Diablo II) encrypt entries — war3.mpq its own (listfile) among them.
 * The archive is built by hand here, the way those archives store encrypted entries, with the
 * shared MPQ cipher from codec-kit: one key per entry from its file name, FIX_KEY mixing in its
 * offset and size, sector `i` under key + i and a sector table under key − 1.
 */
import { describe, expect, it } from 'vitest'
import { HASH_TYPE, mpqEncrypt, mpqHash } from '@modkit/codec-kit/crypto'
import { createCodec, openMpqReader } from '../src/mpq/codec.js'

const FILE_COMPRESS = 0x00000200
const FILE_ENCRYPTED = 0x00010000
const FILE_FIX_KEY = 0x00020000
const FILE_SINGLE_UNIT = 0x01000000
const FILE_EXISTS = 0x80000000
const SECTOR_BYTES = 512 // sector shift 0
const HASH_ENTRIES = 16

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

interface HandFile { readonly name: string; readonly text: string; readonly flags: number }

function storedBytes(file: HandFile, plain: Uint8Array, offset: number): Uint8Array {
  if ((file.flags & FILE_ENCRYPTED) === 0) return plain
  const base = mpqHash(file.name.split('\\').at(-1)!, HASH_TYPE.TABLE)
  const key = ((file.flags & FILE_FIX_KEY) !== 0 ? (base + offset) ^ plain.byteLength : base) >>> 0
  if ((file.flags & FILE_SINGLE_UNIT) !== 0) return mpqEncrypt(plain, key)
  const sectors: Uint8Array[] = []
  for (let start = 0, index = 0; start < plain.byteLength; start += SECTOR_BYTES, index += 1) {
    sectors.push(mpqEncrypt(plain.subarray(start, Math.min(start + SECTOR_BYTES, plain.byteLength)), (key + index) >>> 0))
  }
  if ((file.flags & FILE_COMPRESS) === 0) return concat(sectors)
  // Sectors kept at full size behind their table, which is encrypted one key below sector 0.
  const table = new Uint8Array((sectors.length + 1) * 4)
  const view = new DataView(table.buffer)
  let position = table.byteLength
  sectors.forEach((sector, index) => {
    view.setUint32(index * 4, position, true)
    position += sector.byteLength
  })
  view.setUint32(sectors.length * 4, position, true)
  return concat([mpqEncrypt(table, (key - 1) >>> 0), ...sectors])
}

/** A version-0 MPQ at offset 0: header, entries, hash table, block table. */
function handArchive(files: readonly HandFile[]): Uint8Array {
  const parts: Uint8Array[] = []
  const blocks: number[][] = []
  let offset = 32
  for (const file of files) {
    const plain = encoder.encode(file.text)
    const stored = storedBytes(file, plain, offset)
    blocks.push([offset, stored.byteLength, plain.byteLength, (FILE_EXISTS | file.flags) >>> 0])
    parts.push(stored)
    offset += stored.byteLength
  }
  const hashTable = new Uint8Array(HASH_ENTRIES * 16).fill(0xff)
  const hashView = new DataView(hashTable.buffer)
  files.forEach((file, blockIndex) => {
    let slot = mpqHash(file.name, HASH_TYPE.TABLE_OFFSET) % HASH_ENTRIES
    while (hashView.getUint32(slot * 16 + 12, true) !== 0xffffffff) slot = (slot + 1) % HASH_ENTRIES
    hashView.setUint32(slot * 16, mpqHash(file.name, HASH_TYPE.HASH_A), true)
    hashView.setUint32(slot * 16 + 4, mpqHash(file.name, HASH_TYPE.HASH_B), true)
    hashView.setUint32(slot * 16 + 8, 0, true)
    hashView.setUint32(slot * 16 + 12, blockIndex, true)
  })
  const blockTable = new Uint8Array(blocks.length * 16)
  const blockView = new DataView(blockTable.buffer)
  blocks.forEach((values, index) => values.forEach((value, field) => blockView.setUint32(index * 16 + field * 4, value, true)))
  const hashOffset = offset
  const blockOffset = hashOffset + hashTable.byteLength
  const total = blockOffset + blockTable.byteLength
  const header = new Uint8Array(32)
  const headerView = new DataView(header.buffer)
  header.set([0x4d, 0x50, 0x51, 0x1a])
  headerView.setUint32(4, 32, true)
  headerView.setUint32(8, total, true)
  headerView.setUint16(12, 0, true)
  headerView.setUint16(14, 0, true)
  headerView.setUint32(16, hashOffset, true)
  headerView.setUint32(20, blockOffset, true)
  headerView.setUint32(24, HASH_ENTRIES, true)
  headerView.setUint32(28, blocks.length, true)
  return concat([
    header,
    ...parts,
    mpqEncrypt(hashTable, mpqHash('(hash table)', HASH_TYPE.TABLE)),
    mpqEncrypt(blockTable, mpqHash('(block table)', HASH_TYPE.TABLE)),
  ])
}

describe('encrypted MPQ entries', () => {
  it('reads an encrypted listfile and every way an entry is encrypted', async () => {
    const footman = 'Footman '.repeat(150) // three stored sectors
    const big = 'UnitData '.repeat(150) // three sectors behind an encrypted table
    const files: HandFile[] = [
      {
        name: '(listfile)',
        text: 'Scripts\\common.j\r\nUnits\\Footman.txt\r\nUnits\\Big.txt\r\nUnits\\Plain.txt\r\n',
        flags: FILE_ENCRYPTED | FILE_FIX_KEY | FILE_SINGLE_UNIT,
      },
      { name: 'Scripts\\common.j', text: 'native Foo takes nothing returns nothing\n', flags: FILE_ENCRYPTED | FILE_SINGLE_UNIT },
      { name: 'Units\\Footman.txt', text: footman, flags: FILE_ENCRYPTED },
      { name: 'Units\\Big.txt', text: big, flags: FILE_ENCRYPTED | FILE_COMPRESS },
      { name: 'Units\\Plain.txt', text: 'not encrypted', flags: 0 },
    ]
    const reader = await openMpqReader(handArchive(files), { maxArchiveBytes: 1_048_576, maxEntries: 100, maxEntryBytes: 1_048_576 })
    try {
      const byPath = new Map(reader.entries.map(entry => [entry.path, entry.id]))
      expect([...byPath.keys()]).toEqual(expect.arrayContaining(['Scripts/common.j', 'Units/Footman.txt', 'Units/Big.txt', 'Units/Plain.txt']))
      const text = async (path: string) => decoder.decode(await reader.read(byPath.get(path)!))
      expect(await text('Scripts/common.j')).toBe(files[1]!.text)
      expect(await text('Units/Footman.txt')).toBe(footman)
      expect(await text('Units/Big.txt')).toBe(big)
      expect(await text('Units/Plain.txt')).toBe('not encrypted')
    } finally {
      reader.dispose()
    }
  })

  /*
   * War3Patch.mpq has no (listfile): its entries list as block/NNNN, yet each is found by the path
   * the game asks for — the hash table knows it, and the path is also what decrypts it.
   */
  it('finds an entry by path where no listfile names it', async () => {
    const script = { name: 'Scripts\\common.j', text: 'native Foo takes nothing returns nothing\n', flags: FILE_ENCRYPTED | FILE_SINGLE_UNIT }
    const bytes = handArchive([script])
    const reader = await openMpqReader(bytes, { maxArchiveBytes: 1_048_576, maxEntries: 100, maxEntryBytes: 1_048_576 })
    try {
      expect(reader.entries.map(entry => entry.path)).toEqual(['block/0000'])
      expect(decoder.decode(await reader.read('Scripts/common.j'))).toBe(script.text)
      await expect(reader.read('Scripts/missing.j')).rejects.toThrow()
    } finally {
      reader.dispose()
    }

    const uri = 'memory://War3Patch.mpq'
    const source = {
      kind: 'bytes' as const,
      ref: { id: uri, uri },
      revision: 'content-hash.sha256:no-listfile',
      size: BigInt(bytes.byteLength),
      async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) },
      async *stream() { yield bytes },
    }
    const input = {
      originKind: 'single' as const,
      bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: source.ref, revision: source.revision }],
      primaryBindingId: 'content',
      revisions: { topology: 'single' as const, revision: source.revision, bindings: [{ bindingId: 'content', revision: source.revision }], compositionFingerprint: uri },
      bindingsFor: () => [],
      async openBinding() { return { value: source, release: async () => undefined } },
    }
    const budget = { maxInputBytes: 1_048_576n, maxDepth: 64, maxNodes: 1_000, maxScalarBytes: 1_048_576, maxDiagnostics: 100 }
    const session = await (await createCodec()).open(input as never, 'full', budget as never)
    try {
      const lease = await session.dataSource('common.view/namespace-entry-source', 1)
      try {
        const namespace = lease.value as unknown as { lookup(path: string): Promise<{ id: string; path: string } | undefined> }
        expect(await namespace.lookup('Scripts/common.j')).toMatchObject({ id: 'Scripts/common.j', path: 'Scripts/common.j' })
        // The archive's own separator finds the entry too, under the path asked for.
        expect(await namespace.lookup('Scripts\\common.j')).toMatchObject({ path: 'Scripts\\common.j' })
        expect(await namespace.lookup('Scripts/missing.j')).toBeUndefined()
      } finally {
        await lease.release()
      }
      const extracted = await session.operations().invoke('extract-entry', { entryId: 'Scripts/common.j' } as never)
      expect(extracted.state === 'ok' && extracted.output.kind === 'bytes' ? decoder.decode(extracted.output.value) : extracted).toBe(script.text)
    } finally {
      await session.dispose()
    }
  })
})
