// Intended for models/test; existing Node host test harness, no new runner.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildInventory,
  createHostContributionContractRegistry,
  openSubject,
  linkedExtensionInputs,
  linkedInProcessBackend,
  createExecutionBackendRegistry,
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import {
  writeUvmContainer,
  readUvmContainer,
  DEFAULT_UVM_CONTAINER_BUDGET,
} from '@modkit/uv/model/container'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { decodeM3Materials } from '../src/m3/runtime/material.js'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'

const budget = {
  maxInputBytes: 16777216n,
  maxScalarBytes: 33554432,
  maxNodes: 100000,
  maxDepth: 96,
  maxDiagnostics: 100,
}
const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0)
const seed = {
  meshes: [
    {
      name: 'Triangle',
      primitiveTopology: 'triangles',
      materialIndex: 0,
      positions: [...positions],
      indices: [0, 1, 2],
    },
  ],
  materials: [{ name: 'Paint', layers: [], baseColor: [1, 0.5, 0, 1] }],
  skeleton: { bones: [] },
  animations: [],
  effects: { particles: [], ribbons: [] },
  bounds: null,
}
async function fresh(program) {
  const container = {
    format: 'glb',
    binary: new Uint8Array(),
    extraChunks: [],
    document: {
      asset: { version: '2.0', extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } } },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Triangle node', mesh: 0, translation: [3, 4, 5], scale: [2, 2, 2] }],
      materials: [
        {
          name: 'Paint',
          pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
          extras: { modkit: { role: 'portable-authoring-fallback' } },
          extensions: {
            UV_game_material: { shader: 'modkit.render-material.v1', params: program },
          },
        },
      ],
      extensionsUsed: ['UV_asset', 'UV_provenance', 'UV_game_material', 'UV_units'],
      extensions: {
        UV_asset: { id: 'authored-fresh-triangle', class: 'model' },
        UV_provenance: {
          source: { format: 'uvm' },
          importer: { id: 'authored-fixture', version: '1' },
        },
        UV_units: { sourceUnit: 'fixture-unit', metersPerSourceUnit: 1 },
      },
      extras: { ForeignFormat: { retainedByItsOwner: true } },
    },
  }
  const appended = appendUvmAccessors(
    container,
    [
      { type: 'VEC3', componentType: 5126, values: positions },
      { type: 'SCALAR', componentType: 5125, values: Uint32Array.of(0, 1, 2) },
      ...Array.from({ length: 4 }, () => ({
        type: 'VEC2',
        componentType: 5126,
        values: Float32Array.of(0, 0, 1, 0, 0, 1),
      })),
      { type: 'VEC3', values: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1) },
      { type: 'VEC4', values: Float32Array.of(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1) },
      { type: 'VEC4', values: Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1) },
    ],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes },
  )
  const [position, indices, uv0, uv1, uv2, uv3, normal, tangent, color] = appended.accessors
  const result = structuredClone(appended.container)
  result.document.meshes = [
    {
      primitives: [
        {
          mode: 4,
          indices,
          material: 0,
          attributes: {
            POSITION: position,
            NORMAL: normal,
            TANGENT: tangent,
            COLOR_0: color,
            ...Object.fromEntries(
              [uv0, uv1, uv2, uv3].map((value, index) => [`TEXCOORD_${index}`, value]),
            ),
          },
        },
      ],
    },
  ]
  return result
}
function world(container) {
  const { scene, rig } = readUvmModel(container.document, container.binary, budget)
  return createModelSceneSampler(
    { ...scene, skeleton: rig.bindings },
    { maxBytes: budget.maxScalarBytes },
  )
    .sample(0)
    .primitives.map(primitive => {
      if (!primitive.transform) return primitive
      const matrix = primitive.transform,
        positions = []
      for (let index = 0; index < primitive.positions.length; index += 3)
        for (let row = 0; row < 3; row++)
          positions.push(
            Math.fround(
              matrix[row] * primitive.positions[index] +
                matrix[row + 4] * primitive.positions[index + 1] +
                matrix[row + 8] * primitive.positions[index + 2] +
                matrix[row + 12],
            ),
          )
      return { ...primitive, positions }
    })
}
function near(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length)
  expected.forEach((value, index) =>
    assert.ok(
      Math.abs(actual[index] - value) <= tolerance,
      `component ${index}: ${actual[index]} versus ${value}`,
    ),
  )
}
test('native writer stores common material flipbook tracks in M3 animation sections', async () => {
  const animated = structuredClone(seed)
  animated.animations = [{
    name: 'Atlas', durationSeconds: 0.1, looping: true, nodeTracks: [],
  }]
  animated.materials = [{
    name: 'Atlas paint',
    layers: [],
    standard: {
      layers: {
        decal: {
          slot: 'decal', texturePath: 'atlas.png', uvSource: 0, channels: 1, op: 6,
          teamColorMode: 0, invert: false, clampResult: true, wrapX: true, wrapY: true,
          flipbook: {
            rows: 2, cols: 4,
            frame: {
              value: 0,
              sequenceTracks: [{
                sequenceIndex: 0, concurrent: true, wrapSeconds: 0.1,
                track: {
                  lineType: 0, globalSeqId: null,
                  keys: [0, 1, 2, 3].map(frame => ({ frame: frame * 0.025, vector: [frame] })),
                },
              }],
            },
          },
        },
      },
      blendMode: 0, priority: 0, specularity: 0, specMult: 1, emisMult: 1,
      environmentMultipliers: [1, 0, 0], specMode: 0, alphaTestThreshold: 0,
      twoSided: false, unshaded: false, depthPrepass: false, doubleLambert: false,
      clampOutput: false, usesVertexColor: false, usesVertexAlpha: false,
    },
  }]
  const encoded = await encodeM3JsonModel(animated, { includeTextures: false }, budget)
  assert.deepEqual(encoded.issues, [])
  const frame = (await decodeM3Materials(encoded.bytes, budget)).materials[0]
    .shader.parameters.renderModel.standard.layers.decal.flipbook.frame
  assert.equal(frame.sequenceTracks[0].track.lineType, 0)
  assert.deepEqual(frame.sequenceTracks[0].track.keys.map(key => key.vector[0]), [0, 1, 2, 3])
  assert.equal(frame.sequenceTracks[0].wrapSeconds, 0.1)
})
test('source-free UVM regenerates spatial Fresnel material fields', async () => {
  const encodedSeed = await encodeM3JsonModel(seed, { includeTextures: false }, budget)
  const decodedSeed = await decodeM3Materials(encodedSeed.bytes, budget)
  const program = structuredClone(decodedSeed.materials[0].shader.parameters)
  program.renderModel.standard.layers.diffuse = {
    slot: 'diffuse', texturePath: null, uvSource: 0, channels: 0, op: 6,
    teamColorMode: 0, invert: false, clampResult: false, wrapX: false, wrapY: false,
    constantColor: { value: [1, 0.5, 0, 1] },
    fresnel: {
    mode: 2,
    exponent: 3,
    min: 0.2,
    maxOffset: 0.6,
    translation: [1, 2, 3],
    invertMask: [1, 0, 1],
    rotation: [0.25, -0.5],
    transformMode: 2,
    localTransform: true,
    doNotMirror: true,
    },
  }
  const generated = await exportM3FromUvm(await fresh(program), {
    maxInputBytes: Number(budget.maxInputBytes),
    maxJsonBytes: budget.maxScalarBytes,
    maxNodes: budget.maxNodes,
    maxDepth: budget.maxDepth,
  })
  const writtenLayers = (await decodeM3Materials(generated, budget)).materials[0].shader.parameters
    .renderModel.standard.layers
  const fresnel = Object.values(writtenLayers).find(layer => layer.fresnel)?.fresnel
  assert.deepEqual(fresnel, {
    mode: 2,
    exponent: 3,
    min: Math.fround(0.2),
    maxOffset: Math.fround(0.6),
    translation: [1, 2, 3],
    invertMask: [1, 0, 1],
    rotation: [0.25, -0.5],
    transformMode: 2,
    localTransform: true,
    doNotMirror: true,
  })
})
test('ordinary model.write authors fresh UVM through frozen encoder and reopens matching UVM geometry/material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm3-fresh-write-'))
  const linked = linkedExtensionInputs([sceneModule]),
    executionBackends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
  const inventory = await buildInventory(
    [
      ...linked.inputs,
      {
        ...(await loadExtensionDirectory(fileURLToPath(new URL('..', import.meta.url)))),
        execution: { origin: 'bundled', allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  )
  const open = async bytes => {
    const file = join(directory, `${crypto.randomUUID()}.m3`)
    await writeFile(file, bytes)
    const opened = await openSubject({
      source: await openFileArtifactSource(file),
      path: 'model.m3',
      inventory,
      intent: 'full',
      grant: { id: 'fresh-test', classes: ['read-source', 'write-source'] },
      budget,
      executionBackends,
      target: {
        environment: 'node',
        operatingSystem:
          process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : 'linux',
        architecture: process.arch,
      },
      resolveInput: createFilesystemInputResolver({
        primaryPath: file,
        roots: [directory],
        inventory,
      }),
    })
    assert.equal(opened.state, 'opened')
    assert.equal(opened.selected.contributionId, 'blizzard/m3')
    return opened.session
  }
  let first, reopened
  try {
    const encodedSeed = await encodeM3JsonModel(seed, { includeTextures: false }, budget)
    const material = await decodeM3Materials(encodedSeed.bytes, budget)
    const container = await fresh(material.materials[0].shader.parameters)
    assert.equal(container.document.extras.BlizzardM3, undefined)
    const input = writeUvmContainer(container),
      before = input.slice()
    first = await open(encodedSeed.bytes)
    const result = await first
      .operations()
      .invoke('model-write', {
        schemaVersion: 1,
        uvmBytesHex: Buffer.from(input).toString('hex'),
        metersPerNativeUnit: 2,
      })
    assert.equal(result.state, 'ok', JSON.stringify(result))
    assert.equal(result.output.kind, 'bytes')
    assert.deepEqual(input, before)
    reopened = await open(result.output.value)
    const exported = await reopened
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
    assert.equal(exported.state, 'ok', JSON.stringify(exported))
    assert.equal(exported.output.kind, 'bytes')
    const uvm = readUvmContainer(exported.output.value),
      expected = world(container),
      actual = world(uvm)
    assert.equal(actual.length, expected.length)
    assert.equal(actual.length, 1)
    assert.deepEqual([...actual[0].positions], [...expected[0].positions])
    assert.deepEqual([...actual[0].positions], [3, 4, 5, 5, 4, 5, 3, 6, 5])
    assert.deepEqual([...actual[0].indices], [...expected[0].indices])
    const decoded = readUvmModel(uvm.document, uvm.binary, budget)
    assert.equal(decoded.scene.primitives[0].textureCoordinateSets.length, 4)
    for (const set of decoded.scene.primitives[0].textureCoordinateSets)
      near(set.coordinates, [0, 0, 1, 0, 0, 1], 0.000008)
    assert.equal(uvm.document.materials[0].name, 'Paint')
    assert.deepEqual(
      uvm.document.materials[0].extensions.UV_game_material.params.renderModel.standard,
      container.document.materials[0].extensions.UV_game_material.params.renderModel.standard,
    )
    assert.deepEqual([...decoded.scene.primitives[0].colors], [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1])
    // Reopened local geometry is M3 Z-up; its scene root restores the common source frame.
    near(decoded.scene.primitives[0].normals, [0, -1, 0, 0, -1, 0, 0, -1, 0], 1 / 255 + 1e-7)
    near(decoded.scene.primitives[0].tangents, [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1], 1 / 255 + 1e-7)
    const preserved = await reopened
      .operations()
      .invoke('model-write', {
        schemaVersion: 1,
        uvmBytesHex: Buffer.from(exported.output.value).toString('hex'),
    })
    assert.equal(preserved.state, 'ok')
    const repeated = await reopened
      .operations()
      .invoke('model-write', {
        schemaVersion: 1,
        uvmBytesHex: Buffer.from(exported.output.value).toString('hex'),
      })
    assert.equal(repeated.state, 'ok')
    assert.deepEqual(repeated.output.value, preserved.output.value)
    const instances = structuredClone(container)
    instances.document.nodes.push({ mesh: 0, translation: [-3, 4, 5], scale: [-2, 2, 2] })
    instances.document.scenes[0].nodes.push(1)
    const instanceWrite = await first
      .operations()
      .invoke('model-write', {
        schemaVersion: 1,
        uvmBytesHex: Buffer.from(writeUvmContainer(instances)).toString('hex'),
        metersPerNativeUnit: 2,
      })
    assert.equal(instanceWrite.state, 'ok', JSON.stringify(instanceWrite))
    const instanceSession = await open(instanceWrite.output.value)
    try {
      const exportedInstances = await instanceSession
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
      assert.equal(exportedInstances.state, 'ok')
      const instanceUvm = readUvmContainer(exportedInstances.output.value),
        instanceWorld = world(instanceUvm)
      assert.equal(instanceWorld.length, 2)
      assert.deepEqual([...instanceWorld[1].positions], [-3, 4, 5, -5, 4, 5, -3, 6, 5])
      assert.deepEqual(
        [...instanceWorld[1].indices],
        [0, 2, 1],
        'reflection keeps front-face orientation',
      )
      near(
        readUvmModel(instanceUvm.document, instanceUvm.binary, budget).scene.primitives[1].tangents,
        [-1, 0, 0, -1, -1, 0, 0, -1, -1, 0, 0, -1],
        1 / 255 + 1e-7,
      )
    } finally {
      await instanceSession.dispose()
    }
    const portableDiffuse = structuredClone(container)
    const portableStandard =
      portableDiffuse.document.materials[0].extensions.UV_game_material.params.renderModel.standard
    portableStandard.layers.diffuse = {
      slot: 'diffuse', texturePath: null, uvSource: 0, channels: 0, op: 6,
      teamColorMode: 0, invert: false, clampResult: false, wrapX: false, wrapY: false,
      constantColor: { value: [1, 0.5, 0, 1] },
    }
    const portableWrite = await first.operations().invoke('model-write', {
      schemaVersion: 1,
      uvmBytesHex: Buffer.from(writeUvmContainer(portableDiffuse)).toString('hex'),
      metersPerNativeUnit: 2,
    })
    assert.equal(portableWrite.state, 'ok', JSON.stringify(portableWrite))
    const portableMaterial = (await decodeM3Materials(portableWrite.output.value, budget))
      .materials[0].shader.parameters.renderModel.standard
    assert.equal(portableMaterial.layers.diffuse.teamColorMode, 0)
    assert.equal(portableMaterial.layers.diffuse.op, 6)
    assert.equal(portableMaterial.layers.diffuse.channels, 0)
    assert.equal(portableMaterial.layers.decal, undefined)
    assert.deepEqual(portableMaterial.layers.diffuse.constantColor.value, [1, 0.5, 0, 1])
    for (const change of [
      copy => {
        copy.document.animations = [{}]
      },
      copy => {
        copy.document.nodes[0].scale = [0, 1, 1]
      },
      copy => {
        copy.document.meshes[0].primitives[0].attributes.TEXCOORD_4 =
          copy.document.meshes[0].primitives[0].attributes.TEXCOORD_0
      },
      copy => {
        copy.document.extras = { BlizzardM3: {} }
      },
    ]) {
      const copy = structuredClone(container)
      change(copy)
      await assert.rejects(first
        .operations()
        .invoke('model-write', {
          schemaVersion: 1,
          uvmBytesHex: Buffer.from(writeUvmContainer(copy)).toString('hex'),
        }), { code: 'x3.host/operation-handler-failed' })
    }
  } finally {
    await reopened?.dispose()
    await first?.dispose()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('unexpected scratch path')
    await rm(directory, { recursive: true, force: true })
  }
})
