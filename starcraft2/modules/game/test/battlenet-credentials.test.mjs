import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BattleNetContentSources } from '../../../dist/modules/game/battlenet/content-sources/content-sources.js'

/** A broker port as the host hands it: kept values per `id#scope`, nothing else. */
function fakeBroker() {
  const kept = new Map(), calls = []
  const key = (id, scope) => `${id}#${scope}`
  return { kept, calls, port: {
    async secret(id, scope) { calls.push(['secret', id, scope]); const value = kept.get(key(id, scope)); return value === undefined ? undefined : new TextEncoder().encode(value) },
    async remember(id, value, scope) { calls.push(['remember', id, scope]); kept.set(key(id, scope), value) },
    async forget(id, scope) { calls.push(['forget', id, scope]); kept.delete(key(id, scope)) },
  } }
}

async function setup(t, credentials) {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-bnet-credentials-'))
  const tickets = []
  let sequence = 0
  const source = new BattleNetContentSources({ cacheDirectory: directory, stateDirectory: directory,
    ...(credentials === undefined ? {} : { credentials }),
    publicApi: { async resolveArchive() { throw new Error('unused') }, async *downloadArchive() { throw new Error('unused') } },
    authentication: { supportedRegions: ['us', 'eu', 'kr'], async login(request) {
      tickets.push(request.ticket)
      if (request.ticket === 'refused') throw new Error('The kept ticket was refused')
      const accountId = `account-${++sequence}`
      return { accountId, accountName: accountId, profileId: `${accountId}/${request.region}`, profileName: 'SC2 profile',
        region: request.region, webTicket: `fresh-${request.region}-${sequence}`,
        api: { listPublished: async () => ({ items: [] }) }, close: async () => {} }
    } } })
  t.after(async () => { await source.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { source, tickets }
}

test('every region names the declared Battle.net credential', async t => {
  const { source } = await setup(t, fakeBroker().port)
  const { regions } = await source.snapshot()
  assert.deepEqual(regions.map(region => [region.id, region.credentialId]),
    [['us', 'blizzard/battlenet'], ['eu', 'blizzard/battlenet'], ['kr', 'blizzard/battlenet']])
})

test('the broker keeps the fresh ticket per region and the application never sees it', async t => {
  const broker = fakeBroker()
  const { source, tickets } = await setup(t, broker.port)
  assert.equal(await source.connect('eu'), undefined)
  assert.equal(broker.kept.get('blizzard/battlenet#eu'), 'fresh-eu-1')
  assert.equal(tickets[0], undefined)
  // The next sign-in to the region takes the kept ticket instead of the login page.
  const eu = (await source.snapshot()).connections[0]
  await source.disconnect(eu.id)
  assert.equal(broker.kept.has('blizzard/battlenet#eu'), false, 'signing out forgets the region ticket')
  broker.kept.set('blizzard/battlenet#kr', 'kept-kr')
  await source.connect('kr')
  assert.equal(tickets.at(-1), 'kept-kr')
  assert.equal(broker.kept.get('blizzard/battlenet#kr'), 'fresh-kr-2')
})

test('a refused kept ticket is forgotten and the login page opens', async t => {
  const broker = fakeBroker()
  broker.kept.set('blizzard/battlenet#us', 'refused')
  const { source, tickets } = await setup(t, broker.port)
  await source.connect('us')
  assert.deepEqual(tickets, ['refused', undefined])
  assert.equal(broker.kept.get('blizzard/battlenet#us'), 'fresh-us-1')
  assert.ok(broker.calls.some(call => call[0] === 'forget' && call[2] === 'us'))
})

test('without a broker every sign-in opens the page and nothing is kept', async t => {
  const { source, tickets } = await setup(t, undefined)
  assert.equal(await source.connect('us'), undefined)
  await source.connect('eu')
  assert.deepEqual(tickets, [undefined, undefined])
})
