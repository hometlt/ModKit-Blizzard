import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { VirtualFileSystem, collectStream } from '@modkit/vfs'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { BattleNetVfsProvider, BattleNetPublishOutcomeUnknownError } from '@modkit/blizzard-starcraft2/battlenet/vfs/node'
import { BattleNetAccountsProvider } from '@modkit/blizzard-starcraft2/battlenet/accounts/node'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const code = name => error => error?.code === `blizzard.battlenet/${name}`
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { resolve, reject, promise } }
const list = async mount => { const result = []; for await (const item of mount.list('')) result.push(item); return result }
const archive = encodeFreshMpq([{ path: 'DocumentInfo', bytes: new TextEncoder().encode('<DocInfo/>') }], 1024 * 1024)

function receipt(request, overrides = {}) {
  return {
    status: 'published', operationId: request.operationId, region: request.region,
    archiveSha256: request.archiveSha256, serverRevisionVerified: true,
    publication: {
      id: request.target.mode === 'update' ? request.target.id : 314,
      version: request.target.mode === 'update' ? request.target.expectedVersion + 1 : 65536,
      name: request.name, isMod: request.kind === 'mod', private: request.visibility === 'private', locked: request.locked,
      headerHandle: `73326d680000${Buffer.from(request.region.toUpperCase()).toString('hex')}${hash('synthetic-header')}`,
    },
    ...overrides,
  }
}

async function fixture(t, { publish, api: overrides = {}, providerOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-bnet-publish-'))
  const filePath = join(directory, 'test.SC2Mod')
  await writeFile(filePath, archive)
  const requests = []
  const publications = []
  const api = {
    async listPublished() { return { items: publications } },
    async resolveArchive() { throw new Error('unused') },
    async *downloadArchive() { throw new Error('unused') },
    async publish(request) {
      requests.push(request)
      if (publish) return publish(request)
      assert.equal(hash(await collectStream(request.source.stream(0, request.archiveBytes, request.signal))), request.archiveSha256)
      request.onProgress({ stage: 'allocating' })
      request.onProgress({ stage: 'uploading', uploadedBytes: request.archiveBytes, totalBytes: request.archiveBytes })
      request.onProgress({ stage: 'verifying' })
      const result = receipt(request)
      publications.push(result.publication)
      return result
    },
    ...overrides,
  }
  const provider = new BattleNetVfsProvider({ api, profileKey: 'profile-A', cacheDirectory: directory, ...providerOptions })
  const vfs = new VirtualFileSystem().registerProvider(provider)
  t.after(async () => { await provider.dispose(); await vfs.dispose(); await rm(directory, { recursive: true, force: true }) })
  const options = { region: 'na', filePath, name: 'Тестовый мод', target: { mode: 'create' } }
  return { directory, filePath, options, api, requests, provider, vfs }
}

test('publish a saved mod with defaults, confirmed progress and refreshed catalogue', async t => {
  const f = await fixture(t)
  const old = await f.vfs.openMount('battlenet://us/mine')
  const progress = []
  const result = await f.provider.publish({ ...f.options, operationId: 'operation-1', onProgress: event => progress.push(event) })
  assert.equal(result.status, 'published')
  assert.equal(result.operationId, 'operation-1')
  assert.equal(result.region, 'us')
  assert.equal(result.publication.private, true)
  assert.equal(result.publication.locked, true)
  assert.equal(result.publication.isMod, true)
  assert.equal(result.archiveSha256, hash(archive))
  assert.equal(f.requests[0].locale, 'enUS')
  assert.equal(f.requests[0].fileName, 'test.SC2Mod')
  assert.deepEqual(progress.map(event => event.stage), ['preparing', 'allocating', 'uploading', 'verifying', 'published'])
  assert(progress.every(event => event.operationId === 'operation-1'))
  assert.equal(hash(await readFile(f.filePath)), hash(archive))
  assert.deepEqual(await list(old), [])
  const refreshed = await f.vfs.openMount('battlenet://us/mine')
  assert.equal((await list(refreshed))[0].publication.version, result.publication.version)
  await old.dispose()
  await refreshed.dispose()
  await assert.rejects(f.requests[0].source.size(), /disposed/u)
})

test('update a map using the expected revision, explicit visibility and locale', async t => {
  const f = await fixture(t)
  const filePath = join(f.directory, 'map.SC2Map')
  await writeFile(filePath, archive)
  const target = { mode: 'update', id: 99, expectedVersion: 65537 }
  const result = await f.provider.publish({ ...f.options, filePath, target, region: 'eu', name: 'Map',
    locale: 'ruRU', description: 'Описание карты', visibility: 'public', locked: false })
  const request = f.requests[0]
  assert.deepEqual(request.target, target)
  assert.equal(request.kind, 'map')
  assert.equal(request.description, 'Описание карты')
  assert.equal(request.locale, 'ruRU')
  assert.equal(result.publication.id, 99)
  assert.equal(result.publication.version, 65538)
  assert.equal(result.publication.isMod, false)
  assert.equal(result.publication.private, false)
  assert.equal(result.publication.locked, false)
})

test('invalid local inputs and unavailable backend never submit a publication', async t => {
  const f = await fixture(t)
  const notMpq = join(f.directory, 'broken.SC2Mod')
  await writeFile(notMpq, 'Standard Data: Core.SC2Mod')
  for (const patch of [{ filePath: 'x.txt' }, { filePath: notMpq }, { filePath: f.directory },
    { name: '' }, { visibility: 'friends' }, { locked: 'false' }, { operationId: '../secret' },
    { target: { mode: 'update', id: 1, expectedVersion: 0 } }, { target: undefined }]) {
    await assert.rejects(f.provider.publish({ ...f.options, ...patch }))
  }
  assert.equal(f.requests.length, 0)
  const bounded = await fixture(t, { providerOptions: { maxArchiveBytes: 10 } })
  await assert.rejects(bounded.provider.publish(bounded.options), code('invalid-publication-input'))
  assert.equal(bounded.requests.length, 0)
  const readOnly = await fixture(t, { api: { publish: undefined } })
  await assert.rejects(readOnly.provider.publish({ ...readOnly.options, filePath: 'missing.SC2Map' }), code('publish-unavailable'))
})

test('publishing uses a snapshot and pins options before progress observers can modify them', async t => {
  let seen
  let retainedStream
  const f = await fixture(t, { publish: async request => {
    seen = request
    retainedStream = request.source.stream()
    await assert.rejects(request.source.readAt(0.5, 1), /range/u)
    await writeFile(f.filePath, 'file changed after snapshot')
    assert.equal(hash(await collectStream(request.source.stream())), hash(archive))
    return receipt(request)
  } })
  const options = { ...f.options, target: { mode: 'update', id: 99, expectedVersion: 65536 } }
  options.onProgress = event => {
    if (event.stage !== 'preparing') return
    options.filePath = 'missing.SC2Mod'
    options.name = 'changed'
    options.target.id = 123
  }
  const result = await f.provider.publish(options)
  assert.equal(result.publication.id, 99)
  assert.equal(result.publication.name, f.options.name)
  assert.equal(seen.fileName, 'test.SC2Mod')
  await assert.rejects(collectStream(retainedStream), /disposed/u)
})

test('unconfirmed, mismatched and stale receipts produce an unknown outcome without retry', async t => {
  const changes = [
    r => ({ ...r, serverRevisionVerified: false }), r => ({ ...r, operationId: 'wrong' }),
    r => ({ ...r, region: 'kr' }), r => ({ ...r, archiveSha256: '0'.repeat(64) }),
    r => ({ ...r, publication: { ...r.publication, version: 65537 } }),
    r => ({ ...r, publication: { ...r.publication, id: 999 } }),
    r => ({ ...r, publication: { ...r.publication, private: false } }),
    r => ({ ...r, publication: { ...r.publication, headerHandle: 'invalid' } }),
  ]
  let change
  const f = await fixture(t, { publish: async request => change(receipt(request)) })
  for (const [index, transform] of changes.entries()) {
    change = transform
    const operationId = `unknown-${index}`
    await assert.rejects(f.provider.publish({ ...f.options, operationId,
      target: { mode: 'update', id: 99, expectedVersion: 65537 } }), error => {
      assert(error instanceof BattleNetPublishOutcomeUnknownError)
      assert.equal(error.operationId, operationId)
      return true
    })
    assert.equal(f.requests.length, index + 1)
  }
})

test('definitive rejection differs from a lost acknowledgement', async t => {
  const rejected = await fixture(t, { publish: async request => ({
    status: 'rejected', operationId: request.operationId, region: request.region, reason: 'name-conflict',
  }) })
  await assert.rejects(rejected.provider.publish({ ...rejected.options, operationId: 'rejected-1' }), error => {
    assert(code('publish-rejected')(error))
    assert.equal(error.operationId, 'rejected-1')
    assert.equal(error.reason, 'name-conflict')
    return true
  })
  const lost = await fixture(t, { publish: async () => { throw new Error('Connection lost') } })
  await assert.rejects(lost.provider.publish({ ...lost.options, operationId: 'lost-1' }), error => {
    assert(code('publish-outcome-unknown')(error))
    assert.equal(error.operationId, 'lost-1')
    return true
  })
  assert.equal(lost.requests.length, 1)
})

test('cancellation before submission makes no call; a confirmed receipt wins late cancellation', async t => {
  const controller = new AbortController()
  const f = await fixture(t, { publish: async request => {
    controller.abort()
    return receipt(request)
  } })
  const before = new AbortController()
  before.abort()
  await assert.rejects(f.provider.publish({ ...f.options, signal: before.signal }), { name: 'AbortError' })
  assert.equal(f.requests.length, 0)
  const result = await f.provider.publish({ ...f.options, signal: controller.signal,
    onProgress: async () => { throw new Error('Broken progress observer') } })
  assert.equal(result.status, 'published')
})

async function accounts(t, base, sessions) {
  let next = 0
  const provider = new BattleNetAccountsProvider({ cacheDirectory: base.directory, authentication: {
    supportedRegions: ['us', 'eu', 'kr'], async login() { return sessions[next++] },
  } })
  t.after(() => provider.dispose())
  return provider
}
function connected(accountId, region, api, close = async () => {}) {
  return { accountId, region, accountName: accountId, profileId: `${accountId}-${region}`,
    profileName: region, api, close }
}

test('publication selects exactly one account/region and serializes only that connection', async t => {
  const started = deferred()
  const finish = deferred()
  const a = await fixture(t, { publish: async request => { started.resolve(); await finish.promise; return receipt(request) } })
  const b = await fixture(t)
  const provider = await accounts(t, a, [connected('A', 'us', a.api), connected('B', 'us', b.api)])
  await provider.login({ region: 'us' })
  await provider.login({ region: 'us' })
  await assert.rejects(provider.publish({ ...a.options, accountId: 'missing' }), code('login-required'))
  await assert.rejects(provider.publish({ ...a.options, accountId: 'A', region: 'eu' }), code('login-required'))
  const active = provider.publish({ ...a.options, accountId: 'A' })
  await started.promise
  await assert.rejects(provider.publish({ ...a.options, accountId: 'A' }), code('publish-in-progress'))
  assert.equal((await provider.publish({ ...b.options, accountId: 'B' })).status, 'published')
  finish.resolve()
  await active
  assert.equal(a.requests.length, 1)
  assert.equal(b.requests.length, 1)
})

test('logout waits for publication cancellation and closes only its native connection once', async t => {
  const started = deferred()
  const aborted = deferred()
  const cleanup = deferred()
  let closed = 0
  const f = await fixture(t, { publish: async request => {
    started.resolve()
    await new Promise(resolve => {
      request.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true })
      if (request.signal.aborted) { aborted.resolve(); resolve() }
    })
    await cleanup.promise
    throw request.signal.reason
  } })
  const provider = await accounts(t, f, [connected('A', 'us', f.api, async () => { closed++ }), connected('B', 'us', f.api)])
  await provider.login({ region: 'us' })
  await provider.login({ region: 'us' })
  const publishing = provider.publish({ ...f.options, accountId: 'A', operationId: 'cancelled-upload' })
  const rejected = assert.rejects(publishing, error => code('publish-outcome-unknown')(error) && error.operationId === 'cancelled-upload')
  await started.promise
  let ended = false
  const closing = provider.logout('A', 'us').then(() => { ended = true })
  const closingAgain = provider.logout('A', 'us')
  await aborted.promise
  await setImmediate()
  assert.equal(ended, false)
  assert.equal(closed, 1)
  assert.equal(provider.listConnections()[0].accountId, 'B')
  cleanup.resolve()
  await Promise.all([closing, closingAgain, rejected])
  assert.equal(ended, true)
  assert.equal(closed, 1)
})

test('logoutAll permits later login; dispose waits for late-login cleanup and is terminal/idempotent', async t => {
  const f = await fixture(t)
  let closed = 0
  const finish = deferred()
  const sessionClosing = deferred()
  const finishClosing = deferred()
  let count = 0
  const provider = new BattleNetAccountsProvider({ cacheDirectory: f.directory, authentication: {
    supportedRegions: ['us'], async login() {
      if (++count === 1) return connected('A', 'us', f.api, async () => { closed++ })
      return finish.promise
    },
  } })
  t.after(() => provider.dispose())
  await provider.login({ region: 'us' })
  await provider.logoutAll()
  assert.equal(closed, 1)
  assert.deepEqual(provider.listConnections(), [])
  const pending = provider.login({ region: 'us' })
  const rejected = assert.rejects(pending, code('accounts-disposed'))
  let ended = false
  const disposing = provider.dispose()
  assert.equal(provider.dispose(), disposing)
  void disposing.then(() => { ended = true })
  finish.resolve(connected('B', 'us', f.api, async () => { sessionClosing.resolve(); await finishClosing.promise; closed++ }))
  await sessionClosing.promise
  assert.equal(ended, false)
  finishClosing.resolve()
  await Promise.all([disposing, rejected])
  assert.equal(closed, 2)
  await assert.rejects(provider.login({ region: 'us' }), code('accounts-disposed'))
  await assert.rejects(provider.publish({ ...f.options, accountId: 'A' }), code('accounts-disposed'))
})

test('real saved MPQ publication preparation preserves every byte (backend fixture only)', {
  skip: !process.env.MODKIT_BATTLENET_TEST_ARCHIVE,
}, async t => {
  const f = await fixture(t)
  const filePath = process.env.MODKIT_BATTLENET_TEST_ARCHIVE
  const before = hash(await readFile(filePath))
  const result = await f.provider.publish({ ...f.options, filePath })
  assert.equal(result.archiveSha256, before)
  assert.equal(hash(await readFile(filePath)), before)
  assert.equal(f.requests.length, 1)
})
