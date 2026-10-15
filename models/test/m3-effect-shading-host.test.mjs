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
import { createM3EffectShadingFixture } from './fixtures/m3-effect-shading.fixture.mjs'
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
test.each([false, true].flatMap(unshaded => [false, true].map(litParts => ({ unshaded, litParts }))))(
  'native particle RGB: MAT_.unshaded=$unshaded LitParts=$litParts', async ({ unshaded, litParts }) => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-effect-shading-'))
  try {
    const effectiveUnshaded = unshaded || !litParts
    const bytes = await createM3EffectShadingFixture({ unshaded, litParts }),
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
      const nativeMaterial = nativeEffects.particles[0].material
      assert.equal(document.materials[nativeMaterial].extensions.UV_game_material.params.renderModel.standard.unshaded,
        effectiveUnshaded)
      assert.equal(document.materials[0].extensions.UV_game_material.params.renderModel.standard.unshaded,
        unshaded, 'particle override must not mutate the original base material')
      assert.equal(nativeMaterial === 0, unshaded || litParts)
      assert.equal(nativeEffects.particleLighting, undefined)
      assert.equal(nativeEffects.particles[0].particleLighting, undefined)
      const reopened = readUvmContainer(writeUvmContainer(container)).document
      assert.equal(reopened.materials.length, document.materials.length)
      assert.deepEqual(reopened.extensions.UV_game_effects, nativeEffects)
      assert.equal(nativeEffects.particles[0].maxParticles, 32)
      assert.deepEqual(nativeEffects.particles[0].segmentColors, [
        [128 / 255, 64 / 255, 1],
        [128 / 255, 64 / 255, 1],
        [128 / 255, 64 / 255, 1],
      ])
      const services = createHostServiceResolver({
        inventory,
        definitions,
        executionBackends: backends,
        target,
        grant,
        budgets: budget,
      })
      let captured, rendered, litFrame
      const contracts = {
        async resolve(request) {
          const lease = await services.port.resolve(request)
          return {
            ...lease,
            value: {
              ...lease.value,
              async render(request) {
                // The scene's legacy preview light otherwise takes precedence over the explicit rig.
                const { light: _previewLight, ...scene } = request.scene
                captured = { ...request, scene: { ...scene, lights: [], ambientLight: [0, 0, 0],
                  materialContext: { ...request.scene.materialContext, sceneLighting: true },
                } }
                rendered = await lease.value.render(captured)
                litFrame = await lease.value.render({ ...captured, scene: { ...captured.scene, ambientLight: [1, 1, 1], lights: [
                  { type: 'directional', direction: [0, 0, 1], color: [1, 1, 1] },
                  { type: 'directional', direction: [0, 0, -1], color: [1, 1, 1] },
                ] } })
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
      const particles = captured.scene.primitives.filter(primitive =>
        primitive.id.startsWith('uvm-effect-particle-'),
      )
      assert(particles.length > 0)
      for (const particle of particles) {
        const material = captured.scene.materials.find(value => value.id === particle.materialId)
        const standard = material.shader.parameters.renderModel.standard
        assert.equal(standard.usesVertexColor, false)
        assert.equal(standard.usesVertexAlpha, false)
        assert.deepEqual(material.baseColor, [1, 1, 1, 1])
        // A particle over a render material keeps the material's own program (core 60e091ec):
        // no simple pass, a two-sided sprite, and the lifecycle colour as the primitive's tint.
        assert.equal(material.simpleEffect, undefined)
        assert.equal(standard.twoSided, true)
        assert.equal(standard.unshaded, effectiveUnshaded)
        assert.deepEqual(Array.from(particle.tint), Array.from(Float32Array.from([128 / 255, 64 / 255, 1, 1])))
        // Only the tint: a programmed sprite carrying it as vertex colours too took it twice (core 5e3809af).
        assert.equal(particle.colors, undefined)
      }
      // The emitter veto preserves bright RGB without a light; an authored lit sprite responds to light.
      assert.equal(rendered.rgba[(16 * 32 + 16) * 4 + 3], 255)
      const maxBlue = frame => frame.rgba.reduce((maximum, value, index) =>
        index % 4 === 2 ? Math.max(maximum, value) : maximum, 0)
      const blue = maxBlue(rendered)
      if (effectiveUnshaded)
        assert(blue > 128, `unlit particle blue must not become black: ${blue}`)
      if (effectiveUnshaded) assert.equal(maxBlue(litFrame), blue)
      else assert(maxBlue(litFrame) > blue, `LitParts sprite must respond to scene lighting: ${blue} -> ${maxBlue(litFrame)}`)
      assert(!result.diagnostics.some(item => item.severity === 'error'))
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (
      dirname(cleanup) !== resolve(tmpdir()) ||
      !basename(cleanup).startsWith('modkit-m3-effect-shading-')
    )
      throw new Error('unexpected collision fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
})
