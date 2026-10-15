/** SC2 loader retention pressure and generation races; delivered results remain complete. */
import { describe, expect, it } from 'vitest'
import { LoaderMetadataCache } from '../../shared/workspace/loader-metadata-cache.js'
import { ContentSourceReader, createSourceListingCache } from '../../shared/workspace/content-source-provider.js'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import { VirtualFileSystem } from '../../shared/workspace/vfs.js'
import { ModContextManager } from '../../shared/workspace/mod-context.js'

describe('recoverable loader metadata', () => {
  it('releases retention-owned state once while pending evicted results stay complete', async () => {
    const events: string[] = []
    const cache = new LoaderMetadataCache<number[]>(1, 1000, value => value.length)
    let finish!: (value: number[]) => void
    const pending = cache.get('old', () => new Promise(resolve => { finish = resolve }), () => { events.push('old') })
    const kept = cache.get('new', async () => [2], () => { events.push('new') })
    expect(events).toEqual(['old'])
    finish([1, 3])
    expect(await pending).toEqual([1, 3])
    expect(await kept).toEqual([2])
    cache.clear()
    cache.clear()
    expect(events).toEqual(['old', 'new'])
  })

  it('cannot forget a replacement with an old promise identity', async () => {
    const events: string[] = []
    const cache = new LoaderMetadataCache<number>(2, 1000, () => 1)
    const first = cache.get('same', async () => 1, () => { events.push('first') })
    expect(await first).toBe(1)
    cache.deletePrefix('same')
    const replacement = cache.get('same', async () => 2, () => { events.push('replacement') })
    expect(events).toEqual(['first'])
    cache.delete('same', first)
    expect(cache.get('same', async () => 9)).toBe(replacement)
    expect(await replacement).toBe(2)
    expect(events).toEqual(['first'])
    cache.delete('same', replacement)
    expect(events).toEqual(['first', 'replacement'])
  })

  it('forgets one shared namespace across pending failure, replacement and reader close', async () => {
    const cache = createSourceListingCache()
    let firstCalls = 0, siblingCalls = 0
    let reject!: (error: Error) => void
    const first = new ContentSourceReader({ id: 'first', async read() { return new Uint8Array() }, list() {
      firstCalls++
      return firstCalls === 1 ? new Promise((_resolve, fail) => { reject = fail }) : Promise.resolve([{ name: 'Replacement.txt', directory: false }])
    } }, cache, 'first:')
    const sibling = new ContentSourceReader({ id: 'sibling', async read() { return new Uint8Array() }, async list() { siblingCalls++; return [{ name: 'Sibling.txt', directory: false }] } }, cache, 'sibling:')
    try {
      const pending = first.entries('same'), kept = sibling.entries('same')
      expect(await kept).toEqual([{ name: 'Sibling.txt', directory: false }])
      first.forget()
      const replacement = first.entries('same')
      reject(new Error('old generation failed'))
      await expect(pending).rejects.toThrow('old generation failed')
      expect(await replacement).toEqual([{ name: 'Replacement.txt', directory: false }])
      expect(first.entries('same')).toBe(replacement)
      expect(sibling.entries('same')).toBe(kept)
      await first.close()
      expect(sibling.entries('same')).toBe(kept)
      expect(firstCalls).toBe(2); expect(siblingCalls).toBe(1)
    } finally { await first.close(); await sibling.close() }
  })

  it('shares host-folder retention without invalidating an unchanged add-on namespace', async () => {
    const calls = new Map<string, number>()
    const addon = { id: 'wizard', async list() { calls.set('wizard', (calls.get('wizard') ?? 0) + 1); return [{ name: 'Wizard.txt', directory: false }] }, async read() { return new Uint8Array([77]) } }
    const manager = new ModContextManager(() => new Map(), directory => {
      const id = directory.replace(/\\/gu, '/').split('/').at(-1)!
      return { id, async list(path) {
        calls.set(id, (calls.get(id) ?? 0) + 1)
        if (path !== 'Pressure.SC2Mod') throw new Error('outside synthetic host source')
        return Array.from({ length: 1000 }, (_, j) => ({ name: `${id}_${j}_${'x'.repeat(210)}.txt`, directory: false }))
      }, async read(path) { return path.endsWith('/DocumentInfo') ? new TextEncoder().encode('<DocInfo/>') : new Uint8Array([65]) } }
    }, () => new Map([[addon.id, addon]]))
    try {
      const active = await manager.resolve('C:/MKTEMP/virtual-budget/Folder0/Pressure.SC2Mod')
      const layer = active.order.at(-1)!, wizard = active.order[0]!
      expect((await active.files(wizard)).list).toEqual(['Wizard.txt'])
      const first = await active.files(layer)
      for (let i = 1; i < 48; i++) {
        const mod = await manager.resolve(`C:/MKTEMP/virtual-budget/Folder${i}/Pressure.SC2Mod`)
        expect((await mod.files(mod.order.at(-1)!)).list).toContain(`Folder${i}_999_${'x'.repeat(210)}.txt`)
      }
      expect(await active.files(layer)).toEqual(first)
      expect(calls.get('Folder0')).toBe(2)
      await active.files(wizard)
      const addonLoads = calls.get('wizard')
      manager.invalidate('host')
      expect((await active.files(wizard)).list).toEqual(['Wizard.txt'])
      expect(calls.get('wizard')).toBe(addonLoads)
      expect(await active.read(wizard, 'wizard.txt')).toEqual(new Uint8Array([77]))
    } finally { await manager.dispose() }
  })

  it('shares the budget across add-ons and releases the captured generation when a source close fails', async () => {
    const calls = new Map<string, number>()
    let closed = 0
    const source = { id: 'primary', async list() { return [] }, async read() { return new TextEncoder().encode('<DocInfo/>') } }
    const addons = new Map(Array.from({ length: 48 }, (_, i) => {
      const id = `wizard:${i}`
      return [id, { id, async list() {
        calls.set(id, (calls.get(id) ?? 0) + 1)
        return Array.from({ length: 1000 }, (_, j) => ({ name: `${i}_${j}_${'x'.repeat(210)}.txt`, directory: false }))
      }, async read() { return new Uint8Array([i]) }, async dispose() { closed++; if (i === 0) throw new Error('close failed') } }] as const
    }))
    const manager = new ModContextManager(() => new Map([[source.id, source]]), () => { throw new Error('no host reads') }, () => addons)
    try {
      const mod = await manager.resolveInSource({ sourceId: source.id, path: 'Mods/Pressure.SC2Mod' }, [])
      const first = await mod.files(mod.order[0]!)
      for (const layer of mod.order.slice(1)) await mod.files(layer)
      expect(await mod.files(mod.order[0]!)).toEqual(first)
      expect(calls.get('wizard:0')).toBe(2)
    } finally { await manager.dispose() }
    expect(closed).toBe(48)
  })

  it('bounds directory retention across distinct stable sources while active results stay complete', async () => {
    const calls = new Map<string, number>()
    const sources = new Map(Array.from({ length: 48 }, (_, i) => {
      const id = `aggregate:${i}`
      return [id, { id, async list(path: string) {
        const key = `${id}/${path}`; calls.set(key, (calls.get(key) ?? 0) + 1)
        if (path === 'Mods') return [{ name: 'Pressure.SC2Mod', directory: true }]
        if (path === 'Mods/Pressure.SC2Mod') return Array.from({ length: 1000 }, (_, j) => ({ name: `${i}_${j}_${'x'.repeat(210)}.txt`, directory: false }))
        throw new Error('outside synthetic source')
      }, async read(path: string) { return path.endsWith('/DocumentInfo') ? new TextEncoder().encode('<DocInfo/>') : new Uint8Array([i]) } }] as const
    }))
    const loader = createSc2ModContexts({ sources: () => sources, hostFolder: () => { throw new Error('no host reads') } })
    const open = (i: number) => loader.open({ schemaVersion: 1, target: { sourceId: `aggregate:${i}`, path: 'Mods/Pressure.SC2Mod' }, baseMods: [], sessionId: `aggregate-${i}` })
    const active = await open(0)
    try {
      const layer = active.layers.at(-1)!.id, before = await active.files(layer, { limit: 1000 })
      expect(before.items).toContain(`0_999_${'x'.repeat(210)}.txt`)
      for (let i = 1; i < 48; i++) {
        const context = await open(i)
        try { expect((await context.files(context.layers.at(-1)!.id, { limit: 1000 })).items).toContain(`${i}_999_${'x'.repeat(210)}.txt`) }
        finally { await context.dispose() }
      }
      expect(await active.files(layer, { limit: 1000 })).toEqual(before)
      expect(calls.get('aggregate:0/Mods/Pressure.SC2Mod')).toBe(2)
      expect(await active.read(layer, before.items[0]!, 1)).toEqual(new Uint8Array([0]))
    } finally { await active.dispose(); await loader.dispose() }
  })

  it('keeps the listed-file gate and source errors for point and fallback readers', async () => {
    const requests: string[] = []
    const reader = new ContentSourceReader({ id: 'point', async list(path) {
      if (path === 'Layer') return [{ name: 'Native', directory: true }]
      if (path === 'Layer/Native') return [{ name: 'Read.xml', directory: false }, { name: 'Folder', directory: true }]
      throw new Error('listing failed')
    }, async read(path, maximum) { requests.push(path); expect(maximum).toBe(64 * 1024 * 1024); throw new Error('read failed') } })
    const vfs = new VirtualFileSystem().register('point:', reader).register('fallback:', {
      async list() { return ['Native/Read.xml'] },
      async get(path) { requests.push(path); return new Uint8Array([66]) },
      async getText() { return '' }, async exists() { return true },
    })
    try {
      await expect(vfs.readListed('point:Layer', '/native\\read.xml')).rejects.toThrow('read failed')
      expect(await vfs.readListed('point:Layer', '../Native/Read.xml')).toBeUndefined()
      expect(await vfs.readListed('point:Layer', 'Native/Folder')).toBeUndefined()
      expect(await vfs.readListed('point:Layer', 'Native/Missing.xml')).toBeUndefined()
      await expect(vfs.readListed('point:Missing', 'Read.xml')).rejects.toThrow('listing failed')
      expect(await vfs.readListed('fallback:Layer', '/native\\read.xml')).toEqual(new Uint8Array([66]))
      expect(await vfs.readListed('fallback:Layer', '../Native/Read.xml')).toBeUndefined()
      expect(requests).toEqual(['Layer/Native/Read.xml', 'Layer/Native/Read.xml'])
    } finally { await vfs.close() }
    await expect(vfs.readListed('point:Layer', 'Native/Read.xml')).rejects.toThrow('closed')
  })

  it('reads listed files without rescanning an oversized layer and preserves canonical paths', async () => {
    const calls = new Map<string, number>()
    const root = 'Mods/Bulk.SC2Mod'
    const name = (i: number) => `File${i}_${'x'.repeat(120)}.xml`
    const source = { id: 'fixture:large-layer', async list(path: string) {
      calls.set(path, (calls.get(path) ?? 0) + 1)
      if (path === 'Mods') return [{ name: 'Bulk.SC2Mod', directory: true }]
      if (path === root) return Array.from({ length: 400 }, (_, i) => ({ name: `Directory${i}`, directory: true }))
      if (new RegExp(`^${root.replace('.', '\\.')}\\/Directory\\d+$`, 'u').test(path))
        return Array.from({ length: 100 }, (_, i) => ({ name: name(i), directory: false }))
      throw new Error('no synthetic directory')
    }, async read(path: string) {
      if (path === `${root}/DocumentInfo`) return new TextEncoder().encode('<DocInfo/>')
      if (path === `${root}/Directory0/${name(0)}`) return new Uint8Array([65])
      if (path === `${root}/Directory0/${name(1)}`) throw new Error('source read failed')
      throw new Error(`unexpected noncanonical source read: ${path}`)
    } }
    const loader = createSc2ModContexts({ sources: () => new Map([[source.id, source]]), hostFolder: () => { throw new Error('no host source') } })
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: root }, sessionId: 'large-read' })
    try {
      const layer = context.layers.at(-1)!.id
      expect((await context.files(layer, { limit: 1000 })).items).toHaveLength(1000)
      for (let i = 0; i < 3; i++) expect(await context.read(layer, `directory0/${name(0).toLowerCase()}`, 1)).toEqual(new Uint8Array([65]))
      expect(calls.get(`${root}/Directory399`)).toBe(1)
      await expect(context.read(layer, `Directory0/${name(1)}`, 1)).rejects.toThrow('not a file')
      await expect(context.read(layer, '../escape.xml', 1)).rejects.toThrow()
      await expect(context.read(layer, 'Directory0/Missing.xml', 1)).rejects.toThrow()
      loader.invalidate(source.id)
      expect(await context.read(layer, `directory0/${name(0).toLowerCase()}`, 1)).toEqual(new Uint8Array([65]))
      expect(calls.get(`${root}/Directory0`)).toBeGreaterThan(1)
    } finally { await context.dispose(); await loader.dispose() }
  }, 30000)

  it('bounds count and weight, refreshes LRU, and does not retain oversized values', async () => {
    let loads = 0
    const cache = new LoaderMetadataCache<string>(2, 12, value => value.length)
    const read = (key: string, value = '1234') => cache.get(key, async () => { loads++; return value })
    expect(await read('a')).toBe('1234')
    await read('b'); await read('a'); await read('c')
    expect(loads).toBe(3)
    await read('a'); expect(loads).toBe(3)
    await read('huge', 'x'.repeat(20)); await read('a')
    expect(loads).toBe(4)
    await read('huge', 'x'.repeat(20)); expect(loads).toBe(5)
    await read('b'); expect(loads).toBe(6)
    const weighted = new LoaderMetadataCache<string>(20, 12, value => value.length)
    await weighted.get('a', async () => '123456')
    await weighted.get('b', async () => '123456')
    let reload = false
    await weighted.get('a', async () => { reload = true; return '123456' })
    expect(reload).toBe(true)
  })

  it('keeps pending callers intact across pressure and clear; late failures preserve replacements', async () => {
    const cache = new LoaderMetadataCache<string>(1, 1024, value => value.length)
    let reject!: (error: Error) => void
    const old = cache.get('a', () => new Promise((_resolve, fail) => { reject = fail }))
    expect(cache.get('a', async () => 'wrong')).toBe(old)
    cache.clear()
    const replacement = cache.get('a', async () => 'replacement')
    reject(new Error('old read failed'))
    await expect(old).rejects.toThrow('old read failed')
    expect(await replacement).toBe('replacement')
    expect(cache.get('a', async () => 'wrong')).toBe(replacement)
    let settle!: (value: string) => void
    const pending = cache.get('p', () => new Promise(resolve => { settle = resolve }))
    await cache.get('q', async () => 'other')
    settle('complete original')
    expect(await pending).toBe('complete original')
    expect(await cache.get('q', async () => 'wrong')).toBe('other')
  })

  it('evicts source directory metadata by payload and retries failed/forgotten directories', async () => {
    const reads = new Map<string, number>()
    let fail = true
    const reader = new ContentSourceReader({ id: 'fixture', async read() { return new Uint8Array() },
      async list(path) {
        reads.set(path, (reads.get(path) ?? 0) + 1)
        if (path === 'retry' && fail) { fail = false; throw new Error('retry source') }
        return Array.from({ length: 1000 }, (_, i) => ({ name: `${path}-${i}-${'x'.repeat(140)}`, directory: false }))
      } })
    const first = await reader.entries('first')
    for (let i = 0; i < 40; i++) await reader.entries(`pressure${i}`)
    expect(await reader.entries('first')).toEqual(first)
    expect(reads.get('first')).toBe(2)
    await expect(reader.entries('retry')).rejects.toThrow('retry source')
    expect(await reader.entries('retry')).toHaveLength(1000)
    reader.forget(); await reader.entries('retry')
    expect(reads.get('retry')).toBe(3)
    await reader.close()
  })

  it('reconstructs complete evicted chain listings while a live context remains usable', async () => {
    const counts = new Map<string, number>()
    const source = { id: 'fixture:pressure', async list(path: string) {
      counts.set(path, (counts.get(path) ?? 0) + 1)
      if (path === 'Mods') return Array.from({ length: 160 }, (_, i) => ({ name: `Pressure${i}.SC2Mod`, directory: true }))
      if (/^Mods\/Pressure\d+\.SC2Mod$/u.test(path)) return Array.from({ length: 1000 }, (_, i) => ({ name: `Input${i}_${'x'.repeat(140)}.txt`, directory: false }))
      throw new Error('no such synthetic directory')
    }, async read(path: string) { if (path.endsWith('/DocumentInfo')) return new TextEncoder().encode('<DocInfo/>'); return new Uint8Array([65]) } }
    const loader = createSc2ModContexts({ sources: () => new Map([[source.id, source]]), hostFolder: () => { throw new Error('no host source') } })
    const open = (i: number) => loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: `Mods/Pressure${i}.SC2Mod` }, sessionId: `scope${i}` })
    const active = await open(0)
    try {
      const layer = active.layers.at(-1)!.id
      const before = await active.files(layer, { limit: 1000 })
      for (let i = 1; i < 160; i++) { const context = await open(i); try { expect((await context.files(context.layers.at(-1)!.id, { limit: 1000 })).items).toHaveLength(1000) } finally { await context.dispose() } }
      expect(await active.files(layer, { limit: 1000 })).toEqual(before)
      expect(counts.get('Mods/Pressure0.SC2Mod')).toBe(2)
      expect(await active.read(layer, before.items[0]!, 1)).toEqual(new Uint8Array([65]))
      const reopened = await open(0)
      try { expect(await reopened.files(reopened.layers.at(-1)!.id, { limit: 1000 })).toEqual(before) } finally { await reopened.dispose() }
    } finally { await active.dispose(); await loader.dispose() }
  })
})
