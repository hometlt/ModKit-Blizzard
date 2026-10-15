import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildInventory,
  createHostContributionContractRegistry,
  createExecutionBackendRegistry,
  linkedExtensionInputs,
  linkedInProcessBackend,
  openSubject,
  createBundledServiceDefinitionRegistry,
  registerServiceDefinitionsOrThrow,
  createHostServiceResolver,
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import type { JsonObject, PermissionGrant, ResourceBudget } from '@modkit/sdk'
import { sceneModule } from '@modkit/scene/module'
import { renderUvm } from '@modkit/scene/uvm/render'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3aEffectBindingFixture } from './fixtures/m3a-effect-binding.js'

const budget: ResourceBudget = {
  maxInputBytes: 64_000_000n,
  maxScalarBytes: 64_000_000,
  maxNodes: 1_000_000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const grant: PermissionGrant = { id: 'm3a-effects-host', classes: ['read-source'] }
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('effect host record absent')
  return value as JsonObject
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('effect host array absent')
  return value
}
function modes(particle: unknown): number[] {
  return array(object(object(particle)['sequenceAnimation'])['squirt']).map(raw => {
    const keys = array(object(object(raw)['track'])['keys'])
    return Number(array(object(keys[0])['vector'])[0])
  })
}

test('ordinary M3 host converts admitted effect sidecar and renders every combined clip through scene', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3a-effects-host-'))
  try {
    const base = await createM3aEffectBindingFixture(),
      sideBytes = await createM3aEffectBindingFixture({ sidecar: true })
    const primaryPath = join(directory, 'Hero.m3'),
      sidePath = join(directory, 'Hero-Effects.m3a')
    await writeFile(primaryPath, base, { flag: 'wx' })
    await writeFile(sidePath, sideBytes, { flag: 'wx' })
    const source = await openFileArtifactSource(primaryPath),
      side = await openFileArtifactSource(sidePath)
    const linked = linkedExtensionInputs([sceneModule])
    const backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
    const inventory = await buildInventory(
      [
        ...linked.inputs,
        {
          ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
          execution: { origin: 'bundled', allowTrustedInProcess: true },
        },
      ],
      createHostContributionContractRegistry(),
    )
    const definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const opened = await openSubject({
      inventory,
      source,
      path: primaryPath,
      intent: 'full',
      target,
      grant,
      budget,
      executionBackends: backends,
      serviceDefinitions: definitions,
      resolveInput: createFilesystemInputResolver({ primaryPath, roots: [directory], inventory }),
      logicalResourceDiscovery: [
        {
          role: 'sidecar',
          extension: '.m3a',
          async discover() {
            return {
              state: 'complete',
              context: { primaryLogicalId: 'Hero.m3', rootId: 'effects-fixture' },
              candidates: [
                {
                  logicalId: 'Hero-Effects.m3a',
                  rootId: 'effects-fixture',
                  expectedRevision: side.revision,
                  size: BigInt(sideBytes.length),
                  scopes: ['sibling-directory'],
                },
              ],
              receipt: {
                complete: true,
                pages: 1,
                entries: 1,
                candidates: 1,
                bytes: BigInt(sideBytes.length),
              },
            }
          },
        },
      ],
    })
    if (opened.state !== 'opened') throw new Error(`effect fixture open failed: ${opened.reason}`)
    const services = createHostServiceResolver({
      inventory,
      definitions,
      executionBackends: backends,
      target,
      grant,
      budgets: budget,
    })
    try {
      const converted = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (converted.state !== 'ok' || converted.output.kind !== 'bytes')
        throw new Error('effect fixture UVM conversion failed')
      const container = readUvmContainer(converted.output.value)
      const particles = array(
        object(object(container.document['extensions'])['UV_game_effects'])['particles'],
      )
      assert.equal(particles.length, 2)
      assert(!JSON.stringify(container.document).includes('Hero-Effects.m3a'))
      const envelope = object(object(container.document['extras'])['BlizzardM3'])
      assert.deepEqual(Object.keys(object(envelope['mapping'])), ['frame'])
      const clips = readUvmAnimationClips(container.document)
      if (clips === undefined || clips.length === 0) throw new Error('base effect clips absent')
      assert(clips.every(clip => !clip.sourceId?.includes('Hero-Effects.m3a')))
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      for (const clip of clips) {
        const frame = await renderUvm(
          converted.output.value,
          {
            schemaVersion: 1,
            viewport: { width: 32, height: 32 },
            camera: {
              viewProjection: [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1],
              viewMatrix: identity,
            },
            clipId: clip.id,
            time: 0.75,
            collisions: false,
            rendererId: 'modkit.headless',
          },
          { contracts: services.port, budget },
        )
        assert.equal(frame.width, 32)
        assert.equal(frame.height, 32)
        assert(!frame.diagnostics.some(item => item.severity === 'error'))
      }
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (
      dirname(cleanup) !== resolve(tmpdir()) ||
      !basename(cleanup).startsWith('modkit-m3a-effects-host-')
    )
      throw new Error('unexpected host effect fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
})
