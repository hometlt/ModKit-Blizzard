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
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { uvmSceneFrameMatrix } from '@modkit/uv/model/frame'
import { createM3LinkedEmissionFixture } from './fixtures/m3-linked-emission.fixture.mjs'
const budget = {
    maxInputBytes: 64000000n,
    maxScalarBytes: 64000000,
    maxNodes: 1000000,
    maxDepth: 128,
    maxDiagnostics: 1000,
  },
  grant = { id: 'effect-shading-host', classes: ['read-source'] },
  target = {
    environment: 'node',
    operatingSystem: 'windows',
    architecture: 'x64',
  }
test('native collision child ordinal spawns a zero-rate PAR_ template through UVM and shared simulation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-linked-emission-'))
  try {
    const bytes = await createM3LinkedEmissionFixture(),
      primaryPath = join(directory, 'Shading.m3')
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
      resolveInput: createFilesystemInputResolver({
        primaryPath,
        roots: [directory],
        inventory,
      }),
    })
    if (opened.state !== 'opened') throw new Error(`M3 collision open refused: ${opened.reason}`)
    try {
      const converted = await opened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
      })
      assert.equal(converted.state, 'ok')
      assert.equal(converted.output.kind, 'bytes')
      const container = readUvmContainer(converted.output.value),
        nativeEffects = container.document.extensions.UV_game_effects
      const document = container.document
      assert.equal(nativeEffects.particles.length, 2)
      assert.equal(nativeEffects.particles[0].collisionEmitterIndex, 1)
      assert.equal(nativeEffects.particles[1].emissionRate, 0)
      assert.equal(nativeEffects.particles[1].maxParticles, 32)
      assert.equal(nativeEffects.particles[0].collisionEmitMin, 1)
      assert.equal(nativeEffects.particles[0].collisionEmitMax, 1)
      const services = createHostServiceResolver({
        inventory,
        definitions,
        executionBackends: backends,
        target,
        grant,
        budgets: budget,
      })
      let captured, rendered
      const contracts = {
        async resolve(request) {
          const lease = await services.port.resolve(request)
          return {
            ...lease,
            value: {
              ...lease.value,
              async render(request) {
                captured = request
                rendered = await lease.value.render(request)
                return rendered
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
      const result = await renderUvm(writeUvmContainer(container), request, {
        contracts,
        budget,
      })
      // A programmed sprite carries its colour as the tint, a simple-effect one as vertex colours
      // (core 5e3809af).
      const children = captured.scene.primitives.filter(primitive => {
        const colour = primitive.tint ?? primitive.colors
        return (
          primitive.id.startsWith('uvm-effect-particle-') &&
          colour?.[0] === 0 &&
          colour?.[1] === 1 &&
          colour?.[2] === 0
        )
      })
      assert(children.length > 0)
      // The effects simulate in M3's frame: the materializer's innermost frame node, under the scale.
      assert.equal(document.nodes[nativeEffects.spaceNode].name, 'uv:up-axis')
      const space = uvmSceneFrameMatrix({
        metersPerSourceUnit: document.extensions.UV_units?.metersPerSourceUnit ?? 1,
        upAxis: '+z',
        handedness: 'right',
      })
      assert.equal(space.length, 16)
      const expected = [
        space[8] * 1.75 + space[12],
        space[9] * 1.75 + space[13],
        space[10] * 1.75 + space[14],
      ]
      for (const child of children) {
        assert.deepEqual(
          child.tint === undefined ? child.colors : Array.from(child.tint),
          child.tint === undefined
            ? Float32Array.from(Array.from({ length: 4 }, () => [0, 1, 0, 1]).flat())
            : [0, 1, 0, 1],
        )
        assert.deepEqual([...child.indices], [0, 1, 2, 0, 2, 3])
        const center = [0, 0, 0]
        for (let vertex = 0; vertex < 4; vertex++)
          for (let c = 0; c < 3; c++) center[c] += child.positions[vertex * 3 + c] / 4
        const matrix = child.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        for (let c = 0; c < 3; c++)
          assert(
            Math.abs(
              matrix[c] * center[0] +
                matrix[c + 4] * center[1] +
                matrix[c + 8] * center[2] +
                matrix[c + 12] -
                expected[c],
            ) < 1e-5,
          )
      }
      assert(!result.diagnostics.some(item => item.severity === 'error'))
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (
      dirname(cleanup) !== resolve(tmpdir()) ||
      !basename(cleanup).startsWith('modkit-m3-linked-emission-')
    )
      throw new Error('unexpected collision fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
})
