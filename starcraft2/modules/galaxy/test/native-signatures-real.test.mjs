import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createContentSources } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'
import { inventoryGalaxyNativeSignatures } from '../../../dist/modules/galaxy/services/analysis/native-signatures.js'

const install = process.env.MODKITX_SC2_ROOT ?? 'C:/Apps/StarCraft II'

test('all Core.SC2Mod Galaxy native signatures are inventoried via ModContext without stubs',
  { skip: process.platform !== 'win32' || process.env.MODKIT_TEST_INSTALLED_CORPUS === '0' ||
    !existsSync(join(install, '.build.info')), timeout: 300_000 }, async () => {
    const sources = await createContentSources({ installationDirectory: install })
    let context
    try {
      context = await sources.openModContext({ schemaVersion: 1,
        target: { sourceId: 'local:casc', path: 'mods/core.sc2mod' } })
      const layer = context.layers.at(-1)
      assert.ok(layer)
      const listed = await context.files(layer.id, { limit: 10_000,
        prefix: 'base.sc2data/triggerlibs/' })
      assert.equal(listed.nextCursor, undefined, 'native corpus listing must be complete')
      const paths = listed.items.filter(item => /\.galaxy$/iu.test(item))
      assert.ok(paths.length > 100)
      const signatures = new Map()
      let nativeDeclarations = 0
      for (const path of paths) {
        const bytes = await context.read(layer.id, path, 16 * 1024 * 1024)
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const inventory = inventoryGalaxyNativeSignatures(source, path)
        nativeDeclarations += inventory.signatures.length
        for (const signature of inventory.signatures) {
          assert.ok(source.includes(signature.fragment))
          const prior = signatures.get(signature.name)
          if (prior !== undefined) assert.deepEqual(
            [signature.returnType, signature.parameters], [prior.returnType, prior.parameters],
            `conflicting native signature ${signature.name}`)
          signatures.set(signature.name, signature)
        }
      }
      assert.ok(nativeDeclarations >= signatures.size)
      assert.ok(signatures.size > 2_500)
      assert.ok([...signatures.values()].every(item => item.admission === 'unmapped-native'))
      const create = signatures.get('UnitCreate')
      assert.deepEqual(create?.parameters.map(item => item.type),
        ['int', 'string', 'int', 'int', 'point', 'fixed'])
      assert.equal(create.admission, 'unmapped-native')
    } finally {
      await context?.dispose()
      await sources.dispose()
    }
  })
