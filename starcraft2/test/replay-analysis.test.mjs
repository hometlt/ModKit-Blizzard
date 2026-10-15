import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPLAY_LOOPS_PER_SECOND,
  analyzeReplay,
} from '../modules/replay/services/analysis/index.js'

const stats = overrides => ({
  mineralsCurrent: 100,
  vespeneCurrent: 50,
  mineralsCollectionRate: 800,
  vespeneCollectionRate: 200,
  foodUsed: 10,
  foodMade: 10,
  workersActiveCount: 8,
  mineralsUsedCurrentArmy: 25,
  vespeneUsedCurrentArmy: 0,
  ...overrides,
})

test('analyzeReplay derives bounded source-independent replay summaries', () => {
  const result = analyzeReplay(
    {
      header: { elapsedGameLoops: 448 },
      details: {
        title: 'Synthetic Arena',
        players: [
          { name: 'Alpha', race: 'Terran', result: 1 },
          { name: 'Beta', race: 'Zerg', result: 2 },
        ],
      },
      trackerEvents: [
        { event: 'PlayerStats', gameloop: 0, playerId: 1, stats: stats() },
        {
          event: 'UnitBorn',
          gameloop: 10,
          unitTag: 100,
          controlPlayerId: 1,
          unitTypeName: 'Marine',
        },
        {
          event: 'UnitBorn',
          gameloop: 20,
          unitTag: 200,
          controlPlayerId: 2,
          unitTypeName: 'Zergling',
        },
        { event: 'UnitDied', gameloop: 100, unitTag: 100, killerPlayerId: 2 },
        { event: 'UnitDied', gameloop: 120, unitTag: 200, killerPlayerId: 1 },
        {
          event: 'PlayerStats',
          gameloop: 224,
          playerId: 1,
          stats: stats({ foodUsed: 11, foodMade: 15 }),
        },
      ],
      gameEvents: [
        { _event: 'NNet.Game.SCameraUpdateEvent', _gameloop: 0, _userid: { m_userId: 0 } },
        { _event: 'NNet.Game.SCmdEvent', _gameloop: 22, _userid: { m_userId: 0 } },
        { _event: 'NNet.Game.SCameraUpdateEvent', _gameloop: 224, _userid: { m_userId: 0 } },
        { _event: 'NNet.Game.SCmdEvent', _gameloop: 246, _userid: { m_userId: 0 } },
      ],
      messageEvents: [
        {
          _event: 'NNet.Game.SChatMessage',
          _gameloop: 112,
          _userid: { m_userId: 0 },
          m_string: new TextEncoder().encode('gg'),
        },
      ],
      initData: {
        m_syncLobbyState: {
          m_userInitialData: [{ m_scaledRating: 4321 }, { m_scaledRating: 4000 }],
        },
      },
    },
    {
      unitClass: { Marine: 'army', Zergling: 'army' },
      unitCost: {
        Marine: { minerals: 50, gas: 0 },
        Zergling: { minerals: 25, gas: 0 },
      },
    },
  )

  assert.equal(REPLAY_LOOPS_PER_SECOND, 22.4)
  assert.equal(result.map, 'Synthetic Arena')
  assert.equal(result.durationSeconds, 20)
  assert.equal(result.winner, 1)
  assert.equal(result.players[0].unitsProduced, 1)
  assert.equal(result.players[0].armyProduced, 1)
  assert.equal(result.players[0].unitsLost, 1)
  assert.equal(result.players[0].unitsKilled, 1)
  assert.deepEqual(result.players[0].resourcesLost, { minerals: 50, gas: 0 })
  assert.deepEqual(result.players[0].resourcesKilled, { minerals: 25, gas: 0 })
  assert.equal(result.players[0].mmr, 4321)
  assert.equal(result.players[0].supplyBlockSeconds, 10)
  assert.deepEqual(result.players[0].buildOrder, [
    { gameloop: 10, time: '0:00', name: 'Marine', supply: 10 },
  ])
  assert.equal(result.timeline.length, 2)
  assert.equal(result.engagements.length, 1)
  assert.equal(result.engagements[0].totalDeaths, 2)
  assert.deepEqual(result.chat, [{ gameloop: 112, time: '0:05', userId: 0, message: 'gg' }])
  assert.equal(result.players[0].cameraMoves, 2)
  assert.equal(result.players[0].pac, 2)
})

test('analyzeReplay enforces the build-order bound', () => {
  const input = {
    header: { elapsedGameLoops: 1 },
    details: { title: 'Bound', players: [{ name: 'A', race: 'T', result: 1 }] },
    trackerEvents: [
      { event: 'UnitBorn', gameloop: 0, unitTag: 1, controlPlayerId: 1, unitTypeName: 'A' },
      { event: 'UnitBorn', gameloop: 1, unitTag: 2, controlPlayerId: 1, unitTypeName: 'B' },
    ],
  }
  assert.equal(analyzeReplay(input, { buildOrderLimit: 1 }).players[0].buildOrder.length, 1)
  assert.throws(() => analyzeReplay(input, { buildOrderLimit: 10_001 }), RangeError)
  assert.throws(
    () => analyzeReplay(input, { unitClass: { A: 'vehicle' } }),
    /supported unit class/u,
  )
  assert.throws(
    () => analyzeReplay(input, { unitCost: { A: { minerals: -1, gas: 0 } } }),
    /non-negative finite/u,
  )
})
