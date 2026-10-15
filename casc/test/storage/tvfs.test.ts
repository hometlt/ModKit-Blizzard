import { describe, expect, it } from 'vitest'
import { isTvfsRoot, TvfsNameDb } from '../../src/casc/tvfs.js'

const encoder = new TextEncoder()

function be(value: number, size: number): number[] {
  const out = new Array<number>(size)
  for (let index = size - 1; index >= 0; index--) {
    out[index] = value & 0xff
    value >>>= 8
  }
  return out
}

function hex(value: string): number[] {
  return [...value.matchAll(/../g)].map(match => Number.parseInt(match[0], 16))
}

function flatTvfs(path: string, encodingKey: string, contentSize = 123): Uint8Array {
  const name = [...encoder.encode(path)]
  const entry = [name.length, ...name, 0xff, ...be(0, 4)]
  const pathTable = [0xff, ...be(0x80000000 | (4 + entry.length), 4), ...entry]
  const vfsTable = [1, ...be(0, 4), ...be(contentSize, 4), 0]
  const cftTable = [...hex(encodingKey), ...be(contentSize, 4), ...be(contentSize, 4)]
  const headerSize = 38
  const pathOffset = headerSize
  const vfsOffset = pathOffset + pathTable.length
  const cftOffset = vfsOffset + vfsTable.length
  return new Uint8Array([
    0x54,
    0x56,
    0x46,
    0x53,
    1,
    headerSize,
    9,
    9,
    0,
    0,
    0,
    0,
    ...be(pathOffset, 4),
    ...be(pathTable.length, 4),
    ...be(vfsOffset, 4),
    ...be(vfsTable.length, 4),
    ...be(cftOffset, 4),
    ...be(cftTable.length, 4),
    0,
    1,
    ...pathTable,
    ...vfsTable,
    ...cftTable,
  ])
}

describe('Warcraft III TVFS roots', () => {
  it('parses named files addressed directly by encoding key', async () => {
    const bytes = flatTvfs('war3.w3mod/units/human/footman.mdx', '001122334455667788')
    const root = await TvfsNameDb.parse(bytes)

    expect(isTvfsRoot(bytes)).toBe(true)
    expect(root.size).toBe(1)
    expect(root.getByPath('WAR3.W3MOD\\UNITS\\HUMAN\\FOOTMAN.MDX')).toMatchObject({
      path: 'war3.w3mod/units/human/footman.mdx',
      encodingKey: '001122334455667788',
      contentSize: 123,
      spanCount: 1,
    })
    expect(root.hasPrefix('war3.w3mod/units')).toBe(true)
    expect(root.listPaths('war3.w3mod')).toEqual(['units/human/footman.mdx'])
  })

  it('expands build-config vfs directory manifests under their container path', async () => {
    const directoryKey = '102132435465768798'
    const rootBytes = flatTvfs('war3.w3mod', directoryKey, 50)
    const nestedBytes = flatTvfs('textures/footman_diffuse.dds', 'a0a1a2a3a4a5a6a7a8', 456)
    const reads: string[] = []

    const root = await TvfsNameDb.parse(rootBytes, {
      directoryEncodingKeys: new Set([directoryKey]),
      readEncodingKey: async key => {
        reads.push(key)
        return nestedBytes
      },
    })

    expect(reads).toEqual([directoryKey])
    // The reader asks with ':' normalised to a separator.
    expect(root.getByPath('war3.w3mod\\textures\\footman_diffuse.dds')?.path).toBe('war3.w3mod:textures/footman_diffuse.dds')
    expect(root.getByPath('war3.w3mod:textures/footman_diffuse.dds')).toMatchObject({
      encodingKey: 'a0a1a2a3a4a5a6a7a8',
      contentSize: 456,
    })
  })

  it('continues the nodes after a valueless fragment from it, then returns to the folder', async () => {
    // "human0" names no file: "1/a.mdx" and "2/b.mdx" continue from it, "c.mdx" starts afresh,
    // as Warcraft III Reforged's root writes `faceanimation/human01/…` and `human02/…`.
    const fragment = (name: string) => [name.length, ...encoder.encode(name)]
    const file = (name: string) => [...fragment(name), 0xff, ...be(0, 4)]
    const entries = [...fragment('human0'), ...file('1/a.mdx'), ...fragment('human0'), ...file('2/b.mdx'), ...file('c.mdx')]
    const pathTable = [0xff, ...be(0x80000000 | (4 + entries.length), 4), ...entries]
    const template = flatTvfs('x', '001122334455667788')
    const oldPathSize = 1 + 4 + 1 + 1 + 1 + 4
    const bytes = new Uint8Array([
      ...template.slice(0, 38),
      ...pathTable,
      ...template.slice(38 + oldPathSize),
    ])
    const delta = pathTable.length - oldPathSize
    const view = new DataView(bytes.buffer)
    view.setUint32(16, pathTable.length)
    view.setUint32(20, view.getUint32(20) + delta)
    view.setUint32(28, view.getUint32(28) + delta)

    const root = await TvfsNameDb.parse(bytes)
    expect(root.listPaths('')).toEqual(['c.mdx', 'human0/1/a.mdx', 'human0/2/b.mdx'].map(path => path))
  })

  it('rejects malformed table ranges instead of reading past the manifest', async () => {
    const bytes = flatTvfs('file.mdx', '001122334455667788')
    bytes[12] = 0x7f

    await expect(TvfsNameDb.parse(bytes)).rejects.toThrow(/path table extends beyond buffer/)
  })
})
