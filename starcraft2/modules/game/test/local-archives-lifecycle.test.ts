/** Public local archive ownership: complete returned values, serialized failure/retry and close. */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { LocalArchives, Sc2FolderSource } from '../battlenet/content-sources/local-files.js'
import { ModContextManager } from '../../mod/shared/workspace/mod-context.js'

const root = await mkdtemp(join(tmpdir(), 'sc2-local-archive-lifetime-'))
afterAll(async () => {
  const suffix = relative(resolve(tmpdir()), resolve(root))
  if (suffix.startsWith('..') || !suffix.startsWith('sc2-local-archive-lifetime-')) throw new Error('cleanup escaped fixture')
  await rm(root, { recursive: true, force: true })
})

/** Actual MPQ bytes exercise the public source's archive/cache path. */
async function packed(directory: string, value: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const name = 'Mine.SC2Mod'
  await writeFile(join(directory, name), await encodeFreshMpq([{ path: 'Value.txt', bytes: new TextEncoder().encode(value) }]))
  return name
}

describe('local archive lifetime', () => {
  it('preserves returned values across retry, refresh and disposal without replacing caller authority', async () => {
    const directory = join(root, 'returned'), name = await packed(directory, 'one')
    const archive = new LocalArchives()
    try {
      const result = await archive.use(directory, name, undefined, async reader => {
        const file = reader.entries.find(entry => entry.path === 'Value.txt')!
        return { bytes: await reader.read(file.id), marker: { caller: true } }
      })
      await expect(archive.use(directory, name, undefined, () => { throw new Error('action failed') })).rejects.toThrow('action failed')
      expect(await archive.use(directory, name, undefined, () => 42)).toBe(42)
      await archive.refresh()
      expect(new TextDecoder().decode(result.bytes)).toBe('one')
      expect(result.marker).toEqual({ caller: true })
      await archive.dispose()
      expect(new TextDecoder().decode(result.bytes)).toBe('one')
      await expect(archive.use(directory, name, undefined, () => 1)).rejects.toThrow('closed')
    } finally { await archive.dispose() }
  })

  it('waits for an active action during dispose and refuses queued work', async () => {
    const directory = join(root, 'active'), name = await packed(directory, 'active')
    const archive = new LocalArchives()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = archive.use(directory, name, undefined, async () => { entered(); await gate; return 'complete' })
    await started
    const second = archive.use(directory, name, undefined, () => 'must refuse')
    const refused = expect(second).rejects.toThrow('closed')
    const closing = archive.dispose()
    release()
    expect(await first).toBe('complete')
    await refused; await closing
  })

  it('keeps folder-source bytes complete after its provider closes', async () => {
    const directory = join(root, 'folder'), name = await packed(directory, 'saved')
    const source = new Sc2FolderSource(directory, 'fixture', 'fixture')
    const bytes = await source.read(`${name}/Value.txt`, 64)
    await source.dispose()
    expect(new TextDecoder().decode(bytes)).toBe('saved')
    await expect(source.read(`${name}/Value.txt`, 64)).rejects.toThrow('closed')
  })

  it('keeps a new reader generation invalidatable while the old one closes', async () => {
    let entered!: () => void, release!: () => void
    const closing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let generation = 0, files = ['Before.txt']
    const manager = new ModContextManager(() => new Map(), () => {
      const id = ++generation
      return { id: 'host', list: async () => files.map(name => ({ name, directory: false })),
        read: async (path: string) => new TextEncoder().encode(path.endsWith('/DocumentInfo') ? '<DocInfo/>' : 'own'),
        async dispose() { if (id === 1) { entered(); await gate } },
      }
    })
    const target = join(root, 'virtual', 'Mine.SC2Mod')
    try {
      const original = await manager.resolve(target)
      expect((await original.files(original.order.at(-1)!)).list).toEqual(['Before.txt'])
      const oldClose = manager.dispose()
      await closing
      const current = await manager.resolve(target)
      expect((await current.files(current.order.at(-1)!)).list).toEqual(['Before.txt'])
      release(); await oldClose
      files = ['After.txt']
      manager.invalidate('host')
      expect((await current.files(current.order.at(-1)!)).list).toEqual(['After.txt'])
    } finally { release(); await manager.dispose() }
  })
})
