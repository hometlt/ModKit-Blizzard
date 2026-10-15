/**
 * Version 3 MPQ archives as StarCraft II writes them (maps and mods, here the packed ones the
 * Battle.net cache holds): one entry replaced in its slot, and every structure that repeats what
 * changed agrees with it afterwards — the block table, the entry's BET record, the MD5s of its raw
 * chunks and of the BET table, and the header's MD5s of the block table, the BET table and itself.
 *
 * The cache is found where the host's probes say Program Data is, never at a path written here.
 * The MD5s are checked with node:crypto, independently of the writer's own MD5.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HASH_TYPE, mpqDecrypt, mpqHash } from '@modkit/codec-kit/crypto'
import { createNodeInstallationProbes } from '@modkit/host/node'
import { describe, expect, it } from 'vitest'
import { encodeNativePreservingMpq, readNativeMpqSnapshot } from '../src/mpq/native-preserving.js'
import { openMpqReader } from '../src/mpq/codec.js'

const LIMIT = 3

/** Packed version 3 archives in the Battle.net cache, a few. */
async function cachedArchives(): Promise<string[]> {
  if (process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1') return []
  const programData = await createNodeInstallationProbes().knownFolder('program-data')
  const cache = programData === undefined ? undefined : join(programData, 'Blizzard Entertainment', 'Battle.net', 'Cache')
  if (cache === undefined || !existsSync(cache)) return []
  const found: string[] = []
  for (const first of (await readdir(cache)).sort()) {
    for (const second of await readdir(join(cache, first)).catch(() => [])) {
      for (const name of await readdir(join(cache, first, second)).catch(() => [])) {
        if (!name.endsWith('.s2ma')) continue
        const path = join(cache, first, second, name)
        const bytes = await readFile(path)
        if (bytes.byteLength < 0xd0 || bytes.readUInt32LE(0) !== 0x1a51504d || bytes.readUInt16LE(12) !== 3) continue
        found.push(path)
        if (found.length === LIMIT) return found
      }
    }
  }
  return found
}

const archives = await cachedArchives()
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest()
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true)
const u64 = (bytes: Uint8Array, at: number) => Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(at, true))

describe.skipIf(archives.length === 0)('MPQ version 3 preserving replacement', () => {
  it.each(archives)('replaces an entry of %s and keeps BET and MD5s in step', async path => {
    const source = new Uint8Array(await readFile(path))
    const snapshot = await readNativeMpqSnapshot({ sourceBytes: source, maxEntryBytes: 67_108_864 })
    // The largest text entry, cut in half: its compressed form fits the slot it came from.
    const target = [...snapshot.entries]
      .filter(entry => /\.(xml|galaxy|txt|sc2style|sc2layout)$/iu.test(entry.path) && entry.bytes.byteLength > 64)
      .sort((left, right) => right.bytes.byteLength - left.bytes.byteLength)[0]
    expect(target).toBeDefined()
    const replacement = target!.bytes.slice(0, Math.floor(target!.bytes.byteLength / 2))
    const { bytes: output, receipt } = await encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: target!.path, bytes: replacement }],
    })
    expect(receipt.source.version).toBe(3)
    expect(receipt.tables.bet).toMatch(/^(changed-records-rewritten-in-original-slot|rebuilt-after-relocated-entries)$/u)

    // Every other entry reads as before, the changed one as written — through the product reader.
    const reader = await openMpqReader(output, { maxArchiveBytes: 1 << 30, maxEntries: 100_000, maxEntryBytes: 1 << 26 })
    expect(Buffer.from(await reader.read(target!.path)).equals(Buffer.from(replacement))).toBe(true)
    const reopened = await readNativeMpqSnapshot({ sourceBytes: output, maxEntryBytes: 67_108_864 })
    // Byte comparison by Buffer: vitest's deep equality on megabytes of entries exhausts the heap.
    const drifted = snapshot.entries
      .filter(entry => entry.path !== target!.path)
      .filter(entry => {
        const now = reopened.entries.find(item => item.path === entry.path)?.bytes
        return now === undefined || !Buffer.from(now).equals(Buffer.from(entry.bytes))
      })
      .map(entry => entry.path)
    expect(drifted).toEqual([])

    // The MD5s a version 3 archive keeps, against node:crypto.
    const rawChunk = u32(output, 0x6c)
    const chunkMd5s = (start: number, size: number) => {
      for (let at = 0, slot = 0; at < size; at += rawChunk, slot += 16) {
        expect(output.subarray(start + size + slot, start + size + slot + 16))
          .toEqual(new Uint8Array(md5(output.subarray(start + at, start + Math.min(size, at + rawChunk)))))
      }
    }
    const blockOffset = u32(output, 0x14)
    const blockBytes = u32(output, 0x1c) * 16
    expect(output.subarray(0x70, 0x80)).toEqual(new Uint8Array(md5(output.subarray(blockOffset, blockOffset + blockBytes))))
    const bet = u64(output, 0x34)
    const betSize = u64(output, 0x64)
    if (bet !== 0) {
      expect(output.subarray(0xa0, 0xb0)).toEqual(new Uint8Array(md5(output.subarray(bet, bet + betSize))))
      if (rawChunk !== 0) chunkMd5s(bet, betSize)
    }
    expect(output.subarray(0xc0, 0xd0)).toEqual(new Uint8Array(md5(output.subarray(0, 0xc0))))
    const changed = receipt.changed[0]!
    const blocks = mpqDecrypt(output.slice(blockOffset, blockOffset + blockBytes), mpqHash('(block table)', HASH_TYPE.TABLE))
    if (rawChunk !== 0) chunkMd5s(u32(blocks, changed.blockIndex * 16), changed.outputArchivedBytes)
  })
})
