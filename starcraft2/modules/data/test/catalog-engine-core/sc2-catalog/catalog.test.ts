import { describe, it, expect, beforeEach } from 'vitest'
import { TypedCatalog } from '../../../shared/catalog-engine/sc2-catalog/catalog.js'
import { createBuiltinRegistry } from '../../../shared/catalog-engine/sc2-schema'
import type { ParsedCatalogFile } from '../../../shared/catalog-engine/xml/index.js'

function makeFile(
  entries: Record<string, { id: string; parent?: string; default?: string; fields: Record<string, unknown> }[]>,
): ParsedCatalogFile {
  const map = new Map<string, ReturnType<typeof makeEntry>[]>()
  for (const [type, list] of Object.entries(entries)) {
    map.set(
      type,
      list.map(e => ({ ...makeEntry(type, e.id, e.fields, e.parent), ...(e.default === undefined ? {} : { default: e.default }) })),
    )
  }
  return { rootTypes: Object.keys(entries), entries: map }
}

function makeEntry(type: string, id: string, fields: Record<string, unknown>, parent?: string) {
  return { type, id, parent, fields: fields as Record<string, import('../../../shared/catalog-engine/xml/index.js').RawValue> }
}

describe('TypedCatalog', () => {
  let catalog: TypedCatalog

  beforeEach(() => {
    catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  })

  it('stores entities and retrieves by namespace + id', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '45' } }],
      }),
    ])

    const entity = catalog.get('Unit', 'Marine')
    expect(entity).toBeDefined()
    expect(entity?.id).toBe('Marine')
    expect(entity?.class).toBe('CUnit')
    expect(entity?.namespace).toBe('Unit')
  })

  it('resolves inheritance — child overrides parent scalar', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Base', fields: { LifeMax: '100', Armor: '1' } },
          { id: 'Marine', parent: 'Base', fields: { LifeMax: '45' } },
        ],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    expect(resolved?.['LifeMax']).toBe('45') // child overrides
    expect(resolved?.['Armor']).toBe('1') // inherited from parent
  })

  it('names the declaration that supplied each resolved field, patches and parents included', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Base', fields: { LifeMax: '100', Armor: '1' } },
          { id: 'Marine', parent: 'Base', fields: { LifeMax: '45', Speed: '2.25' } },
        ],
      }),
    ], { mod: 'Core.SC2Mod' })
    catalog.loadFromFiles([
      makeFile({ CUnit: [{ id: 'Marine', fields: { Speed: '3.15' } }] }),
    ], { mod: 'Liberty.SC2Mod' })

    const sources = catalog.getResolvedSources('Unit', 'Marine')
    expect(Object.keys(sources ?? {}).sort()).toEqual(Object.keys(catalog.getResolved('Unit', 'Marine') ?? {}).sort())
    expect(sources?.['LifeMax']?.mod).toBe('Core.SC2Mod')
    expect(sources?.['Armor']?.mod).toBe('Core.SC2Mod')
    expect(sources?.['Speed']?.mod).toBe('Liberty.SC2Mod')
    expect(catalog.getResolvedSources('Unit', 'Missing')).toBeUndefined()
  })

  it('inherits the template of its own class, not another class of the namespace', () => {
    catalog.loadFromFiles([
      makeFile({
        CActorModel: [{ id: '', default: '1', fields: { FogVisibility: 'Snapshot' } }],
        CActorSound: [{ id: '', default: '1', fields: { FogVisibility: 'Visible', Model: 'Leaked' } }],
      }),
      makeFile({ CActorModel: [{ id: 'Impact', fields: { Model: 'Impact' } }] }),
    ], { mod: 'Core.SC2Mod' })

    const resolved = catalog.getResolved('Actor', 'Impact')
    expect(resolved?.['FogVisibility']).toBe('Snapshot')
    expect(resolved?.['Model']).toBe('Impact')
    expect(catalog.getResolvedSources('Actor', 'Impact')?.['FogVisibility']?.mod).toBe('Core.SC2Mod')
  })

  it('substitutes the built-in id and keeps the placeholders of an abstract template', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Base', default: '1', fields: { Link: 'Unit/##id##/$id', Custom: '##icon##', NotId: '$identity' } },
          { id: 'Marine', parent: 'Base', fields: {} },
        ],
      }),
    ])
    expect(catalog.getResolved('Unit', 'Marine')).toMatchObject({
      Link: 'Unit/Marine/Marine', Custom: '##icon##', NotId: '$identity',
    })
    expect(catalog.getResolved('Unit', 'Base')).toMatchObject({ Link: 'Unit/##id##/$id' })
  })

  it('takes no template from an id-less declaration without default="1"', () => {
    // Liberty's `<CLight parent="default">` is NoLight with its id missing, not the CLight template.
    catalog.loadFromFiles([
      makeFile({
        CLight: [
          { id: 'default', default: '1', fields: { TimePerDay: '24:00:00' } },
          { id: '', parent: 'default', fields: { ToDInfoArray: { AmbientColor: '0,0,0' } } },
          { id: 'DefaultLight', fields: { EditorCategories: 'LightGroup:UI' } },
        ],
      }),
    ])
    expect(catalog.getResolved('Light', 'DefaultLight')).toEqual({ EditorCategories: 'LightGroup:UI' })
  })

  it('expands $constants in values, a constant naming another included', () => {
    catalog.loadFromFiles([
      makeFile({
        CConst: [
          { id: '$Sheet', fields: { value: 'sheet17' } },
          { id: '$Portraits17', fields: { value: 'ui_$Sheet.dds' } },
        ],
        CReward: [{ id: 'Hero', fields: { IconFile: '$Portraits17' } }],
      }),
    ])

    expect(catalog.getResolved('Reward', 'Hero')?.['IconFile']).toBe('ui_sheet17.dds')
  })

  it('resolves inheritance — entity without parent returns own data', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Standalone', fields: { LifeMax: '200' } }],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Standalone')
    expect(resolved?.['LifeMax']).toBe('200')
  })

  it('resolves multi-level parent chain', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Root', fields: { LifeMax: '100', Armor: '0', Speed: '2.25' } },
          { id: 'Mid', parent: 'Root', fields: { Armor: '1' } },
          { id: 'Child', parent: 'Mid', fields: { LifeMax: '45' } },
        ],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Child')
    expect(resolved?.['LifeMax']).toBe('45') // from Child
    expect(resolved?.['Armor']).toBe('1') // from Mid
    expect(resolved?.['Speed']).toBe('2.25') // from Root
  })

  it('handles dangling parent reference gracefully', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', parent: 'NonExistent', fields: { LifeMax: '45' } }],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    expect(resolved?.['LifeMax']).toBe('45')
  })

  it('expands parent-chain <?token?> declarations with child-supplied attribute values', () => {
    // SC2 actor templating: the template declares <?token id="icon" value="Default"?>
    // and references ##icon## in fields; a derived actor supplies the value via a
    // like-named attribute (parsed into fields): <CActorUnit id="NodMilitant"
    // icon="Militant" parent="NodInfantry"/>.
    const file = makeFile({
      CActorUnit: [
        { id: 'NodInfantry', fields: { UnitIcon: 'Assets\\icons\\btn-unit-##icon##.dds' } },
        { id: 'NodMilitant', parent: 'NodInfantry', fields: { icon: 'Militant' } },
      ],
    })
    // Attach the token decl to the template entry (parser emits `tokens`).
    const entries = file.entries.get('CActorUnit')!
    ;(entries[0] as { tokens?: unknown }).tokens = [{ id: 'icon', value: 'Default' }]
    catalog.loadFromFiles([file])

    // Child: attribute value fills the inherited ##icon## reference.
    expect(catalog.getResolved('Actor', 'NodMilitant')?.['UnitIcon']).toBe(
      'Assets\\icons\\btn-unit-Militant.dds',
    )
    // Template itself: decl default applies.
    expect(catalog.getResolved('Actor', 'NodInfantry')?.['UnitIcon']).toBe(
      'Assets\\icons\\btn-unit-Default.dds',
    )
  })

  it('merges indexed arrays from parent chain', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          {
            id: 'Base',
            fields: {
              WeaponArray: [
                { index: '0', Link: 'Gauss' },
                { index: '1', Link: 'Cannon' },
              ],
            },
          },
          {
            id: 'Marine',
            parent: 'Base',
            fields: {
              WeaponArray: [
                { index: '0', Link: 'ImpaleRound' }, // override index 0
                { index: '2', Link: 'NewWeapon' }, // add index 2
              ],
            },
          },
        ],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    const weapons = resolved?.['WeaponArray'] as Array<Record<string, string>>
    expect(weapons).toHaveLength(3)
    expect(weapons.find(w => w['index'] === '0')?.['Link']).toBe('ImpaleRound')
    expect(weapons.find(w => w['index'] === '1')?.['Link']).toBe('Cannon')
    expect(weapons.find(w => w['index'] === '2')?.['Link']).toBe('NewWeapon')
  })

  it('applies indexed overrides to a SCALAR-valued parent array', () => {
    // Real shape from tiberium-crossover: the parent lists values positionally
    // (`<TechTreeProducedUnitArray value="NodRaider"/>` …), and the child replaces
    // individual slots by index, blanking the ones it does not want. Without slot
    // alignment the child's entries append instead, so the building shows the parent's
    // whole production list plus a row of `[object Object]`.
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          {
            id: 'WarFactory',
            fields: { TechTreeProducedUnitArray: ['Raider', 'Bike', 'Scorpion'] },
          },
          {
            id: 'RedeemerFacility',
            parent: 'WarFactory',
            fields: {
              TechTreeProducedUnitArray: [
                { index: '0', value: 'Redeemer' },
                { index: '1', value: '' },
                { index: '2', value: '' },
              ],
            },
          },
        ],
      }),
    ])

    expect(catalog.getResolved('Unit', 'RedeemerFacility')?.['TechTreeProducedUnitArray']).toEqual([
      'Redeemer',
      '',
      '',
    ])
    // The parent is untouched.
    expect(catalog.getResolved('Unit', 'WarFactory')?.['TechTreeProducedUnitArray']).toEqual([
      'Raider',
      'Bike',
      'Scorpion',
    ])
  })

  it('keeps an indexed override past the end of a scalar parent array in its own slot', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Base', fields: { TechTreeProducedUnitArray: ['A'] } },
          {
            id: 'Derived',
            parent: 'Base',
            fields: { TechTreeProducedUnitArray: [{ index: '2', value: 'C' }] },
          },
        ],
      }),
    ])

    // Slot 1 stays empty: a bare 'C' would read as slot 1.
    expect(catalog.getResolved('Unit', 'Derived')?.['TechTreeProducedUnitArray']).toEqual([
      'A',
      { index: '2', value: 'C' },
    ])
  })

  it('substitutes $Token in field values', () => {
    catalog.loadFromFiles([
      makeFile({
        CConst: [{ id: 'MarineLife', fields: { value: '45' } }],
        CUnit: [{ id: 'Marine', fields: { LifeMax: '$MarineLife' } }],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    expect(resolved?.['LifeMax']).toBe('45')
  })

  it('substitutes ##Token## in field values', () => {
    catalog.loadFromFiles([
      makeFile({
        CConst: [{ id: 'DefaultArmor', fields: { value: '2' } }],
        CUnit: [{ id: 'Tank', fields: { Armor: '##DefaultArmor##' } }],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Tank')
    expect(resolved?.['Armor']).toBe('2')
  })

  it('leaves unknown tokens untouched', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '$UnknownToken' } }],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    expect(resolved?.['LifeMax']).toBe('$UnknownToken')
  })

  it('TypedNamespace proxy — indexed access', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '45' } }],
      }),
    ])

    const units = catalog.namespace<{ LifeMax: string }>('Unit')
    expect(units['Marine']?.['LifeMax']).toBe('45')
  })

  it('TypedNamespace proxy — get() method', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '45' } }],
      }),
    ])

    const units = catalog.namespace<{ LifeMax: string }>('Unit')
    expect(units.get('Marine')?.['LifeMax']).toBe('45')
    expect(units.get('NonExistent')).toBeUndefined()
  })

  it('TypedNamespace proxy — all(), size, keys()', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Marine', fields: { LifeMax: '45' } },
          { id: 'Marauder', fields: { LifeMax: '125' } },
        ],
      }),
    ])

    const units = catalog.namespace<Record<string, string>>('Unit')
    expect(units.size).toBe(2)
    expect(units.all()).toHaveLength(2)
    expect(Array.from(units.keys())).toContain('Marine')
  })

  it('merges duplicate entries within a single loadFromFiles call', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Marine', fields: { LifeMax: '45', Armor: '0' } },
          { id: 'Marine', fields: { Armor: '1' } }, // patch
        ],
      }),
    ])

    const resolved = catalog.getResolved('Unit', 'Marine')
    expect(resolved?.['LifeMax']).toBe('45') // from first
    expect(resolved?.['Armor']).toBe('1') // patched by second
  })

  it('cache is invalidated after loadFromFiles', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '45' } }],
      }),
    ])

    expect(catalog.getResolved('Unit', 'Marine')?.['LifeMax']).toBe('45')

    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '50' } }],
      }),
    ])

    expect(catalog.getResolved('Unit', 'Marine')?.['LifeMax']).toBe('50')
  })

  it('all() returns raw entities for namespace', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [
          { id: 'Marine', fields: {} },
          { id: 'Marauder', fields: {} },
        ],
      }),
    ])

    expect(catalog.all('Unit')).toHaveLength(2)
    expect(catalog.all('Abil')).toHaveLength(0)
  })

  it('namespaces() lists loaded namespaces', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: {} }],
        CAbilEffect: [{ id: 'Stimpack', fields: {} }],
      }),
    ])

    expect(catalog.namespaces()).toContain('Unit')
    expect(catalog.namespaces()).toContain('Abil')
  })

  it('clear() removes all data', () => {
    catalog.loadFromFiles([
      makeFile({
        CUnit: [{ id: 'Marine', fields: { LifeMax: '45' } }],
      }),
    ])
    catalog.clear()

    expect(catalog.get('Unit', 'Marine')).toBeUndefined()
    expect(catalog.namespaces()).toHaveLength(0)
  })
})

describe('TypedCatalog path-scoped constants', () => {
  it('keeps every path a constant id aliases, even though constants merge by id', async () => {
    const { parseCatalogXml } = await import('../../../shared/catalog-engine/xml/index.js')
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([
      parseCatalogXml(`<Catalog>
        <const id="air" path="CAbilEffectInstant.TargetFilters" value="Air"/>
        <const id="air" path="CWeaponLegacy.TargetFilters" value="Air"/>
        <const id="Ground" path="CUnit.Collide.index" value="Land2"/>
      </Catalog>`),
    ])
    expect(catalog.hasConstAlias('CAbilEffectInstant.TargetFilters', 'air')).toBe(true)
    expect(catalog.hasConstAlias('CWeaponLegacy.TargetFilters', 'air')).toBe(true)
    expect(catalog.hasConstAlias('CUnit.Collide.index', 'Ground')).toBe(true)
    expect(catalog.hasConstAlias('CUnit.Collide.index', 'air')).toBe(false)
    catalog.clear()
    expect(catalog.hasConstAlias('CUnit.Collide.index', 'Ground')).toBe(false)
  })
})
