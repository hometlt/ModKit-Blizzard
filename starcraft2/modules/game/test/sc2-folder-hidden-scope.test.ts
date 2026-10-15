import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Sc2FolderSource } from '../battlenet/content-sources/local-files.js'

const hidden = vi.hoisted(() => vi.fn())
vi.mock('@modkit/vfs/content-sources/node', async importOriginal => ({
  ...await importOriginal<object>(), windowsHiddenPaths: hidden,
}))

it('limits installation hidden discovery to the requested section, preserving inheritance and refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc2-hidden-scope-'))
  const source = new Sc2FolderSource(root, 'installation', 'SC2', ['Maps', 'Mods', 'Campaigns'])
  hidden.mockReset().mockImplementation(async (directory: string) =>
    new Set(directory === root ? ['Mods'] : ['secret.txt']))
  try {
    await mkdir(join(root, 'Mods', 'Nested'), { recursive: true })
    await mkdir(join(root, 'Maps'))
    await mkdir(join(root, 'Data'))
    await writeFile(join(root, 'Mods', 'Nested', 'file.txt'), 'value')
    await writeFile(join(root, 'Maps', 'secret.txt'), 'value')
    expect(await source.list('')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Mods', hidden: true }),
    ]))
    expect(hidden.mock.calls).toEqual([[root, undefined, { recursive: false }]])
    expect((await source.list('Mods/Nested'))[0]).toMatchObject({ name: 'file.txt', hidden: true })
    expect((await source.list('Maps'))[0]).toMatchObject({ name: 'secret.txt', hidden: true })
    await source.list('Mods')
    expect(hidden.mock.calls).toEqual([
      [root, undefined, { recursive: false }],
      [join(root, 'Mods', 'Nested'), undefined, { recursive: false }],
      [join(root, 'Mods'), undefined, { recursive: false }],
      [join(root, 'Maps'), undefined, { recursive: false }],
    ])
    await source.refresh()
    hidden.mockClear()
    await source.list('')
    expect(hidden.mock.calls).toEqual([[root, undefined, { recursive: false }]])
  } finally {
    await source.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps one recursive listing for an ordinary opened mod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sc2-mod-hidden-'))
  const source = new Sc2FolderSource(root, 'host', 'Mod')
  hidden.mockReset().mockResolvedValue(new Set(['Nested/secret.txt']))
  try {
    await mkdir(join(root, 'Nested'))
    await writeFile(join(root, 'Nested', 'secret.txt'), 'value')
    await source.list('')
    expect((await source.list('Nested'))[0]).toMatchObject({ name: 'secret.txt', hidden: true })
    expect(hidden.mock.calls).toEqual([[root, undefined, { recursive: true }]])
  } finally {
    await source.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
