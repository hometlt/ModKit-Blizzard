import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { abiVersion, createProvider, provides } from '@modkit/blizzard-starcraft2'

test('the exported StarCraft II discovery provider loads without the Modkit workspace', async () => {
  assert.equal(abiVersion, 1)
  assert.equal(provides.length, 1)

  const lease = createProvider({ contract: provides[0], major: 1 })
  assert.equal(lease.value.contract, provides[0])
  assert.deepEqual(lease.value.gameIds, ['blizzard/starcraft-2'])
  assert.equal(typeof lease.value.discover, 'function')
  await lease.release()
})

test('the repository advertises one StarCraft II extension root', async () => {
  const repository = JSON.parse(
    await readFile(new URL('../modkit.repository.json', import.meta.url), 'utf8'),
  )
  const sc2Roots = repository.extensions.filter(extension =>
    extension.id.startsWith('blizzard/starcraft2'),
  )
  assert.deepEqual(sc2Roots, [{ id: 'blizzard/starcraft2', path: 'starcraft2' }])
})

test('the standalone repository loads its SC2 codecs, language layers, and linked extensions', async () => {
  const [mapCodec, bankCodec, dataLanguage, triggerLanguage, workspaceLinks, galaxyLanguage, game] =
    await Promise.all([
      import('../starcraft2/dist/modules/map/codecs/package/portable/codec.mjs'),
      import('../starcraft2/modules/banks/codecs/bank/runtime.js'),
      import('../starcraft2/modules/data/providers/language/runtime.js'),
      import('../starcraft2/modules/triggers/providers/language/runtime.js'),
      import('@modkit/blizzard-starcraft2/galaxy/sc2-workspace-links'),
      import('@modkit/blizzard-starcraft2/galaxy/provider'),
      import('@modkit/blizzard-starcraft2/game-linked'),
    ])

  assert.equal(mapCodec.abiVersion, 1)
  assert.equal(typeof mapCodec.createCodec, 'function')
  assert.equal(bankCodec.abiVersion, 1)
  assert.equal(typeof bankCodec.createCodec, 'function')
  assert.equal(typeof dataLanguage.createProvider, 'function')
  assert.equal(typeof triggerLanguage.createProvider, 'function')
  assert.equal(typeof workspaceLinks.createSc2WorkspaceLinkIndex, 'function')
  assert.equal(typeof galaxyLanguage.createProvider, 'function')
  assert.equal(game.starcraft2Game.coordinate, 'blizzard/starcraft2-game')
})
