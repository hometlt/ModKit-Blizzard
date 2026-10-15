import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { schemaText } from '../src/m3/runtime/schema.js'
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
import { attachUvmFormatResidual } from '@modkit/uv/model/format-residual'
import {
  writeUvmContainer,
  readUvmContainer,
  DEFAULT_UVM_CONTAINER_BUDGET,
} from '@modkit/uv/model/container'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { decodeM3Materials } from '../src/m3/runtime/material.js'

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
      asset: {
        version: '2.0',
        extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } },
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [3, 4, 5], scale: [2, 2, 2] }],
      materials: [
        {
          name: 'Paint',
          extensions: {
            UV_game_material: {
              shader: 'modkit.render-material.v1',
              params: program,
            },
          },
        },
      ],
      extensionsUsed: ['UV_asset', 'UV_provenance', 'UV_game_material'],
      extensions: {
        UV_asset: { id: 'authored-fresh-triangle', class: 'model' },
        UV_provenance: {
          source: { format: 'uvm' },
          importer: { id: 'authored-fixture', version: '1' },
        },
      },
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
      {
        type: 'VEC4',
        values: Float32Array.of(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1),
      },
      {
        type: 'VEC4',
        values: Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1),
      },
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

async function rigFixture(program, uvBase = 2) {
  let container = structuredClone(await fresh(program))
  container.document.nodes = [
    { name: 'Named mesh node', mesh: 0, skin: 0 },
    { name: 'Root', translation: [0, 1, 0], scale: [1, 2, 3], children: [2] },
    { name: 'Child', translation: [1, 0, 0] },
  ]
  container.document.scenes = [{ nodes: [0, 1] }]
  const rootInverse = [1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1 / 3, 0, 0, -0.5, 0, 1]
  const childInverse = [...rootInverse]
  childInverse[12] = -1
  const appended = appendUvmAccessors(
    container,
    [
      {
        type: 'VEC4',
        values: Uint16Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0),
      },
      {
        type: 'VEC4',
        values: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0.6, 0.4, 0, 0),
      },
      {
        type: 'MAT4',
        values: Float32Array.from([...childInverse, ...rootInverse]),
      },
      { type: 'SCALAR', values: Float32Array.of(0, 1) },
      { type: 'VEC3', values: Float32Array.of(1, 0, 0, 20, 1, 0) },
      {
        type: 'VEC4',
        values: Float32Array.of(0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2),
      },
      { type: 'VEC3', values: Float32Array.of(1, 2, 3, 2, 3, 4) },
      { type: 'VEC3', values: Float32Array.of(0, 1, 0, 0, 2, 0) },
      {
        type: 'VEC2',
        values: Float32Array.of(uvBase, uvBase, uvBase + 1, uvBase, uvBase, uvBase + 1),
      },
    ],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes },
  )
  container = structuredClone(appended.container)
  container.document.meshes[0].name = 'Named rig mesh'
  const [joints, weights, inverse, time, translation, rotation, scale, stepTranslation, uv] =
    appended.accessors
  const attrs = container.document.meshes[0].primitives[0].attributes
  attrs.JOINTS_0 = joints
  attrs.WEIGHTS_0 = weights
  for (let set = 0; set < 4; set++) attrs['TEXCOORD_' + set] = uv
  container.document.skins = [{ joints: [2, 1], inverseBindMatrices: inverse, skeleton: 1 }]
  container.document.animations = [
    {
      name: 'Move',
      extras: { uv: { sourceSequenceIndex: 0, looping: false } },
      samplers: [
        { input: time, output: translation, interpolation: 'LINEAR' },
        { input: time, output: rotation, interpolation: 'LINEAR' },
        { input: time, output: scale, interpolation: 'LINEAR' },
      ],
      channels: [
        { sampler: 0, target: { node: 2, path: 'translation' } },
        { sampler: 1, target: { node: 2, path: 'rotation' } },
        { sampler: 2, target: { node: 1, path: 'scale' } },
      ],
    },
    {
      name: 'Step',
      extras: { uv: { sourceSequenceIndex: 1, looping: false } },
      samplers: [{ input: time, output: stepTranslation, interpolation: 'STEP' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
    },
  ]
  return container
}
function posed(container, clipIndex, time) {
  const { scene, rig } = readUvmModel(container.document, container.binary, budget)
  const sampled = createModelSceneSampler(
    { ...scene, skeleton: rig.bindings },
    {
      maxBytes: budget.maxScalarBytes,
      ...(clipIndex === undefined ? {} : { clip: rig.clips[clipIndex] }),
    },
  ).sample(time)
  return sampled.primitives.map(primitive => {
    const matrix = primitive.transform,
      positions = []
    if (!matrix) return [...primitive.positions]
    for (let i = 0; i < primitive.positions.length; i += 3)
      for (let r = 0; r < 3; r++)
        positions.push(
          matrix[r] * primitive.positions[i] +
            matrix[r + 4] * primitive.positions[i + 1] +
            matrix[r + 8] * primitive.positions[i + 2] +
            matrix[r + 12],
        )
    return positions
  })
}

test('fresh UVM rig restores BONE/IREF, remaps skin slots and reopens matching sampled TRS clips', async () => {
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

  let first
  try {
    const seedBytes = await encodeM3JsonModel(seed, { includeTextures: false }, budget)
    const program = (await decodeM3Materials(seedBytes.bytes, budget)).materials[0].shader
      .parameters
    first = await open(seedBytes.bytes)
    for (const uvBase of [2, -5]) {
      const container = await rigFixture(program, uvBase),
        before = writeUvmContainer(container)
      const output = await first
        .operations()
        .invoke('model-write', {
          schemaVersion: 1,
          uvmBytesHex: Buffer.from(before).toString('hex'),
          metersPerNativeUnit: 2,
        })
      assert.equal(output.state, 'ok', JSON.stringify(output))
      assert.equal(output.output.kind, 'bytes')
      if (uvBase === 2) {
        // The frame as the materializer writes it: +z up turned to +y up, then two metres a unit,
        // both as the document's last nodes over the scene's roots.
        const nodes = container.document.nodes
        const roots = container.document.scenes[0].nodes
        const framed = {
          ...container,
          document: {
            ...container.document,
            nodes: [
              ...nodes,
              { name: 'uv:up-axis', rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: roots },
              { name: 'uv:units', scale: [2, 2, 2], children: [nodes.length] },
            ],
            scenes: [{ ...container.document.scenes[0], nodes: [nodes.length + 1] }],
            extensionsUsed: [...container.document.extensionsUsed, 'UV_units'],
            extensions: {
              ...container.document.extensions,
              UV_units: { sourceUnit: 'sc2-game-unit', metersPerSourceUnit: 2 },
            },
          },
        }
        const sourceFree = attachUvmFormatResidual(framed, {
          namespace: 'BlizzardM3',
          format: 'm3',
          profile: 'portable-scene-v1',
          residual: { mdVersion: 34 },
          mapping: { frame: { metersPerSourceUnit: 2 } },
        })
        const sourceFreeOutput = await first.operations().invoke('model-write', {
          schemaVersion: 1,
          uvmBytesHex: Buffer.from(writeUvmContainer(sourceFree)).toString('hex'),
        })
        assert.equal(sourceFreeOutput.state, 'ok', JSON.stringify(sourceFreeOutput))
        assert.deepEqual(sourceFreeOutput.output.value, output.output.value)
      }
      assert.deepEqual(writeUvmContainer(container), before)
      const nativeSections = await M3SectionList.load(
        Uint8Array.from(output.output.value).buffer,
        await schemaText(),
      )
      const sectionsFor = ref => nativeSections.getSectionByReference(ref).content
      const modelBounds = [
        nativeSections.model.boundings,
        nativeSections.model.collision_boundings,
        ...sectionsFor(nativeSections.model.sequences).map(sequence => sequence.bounding_sphere),
      ]
      const meshBounds = [
        ...sectionsFor(nativeSections.model.divisions).flatMap(division =>
          sectionsFor(division.msec).flatMap(msec => [msec.bounding.default, msec.bounding.null]),
        ),
      ]
      const radius = modelBounds[0].radius
      const meshRadius = meshBounds[0].radius
      assert.ok(meshRadius > radius, 'moving root requires a larger dual-frame MSEC bound')
      for (const bounds of modelBounds) assert.equal(bounds.radius, radius)
      for (const bounds of meshBounds) assert.equal(bounds.radius, meshRadius)
      assert.ok(
        radius > 1,
        'animated output must not keep the frozen encoder static triangle bound',
      )
      for (const bounds of [...modelBounds, ...meshBounds]) {
        const radius = bounds.radius
        assert.deepEqual([bounds.min.x, bounds.min.y, bounds.min.z], [-radius, -radius, -radius])
        assert.deepEqual([bounds.max.x, bounds.max.y, bounds.max.z], [radius, radius, radius])
      }
      const reopened = await open(output.output.value)
      try {
        const exported = await reopened.operations().invoke('model-export-uvm', {
          schemaVersion: 1,
          metersPerSourceUnit: 2,
        })
        assert.equal(exported.state, 'ok')
        const actual = readUvmContainer(exported.output.value)
        const actualRig = readUvmModel(actual.document, actual.binary, budget)
        assert.deepEqual(
          actualRig.rig.bindings.map(bone => bone.boneName),
          ['Root', 'Child'],
        )
        assert.deepEqual(
          actualRig.rig.bindings.map(bone => bone.parentBoneIndex),
          [null, 0],
        )
        assert.deepEqual(
          actualRig.rig.clips.map(clip => clip.name),
          ['Move', 'Step'],
        )
        for (const index of [undefined, 0, 1])
          for (const time of [0, 0.25, 0.75, 0.999, 1]) {
            const expected = posed(container, index, time),
              found = posed(actual, index, time)
            assert.equal(found.length, expected.length)
            found.forEach((positions, i) => near(positions, expected[i], 0.00005))
            // This fixture has identity root rotation and explicit two-key root
            // scales/STEP translations. Invert that authored root independently
            // of the production bounds algorithm for actual reopened positions.
            const alpha = Math.max(0, Math.min(1, time))
            const rootScale = index === 0 ? [1 + alpha, 2 + alpha, 3 + alpha] : [1, 2, 3]
            const rootTranslation = [0, index === 1 && time >= 1 ? 2 : 1, 0]
            for (const positions of found)
              for (let offset = 0; offset < positions.length; offset += 3) {
                const point = positions.slice(offset, offset + 3)
                assert.ok(
                  Math.hypot(...point) <= radius * 2,
                  'native model bounds omit a sampled skinned point',
                )
                const local = point.map(
                  (value, axis) => (value - rootTranslation[axis]) / rootScale[axis],
                )
                assert.ok(
                  Math.hypot(...local) <= meshRadius * 2,
                  'native MSEC bounds omit a root-local sampled point',
                )
              }
          }
        for (const set of actualRig.scene.primitives[0].textureCoordinateSets)
          near(set.coordinates, [uvBase, uvBase, uvBase + 1, uvBase, uvBase, uvBase + 1], 0.00005)
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
      } finally {
        await reopened.dispose()
      }
    }
    for (const mutate of [
      value => {
        value.document.nodes[1].scale = [0, 2, 3]
      },
      value => {
        value.document.nodes[1].scale = [1e-46, 2, 3]
      },
      value => {
        const sampler = value.document.animations[0].samplers[2]
        const accessor = value.document.accessors[sampler.output]
        const view = value.document.bufferViews[accessor.bufferView]
        // Native LINEAR scale would cross zero between otherwise finite keys.
        new DataView(
          value.binary.buffer,
          value.binary.byteOffset,
          value.binary.byteLength,
        ).setFloat32((view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + 12, -2, true)
      },
      value => {
        value.extraChunks.push({
          type: 0x12345678,
          bytes: Uint8Array.of(1, 2, 3, 4),
        })
      },
      value => {
        value.document.nodes[1].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      },
      value => {
        value.document.animations[0].samplers[0].interpolation = 'CUBICSPLINE'
      },
      value => {
        value.document.animations[1].channels[0].target.node = 2
      },
      value => {
        value.document.nodes[0].translation = [1, 0, 0]
      },
    ]) {
      const value = await rigFixture(program)
      mutate(value)
      await assert.rejects(
        () =>
          first
            .operations()
            .invoke('model-write', {
              schemaVersion: 1,
              uvmBytesHex: Buffer.from(writeUvmContainer(value)).toString('hex'),
            }),
        { code: 'x3.host/operation-handler-failed' },
      )
    }
  } finally {
    await first?.dispose()
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error('unexpected scratch path')
    await rm(directory, { recursive: true, force: true })
  }
})
