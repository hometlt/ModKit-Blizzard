/** Transient loose readers stay with their chain; active reads, origins and common-source close survive. */
import { describe, expect, it } from 'vitest'
import { VirtualFileSystem, type BaseReader } from '../../shared/workspace/vfs.js'
import { ModContextManager } from '../../shared/workspace/mod-context.js'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'

/** A small bounded source with visible read/close ownership. */
function reader(text: string, close: () => void): BaseReader {
  return { list: async () => ['file.txt'], exists: async () => true,
    get: async () => new TextEncoder().encode(text), getText: async () => text, close }
}

describe('loose chain protocol scopes', () => {
  it('routes only within its own scope and leaves shared readers to their owner', async () => {
    let sharedCloses = 0, localCloses = 0
    const shared = new VirtualFileSystem().register('source:', reader('shared', () => { sharedCloses++ }))
    const scope = new VirtualFileSystem(shared).register('loose0:', reader('own', () => { localCloses++ }))
    const sibling = new VirtualFileSystem(shared)
    expect(await scope.getText('loose0:file.txt')).toBe('own')
    expect(await scope.getText('source:file.txt')).toBe('shared')
    expect(() => shared.get('loose0:file.txt')).toThrow('No reader registered')
    expect(() => sibling.get('loose0:file.txt')).toThrow('No reader registered')
    expect(() => scope.get('loose0:../../escape')).toThrow('escapes')
    await scope.close()
    expect(localCloses).toBe(1); expect(sharedCloses).toBe(0)
    expect(await sibling.getText('source:file.txt')).toBe('shared')
    const live = new VirtualFileSystem(shared).register('loose1:', reader('live', () => {}))
    await shared.close()
    expect(sharedCloses).toBe(1)
    expect(() => live.get('loose1:file.txt')).toThrow('closed')
  })

  it('keeps old loose results readable and origins exact through cache pressure and invalidation', async () => {
    const source = { id: 'fixture:loose', async list(path: string) {
      if (path === 'Files') return Array.from({ length: 450 }, (_, i) => ({ name: `Loose${i}.txt`, directory: false }))
      throw new Error('not a directory')
    }, async read(path: string) { return new TextEncoder().encode(path) } }
    const manager = new ModContextManager(() => new Map([[source.id, source]]), () => { throw new Error('no host reads') })
    const active = await manager.resolveInSource({ sourceId: source.id, path: 'Files/Loose0.txt' }, [])
    const primary = active.order.at(-1)!
    const before = await active.files(primary)
    for (let i = 1; i < 450; i++) {
      const other = await manager.resolveInSource({ sourceId: source.id, path: `Files/Loose${i}.txt` }, [])
      expect((await other.files(other.order.at(-1)!)).list).toEqual([`Loose${i}.txt`])
    }
    expect(await manager.sourceOf(primary)).toEqual({ id: source.id, path: 'Files/Loose0.txt' })
    expect(await active.files(primary)).toEqual(before)
    expect(new TextDecoder().decode(await active.read(primary, 'Loose0.txt'))).toBe('Files/Loose0.txt')
    manager.invalidate(source.id)
    expect(await active.files(primary)).toEqual(before)
    const reopened = await manager.resolveInSource({ sourceId: source.id, path: 'Files/Loose0.txt' }, [])
    expect(await manager.sourceOf(reopened.order.at(-1)!)).toEqual({ id: source.id, path: 'Files/Loose0.txt' })
    expect(new TextDecoder().decode(await reopened.read(reopened.order.at(-1)!, 'Loose0.txt'))).toBe('Files/Loose0.txt')
    await manager.dispose()
    await expect(active.read(primary, 'Loose0.txt')).rejects.toThrow('closed')
  })

  it('keeps loose session overlays isolated and releases the closed view', async () => {
    const source = { id: 'fixture:overlay', async list(path: string) {
      if (path === 'Files') return [{ name: 'Loose.txt', directory: false }]
      throw new Error('not a directory')
    }, async read() { return new TextEncoder().encode('saved') } }
    const loader = createSc2ModContexts({ sources: () => new Map([[source.id, source]]), hostFolder: () => { throw new Error('no host reads') } })
    const open = (sessionId: string) => loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: 'Files/Loose.txt' }, baseMods: [], sessionId })
    const alpha = await open('alpha'), beta = await open('beta')
    try {
      const layer = alpha.layers.at(-1)!.id
      await alpha.overlay([{ layerId: layer, path: 'Loose.txt', text: 'alpha' }])
      expect(new TextDecoder().decode(await alpha.read(layer, 'Loose.txt', 64))).toBe('alpha')
      expect(new TextDecoder().decode(await beta.read(layer, 'Loose.txt', 64))).toBe('saved')
      await alpha.dispose()
      const reopened = await open('alpha')
      try { expect(new TextDecoder().decode(await reopened.read(layer, 'Loose.txt', 64))).toBe('saved') } finally { await reopened.dispose() }
    } finally { await alpha.dispose(); await beta.dispose(); await loader.dispose() }
  })
})
