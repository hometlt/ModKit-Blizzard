import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { Sc2CascSource } from '../battlenet/content-sources/casc-source.js'
import { Sc2FolderSource } from '../battlenet/content-sources/local-files.js'
import { createSc2ModContexts } from '../../mod/shared/workspace/mod-contexts.js'

const fixture = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), notInstalled: new Set<string>(), localRows: vi.fn(), localRow: vi.fn() }))
vi.mock('@modkit/blizzard-casc/installation-node', () => ({
  installationBuild: () => ({ buildKey: 'synthetic-build', product: 's2' }),
  openCascInstallation: async () => {
    const keys = [...fixture.files.keys()].sort()
    const index = {
      lowerBound: (prefix: string) => {
        const index = keys.findIndex(key => key >= prefix)
        return index < 0 ? keys.length : index
      },
      keyAt: (index: number) => keys[index]!,
      contentSizeAt: (index: number) => fixture.files.get(keys[index]!)!.byteLength,
      forEachKey: (start: number, end: number, visit: (bytes: Uint8Array, from: number, to: number, index: number) => boolean) => {
        for (let index = start; index < end; index++) {
          const bytes = new TextEncoder().encode(keys[index]!)
          if (!visit(bytes, 0, bytes.length, index)) break
        }
      },
    }
    return {
      entryIndex: index,
      localRows: async () => { fixture.localRows(); return Uint8Array.from(keys, key => (fixture.notInstalled.has(key) ? 0 : 1)) },
      localRow: (row: number) => { fixture.localRow(); return !fixture.notInstalled.has(keys[row]!) },
      contentSizeOf: (file: string) => fixture.files.get(file.toLowerCase())?.byteLength,
      readPath: async (file: string) => fixture.files.get(file.toLowerCase())!,
      close: async () => {},
    }
  },
}))

function source(packages: readonly string[] = ['Core', 'Liberty', 'Swarm', 'Void']): Sc2CascSource {
  for (const name of packages) {
    fixture.files.set(`mods/${name.toLowerCase()}.sc2mod/base.sc2data/gamedata/unitdata.xml`, new TextEncoder().encode('<Catalog/>'))
  }
  return new Sc2CascSource(path.resolve('synthetic-sc2-installation'))
}

afterEach(() => {
  fixture.files.clear()
  fixture.notInstalled.clear()
  fixture.localRows.mockClear()
  fixture.localRow.mockClear()
})

/** What the loader found before `listFiles`: every file reached by walking `list` folder by folder. */
async function walked(casc: Sc2CascSource, path: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await casc.list(directory)) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.directory) await visit(`${directory}/${entry.name}`, relative)
      else files.push(relative)
    }
  }
  await visit(path, '')
  return files.sort()
}

describe('CASC package listing for the mod loader', () => {
  it('checks only matching package rows for scoped file pages and keeps installed-only results', async () => {
    const casc = source(['Core', 'Void'])
    const folder = 'mods/void.sc2mod/base.sc2data'
    for (const file of ['a.txt', 'b.txt', 'c.galaxy']) {
      fixture.files.set(`${folder}/${file}`, new TextEncoder().encode(file))
    }
    fixture.notInstalled.add(`${folder}/b.txt`)
    try {
      expect((await casc.files(folder, { limit: 10, extensions: ['galaxy'] })).items)
        .toEqual([expect.objectContaining({ path: `${folder}/c.galaxy` })])
      expect(fixture.localRows).not.toHaveBeenCalled()
      expect(fixture.localRow).toHaveBeenCalledTimes(1)
      const files: string[] = []
      let cursor: string | undefined
      do {
        const page = await casc.files(folder, { limit: 1, extensions: ['txt'], ...(cursor === undefined ? {} : { cursor }) })
        files.push(...page.items.map(item => item.path))
        cursor = page.nextCursor
      } while (cursor !== undefined)
      expect(files).toEqual([`${folder}/a.txt`])
      expect(fixture.localRows).not.toHaveBeenCalled()
      // A whole-storage search still amortizes availability checks with the complete bitmap.
      await casc.files('', { limit: 10 })
      expect(fixture.localRows).toHaveBeenCalled()
    } finally { await casc.dispose() }
  })

  it('opens online stock metadata without scanning local availability for the entire installation', async () => {
    const casc = source(['Void'])
    try {
      expect(new TextDecoder().decode(await casc.read('Mods/Void.SC2Mod/DocumentInfo', 4096)))
        .toContain('<Value>file:Mods/Swarm.SC2Mod</Value>')
      expect((await casc.list('Mods/Void.SC2Mod')).some(item => item.name === 'DocumentInfo')).toBe(true)
      expect(await casc.listFiles('Mods/Void.SC2Mod')).toContain('DocumentInfo')
      expect(fixture.localRows).not.toHaveBeenCalled()
      expect(fixture.localRow).toHaveBeenCalled()
      // Broad installed-file search still requests the complete availability bitmap.
      await casc.files('', { limit: 10 })
      expect(fixture.localRows).toHaveBeenCalled()
    } finally { await casc.dispose() }
  })

  it('does not manufacture stock metadata for a package with no local files', async () => {
    const casc = source(['Void'])
    fixture.notInstalled.add('mods/void.sc2mod/base.sc2data/gamedata/unitdata.xml')
    try {
      await expect(casc.read('Mods/Void.SC2Mod/DocumentInfo', 4096)).rejects.toThrow('not found')
      expect((await casc.list('Mods/Void.SC2Mod')).some(item => item.name === 'DocumentInfo')).toBe(false)
      expect(fixture.localRows).not.toHaveBeenCalled()
    } finally { await casc.dispose() }
  })

  const tree = () => {
    for (const file of ['base.sc2data/gamedata/unitdata.xml', 'base.sc2data/gamedata/weapondata.xml',
      'base.sc2data/ui/layout/a.sc2layout', 'enus.sc2data/localizeddata/gamestrings.txt',
      'ruru.sc2data/localizeddata/gamestrings.txt', 'componentlist.sc2components']) {
      fixture.files.set(`mods/void.sc2mod/${file}`, new TextEncoder().encode('x'))
    }
    // A sibling whose name extends the package's must stay outside its range.
    fixture.files.set('mods/void.sc2modx/base.sc2data/gamedata/unitdata.xml', new TextEncoder().encode('x'))
    fixture.files.set('mods/core.sc2mod/base.sc2data/gamedata/unitdata.xml', new TextEncoder().encode('x'))
  }

  it('lists one package in one pass with exactly the names a walk of list finds, online and offline', async () => {
    tree()
    // Offline hides names whose bytes are not installed, and a folder holding none of its own.
    fixture.notInstalled.add('mods/void.sc2mod/ruru.sc2data/localizeddata/gamestrings.txt')
    for (const online of [true, false]) {
      const casc = new Sc2CascSource(path.resolve('synthetic-sc2-installation'), undefined, online)
      try {
        for (const folder of ['Mods/Void.SC2Mod', 'Mods/Void.SC2Mod/Base.SC2Data', 'Mods/Void.SC2Mod/Base.SC2Data/GameData']) {
          const indexed = await casc.listFiles(folder)
          expect(indexed?.slice().sort()).toEqual(await walked(casc, folder))
        }
        const files = (await casc.listFiles('Mods/Void.SC2Mod'))!
        expect(files).toContain('DocumentInfo')
        expect(files.includes('ruru.sc2data/localizeddata/gamestrings.txt')).toBe(online)
        expect(files.some(file => file.includes('unitdata.xml') && file.startsWith('base.sc2data/'))).toBe(true)
        expect(await casc.listFiles('Mods/Void.SC2Mod/Base.SC2Data')).not.toContain('DocumentInfo')
        // Above package level the loader walks, as before.
        expect(await casc.listFiles('Mods')).toBeUndefined()
        await expect(casc.listFiles('Mods/Missing.SC2Mod')).rejects.toThrow('not found')
        await expect(casc.list('Mods/Missing.SC2Mod')).rejects.toThrow('not found')
        await expect(casc.listFiles('Maps/Void.SC2Mod')).rejects.toThrow('Select Mods or Campaigns')
      } finally { await casc.dispose() }
    }
  })

  it('gives the loader the same layer files whether the storage lists by index or is walked', async () => {
    tree()
    const casc = new Sc2CascSource(path.resolve('synthetic-sc2-installation'))
    const listed: string[] = []
    const storage = (indexed: boolean) => ({
      id: 'local:casc',
      list: (folder: string) => { listed.push(folder); return casc.list(folder) },
      ...(indexed ? { listFiles: (folder: string) => casc.listFiles(folder) } : {}),
      read: (file: string, maximum: number) => casc.read(file, maximum),
    })
    const filesOf = async (indexed: boolean) => {
      const loader = createSc2ModContexts({ sources: () => new Map([['local:casc', storage(indexed)]]),
        hostFolder: () => { throw new Error('No host folder is read') } })
      try {
        const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/Void.SC2Mod' } })
        const all = async (layerId: string): Promise<string[]> => {
          const items: string[] = []
          let cursor: string | undefined
          do {
            const page = await context.files(layerId, { limit: 1000, ...(cursor === undefined ? {} : { cursor }) })
            items.push(...page.items)
            cursor = page.nextCursor
          } while (cursor !== undefined)
          return items.sort()
        }
        return await Promise.all(context.layers.map(async layer => [layer.sourcePath, await all(layer.id)] as const))
      } finally { await loader.dispose() }
    }
    try {
      listed.length = 0
      const viaWalk = await filesOf(false)
      const walkedFolders = listed.filter(folder => folder.toLowerCase().startsWith('mods/void.sc2mod/')).length
      listed.length = 0
      const viaIndex = await filesOf(true)
      expect(viaIndex).toEqual(viaWalk)
      expect(viaIndex.find(([layer]) => layer === 'Mods/Void.SC2Mod')?.[1]).toContain('DocumentInfo')
      // The index answered the package: no folder below it was listed one by one.
      expect(walkedFolders).toBeGreaterThan(0)
      expect(listed.filter(folder => folder.toLowerCase().startsWith('mods/void.sc2mod/'))).toEqual([])
    } finally { await casc.dispose() }
  })
})

describe('stock CASC DocumentInfo through the source and the ordinary mod loader', () => {
  it('projects the same metadata for stock directories and archives without changing their files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sc2-stock-metadata-'))
    const folder = new Sc2FolderSource(root, 'local:game', 'Synthetic installation')
    const real = '<DocInfo><Dependencies/></DocInfo>'
    try {
      await mkdir(path.join(root, 'Mods', 'Void.SC2Mod', 'Base.SC2Data'), { recursive: true })
      await writeFile(path.join(root, 'Mods', 'Void.SC2Mod', 'Base.SC2Data', 'data.xml'), '<Catalog/>')
      const document = (await folder.list('Mods/Void.SC2Mod')).find(item => item.name === 'DocumentInfo')!
      expect(new TextDecoder().decode(await folder.read(document.path, 4096)))
        .toContain('<Value>file:Mods/Swarm.SC2Mod</Value>')
      await expect(folder.read(document.path, 1)).rejects.toThrow('limit')
      expect(await folder.resolveLocalPath(document.path)).toEqual({ path: path.join(root, 'Mods', 'Void.SC2Mod'), kind: 'directory' })
      expect((await folder.list('Mods/Void.SC2Mod/Base.SC2Data')).some(item => item.name === 'DocumentInfo')).toBe(false)
      await writeFile(path.join(root, 'Mods', 'Void.SC2Mod', 'DocumentInfo'), real)
      expect(new TextDecoder().decode(await folder.read(document.path, 4096))).toBe(real)
      await writeFile(path.join(root, 'Mods', 'Swarm.SC2Mod'), await encodeFreshMpq([
        { path: 'Base.SC2Data/data.xml', bytes: new TextEncoder().encode('<Catalog/>') },
      ], 1024 * 1024))
      expect((await folder.list('Mods/Swarm.SC2Mod')).some(item => item.name === 'DocumentInfo')).toBe(true)
      expect(new TextDecoder().decode(await folder.read('Mods/Swarm.SC2Mod/DocumentInfo', 4096)))
        .toContain('<Value>file:Mods/Liberty.SC2Mod</Value>')
      await writeFile(path.join(root, 'Mods', 'Liberty.SC2Mod'), await encodeFreshMpq([
        { path: 'DocumentInfo', bytes: new TextEncoder().encode(real) },
      ], 1024 * 1024))
      expect(new TextDecoder().decode(await folder.read('Mods/Liberty.SC2Mod/DocumentInfo', 4096))).toBe(real)
    } finally { await folder.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('lists and reads bounded, case-insensitive metadata for installed stock packages only', async () => {
    const casc = source(['Void', 'Custom'])
    try {
      expect(casc.root.revision).toMatch(/^synthetic-build:[a-f0-9]{64}$/u)
      const rows = await casc.list('Mods/Void.SC2Mod')
      const document = rows.find(item => item.name === 'DocumentInfo')!
      const bytes = await casc.read(document.path.toUpperCase(), document.size!)
      expect(new TextDecoder().decode(bytes)).toContain('<Value>file:Mods/Swarm.SC2Mod</Value>')
      await expect(casc.read(document.path, bytes.byteLength - 1)).rejects.toThrow('limit')
      expect((await casc.list('Mods/Custom.SC2Mod')).some(item => item.name === 'DocumentInfo')).toBe(false)
      await expect(casc.read('Mods/Custom.SC2Mod/DocumentInfo', 4096)).rejects.toThrow('not found')
      await expect(casc.read('Mods/Liberty.SC2Mod/DocumentInfo', 4096)).rejects.toThrow('not found')
      await expect(casc.read('Mods/Void.SC2Mod/../DocumentInfo', 4096)).rejects.toThrow('Invalid')
    } finally { await casc.dispose() }
  })

  it('keeps a real DocumentInfo, including an empty dependency list, authoritative', async () => {
    const real = new TextEncoder().encode('<DocInfo><Dependencies/></DocInfo>')
    fixture.files.set('mods/void.sc2mod/documentinfo', real)
    const casc = source()
    const loader = createSc2ModContexts({
      sources: () => new Map([['local:casc', {
        id: 'local:casc', list: folder => casc.list(folder), read: (file, maximum) => casc.read(file, maximum),
      }]]),
      hostFolder: () => { throw new Error('No host folder is read') },
    })
    try {
      expect(await casc.read('Mods/Void.SC2Mod/DocumentInfo', 4096)).toEqual(real)
      expect((await casc.list('Mods/Void.SC2Mod')).filter(item => item.name.toLowerCase() === 'documentinfo')).toHaveLength(1)
      const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/Void.SC2Mod' } })
      expect(context.layers.map(layer => layer.sourcePath)).toEqual(['Mods/Core.SC2Mod', 'Mods/Void.SC2Mod'])
      expect(context.unresolved).toEqual([])
    } finally { await loader.dispose(); await casc.dispose() }
  })

  it('includes virtual files in paged searches without duplicates and respects filters', async () => {
    const casc = source()
    try {
      const files: string[] = []
      let cursor: string | undefined
      do {
        const page = await casc.files('', { limit: 1, ...(cursor === undefined ? {} : { cursor }) })
        files.push(...page.items.map(item => item.path))
        cursor = page.nextCursor
      } while (cursor !== undefined)
      expect(files).toHaveLength(8)
      expect(new Set(files).size).toBe(8)
      expect(files.filter(file => file.endsWith('/DocumentInfo'))).toHaveLength(4)
      expect((await casc.files('Mods/Void.SC2Mod', { limit: 10, pattern: 'void documentinfo' })).items)
        .toEqual([expect.objectContaining({ path: 'mods/void.sc2mod/DocumentInfo' })])
      expect((await casc.files('', { limit: 10, extensions: ['xml'] })).items).toHaveLength(4)
      expect((await casc.files('', { limit: 10, extensions: [''] })).items).toHaveLength(4)
      await expect(casc.files('', { limit: 1, cursor: 'virtual:-1' })).rejects.toThrow('cursor')
    } finally { await casc.dispose() }
  })

  it('loads every stock dependency from source metadata and locates the same file in its context', async () => {
    const casc = source()
    const loader = createSc2ModContexts({
      sources: () => new Map([['local:casc', {
        id: 'local:casc', list: folder => casc.list(folder), read: (file, maximum) => casc.read(file, maximum),
      }]]),
      hostFolder: () => { throw new Error('No host folder is read') },
    })
    try {
      const context = await loader.open({ schemaVersion: 1, target: {
        sourceId: 'local:casc', path: 'Mods/Void.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
      } })
      expect(context.layers.map(layer => [layer.sourcePath, layer.provenance])).toEqual([
        ['Mods/Core.SC2Mod', 'declared'], ['Mods/Liberty.SC2Mod', 'declared'],
        ['Mods/Swarm.SC2Mod', 'declared'], ['Mods/Void.SC2Mod', 'opened'],
      ])
      expect(context.unresolved).toEqual([])
      const location = await context.locate('DocumentInfo')
      expect(location).toEqual({ layerId: context.layers.at(-1)!.id, path: 'DocumentInfo' })
      expect(await context.read(location!.layerId, location!.path, 4096))
        .toEqual(await casc.read('Mods/Void.SC2Mod/DocumentInfo', 4096))
    } finally { await loader.dispose(); await casc.dispose() }
  })
})
