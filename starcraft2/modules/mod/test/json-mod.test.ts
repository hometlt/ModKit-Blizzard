/**
 * JSON mod packaging: `jsonModToFiles` writes the SC2Components layout, `parseJsonMod` reads the
 * format back, and `jsonModContentSource` serves JSON mods to the one mod loader as folder mods.
 *
 * What they produce is StarCraft II file formats: the `<Catalog>` shape, the `base.sc2data/GameData`
 * layout, the DocumentInfo `file:Mods\...` dependency form and the component manifest are
 * assertions about SC2, not about JSON.
 */
import { describe, expect, it } from 'vitest'
import {
  jsonModContentSource,
  jsonModToFiles,
  parseJsonMod,
  type JsonMod,
} from '../shared/json-mod.js'
import { createSc2ModContexts } from '../shared/workspace/mod-contexts.js'

/** Unnamed by default, so a reader case can decide the root from the map key. */
function mod(over: Partial<JsonMod> = {}): JsonMod {
  return {
    manifest: { format: 'modkit-json-mod@1' },
    deps: [],
    entries: { Unit: { BaseUnit: { LifeMax: '45' } } },
    ...over,
  }
}

function fileAt(files: ReturnType<typeof jsonModToFiles>, path: string): string {
  const hit = files.find(f => f.path === path)
  if (!hit) throw new Error(`no ${path} among ${files.map(f => f.path).join(', ')}`)
  return typeof hit.content === 'string' ? hit.content : new TextDecoder().decode(hit.content)
}

describe('jsonModToFiles', () => {
  it('writes one GameData catalog per namespace, named the way the editor names them', () => {
    const files = jsonModToFiles(
      mod({
        entries: {
          Unit: { BaseUnit: { LifeMax: '45' } },
          Weapon: { BaseRifle: { Range: '6' } },
        },
      }),
    )

    expect(files.map(f => f.path).sort()).toEqual([
      'ComponentList.SC2Components',
      'base.sc2data/GameData/unitdata.xml',
      'base.sc2data/GameData/weapondata.xml',
    ])
    expect(fileAt(files, 'base.sc2data/GameData/unitdata.xml')).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<Catalog>\n' +
        '    <CUnit id="BaseUnit">\n' +
        '        <LifeMax value="45"/>\n' +
        '    </CUnit>\n' +
        '</Catalog>\n',
    )
  })

  it('derives the class from the namespace unless the entity overrides it, and keeps parents', () => {
    const xml = fileAt(
      jsonModToFiles(
        mod({
          entries: {
            Unit: {
              Trooper: { LifeMax: '45' },
              Hero: { class: 'CUnitHero', parent: 'Trooper', LifeMax: '200' },
            },
          },
        }),
      ),
      'base.sc2data/GameData/unitdata.xml',
    )

    expect(xml).toContain('<CUnit id="Trooper">')
    expect(xml).toContain('<CUnitHero id="Hero" parent="Trooper">')
  })

  it('marks the empty id as the namespace default', () => {
    const xml = fileAt(
      jsonModToFiles(mod({ entries: { Unit: { '': { LifeMax: '100' } } } })),
      'base.sc2data/GameData/unitdata.xml',
    )
    expect(xml).toContain('<CUnit default="1" id="">')
  })

  it('writes Const entries as <const> attribute rows rather than child elements', () => {
    const xml = fileAt(
      jsonModToFiles(mod({ entries: { Const: { $Cost: { type: 'CFixed', value: '50' } } } })),
      'base.sc2data/GameData/constdata.xml',
    )
    expect(xml).toContain('<const id="$Cost" type="CFixed" value="50"/>')
  })

  it('emits a DocumentInfo only when there are deps, in the file:Mods\\ form', () => {
    expect(jsonModToFiles(mod()).some(f => f.path === 'DocumentInfo')).toBe(false)

    const info = fileAt(jsonModToFiles(mod({ deps: ['Liberty', 'Swarm.SC2Mod'] })), 'DocumentInfo')
    // A bare name gains .SC2Mod; one that already names its kind is left alone.
    expect(info).toContain('file:Mods\\Liberty.SC2Mod')
    expect(info).toContain('file:Mods\\Swarm.SC2Mod')
    expect(info).not.toContain('Swarm.SC2Mod.SC2Mod')
  })

  it('skips namespaces with no entities', () => {
    const files = jsonModToFiles(mod({ entries: { Unit: {}, Weapon: { R: { Range: '6' } } } }))
    expect(files.map(f => f.path)).not.toContain('base.sc2data/GameData/unitdata.xml')
  })
})

describe('reading a JSON mod back', () => {
  it('refuses anything that does not declare the format', () => {
    expect(parseJsonMod(JSON.stringify(mod())).entries).toEqual({ Unit: { BaseUnit: { LifeMax: '45' } } })
    expect(() => parseJsonMod('{"manifest":{"format":"other"},"deps":[],"entries":{}}')).toThrow('manifest.format')
    expect(() => parseJsonMod('{"manifest":{"format":"modkit-json-mod@1"},"deps":[1],"entries":{}}')).toThrow('deps')
    expect(() => parseJsonMod('[]')).toThrow('object')
  })

  it('serves each mod as a folder mod under Mods, named by its manifest or its key', async () => {
    const source = jsonModContentSource(
      'local:json',
      new Map([
        ['keyed', mod()],
        ['ignored', mod({ manifest: { format: 'modkit-json-mod@1', name: 'Named' } })],
      ]),
    )
    expect((await source.list('mods')).map(entry => entry.name).sort()).toEqual(['Named.SC2Mod', 'keyed.SC2Mod'])
    expect((await source.list('Mods/keyed.SC2Mod/base.sc2data/GameData')).map(entry => entry.name)).toEqual([
      'unitdata.xml',
    ])
    const xml = new TextDecoder().decode(await source.read('MODS\\KEYED.SC2MOD\\base.sc2data\\GameData\\unitdata.xml', 1 << 20))
    expect(xml).toContain('<CUnit id="BaseUnit">')
    await expect(source.read('Mods/keyed.SC2Mod/missing.xml', 1 << 20)).rejects.toThrow('not in local:json')
  })

  it('opens through the one mod loader over the stock chain it declares', async () => {
    const stock = jsonModContentSource(
      'local:casc',
      new Map<string, JsonMod>(
        ['Core', 'Liberty', 'Swarm', 'Void'].map((name, index, names) => [name, mod({
          entries: {}, deps: index === 0 ? [] : [names[index - 1]!],
        })]),
      ),
    )
    const mine = jsonModContentSource(
      'local:json',
      new Map([
        [
          'Mine',
          mod({
            deps: ['Void'],
            entries: { Unit: { Trooper: { LifeMax: '45' }, Hero: { parent: 'Trooper', Speed: '3' } } },
          }),
        ],
      ]),
    )
    const loader = createSc2ModContexts({
      sources: () => new Map([[stock.id, stock], [mine.id, mine]]),
      hostFolder: () => {
        throw new Error('no host folder is read')
      },
    })
    try {
      const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'local:json', path: 'Mods/Mine.SC2Mod' } })
      expect(context.layers.map(layer => [layer.sourceId, layer.sourcePath])).toEqual([
        ['local:casc', 'Mods/Core.SC2Mod'],
        ['local:casc', 'Mods/Liberty.SC2Mod'],
        ['local:casc', 'Mods/Swarm.SC2Mod'],
        ['local:casc', 'Mods/Void.SC2Mod'],
        ['local:json', 'Mods/Mine.SC2Mod'],
      ])
      const answer = (await context.query?.({
        kind: 'data.entities',
        refs: [{ namespace: 'Unit', entityId: 'Hero' }],
      })) as { entities: { entityId: string; parentEntityId?: string; fields: Record<string, unknown> }[] }
      expect(answer.entities).toHaveLength(1)
      expect(answer.entities[0]).toMatchObject({ entityId: 'Hero', parentEntityId: 'Trooper' })
      await context.dispose()
    } finally {
      await loader.dispose()
    }
  })
})
