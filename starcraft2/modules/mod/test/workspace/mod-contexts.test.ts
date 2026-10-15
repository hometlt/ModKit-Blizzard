/**
 * The one mod loader over the host's content sources.
 *
 * Stock packages live in a CASC-like source that projects their DocumentInfo; a user mod lives
 * on disk and declares Void; a trigger script lives in no package at all. The loader must give
 * each a load order built from the same rules, report where every layer came from, serve reads
 * only from each layer's own file list, and open the loose file inside the base mod a setting
 * names — Void by default.
 */
import { afterAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
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
  'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Marine'),
  'Mods/Liberty.SC2Mod/Base.SC2Assets/Assets/Textures/marine.dds': 'DDS ',
  'Mods/Swarm.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Zergling'),
  'Mods/Void.SC2Mod/Base.SC2Data/GameData/UnitData.xml': unit('Adept'),
  'Mods/Void.SC2Mod/Base.SC2Data/TriggerLibs/LibraryList.xml': '<LibraryList/>',
  'Scripts/Tool.galaxy': 'void tool() {}\n',
})

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sc2-mod-contexts-'))
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

describe('the one mod loader', () => {
  it('orders a user mod over the stock chain it declares, and says where each layer came from', async () => {
    const modRoot = path.join(scratch, 'Mine.SC2Mod')
    await write(
      'Mine.SC2Mod/DocumentInfo',
      '<DocInfo><Dependencies><Value>bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod</Value></Dependencies></DocInfo>',
    )
    await write('Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml', unit('Mine'))
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: modRoot })

    expect(context.layers.map(layer => [layer.sourceId, layer.sourcePath, layer.provenance])).toEqual([
      ['local:casc', 'Mods/Core.SC2Mod', 'declared'],
      ['local:casc', 'Mods/Liberty.SC2Mod', 'declared'],
      ['local:casc', 'Mods/Swarm.SC2Mod', 'declared'],
      ['local:casc', 'Mods/Void.SC2Mod', 'declared'],
      ['host', modRoot.replace(/\\/g, '/'), 'opened'],
    ])
    expect(context.unresolved).toEqual([])
    // every layer's catalog is in the resolved data, answered by reference
    const units = ['Adept', 'CoreUnit', 'Marine', 'Mine', 'Zergling']
    const answer = await context.query({
      kind: 'data.entities',
      refs: units.map(entityId => ({ namespace: 'Unit', entityId })),
    })
    expect(answer.entities.map(entity => entity.entityId).sort()).toEqual(units)
    await loader.dispose()
  })

  it('lists each layer by original paths and refuses a read the list does not hold', async () => {
    const modRoot = path.join(scratch, 'Mine.SC2Mod')
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: modRoot })
    const liberty = context.layers.find(layer => layer.sourcePath === 'Mods/Liberty.SC2Mod')
    if (liberty === undefined) throw new Error('Liberty is not in the chain')
    const page = await context.files(liberty.id, { limit: 10 })
    expect(page.items).toEqual([
      'Base.SC2Assets/Assets/Textures/marine.dds',
      'Base.SC2Data/GameData/UnitData.xml',
      'DocumentInfo',
    ])
    const bytes = await context.read(liberty.id, 'Base.SC2Assets/Assets/Textures/marine.dds', 1024)
    expect(new TextDecoder().decode(bytes)).toBe('DDS ')
    await expect(context.read(liberty.id, 'Base.SC2Data/GameData/Missing.xml', 1024)).rejects.toThrow(
      /not a file of/u,
    )
    // the last layer that has a path wins
    expect(await context.locate('Base.SC2Data/GameData/UnitData.xml')).toEqual({
      layerId: context.layers[context.layers.length - 1]?.id,
      path: 'Base.SC2Data/GameData/UnitData.xml',
    })
    await loader.dispose()
  })

  it('answers resolved entities by reference and filters a layer listing by prefix', async () => {
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: path.join(scratch, 'Mine.SC2Mod') })
    const answer = await context.query({
      kind: 'data.entities',
      refs: [
        { namespace: 'Unit', entityId: 'Marine' },
        { namespace: 'Unit', entityId: 'Mine' },
        { namespace: 'Unit', entityId: 'Nobody' },
      ],
    })
    expect(answer.entities.map(entity => `${entity.namespace}/${entity.entityId}`)).toEqual([
      'Unit/Marine',
      'Unit/Mine',
    ])
    await expect(context.query({ kind: 'everything' })).rejects.toThrow(/data\.entities/u)
    const liberty = context.layers.find(layer => layer.sourcePath === 'Mods/Liberty.SC2Mod')
    if (liberty === undefined) throw new Error('Liberty is not in the chain')
    expect((await context.files(liberty.id, { limit: 10, prefix: 'base.sc2assets/' })).items).toEqual([
      'Base.SC2Assets/Assets/Textures/marine.dds',
    ])
    await loader.dispose()
  })

  it("opens a packed map through the MPQ codec and reads its own GameData into the resolved data", async () => {
    const map = await write('Packed.SC2Map', '')
    await fs.writeFile(
      map,
      await encodeFreshMpq([
        { path: 't3Terrain.xml', bytes: new TextEncoder().encode('<terrain tileSet="T"/>') },
        {
          path: 'Base.SC2Data/GameData/WaterData.xml',
          bytes: new TextEncoder().encode('<Catalog><CWater id="MapOnly"/></Catalog>'),
        },
      ]),
    )
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: map })
    const primary = context.layers[context.layers.length - 1]
    if (primary === undefined) throw new Error('no primary layer')
    expect([primary.sourceId, primary.sourcePath, primary.role]).toEqual(['host', map.replace(/\\/g, '/'), 'primary'])
    expect((await context.files(primary.id, { limit: 10 })).items).toEqual([
      '(listfile)',
      'Base.SC2Data/GameData/WaterData.xml',
      't3Terrain.xml',
    ])
    const answer = await context.query({ kind: 'data.entities', refs: [{ namespace: 'Water', entityId: 'MapOnly' }] })
    expect(answer.entities.map(entity => entity.entityId)).toEqual(['MapOnly'])
    await loader.dispose()
  })

  it('opens a file that belongs to no package inside Void, or inside the base a setting names', async () => {
    const script = await write('loose/MapScript.galaxy', 'void main() {}\n')
    const loader = contexts()
    const byDefault = await loader.open({ schemaVersion: 1, target: script })
    expect(byDefault.layers.map(layer => [layer.sourcePath, layer.role, layer.provenance])).toEqual([
      ['Mods/Core.SC2Mod', 'dependency', 'declared'],
      ['Mods/Liberty.SC2Mod', 'dependency', 'declared'],
      ['Mods/Swarm.SC2Mod', 'dependency', 'declared'],
      ['Mods/Void.SC2Mod', 'base', 'setting'],
      [script.replace(/\\/g, '/'), 'primary', 'opened'],
    ])
    const primary = byDefault.layers[byDefault.layers.length - 1]
    if (primary === undefined) throw new Error('no primary layer')
    expect((await byDefault.files(primary.id, { limit: 10 })).items).toEqual(['MapScript.galaxy'])

    const onLiberty = await loader.open({
      schemaVersion: 1,
      target: script,
      baseMods: ['Mods/Liberty.SC2Mod'],
    })
    expect(onLiberty.layers.map(layer => layer.sourcePath)).toEqual([
      'Mods/Core.SC2Mod',
      'Mods/Liberty.SC2Mod',
      script.replace(/\\/g, '/'),
    ])
    expect(onLiberty.contextId).not.toBe(byDefault.contextId)
    await loader.dispose()
  })

  it('opens a folder that belongs to no package inside Void, serving every file under it', async () => {
    await write('scripts/Main.galaxy', 'void main() {}\n')
    await write('scripts/lib/Util.galaxy', 'void util() {}\n')
    const folder = path.join(scratch, 'scripts')
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: folder })
    expect(context.layers.map(layer => [layer.sourcePath, layer.role])).toEqual([
      ['Mods/Core.SC2Mod', 'dependency'],
      ['Mods/Liberty.SC2Mod', 'dependency'],
      ['Mods/Swarm.SC2Mod', 'dependency'],
      ['Mods/Void.SC2Mod', 'base'],
      [folder.replace(/\\/g, '/'), 'primary'],
    ])
    const primary = context.layers[context.layers.length - 1]
    if (primary === undefined) throw new Error('no primary layer')
    expect((await context.files(primary.id, { limit: 10 })).items).toEqual([
      'Main.galaxy',
      'lib/Util.galaxy',
    ])
    expect(new TextDecoder().decode(await context.read(primary.id, 'lib/Util.galaxy', 1024))).toBe(
      'void util() {}\n',
    )
    await loader.dispose()
  })

  it('opens a path inside a content source: its package, or a loose file inside Void', async () => {
    const loader = contexts()
    const inPackage = await loader.open({
      schemaVersion: 1,
      target: { sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml' },
    })
    expect(inPackage.layers.map(layer => [layer.sourceId, layer.sourcePath, layer.role])).toEqual([
      ['local:casc', 'Mods/Core.SC2Mod', 'dependency'],
      ['local:casc', 'Mods/Liberty.SC2Mod', 'primary'],
    ])
    const loose = await loader.open({
      schemaVersion: 1,
      target: { sourceId: 'local:casc', path: 'Scripts/Tool.galaxy' },
    })
    expect(loose.layers.map(layer => [layer.sourcePath, layer.role])).toEqual([
      ['Mods/Core.SC2Mod', 'dependency'],
      ['Mods/Liberty.SC2Mod', 'dependency'],
      ['Mods/Swarm.SC2Mod', 'dependency'],
      ['Mods/Void.SC2Mod', 'base'],
      ['Scripts/Tool.galaxy', 'primary'],
    ])
    const primary = loose.layers[loose.layers.length - 1]
    if (primary === undefined) throw new Error('no primary layer')
    expect(new TextDecoder().decode(await loose.read(primary.id, 'Tool.galaxy', 1024))).toBe('void tool() {}' + String.fromCharCode(10))
    await loader.dispose()
  })

  it('opens a path inside a packed map as that map', async () => {
    const map = path.join(scratch, 'Packed.SC2Map')
    const loader = contexts()
    const context = await loader.open({ schemaVersion: 1, target: path.join(map, 'Base.SC2Data', 'GameData', 'WaterData.xml') })
    expect(context.layers.at(-1)?.sourcePath).toBe(map.replace(/\\/g, '/'))
    await loader.dispose()
  })

  it('layers the editor add-on folders beneath the opened package', async () => {
    const wizards = memorySource('local:editor-wizards:0', { 'Tool.BlizWiz': '<wizardfile/>' })
    const loader = contexts({ addOns: () => new Map([[wizards.id, wizards]]) })
    const context = await loader.open({ schemaVersion: 1, target: path.join(scratch, 'Mine.SC2Mod') })
    const addOn = context.layers.find(layer => layer.sourceId === wizards.id)
    expect(addOn).toMatchObject({ sourcePath: '', role: 'dependency', provenance: 'setting' })
    expect(context.layers.at(-1)?.role).toBe('primary')
    expect((await context.files(addOn!.id, { limit: 10 })).items).toEqual(['Tool.BlizWiz'])
    await loader.dispose()
  })

  it('opens a replay inside the archives it names', async () => {
    const replay = await write('replays/Game.SC2Replay', 'replay bytes')
    const seen: string[] = []
    const loader = contexts({
      replayLayers: async bytes => {
        seen.push(new TextDecoder().decode(bytes))
        return { layers: [{ sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod' }], unresolved: ['s2ma:eu:missing'] }
      },
    })
    const context = await loader.open({ schemaVersion: 1, target: replay })
    expect(seen).toEqual(['replay bytes'])
    expect(context.layers.map(layer => [layer.sourcePath, layer.role, layer.provenance])).toEqual([
      ['Mods/Core.SC2Mod', 'dependency', 'declared'],
      ['Mods/Liberty.SC2Mod', 'dependency', 'declared'],
      [replay.replace(/\\/g, '/'), 'primary', 'opened'],
    ])
    expect(context.unresolved).toEqual(['s2ma:eu:missing'])
    await loader.dispose()
  })
})
