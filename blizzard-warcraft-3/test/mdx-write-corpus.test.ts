/** Discovery/ContentSources → Host model.write/reopen; not native Editor or byte-equality proof. */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRUSTED_IN_PROCESS_EXECUTION_BACKEND, buildInventory, createExecutionBackendRegistry,
  createHostContributionContractRegistry, openSubject } from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { discoverWarcraft3Installations } from '../dist/game/installation.js'
import { createContentSources } from '../dist/game/content-sources.js'
import { source } from './war3-harness.js'

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('MDX writer installed corpus', () => {
  it('keeps shipped SD models writable through source-chunk admission', async ({ skip }) => {
    const discovery = await discoverWarcraft3Installations({ gameId: 'blizzard/warcraft-3', maxCandidates: 16 })
    const installation = discovery.installations[0]
    if (installation === undefined) { skip(); return }
    const sources = await createContentSources({ installationDirectory: installation.normalizedPath, artSet: 'sd' })
    const path = 'Abilities/Spells/Other/BreathOfFire/BreathOfFireMissile.mdx'
    try {
      const bytes = await sources.read('local:warcraft3', path, 16_777_216)
      const inventory = await buildInventory([{ ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
        execution: { origin: 'bundled', allowTrustedInProcess: true },
      }], createHostContributionContractRegistry())
      const common = { inventory, target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const,
        executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
        grant: { id: 'wc3-native-write-corpus', classes: ['read-source'] } as const,
        budget: { maxInputBytes: 16_777_216n, maxScalarBytes: 16_777_216, maxDepth: 64, maxNodes: 100_000, maxDiagnostics: 100 },
        path, intent: 'full' as const }
      const opened = await openSubject({ ...common, source: source(bytes) })
      if (opened.state !== 'opened') throw new Error(`native input failed: ${JSON.stringify(opened).slice(0, 1000)}`)
      try {
        const original = await opened.session.operations().invoke('inspect', null)
        if (original.state !== 'ok' || original.output.kind !== 'json') throw new Error('native inspection failed')
        const facts = original.output.value as Record<string, unknown>
        expect(facts['particleEmitters']).toBeGreaterThan(0)
        for (const encoding of ['mdx', 'mdl'] as const) {
          const written = await opened.session.operations().invoke('model-write', { schemaVersion: 1, encoding })
          if (written.state !== 'ok' || written.output.kind !== 'bytes') throw new Error(`native write failed: ${JSON.stringify(written)}`)
          const reopened = await openSubject({ ...common, path: `rewritten.${encoding}`, source: source(written.output.value as Uint8Array) })
          if (reopened.state !== 'opened') throw new Error(`native output did not reopen: ${reopened.state}`)
          try {
            const inspected = await reopened.session.operations().invoke('inspect', null)
            if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error('written inspection failed')
            expect(inspected.output.value).toMatchObject({ geosets: facts['geosets'], particleEmitters: facts['particleEmitters'],
              sequences: facts['sequences'], encoding })
          } finally { await reopened.session.dispose() }
        }
        console.log('WC3_NATIVE_WRITE', JSON.stringify({ version: installation.version, artSet: 'sd', path, bytes: bytes.length,
          geosets: facts['geosets'], particles: facts['particleEmitters'], encodings: ['mdx', 'mdl'] }))
      } finally { await opened.session.dispose() }
    } finally { await sources.dispose() }
  }, 180_000)
})
