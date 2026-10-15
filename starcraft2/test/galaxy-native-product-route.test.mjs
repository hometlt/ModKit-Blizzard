/** Installed native file → ModContext → ordinary host Galaxy codec operation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactByteSourceFromRandomAccess, buildInventory,
  createExecutionBackendRegistry, createHostContributionContractRegistry,
  openSubject, TRUSTED_IN_PROCESS_EXECUTION_BACKEND } from '../../../modkit-core/packages/host/dist/index.js'
import { loadExtensionDirectory } from '../../../modkit-core/packages/host/dist/node/index.js'
import { revisionId } from '../../../modkit-core/packages/sdk/dist/index.js'
import { createMemorySource } from '../../../modkit-core/packages/vfs/dist/index.js'
import { createContentSources } from '../dist/modules/game/battlenet/content-sources/local-content-sources.js'

const install = process.env.MODKITX_SC2_ROOT ?? 'C:/Apps/StarCraft II'

test('Galaxy native signatures are queryable through the public host operation',
  { skip: process.platform !== 'win32' || process.env.MODKIT_TEST_INSTALLED_CORPUS === '0' ||
    !existsSync(join(install, '.build.info')), timeout: 300_000 }, async () => {
    const sources = await createContentSources({ installationDirectory: install })
    let context
    let opened
    let source
    try {
      context = await sources.openModContext({ schemaVersion: 1,
        target: { sourceId: 'local:casc', path: 'mods/core.sc2mod' } })
      const layer = context.layers.at(-1)
      assert.ok(layer)
      const bytes = await context.read(layer.id, 'base.sc2data/triggerlibs/natives.galaxy', 16 * 1024 * 1024)
      source = createMemorySource('installed-core-natives', bytes)
      const artifact = await artifactByteSourceFromRandomAccess(source, {
        ref: { id: 'installed-core-natives', uri: 'memory:Natives.galaxy' },
        revision: revisionId('provider-token:installed-core-natives'),
      })
      const extension = await loadExtensionDirectory(fileURLToPath(new URL('../', import.meta.url)))
      const inventory = await buildInventory([{
        ...extension, execution: { origin: 'bundled', allowTrustedInProcess: true },
      }], createHostContributionContractRegistry())
      opened = await openSubject({
        inventory, source: artifact, path: 'Natives.galaxy', intent: 'full',
        executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
        grant: { id: 'installed-galaxy-native-operation', classes: ['read-source'] },
        budget: { maxInputBytes: 16_777_216n, maxDepth: 128, maxNodes: 1_000_000,
          maxScalarBytes: 16_777_216, maxDiagnostics: 100 },
      })
      assert.equal(opened.state, 'opened', opened.reason)
      assert.equal(opened.selected.contributionId, 'blizzard/galaxy')
      const result = await opened.session.operations().invoke('native-signatures', { limit: 2 })
      assert.equal(result.state, 'ok', JSON.stringify(result))
      assert.equal(result.output.kind, 'json')
      assert.ok(result.output.value.total > 2_000)
      assert.equal(result.output.value.items.length, 2)
      assert.equal(result.output.value.items[0].admission, 'unmapped-native')
      assert.equal(result.output.value.nextOffset, 2)
    } finally {
      if (opened?.state === 'opened') await opened.session.dispose()
      source?.dispose()
      await context?.dispose()
      await sources.dispose()
    }
  })
