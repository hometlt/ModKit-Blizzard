import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
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
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3ModelParticleFixture } from './fixtures/m3-model-particles.fixture.mjs'
const budget = {
  maxInputBytes: 64000000n,
  maxScalarBytes: 64000000,
  maxNodes: 1000000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const grant = { id: 'native-nested-model-proof', classes: ['read-source'] }
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' }
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

test('actual M3 exports camera/lights and renders M3 plus UVM particle children through scoped host codec selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-model-particles-'))
  const captured = []
  // Instrument only the real renderer invocation; parser, resolver, converter and rasterizer are production code.
  const traced = {
    ...sceneModule,
    moduleEntries: sceneModule.moduleEntries.map(([url, module]) => [
      url,
      url.endsWith('/headless.js')
        ? {
            ...module,
            createProvider(selection) {
              const lease = module.createProvider(selection)
              return {
                ...lease,
                value: {
                  ...lease.value,
                  async render(request) {
                    captured.push(request)
                    return lease.value.render(request)
                  },
                },
              }
            },
          }
        : module,
    ]),
  }
  try {
    const linked = linkedExtensionInputs([traced]),
      backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
    const core = resolve(import.meta.dirname, '../../../modkit-core')
    const inventory = await buildInventory(
      [
        ...linked.inputs,
        {
          ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
          execution: { origin: 'bundled', allowTrustedInProcess: true },
        },
        {
          ...(await loadExtensionDirectory(join(core, 'extensions/models'))),
          execution: { origin: 'bundled', allowTrustedInProcess: true },
        },
      ],
      createHostContributionContractRegistry(),
    )
    const definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const open = async name => {
      const path = join(directory, name)
      const opened = await openSubject({
        inventory,
        source: await openFileArtifactSource(path),
        path,
        intent: 'full',
        target,
        grant,
        budget,
        executionBackends: backends,
        serviceDefinitions: definitions,
        resolveInput: createFilesystemInputResolver({
          primaryPath: path,
          roots: [directory],
          inventory,
        }),
      })
      assert.equal(opened.state, 'opened', JSON.stringify(opened.state === 'opened' ? {} : opened))
      return opened
    }
    const child = new Uint8Array(await readFile(new URL('./fixtures/m3/model.m3', import.meta.url)))
    await writeFile(join(directory, 'Child.m3'), child)
    const childSubject = await open('Child.m3')
    try {
      const converted = await childSubject.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      assert.equal(converted.state, 'ok')
      await writeFile(join(directory, 'Child.uvm.glb'), converted.output.value)
    } finally {
      await childSubject.session.dispose()
    }
    const uvmSubject = await open('Child.uvm.glb')
    try {
      assert.equal(
        uvmSubject.selected.contributionId,
        'modkit/model-uvm',
        JSON.stringify(uvmSubject.candidates),
      )
    } finally {
      await uvmSubject.session.dispose()
    }
    const parent = await createM3ModelParticleFixture(['Child.m3', 'Child.uvm.glb'])
    await writeFile(join(directory, 'Parent.m3'), parent)
    const opened = await open('Parent.m3')
    try {
      const converted = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      assert.equal(converted.state, 'ok')
      const document = readUvmContainer(converted.output.value).document
      assert.deepEqual(document.extensions.UV_game_effects.particles[0].modelPaths, [
        'Child.m3',
        'Child.uvm.glb',
      ])
      const cameraNode = document.nodes.findIndex(node => node.camera !== undefined)
      assert.equal(document.extensions.UV_game_effects.particles[0].swapModelParticleYZ, true)
      assert(cameraNode >= 0)
      assert.deepEqual(Object.keys(document.extras.BlizzardM3.mapping), ['frame'])
      assert.deepEqual(document.cameras[0].perspective, {
        yfov: 1,
        znear: Math.fround(0.1),
        zfar: 20,
      })
      assert(document.extensionsUsed.includes('UV_scene_camera'))
      assert.deepEqual(
        Object.keys(document.cameras[0].extensions.UV_scene_camera.sequenceAnimation).sort(),
        ['yfov', 'zfar', 'znear'],
      )
      assert.deepEqual(
        Object.keys(document.extensions.UV_scene_lights.lights[0].sequenceAnimation).sort(),
        ['color', 'intensity'],
      )
      assert.deepEqual(
        document.extensions.UV_scene_lights.lights[0].animationDefaults,
        {
          color: [0.5, 1, 0.25],
          intensity: 1,
          attenuationStart: 1,
          decayExponent: 2,
        },
      )
      const clip = readUvmAnimationClips(document)?.[0]
      const rendered = await opened.session.operations().invoke('render-m3-scene', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
        viewport: { width: 32, height: 32 },
        camera: { viewProjection: identity, viewMatrix: identity },
        time: 0.8,
        ...(clip === undefined ? {} : { clipId: clip.id }),
        rendererId: 'modkit.headless',
      })
      assert.equal(rendered.state, 'ok', JSON.stringify(rendered))
      assert(
        !rendered.diagnostics.some(item => item.code === 'common.uvm/model-particle-unrendered'),
        JSON.stringify(rendered.diagnostics),
      )
      const frame = captured.at(-1)
      assert(frame.scene.primitives.some(primitive => primitive.id.startsWith('model-particle-')),
        JSON.stringify({ ids: frame.scene.primitives.map(primitive => primitive.id), diagnostics: rendered.diagnostics }))
      assert(
        frame.scene.primitives.some(primitive => primitive.id.startsWith('uvm-effect-particle-')),
      )
      assert.deepEqual(
        frame.scene.lights.map(light => light.type),
        ['directional', 'point', 'spot'],
      )
      // The vendored scene now lights a preview as core does: the directional light is the
      // scene's own, the point and spot lights keep the model's colour.
      assert.notDeepEqual(frame.scene.lights[0].color, [0.5, 1, 0.25])
      assert.deepEqual(frame.scene.lights[1].color, [0.5, 1, 0.25])
      assert.deepEqual(frame.scene.lights[2].color, [0.5, 1, 0.25])
      const resolved = opened.resources
        .provenance()
        .filter(item => item.state === 'resolved' && item.role === 'sidecar')
        .map(item => item.logicalId)
      assert(resolved.includes('Child.m3'))
      assert(resolved.includes('Child.uvm.glb'))
      const selected = await opened.session.operations().invoke('render-m3-scene', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
        viewport: { width: 16, height: 16 },
        camera: { node: cameraNode },
        time: 0,
        rendererId: 'modkit.headless',
      })
      assert.equal(selected.state, 'ok', JSON.stringify(selected))
      const restCamera = captured.at(-1).camera
      assert(restCamera.viewMatrix.every(Number.isFinite))
      assert.notDeepEqual([...restCamera.viewProjection], identity)
      if (process.env.MODKIT_LINK_MODE === 'core') {
        const animatedCamera = await opened.session.operations().invoke('render-m3-scene', {
          schemaVersion: 1,
          metersPerSourceUnit: 1,
          viewport: { width: 16, height: 16 },
          camera: { node: cameraNode },
          time: 0.8,
          ...(clip === undefined ? {} : { clipId: clip.id }),
          rendererId: 'modkit.headless',
        })
        assert.equal(animatedCamera.state, 'ok', JSON.stringify(animatedCamera))
        assert.notDeepEqual(captured.at(-1).camera.viewProjection, restCamera.viewProjection)
      }
      assert.deepEqual(await readFile(join(directory, 'Parent.m3')), Buffer.from(parent))
      assert.deepEqual(await readFile(join(directory, 'Child.m3')), Buffer.from(child))
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const absolute = resolve(directory)
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith('modkit-m3-model-particles-')
    )
      throw new Error('invalid test cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})
