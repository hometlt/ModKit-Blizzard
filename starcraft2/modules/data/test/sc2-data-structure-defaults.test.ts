/**
 * Resolved-data snapshots apply root-level structure defaults (`<SCost>` in AbilData.xml) per
 * catalog, as the lowest layer under declared and inherited values.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeStarcraft2DataAuthoringIndex,
  analyzeStarcraft2ResolvedData,
} from '../services/catalog/provider.js'

const document = (path: string, text: string) => ({
  rootId: 'fixture',
  path,
  text,
  revision: `sha256:${path}`,
})

const analyze = (documents: ReturnType<typeof document>[]) =>
  analyzeStarcraft2ResolvedData({
    workspaceId: 'workspace:structure-defaults',
    gameId: 'blizzard/starcraft-2',
    documents,
    localizationDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 4,
    maxTextBytes: 1_048_576,
    maxEntities: 256,
    maxDepth: 64,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  })

const analyzeAuthoring = (documents: ReturnType<typeof document>[]) =>
  analyzeStarcraft2DataAuthoringIndex({
    workspaceId: 'workspace:structure-defaults',
    gameId: 'blizzard/starcraft-2',
    documents,
    localizationDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 4,
    maxTextBytes: 1_048_576,
    maxEntities: 256,
    maxDepth: 64,
    maxOutputBytes: 48 * 1_024 * 1_024,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  })

const ABIL = `<Catalog>
  <SCost><Charge Link="Abil/##id##"/><Cooldown Link="Abil/##id##"/></SCost>
  <SAbilCmdButton><Flags index="AllowMinimap" value="1"/></SAbilCmdButton>
  <CAbilEffectInstant id="Blink"><CmdButtonArray index="Execute" DefaultButtonFace="Blink"/></CAbilEffectInstant>
</Catalog>`
const BEHAVIOR = `<Catalog>
  <SCost><Charge Link="Behavior/##id##" Location="Behavior"/></SCost>
  <CBehaviorBuff id="Stim"><Cost><Cooldown TimeUse="5"/></Cost></CBehaviorBuff>
</Catalog>`

describe('SC2 resolved data structure defaults', () => {
  it('applies each catalog its own defaults and keeps flag indices', async () => {
    const snapshot = await analyze([
      document('Base.SC2Data/GameData/AbilData.xml', ABIL),
      document('Base.SC2Data/GameData/BehaviorData.xml', BEHAVIOR),
    ])
    const definition = (namespace: string, entityId: string) =>
      snapshot.definitions.find(
        (item: { namespace: string; entityId: string }) =>
          item.namespace === namespace && item.entityId === entityId,
      )
    const blink = definition('Abil', 'Blink')
    expect(blink.fields.InterruptCost).toEqual({
      Charge: { Link: 'Abil/Blink' },
      Cooldown: { Link: 'Abil/Blink' },
    })
    expect(blink.fields.CmdButtonArray).toEqual([
      {
        index: 'Execute',
        value: { Flags: [{ index: 'AllowMinimap', value: 1 }], DefaultButtonFace: 'Blink' },
      },
    ])
    expect(definition('Behavior', 'Stim').fields.Cost).toEqual({
      Charge: { Link: 'Behavior/Stim', Location: 'Behavior' },
      Cooldown: { TimeUse: 5 },
    })
    expect(snapshot.diagnostics.map((item: { code: string }) => item.code)).not.toContain(
      'blizzard.starcraft2/data-catalog-element-unsupported',
    )
    expect(snapshot.definitions).toHaveLength(2)
  })

  it('keeps valid catalog context when one live authoring document is temporarily malformed', async () => {
    const snapshot = await analyze([
      document(
        'Base.SC2Data/GameData/UnitData.xml',
        '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit></Catalog>',
      ),
      document('Selected.SC2Data/GameData/ActorData.xml', '<Catalog><'),
    ])
    expect(
      snapshot.definitions.some(
        (item: { namespace: string; entityId: string }) =>
          item.namespace === 'Unit' && item.entityId === 'Marine',
      ),
    ).toBe(true)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'blizzard.starcraft2/data-document-invalid',
          source: expect.objectContaining({
            path: 'Selected.SC2Data/GameData/ActorData.xml',
          }),
        }),
      ]),
    )
  })

  it('projects merged EditorCategories metadata through the canonical snapshot owner field', async () => {
    const snapshot = await analyze([
      document(
        'Base.SC2Data/EditorData/EditorCategories.xml',
        `<EditorCategories>
          <category name="Race"><value>Terr</value><value>Prot</value></category>
          <objectUsage type="Unit"><objects><usage source="External">Race</usage></objects></objectUsage>
        </EditorCategories>`,
      ),
      document('Base.SC2Data/GameData/UnitData.xml', '<Catalog><CUnit id="Marine"/></Catalog>'),
    ])
    expect((snapshot as unknown as { ownerMetadata?: unknown }).ownerMetadata).toEqual({
      starcraft2: {
        editorCategories: {
          categories: { Race: ['Terr', 'Prot'] },
          objectUsage: {
            Unit: {
              objects: [{ source: 'External', category: 'Race' }],
              fields: [],
            },
          },
        },
      },
    })
    expect(snapshot.definitions.map(entity => entity.entityId)).toEqual(['Marine'])
  })

  it(
    'keeps default templates, inherited tokens and owner metadata in both canonical projections',
    async () => {
      const documents = [
        document(
          'Base.SC2Data/EditorData/EditorCategories.xml',
          `<EditorCategories>
            <category name="Race"><value>Terr</value></category>
            <objectUsage type="Unit"><objects><usage source="External">Race</usage></objects></objectUsage>
          </EditorCategories>`,
        ),
        document(
          'Base.SC2Data/GameData/UnitData.xml',
          `<Catalog>
            <CUnit id="Template" default="1"><?token id="Weapon" type="CWeaponLink" value="GaussRifle"?></CUnit>
            <CUnit id="Child" parent="Template"/>
          </Catalog>`,
        ),
      ]
      const [snapshot, index] = await Promise.all([analyze(documents), analyzeAuthoring(documents)])
      for (const entity of [
        snapshot.definitions.find(item => item.entityId === 'Template'),
        index.entities.find(item => item.entityId === 'Template'),
      ]) {
        expect(entity).toMatchObject({
          defaultTemplate: true,
          tokens: [{ id: 'Weapon', type: 'CWeaponLink', value: 'GaussRifle' }],
        })
      }
      for (const entity of [
        snapshot.definitions.find(item => item.entityId === 'Child'),
        index.entities.find(item => item.entityId === 'Child'),
      ]) {
        expect(entity).toMatchObject({
          tokens: [{ id: 'Weapon', type: 'CWeaponLink', value: 'GaussRifle' }],
        })
      }
      expect(index.ownerMetadata).toEqual(snapshot.ownerMetadata)
    },
  )

  it(
    'matches the full resolver for structure defaults plus inherited structured/indexed fields',
    async () => {
      const source = `<Catalog>
      <SCost><Charge Link="Abil/##id##"/><Cooldown Link="Abil/##id##"/></SCost>
      <CAbilEffectInstant id="Base">
        <Cost><Cooldown TimeUse="5"/></Cost>
        <CmdButtonArray index="Execute" DefaultButtonFace="Base"><Flags index="Hidden" value="1"/></CmdButtonArray>
      </CAbilEffectInstant>
      <CAbilEffectInstant id="Child" parent="Base">
        <Cost><Charge CountUse="2"/></Cost>
        <CmdButtonArray index="Execute"><Flags index="Hidden" removed="1"/><Flags index="Queued" value="1"/></CmdButtonArray>
      </CAbilEffectInstant>
    </Catalog>`
      const documents = [document('Base.SC2Data/GameData/AbilData.xml', source)]
      const [snapshot, index] = await Promise.all([analyze(documents), analyzeAuthoring(documents)])
      const full = snapshot.definitions.find(
        (entity: { namespace: string; entityId: string }) =>
          entity.namespace === 'Abil' && entity.entityId === 'Child',
      )
      const rows = new Map(
        index.entities.map((entity: { namespace: string; entityId: string }) => [
          `${entity.namespace}\0${entity.entityId}`,
          entity,
        ]),
      )
      const field = (entityId: string, fieldId: string): unknown => {
        const row = rows.get(`Abil\0${entityId}`) as
          | {
              parentEntityId?: string
              fields?: readonly { fieldId: string; value: unknown }[]
            }
          | undefined
        const own = row?.fields?.find(item => item.fieldId === fieldId)
        return (
          own?.value ??
          (row?.parentEntityId === undefined ? undefined : field(row.parentEntityId, fieldId))
        )
      }
      expect(field('Child', 'Cost')).toEqual(full.fields.Cost)
      expect(field('Child', 'CmdButtonArray')).toEqual(full.fields.CmdButtonArray)
      expect(field('Child', 'Cost')).toMatchObject([
        {
          index: '0',
          value: {
            Charge: { Link: 'Abil/Child', CountUse: 2 },
            Cooldown: { Link: 'Abil/Child', TimeUse: 5 },
          },
        },
      ])
      expect(
        (rows.get('Abil\0Child') as { tombstones?: readonly { path: readonly string[] }[] })
          .tombstones,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['CmdButtonArray', 'Execute', 'Flags', 'Hidden'],
          }),
        ]),
      )
      expect(index.valuesComplete).toBe(true)
    },
  )
})

describe('mergeStructureDefault', () => {
  it('merges same-index entries as records instead of recursing forever', async () => {
    const { mergeStructureDefault } = await import('../services/catalog/struct-defaults.js')
    expect(
      mergeStructureDefault(
        { index: 'Life', value: 1, Extra: 'kept' },
        { index: 'Life', value: 0 },
      ),
    ).toEqual({ index: 'Life', value: 0, Extra: 'kept' })
    expect(
      mergeStructureDefault(
        [{ index: 'A', value: 1 }],
        [{ index: 'A', value: 0 }, { index: 'B', value: 1 }],
      ),
    ).toEqual([{ index: 'A', value: 0 }, { index: 'B', value: 1 }])
  })

  it('meets a positional default list written with bare elements by slot', async () => {
    const { mergeStructureDefault } = await import('../services/catalog/struct-defaults.js')
    // Core SSoundData: <MuteFadeOut/><MuteFadeOut Time="250" Volume="-96"/>; CoreDflt Movie
    // overrides slot 1 with <MuteFadeOut index="1" Time="2000"/>.
    expect(
      mergeStructureDefault(['', { Time: '250', Volume: '-96' }], { index: '1', Time: '2000' }),
    ).toEqual(['', { Time: '2000', Volume: '-96', index: '1' }])
    // A single record stays a record even when it carries its slot.
    expect(mergeStructureDefault({ Charge: 'A' }, { index: '0', Cooldown: 'B' }))
      .toEqual({ Charge: 'A', Cooldown: 'B', index: '0' })
  })
})
