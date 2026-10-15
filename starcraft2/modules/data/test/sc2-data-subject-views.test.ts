import { describe, expect, it } from 'vitest'
import { parseCatalogXml } from '../shared/catalog-engine/xml/index.js'
import { entitySubjects, modOfCatalog } from '../codecs/sc2data/src/entity-cards.js'
import { entityCardFacts, entitySubjectId } from '../codecs/sc2data/src/entity-facts.js'
import { resolvedEntityViewXml } from '../codecs/sc2data/src/resolved-view.js'
import { TypedCatalog } from '../shared/catalog-engine/sc2-catalog/index.js'
import { createBuiltinRegistry } from '../shared/catalog-engine/sc2-schema/index.js'
import type { EntityCard } from '../shared/format/wiki/cards.js'

const source = { id: 'memory://subject-views.xml', uri: 'memory://subject-views.xml' } as never
const options = { snapshotId: 'subject-views:1', source }
const link = (ns: string, id: string) => ({ ns, id, label: id })

function card(): EntityCard {
  return {
    ns: 'Unit',
    id: 'Marine',
    className: 'CUnit',
    name: 'Marine',
    vitals: [{ name: 'Life', max: 45, armor: 0 }],
    attributes: [],
    fields: [{ name: 'Speed', value: '0', editable: true }],
    weapons: [{ ...link('Weapon', 'GaussRifle'), range: 5 }],
    commandCards: [
      {
        id: 'Root',
        buttons: [
          {
            id: 'TrainMarine',
            row: 1,
            col: 2,
            type: 'AbilCmd',
            face: 'TrainMarine',
            nameHtml: '<b>Train Marine</b>',
            tooltipHtml: 'Ready &amp; able',
            iconAsset: 'Assets\\Textures\\marine.dds',
            hotkey: 'M',
            abil: 'BarracksTrain',
            cost: { minerals: 50 },
            time: 18,
            produces: link('Unit', 'Marine'),
          },
        ],
      },
    ],
    producers: [
      {
        kind: 'train',
        category: 'production',
        creator: link('Abil', 'BarracksTrain'),
        path: 'InfoArray.Train1.Unit',
        triggers: [],
        routes: [{ producer: link('Unit', 'Barracks'), via: [link('Abil', 'BarracksTrain')] }],
      },
    ],
    abilities: [],
    behaviors: [],
    sounds: [],
    relationsOut: [],
    relationsIn: [],
    locales: ['enUS'],
  }
}

function catalog(xml: string): TypedCatalog {
  const value = new TypedCatalog({ schema: createBuiltinRegistry() })
  value.loadFromFiles([parseCatalogXml(xml)])
  return value
}

describe('SC2 subject-view projections (synthetic, no installed UI)', () => {
  it('retains vital write metadata only when the owner supplies a write route', async () => {
    const writable = entityCardFacts(new Map([['enUS', card()]]), {
      ...options,
      editOperation: 'edit.field',
    })
    const stats = (await writable.facts('stats', { limit: 20 })).items
    const life = stats.find(item => item.id === 'life')!
    expect(life.editable?.write?.operation).toBe('edit.field')
    expect(life.provenance[0]?.semanticPath).toEqual(['Unit', 'Marine', 'LifeMax'])
    expect(stats.find(item => item.id === 'life-armor')?.editable).toBeDefined()
    expect(stats.find(item => item.id === 'speed')).toMatchObject({
      value: 0,
      type: { kind: 'number' },
    })
    const readonly = entityCardFacts(new Map([['enUS', card()]]), options)
    for (const group of (await readonly.groups({ limit: 20 })).items) {
      expect(
        (await readonly.facts(group.id, { limit: 50 })).items.every(
          item => item.editable === undefined,
        ),
      ).toBe(true)
    }
  })

  it('keeps localized command slots, costs and navigable production owners', async () => {
    const french = card()
    french.commandCards[0]!.buttons[0]!.nameHtml = 'Former un Marine'
    const facts = entityCardFacts(
      new Map([
        ['enUS', card()],
        ['frFR', french],
      ]),
      options,
    )
    const commands = (await facts.facts('command-card', { limit: 20 })).items
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      label: 'Train Marine',
      locale: 'enUS',
      value: {
        page: 'Root',
        row: 1,
        column: 2,
        description: 'Ready & able',
        hotkey: 'M',
        icon: 'Assets/Textures/marine.dds',
        cost: { minerals: 50 },
        time: 18,
        ability: entitySubjectId('Abil', 'BarracksTrain'),
        produces: entitySubjectId('Unit', 'Marine'),
      },
    })
    expect(commands[1]).toMatchObject({ locale: 'frFR', label: 'Former un Marine' })
    // A route reads as its chain; the producer is a link among the relations below.
    expect((await facts.facts('producers', { limit: 20 })).items[0]).toMatchObject({
      label: 'BarracksTrain',
      value: ['Barracks → BarracksTrain'],
      note: expect.stringContaining('train · production · InfoArray.Train1.Unit'),
    })
    expect((await facts.relations({ limit: 50 })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'Produced by',
          subjectId: entitySubjectId('Unit', 'Barracks'),
        }),
        expect.objectContaining({
          role: 'Weapons',
          subjectId: entitySubjectId('Weapon', 'GaussRifle'),
        }),
        expect.objectContaining({
          role: 'Command buttons',
          subjectId: entitySubjectId('Button', 'TrainMarine'),
        }),
      ]),
    )
  })

  it('publishes reopenable named parents from the existing catalog chain', async () => {
    const loaded = catalog(`<Catalog>
      <CUnit default="1"><LifeArmor value="1"/></CUnit>
      <CUnit id="Infantry"><LifeMax value="40"/></CUnit>
      <CUnit id="Marine" parent="Infantry"><LifeMax value="45"/></CUnit>
    </Catalog>`)
    const selector = entitySubjects(modOfCatalog(loaded) as never, options)
    const marine = await selector.openFacts(entitySubjectId('Unit', 'Marine'))
    try {
      const parents = (await marine.value.relations({ limit: 50 })).items.filter(
        item => item.role === 'Parent chain',
      )
      expect(parents.map(item => item.subjectId)).toEqual([entitySubjectId('Unit', 'Infantry')])
      const parent = await selector.openFacts(parents[0]!.subjectId)
      try {
        expect((await parent.value.facts('stats', { limit: 20 })).items).toContainEqual(
          expect.objectContaining({ id: 'life', value: 40 }),
        )
      } finally {
        await parent.release()
      }
      expect((await marine.value.facts('overview', { limit: 20 })).items).toContainEqual(
        expect.objectContaining({
          id: 'parent-chain',
          value: ['Unit/(default)', 'Unit/Infantry', 'Unit/Marine'],
        }),
      )
    } finally {
      await marine.release()
    }
  })

  it('labels a missing parent without inventing a navigable target', async () => {
    const loaded = catalog(
      '<Catalog><CUnit id="Marine" parent="Missing"><LifeMax value="45"/></CUnit></Catalog>',
    )
    const selector = entitySubjects(modOfCatalog(loaded) as never, options)
    const marine = await selector.openFacts(entitySubjectId('Unit', 'Marine'))
    try {
      const overview = (await marine.value.facts('overview', { limit: 20 })).items
      expect(overview.find(item => item.id === 'parent-chain')?.note).toContain('missing or cyclic')
      expect(
        (await marine.value.relations({ limit: 50 })).items.filter(
          item => item.role === 'Parent chain',
        ),
      ).toEqual([])
    } finally {
      await marine.release()
    }
  })

  it('round-trips resolved nested/indexed raw fields and protects XML comments', () => {
    const loaded = catalog(`<Catalog>
      <CUnit id="Infantry"><LifeMax value="40"/></CUnit>
      <CUnit id="Marine--&amp;" parent="Infantry">
        <CostResource index="Minerals" value="50"/>
        <WeaponArray index="2" Link="Gauss&amp;Rifle"/>
        <CardLayouts><LayoutButtons index="0" Face="Attack"><Row value="1"/></LayoutButtons></CardLayouts>
      </CUnit>
    </Catalog>`)
    const fields = loaded.getResolved('Unit', 'Marine--&')!
    const xml = resolvedEntityViewXml(
      'CUnit',
      {
        namespace: 'Unit',
        id: 'Marine--&',
        fields,
        chain: ['Infantry', 'Marine--&'],
        partial: false,
      },
      'Infantry',
    )
    expect(xml).not.toContain('[object Object]')
    expect(xml).toContain('loaded catalog only')
    expect(xml).toContain('<LifeMax value="40"/>')
    expect(xml).toContain('Link="Gauss&amp;Rifle"')
    expect(xml).toContain('id="Marine--&amp;"')
    const reopened = catalog(xml)
    expect(reopened.getResolved('Unit', 'Marine--&')).toEqual(fields)
    for (const match of xml.matchAll(/<!--([\s\S]*?)-->/gu)) expect(match[1]).not.toContain('--')
  })
})
