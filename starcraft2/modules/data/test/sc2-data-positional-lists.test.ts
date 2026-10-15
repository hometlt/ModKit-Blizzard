/**
 * SC2 catalog lists merge by slot (running index; an explicit numeric `index="N"` resets the
 * counter), except the few MK2 appending lists. The provider emits positional lists as indexed
 * slots so the common resolver merges a child's slot into the parent's slot.
 */
import { describe, expect, it } from 'vitest'
import { analyzeStarcraft2ResolvedData } from '../services/catalog/provider.js'

const CATALOG = `<Catalog>
  <SCost><Charge Link="Abil/##id##"/></SCost>
  <CBehaviorBuff id="Base"><Modification><MoveSpeedMultiplier value="1.5"/><DamageDealtScaled index="Melee" value="0.5"/></Modification></CBehaviorBuff>
  <CBehaviorBuff id="Child" parent="Base"><Modification><AttackSpeedMultiplier value="2"/></Modification></CBehaviorBuff>
  <CAbilEffectInstant id="Parent"><CmdButtonArray index="Execute" DefaultButtonFace="Face" Requirements="Req"/><Cost><Vital index="Energy" value="50"/></Cost></CAbilEffectInstant>
  <CAbilEffectInstant id="Heir" parent="Parent"><CmdButtonArray index="Execute" DefaultButtonFace="Other"/><Cost><Cooldown TimeUse="5"/></Cost></CAbilEffectInstant>
  <CUnit id="Base"><WeaponArray Link="A"/><WeaponArray Link="B"/><GlossaryStrongArray value="X"/></CUnit>
  <CUnit id="Variant" parent="Base"><WeaponArray index="1" Link="C"/><WeaponArray Link="D"/><GlossaryStrongArray value="Y"/></CUnit>
</Catalog>`

async function resolved() {
  const snapshot = await analyzeStarcraft2ResolvedData({
    workspaceId: 'workspace:positional-lists',
    gameId: 'blizzard/starcraft-2',
    documents: [{ rootId: 'fixture', path: 'Base.SC2Data/GameData/AbilData.xml', text: CATALOG, revision: 'sha256:fixture' }],
    localizationDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 4,
    maxTextBytes: 1_048_576,
    maxEntities: 64,
    maxDepth: 64,
    plannedDocumentCount: 1,
    unresolvedRequirementIds: [],
  })
  return (namespace: string, entityId: string) =>
    snapshot.definitions.find(
      (item: { namespace: string; entityId: string }) =>
        item.namespace === namespace && item.entityId === entityId,
    )?.fields
}

describe('SC2 positional catalog lists', () => {
  it('merges list slots by running index and keeps appending lists appending', async () => {
    const fields = await resolved()
    expect(fields('Unit', 'Variant').WeaponArray).toEqual([
      { index: '0', value: { Link: 'A' } },
      { index: '1', value: { Link: 'C' } },
      { index: '2', value: { Link: 'D' } },
    ])
    expect(fields('Unit', 'Variant').GlossaryStrongArray).toEqual(['X', 'Y'])
    expect(fields('Unit', 'Variant').WeaponArray).toHaveLength(3)
    const cost = fields('Abil', 'Heir').Cost
    expect(cost).toHaveLength(1)
    expect(cost[0]).toMatchObject({
      index: '0',
      value: { Charge: { Link: 'Abil/Heir' }, Cooldown: { TimeUse: 5 } },
    })
  })

  // Catalog-engine owns deep merging for both linked and installed SDK dependencies.
  it(
    'keeps inherited sub-fields of structures, indexed slots and positional slots',
    async () => {
      const fields = await resolved()
      expect(fields('Behavior', 'Child').Modification).toEqual({
        MoveSpeedMultiplier: 1.5,
        DamageDealtScaled: [{ index: 'Melee', value: 0.5 }],
        AttackSpeedMultiplier: 2,
      })
      expect(fields('Abil', 'Heir').CmdButtonArray).toEqual([
        { index: 'Execute', value: { DefaultButtonFace: 'Other', Requirements: 'Req' } },
      ])
      expect(fields('Abil', 'Heir').Cost).toEqual([
        {
          index: '0',
          value: {
            Charge: { Link: 'Abil/Heir' },
            Vital: [{ index: 'Energy', value: 50 }],
            Cooldown: { TimeUse: 5 },
          },
        },
      ])
    },
  )
})
