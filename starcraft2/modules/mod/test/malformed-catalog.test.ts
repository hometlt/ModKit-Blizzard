/**
 * A GameData file whose XML is malformed (a live edit mid-typing, a broken download) contributes no
 * entities, and every surface says which file and why instead of failing whole or reading garbage.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SC2ModReader } from '../shared/core/reader.js'
import { FsReader, VirtualFileSystem } from '../shared/workspace/vfs.js'
import { modResourceTree, type ModCardInput } from '../services/resources/src/mod-card.js'
import { catalogFileFromBytes, loadCatalogDocument } from '../../data/shared/format/document.js'
import { sc2DataFindings } from '../../data/shared/format/summary.js'

vi.mock('@modkitx/sc2-entity-subjects', () => ({
  entitySubjectId: (namespace: string, id: string) => `entity:${namespace}/${id}`,
  entitySubjects: vi.fn(),
}))

const scratch = await mkdtemp(join(tmpdir(), 'sc2-malformed-'))
afterAll(() => rm(scratch, { recursive: true, force: true }))

describe('malformed GameData', () => {
  it('loads the rest of the mod and names the file the reader left out', async () => {
    const gameData = join(scratch, 'Broken.SC2Mod', 'Base.SC2Data', 'GameData')
    await mkdir(gameData, { recursive: true })
    await writeFile(join(gameData, 'UnitData.xml'), '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit></Catalog>')
    await writeFile(join(gameData, 'WeaponData.xml'), '<Catalog><CWeaponLegacy id="Rifle"></Catalog>')
    const vfs = new VirtualFileSystem()
    vfs.register('file:', new FsReader())
    const base = `file:${join(scratch, 'Broken.SC2Mod').replace(/\\/g, '/')}`
    const mod = await new SC2ModReader({ vfs }).read(base, { deps: [] })
    expect(mod.units.get('Marine')?.['LifeMax']).toBe('45')
    expect(mod.malformedCatalogs).toEqual([
      { mod: base, path: 'Base.SC2Data/GameData/WeaponData.xml', message: expect.stringMatching(/CWeaponLegacy/u) },
    ])
  })

  it('shows the left-out file under GameData in the Resources tree', async () => {
    const input: ModCardInput = {
      root: { id: 'fixture:Broken.SC2Mod', uri: 'fixture:Broken.SC2Mod' } as ModCardInput['root'],
      revision: 'test',
      files: new Map(),
      entries: [],
      dependencies: [],
      namespaces: [{ ns: 'Unit', total: 1, own: 1 }],
      mod: {
        locales: new Map(),
        namespaces: () => ['Unit'],
        all: ns => (ns === 'Unit' ? [{ id: 'Marine', class: 'CUnit', data: {} }] : []),
        malformedCatalogs: [{ mod: 'fixture:Broken.SC2Mod', path: 'Base.SC2Data/GameData/WeaponData.xml', message: 'Missing end tag' }],
      },
    }
    const tree = modResourceTree(input)
    const children = await tree.children({ id: 'category/gamedata', hasChildren: true }, { limit: 100 })
    const error = children.items.find(item => item.id.startsWith('data-error/'))
    expect(error).toBeDefined()
    expect(await tree.facts(error!)).toMatchObject({
      kind: 'data-diagnostic',
      label: 'Malformed XML: Base.SC2Data/GameData/WeaponData.xml',
      preview: 'Missing end tag',
    })
  })

  it('opens a malformed document as an empty catalog with the reason as an error', () => {
    const source = { id: 'WeaponData.xml', path: 'Mods/Broken.SC2Mod/Base.SC2Data/GameData/WeaponData.xml' }
    const file = catalogFileFromBytes(source, new TextEncoder().encode('<Catalog><CWeaponLegacy id="Rifle"></Catalog>'))
    expect(file.parsed.entries.size).toBe(0)
    const document = loadCatalogDocument({ files: [file], source, detection: { confidence: 1 } as never })
    expect(sc2DataFindings(document)).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'sc2-data.document-malformed',
      message: expect.stringContaining('WeaponData.xml is not well-formed XML'),
    }))
  })
})
