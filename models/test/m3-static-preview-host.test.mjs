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
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { schemaText } from '../src/m3/runtime/schema.js'
import { createM3NativeFacade } from '../src/m3/runtime/native-builders.js'

const budget = {
    maxInputBytes: 64000000n,
    maxScalarBytes: 64000000,
    maxNodes: 1000000,
    maxDepth: 128,
    maxDiagnostics: 1000,
  },
  grant = { id: 'static-preview-host', classes: ['read-source'] },
  target = {
    environment: 'node',
    operatingSystem: 'windows',
    architecture: 'x64',
  },
  identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

async function preview(bytes) {
  const sections = await M3SectionList.load(
    Uint8Array.from(bytes).buffer,
    schemaText(),
    undefined,
    undefined,
    undefined,
    budget,
  )
  const native = createM3NativeFacade(sections)
  return { cameras: native.cameras, lights: native.lights }
}

test('source-free UVM writes mapped and residual M3 cameras/lights with native units and fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-preview-'))
  try {
    const cameras = [0, 1].map(index => ({
        name: `Camera_${index}`,
        boneIndex: 0,
        fieldOfView: 0.7 + index * 0.1,
        nearClip: 2 + index,
        farClip: 90 + index,
        useVerticalFov: index === 1,
        shadowClipDistance: 11 + index,
        focusDistance: 3 + index,
        farFocusRange: 4 + index,
        nearFocusRange: 5 + index,
        nearFalloffStart: 6 + index,
        nearFalloffEnd: 7 + index,
        dofType: 2 + index,
        depthOfField: 0.25 + index,
        bokehFStop: 1.5 + index,
        bokehMaxCoCDiameter: 2.5 + index,
      })),
      lights = Array.from({ length: 5 }, (_, index) => ({
        type: index % 3,
        boneIndex: 0,
        flags: 4 + index,
        color: [0.1 + index, 0.2 + index, 0.3 + index],
        intensity: index === 3 ? 0 : 1.5 + index,
        specularColor: [0.4 + index, 0.5 + index, 0.6 + index],
        specularIntensity: 0.75 + index,
        attenuationNear: 1 + index,
        attenuationFar: 10 + index,
        decay: 2 + index,
        hotspot: 0.1 + index * 0.01,
        falloff: 0.5 + index * 0.01,
      }))
    const encoded = await encodeM3JsonModel(
      {
        meshes: [],
        materials: [],
        skeleton: {
          bones: [{ index: 0, name: 'Preview', parentIndex: -1, inverseBindMatrix: identity }],
        },
        animations: [],
        effects: { particles: [], ribbons: [] },
        bounds: null,
        metadata: { m3Cameras: cameras, m3Lights: lights },
      },
      { includeTextures: false, upAxis: 'z' },
      budget,
    )
    const primaryPath = join(directory, 'Preview.m3')
    await writeFile(primaryPath, encoded.bytes, { flag: 'wx' })
    const linked = linkedExtensionInputs([sceneModule]),
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
      source: await openFileArtifactSource(primaryPath),
      path: primaryPath,
      intent: 'full',
      target,
      grant,
      budget,
      executionBackends: createExecutionBackendRegistry([
        linkedInProcessBackend(linked.modules),
      ]),
      serviceDefinitions: definitions,
      resolveInput: createFilesystemInputResolver({ primaryPath, roots: [directory], inventory }),
    })
    if (opened.state !== 'opened') throw new Error(`M3 preview open refused: ${opened.reason}`)
    try {
      const converted = await opened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 2,
      })
      assert.equal(converted.state, 'ok')
      assert.equal(converted.output.kind, 'bytes')
      const portable = readUvmContainer(converted.output.value)
      assert(!portable.document.extensionsUsed.includes('UV_source_blob'))
      assert.equal(portable.document.cameras.length, 1)
      assert.equal(portable.document.extensions.UV_scene_lights.lights.length, 4)
      assert.equal(portable.document.extras.BlizzardM3.residual.preview.unprojectedCameras.length, 1)
      assert.equal(portable.document.extras.BlizzardM3.residual.preview.unprojectedLights.length, 1)
      const written = await opened.session.operations().invoke('model-write', {
        schemaVersion: 1,
        uvmBytesHex: Buffer.from(writeUvmContainer(portable)).toString('hex'),
      })
      assert.equal(written.state, 'ok')
      assert.equal(written.output.kind, 'bytes')
      assert.deepEqual(await preview(written.output.value), await preview(encoded.bytes))
    } finally {
      await opened.session.dispose()
    }
  } finally {
    const cleanup = resolve(directory)
    if (dirname(cleanup) !== resolve(tmpdir()) || !basename(cleanup).startsWith('modkit-m3-preview-'))
      throw new Error('unexpected preview fixture cleanup path')
    await rm(cleanup, { recursive: true, force: true })
  }
}, 30_000)
