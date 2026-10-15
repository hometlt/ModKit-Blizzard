import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ReplayScene,
  buildControlTimeline,
  buildReplayTimeline,
  hudStateAt,
  selectionAt,
  unitPositionAt,
} from '../starcraft2/modules/replay/services/timeline/index.js'

const tag = index => index * 2 ** 18 + 1
const born = (gameloop, index, x, y) => ({
  gameloop, eventid: 1, event: 'UnitBorn', unitTagIndex: index, unitTagRecycle: 1,
  unitTag: tag(index), unitTypeName: 'Marine', controlPlayerId: 1, upkeepPlayerId: 1, x, y,
})

test('tracker timeline interpolates positions and handles recycled unit indices', () => {
  const timeline = buildReplayTimeline([
    born(0, 5, 0, 0),
    { gameloop: 100, eventid: 8, event: 'UnitPositions', firstUnitIndex: 5, units: [{ unitIndex: 5, x: 20, y: 10 }] },
    { gameloop: 150, eventid: 2, event: 'UnitDied', unitTagIndex: 5, unitTagRecycle: 1, unitTag: tag(5), x: 30, y: 10 },
    { ...born(160, 5, 40, 40), unitTagRecycle: 2, unitTag: 5 * 2 ** 18 + 2 },
  ])
  assert.deepEqual(unitPositionAt(timeline.units[0], 50), [10, 5])
  assert.equal(timeline.units.length, 2)
  assert.equal(timeline.units[1].samples[1], 40)
})

test('scene sampling is deterministic across arbitrary seeks', () => {
  const timeline = buildReplayTimeline([
    born(0, 1, 0, 0),
    born(20, 2, 100, 100),
    { gameloop: 100, eventid: 8, event: 'UnitPositions', firstUnitIndex: 1, units: [{ unitIndex: 1, x: 40, y: 0 }] },
    { gameloop: 150, eventid: 2, event: 'UnitDied', unitTagIndex: 2, unitTagRecycle: 1, unitTag: tag(2), x: 100, y: 100 },
  ])
  const reused = new ReplayScene(timeline)
  reused.sampleAt(149)
  reused.sampleAt(10)
  const frame = reused.sampleAt(50)
  const snapshot = { count: frame.count, tags: [...frame.tags.slice(0, frame.count)], positions: [...frame.positions.slice(0, frame.count * 2)] }
  const fresh = new ReplayScene(timeline).sampleAt(50)
  assert.deepEqual(snapshot, { count: fresh.count, tags: [...fresh.tags.slice(0, fresh.count)], positions: [...fresh.positions.slice(0, fresh.count * 2)] })
})

test('control timeline reconstructs player selection and HUD at an arbitrary loop', () => {
  const timeline = buildReplayTimeline([
    { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 1, type: 1, userId: 0 },
    {
      gameloop: 5,
      eventid: 0,
      event: 'PlayerStats',
      playerId: 1,
      stats: {
        mineralsCurrent: 75,
        vespeneCurrent: 25,
        mineralsCollectionRate: 600,
        vespeneCollectionRate: 120,
        foodUsed: 14,
        foodMade: 23,
        workersActiveCount: 12,
        mineralsUsedCurrentArmy: 100,
        vespeneUsedCurrentArmy: 0,
      },
    },
  ])
  const controls = buildControlTimeline(
    [
      {
        _event: 'NNet.Game.SSelectionDeltaEvent',
        _gameloop: 10,
        _userid: { m_userId: 0 },
        m_controlGroupId: 10,
        m_delta: { m_removeMask: { None: null }, m_addUnitTags: [11, 12] },
      },
    ],
    timeline.players,
  )
  const track = controls.players.get(1)
  assert.ok(track)
  assert.deepEqual(selectionAt(track, 10), [11, 12])
  assert.deepEqual(hudStateAt(timeline, 1, 10), {
    loop: 5,
    minerals: 75,
    vespene: 25,
    mineralsRate: 600,
    vespeneRate: 120,
    supplyUsed: 14,
    supplyCap: 23,
    workersActive: 12,
    armyValueMinerals: 100,
    armyValueVespene: 0,
  })
})
