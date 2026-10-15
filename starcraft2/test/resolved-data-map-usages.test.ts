import { describe, expect, it } from 'vitest'
import {
  analyzeStarcraft2ResolvedData,
  planStarcraft2DataWorkspace,
} from '../modules/data/services/catalog/provider.js'

/*
 * A map's placed objects and preload list are indexed with the data: what they name becomes a
 * relation into the catalog, so an entity lists them among its users and a name that resolves to
 * nothing is reported like any dead catalog link.
 */
const unitData = `<Catalog>
  <CUnit id="Marine"/>
  <CSound id="Boom"/>
</Catalog>`
const objects = `<PlacedObjects Version="27">
  <ObjectUnit Id="1" Position="1,2,0" UnitType="Marine" Player="1"><Texture TexSlot="0" TexProps="" TexLink="MarineSkin"/></ObjectUnit>
  <ObjectPoint Id="2" Position="0,0,0" Name="P" Sound="Boom"/>
</PlacedObjects>`
const preload = `<Preload>
  <Unit id="Marine"/>
  <Unit id="Ghost"/>
</Preload>`

describe('SC2 resolved data indexes a map\'s Objects and Preload', () => {
  it('plans the map root\'s Objects and Preload.xml as usage documents, and no other root\'s', async () => {
    const plan = await planStarcraft2DataWorkspace({
      workspace: {
        schemaVersion: 1,
        workspaceId: 'workspace:map-usages',
        gameId: 'blizzard/starcraft-2',
        complete: true,
        sources: [],
        loadOrder: [
          { rootId: 'core', sourcePath: 'mods/core.sc2mod' },
          { rootId: 'map', sourcePath: 'maps/test.sc2map' },
        ],
      },
      locales: ['enUS'],
      maxRequirements: 4096,
    })
    expect(plan.requirements.filter(item => item.kind === 'usage')).toEqual([
      expect.objectContaining({ rootId: 'map', path: 'maps/test.sc2map/objects', required: false }),
      expect.objectContaining({ rootId: 'map', path: 'maps/test.sc2map/preload.xml', required: false }),
    ])
  })

  it('turns what the map names into relations, dead when nothing declares it', async () => {
    const usageDocuments = [
      { rootId: 'map', path: 'maps/test.sc2map/objects', text: objects },
      { rootId: 'map', path: 'maps/test.sc2map/preload.xml', text: preload },
    ]
    const snapshot = await analyzeStarcraft2ResolvedData({
      workspaceId: 'workspace:map-usages',
      gameId: 'blizzard/starcraft-2',
      documents: [{ rootId: 'map', path: 'maps/test.sc2map/base.sc2data/gamedata/unitdata.xml', text: unitData }],
      localizationDocuments: [],
      usageDocuments,
      locales: [],
      localizationKeys: [],
      queries: [],
      maxDocuments: 8,
      maxTextBytes: 1_048_576,
      maxEntities: 2_048,
      maxDepth: 64,
      plannedDocumentCount: 3,
      unresolvedRequirementIds: [],
    })
    const users = (namespace: string, entityId: string) =>
      snapshot.relations
        .filter(item => item.to.namespace === namespace && item.to.entityId === entityId)
        .map(item => [`${item.from.namespace}/${item.from.entityId}`, item.role, item.dead])
    expect(users('Unit', 'Marine')).toEqual(
      expect.arrayContaining([
        ['Objects/unit/1', 'unitType', false],
        ['Preload/Unit/Marine', 'id', false],
      ]),
    )
    expect(users('Sound', 'Boom')).toEqual([['Objects/point/2', 'sound', false]])
    expect(users('Texture', 'MarineSkin')).toEqual([['Objects/unit/1', 'texLink', true]])
    expect(users('Unit', 'Ghost')).toEqual([['Preload/Unit/Ghost', 'id', true]])
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'common.data/relation-target-unavailable',
        message: 'Preload/Unit/Ghost id names unavailable Unit/Ghost',
        source: expect.objectContaining({ path: 'maps/test.sc2map/preload.xml' }),
      }),
    )
  })
})
