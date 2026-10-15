import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSc2ReplayCommands } from '../modules/replay/services/commands/normalize.js'
import {
  createReplaySemanticCommandResolver,
  parseReplayStableAbilities,
} from '../modules/replay/services/commands/semantic-resolver.js'
import { buildReplayTimeline } from '../modules/replay/services/timeline/index.js'

const selection = (loop, removeMask, addUnitTags) => ({
  _event: 'NNet.Game.SSelectionDeltaEvent',
  _gameloop: loop,
  _userid: { m_userId: 0 },
  m_controlGroupId: 10,
  m_delta: { m_removeMask: removeMask, m_addUnitTags: addUnitTags },
})

const command = (loop, sequence, target) => ({
  _event: 'NNet.Game.SCmdEvent',
  _gameloop: loop,
  _userid: { m_userId: 0 },
  m_cmdFlags: 0,
  m_abil: { m_abilLink: 42, m_abilCmdIndex: 1, m_abilCmdData: null },
  m_data: target,
  m_sequence: sequence,
})

test('Replay command intents preserve selection, ability and scaled targets without guessing semantics', () => {
  const trackerEvents = [
    { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 1, type: 1, userId: 0 },
  ]
  const gameEvents = [
    selection(0, { None: null }, [100, 101]),
    command(1, 7, { TargetPoint: { x: 10 * 4096, y: 20 * 4096, z: 0 } }),
    selection(2, { OneIndices: [0] }, [102]),
    command(3, 8, {
      TargetUnit: {
        m_tag: 900,
        m_snapshotUnitLink: 17,
        m_snapshotControlPlayerId: 2,
        m_snapshotUpkeepPlayerId: 2,
        m_snapshotPoint: { x: 12 * 4096, y: 24 * 4096, z: 0 },
      },
    }),
  ]
  const result = normalizeSc2ReplayCommands({
    decoded: {
      header: { version: { baseBuild: 95299 } },
      trackerEvents,
      gameEvents,
      protocolSupport: { selectedBuild: 95299, exact: true },
    },
    timeline: buildReplayTimeline(trackerEvents),
  })
  assert.equal(result.commands.length, 0)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.intents, [
    {
      id: 'sc2-replay:95299:1',
      replayBuild: 95299,
      protocolBuild: 95299,
      protocolExact: true,
      loop: 1,
      userId: 0,
      player: 1,
      sequence: 7,
      flags: 0,
      unitTags: [100, 101],
      ability: { link: 42, commandIndex: 1 },
      target: { kind: 'point', x: 10, y: 20, z: 0 },
    },
    {
      id: 'sc2-replay:95299:3',
      replayBuild: 95299,
      protocolBuild: 95299,
      protocolExact: true,
      loop: 3,
      userId: 0,
      player: 1,
      sequence: 8,
      flags: 0,
      unitTags: [101, 102],
      ability: { link: 42, commandIndex: 1 },
      target: {
        kind: 'unit',
        tag: 900,
        unitLink: 17,
        controlPlayer: 2,
        upkeepPlayer: 2,
        x: 12,
        y: 24,
      },
    },
  ])
})

test('Replay command intent bounds are explicit', () => {
  const trackerEvents = [
    { gameloop: 0, eventid: 9, event: 'PlayerSetup', playerId: 1, type: 1, userId: 0 },
  ]
  const gameEvents = [
    selection(0, { None: null }, [100]),
    command(1, 1, { null: null }),
    command(2, 2, { null: null }),
  ]
  const result = normalizeSc2ReplayCommands(
    {
      decoded: { header: { version: { baseBuild: 1 } }, trackerEvents, gameEvents },
      timeline: buildReplayTimeline(trackerEvents),
    },
    undefined,
    { maxIntents: 1 },
  )
  assert.equal(result.intents.length, 1)
  assert.equal(result.diagnostics.at(-1).code, 'intent-limit')
  assert.throws(
    () =>
      normalizeSc2ReplayCommands(
        {
          decoded: { header: { version: { baseBuild: 1 } }, trackerEvents, gameEvents },
          timeline: buildReplayTimeline(trackerEvents),
        },
        undefined,
        { maxIntents: 100_001 },
      ),
    /maxIntents/u,
  )
})

test('stable IDs and resolved ability classes produce only exact semantic commands', () => {
  const stableIds = {
    Abilities: [
      { id: 42, index: 0, name: 'Move' },
      { id: 43, index: 1, name: 'Train' },
    ],
  }
  assert.equal(parseReplayStableAbilities(stableIds).size, 2)
  const resolver = createReplaySemanticCommandResolver(
    stableIds,
    new Map([
      ['Move', { typeId: 'CAbilMove', fields: {} }],
      [
        'Train',
        {
          typeId: 'CAbilTrain',
          fields: { InfoArray: [{ index: 'Train1', Unit: { value: 'Marine' } }] },
        },
      ],
    ]),
  )
  const base = {
    unitTags: [100],
    target: { kind: 'point', x: 10, y: 20, z: 0 },
  }
  assert.deepEqual(resolver.resolve({ ...base, ability: { link: 42, commandIndex: 0 } }), {
    kind: 'move',
    unitTags: [100],
    x: 10,
    y: 20,
  })
  assert.deepEqual(
    resolver.resolve({ ...base, ability: { link: 43, commandIndex: 1 } }),
    { kind: 'train', structureTags: [100], unitType: 'Marine' },
  )
  assert.equal(resolver.resolve({ ...base, ability: { link: 43, commandIndex: 2 } }), undefined)
  assert.throws(
    () => parseReplayStableAbilities({ Abilities: [{ id: 1, index: 0, name: 'A' }, { id: 1, index: 0, name: 'B' }] }),
    /duplicate/u,
  )
})
