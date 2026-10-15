import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VirtualFileSystem, collectStream } from '@modkit/vfs'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { BattleNetAccountsProvider } from '@modkit/blizzard-starcraft2/battlenet/accounts/node'

const sha = value => createHash('sha256').update(value).digest('hex')
const code = value => error => error?.code === `blizzard.battlenet/${value}`
const list = async (mount, path = '') => { const entries = []; for await (const entry of mount.list(path)) entries.push(entry); return entries }

function session(accountId, region, { profileId = `${accountId}:${region}:profile`, text = `${accountId}/${region}` } = {}) {
  const bytes = encodeFreshMpq([{ path: 'owner.txt', bytes: new TextEncoder().encode(text) }], 1024 * 1024)
  const expired = new AbortController()
  const calls = { listed: 0, resolved: 0, downloaded: 0, closed: 0 }
  const api = {
    async listPublished(request) {
      assert.equal(request.region, region)
      request.signal.throwIfAborted()
      calls.listed++
      return { items: [{ id: 42, version: 65537, name: 'Same name', isMod: true,
        headerHandle: `73326d6800005553${sha(bytes)}` }] }
    },
    async resolveArchive(request) {
      assert.equal(request.region, region)
      calls.resolved++
      return { sha256: sha(bytes), size: bytes.length, kind: 'mpq' }
    },
    async *downloadArchive(request) {
      assert.equal(request.region, region)
      request.signal.throwIfAborted()
      calls.downloaded++
      yield bytes
    },
  }
  return { accountId, region, profileId, accountName: `Account ${accountId}`, profileName: `Profile ${region}`,
    api, signal: expired.signal, expired, calls, async close() { calls.closed++ },
    credential: 'test-only-secret-must-not-appear-in-connection-list' }
}

async function setup(t, login, supportedRegions = ['us', 'eu', 'kr']) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'modkit-bnet-accounts-'))
  const requests = []
  const provider = new BattleNetAccountsProvider({ cacheDirectory, authentication: {
    supportedRegions,
    login: async request => { requests.push(request); return login(request) },
  } })
  const vfs = new VirtualFileSystem().registerProvider(provider)
  t.after(async () => {
    await provider.dispose()
    await vfs.dispose()
    await rm(cacheDirectory, { force: true, recursive: true })
  })
  const openMount = async (accountId, region) => {
    const mount = await vfs.openMount(provider.uri({ accountId, region }))
    return mount
  }
  return { provider, requests, vfs, openMount }
}

async function owner(mount) {
  const [folder] = await list(mount)
  const source = await mount.open(`${folder.path}/owner.txt`)
  return { source, text: new TextDecoder().decode(await collectStream(source.stream())) }
}

test('login selects regional sessions, aliases NA to US, and exposes only connection metadata', async t => {
  const sessions = []
  const fixture = await setup(t, request => {
    const result = session(request.expectedAccountId ?? `new-${sessions.length}`, request.region)
    sessions.push(result)
    return result
  })
  const a = await fixture.provider.login({ region: 'na' })
  await fixture.provider.login({ accountId: a.accountId, region: 'eu' })
  await fixture.provider.login({ accountId: a.accountId, region: 'kr' })
  const b = await fixture.provider.login({ region: 'us' })
  assert.deepEqual(fixture.requests.map(request => request.region), ['us', 'eu', 'kr', 'us'])
  assert.equal(new Set(fixture.requests.map(request => request.browserSessionId)).size, 4)
  assert.equal(fixture.provider.listConnections().length, 4)
  assert(!JSON.stringify(fixture.provider.listConnections()).includes('secret'))
  assert(fixture.provider.listConnections().every(item => !('api' in item) && !('signal' in item)))
  const again = await fixture.provider.login({ accountId: a.accountId, region: 'na' })
  assert.deepEqual(again, a)
  assert.equal(fixture.requests.length, 4)
  const mounts = []
  for (const [accountId, region] of [[a.accountId, 'na'], [a.accountId, 'eu'], [a.accountId, 'kr'], [b.accountId, 'us']]) {
    const mount = await fixture.openMount(accountId, region)
    mounts.push(mount)
    const result = await owner(mount)
    assert.equal(result.text, `${accountId}/${region === 'na' ? 'us' : region}`)
    await result.source.dispose()
  }
  assert.equal(new Set(mounts.map(mount => mount.id)).size, 4)
  assert(sessions.every(item => item.calls.downloaded === 1))
})

test('account selector is required when ambiguous and never falls back to another account/region', async t => {
  let counter = 0
  const fixture = await setup(t, request => session(`account-${++counter}`, request.region))
  await assert.rejects(fixture.vfs.openMount('battlenet://us/mine'), code('login-required'))
  const a = await fixture.provider.login({ region: 'us' })
  const single = await fixture.vfs.openMount('battlenet://na/mine')
  assert.equal(new URL(single.id).searchParams.get('account'), a.accountId)
  await single.dispose()
  await fixture.provider.login({ region: 'us' })
  await assert.rejects(fixture.vfs.openMount('battlenet://us/mine'), code('account-required'))
  await assert.rejects(fixture.openMount(a.accountId, 'eu'), code('login-required'))
  await assert.rejects(fixture.openMount('missing-account', 'us'), code('login-required'))
  for (const uri of ['battlenet://us/mine?account=', 'battlenet://us/mine?account=a&account=b',
    'battlenet://user@us/mine', 'battlenet://us/mine/%2e%2e?account=account-1']) {
    await assert.rejects(fixture.vfs.openMount(uri), code('invalid-uri'))
  }
})

test('logout invalidates old file sources in only the selected account/region', async t => {
  const sessions = [session('A', 'us'), session('A', 'eu'), session('B', 'us')]
  let next = 0
  const fixture = await setup(t, () => sessions[next++])
  await fixture.provider.login({ region: 'us' })
  await fixture.provider.login({ accountId: 'A', region: 'eu' })
  await fixture.provider.login({ region: 'us' })
  const aUS = await owner(await fixture.openMount('A', 'us'))
  const aEU = await owner(await fixture.openMount('A', 'eu'))
  const b = await owner(await fixture.openMount('B', 'us'))
  await fixture.provider.logout('A', 'na')
  await assert.rejects(aUS.source.size(), code('logged-out'))
  assert(await aEU.source.size() > 0)
  assert(await b.source.size() > 0)
  assert.equal(fixture.provider.listConnections().length, 2)
  await fixture.provider.logout('A')
  await assert.rejects(aEU.source.size(), code('logged-out'))
  assert(await b.source.size() > 0)
  assert.deepEqual(sessions.map(item => item.calls.closed), [1, 1, 0])
  await fixture.provider.dispose()
  await assert.rejects(b.source.size(), code('accounts-disposed'))
  assert.deepEqual(sessions.map(item => item.calls.closed), [1, 1, 1])
})

test('a fresh browser returning the wrong account/region is closed and not adopted', async t => {
  const wrongAccount = session('wrong', 'eu')
  const fixture = await setup(t, () => wrongAccount)
  await assert.rejects(fixture.provider.login({ accountId: 'expected', region: 'eu' }), code('account-mismatch'))
  assert.equal(wrongAccount.calls.closed, 1)
  assert.deepEqual(fixture.provider.listConnections(), [])
  const wrongRegion = session('expected', 'us')
  const other = await setup(t, () => wrongRegion)
  await assert.rejects(other.provider.login({ accountId: 'expected', region: 'kr' }), code('region-mismatch'))
  assert.equal(wrongRegion.calls.closed, 1)
})

test('unsupported backend regions fail before opening a browser; cancellation closes late sessions', async t => {
  let finish
  const fixture = await setup(t, () => new Promise(resolve => { finish = resolve }), ['us'])
  await assert.rejects(fixture.provider.login({ region: 'eu' }), code('login-region-unavailable'))
  assert.equal(fixture.requests.length, 0)
  const controller = new AbortController()
  const login = fixture.provider.login({ region: 'na', signal: controller.signal })
  const rejected = assert.rejects(login, { name: 'AbortError' })
  controller.abort()
  const late = session('late', 'us')
  finish(late)
  await rejected
  assert.equal(late.calls.closed, 1)
  assert.deepEqual(fixture.provider.listConnections(), [])
})

test('logout/dispose during an unknown-account login cannot reconnect it later', async t => {
  let finish
  const fixture = await setup(t, () => new Promise(resolve => { finish = resolve }))
  const login = fixture.provider.login({ region: 'eu' })
  const rejected = assert.rejects(login, code('login-cancelled'))
  await fixture.provider.logout('A')
  const late = session('A', 'eu')
  finish(late)
  await rejected
  assert.equal(late.calls.closed, 1)
  const second = fixture.provider.login({ region: 'kr' })
  const secondRejected = assert.rejects(second, code('accounts-disposed'))
  const disposing = fixture.provider.dispose()
  const afterDispose = session('B', 'kr')
  finish(afterDispose)
  await secondRejected
  await disposing
  assert.equal(afterDispose.calls.closed, 1)
})

test('expiration requires reauthentication and cached archives remain scoped to account/profile/region', async t => {
  const sessions = [session('A', 'us', { text: 'identical' }), session('A', 'us', { text: 'identical' }),
    session('B', 'us', { text: 'identical' }), session('A', 'eu', { text: 'identical' }),
    session('A', 'us', { text: 'identical', profileId: 'other-profile' })]
  let next = 0
  const fixture = await setup(t, () => sessions[next++])
  await fixture.provider.login({ region: 'us' })
  const expired = await owner(await fixture.openMount('A', 'us'))
  sessions[0].expired.abort(new Error('Native session expired'))
  await assert.rejects(expired.source.size(), /Native session expired/u)
  await assert.rejects(fixture.openMount('A', 'us'), code('login-required'))
  await fixture.provider.login({ accountId: 'A', region: 'us' })
  await owner(await fixture.openMount('A', 'us'))
  assert.equal(sessions[0].calls.closed, 1)
  assert.equal(sessions[1].calls.downloaded, 0)
  await fixture.provider.login({ region: 'us' })
  await owner(await fixture.openMount('B', 'us'))
  assert.equal(sessions[2].calls.downloaded, 1)
  await fixture.provider.login({ accountId: 'A', region: 'eu' })
  await owner(await fixture.openMount('A', 'eu'))
  assert.equal(sessions[3].calls.downloaded, 1)
  await fixture.provider.logout('A', 'us')
  await fixture.provider.login({ accountId: 'A', region: 'us' })
  await owner(await fixture.openMount('A', 'us'))
  assert.equal(sessions[4].calls.downloaded, 1)
})

test('simultaneous logins for the same identity keep one session and close the redundant one', async t => {
  const sessions = [session('A', 'us'), session('A', 'us')]
  let next = 0
  const fixture = await setup(t, () => sessions[next++])
  const results = await Promise.all([fixture.provider.login({ region: 'us' }), fixture.provider.login({ region: 'na' })])
  assert.deepEqual(results[0], results[1])
  assert.equal(fixture.provider.listConnections().length, 1)
  assert.deepEqual(sessions.map(item => item.calls.closed), [0, 1])
})
