import { describe, expect, it } from 'vitest'
import { TypedCatalog, type CatalogEntity } from '../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../shared/catalog-engine/sc2-schema'
import { parseCatalogXml } from '../../shared/catalog-engine/xml/index.js'
import { extractSubtree, type CatalogExtractRelation, type CatalogExtractRelationGraph } from '../../shared/format/extract.js'
import { Filter } from '../../shared/format/filter.js'
import { flatten } from '../../shared/format/flatten.js'
import { toRelationGraphView } from '../../shared/format/graph-view.js'
import { findCatalogUnitProducers } from '../../shared/format/producers.js'
import { buildCatalogRelations } from '../../shared/format/relations.js'

const CATALOG_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CActorUnit id="GenericAttackBase" default="1">
    <?token id="effectImpact" type="CEffectLink"?>
    <On Terms="Effect.##effectImpact##.Start" Send="Create $effectImpact"/>
  </CActorUnit>
  <CActorUnit id="MarauderAttack" parent="GenericAttackBase" unitName="Marauder">
    <effectImpact value="PunisherU"/>
    <Missile value="MarauderMissile"/>
  </CActorUnit>
  <CSound id="MarauderSound">
    <unitSound value="Marauder"/>
    <AssetArray value="Sound/Marauder/Attack"/>
  </CSound>
  <CUnit id="ParentUnit"/>
  <CUnit id="SeedUnit" parent="ParentUnit"><WeaponArray Link="SeedWeapon"/></CUnit>
  <CWeaponLegacy id="SeedWeapon"><DisplayEffect value="IncomingEffect"/></CWeaponLegacy>
  <CEffectDamage id="IncomingEffect"/>
</Catalog>`

function makeCatalog(): TypedCatalog {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([parseCatalogXml(CATALOG_XML)], { mod: 'Fixture.SC2Mod' })
  return catalog
}

function relation(from: CatalogEntity, to: CatalogEntity): CatalogExtractRelation {
  return { from, to }
}

function makeGraph(relations: CatalogExtractRelation[]): CatalogExtractRelationGraph {
  return {
    outgoing(namespace, id) {
      return relations.filter(edge => edge.from.namespace === namespace && edge.from.id === id)
    },
    incoming(namespace, id) {
      return relations.filter(edge => edge.to.namespace === namespace && edge.to.id === id)
    },
  }
}

describe('SC2 catalog operations consolidated from @modkitx/ops', () => {
  it('filters entities through the structural catalog surface', () => {
    const catalog = makeCatalog()

    expect(Filter.byNamespace(catalog, 'Unit').map(entity => entity.id)).toEqual([
      'ParentUnit',
      'SeedUnit',
    ])
    expect(Filter.byPrefix(catalog, 'Unit', 'Seed').map(entity => entity.id)).toEqual(['SeedUnit'])
    expect(Filter.byClass(catalog, 'Weapon', 'CWeaponLegacy').map(entity => entity.id)).toEqual([
      'SeedWeapon',
    ])
    expect(Filter.fromMod(catalog, 'Unit', 'Fixture.SC2Mod')).toHaveLength(2)
  })

  it('flattens Actor and Sound data without requiring an SC2Mod container', () => {
    const catalog = makeCatalog()
    const result = flatten(catalog)

    const actor = catalog.get('Actor', 'MarauderAttack')!
    expect(actor.parent).toBeUndefined()
    expect(actor.data['effectImpact']).toBeUndefined()
    expect(actor.data['unitName']).toBe('Marauder')
    expect(actor.data['Missile']).toBe('MarauderMissile')
    // The complete schema identifies On and AssetArray as arrays even for one XML element.
    expect(actor.data['On']).toEqual([{
      Terms: 'Effect.PunisherU.Start',
      Send: 'Create PunisherU',
    }])

    const sound = catalog.get('Sound', 'MarauderSound')!
    expect(sound.data['unitSound']).toBeUndefined()
    expect(sound.data['AssetArray']).toEqual(['Sound/Marauder/Attack'])
    expect(result).toMatchObject({ entitiesFlattened: 2, parentsRemoved: 1 })
  })

  it('extracts outgoing, parent, and optional incoming catalog dependencies', () => {
    const catalog = makeCatalog()
    const seed = catalog.get('Unit', 'SeedUnit')!
    const weapon = catalog.get('Weapon', 'SeedWeapon')!
    const incoming = catalog.get('Effect', 'IncomingEffect')!
    const graph = makeGraph([relation(seed, weapon), relation(incoming, seed)])

    expect(
      extractSubtree(catalog, graph, [seed]).map(entity => `${entity.namespace}/${entity.id}`),
    ).toEqual(['Unit/ParentUnit', 'Unit/SeedUnit', 'Weapon/SeedWeapon'])

    expect(
      extractSubtree(catalog, graph, [seed], { includeIncoming: true }).map(
        entity => `${entity.namespace}/${entity.id}`,
      ),
    ).toEqual(['Effect/IncomingEffect', 'Unit/ParentUnit', 'Unit/SeedUnit', 'Weapon/SeedWeapon'])

    expect(
      extractSubtree(catalog, graph, [seed], { excludeNamespaces: ['Weapon'] }).map(
        entity => `${entity.namespace}/${entity.id}`,
      ),
    ).toEqual(['Unit/ParentUnit', 'Unit/SeedUnit'])
  })

  it('builds and projects schema-driven catalog relations without mod-level composition', () => {
    const catalog = makeCatalog()
    const graph = buildCatalogRelations(catalog)

    expect(graph.outgoing('Unit', 'SeedUnit')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: expect.objectContaining({ namespace: 'Weapon', id: 'SeedWeapon' }),
          path: 'WeaponArray.0.Link',
        }),
      ]),
    )
    expect(graph.incoming('Effect', 'IncomingEffect')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ namespace: 'Weapon', id: 'SeedWeapon' }),
          path: 'DisplayEffect',
        }),
      ]),
    )

    const view = toRelationGraphView(graph, {
      ns: 'Unit',
      id: 'SeedUnit',
      depth: 2,
      direction: 'out',
    })
    expect(view.nodes.map(node => `${node.ns}/${node.id}`)).toEqual(
      expect.arrayContaining(['Unit/SeedUnit', 'Weapon/SeedWeapon', 'Effect/IncomingEffect']),
    )
  })

  it('finds catalog-owned Unit production routes without reading Trigger XML', () => {
    const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
    catalog.loadFromFiles([
      parseCatalogXml(`<?xml version="1.0" encoding="utf-8"?>
        <Catalog>
          <CUnit id="Marine"/>
          <CUnit id="Barracks"><AbilArray Link="BarracksTrain"/></CUnit>
          <CAbilTrain id="BarracksTrain">
            <InfoArray index="Train1" Unit="Marine"/>
          </CAbilTrain>
          <CUnit id="Caster"><AbilArray Link="SummonMarine"/></CUnit>
          <CAbilEffectInstant id="SummonMarine">
            <Effect index="0" value="SpawnMarine"/>
          </CAbilEffectInstant>
          <CEffectCreateUnit id="SpawnMarine"><SpawnUnit value="Marine"/></CEffectCreateUnit>
        </Catalog>`),
    ])

    const producers = findCatalogUnitProducers(catalog, 'Marine')
    expect(producers.map(item => `${item.kind}:${item.creator.id}`)).toEqual(
      expect.arrayContaining(['train:BarracksTrain', 'create-unit:SpawnMarine']),
    )
    expect(
      producers.find(item => item.creator.id === 'BarracksTrain')?.routes[0]?.producer.id,
    ).toBe('Barracks')
    expect(
      producers
        .find(item => item.creator.id === 'SpawnMarine')
        ?.routes[0]?.chain.map(item => item.from.id),
    ).toEqual(['Caster', 'SummonMarine', 'SpawnMarine'])
    expect(producers.find(item => item.creator.id === 'SpawnMarine')?.upstream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: 'Effect', id: 'SpawnMarine' }),
        expect.objectContaining({ namespace: 'Abil', id: 'SummonMarine' }),
      ]),
    )
  })
})
