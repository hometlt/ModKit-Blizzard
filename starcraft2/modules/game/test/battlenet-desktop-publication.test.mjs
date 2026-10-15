import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMemorySource } from '@modkit/vfs'
import { publishDesktopPackage } from '../../../dist/modules/game/battlenet/publishing/desktop-publication.js'
const hash = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, region = 'us') {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-prepared-publication-'))
  const archive = Buffer.from('snapshot archive'), header = Buffer.from('header'), locale = Buffer.from('locale')
  await writeFile(join(directory, 'header.s2mh'), header); await writeFile(join(directory, 'locale.s2ml'), locale)
  const manifest = { schema: 1, region, name: 'Test', locale: 'enUS', kind: 'mod', archiveSha256: hash(archive),
    header: { file: 'header.s2mh', sha256: hash(header) }, locales: [{ file: 'locale.s2ml', sha256: hash(locale) }], metadata: {} }
  const raw = JSON.stringify(manifest), packagePath = join(directory, 'test.modkit-publish.json')
  await writeFile(packagePath, raw)
  const source = createMemorySource('test', archive)
  t.after(async () => { await source.dispose(); await rm(directory, { recursive: true, force: true }) })
  const request = { operationId: 'reviewed-operation', region, name: 'Test', locale: 'enUS', kind: 'mod',
    fileName: 'test.SC2Mod', target: { mode: 'create' }, visibility: 'private', locked: true,
    packagePath, packageSha256: hash(raw), archiveSha256: hash(archive), archiveBytes: archive.length,
    source, signal: new AbortController().signal, onProgress() {} }
  return { directory, archive, header, locale, manifest, request }
}
test('stages exact immutable components outside IPC and removes them after the native result', async t => {
  for (const region of ['us', 'eu', 'kr']) {
    const f = await fixture(t, region)
    let stage
    const receipt = { status: 'rejected', operationId: f.request.operationId, region, reason: 'synthetic preflight rejection' }
    const result = await publishDesktopPackage(f.request, f.directory, `account/profile/${region}`, async (method, signal, payload) => {
      assert.equal(method, 'publish'); assert.equal(signal, f.request.signal)
      assert(!JSON.stringify(payload).includes('snapshot archive'))
      assert(!payload.journalDirectory.includes('account'))
      const normalized = JSON.parse(await readFile(payload.packageFile, 'utf8'))
      stage = payload.packageFile.slice(0, -'/package.json'.length)
      assert.equal(normalized.operationId, f.request.operationId)
      assert.equal(normalized.region, region)
      assert.deepEqual(await readFile(join(stage, normalized.archiveFile)), f.archive)
      assert.deepEqual(await readFile(join(stage, normalized.files[0].file)), f.header)
      return receipt
    })
    assert.equal(result, receipt)
    await assert.rejects(readdir(stage), { code: 'ENOENT' })
  }
})
test('reviewed package tampering, component tampering and traversal never reach native RPC', async t => {
  const f = await fixture(t)
  const unused = async () => { assert.fail('Must not call the native transport') }
  await writeFile(f.request.packagePath, '{}')
  await assert.rejects(publishDesktopPackage(f.request, f.directory, 'a', unused), /changed after review/)
  await writeFile(f.request.packagePath, JSON.stringify(f.manifest))
  await writeFile(join(f.directory, 'header.s2mh'), 'changed')
  await assert.rejects(publishDesktopPackage(f.request, f.directory, 'a', unused), /SHA-256/)
  f.manifest.header.file = '../header.s2mh'
  const raw = JSON.stringify(f.manifest)
  await writeFile(f.request.packagePath, raw)
  await assert.rejects(publishDesktopPackage({ ...f.request, packageSha256: hash(raw) }, f.directory, 'a', unused), /component/)
})
test('archive-only input is explicitly rejected instead of guessing compiled metadata', async t => {
  const f = await fixture(t)
  const result = await publishDesktopPackage({ ...f.request, packagePath: undefined }, f.directory, 'a', async () => assert.fail())
  assert.equal(result.status, 'rejected'); assert.match(result.reason, /prepared/)
})
