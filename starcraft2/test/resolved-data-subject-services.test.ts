import { describe, expect, it } from 'vitest'
import { createProvider } from '../modules/data/services/catalog/provider.js'

const gameId = 'blizzard/starcraft-2'
const catalog = `<Catalog>
  <CUnit id="Marine">
    <Name value="Unit/Name/Marine"/>
    <LifeMax value="45"/>
    <WeaponArray index="0" Link="GaussRifle"/>
  </CUnit>
  <CUnit id="ComplexUnit">
    <WeaponArray index="0" Link="ComplexWeapon"/>
  </CUnit>
  <CUnit id="DoubleUnit">
    <WeaponArray index="0" Link="GaussRifle"/>
    <WeaponArray index="1" Link="GaussRifle"/>
  </CUnit>
  <CWeapon id="GaussRifle">
    <Range value="5"/>
    <Period value="0.75"/>
    <Effect Link="GaussDamage"/>
  </CWeapon>
  <CWeapon id="ComplexWeapon">
    <Period value="1"/>
    <DisplayEffect Link="GaussSet"/>
  </CWeapon>
  <CEffectDamage id="GaussDamage">
    <Amount value="6"/>
  </CEffectDamage>
  <CEffectSet id="GaussSet">
    <EffectArray value="GaussDamage"/>
  </CEffectSet>
</Catalog>`

const analysisRequest = {
  workspaceId: 'workspace:subject-services',
  gameId,
  documents: [
    {
      rootId: 'workspace',
      path: 'Base.SC2Data/GameData/TestData.xml',
      text: catalog,
      revision: 'sha256:subject-services',
    },
  ],
  localizationDocuments: [],
  locales: [],
  localizationKeys: [],
  queries: [{ namespace: 'Unit', entityId: 'Marine' }],
  maxDocuments: 4,
  maxTextBytes: 32_768,
  maxEntities: 64,
  maxDepth: 16,
  plannedDocumentCount: 1,
  unresolvedRequirementIds: [],
}

describe('StarCraft II resolved-data subject services', () => {
  it('does not publish a projection lease when cancelled while its owner loads', async () => {
    const providerLease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
    try {
      const workspace = providerLease.value
      const snapshot = await workspace.analyze(analysisRequest)
      for (const operation of ['openSchemaTree', 'openDefinitionTable', 'openLocalizationTable',
        'openRelations', 'openSubjectFacts', 'openSubjectCalculations'] as const) {
        const cancellation = new AbortController()
        const pending = workspace[operation]!({
          snapshotId: snapshot.snapshotId,
          subject: { namespace: 'Unit', entityId: 'Marine' },
          maxPageSize: 2,
          maxEntities: 64,
          maxRelations: 64,
          maxCalculations: 4,
          signal: cancellation.signal,
        })
        cancellation.abort(new Error('cancelled while loading projection'))
        await expect(pending).rejects.toThrow('cancelled while loading projection')
      }
    } finally {
      await providerLease.release()
    }
  })

  it('opens facts and strict calculations through the resolved-workspace provider', async () => {
    const providerLease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
    try {
      const workspace = providerLease.value
      expect(workspace.openSubjectFacts).toBeTypeOf('function')
      expect(workspace.openSubjectCalculations).toBeTypeOf('function')
      const snapshot = await workspace.analyze(analysisRequest)
      const commonRequest = {
        snapshotId: snapshot.snapshotId,
        subject: { namespace: 'Unit', entityId: 'Marine' },
        maxPageSize: 2,
        maxEntities: 64,
        maxCalculations: 4,
      }
      const factsLease = await workspace.openSubjectFacts({
        ...commonRequest,
        maxRelations: 64,
      })
      const calculationsLease = await workspace.openSubjectCalculations(commonRequest)
      try {
        expect(await factsLease.value.summary()).toMatchObject({
          snapshotId: snapshot.snapshotId,
          completeness: { bounds: { maxCalculations: 4 } },
        })
        const summary = await calculationsLease.value.summary()
        expect(summary).toEqual({
          snapshotId: snapshot.snapshotId,
          subjectId: 'Unit/Marine',
          totalCalculations: 1,
          completeness: 'complete',
        })
        const page = await calculationsLease.value.calculations({ limit: 1 })
        expect(page.items).toEqual([
          expect.objectContaining({
            id: 'weapon-0-simple-dps',
            status: 'computed',
            value: 8,
            rawValue: 8,
            unit: 'damage-per-game-second',
            formula: {
              id: 'blizzard.starcraft2/simple-weapon-dps',
              name: 'StarCraft II simple displayed weapon DPS',
              version: '1.0.0',
              expression: 'damage * attacks / period',
            },
            knowledgeTarget: {
              kind: 'concept',
              ecosystem: 'starcraft-2',
              conceptId: 'simple-weapon-dps',
            },
          }),
        ])
        expect(page.items[0]?.inputs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'damage', state: 'resolved', value: 6 }),
            expect.objectContaining({ id: 'attacks', state: 'defaulted', value: 1 }),
            expect.objectContaining({ id: 'period', state: 'resolved', value: 0.75 }),
          ]),
        )
        expect(page.items[0]?.provenance.length).toBeGreaterThan(0)
      } finally {
        await Promise.all([factsLease.release(), calculationsLease.release()])
      }
    } finally {
      await providerLease.release()
    }
  })

  it('keeps indirect effect chains unsupported and requires the public maxCalculations bound', async () => {
    const providerLease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
    try {
      const workspace = providerLease.value
      const snapshot = await workspace.analyze(analysisRequest)
      const request = {
        snapshotId: snapshot.snapshotId,
        subject: { namespace: 'Unit', entityId: 'ComplexUnit' },
        maxPageSize: 2,
        maxEntities: 64,
        maxCalculations: 4,
      }
      const lease = await workspace.openSubjectCalculations(request)
      try {
        expect(await lease.value.summary()).toMatchObject({
          completeness: 'partial',
          reason: expect.stringContaining('unsupported'),
        })
        const page = await lease.value.calculations({ limit: 2 })
        expect(page.items[0]).toMatchObject({
          status: 'unsupported',
          inputs: expect.arrayContaining([
            expect.objectContaining({ id: 'damage', state: 'unsupported' }),
          ]),
          warnings: expect.arrayContaining([
            expect.objectContaining({
              code: 'blizzard.starcraft2/calculation-effect-chain-unsupported',
            }),
          ]),
        })
        expect(page.items[0]).not.toHaveProperty('value')
      } finally {
        await lease.release()
      }
      await expect(
        workspace.openSubjectCalculations({
          snapshotId: snapshot.snapshotId,
          subject: { namespace: 'Unit', entityId: 'Marine' },
          maxPageSize: 2,
          maxEntities: 64,
          maxWeapons: 1,
        }),
      ).rejects.toThrow('maxCalculations')
      await expect(
        workspace.openSubjectFacts({
          snapshotId: snapshot.snapshotId,
          subject: { namespace: 'Unit', entityId: 'Marine' },
          maxPageSize: 2,
          maxEntities: 64,
          maxRelations: 64,
          maxWeapons: 1,
        }),
      ).rejects.toThrow('maxCalculations')

      const cappedLease = await workspace.openSubjectCalculations({
        snapshotId: snapshot.snapshotId,
        subject: { namespace: 'Unit', entityId: 'DoubleUnit' },
        maxPageSize: 2,
        maxEntities: 64,
        maxCalculations: 1,
      })
      try {
        expect(await cappedLease.value.summary()).toMatchObject({
          totalCalculations: 1,
          completeness: 'capped',
        })
        expect((await cappedLease.value.calculations({ limit: 2 })).items).toHaveLength(1)
      } finally {
        await cappedLease.release()
      }
    } finally {
      await providerLease.release()
    }
  })
})
