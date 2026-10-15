import assert from 'node:assert/strict'
import test from 'node:test'
import { LobbyTracker } from '../../../dist/modules/game/battlenet/lobbies/lobby-tracker.js'

const T0 = 1_800_000_000
const lobby = (id, change = {}) => ({ advert: { id, serverLabel: 9, serverEpoch: 1 }, map: { id: 140436, version: 1 },
  extensionMod: null, variant: 1, title: '', hostName: 'Host#1', players: 1, capacity: 8, createdAt: T0, ...change })
const human = (name, host = false) => ({ team: 1, kind: 'human', name, host })

function closeAfter(setup, entry, gap) {
  const tracker = new LobbyTracker()
  tracker.apply([entry], T0)
  setup(tracker)
  tracker.apply([], T0 + gap)
  return tracker.closed[0]
}

test('opening, parameter changes and closing make one timeline per lobby', () => {
  const tracker = new LobbyTracker()
  assert.deepEqual(tracker.apply([lobby(1)], T0 + 5), [{ at: T0, kind: 'opened', name: 'Host#1' }])
  assert.deepEqual(tracker.apply([lobby(1)], T0 + 15), [])
  const events = tracker.apply([lobby(1, { title: '1v1', players: 2, capacity: 6, hostName: 'Other#2', variant: 2 })], T0 + 25)
  assert.deepEqual(events.map(e => [e.kind, e.from, e.to]),
    [['title', '', '1v1'], ['host', 'Host#1', 'Other#2'], ['capacity', 8, 6], ['variant', 1, 2], ['players', 1, 2]])
  const [closed] = tracker.apply([], T0 + 40)
  assert.deepEqual(closed, { at: T0 + 40, kind: 'closed', outcome: 'started' })
  assert.equal(tracker.open.length, 0)
  assert.deepEqual(tracker.closed[0].events.map(e => e.kind), ['opened', 'title', 'host', 'capacity', 'variant', 'players', 'closed'])
})

test('slot lists turn counts into named joins and leaves', () => {
  const tracker = new LobbyTracker()
  tracker.apply([lobby(1, { players: 2 })], T0 + 5)
  assert.deepEqual(tracker.applySlots(1, [human('Host#1', true), human('Early#2')], T0 + 5),
    [{ at: T0, kind: 'joined', name: 'Host#1' }, { at: T0 + 5, kind: 'joined', name: 'Early#2' }])
  tracker.apply([lobby(1, { players: 2 })], T0 + 20)
  assert.deepEqual(tracker.applySlots(1, [human('Host#1', true), human('Late#3'), { team: 2, kind: 'ai', host: false }], T0 + 20),
    [{ at: T0 + 20, kind: 'joined', name: 'Late#3' }, { at: T0 + 20, kind: 'left', name: 'Early#2' }])
  // Once slots are known the bare player count is not repeated as its own event.
  assert.deepEqual(tracker.apply([lobby(1, { players: 3 })], T0 + 30), [])
  assert.deepEqual(tracker.applySlots(99, [human('X#1')], T0 + 30), [], 'unknown lobby is ignored')
})

test('players already in a lobby found late are marked as such', () => {
  const tracker = new LobbyTracker()
  tracker.apply([lobby(2, { players: 2 })], T0 + 300)
  const events = tracker.applySlots(2, [human('Host#1', true), human('Old#2')], T0 + 300)
  assert.deepEqual(events[1], { at: T0 + 300, kind: 'joined', name: 'Old#2', late: true })
})

test('closing outcome follows the original Arcade Watcher rules', () => {
  const step = 15
  assert.equal(closeAfter(() => {}, lobby(1, { players: 1 }), step).outcome, 'abandoned')
  assert.equal(closeAfter(() => {}, lobby(1, { players: 3 }), step).outcome, 'started')
  assert.equal(closeAfter(() => {}, lobby(1, { players: 1, capacity: 1 }), step).outcome, 'started')
  const orphan = closeAfter(() => {}, lobby(1, { players: 4 }), 90)
  assert.deepEqual([orphan.outcome, orphan.closedAt], ['unknown', T0])
  assert.equal(closeAfter(t => t.applySlots(1, [human('Host#1', true), human('B#2'), human('C#3')], T0), lobby(1), step).outcome, 'started',
    'a fresh slot list beats the list count')
  assert.equal(closeAfter(t => t.applySlots(1, [human('B#2'), human('C#3')], T0 - 30), lobby(1, { players: 2 }), step).outcome, 'abandoned',
    'two players left in a stale slot list without the host')
})

test('server clock skew is learned from fresh lobbies and closed history is bounded', () => {
  const tracker = new LobbyTracker(2)
  tracker.apply([lobby(1, { createdAt: T0 + 50 })], T0)
  assert.equal(tracker.open[0].openedAt, T0)
  tracker.apply([lobby(1, { createdAt: T0 + 50 }), lobby(2, { createdAt: T0 + 50 + 20 })], T0 + 30)
  assert.equal(tracker.open[1].openedAt, T0 + 20)
  for (let id = 3; id < 6; id++) { tracker.apply([lobby(id)], T0 + id * 10); tracker.apply([], T0 + id * 10 + 5) }
  assert.deepEqual(tracker.closed.map(t => t.lobby.advert.id), [5, 4])
})
