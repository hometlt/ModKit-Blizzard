import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
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
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3CollisionSplatFixture } from './fixtures/m3-collision-splats.fixture.mjs'
const budget = {
    maxInputBytes: 64000000n,
    maxScalarBytes: 64000000,
    maxNodes: 1000000,
    maxDepth: 128,
    maxDiagnostics: 1000,
  },
  grant = { id: 'collision-splat-host', classes: ['read-source'] },
  target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' }
test('native M3 particle collision links and PHSH physics reach shared simulation and impact receiver draws', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-collision-splats-'))
  try {
    const bytes = await createM3CollisionSplatFixture(),
      primaryPath = join(directory, 'Impact.m3')
    await writeFile(primaryPath, bytes, { flag: 'wx' })
    const source = await openFileArtifactSource(primaryPath),
      linked = linkedExtensionInputs([sceneModule]),
      backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]),
      inventory = await buildInventory(
        [
          ...linked.inputs,
          {
            ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
            execution: { origin: 'bundled', allowTrustedInProcess: true },
          },
        ],
        createHostContributionContractRegistry(),
      ),
      definitions = createBundledServiceDefinitionRegistry()
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
    })
    if (opened.state !== 'opened') throw new Error(`M3 collision open refused: ${opened.reason}`)
    try {
      const converted = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      assert.equal(converted.state, 'ok')
      assert.equal(converted.output.kind, 'bytes')
      const container = readUvmContainer(converted.output.value),
        nativeEffects = container.document.extensions.UV_game_effects
      assert.equal(nativeEffects.particles[0].collideObjects, true)
      assert.equal(nativeEffects.particles[0].maxParticles, 32)
      assert.equal(nativeEffects.particles[0].emissionRate, 10)
      assert.equal(nativeEffects.particles[0].speed, 10)
      assert.equal(nativeEffects.particles[0].lifeSpan, 2)
      assert.equal(nativeEffects.particles[0].collisionProjectorIndex, 0)
      assert.equal(nativeEffects.projectors[0].active, 0)
      const physics = container.document.nodes.flatMap((node, index) =>
        node.extensions?.UV_game_collision?.role === 'physics' ? [index] : [],
      )
      assert.equal(physics.length, 1)
      const appended = appendUvmAccessors(container, [
          {
            type: 'VEC3',
            target: 34962,
            values: Float32Array.from([-0.5, -0.5, 1.7501, 0.5, -0.5, 1.7501, 0, 0.5, 1.7501]),
          },
        ]),
        document = structuredClone(appended.container.document),
        mesh = (document.meshes ??= []).length,
        node = document.nodes.length
      document.meshes.push({
        primitives: [{ mode: 4, attributes: { POSITION: appended.accessors[0] } }],
      })
      document.nodes.push({ mesh })
      if (nativeEffects.spaceNode !== undefined)
        (document.nodes[nativeEffects.spaceNode].children ??= []).push(node)
      else document.scenes[document.scene ?? 0].nodes.push(node)
      const services = createHostServiceResolver({
        inventory,
        definitions,
        executionBackends: backends,
        target,
        grant,
        budgets: budget,
      })
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
      const clip = readUvmAnimationClips(document)?.[0],
        identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const request = {
        schemaVersion: 1,
        viewport: { width: 32, height: 32 },
        camera: { viewProjection: identity, viewMatrix: identity },
        time: 0.8,
        rendererId: 'modkit.headless',
        ...(clip === undefined ? {} : { clipId: clip.id }),
      }
      const result = await renderUvm(
        writeUvmContainer({ ...appended.container, document }),
        request,
        { contracts, budget },
      )
      const impacts = captured.scene.primitives.filter(primitive =>
        primitive.id.startsWith('uvm-projector-impact-'),
      )
      assert(impacts.length > 0)
      assert(!captured.scene.primitives.some(primitive => primitive.id === 'uvm-projector-0'))
      for (const impact of impacts) {
        assert.deepEqual(
          Array.from(impact.positions),
          Array.from(Float32Array.from([-0.5, -0.5, 1.7501, 0.5, -0.5, 1.7501, 0, 0.5, 1.7501])),
        )
        assert.deepEqual(Array.from(impact.indices), [0, 1, 2])
        assert.deepEqual(impact.depthBias, { slopeScale: -1, units: -1 })
        const material = captured.scene.materials.find(
          candidate => candidate.id === impact.materialId,
        )
        assert.equal(material.simpleEffect.blend, 'opaque')
        assert.equal(material.baseColor[3], 1)
        assert.equal(material.shader.id, 'modkit.render-material.v1')
      }
      assert(!result.diagnostics.some(item => item.severity === 'error'))
      // Same authored shape tagged as an attachment volume must stop causing impacts.
      document.nodes[physics[0]].extensions.UV_game_collision.role = 'effect'
      await renderUvm(writeUvmContainer({ ...appended.container, document }), request, {
        contracts,
        budget,
      })
      assert(
        !captured.scene.primitives.some(primitive =>
          primitive.id.startsWith('uvm-projector-impact-'),
        ),
      )
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (
      dirname(cleanup) !== resolve(tmpdir()) ||
      !basename(cleanup).startsWith('modkit-m3-collision-splats-')
    )
      throw new Error('unexpected collision fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
})
