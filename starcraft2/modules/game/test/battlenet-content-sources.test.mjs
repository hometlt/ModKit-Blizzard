import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { BattleNetContentSources } from '../../../dist/modules/game/battlenet/content-sources/content-sources.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const bytes = encodeFreshMpq([{ path: 'DocumentInfo', bytes: new TextEncoder().encode('<DocInfo/>') }], 1024 * 1024)
const publication = (id, privateValue = false) => ({ id, name: `Mod ${id}`, version: 65537, isMod: true,
  private: privateValue, headerHandle: `73326d6800005553${hash(String(id))}` })
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-sources-'))
  let downloads = 0, closed = 0, sequence = 0
  const options = { cacheDirectory: directory, stateDirectory: directory, publishing: true, deletion: true,
    publicApi: { async resolveArchive() { return { kind: 'mpq', sha256: hash(bytes) } },
      async *downloadArchive() { downloads++; yield bytes } },
    authentication: { supportedRegions: ['us', 'eu', 'kr'], async login(request) {
      const accountId = request.expectedAccountId ?? `account-${++sequence}`
      const ownPublication = publication(sequence, true)
      let deleted = false
      return { accountId, accountName: accountId, profileId: `${accountId}/${request.region}`, profileName: 'SC2 profile',
        region: request.region, credential: 'never-serialize-this',
        api: { ...options.publicApi, listPublished: async () => ({ items: deleted ? [] : [ownPublication] }),
          deletePublication: async value => { deleted = true; return { status: 'unlinked', region: request.region,
            operationId: value.operationId, id: value.publication.id, version: value.publication.version, serverUnlinkVerified: true } },
          publish: async value => ({ status: 'published', operationId: value.operationId, region: request.region,
            archiveSha256: value.archiveSha256, serverRevisionVerified: true, publication: {
              id: 19, version: 65538, name: value.name, isMod: true, private: true, locked: true,
              headerHandle: `73326d680000${Buffer.from(request.region.toUpperCase()).toString('hex')}${hash('header')}` } }),
          searchMods: async () => ({ items: [publication(10), publication(11, true)] }) },
        close: async () => { closed++ } }
    } },
  }
  const source = new BattleNetContentSources(options)
  t.after(async () => { await source.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { source, options, directory, counters: () => ({ downloads, closed }) }
}
test('multiple accounts and regions are distinct roots; logout invalidates only its account/region', async t => {
  const { source, counters } = await setup(t)
  await source.connect('na'); await source.connect('us'); await source.connect('eu', 'account-1')
  const snapshot = await source.snapshot()
  assert.equal(snapshot.connections.length, 3)
  assert.equal(snapshot.roots.filter(root => root.kind === 'mine').length, 3)
  assert(!JSON.stringify(snapshot).includes('never-serialize-this'))
  const [a, b] = snapshot.connections.filter(item => item.region === 'us')
  const first = await source.list(`mine:${a.id}`, '')
  assert(first.length > 0)
  await source.disconnect(a.id)
  await assert.rejects(source.list(`mine:${a.id}`, ''), /ended/)
  assert((await source.list(`mine:${b.id}`, '')).length > 0)
  assert.equal(counters().closed, 1)
})
test('own deletion invalidates the selected catalogue and cannot use public choices or expired tokens', async t => {
  const { source } = await setup(t)
  await source.connect('eu'); await source.connect('kr')
  const connections = (await source.snapshot()).connections
  const eu = connections.find(item => item.region === 'eu'), kr = connections.find(item => item.region === 'kr')
  assert.equal((await source.list(`mine:${eu.id}`, '')).length, 1)
  const publicResults = await source.search(eu.id, 'Mod')
  await assert.rejects(source.deletePublication(publicResults[0].id), /expired/)
  const choices = await source.deletionCandidates(eu.id)
  assert.equal((await source.deletePublication(choices[0].id)).region, 'eu')
  assert.equal((await source.list(`mine:${eu.id}`, '')).length, 0)
  assert.equal((await source.list(`mine:${kr.id}`, '')).length, 1)
  await assert.rejects(source.deletePublication(choices[0].id), /expired/)
  const next = await source.deletionCandidates(kr.id)
  await source.disconnect(kr.id)
  await assert.rejects(source.deletePublication(next[0].id), /expired/)
})

test('own publication rows expose a cache toggle and an exact row-bound deletion review', async t => {
  const { source, counters } = await setup(t)
  await source.connect('us')
  const connection = (await source.snapshot()).connections[0]
  const root = `mine:${connection.id}`
  let [row] = await source.list(root, '')
  assert.deepEqual(row.actions?.map(action => action.id), ['download', 'delete-publication'])
  await source.download(root, row.path)
  assert.equal(counters().downloads, 1)
  ;[row] = await source.list(root, '')
  assert.deepEqual(row.actions?.map(action => action.id), ['clear-cache', 'delete-publication'])
  const review = await source.prepareDeletePublication(root, row.path)
  assert.equal(review.description.includes('#1'), true)
  await source.clearCache(root, row.path)
  ;[row] = await source.list(root, '')
  assert.deepEqual(row.actions?.map(action => action.id), ['download', 'delete-publication'])
})

test('publication review selects a regional account and can be consumed only once; logout expires reviews', async t => {
  const { source, directory } = await setup(t)
  await source.connect('eu'); await source.connect('kr')
  const eu = (await source.snapshot()).connections.find(item => item.region === 'eu')
  const filePath = join(directory, 'test.SC2Mod'), packagePath = join(directory, 'test.modkit-publish.json')
  await writeFile(filePath, bytes)
  const manifest = { schema: 1, region: 'eu', name: 'Test', kind: 'mod', locale: 'enUS', archiveSha256: hash(bytes),
    target: { mode: 'update', id: 19, expectedVersion: 65537 }, visibility: 'private', locked: true }
  await writeFile(packagePath, JSON.stringify(manifest))
  const review = await source.preparePublish(eu.id, filePath, packagePath)
  assert.equal(review.region, 'eu'); assert.equal(review.sha256, hash(bytes))
  const receipt = await source.publish(review.id)
  assert.equal(receipt.region, 'eu'); assert.equal(receipt.publication.version, 65538)
  await assert.rejects(source.publish(review.id), /expired/)
  const second = await source.preparePublish(eu.id, filePath, packagePath)
  await source.disconnect(eu.id)
  await assert.rejects(source.publish(second.id), /expired/)
  const kr = (await source.snapshot()).connections.find(item => item.region === 'kr')
  await assert.rejects(source.preparePublish(kr.id, filePath, packagePath), /region/)
})
test('search never downloads; saved public revisions persist and open after logout and restart', async t => {
  const { source, options, counters, directory } = await setup(t)
  await source.connect('us')
  const connection = (await source.snapshot()).connections[0]
  const results = await source.search(connection.id, 'Mod')
  assert.equal(results.length, 1, 'private search results cannot enter the public source')
  await source.add(results[0].id)
  assert.equal(counters().downloads, 0)
  await source.disconnect(connection.id)
  const rows = await source.list('public:us', '')
  assert.equal(rows.length, 1)
  assert.equal(counters().downloads, 0)
  const files = await source.list('public:us', rows[0].path)
  assert(files.some(item => item.name === 'DocumentInfo'))
  assert.equal(new TextDecoder().decode(await source.read('public:us', `${rows[0].path}/DocumentInfo`, 100)), '<DocInfo/>')
  assert.equal(counters().downloads, 1)
  await assert.rejects(source.read('public:us', `${rows[0].path}/DocumentInfo`, 2), /limit/)
  const state = await readFile(join(directory, 'public-mods-v1.json'), 'utf8')
  assert(!state.includes('account-1')); assert(!state.includes('never-serialize-this'))
  const reopened = new BattleNetContentSources(options)
  try {
    const again = await reopened.list('public:us', '')
    await reopened.list('public:us', again[0].path)
    assert.equal(counters().downloads, 1, 'verified archive cache is reused across sessions')
    await reopened.remove('public:us', again[0].path)
    assert.deepEqual(await reopened.list('public:us', ''), [])
    await assert.rejects(reopened.add(results[0].id), /expired/)
  } finally { await reopened.dispose() }
})
