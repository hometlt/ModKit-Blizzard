/**
 * Where the one mod loader places a host path it cannot find as a package: a member of a container
 * the sources cannot read, or a file not yet saved, opens as a loose file inside its base mods; a
 * file not yet saved into a mod belongs to that mod; a path under nothing that exists is refused.
 *
 * The source declares stock layering through DocumentInfo, as the installed CASC source does.
 */
import { afterAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import { jsonModContentSource, type JsonMod } from '../../shared/json-mod.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'
import { sc2BuiltinDirectDependencies } from '../../shared/workspace/implicit-dependencies.js'

/** The stock chain with nothing in it: only its layering matters here. */
const stock = jsonModContentSource(
  'local:casc',
  new Map<string, JsonMod>(
    ['Core', 'Liberty', 'Swarm', 'Void'].map(name => [
      name,
      { manifest: { format: 'modkit-json-mod@1' }, deps: [...sc2BuiltinDirectDependencies(`Mods/${name}.SC2Mod`)], entries: {} },
    ]),
  ),
)

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sc2-mod-placement-'))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

const loader = createSc2ModContexts({
  sources: () => new Map([[stock.id, stock]]),
  hostFolder: directory => {
    const folder = new Sc2FolderSource(directory, 'host', 'host')
    return { id: 'host', list: p => folder.list(p), read: (p, max) => folder.read(p, max), dispose: () => folder.dispose() }
  },
})
afterAll(() => loader.dispose())

const forward = (value: string): string => value.replace(/\\/g, '/')

describe('placing a path the loader finds no package for', () => {
  it('opens a member of a container the sources cannot read inside its base mods', async () => {
    const archive = await write('downloads/Pack.zip', 'not a package')
    const member = path.join(archive, 'Maps', 'Foo.SC2Map', 'MapScript.galaxy')
    const context = await loader.open({ schemaVersion: 1, target: member })
    expect(context.layers.map(layer => [layer.sourcePath, layer.role])).toEqual([
      ['Mods/Core.SC2Mod', 'dependency'],
      ['Mods/Liberty.SC2Mod', 'dependency'],
      ['Mods/Swarm.SC2Mod', 'dependency'],
      ['Mods/Void.SC2Mod', 'base'],
      [forward(member), 'primary'],
    ])
  })

  it('opens a file not yet saved inside its folder: the base mods, or the mod around it', async () => {
    await write('downloads/.keep', '')
    const unsaved = await loader.open({
      schemaVersion: 1,
      target: path.join(scratch, 'downloads', 'Untitled.galaxy'),
    })
    expect(unsaved.layers.at(-2)?.sourcePath).toBe('Mods/Void.SC2Mod')
    await write(
      'Mine.SC2Mod/DocumentInfo',
      '<?xml version="1.0" encoding="utf-8"?>\n<DocInfo><Dependencies><Value>bnet:Void/0.0/999,file:Mods/Void.SC2Mod</Value></Dependencies></DocInfo>\n',
    )
    await write('Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml', '<Catalog/>\n')
    const inMod = await loader.open({
      schemaVersion: 1,
      target: path.join(scratch, 'Mine.SC2Mod', 'Base.SC2Data', 'GameData', 'New.xml'),
    })
    expect(inMod.layers.at(-1)?.sourcePath).toBe(forward(path.join(scratch, 'Mine.SC2Mod')))
  })

  it('refuses a path under nothing that exists', async () => {
    await expect(
      loader.open({ schemaVersion: 1, target: path.join(scratch, 'missing', 'x.galaxy') }),
    ).rejects.toThrow('does not exist')
  })
})

/*
 * A hover or a completion names an asset as the game spells it (`Assets\Textures\x.dds`); the
 * package keeps it under Base.SC2Assets, a locale's component or (a map) its root, as the mod,
 * campaign and map codecs declare (`container.assetRoots`). `locate` finds it there.
 */
describe('locating an asset by the path the game spells', () => {
  it('finds it under Base.SC2Assets, then a locale component, and a component path as itself', async () => {
    for (const file of [
      'Assets.SC2Mod/Base.SC2Assets/Assets/Textures/both.dds',
      'Assets.SC2Mod/enUS.SC2Assets/Assets/Textures/both.dds',
      'Assets.SC2Mod/deDE.SC2Assets/Assets/Textures/german.dds',
      'Assets.SC2Mod/enUS.SC2Assets/Assets/Textures/english.dds',
      'Assets.SC2Mod/Assets/Textures/root.dds',
    ])
      await write(file, 'DDS ')
    const context = await loader.open({
      schemaVersion: 1,
      target: path.join(scratch, 'Assets.SC2Mod'),
      locales: ['enUS'],
    })
    const primary = context.layers.at(-1)?.id
    const at = async (spelled: string) => (await context.locate(spelled))?.path
    expect(await at('Assets\\Textures\\both.dds')).toBe('Base.SC2Assets/Assets/Textures/both.dds')
    expect(await at('Assets\\Textures\\english.dds')).toBe('enUS.SC2Assets/Assets/Textures/english.dds')
    expect(await at('Assets/Textures/german.dds')).toBe('deDE.SC2Assets/Assets/Textures/german.dds')
    expect(await at('assets\\textures\\root.dds')).toBe('Assets/Textures/root.dds')
    expect(await at('enUS.SC2Assets/Assets/Textures/both.dds')).toBe('enUS.SC2Assets/Assets/Textures/both.dds')
    expect(await at('enUS.SC2Assets/Assets/Textures/german.dds')).toBeUndefined()
    expect(await at('Assets\\Textures\\missing.dds')).toBeUndefined()
    expect((await context.locate('Assets\\Textures\\both.dds'))?.layerId).toBe(primary)
  })
})
