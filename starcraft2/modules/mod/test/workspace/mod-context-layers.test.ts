/**
 * The one mod loader: later resource cases. Stock metadata is projected by the source, as in CASC;
 * the fixture adds localized strings and a Galaxy library to the stock chain. Current verification
 * hashes are recorded in the feature ledger; earlier receipts retain their historical hashes.
 */
import { afterAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import type { ContentSourceStorage } from '../../shared/workspace/content-source-provider.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'
import { sc2BuiltinDocumentInfo } from '../../shared/workspace/implicit-dependencies.js'

const unit = (id: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n  <CUnit id="${id}"/>\n</Catalog>\n`

/** A content source held in memory: a path → bytes table, listed a folder at a time. */
function memorySource(id: string, files: Record<string, string>): ContentSourceStorage {
  const table = new Map(Object.entries(files).map(([file, text]) => [file, new TextEncoder().encode(text)]))
  return {
    id,
    async list(folder) {
      const prefix = folder === '' ? '' : `${folder.toLowerCase()}/`
      const children = new Map<string, { name: string; directory: boolean }>()
      for (const file of table.keys()) {
        if (!file.toLowerCase().startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const name = rest.split('/')[0] as string
        children.set(name.toLowerCase(), { name, directory: rest.includes('/') })
      }
      if (children.size === 0 && prefix !== '') throw new Error(`${folder} does not exist`)
      return [...children.values()]
    },
    async read(file, maxBytes) {
      const hit = [...table].find(([key]) => key.toLowerCase() === file.toLowerCase())
      if (hit === undefined) throw new Error(`${file} does not exist`)
      if (hit[1].byteLength > maxBytes) throw new Error('too large')
      return hit[1]
    },
  }
}

const casc = memorySource('local:casc', {
  ...Object.fromEntries(['Core', 'Liberty', 'Swarm', 'Void'].map(name => [
    `Mods/${name}.SC2Mod/DocumentInfo`, sc2BuiltinDocumentInfo(`Mods/${name}.SC2Mod`)!,
  ])),
  'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('CoreUnit'),
  'Mods/Core.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Marine=Core Marine\nUnit/Name/CoreOnly=Core name\n',
  'Mods/Core.SC2Mod/Base.SC2Data/TriggerLibs/Core.galaxy': 'void CoreFn() {}\n',
  'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Marine'),
  'Mods/Liberty.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Marine=Liberty Marine\n',
  'Mods/Liberty.SC2Mod/Base.SC2Assets/Assets/Textures/marine.dds': 'DDS ',
  'Mods/Swarm.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Zergling'),
  'Mods/Void.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Adept'),
  'Mods/Void.SC2Mod/Base.SC2Data/TriggerLibs/LibraryList.xml': '<LibraryList/>',
  'Scripts/Tool.galaxy': 'void tool() {}\n',
})

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sc2-mod-context-layers-'))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

function contexts(extra: Partial<Parameters<typeof createSc2ModContexts>[0]> = {}) {
  return createSc2ModContexts({
    ...extra,
    sources: () => new Map([[casc.id, casc]]),
    hostFolder: directory => {
      const folder = new Sc2FolderSource(directory, 'host', 'host')
      return { id: 'host', list: p => folder.list(p), read: (p, max) => folder.read(p, max), dispose: () => folder.dispose() }
    },
  })
}

describe('the one mod loader, later cases', () => {
  it('does not strip or rename custom source roots while normalizing built-in package spelling', async () => {
    const { canonicalSourcePackageRoot } = await import('../../shared/workspace/mod-context.js')
    const custom = ['Nested/Mods/Liberty.SC2Mod', 'Mods/CuStOm.SC2Mod', 'Mods/Liberty.SC2Mod/Nested.SC2Mod', 'C:/Games/Mods/Liberty.SC2Mod']
    expect(custom.map(canonicalSourcePackageRoot)).toEqual(custom)
  })

  it('uses the same stock package identity when opened with another spelling and when inherited', async () => {
    const loader = contexts()
    const parent = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'mods/liberty.sc2mod' } })
    const child = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'mods/void.sc2mod' } })
    try {
      const primary = parent.layers.at(-1)!
      const inherited = child.layers.find(layer => layer.sourcePath.toLowerCase() === 'mods/liberty.sc2mod')!
      expect(primary.sourcePath).toBe(inherited.sourcePath)
      expect(primary.sourcePath).toBe('Mods/Liberty.SC2Mod')
      const placed = await loader.locateModPackage({ sourceId: 'local:casc', path: 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml' })
      expect(placed).toMatchObject({ kind: 'package', path: primary.sourcePath, displayName: primary.displayName })
    } finally { await parent.dispose(); await child.dispose(); await loader.dispose() }
  })

  it('serves one effective resource tree over dependencies, with overridden strings', async () => {
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod' } })
    const root = await context.query({ kind: 'resources.tree', action: 'root' }) as { id: string; hasChildren: boolean }
    const page = await context.query({ kind: 'resources.tree', action: 'children', node: root, page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    const facts = await Promise.all(page.items.map(node => context.query({ kind: 'resources.tree', action: 'facts', node }) as Promise<{ label: string; value?: number }>))
    expect(facts.map(item => item.label)).toContain('Strings')
    const strings = page.items[facts.findIndex(item => item.label === 'Strings')]!
    const locales = await context.query({ kind: 'resources.tree', action: 'children', node: strings, page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    const catalogs = await context.query({ kind: 'resources.tree', action: 'children', node: locales.items[0], page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    const groups = await context.query({ kind: 'resources.tree', action: 'children', node: catalogs.items[0], page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    const keys = await context.query({ kind: 'resources.tree', action: 'children', node: groups.items[0], page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    const keyFacts = await Promise.all(keys.items.map(node => context.query({
      kind: 'resources.tree', action: 'facts', node,
    }) as Promise<{ label: string; preview?: string; subjectId?: string }>))
    expect(keyFacts.find(item => item.label === 'Unit/Name/Marine')).toMatchObject({
      preview: 'Liberty Marine', subjectId: expect.stringContaining('Liberty.SC2Mod'),
    })
    expect(keyFacts.find(item => item.label === 'Unit/Name/CoreOnly')).toMatchObject({
      preview: 'Core name', subjectId: expect.stringContaining('Core.SC2Mod'),
    })
    const coreUnit = await context.query({ kind: 'resources.tree', action: 'facts',
      node: { id: 'entity/Unit/CoreUnit', hasChildren: true } }) as { declaration?: { subjectId: string } }
    expect(coreUnit.declaration?.subjectId).toContain('Core.SC2Mod')
    const galaxy = page.items[facts.findIndex(item => item.label === 'Galaxy')]!
    const symbols = await context.query({ kind: 'resources.tree', action: 'children', node: galaxy, page: { limit: 50 } }) as { items: { id: string; hasChildren: boolean }[] }
    expect(symbols.items.length).toBeGreaterThan(0)
    await loader.dispose()
  })
  /*
   * VS Code asks where a path lies before it loads anything, so the answer must be the one `open`
   * would give: the package it names is the primary layer's source and path, `loose` means the file
   * opens over the base mods, and `missing` means `open` refuses.
   */
  it('places a target the way opening it would, without resolving a chain', async () => {
    const file = await write('Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml', unit('Mine'))
    const loader = contexts()
    const primaryOf = async (target: Parameters<typeof loader.open>[0]['target']) => {
      const context = await loader.open({ schemaVersion: 1, target })
      const primary = context.layers.at(-1)
      return { sourceId: primary?.sourceId, path: primary?.sourcePath, displayName: primary?.displayName, kind: primary?.kind }
    }

    const inPackage = await loader.locateModPackage(file)
    expect(inPackage).toEqual({
      kind: 'package',
      sourceId: 'host',
      path: path.join(scratch, 'Mine.SC2Mod').split(path.sep).join('/'),
      displayName: 'Mine.SC2Mod',
    })
    expect(await primaryOf(file)).toMatchObject({
      sourceId: 'host',
      path: path.join(scratch, 'Mine.SC2Mod').split(path.sep).join('/'),
    })

    const stock = await loader.locateModPackage({ sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml' })
    expect(stock).toEqual({ kind: 'package', sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod', displayName: 'Liberty.SC2Mod' })
    expect(await primaryOf({ sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml' }))
      .toMatchObject({ sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod' })

    // A file in no package: `open` reads it over the base mods, so its own layer is not a package.
    expect(await loader.locateModPackage({ sourceId: 'local:casc', path: 'Scripts/Tool.galaxy' }))
      .toEqual({ kind: 'loose' })
    expect(await primaryOf({ sourceId: 'local:casc', path: 'Scripts/Tool.galaxy' }))
      .toMatchObject({ kind: 'files', path: 'Scripts/Tool.galaxy' })

    const absent = path.join(scratch, 'nowhere', 'Nothing.SC2Mod', 'DocumentInfo')
    expect(await loader.locateModPackage(absent)).toEqual({ kind: 'missing' })
    await expect(loader.open({ schemaVersion: 1, target: absent })).rejects.toThrow()
    await loader.dispose()
  })

  /*
   * In a window with several games the composition gives a host path to the module that calls it a
   * package, else to the first that takes it loose. A Warcraft III script outside any package must
   * reach Warcraft III, not open over StarCraft II's base mods, so a type SC2 does not read is
   * `foreign`; every type SC2's own manifests declare stays `loose`.
   */
  it('calls a file of a type StarCraft II does not read foreign', async () => {
    const script = await write('Loose/common.j', 'native Foo takes nothing returns nothing\n')
    const map = await write('Loose/Map.w3x', 'HM3W')
    const loader = contexts()
    expect(await loader.locateModPackage(script)).toEqual({ kind: 'foreign' })
    expect(await loader.locateModPackage(map)).toEqual({ kind: 'foreign' })
    expect(await loader.locateModPackage({ sourceId: 'local:casc', path: 'Scripts/Blizzard.j' }))
      .toEqual({ kind: 'foreign' })
    expect(await loader.locateModPackage(path.dirname(script))).toEqual({ kind: 'loose' })

    const declared = new Set<string>()
    const collect = (value: unknown, key?: string): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && (key === 'extensions' || key === 'fileExtensions')) declared.add(item)
          else collect(item)
        }
      } else if (value !== null && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) collect(item, name)
      }
    }
    const modules = path.join(import.meta.dirname, '..', '..', '..')
    for (const entry of await fs.readdir(modules, { recursive: true, withFileTypes: true })) {
      const where = path.join(entry.parentPath, entry.name)
      if (!/(?:codec|provider)\.json$/u.test(entry.name) || /[\\/](?:dist|node_modules|test)[\\/]/u.test(where)) continue
      collect(JSON.parse(await fs.readFile(where, 'utf8')))
    }
    expect(declared.size).toBeGreaterThan(10)
    for (const extension of declared) {
      // A package extension (`.SC2Mod`) places as the package it names; nothing SC2 declares is foreign.
      const placed = await loader.locateModPackage({ sourceId: 'local:casc', path: `Scripts/Probe.${extension.replace(/^\./u, '')}` })
      expect([extension, placed.kind]).not.toEqual([extension, 'foreign'])
    }
    await loader.dispose()
  })

  it('says which layer is a package and which is only files', async () => {
    const wizards = memorySource('local:editor-wizards:0', { 'Tool.BlizWiz': '<wizardfile/>' })
    await write('Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml', unit('Mine'))
    const loader = contexts({ addOns: () => new Map([[wizards.id, wizards]]) })
    const context = await loader.open({ schemaVersion: 1, target: path.join(scratch, 'Mine.SC2Mod') })
    expect(context.layers.find(layer => layer.sourceId === wizards.id)).toMatchObject({ kind: 'files' })
    expect(context.layers.at(-1)).toMatchObject({ role: 'primary', kind: 'package' })
    await loader.dispose()
  })
})
