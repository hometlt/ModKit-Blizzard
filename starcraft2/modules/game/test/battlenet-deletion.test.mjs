import assert from 'node:assert/strict'
import test from 'node:test'
import { BattleNetVfsProvider } from '../../../dist/modules/game/battlenet/content-sources/vfs-provider.js'
const item = { id: 19, version: 65537, name: 'Owned mod', isMod: true, headerHandle: '73326d6800004555' + 'a'.repeat(64) }
const setup = (t, backend) => {
  const provider = new BattleNetVfsProvider({ profileKey: 'test', region: 'eu', cacheDirectory: '.', api: {
    listPublished: async () => ({ items: [item] }), resolveArchive: async () => { throw new Error('unused') },
    async *downloadArchive() {}, deletePublication: backend,
  } })
  t.after(() => provider.dispose()); return provider
}
const receipt = request => ({ status: 'unlinked', region: request.region, operationId: request.operationId,
  id: request.publication.id, version: request.publication.version, serverUnlinkVerified: true })
test('deletion binds a concrete revision/region and accepts only a verified native receipt', async t => {
  let calls = 0
  const provider = setup(t, async request => { calls++; assert.equal(request.region, 'eu'); assert(Object.isFrozen(request.publication)); return receipt(request) })
  assert.equal((await provider.deletePublication({ region: 'eu', publication: item })).status, 'unlinked')
  await assert.rejects(provider.deletePublication({ region: 'kr', publication: item }), /another region/)
  assert.equal(calls, 1)
})
test('lost acknowledgements and wrong receipts never trigger automatic retries', async t => {
  for (const response of [undefined, { id: 20 }, { serverUnlinkVerified: false }]) {
    let calls = 0
    const provider = setup(t, async request => { calls++; if (!response) throw new Error('lost'); return { ...receipt(request), ...response } })
    await assert.rejects(provider.deletePublication({ region: 'eu', publication: item, operationId: 'op' }), error => {
      assert.equal(error.code, 'blizzard.battlenet/delete-outcome-unknown'); assert.equal(error.operationId, 'op'); return true
    })
    assert.equal(calls, 1)
  }
})
test('dispose cancels deletion and waits for the active native operation', async t => {
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const provider = setup(t, request => new Promise((_resolve, reject) => {
    entered(); request.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })
  }))
  const result = provider.deletePublication({ region: 'eu', publication: item })
  const rejected = assert.rejects(result, /Reconcile/)
  await ready
  await assert.rejects(provider.deletePublication({ region: 'eu', publication: item }), /active/)
  await provider.dispose(); await rejected
})
