import { describe, expect, it } from 'vitest'

import { createCascNamespaceSource } from '../src/casc/codec.js'
import { CascPathIndex } from '../src/casc/path-index.js'

const revision = 'content-hash.sha256:path-index-test'
const sourceRef = { id: 'casc-test', uri: 'memory://casc-test' }

function file(path: string, contentKey: string, contentSize = 1, packageIndex = 0) {
  return { path, contentKey, contentSize, packageIndex }
}

describe('CascPathIndex', () => {
  it('sorts by normalized key, keeps the display spelling and drops repeated keys', () => {
    const index = CascPathIndex.fromFiles([
      file('mods/void.sc2mod/base.sc2data/game.xml', 'b'.repeat(32), 3),
      file('Mods/Core.SC2Mod/DocumentHeader', 'a'.repeat(32), 2),
      file('mods/core.sc2mod/documentheader', 'c'.repeat(32), 9), // same key, added later
    ])

    expect(index.size).toBe(2)
    expect(index.keyAt(0)).toBe('mods/core.sc2mod/documentheader')
    expect(index.pathAt(1)).toBe('mods/void.sc2mod/base.sc2data/game.xml')
    // The later row wins, as a map insert would.
    expect(index.getByPath('MODS/CORE.SC2MOD/DocumentHeader')).toMatchObject({
      contentKey: 'c'.repeat(32),
      contentSize: 9,
    })
    expect(index.getByPath('mods\\void.sc2mod\\base.sc2data\\game.xml')?.contentSize).toBe(3)
    expect(index.getByPath('mods/nothing.xml')).toBeUndefined()
  })

  it('orders thousands of prefix-sharing keys as a byte sort would, the last repeat winning', () => {
    let seed = 7
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % n
    const parts = ['mods', 'Mods', 'core.sc2mod', 'base.sc2data', 'a', 'a.b', 'a-b', 'ab', '']
    const files = Array.from({ length: 4000 }, (_, row) => {
      const path = Array.from({ length: 1 + random(5) }, () => parts[random(parts.length)]).join('/')
      return file(path, row.toString(16).padStart(32, '0'), row)
    })
    const expected = new Map<string, number>()
    for (const item of files) expected.set(item.path.toLowerCase(), item.contentSize)
    const keys = [...expected.keys()].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    )

    const index = CascPathIndex.fromFiles(files)
    expect(Array.from({ length: index.size }, (_, row) => index.keyAt(row))).toEqual(keys)
    expect(keys.map((_, row) => index.contentSizeAt(row))).toEqual(keys.map(key => expected.get(key)))
    // Front-coded blocks: every row, block edge and gap between keys lands where a scan would.
    const sorted = keys.map(key => Buffer.from(key))
    const scan = (needle: string) => {
      const bytes = Buffer.from(needle)
      const found = sorted.findIndex(key => Buffer.compare(key, bytes) >= 0)
      return found === -1 ? sorted.length : found
    }
    const needles = keys.filter((_, row) => row % 3 === 0).flatMap(key => [key, key.slice(0, -1), `${key}\u0001`])
    for (const needle of [...needles, '', 'm', 'zz', '￿']) {
      expect(index.lowerBound(needle), needle).toBe(scan(needle))
    }
    const reread = CascPathIndex.deserialize(index.serialize())
    expect(Array.from({ length: reread.size }, (_, row) => reread.keyAt(row))).toEqual(keys)
    // The byte walk sees the same keys, lets a visitor read its own row, and stops when told.
    const walked: string[] = []
    reread.forEachKey(5, reread.size, (bytes: Uint8Array, from: number, to: number, row: number) => {
      const key = Buffer.from(bytes.subarray(from, to)).toString('latin1')
      expect(reread.keyAt(row)).toBe(key)
      walked.push(key)
      return walked.length < 40
    })
    expect(walked).toEqual(keys.slice(5, 45))
  })

  it('orders long shared prefixes, short keys and UTF-8 names with the last duplicate winning', () => {
    const prefix = 'mods/core.sc2mod/' + 'shared/'.repeat(48)
    const endings = ['a', 'A', 'é', 'Ω', 'İ', 'K', '😀', 'a-b', 'a.b']
    const paths = [prefix.slice(0, -1), prefix, ...Array.from({ length: 384 }, (_, row) =>
      prefix + 'a'.repeat(row % 33) + endings[row % endings.length])]
    const files = paths.map((path, row) => file(path, row.toString(16).padStart(32, '0'), row))
    const expected = new Map<string, number>()
    for (const item of files) expected.set(item.path.toLowerCase(), item.contentSize)
    const keys = [...expected.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const index = CascPathIndex.fromFiles(files)
    expect(Array.from({ length: index.size }, (_, row) => index.keyAt(row))).toEqual(keys)
    expect(keys.map((_, row) => index.contentSizeAt(row))).toEqual(keys.map(key => expected.get(key)))
  })

  it('answers prefix questions across keys that sort between a folder and its files', () => {
    const index = CascPathIndex.fromFiles([
      file('mods/core', '0'.repeat(32)),
      file('mods/core.sc2mod', '1'.repeat(32)),
      file('mods/core/base.sc2data/game.xml', '2'.repeat(32)),
    ])

    // 'mods/core.sc2mod' sorts between 'mods/core' and 'mods/core/…' ('.' < '/'), so a prefix
    // probe has to look past it instead of stopping at the first row after the folder name.
    expect(index.hasPrefix('mods/core')).toBe(true)
    expect(index.hasPrefix('mods/core/')).toBe(true)
    expect(index.hasPrefix('mods/cor')).toBe(false)
    expect(index.hasPrefix('')).toBe(true)
    expect(index.listPaths('mods/core')).toEqual(['base.sc2data/game.xml'])
    expect(index.listPaths()).toEqual([
      'mods/core',
      'mods/core.sc2mod',
      'mods/core/base.sc2data/game.xml',
    ])
  })

  it('normalizes non-ASCII names the same way a lookup does', () => {
    const index = CascPathIndex.fromFiles([file('Mods/Ärger.sc2mod/Datei.xml', 'd'.repeat(32))])
    expect(index.keyAt(0)).toBe('mods/ärger.sc2mod/datei.xml')
    expect(index.pathAt(0)).toBe('Mods/Ärger.sc2mod/Datei.xml')
    expect(index.getByPath('MODS/ÄRGER.SC2MOD/DATEI.XML')?.contentKey).toBe('d'.repeat(32))
  })

  it('round-trips through the cache blob, display spellings included', () => {
    const index = CascPathIndex.fromFiles([
      file('Mods/Core.SC2Mod/DocumentHeader', 'a'.repeat(32), 7, 2),
      file('mods/void.sc2mod/x.xml', 'b'.repeat(32), 8, 3),
    ])
    const restored = CascPathIndex.deserialize(index.serialize())

    expect(restored.size).toBe(2)
    expect(restored.listPaths()).toEqual(index.listPaths())
    expect(restored.fileAt(0)).toEqual(index.fileAt(0))
    expect(restored.fileAt(1)).toEqual(index.fileAt(1))
    expect(() => CascPathIndex.deserialize(new Uint8Array(24))).toThrow(/magic/)
  })

  it('backs the namespace source directly — no entry object per file', async () => {
    const index = CascPathIndex.fromFiles([
      file('campaigns/liberty.sc2campaign/base.sc2data/game.xml', 'a'.repeat(32), 1),
      file('mods/core.sc2mod/base.sc2data/game.xml', 'b'.repeat(32), 2),
      file('mods/core.sc2mod/documentheader', 'c'.repeat(32), 3),
    ])
    const namespace = createCascNamespaceSource(
      { entryIndex: index, resolveFile: (path: string) => index.getByPath(path) },
      sourceRef,
      revision,
    )

    await expect(namespace.children('', { limit: 8 })).resolves.toMatchObject({
      items: [
        { path: 'Campaigns', kind: 'directory' },
        { path: 'Mods', kind: 'directory' },
      ],
    })
    const page = await namespace.list('mods/core.sc2mod/', { limit: 1 })
    expect(page.items.map(item => item.path)).toEqual(['mods/core.sc2mod/base.sc2data/game.xml'])
    expect(page.items[0]!.size).toBe(2n)
    const next = await namespace.list('mods/core.sc2mod/', { cursor: page.nextCursor, limit: 8 })
    expect(next.items.map(item => item.path)).toEqual(['mods/core.sc2mod/documentheader'])
    await expect(
      namespace.search(
        { kind: 'basename-any', basenames: ['game.xml'], caseSensitive: false },
        { limit: 8 },
      ),
    ).resolves.toMatchObject({
      items: [
        { path: 'campaigns/liberty.sc2campaign/base.sc2data/game.xml' },
        { path: 'mods/core.sc2mod/base.sc2data/game.xml' },
      ],
    })
  })
})
