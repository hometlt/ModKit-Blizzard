/**
 * Options every SC2 content-source entry point takes from the host. `battlenet-local-sources.test.mjs`
 * is pinned by hash as feature-ledger evidence, so cases added later live here.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { hostLocalOptions } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'

test('every entry point takes the shared index cache and its switches from the host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-index-cache-'))
  try {
    const raw = { documentsDirectory: directory, battleNetCacheDirectory: directory, sc2MapsCacheDirectory: directory }
    const options = await hostLocalOptions(raw, { indexCacheDirectory: directory, indexCaches: { s2: { names: false } } })
    assert.equal(options.indexCacheDirectory, directory)
    assert.deepEqual(options.indexCaches, { s2: { names: false } })
    // A relative directory is not the host's: the CASC index keeps this source's own place.
    assert.equal((await hostLocalOptions(raw, { indexCacheDirectory: 'relative' })).indexCacheDirectory, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
