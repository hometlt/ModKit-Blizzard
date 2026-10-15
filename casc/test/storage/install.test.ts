import { describe, expect, it } from 'vitest'
import { parseInstallManifest } from '../../src/casc/install.js'

interface TagSpec {
  name: string
  type: number
  /** Indices of the entries this tag applies to. */
  entries: number[]
}
interface EntrySpec {
  name: string
  contentKey: string
  size: number
}

/** Serialize a manifest in Blizzard's `IN` layout so the parser can round-trip it. */
function buildInstall(tags: TagSpec[], entries: EntrySpec[], hashSize = 16): Uint8Array {
  const bytes: number[] = []
  const asciiz = (s: string) => {
    for (const ch of s) bytes.push(ch.charCodeAt(0))
    bytes.push(0)
  }
  const u16 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff)
  const u32 = (v: number) =>
    bytes.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
  const maskLength = Math.ceil(entries.length / 8)

  bytes.push(0x49, 0x4e, 1, hashSize)
  u16(tags.length)
  u32(entries.length)

  for (const tag of tags) {
    asciiz(tag.name)
    u16(tag.type)
    const mask = new Uint8Array(maskLength)
    for (const i of tag.entries) mask[i >> 3]! |= 0x80 >> (i & 7)
    bytes.push(...mask)
  }
  for (const entry of entries) {
    asciiz(entry.name)
    for (let i = 0; i < entry.contentKey.length; i += 2) {
      bytes.push(Number.parseInt(entry.contentKey.slice(i, i + 2), 16))
    }
    u32(entry.size)
  }
  return new Uint8Array(bytes)
}

const CK = (b: number) => b.toString(16).padStart(2, '0').repeat(16)

describe('install manifest parsing', () => {
  const tags: TagSpec[] = [
    { name: 'Windows', type: 1, entries: [0, 2] },
    { name: 'enUS', type: 3, entries: [1] },
  ]
  const entries: EntrySpec[] = [
    { name: 'StarCraft II.exe', contentKey: CK(0x00), size: 5234552 },
    { name: 'Mods/Core.SC2Mod/Base.SC2Data', contentKey: CK(0x11), size: 2000 },
    { name: 'readme.txt', contentKey: CK(0x22), size: 3 },
  ]

  it('round-trips header, entries, and per-entry tags', () => {
    const manifest = parseInstallManifest(buildInstall(tags, entries))

    expect(manifest.version).toBe(1)
    expect(manifest.hashSize).toBe(16)
    expect(manifest.tags).toEqual([
      { name: 'Windows', type: 1 },
      { name: 'enUS', type: 3 },
    ])
    expect(manifest.entries).toHaveLength(3)

    expect(manifest.entries[0]).toEqual({
      name: 'StarCraft II.exe',
      contentKey: CK(0x00),
      size: 5234552,
      tags: ['Windows'],
    })
    expect(manifest.entries[1]).toEqual({
      name: 'Mods/Core.SC2Mod/Base.SC2Data',
      contentKey: CK(0x11),
      size: 2000,
      tags: ['enUS'],
    })
    expect(manifest.entries[2]!.tags).toEqual(['Windows'])
  })

  it('resolves bitmasks that span multiple bytes', () => {
    const many: EntrySpec[] = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      contentKey: CK(i),
      size: i,
    }))
    // Bit 9 lives in the second mask byte — catches MSB-first / byte-index bugs.
    const manifest = parseInstallManifest(
      buildInstall([{ name: 'T', type: 1, entries: [0, 9] }], many),
    )
    expect(manifest.entries[0]!.tags).toEqual(['T'])
    expect(manifest.entries[8]!.tags).toEqual([])
    expect(manifest.entries[9]!.tags).toEqual(['T'])
  })

  it('rejects a buffer without the IN signature', () => {
    expect(() =>
      parseInstallManifest(new Uint8Array([0x44, 0x4c, 1, 16, 0, 0, 0, 0, 0, 0])),
    ).toThrow(/IN magic/)
  })
})
