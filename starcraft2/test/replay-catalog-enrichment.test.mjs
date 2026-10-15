import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from '../modules/data/services/catalog/provider.js'
import {
  classifyResolvedReplayUnit,
  loadReplayCatalogLookups,
  replayCatalogLookups,
} from '../modules/replay/services/analysis/catalog-enrichment.js'
import { analyzeReplay } from '../modules/replay/services/analysis/index.js'

const catalog = `<Catalog>
  <CUnit id="WorkerTemplate">
    <FlagArray index="Worker" value="1"/>
    <CostResource index="Minerals" value="50"/>
    <CostResource index="Vespene" value="0"/>
  </CUnit>
  <CUnit id="SCV" parent="WorkerTemplate"/>
  <CUnit id="CommandCenter">
    <Attributes index="Structure" value="1"/>
    <CostResource index="Minerals" value="400"/>
  </CUnit>
  <CUnit id="Marine">
    <WeaponArray index="0" Link="GaussRifle"/>
    <CostResource index="Minerals" value="50"/>
  </CUnit>
  <CUnit id="Observer"/>
</Catalog>`

const analysisRequest = {
  workspaceId: 'workspace:replay-catalog',
  gameId: 'blizzard/starcraft-2',
  documents: [
    {
      rootId: 'workspace',
      path: 'Base.SC2Data/GameData/UnitData.xml',
      text: catalog,
      revision: 'sha256:replay-catalog',
    },
  ],
  localizationDocuments: [],
  locales: [],
  localizationKeys: [],
  queries: [],
  maxDocuments: 4,
  maxTextBytes: 32_768,
  maxEntities: 64,
  maxDepth: 16,
  plannedDocumentCount: 1,
  unresolvedRequirementIds: [],
}

test('resolved SC2 flags retain their index and feed Replay classification', async () => {
  const providerLease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
  try {
    const workspace = providerLease.value
    const snapshot = await workspace.analyze(analysisRequest)
    const scv = snapshot.definitions.find(item => item.namespace === 'Unit' && item.entityId === 'SCV')
    const commandCenter = snapshot.definitions.find(
      item => item.namespace === 'Unit' && item.entityId === 'CommandCenter',
    )
    assert.deepEqual(scv.fields.FlagArray, [{ index: 'Worker', value: 1 }])
    assert.deepEqual(commandCenter.fields.Attributes, [{ index: 'Structure', value: 1 }])

    const direct = replayCatalogLookups(snapshot)
    assert.deepEqual({ ...direct.unitClass }, {
      WorkerTemplate: 'worker',
      SCV: 'worker',
      CommandCenter: 'building',
      Marine: 'army',
      Observer: 'other',
    })
    assert.deepEqual({ ...direct.unitCost }, {
      WorkerTemplate: { minerals: 50, gas: 0 },
      SCV: { minerals: 50, gas: 0 },
      CommandCenter: { minerals: 400, gas: 0 },
      Marine: { minerals: 50, gas: 0 },
    })

    const throughContract = await loadReplayCatalogLookups(workspace, {
      snapshotId: snapshot.snapshotId,
      maxPageSize: 2,
      maxDefinitions: 16,
      maxUnits: 8,
    })
    assert.deepEqual(throughContract, direct)
    assert.deepEqual(throughContract.summary, {
      snapshotId: snapshot.snapshotId,
      units: 5,
      completeUnits: 5,
      pricedUnits: 4,
      complete: true,
    })
  } finally {
    await providerLease.release()
  }
})

test('Replay analysis consumes resolved catalog lookups without format coupling', async () => {
  assert.equal(
    classifyResolvedReplayUnit({
      FlagArray: [{ index: 'Worker', value: 0 }],
      WeaponArray: [{ Link: 'Gun' }],
    }),
    'army',
  )
  const providerLease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
  try {
    const snapshot = await providerLease.value.analyze(analysisRequest)
    const lookups = replayCatalogLookups(snapshot)
    const result = analyzeReplay(
      {
        header: { elapsedGameLoops: 100 },
        details: { title: 'Catalog', players: [{ name: 'Player', race: 'Terran', result: 1 }] },
        trackerEvents: [
          {
            event: 'UnitBorn',
            gameloop: 1,
            unitTag: 1,
            controlPlayerId: 1,
            unitTypeName: 'SCV',
          },
          {
            event: 'UnitBorn',
            gameloop: 2,
            unitTag: 2,
            controlPlayerId: 1,
            unitTypeName: 'CommandCenter',
          },
          {
            event: 'UnitBorn',
            gameloop: 3,
            unitTag: 3,
            controlPlayerId: 1,
            unitTypeName: 'Marine',
          },
          { event: 'UnitDied', gameloop: 50, unitTag: 3 },
        ],
      },
      lookups,
    )
    assert.equal(result.players[0].workersProduced, 1)
    assert.equal(result.players[0].buildingsProduced, 1)
    assert.equal(result.players[0].armyProduced, 1)
    assert.deepEqual(result.players[0].resourcesLost, { minerals: 50, gas: 0 })
  } finally {
    await providerLease.release()
  }
})
