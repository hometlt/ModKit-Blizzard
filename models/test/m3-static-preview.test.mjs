import assert from 'node:assert/strict'
import { test } from 'vitest'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { schemaText } from '../src/m3/runtime/schema.js'
import { createM3NativeFacade } from '../src/m3/runtime/native-builders.js'
import { projectM3StaticPreview } from '../dist/m3/uvm/preview.js'
import { materializeUvmCore } from '@modkit/uv/model/materializer'
import { resolveUvmCamera } from '@modkit/scene/uvm/cameras'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import {
  DEFAULT_UVM_CONTAINER_BUDGET,
  readUvmContainer,
  writeUvmContainer,
} from '@modkit/uv/model/container'

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const budget = {
  maxInputBytes: 16777216n,
  maxScalarBytes: 33554432,
  maxNodes: 100000,
  maxDepth: 96,
  maxDiagnostics: 100,
}
const uvmBudget = {
  ...DEFAULT_UVM_CONTAINER_BUDGET,
  maxJsonBytes: 33554432,
  maxNodes: 100000,
  maxDepth: 96,
}
/** The preview through the materializer: a +z-up model of one empty node, two metres a unit. */
const materialized = preview => {
  const result = materializeUvmCore(
    {
      info: {
        scenes: 1,
        nodes: 2,
        meshes: 0,
        primitives: 0,
        materials: 0,
        textures: 0,
        animations: 0,
        geometryAccess: 'metadata-only',
        upAxis: '+z',
      },
      nodes: [{ id: 'root', childIds: [], meshIds: [], transform: identity }, preview.node],
      lights: preview.lights,
      cameras: [preview.camera],
    },
    {
      scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
      profile: 'UVM/core@1.0',
      subjectRevision: 'content-hash.sha256:preview',
      options: { assetId: 'native-preview-fixture', sourceFormat: 'm3', units: { metersPerSourceUnit: 2 } },
    },
  )
  return { container: readUvmContainer(result.bytes, uvmBudget), nodes: result.bindings.nodes }
}
test('actual native CAM_/LITE/IREF defaults project into owned glTF camera and source-local common lights', async () => {
  const inverse = identity.slice()
  inverse.splice(12, 3, -3, -4, -5)
  const seed = {
    meshes: [],
    materials: [],
    skeleton: {
      bones: [{ index: 0, name: 'Preview', parentIndex: -1, inverseBindMatrix: inverse }],
    },
    animations: [],
    effects: { particles: [], ribbons: [] },
    bounds: null,
    metadata: {
      m3Cameras: [
        {
          name: 'Camera',
          boneIndex: 0,
          fieldOfView: 1,
          nearClip: 1,
          farClip: 9,
          useVerticalFov: false,
        },
      ],
      m3Lights: [0, 1, 2].map(type => ({
        type,
        boneIndex: 0,
        color: [0.25, 0.5, 0.75],
        intensity: 2,
        attenuationNear: 1,
        attenuationFar: 10,
        decay: 2.5,
        hotspot: 0.2,
        falloff: 0.6,
      })),
    },
  }
  const bytes = await encodeM3JsonModel(seed, { includeTextures: false, upAxis: 'z' }, budget)
  const sections = await M3SectionList.load(Uint8Array.from(bytes.bytes).buffer, schemaText())
  const native = createM3NativeFacade(sections)
  assert.equal(native.cameras.length, 1)
  assert.equal(native.lights.length, 3)
  const matrices = sections
    .getSectionByReference(sections.model.bone_rests)
    .content.map(record =>
      ['x', 'y', 'z', 'w'].flatMap(column =>
        ['x', 'y', 'z', 'w'].map(component => record.matrix[column][component]),
      ),
    )
  const source = { cameras: native.cameras, lights: native.lights, inverseBindMatrices: matrices }
  const projected = projectM3StaticPreview(source, { metersPerSourceUnit: 2, budget: uvmBudget })
  assert.deepEqual(projected.diagnostics, [])
  assert.equal(projected.lights.lights.length, 3)
  assert.equal(projected.mapping.camera.authoredFovAxis, 'horizontal')
  assert.equal(projected.mapping.camera.policy, 'pinned-fov-treated-as-vertical')
  const published = materialized(projected)
  const reopened = readUvmContainer(writeUvmContainer(published.container, uvmBudget), uvmBudget)
  const document = reopened.document,
    camera = document.cameras[0]
  const cameraNode = published.nodes['m3/preview-camera']
  assert.equal(document.nodes[cameraNode].camera, 0)
  // Clip distances in metres: glTF does not scale them by the nodes above the camera.
  assert.deepEqual(camera.perspective, { yfov: 1, znear: 2, zfar: 18 })
  // The lights are in M3's frame: the materializer's innermost frame node.
  const lights = document.extensions.UV_scene_lights
  assert.equal(document.nodes[lights.spaceNode].name, 'uv:up-axis')
  assert.deepEqual(lights, {
    version: 1,
    spaceNode: lights.spaceNode,
    ambient: [0.02, 0.02, 0.02],
    lights: [
      {
        type: 'directional',
        direction: [0, 0, 1],
        color: [0.5, 1, 1.5],
        range: 10,
        attenuationStart: 1,
        attenuationEnd: 10,
        decayExponent: 2.5,
      },
      {
        type: 'point',
        direction: [0, 0, -1],
        position: [3, 4, 5],
        color: [0.5, 1, 1.5],
        range: 10,
        attenuationStart: 1,
        attenuationEnd: 10,
        decayExponent: 2.5,
      },
      {
        type: 'spot',
        direction: [0, 0, -1],
        position: [3, 4, 5],
        color: [0.5, 1, 1.5],
        range: 10,
        attenuationStart: 1,
        attenuationEnd: 10,
        decayExponent: 2.5,
        innerConeAngle: Math.fround(0.2),
        outerConeAngle: Math.fround(0.6),
      },
    ],
  })
  const parsed = readUvmModel(document, reopened.binary, { maxScalarBytes: budget.maxScalarBytes })
  const sampled = createModelSceneSampler(parsed.scene, { maxBytes: budget.maxScalarBytes }).sample(
    0,
  )
  const actual = resolveUvmCamera(
    document,
    { node: cameraNode },
    {
      aspect: 1,
      nodeTransforms: sampled.nodeTransforms,
      activeNodes: new Set(sampled.nodeTransforms.keys()),
      maxBytes: 65536,
      maxNodes: 1000,
    },
  )
  assert.deepEqual(actual.eyePosition.map(value => Math.round(value * 1e9) / 1e9), [6, 10, -8])
  const expected = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, -6, -8, -10, 1]
  expected.forEach((value, index) =>
    assert.ok(Math.abs(actual.viewMatrix[index] - value) < 1e-6, `view ${index}`),
  )
  // The projection owns its values: the native records may change after it.
  native.cameras[0].nearClip = 1000
  matrices[0].fill(0)
  assert.equal(projected.camera.camera.perspective.znear, 2)
})
test('static boundary picks first valid bind, caps lights, owns data and preserves refusal boundaries', () => {
  const camera = {
    name: 'Valid',
    boneIndex: 0,
    fieldOfView: 1,
    nearClip: 3,
    farClip: 2,
    useVerticalFov: true,
  }
  const source = {
    cameras: [{ ...camera, boneIndex: 9 }, camera],
    lights: Array.from({ length: 5 }, () => ({
      boneIndex: 0,
      type: 1,
      color: [1, 1, 1],
      intensity: 1,
    })),
    inverseBindMatrices: [identity],
  }
  const result = projectM3StaticPreview(source, { metersPerSourceUnit: 1, budget: uvmBudget })
  assert.equal(result.mapping.camera.nativeIndex, 1)
  assert.equal(result.camera.camera.perspective.zfar, 10000)
  assert.equal(result.lights.lights.length, 4)
  assert.equal(result.diagnostics.length, 1)
  assert.throws(
    () =>
      projectM3StaticPreview(source, {
        metersPerSourceUnit: 1,
        budget: uvmBudget,
        signal: AbortSignal.abort(),
      }),
    /abort/i,
  )
  assert.throws(
    () =>
      projectM3StaticPreview(source, {
        metersPerSourceUnit: 1,
        budget: { ...uvmBudget, maxJsonBytes: 1 },
      }),
    /budget|bytes|maxBytes/i,
  )
})


test('model conversion may attach the preview camera to its exact native bone', () => {
  const source={cameras:[{boneIndex:0,fieldOfView:0.5,nearClip:0.1,farClip:10}],lights:[],inverseBindMatrices:[identity]}
  const preview=projectM3StaticPreview(source,{metersPerSourceUnit:2,budget:uvmBudget,cameraBoneNodeIds:['bone/0']})
  assert.equal(preview.cameraParentNodeId,'bone/0')
  assert.deepEqual(preview.node.transform,identity)
  assert.equal(preview.camera.camera.perspective.znear,0.2)
  assert.equal(preview.mapping.camera.boneIndex,0)
})
