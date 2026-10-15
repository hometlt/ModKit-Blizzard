import { describe, expect, it } from 'vitest'
import {
  CascPatchOverlay,
  CascPatchWriter,
  createCascPatchPlan,
  encodeBlteStored,
  parseCascPatchManifest,
  readCascPatchBundle,
  writeCascPatchBundle,
  type CascKeyHasher,
} from '../../src/casc/writer.js'

const text = new TextEncoder()
const decode = new TextDecoder()

const testHasher: CascKeyHasher = {
  contentKey: (_data, path) =>
    `content-${path
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .padEnd(24, '0')
      .slice(0, 24)}`,
  encodingKey: (_data, path) =>
    `encoding-${path
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .padEnd(23, '0')
      .slice(0, 23)}`,
}

describe('experimental CASC patch writer', () => {
  it('encodes a single stored BLTE container', () => {
    const encoded = encodeBlteStored(text.encode('hello'))
    expect(decode.decode(encoded.subarray(0, 4))).toBe('BLTE')
    expect(encoded[8]).toBe(0x4e)
    expect(decode.decode(encoded.subarray(9))).toBe('hello')
  })

  it('creates deterministic patch plans with normalized paths', async () => {
    const plan = await createCascPatchPlan(
      [{ path: '\\Mods\\Core.SC2Mod\\Base.SC2Data\\Foo.txt', data: text.encode('abc') }],
      { hasher: testHasher, deletes: ['Old/File.txt'] },
    )

    expect(plan.files[0]!.path).toBe('Mods/Core.SC2Mod/Base.SC2Data/Foo.txt')
    expect(plan.files[0]!.contentKey).toMatch(/^content-/)
    expect(plan.deletes).toEqual([{ path: 'Old/File.txt' }])
  })

  it('rejects duplicate paths case-insensitively', async () => {
    await expect(
      createCascPatchPlan(
        [
          { path: 'A/B.txt', data: text.encode('one') },
          { path: 'a/b.txt', data: text.encode('two') },
        ],
        { hasher: testHasher },
      ),
    ).rejects.toThrow(/Duplicate/)
  })

  it('creates an overlay reader from a patch plan', async () => {
    const writer = new CascPatchWriter()
    writer.put('GameData/UnitData.xml', text.encode('<Unit/>'))
    writer.delete('GameData/Old.xml')
    const overlay = CascPatchOverlay.fromPlan(await writer.toPlan({ hasher: testHasher }))

    expect(await overlay.exists('GameData/UnitData.xml')).toBe(true)
    expect(await overlay.exists('GameData/Old.xml')).toBe(false)
    expect(decode.decode(await overlay.get('GameData/UnitData.xml'))).toBe('<Unit/>')
    expect(await overlay.list('GameData')).toEqual(['unitdata.xml'])
  })

  it('writes a portable patch bundle layout', async () => {
    const writes = new Map<string, Uint8Array>()
    const plan = await createCascPatchPlan([{ path: 'A.txt', data: text.encode('a') }], {
      hasher: testHasher,
    })
    const paths = await writeCascPatchBundle(
      {
        set: async (path, data) => {
          writes.set(path, data)
        },
      },
      plan,
      'PatchRoot',
    )

    expect(paths[0]).toBe('PatchRoot/casc-patch.json')
    expect(paths[1]).toContain('/data/en/co/encoding-atxt')
    expect(writes.has(paths[0]!)).toBe(true)
    expect(writes.has(paths[1]!)).toBe(true)
  })

  it('parses manifests and reads written bundles back', async () => {
    const writes = new Map<string, Uint8Array>()
    const plan = await createCascPatchPlan([{ path: 'A.txt', data: text.encode('a') }], {
      hasher: testHasher,
      deletes: ['Dead.txt'],
    })
    await writeCascPatchBundle(
      {
        set: async (path, data) => {
          writes.set(path, data)
        },
      },
      plan,
    )

    const manifest = parseCascPatchManifest(writes.get('casc-patch.json')!)
    expect(manifest.deletes).toEqual([{ path: 'Dead.txt' }])

    const readBack = await readCascPatchBundle({
      list: async () => [...writes.keys()],
      exists: async path => writes.has(path),
      get: async path => {
        const data = writes.get(path)
        if (!data) throw new Error(path)
        return data
      },
    })

    expect(readBack.files[0]?.path).toBe('A.txt')
    const overlay = CascPatchOverlay.fromPlan(readBack)
    expect(decode.decode(await overlay.get('A.txt'))).toBe('a')
  })
})
