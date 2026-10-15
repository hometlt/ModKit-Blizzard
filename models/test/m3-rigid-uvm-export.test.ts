import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { writeUvmContainer, DEFAULT_UVM_CONTAINER_BUDGET } from '@modkit/uv/model/container'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { createModelPoseSampler } from '@modkit/codec-kit/model/skeleton'
import { composeTrsMatrix } from '@modkit/codec-kit/model-math/sequence-pose'
import { createProvider } from '../src/m3/native-encoder.js'
import { createProvider as createPortableProvider } from '../dist/browser/native-encoder.js'
import { decodeM3Geometry } from '../src/m3/runtime/geometry.js'
import { decodeM3Skeleton } from '../src/m3/runtime/skeleton.js'
import { decodeM3Animations } from '../src/m3/runtime/animation.js'
import { decodeM3Attachments } from '../src/m3/runtime/attachments.js'
import { decodeM3Materials } from '../src/m3/runtime/material.js'

const budget = {
  maxInputBytes: 16777216n,
  maxScalarBytes: 33554432,
  maxNodes: 100000,
  maxDepth: 96,
  maxDiagnostics: 100,
}

// Independently authored common scene: no M3/PIE source bytes or source-native residuals.
function fixture(frame = 'diagonal') {
  const material = {
    version: 1,
    standard: {
      layers: {
        diffuse: {
          slot: 'diffuse',
          texturePath: 'Assets/Hull.dds',
          uvSource: 0,
          channels: 1,
          op: 6,
          teamColorMode: 0,
          invert: false,
          clampResult: false,
          wrapX: true,
          wrapY: true,
          uvOffset: { value: [0.25, 0.125] },
          uvTiling: { value: [2, 1] },
        },
      },
      blendMode: 0,
      priority: 0,
      specularity: 0,
      specMult: 1,
      emisMult: 1,
      environmentMultipliers: [1, 0, 0],
      specMode: 0,
      alphaTestThreshold: 0,
      twoSided: false,
      unshaded: false,
      depthPrepass: false,
      doubleLambert: false,
      clampOutput: false,
      usesVertexColor: false,
      usesVertexAlpha: false,
    },
  }
  const source = {
    format: 'glb',
    binary: new Uint8Array(),
    extraChunks: [],
    document: {
      asset: { version: '2.0', extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } } },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        {
          name: 'Unit frame',
          matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
          children: [1],
        },
        { name: 'Body', translation: [1, 2, 3], children: [2] },
        { name: 'Turret', mesh: 0, children: [3] },
        {
          name: 'Authored connector node',
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1, 2, 1],
          extensions: { UV_game_socket: { role: 'attach', index: 0, sourceName: 'Connector_0' } },
        },
      ],
      materials: [
        {
          name: 'Hull',
          extensions: {
            UV_game_material: {
              shader: 'modkit.render-material.v1',
              params: { renderModel: material },
            },
          },
        },
      ],
      extensionsUsed: [
        'UV_asset',
        'UV_provenance',
        'UV_game_material',
        'UV_game_socket',
        'UV_units',
      ],
      extensions: {
        UV_asset: { id: 'rigid-node-fixture', class: 'model' },
        UV_provenance: {
          source: { format: 'uvm' },
          importer: { id: 'authored-fixture', version: '1' },
        },
        UV_units: { sourceUnit: 'fixture-unit', metersPerSourceUnit: 2 },
      },
      extras: { ForeignFormat: { originalBytes: false } },
    },
  }
  if (frame !== 'diagonal') {
    const root = new Float32Array(16),
      connector = new Float32Array(16)
    const rotation = [0.2, -0.3, 0.1, 0.9]
    const length = Math.hypot(...rotation)
    const units = frame === 'small-units' ? 1 / 1024 : 2
    composeTrsMatrix(
      root,
      0,
      [2 * units, -3 * units, 4 * units],
      rotation.map(value => value / length),
      [units, 1.5 * units, 0.75 * units],
    )
    composeTrsMatrix(connector, 0, [0.5, 1, 2], [0, Math.SQRT1_2, 0, Math.SQRT1_2], [1.2, 0.4, 2])
    source.document.nodes[0].matrix = [...root]
    source.document.nodes[3].matrix = [...connector]
  }
  const appended = appendUvmAccessors(
    source,
    [
      { type: 'VEC3', values: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) },
      { type: 'VEC3', values: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1) },
      { type: 'VEC2', values: Float32Array.of(0, 0, 1, 0, 0, 1) },
      { type: 'SCALAR', values: Uint16Array.of(0, 1, 2) },
      { type: 'SCALAR', values: Float32Array.of(0, 0.125, 0.25) },
      { type: 'VEC3', values: Float32Array.of(1, 2, 3, 2, 3, 4, 3, 4, 5) },
      {
        type: 'VEC4',
        values: Float32Array.of(0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 1, 0),
      },
      { type: 'VEC3', values: Float32Array.of(1, 1, 1, 2, 1, 1, 1, 2, 1) },
      { type: 'SCALAR', values: Float32Array.of(1, 1, 1) },
    ],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes },
  )
  const result = structuredClone(appended.container)
  result.document.extensionsUsed.push('UV_game_variants', 'KHR_animation_pointer')
  result.document.extensions.UV_game_variants = {
    visibility: [{ mesh: 0, primitive: 0, value: 1 }],
  }
  const [position, normal, uv, indices, input, translation, rotation, scale, visibility] =
    appended.accessors
  result.document.meshes = [
    {
      name: 'Hull',
      primitives: [
        {
          mode: 4,
          material: 0,
          indices,
          attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
        },
      ],
    },
  ]
  result.document.animations = [
    {
      name: 'Move',
      extras: { uv: { sourceDurationSeconds: 0.25, sourceSequenceIndex: 0, looping: false } },
      samplers: [translation, rotation, scale, visibility].map(output => ({
        input,
        output,
        interpolation: 'LINEAR',
      })),
      channels: [
        { sampler: 0, target: { node: 1, path: 'translation' } },
        { sampler: 1, target: { node: 2, path: 'rotation' } },
        { sampler: 2, target: { node: 2, path: 'scale' } },
        {
          sampler: 3,
          target: {
            path: 'pointer',
            extensions: {
              KHR_animation_pointer: { pointer: '/extensions/UV_game_variants/visibility/0/value' },
            },
          },
        },
      ].map(channel => ({
        ...channel,
        extras: { uv: { concurrent: true, wrapSeconds: 0.25, repeatCount: 0 } },
      })),
    },
  ]
  return result
}

async function encode(container, factory = createProvider) {
  const lease = factory(
    {
      contract: 'common.model/native-encoder',
      major: 1,
      offerId: 'm3-from-uvm',
      contractSelectionKey: 'format=m3',
    },
    { budgets: budget },
  )
  try {
    return (
      await lease.value.encode({
        uvm: writeUvmContainer(container),
        options: { metersPerNativeUnit: 2 },
      })
    ).bytes
  } finally {
    await lease.release()
  }
}
function near(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length)
  expected.forEach((value, index) =>
    assert.ok(
      Math.abs(actual[index] - value) <= tolerance,
      `${index}: ${actual[index]} != ${value}`,
    ),
  )
}
const targetPoint = value => [value[0] / 2, -value[2] / 2, value[1] / 2]

test('unused valid skin tables do not prevent exact rigid lowering or bypass validation', async () => {
  const source=fixture(), baseline=await encode(source)
  source.document.skins=[{joints:[1,2],skeleton:1}]
  const original=writeUvmContainer(source)
  // Byte-identical native bones/vertices/tracks inherit the animated pose checks below.
  assert.deepEqual(await encode(source),baseline)
  assert.deepEqual(writeUvmContainer(source),original)
  source.document.skins[0].joints=[999]
  await assert.rejects(()=>encode(source),/skin joint/)
  source.document.skins[0].joints=[1,2]
  source.document.skins[0].extras={unknown:1}
  await assert.rejects(()=>encode(source),/unknown unused skin/)
})

function point(matrix, value) {
  return [0, 1, 2].map(
    row =>
      matrix[row] * value[0] +
      matrix[row + 4] * value[1] +
      matrix[row + 8] * value[2] +
      matrix[row + 12],
  )
}

test.each(['diagonal', 'rotated', 'small-units'])(
  'native M3 preserves source-free rigid motion, connector pose and material transforms (%s)',
  async frame => {
    const source = fixture(frame),
      original = writeUvmContainer(source)
    const bytes = await encode(source)
    assert.deepEqual(await encode(source), bytes)
    assert.deepEqual(await encode(source, createPortableProvider), bytes)
    assert.deepEqual(writeUvmContainer(source), original)
    const [geometry, skeleton, animation, attachments, materials] = await Promise.all([
      decodeM3Geometry(bytes, budget),
      decodeM3Skeleton(bytes, budget),
      decodeM3Animations(bytes, budget),
      decodeM3Attachments(bytes, budget),
      decodeM3Materials(bytes, budget),
    ])
    assert.equal(animation.fatal, false)
    assert.equal(animation.clips[0].name, 'Move')
    assert.equal(animation.clips[0].looping, false)
    assert.equal(animation.clips[0].durationSeconds, 0.25)
    assert.equal(skeleton.rejectedLocalPoses, 0)
    assert.equal(attachments.sockets[0].sourceName, 'Connector_0')
    const layer = materials.materials[0].shader.parameters.renderModel.standard.layers.decal
    assert.equal(layer.texturePath, 'Assets/Hull.dds')
    assert.deepEqual(layer.uvOffset.value, [0.25, 0.125])
    assert.deepEqual(layer.uvTiling.value, [2, 1])
    const common = readUvmModel(source.document, source.binary, budget)
    const sampler = createModelSceneSampler(
      { ...common.scene, nodePoses: common.rig.nodePoses },
      { maxBytes: budget.maxScalarBytes, clip: common.rig.clips[0] },
    )
    const pose = createModelPoseSampler({
      bindings: skeleton.bindings,
      hierarchyId: 'm3/bone-table',
      clip: animation.clips[0],
    })
    const turret = skeleton.bindings.find(binding => binding.boneName === 'Turret')
    const socket = skeleton.bindings.find(
      binding => binding.nodeId === attachments.sockets[0].nodeId,
    )
    const primitive = geometry.primitives[0]
    assert.ok(primitive.boneWeights.every((value, index) => value === (index % 4 === 0 ? 1 : 0)))
    for (const time of [0, 0.0625, 0.125, 0.1875, 0.25]) {
      const nativePose = pose.sample(time)
      const nativeWorld = nativePose.bones.find(
        bone => bone.boneIndex === turret.boneIndex,
      ).worldMatrix
      const commonFrame = sampler.sample(time)
      const expected = commonFrame.primitives[0]
      for (let offset = 0; offset < primitive.positions.length; offset += 3)
        near(
          point(nativeWorld, primitive.positions.slice(offset, offset + 3)),
          targetPoint(point(expected.transform, expected.positions.slice(offset, offset + 3))),
        )
      const nativeSocket = nativePose.bones.find(
        bone => bone.boneIndex === socket.boneIndex,
      ).worldMatrix
      const commonSocket = commonFrame.nodeTransforms.get('node-3')
      // Compare the whole connector frame, not just its origin: offset, rotation and scale
      // survive native ATT_ binding to its synthetic rigid bone, at key and intermediate times.
      for (const basis of [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ])
        near(point(nativeSocket, targetPoint(basis)), targetPoint(point(commonSocket, basis)))
    }
  },
)

test('rigid export refuses unsupported matrix/shear and finite repeat semantics', async () => {
  for (const modify of [
    matrix => {
      matrix[4] = 0.5
    },
    matrix => {
      matrix[4] = 0.5
      matrix[12] = 1e20
    },
    matrix => {
      matrix[0] = matrix[5] = matrix[10] = 1e-9
      matrix[4] = 0.5e-9
    },
    matrix => {
      matrix[0] = 0
    },
    matrix => {
      matrix[0] = 1e-100
    },
    matrix => {
      matrix[4] = matrix[0]
      matrix[5] = 0
    },
    matrix => {
      matrix[0] = 1e100
    },
    matrix => {
      matrix[3] = 0.5
    },
  ]) {
    const source = fixture()
    modify(source.document.nodes[0].matrix)
    await assert.rejects(
      () => encode(source),
      /TRS-representable affine node matrix|invalid|finite|singular/i,
    )
  }
  const repeated = fixture()
  repeated.document.extensionsUsed.push('UV_game_animation_clips')
  repeated.document.extensions.UV_game_animation_clips = {
    schemaVersion: 1,
    clips: [
      {
        id: 'finite',
        name: 'Move',
        sourceSequenceIndex: 0,
        animation: 0,
        durationSeconds: 0.25,
        repeatCount: 3,
        looping: true,
      },
    ],
  }
  await assert.rejects(() => encode(repeated), /finite animation repeat count/)
  const hidden = fixture()
  hidden.document.extensions.UV_game_variants.visibility[0].value = 0
  await assert.rejects(() => encode(hidden), /non-default primitive visibility/)
  const changing = fixture()
  const appended = appendUvmAccessors(
    changing,
    [{ type: 'SCALAR', values: Float32Array.of(1, 0, 1) }],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes },
  )
  const changingContainer = structuredClone(appended.container)
  changingContainer.document.animations[0].samplers[3].output = appended.accessors[0]
  await assert.rejects(() => encode(changingContainer), /animated primitive visibility/)
})

test.each([false, true])(
  'plain color becomes unshaded M3 and refuses PBR features (animated=%s)',
  async animated => {
    const source = fixture()
    if (!animated) {
      delete source.document.animations
      delete source.document.nodes[3].extensions
      delete source.document.extensions.UV_game_variants
      source.document.extensionsUsed = source.document.extensionsUsed.filter(
        name => !['UV_game_socket', 'UV_game_variants', 'KHR_animation_pointer'].includes(name),
      )
    }
    source.document.materials = [
      {
        name: 'Plain',
        pbrMetallicRoughness: {
          metallicFactor: 0,
          roughnessFactor: 1,
          baseColorFactor: [0.25, 0.5, 1, 1],
        },
      },
    ]
    source.document.extensionsUsed = source.document.extensionsUsed.filter(
      name => name !== 'UV_game_material',
    )
    const material = (await decodeM3Materials(await encode(source), budget)).materials[0].shader
      .parameters.renderModel.standard
    assert.equal(material.unshaded, true)
    near(material.layers.decal.constantColor.value, [0.25, 0.5, 1, 1], 1 / 255)
    source.document.materials[0].pbrMetallicRoughness.metallicFactor = 1
    await assert.rejects(() => encode(source), /opaque nonmetallic rough material/)
  },
)

// Mixed joint-owned rigid draw: deliberately reordered skin slots and a nonidentity bind.
test('mixed rigid geometry uses the existing joint skin slot and inverse bind', async () => {
  const {prepareRigidM3Container}=await import('../src/m3/runtime/fresh-rigid.js')
  const translate=(x:number)=>[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]
  const source:any={format:'glb',binary:new Uint8Array(),extraChunks:[],document:{
    asset:{version:'2.0',extras:{uv:{format:'UVM',version:'1.0',profile:'core'}}},scene:0,scenes:[{nodes:[0,2]}],
    nodes:[{name:'root',children:[1]},{name:'rigid',mesh:1,translation:[5,0,0]},{mesh:0,skin:0}],
    skins:[{joints:[1,0],skeleton:0}],materials:[],extensionsUsed:['UV_asset','UV_provenance'],extensions:{UV_asset:{id:'mixed',class:'model'},UV_provenance:{source:{format:'uvm'},importer:{id:'test',version:'1'}}}}}
  const a=appendUvmAccessors(source,[
    {type:'VEC3',values:Float32Array.of(0,0,0,1,0,0,0,1,0)},
    {type:'SCALAR',values:Uint16Array.of(0,1,2)},
    {type:'VEC4',values:Uint16Array.of(1,0,0,0,1,0,0,0,1,0,0,0)},
    {type:'VEC4',values:Float32Array.of(1,0,0,0,1,0,0,0,1,0,0,0)},
    {type:'MAT4',values:Float32Array.from([...translate(-5),...translate(0)])},
    {type:'VEC3',values:Float32Array.of(0,0,1,0,0,1,0,0,1)}
  ],{...DEFAULT_UVM_CONTAINER_BUDGET,maxScalarBytes:budget.maxScalarBytes})
  const [position,indices,joints,weights,ibm,normal]=a.accessors
  const container:any=structuredClone(a.container)
  container.document.skins[0].inverseBindMatrices=ibm
  container.document.meshes=[{primitives:[{mode:4,indices,attributes:{POSITION:position,NORMAL:normal,JOINTS_0:joints,WEIGHTS_0:weights}}]},
    {primitives:[{mode:4,indices,attributes:{POSITION:position,NORMAL:normal}}]}]
  const uv=appendUvmAccessors(container,[{type:'VEC2',values:Float32Array.of(0,0,1,0,0,1)},{type:'SCALAR',values:Float32Array.of(0,.25)},{type:'VEC4',values:Float32Array.of(0,0,0,1,0,Math.SQRT1_2,0,Math.SQRT1_2)},{type:'VEC4',values:Float32Array.of(1,0,0,1,1,0,0,1,1,0,0,1)}],{...DEFAULT_UVM_CONTAINER_BUDGET,maxScalarBytes:budget.maxScalarBytes})
  container.binary=uv.container.binary;container.document=structuredClone(uv.container.document)
  container.document.materials=fixture().document.materials
  container.document.extensionsUsed.push('UV_game_material')
  for(const mesh of container.document.meshes)for(const p of mesh.primitives){p.material=0;p.attributes.TEXCOORD_0=uv.accessors[0];p.attributes.TANGENT=uv.accessors[3]}
  container.document.animations=[{name:'Turn',extras:{uv:{sourceDurationSeconds:.25,sourceSequenceIndex:0,looping:false}},samplers:[{input:uv.accessors[1],output:uv.accessors[2],interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:1,path:'rotation'}}]}]

  const before=structuredClone(container)
  const result=prepareRigidM3Container(container,budget)
  assert.deepEqual(container,before)
  assert.deepEqual(result.document.meshes[0],before.document.meshes[0])
  assert.deepEqual(result.document.skins,before.document.skins)
  assert.equal(result.document.nodes[1].mesh,undefined)
  assert.deepEqual(result.document.nodes[1].translation,[5,0,0])
  const parsed=readUvmModel(result.document,result.binary,budget)
  const rigid=parsed.scene.primitives[1]
  assert.deepEqual([...rigid.positions],[5,0,0,6,0,0,5,1,0])
  const {readUvmAccessor}=await import('@modkit/uv/model/accessor')
  assert.deepEqual([...readUvmAccessor(result.document,result.binary,result.document.meshes[1].primitives[0].attributes.JOINTS_0,budget,'joints').values],[0,0,0,0,0,0,0,0,0,0,0,0])
  // J(t)*IBM*(IBM^-1*v) must agree with independently evaluated original rigid draw.
  for(const animatedX of [5,7,11])for(let v=0;v<3;v++)
    assert.equal(animatedX-5+rigid.positions[v*3],animatedX+[0,1,0][v])
  const native=await encode(container)
  const geometry=await decodeM3Geometry(native,budget)
  const skeleton=await decodeM3Skeleton(native,budget)
  assert.equal(geometry.primitives.length,2)
  assert.equal(skeleton.bindings.length,2)
  assert.deepEqual(container,before)
  near([...geometry.primitives[1].positions],targetPoint([5,0,0]).concat(targetPoint([6,0,0]),targetPoint([5,1,0])))
  const animation=await decodeM3Animations(native,budget)
  const pose=createModelPoseSampler({bindings:skeleton.bindings,hierarchyId:'m3/bone-table',clip:animation.clips[0]})
  const bone=skeleton.bindings.find(b=>b.boneName==='rigid')
  const primitive=geometry.primitives[1]
  for(const time of [0,.125,.25]) {
    const angle=time/.25*Math.PI/2,cs=Math.cos(angle),sn=Math.sin(angle)
    const matrix=pose.sample(time).bones.find(b=>b.boneIndex===bone.boneIndex).skinningMatrix
    for(let v=0;v<3;v++)near(point(matrix,primitive.positions.slice(v*3,v*3+3)),targetPoint([5+cs*[0,1,0][v],[0,0,1][v],-sn*[0,1,0][v]]))
    const direction=(value:number[])=>point(matrix,value).map((n,k)=>n-point(matrix,[0,0,0])[k])
    near(direction([...primitive.normals.slice(0,3)]),[sn,-cs,0],.02)
    near(direction([...primitive.tangents.slice(0,3)]),[cs,sn,0],.02)
  }
  const malformed=structuredClone(before);malformed.document.skins[0].joints=[0]
  assert.throws(()=>prepareRigidM3Container(malformed,budget))
})
