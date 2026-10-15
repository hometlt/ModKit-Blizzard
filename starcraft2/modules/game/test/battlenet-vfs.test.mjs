import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VirtualFileSystem, collectStream } from '@modkit/vfs'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import {
  BattleNetVfsProvider, battleNetPublicationDirectory,
} from '@modkit/blizzard-starcraft2/battlenet/vfs/node'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const header = seed => `73326d6800005553${sha256(seed)}`
const publication = (id = 17, name = 'Example', version = 65537) => ({
  id, name, version, isMod: true, headerHandle: header(`${id}:${version}`), private: true,
})
const pack = entries => encodeFreshMpq(Object.entries(entries).map(([path, text]) => ({
  path, bytes: new TextEncoder().encode(text),
})), 1024 * 1024)
const payload = pack({ 'DocumentInfo': '<DocInfo/>', 'Base.SC2Data/GameData/Units.xml': '<Catalog/>', 'empty.txt': '' })
const list = async (mount, path = '', signal) => { const items = []; for await (const item of mount.list(path, signal)) items.push(item); return items }
const code = expected => error => error?.code === `blizzard.battlenet/${expected}`

async function setup(t, { items = [publication()], bytes = payload, limits, profileKey = 'test-profile', cacheDirectory, api: overrides = {} } = {}) {
  const directory = cacheDirectory ?? await mkdtemp(join(tmpdir(), 'modkit-battlenet-test-'))
  if (!cacheDirectory) t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = { list: 0, search: 0, resolve: 0, download: 0 }
  const api = {
    async listPublished() { calls.list++; return { items } },
    async searchMods({ name }) { calls.search++; return { items: items.filter(item => item.name.includes(name)) } },
    async resolveArchive() { calls.resolve++; return { sha256: sha256(bytes), kind: 'mpq', size: bytes.length } },
    async *downloadArchive({ signal }) {
      calls.download++
      for (let offset = 0; offset < bytes.length; offset += 31) {
        signal.throwIfAborted()
        yield bytes.slice(offset, offset + 31)
      }
    },
    ...overrides,
  }
  const provider = new BattleNetVfsProvider({ api, profileKey, cacheDirectory: directory, ...(limits ? { limits } : {}) })
  const vfs = new VirtualFileSystem().registerProvider(provider)
  const opened = []
  t.after(async () => { for (const mount of opened) await mount.dispose(); await vfs.dispose() })
  const openMount = async (uri = 'battlenet://us/mine', options) => {
    const mount = await vfs.openMount(uri, options)
    opened.push(mount)
    return mount
  }
  return { provider, vfs, openMount, calls, directory, api }
}

test('own publications paginate; root metadata and name filtering never download archives', async t => {
  const items = [publication(17, 'My / Mod'), publication(18, 'my / mod'), publication(19, 'Other')]
  const cursors = []
  const fixture = await setup(t, { api: {
    async listPublished({ cursor, region }) {
      assert.equal(region, 'us')
      cursors.push(cursor)
      return cursor ? { items: items.slice(1) } : { items: items.slice(0, 1), nextCursor: 'page-2' }
    },
  } })
  const mount = await fixture.openMount('battlenet://us/mine?name=MY%20%2F%20MOD')
  const nodes = await list(mount)
  assert.equal(nodes.length, 2)
  assert.equal(new Set(nodes.map(node => node.path)).size, 2)
  assert(nodes.every(node => node.kind === 'directory' && node.publication.private))
  assert.equal((await mount.stat(nodes[0].path)).kind, 'directory')
  assert.deepEqual(cursors, [undefined, 'page-2'])
  assert.equal(fixture.calls.resolve, 0)
  assert.equal(fixture.calls.download, 0)
})

test('public name search delegates to the API; unavailable search is explicit', async t => {
  const fixture = await setup(t)
  assert.equal((await list(await fixture.openMount('battlenet://eu/search?name=Example'))).length, 1)
  assert.equal(fixture.calls.search, 1)
  assert.equal(fixture.calls.list, 0)
  const unavailable = await setup(t, { api: { searchMods: undefined } })
  await assert.rejects(unavailable.openMount('battlenet://us/search?name=Example'), code('search-unavailable'))
})

test('the single-session provider normalizes NA and enforces configured account/region bindings', async t => {
  const fixture = await setup(t, { api: {
    async listPublished({ region }) { assert.equal(region, 'us'); return { items: [publication()] } },
  } })
  assert.equal((await list(await fixture.openMount('battlenet://na/mine'))).length, 1)
  const pinned = new BattleNetVfsProvider({ api: fixture.api, cacheDirectory: fixture.directory,
    profileKey: 'pinned', accountId: 'account-a', region: 'us' })
  const vfs = new VirtualFileSystem().registerProvider(pinned)
  t.after(() => vfs.dispose())
  await assert.rejects(vfs.openMount('battlenet://eu/mine?account=account-a'), code('region-mismatch'))
  await assert.rejects(vfs.openMount('battlenet://us/mine?account=account-b'), code('account-mismatch'))
  await assert.rejects(fixture.openMount('battlenet://us/mine?account=account-a'), code('account-mismatch'))
  const mount = await vfs.openMount('battlenet://na/mine?account=account-a')
  assert.equal((await list(mount)).length, 1)
  await mount.dispose()
})

test('lazy MPQ tree, random reads, streams, subdirectory mounts and persistent cache reopen', async t => {
  const fixture = await setup(t)
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  assert.equal(fixture.calls.download, 0)
  const [a, b] = await Promise.all([list(mount, root.path), list(mount, root.path)])
  assert.deepEqual(a, b)
  assert(a.some(node => node.name === 'Base.SC2Data' && node.kind === 'directory'))
  assert.equal(fixture.calls.download, 1)
  fixture.vfs.mount('remote', mount)
  const source = await fixture.vfs.open(`remote/${root.path}/Base.SC2Data/GameData/Units.xml`)
  assert.equal(new TextDecoder().decode(await source.readAt(1, 7)), 'Catalog')
  assert.equal(new TextDecoder().decode(await collectStream(source.stream())), '<Catalog/>')
  const empty = await mount.open(`${root.path}/empty.txt`)
  assert.equal(await empty.size(), 0)
  await empty.dispose()
  await source.dispose()
  const reopened = await setup(t, { cacheDirectory: fixture.directory })
  const inner = await reopened.openMount(`battlenet://us/mine/${encodeURIComponent(root.path)}/Base.SC2Data/GameData`)
  assert.equal((await list(inner))[0].path, 'Units.xml')
  const cached = await inner.open('Units.xml')
  assert.equal(new TextDecoder().decode(await cached.readAt(0, 10)), '<Catalog/>')
  assert.equal(reopened.calls.download, 0)
  await cached.dispose()
})

test('profile, region and concrete version scope prevent stale cache reuse', async t => {
  const first = await setup(t)
  const mount = await first.openMount()
  const [root] = await list(mount)
  await list(mount, root.path)
  const second = await setup(t, { profileKey: 'another-profile', cacheDirectory: first.directory })
  const secondMount = await second.openMount()
  await list(secondMount, root.path)
  assert.equal(second.calls.download, 1)
  const region = await first.openMount('battlenet://eu/mine')
  await list(region, root.path)
  assert.equal(first.calls.download, 2)
  const newer = await setup(t, { cacheDirectory: first.directory, items: [publication(17, 'Example', 65538)], bytes: pack({ 'new.txt': 'new version' }) })
  const newerMount = await newer.openMount()
  const [newRoot] = await list(newerMount)
  // A publication is named after itself (ef1722eb): its next version keeps the path. What must not
  // carry over is the cache — the mount's revision changes and the new archive is downloaded.
  assert.equal(newRoot.path, root.path)
  assert.notEqual(newerMount.revision, mount.revision)
  const entries = await list(newerMount, newRoot.path)
  assert.equal(newer.calls.download, 1)
  const names = entries.map(entry => entry.path.split('/').at(-1))
  assert.ok(names.includes('new.txt') && !names.includes('DocumentInfo'), names.join(', '))
})

test('SHA-256 mismatch leaves no complete cache file or partial download', async t => {
  const fixture = await setup(t, { api: {
    async *downloadArchive() { yield new Uint8Array(payload.length) },
  } })
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  await assert.rejects(list(mount, root.path), code('integrity'))
  const cache = join(fixture.directory, 'battlenet-v1', sha256('test-profile'), 'us')
  assert.deepEqual(await readdir(cache), [])
})

test('a corrupted disk cache is replaced by verified bytes', async t => {
  const fixture = await setup(t)
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  await list(mount, root.path)
  const file = join(fixture.directory, 'battlenet-v1', sha256('test-profile'), 'us', `${sha256(payload)}.s2ma`)
  await writeFile(file, new Uint8Array(payload.length))
  const reopened = await fixture.openMount()
  await list(reopened, root.path)
  assert.equal(fixture.calls.download, 2)
  assert.equal(sha256(await readFile(file)), sha256(payload))
})

test('cancelling one concurrent caller keeps the other caller alive', async t => {
  let started
  const starting = new Promise(resolve => { started = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let downloads = 0
  const fixture = await setup(t, { api: {
    async *downloadArchive({ signal }) {
      downloads++
      started()
      await gate
      signal.throwIfAborted()
      yield payload
    },
  } })
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  const controller = new AbortController()
  const first = list(mount, root.path, controller.signal)
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const second = list(mount, root.path)
  await starting
  controller.abort()
  release()
  await rejected
  assert((await second).length > 0)
  assert.equal(downloads, 1)
})

test('dispose cancels an in-flight download; subsequent mount retries', async t => {
  let started
  const starting = new Promise(resolve => { started = resolve })
  let downloads = 0
  const fixture = await setup(t, { api: {
    async *downloadArchive({ signal }) {
      downloads++
      if (downloads === 1) {
        started()
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      yield payload
    },
  } })
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  const pending = list(mount, root.path)
  const rejected = assert.rejects(pending)
  await starting
  mount.dispose()
  await rejected
  await assert.rejects(mount.stat(''), code('mount-disposed'))
  const next = await fixture.openMount()
  assert((await list(next, root.path)).length > 0)
})

test('mount read budgets are shared across files; invalid ranges and disposed sources fail', async t => {
  const fixture = await setup(t, { limits: { maxReadBytes: 5n, maxReadRangeBytes: 4, maxStreamBytes: 4n } })
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  const a = await mount.open(`${root.path}/DocumentInfo`)
  const b = await mount.open(`${root.path}/Base.SC2Data/GameData/Units.xml`)
  await assert.rejects(a.readAt(0.5, 1), code('read-range'))
  await assert.rejects(a.readAt(0, 5), code('range-limit'))
  assert.throws(() => b.stream(), code('stream-limit'))
  await a.readAt(0, 4)
  await b.readAt(0, 1)
  await assert.rejects(b.readAt(0, 1), code('read-limit'))
  await a.dispose()
  await assert.rejects(a.readAt(0, 1), code('source-disposed'))
  mount.dispose()
  await assert.rejects(b.size(), code('mount-disposed'))
})

test('entry, memory and streamed download limits fail without exposing partial trees', async t => {
  const huge = await setup(t, { limits: { maxMaterializedBytes: 32n } })
  const mount = await huge.openMount()
  const [root] = await list(mount)
  await assert.rejects(list(mount, root.path), code('archive-size-limit'))
  const stream = await setup(t, { limits: { maxMaterializedBytes: 32n }, api: {
    async resolveArchive() { return { sha256: sha256(payload), kind: 'mpq' } },
  } })
  await assert.rejects(list(await stream.openMount(), root.path), code('archive-size-limit'))
  const entries = await setup(t, { limits: { maxEntries: 1 } })
  await assert.rejects(list(await entries.openMount(), root.path))
})

test('URIs, VFS traversal and catalogue cursor loops are rejected', async t => {
  const fixture = await setup(t)
  for (const uri of ['https://us/mine', 'battlenet://us:123/mine', 'battlenet://user@us/mine',
    'battlenet://us/mine/%2e%2e', 'battlenet://us/search', 'battlenet://cn/mine', 'battlenet://us/mine?ticket=x']) {
    await assert.rejects(fixture.openMount(uri))
  }
  const mount = await fixture.openMount('battlenet://us')
  await assert.rejects(mount.stat('../escape'))
  const loop = await setup(t, { api: { async listPublished() { return { items: [], nextCursor: 'again' } } } })
  await assert.rejects(loop.openMount(), code('invalid-cursor'))
  const latest = await setup(t, { items: [publication(17, 'latest', 0)] })
  await assert.rejects(latest.openMount(), code('invalid-publication'))
})

test('Standard Data depot references are not presented as archives', async t => {
  const fixture = await setup(t, { api: {
    async resolveArchive() { return { sha256: sha256('Standard Data: Core.SC2Mod'), kind: 'standard-data' } },
  } })
  const mount = await fixture.openMount()
  const [root] = await list(mount)
  await assert.rejects(list(mount, root.path), code('standard-data-reference'))
  assert.equal(fixture.calls.download, 0)
})

test('real published MPQ: optional explicit local fixture, no installation discovery', {
  skip: !process.env.MODKIT_BATTLENET_TEST_ARCHIVE,
}, async t => {
  const bytes = new Uint8Array(await readFile(process.env.MODKIT_BATTLENET_TEST_ARCHIVE))
  const fixture = await setup(t, { bytes })
  const mount = await fixture.openMount()
  const directory = battleNetPublicationDirectory(publication())
  const expected = await openMpqReader(bytes, { maxArchiveBytes: bytes.length, maxEntries: 25000, maxEntryBytes: 1024 ** 3 })
  t.after(() => expected.dispose())
  assert(expected.entries.length > 0)
  for (const entry of expected.entries) {
    const source = await mount.open(`${directory}/${entry.path}`)
    assert.deepEqual(await collectStream(source.stream()), await expected.read(entry.id))
    await source.dispose()
  }
  assert.equal(fixture.calls.download, 1)
})
