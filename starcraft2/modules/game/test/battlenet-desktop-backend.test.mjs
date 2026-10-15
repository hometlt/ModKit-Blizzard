import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createDesktopLoginBackend } from '../../../dist/modules/game/battlenet/desktop/desktop-backend.js'
import { encodeCacheHeader } from '../../../dist/modules/game/battlenet/content-sources/cache-header.js'

const helper = String.raw`
const { createConnection } = require('node:net');
const { createInterface } = require('node:readline');
const region = process.argv[2], scenario = process.argv[3];
const socket = createConnection(process.argv[4]);
const send = data => socket.write('MODKIT_SOURCE:' + JSON.stringify(data) + '\n');
socket.on('connect', () => {
  if (scenario === 'wait') return;
  const data = Buffer.from('MODKIT_SOURCE:' + JSON.stringify({ type: 'ready', accountId: 'account',
    accountName: 'Аккаунт', profileId: 'profile', profileName: 'Профиль',
    region: scenario === 'wrong-region' ? 'kr' : region }) + '\n');
  // Force an IPC boundary in the middle of the first Cyrillic UTF-8 character.
  const boundary = data.indexOf(Buffer.from('Аккаунт')) + 1;
  socket.write(data.subarray(0, boundary));
  setTimeout(() => socket.write(data.subarray(boundary)), 20);
});
createInterface({ input: socket }).on('line', line => {
  const data = JSON.parse(line);
  if (data.type === 'close') { socket.end(); return; }
  if (data.type === 'request') {
    if (scenario === 'pending') return;
    if (scenario === 'query-failed') send({ type: 'response', id: data.id,
      error: 'must-not-expose-secret', diagnostic: 'ValueError-map_catalog-61' });
    else if (data.method === 'lobbies') send({ type: 'response', id: data.id, value: [{ advert_id: 4922252,
      server_label: 9, server_epoch: scenario === 'bad-lobby' ? 2 ** 40 : -5, map_id: data.mapId ?? 140436, map_version: 131154,
      extension_mod_id: null, extension_mod_version: null, variant: 1, title: 'Лобби', host: 'Host#1', players: 3, capacity: 8, created: 1790000000 }] });
    else if (data.method === 'preview') send({ type: 'response', id: data.id, value: data.advert.id === 0 ? null :
      [{ team: 1, kind: 'human', name: 'Host#1', profile: { region: 2, realm: 1, id: '9223372036854775809' }, host: true },
        { team: 2, kind: 'ai', name: null, profile: null, host: false }] });
    else if (data.method === 'portraits') send({ type: 'response', id: data.id, value: scenario === 'bad-portraits'
      ? { players: [], unlockableFiles: [] } : { players: data.players.map(player => ({ name: player.name, portrait: null })), unlockableFiles: [] } });
    else if (data.method === 'names') send({ type: 'response', id: data.id, value: { players: scenario === 'bad-names'
      ? data.players.slice(1) : data.players.map((player, index) => ({ ...player, name: index ? null : 'Игрок#123', tag: index ? null : 'CLAN' })) } });
    else if (data.method === 'inspectProfile') send({ type: 'response', id: data.id, value: scenario === 'bad-shape'
      ? { sections: { 'Игрок#123': 1 } } : { type: 1, bytes: 900, entries: 40, parsedTo: 900, s2gs: 2, valueTypes: { 1: 30, 5: 10 },
        sections: { '14/f0': 12, '02': 8 }, self: data.self === true } });
    else if (data.method === 'season') send({ type: 'response', id: data.id, value: scenario === 'bad-season'
      ? { state: 'active', seasonId: 66, start: 'soon', end: 2 }
      : { state: 'active', seasonId: 66, number: 2, year: 2026, start: 1782086400, end: 1790000000, matchmakers: 5, leagues: 40, version: 3 } });
    else if (data.method === 'queues') send({ type: 'response', id: data.id, value: scenario.startsWith('queues:')
      ? scenario.slice(7).split(',').map((header_handle, index) => ({ id: 201 + index, version: 163, header_handle }))
      : [{ id: 201, version: 163, header_handle: 'not-a-handle' }] });
    else if (data.method === 'maps') send({ type: 'response', id: data.id, value: data.maps.map(map => ({ id: map.id,
      version: map.version, name: 'Карта ' + map.id, is_mod: false, private: false, locked: false,
      header_handle: '73326d6800004555' + 'b'.repeat(64) })) });
    else {
      const items = [{ id: 1, version: 65537, name: 'Тест', is_mod: true, private: false, locked: false,
        header_handle: '73326d6800005553' + 'a'.repeat(64) }];
      send({ type: 'response', id: data.id, value: data.method === 'search' ? { items, truncated: data.name === 'TD' } : items });
    }
  }
});
socket.on('end', () => process.exit());
socket.on('error', () => process.exit(1));
`
async function setup(t, scenario = 'normal', battleNetCacheDirectory) {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-bnet-helper-'))
  await writeFile(join(directory, 'content_login.cjs'), helper)
  const sessions = []
  t.after(async () => {
    await Promise.all(sessions.map(session => session.close()))
    await rm(directory, { recursive: true, force: true })
  })
  const backend = createDesktopLoginBackend({ researchDirectory: directory,
    electronExecutable: process.execPath, pythonExecutable: scenario, ...(battleNetCacheDirectory ? { battleNetCacheDirectory } : {}) })
  return { ...backend, async login(request) {
    const session = await backend.login(request)
    sessions.push(session)
    return session
  } }
}
const options = { skip: process.platform !== 'win32', timeout: 15000 }
const request = signal => ({ region: 'us', browserSessionId: 'test', signal })

test('desktop helper preserves split UTF-8 identities and closes the selected session', options, async t => {
  const backend = await setup(t)
  const session = await backend.login(request(new AbortController().signal))
  t.after(() => session.close())
  assert.equal(session.accountName, 'Аккаунт')
  assert.equal(session.profileName, 'Профиль')
  const page = await session.api.listPublished({ region: 'us', signal: new AbortController().signal })
  assert.equal(page.items[0].name, 'Тест')
  const found = await session.api.searchMods({ region: 'us', name: 'Te', signal: new AbortController().signal })
  assert.deepEqual([found.items[0].name, found.truncated], ['Тест', undefined])
  assert.equal((await session.api.searchMods({ region: 'us', name: 'TD', signal: new AbortController().signal })).truncated, true)
  await session.close()
  assert.equal(session.signal.aborted, true)
  await assert.rejects(session.api.listPublished({ region: 'us', signal: new AbortController().signal }), /ended/)
})
test('NA, EU and KR use the same isolated helper path and reject cross-region calls', options, async t => {
  const backend = await setup(t)
  for (const region of ['us', 'eu', 'kr']) {
    const signal = new AbortController().signal
    const session = await backend.login({ ...request(signal), region })
    assert.equal(session.region, region)
    assert.equal((await session.api.listPublished({ region, signal })).items.length, 1)
    await assert.rejects(session.api.listPublished({ region: region === 'us' ? 'eu' : 'us', signal }), /region mismatch/)
    await assert.rejects(session.api.searchMods({ region: region === 'us' ? 'eu' : 'us', name: 'Test', signal }), /region mismatch/)
    await session.close()
  }
})
test('desktop helper rejects a different region and suppresses raw query errors', options, async t => {
  const wrong = await setup(t, 'wrong-region')
  await assert.rejects(wrong.login(request(new AbortController().signal)), /login\/session failed/)
  const backend = await setup(t, 'query-failed')
  const session = await backend.login(request(new AbortController().signal))
  t.after(() => session.close())
  await assert.rejects(session.api.searchMods({ region: 'us', name: 'a', signal: new AbortController().signal }), error => {
    assert.match(error.message, /ValueError-map_catalog-61/)
    assert(!error.message.includes('must-not-expose-secret'))
    return true
  })
})
test('aborting a pending native query rejects it and terminates its helper', options, async t => {
  const backend = await setup(t, 'pending')
  const session = await backend.login(request(new AbortController().signal))
  t.after(() => session.close())
  const controller = new AbortController()
  const pending = session.api.listPublished({ region: 'us', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /ended/)
  await session.close()
  assert(session.signal.aborted)
})
test('aborting before login completes closes the interactive helper', options, async t => {
  const backend = await setup(t, 'wait')
  const controller = new AbortController()
  const pending = backend.login(request(controller.signal))
  controller.abort(new Error('Login cancelled'))
  await assert.rejects(pending, /Login cancelled/)
})
test('open lobbies and lobby previews cross the helper with checked records', options, async t => {
  const backend = await setup(t)
  const signal = new AbortController().signal
  const session = await backend.login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  const [lobby] = await session.api.openLobbies({ region: 'eu', mapId: 72738, signal })
  assert.deepEqual(lobby, { advert: { id: 4922252, serverLabel: 9, serverEpoch: -5 }, map: { id: 72738, version: 131154 }, extensionMod: null,
    variant: 1, title: 'Лобби', hostName: 'Host#1', players: 3, capacity: 8, createdAt: 1790000000 })
  assert.deepEqual(await session.api.lobbyPreview({ region: 'eu', advert: lobby.advert, signal }),
    [{ team: 1, kind: 'human', name: 'Host#1', profile: { region: 2, realm: 1, id: '9223372036854775809' }, host: true },
      { team: 2, kind: 'ai', host: false }])
  assert.equal(await session.api.lobbyPreview({ region: 'eu', advert: { ...lobby.advert, id: 0 }, signal }), null)
  const [described] = await session.api.describeMaps({ region: 'eu', maps: [lobby.map], signal })
  assert.deepEqual([described.id, described.version, described.name], [72738, 131154, 'Карта 72738'])
  await assert.rejects(session.api.describeMaps({ region: 'eu', maps: [], signal }), /1 to 100/)
  await assert.rejects(session.api.openLobbies({ region: 'us', signal }), /region mismatch/)
  const bad = await (await setup(t, 'bad-lobby')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.openLobbies({ region: 'eu', signal }), /Invalid lobby record/)
})
test('portraits are asked by name and a malformed answer is refused', options, async t => {
  const backend = await setup(t)
  const signal = new AbortController().signal
  const session = await backend.login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  const players = [{ region: 2, realm: 1, name: 'Host' }, { region: 2, realm: 1, name: 'Guest' }]
  assert.deepEqual(await session.api.describePortraits({ region: 'eu', players, signal }), [null, null])
  assert.deepEqual(await session.api.describePortraits({ region: 'eu', players: [], signal }), [])
  await assert.rejects(session.api.describePortraits({ region: 'eu', players: Array(17).fill(players[0]), signal }), /at most 16/)
  await assert.rejects(session.api.describePortraits({ region: 'us', players, signal }), /region mismatch/)
  const bad = await (await setup(t, 'bad-portraits')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.describePortraits({ region: 'eu', players, signal }), /Invalid portrait answer/)
})
test('names are asked by toon handle and a malformed answer is refused', options, async t => {
  const backend = await setup(t)
  const signal = new AbortController().signal
  const session = await backend.login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  const players = [{ region: 2, realm: 1, id: '9223372036854775809' }, { region: 2, realm: 1, id: '7' }]
  assert.deepEqual(await session.api.describeNames({ region: 'eu', players, signal }),
    [{ ...players[0], name: 'Игрок#123', clanTag: 'CLAN' }, players[1]])
  assert.deepEqual(await session.api.describeNames({ region: 'eu', players: [], signal }), [])
  await assert.rejects(session.api.describeNames({ region: 'eu', players: Array(65).fill(players[0]), signal }), /at most 64/)
  await assert.rejects(session.api.describeNames({ region: 'eu', players: [{ region: 2, realm: 1, id: '1e3' }], signal }), /Invalid player handle/)
  const bad = await (await setup(t, 'bad-names')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.describeNames({ region: 'eu', players, signal }), /Invalid name answer/)
})
test('a profile shape carries counts and section paths only', options, async t => {
  const backend = await setup(t)
  const signal = new AbortController().signal
  const session = await backend.login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  assert.deepEqual(await session.api.inspectProfile({ region: 'eu', player: 'self', signal }),
    { type: 1, bytes: 900, entries: 40, parsedTo: 900, s2gs: 2, valueTypes: { 1: 30, 5: 10 }, sections: { '14/f0': 12, '02': 8 } })
  await assert.rejects(session.api.inspectProfile({ region: 'eu', player: { region: 2, realm: 1, id: 'x' }, signal }), /Invalid player handle/)
  const bad = await (await setup(t, 'bad-shape')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.inspectProfile({ region: 'eu', player: 'self', signal }), /Invalid profile shape/)
})

/** A queue header as the game writes it (tags of Battlenet::MatchMaker::Header), synthetic values. */
function queueFile({ id, teamSize, tags, maps, locale }) {
  const n = value => ({ kind: 9, value: BigInt(value) })
  const struct = entries => ({ kind: 5, value: new Map(entries.map(([tag, node]) => [BigInt(tag), node])) })
  const list = items => ({ kind: 0, value: items })
  const four = text => ({ kind: 7, value: new TextEncoder().encode(text.padStart(4, ' ')) })
  const entry = (map, type) => struct([[0, struct([[0, n(map)], [1, n(0)]])], [1, n(type)]])
  return encodeCacheHeader(struct([
    [0, struct([[2, list([struct([[0, { kind: 7, value: new TextEncoder().encode('enUS') }], [1, list([{ kind: 2, value: locale }])]])])],
      [4, struct([[1, n(0)], [2, n(1)]])], [8, n(teamSize)], [9, n(2)], [14, list(tags.map(four))]])],
    [2, struct([[0, n(2)], [1, four('S2')], [3, n(id)], [4, n(163)]])],
    [3, list(maps.map(map => struct([[0, struct([[0, n(0)], [1, four('Fasr')], [3, list([entry(map, 0), entry(900001, 1)])]])], [1, list([])]])))],
  ]))
}

test('matchmaking queues come with their map pools from the queue headers', options, async t => {
  const cache = await mkdtemp(join(tmpdir(), 'modkit-bnet-cache-'))
  t.after(() => rm(cache, { recursive: true, force: true }))
  const store = async (type, bytes) => {
    const sha = createHash('sha256').update(bytes).digest('hex')
    await mkdir(join(cache, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true })
    await writeFile(join(cache, sha.slice(0, 2), sha.slice(2, 4), `${sha}.${type}`), bytes)
    const handle = Buffer.alloc(40)
    handle.write(type, 0, 'latin1'); handle.write('EU', 6, 'latin1'); Buffer.from(sha, 'hex').copy(handle, 8)
    return handle
  }
  const table = await store('s2ql', Buffer.from('<?xml version="1.0" encoding="utf-8"?><locale locale="enUS"><e id="1">Ranked 1v1</e></locale>'))
  const solo = await store('s2qh', queueFile({ id: 201, teamSize: 1, tags: ['Ladd', 'Solo'], maps: [300001, 300002], locale: table }))
  const coop = await store('s2qh', queueFile({ id: 202, teamSize: 2, tags: ['Coop'], maps: [300003], locale: table }))
  const backend = await setup(t, `queues:${solo.toString('hex')},${coop.toString('hex')}`, cache)
  const signal = new AbortController().signal
  const session = await backend.login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  const all = await session.api.describeQueues({ region: 'eu', signal })
  assert.deepEqual(all.map(queue => [queue.id, queue.teamSize, queue.tags]), [[201, 1, ['Ladd', 'Solo']], [202, 2, ['Coop']]])
  assert.equal(all[0].name, 'Ranked 1v1')
  assert.deepEqual(all[0].maps, [{ id: 300001, mods: [900001], variantIndex: 0, speed: 'Fasr' }, { id: 300002, mods: [900001], variantIndex: 0, speed: 'Fasr' }])
  // Only queues that carry every tag asked for.
  assert.deepEqual((await session.api.describeQueues({ region: 'eu', tags: ['Ladd'], signal })).map(queue => queue.id), [201])
  await assert.rejects(session.api.describeQueues({ region: 'eu', tags: ['Ladder'], signal }), /Invalid queue tags/)
  await assert.rejects(session.api.describeQueues({ region: 'us', signal }), /Session region mismatch/)
  // A worker answer that names no queue header is refused.
  const bad = await (await setup(t, 'bad-queues')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.describeQueues({ region: 'eu', signal }), /Invalid queue header handle/)
})

test('the current season crosses the helper with ids and dates only', options, async t => {
  const signal = new AbortController().signal
  const session = await (await setup(t)).login({ ...request(signal), region: 'eu' })
  t.after(() => session.close())
  assert.deepEqual(await session.api.describeSeason({ region: 'eu', signal }),
    { state: 'active', seasonId: 66, number: 2, year: 2026, start: 1782086400, end: 1790000000 })
  await assert.rejects(session.api.describeSeason({ region: 'us', signal }), /Session region mismatch/)
  const bad = await (await setup(t, 'bad-season')).login({ ...request(signal), region: 'eu' })
  t.after(() => bad.close())
  await assert.rejects(bad.api.describeSeason({ region: 'eu', signal }), /Invalid season record/)
})
