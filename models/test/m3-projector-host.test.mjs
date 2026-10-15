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
import { sceneModule } from '@modkit/scene/module'
import { renderUvm } from '@modkit/scene/uvm/render'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3FieldEffectsFixture } from './fixtures/m3-field-effects.fixture.mjs'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { serializeM3SectionGraph } from '../dist/m3/native/structural.js'
import { readFile } from 'node:fs/promises'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { writeUvmContainer } from '@modkit/uv/model/container'
async function createM3aEffectBindingFixture(options = {}) {
  const bytes = await createM3FieldEffectsFixture(options)
  if (options.sidecar) return bytes
  const sections = await M3SectionList.load(
    bytes.slice().buffer,
    await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'),
  )
  const projector = sections.getSectionByReference(sections.model.projections).content[0]
  projector.alpha_init = 0.5
  for (const [field, value] of Object.entries({
    near: 0.1,
    far: 1000,
    box_offset_x_left: -1000,
    box_offset_x_right: 1000,
    box_offset_y_back: -1000,
    box_offset_y_front: 1000,
    aspect_ratio: 1,
    field_of_view: 1,
  }))
    projector[field].default = value
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
const budget = {
  maxInputBytes: 64000000n,
  maxScalarBytes: 64_000_000,
  maxNodes: 1_000_000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const grant = { id: 'm3a-effects-host', classes: ['read-source'] }
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' }
function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('effect host record absent')
  return value
}
function array(value) {
  if (!Array.isArray(value)) throw new TypeError('effect host array absent')
  return value
}
function modes(particle) {
  return array(object(object(particle)['sequenceAnimation'])['squirt']).map(raw => {
    const keys = array(object(object(raw)['track'])['keys'])
    return Number(array(object(keys[0])['vector'])[0])
  })
}
test('native PROJ and authored shader reach the common receiver and simple-effect renderer for every M3A clip', async () => {
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
      assert(clips.every(clip => !clip.sourceId.includes('Hero-Effects.m3a')))
      // A receiver authored through ordinary UVM geometry proves the cross-format scene boundary.
      const appended = appendUvmAccessors(container, [
        {
          type: 'VEC3',
          target: 34962,
          values: Float32Array.from([0, 0, 100, 10, 0, 100, 0, 10, 100]),
        },
      ])
      const document = structuredClone(appended.container.document),
        effects = object(object(document.extensions).UV_game_effects)
      const meshIndex = (document.meshes ??= []).length,
        nodeIndex = document.nodes.length
      document.meshes.push({
        primitives: [{ mode: 4, attributes: { POSITION: appended.accessors[0] } }],
      })
      document.nodes.push({ mesh: meshIndex })
      if (effects.spaceNode !== undefined)
        (document.nodes[effects.spaceNode].children ??= []).push(nodeIndex)
      else document.scenes[document.scene ?? 0].nodes.push(nodeIndex)
      const receiverBytes = writeUvmContainer({ ...appended.container, document })
      let captured
      const contracts = {
        async resolve(request) {
          const lease = await services.port.resolve(request)
          return {
            ...lease,
            value: {
              ...lease.value,
              async render(request) {
                captured = request
                return lease.value.render(request)
              },
            },
          }
        },
      }
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      for (const clip of clips) {
        const frame = await renderUvm(
          receiverBytes,
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
          { contracts, budget },
        )
        const projected = captured.scene.primitives.filter(
          primitive => primitive.id === 'uvm-projector-0',
        )
        assert.equal(projected.length, 1)
        assert.equal(projected[0].positions.length, 9)
        projected[0].positions.forEach((value, index) =>
          assert(Math.abs(value - [0, 0, 100, 10, 0, 100, 0, 10, 100][index]) < 1e-5),
        )
        assert.deepEqual(projected[0].depthBias, { slopeScale: -1, units: -1 })
        const projectedMaterial = captured.scene.materials.find(
          material => material.id === projected[0].materialId,
        )
        assert.equal(projectedMaterial.shader.id, 'modkit.render-material.v1')
        assert.equal(projectedMaterial.simpleEffect.blend, 'opaque')
        assert.deepEqual(projectedMaterial.baseColor, [1, 1, 1, 0.5])
        assert(
          !frame.diagnostics.some(
            item => item.message.includes('projector') && item.message.includes('unrendered'),
          ),
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
