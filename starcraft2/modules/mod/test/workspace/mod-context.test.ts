/**
 * ModContextManager — a package's chain over the host's content sources: which layers load beneath
 * it, why each is there, and each layer's files. Stock packages sit in an installation-like folder
 * served as a content source; the opened package sits on disk, as a folder or a packed file.
 */
import { describe, it, expect, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { ModContextManager } from '../../shared/workspace/mod-context.js'
import type { ContentSourceStorage } from '../../shared/workspace/content-source-provider.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const encode = (text: string) => new TextEncoder().encode(text)

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'modkit-ctx-'))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

async function write(relative: string, content: string | Uint8Array): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

/** A host folder as a content source, packed packages in it read as folders — as the host serves it. */
function folder(id: string, directory: string): ContentSourceStorage {
  const source = new Sc2FolderSource(directory, id, id)
  return { id, list: p => source.list(p), read: (p, max) => source.read(p, max), dispose: () => source.dispose() }
}

/** A manager over one installation folder under the scratch directory. */
async function managerOver(install: string, packages: readonly string[]): Promise<ModContextManager> {
  for (const name of packages) await write(`${install}/${name}/Base.SC2Data/GameData/UnitData.xml`, '<Catalog/>')
  const source = folder('install', path.join(scratch, install))
  return new ModContextManager(() => new Map([[source.id, source]]), directory => folder('host', directory))
}

const names = (order: readonly string[]) =>
  order.map(layer => layer.slice(Math.max(layer.lastIndexOf('/'), layer.indexOf(':')) + 1))

describe('ModContextManager', () => {
  it('finds a content-only mod root (a folder with a GameData/ subdir)', async () => {
    const root = await new ModContextManager(() => new Map(), directory => folder('host', directory)).findModRoot(
      path.join(FIXTURES, 'ExportMod', 'GameData', 'UnitData.xml'),
    )
    expect(root && path.basename(root)).toBe('ExportMod')
  })

  it('resolves a declared dependency from a content source, and lists and reads each layer', async () => {
    const mgr = await managerOver('declared', ['Mods/Core.SC2Mod', 'Mods/BaseLib.SC2Mod'])
    const child = path.dirname(
      await write('work/Child.SC2Mod/DocumentInfo', '<DocInfo><Dependencies><Value>file:Mods\\BaseLib.SC2Mod</Value></Dependencies></DocInfo>'),
    )
    await write('work/Child.SC2Mod/Base.SC2Data/GameData/UnitData.xml', '<Catalog><CUnit id="Child"/></Catalog>')
    const mod = await mgr.resolve(child)

    expect(mod.order).toEqual([
      'content-source0:Mods/Core.SC2Mod',
      'content-source0:Mods/BaseLib.SC2Mod',
      'host0:Child.SC2Mod',
    ])
    expect(mod.unresolved).toEqual([])
    expect(mod.layerProvenance.get('content-source0:mods/baselib.sc2mod')).toBe('declared')
    expect(mod.layerProvenance.get('content-source0:mods/core.sc2mod')).toBe('implicit')
    expect(await mgr.sourceOf(mod.order[1] as string)).toEqual({ id: 'install', path: 'Mods/BaseLib.SC2Mod' })
    expect(await mgr.sourceOf(mod.order[2] as string)).toEqual({ id: 'host', path: child.replace(/\\/g, '/') })

    const primary = mod.order[2] as string
    expect((await mod.files(primary)).list).toEqual(['Base.SC2Data/GameData/UnitData.xml', 'DocumentInfo'])
    expect(await mod.read(primary, 'base.sc2data/gamedata/unitdata.xml')).toEqual(
      encode('<Catalog><CUnit id="Child"/></Catalog>'),
    )
    // only what the layer lists is served
    expect(await mod.read(primary, '../BaseLib.SC2Mod/DocumentInfo')).toBeUndefined()
    await expect(mod.files('file:C:/elsewhere')).rejects.toThrow(/not a layer/u)

    expect(mgr.resolve(child)).toBe(mgr.resolve(child))
    const first = mgr.resolve(child)
    mgr.invalidate()
    expect(mgr.resolve(child)).not.toBe(first)
    await mgr.dispose()
  })

  // v89: «Reload Resources» reread a changed file but never listed a new one — the open package's
  // folder listing outlived the refresh.
  it('lists a file added to an open package once the host source is invalidated', async () => {
    const mgr = await managerOver('added', ['Mods/Core.SC2Mod'])
    const pkg = path.dirname(
      await write('added-work/Added.SC2Mod/DocumentInfo', '<DocInfo><Dependencies></Dependencies></DocInfo>'),
    )
    const listed = async () => {
      const mod = await mgr.resolve(pkg)
      return (await mod.files(mod.order.at(-1) as string)).list
    }
    expect(await listed()).toEqual(['DocumentInfo'])
    await write('added-work/Added.SC2Mod/Base.SC2Data/TriggerLibs/Added.galaxy', 'void Added() {}')
    mgr.invalidate('install')
    expect(await listed()).toEqual(['DocumentInfo'])
    mgr.invalidate('host')
    expect(await listed()).toEqual(['Base.SC2Data/TriggerLibs/Added.galaxy', 'DocumentInfo'])
    await mgr.dispose()
  })

  // A host calls a language snapshot complete only over layers named by their content (plan 1.23).
  it('names the layers of a source by its revision, and none of a folder on disk', async () => {
    await write('revision/Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml', '<Catalog/>')
    const install = { ...folder('install', path.join(scratch, 'revision')), revision: 'build-1' }
    const mgr = new ModContextManager(() => new Map([[install.id, install]]), directory => folder('host', directory))
    const pkg = path.dirname(await write('revision-work/Named.SC2Mod/DocumentInfo', '<DocInfo><Dependencies></Dependencies></DocInfo>'))
    const mod = await mgr.resolve(pkg)
    expect(mod.order.map(layer => mod.fingerprints.get(layer.toLowerCase()))).toEqual([
      'provider-token:build-1%2Fmods%2Fcore.sc2mod',
      undefined,
    ])
    await mgr.dispose()
  })

  it('resolves a dependency that sits next to its mod in a nested collection folder', async () => {
    const mgr = await managerOver('nested', ['Mods/Core.SC2Mod'])
    const scion = path.dirname(
      await write('nested-work/allraces/Scion.SC2Mod/DocumentInfo', '<DocInfo><Dependencies><Value>file:Mods\\Scion-Assets.SC2Mod</Value></Dependencies></DocInfo>'),
    )
    await write('nested-work/allraces/Scion-Assets.SC2Mod/GameData/UnitData.xml', '<Catalog/>')
    const mod = await mgr.resolve(scion)
    expect(mod.unresolved).toEqual([])
    expect(names(mod.order)).toEqual(['Core.SC2Mod', 'Scion-Assets.SC2Mod', 'Scion.SC2Mod'])
    await mgr.dispose()
  })

  it('does not add Core.SC2Mod as its own dependency, and loads only Core beneath a bare map', async () => {
    const mgr = await managerOver('core', ['Mods/Core.SC2Mod', 'Mods/Liberty.SC2Mod'])
    const core = await mgr.resolve(path.join(scratch, 'core', 'Mods', 'Core.SC2Mod'))
    expect(names(core.order)).toEqual(['Core.SC2Mod'])
    // Liberty is a declaration, not a default: the engine loads Core alone beneath such a map.
    const map = path.dirname(await write('core-work/MyMap.SC2Map/t3Terrain.xml', '<terrain tileSet="Test"/>'))
    const mod = await mgr.resolve(map)
    expect(names(mod.order)).toEqual(['Core.SC2Mod', 'MyMap.SC2Map'])
    expect(await mod.read(mod.order[1] as string, 't3Terrain.xml')).toEqual(encode('<terrain tileSet="Test"/>'))
    await mgr.dispose()
  })

  it('layers a campaign over its matching data mod and engine parents', async () => {
    const mgr = await managerOver('campaign', [
      'Mods/Core.SC2Mod',
      'Mods/Liberty.SC2Mod',
      'Mods/Swarm.SC2Mod',
      'Mods/Void.SC2Mod',
      'Campaigns/Liberty.SC2Campaign',
      'Campaigns/Swarm.SC2Campaign',
      'Campaigns/Void.SC2Campaign',
    ])
    // A bare name with a package extension never matches the other kind of the same stem.
    const map = path.dirname(
      await write('campaign-work/CampaignMap.SC2Map/DocumentInfo', '<DocInfo><Dependencies><Value>file:Void.SC2Campaign</Value></Dependencies></DocInfo>'),
    )
    const mod = await mgr.resolve(map)
    expect(mod.unresolved).toEqual([])
    expect(names(mod.order)).toEqual([
      'Core.SC2Mod',
      'Liberty.SC2Mod',
      'Liberty.SC2Campaign',
      'Swarm.SC2Mod',
      'Swarm.SC2Campaign',
      'Void.SC2Mod',
      'Void.SC2Campaign',
      'CampaignMap.SC2Map',
    ])
    await mgr.dispose()
  })

  it('opens a packed SC2Map through the MPQ codec, and fails to list one that is not an archive', async () => {
    const mgr = await managerOver('packed', ['Mods/Core.SC2Mod'])
    const terrain = encode('<terrain tileSet="ArchiveTerrain"/>')
    const map = await write(
      'packed-work/Archive.SC2Map',
      await encodeFreshMpq([
        { path: 't3Terrain.xml', bytes: terrain },
        { path: 'Base.SC2Data/GameData/UnitData.xml', bytes: encode('<Catalog><CUnit id="ArchiveUnit"/></Catalog>') },
      ]),
    )
    const mod = await mgr.resolve(map)
    const primary = mod.order.at(-1) as string
    expect(primary).toBe('host0:Archive.SC2Map')
    expect(names(mod.order.slice(0, -1))).toEqual(['Core.SC2Mod'])
    // the archive as the content source lists it, the MPQ's own (listfile) included
    expect((await mod.files(primary)).list).toEqual(['(listfile)', 'Base.SC2Data/GameData/UnitData.xml', 't3Terrain.xml'])
    expect(await mod.read(primary, 't3Terrain.xml')).toEqual(terrain)

    const fake = await write('packed-work/Fake.SC2Map', 'not an archive')
    const broken = await mgr.resolve(fake)
    await expect(broken.files(broken.order.at(-1) as string)).rejects.toThrow()
    await mgr.dispose()
  })
})
