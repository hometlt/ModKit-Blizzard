import assert from 'node:assert/strict'
import { test } from 'vitest'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { DEFAULT_UVM_CONTAINER_BUDGET, writeUvmContainer } from '@modkit/uv/model/container'
import { encodeM3UvmBytes } from '../src/m3/uvm/write-operation.js'
import { decodeM3Materials } from '../src/m3/runtime/material.js'
import { decodeM3Geometry } from '../src/m3/runtime/geometry.js'
import { createProvider } from '../src/m3/native-encoder.js'

const budget = { maxInputBytes: 16777216n, maxScalarBytes: 16777216,
  maxNodes: 100000, maxDepth: 96, maxDiagnostics: 100 }

/** Independently authored portable triangle and foreign material, without native residuals. */
function fixture(): any {
  const source: any = { format: 'glb', binary: new Uint8Array(), extraChunks: [], document: {
    asset: { version: '2.0', extras: { uv: { format: 'UVM', version: '1.0', profile: 'core' } } },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    materials: [{ name: 'Foreign', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1,
      baseColorTexture: { index: 0 } }, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true,
      extensions: { UV_game_material: { shader: 'foreign.fx', params: { DamageTexture: 'Damaged.dds' } } } }],
    textures: [{ source: 0 }], images: [{ uri: 'media/Hull.png', name: 'Assets/Hull.dds' }],
    extensionsUsed: ['UV_asset', 'UV_provenance', 'UV_game_material'], meshes: [],
    extensions: { UV_asset: { id: 'foreign-material-fixture', class: 'prop' },
      UV_provenance: { source: { format: 'uvm' }, importer: { id: 'authored-fixture', version: '1' } } },
  } }
  const result = appendUvmAccessors(source, [
    { type: 'VEC3', values: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) },
    { type: 'VEC3', values: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1) },
    { type: 'VEC2', values: Float32Array.of(0, 0, 1, 0, 0, 1) },
  ], { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes })
  const container: any = structuredClone(result.container)
  container.document.meshes = [{ primitives: [{ mode: 4, material: 0,
    attributes: { POSITION: result.accessors[0], NORMAL: result.accessors[1], TEXCOORD_0: result.accessors[2] } }] }]
  return container
}
/** Same byte encoder as the native provider; strict is deliberately the default. */
function encode(container: any, policy: 'strict' | 'base-color-coverage' = 'strict', notes: string[] = []) {
  return encodeM3UvmBytes(writeUvmContainer(container), budget, undefined, 'm3', 1, policy, notes)
}

test('foreign shader requires explicit approximation; MASK, culling, UV and geometry reopen', async () => {
  const source = fixture(), notes: string[] = []
  await assert.rejects(() => encode(source), /explicit common RenderMaterial/)
  const native = await encode(source, 'base-color-coverage', notes)
  const material = (await decodeM3Materials(native, budget)).materials[0].shader.parameters.renderModel.standard
  assert.equal(material.layers.decal.texturePath, 'Assets/Hull.dds')
  assert.equal(material.layers.alpha1.texturePath, 'Assets/Hull.dds')
  assert.equal(material.layers.alpha1.channels, 2) // AAAA: cut by texture alpha, not RGB brightness.
  assert.equal(material.layers.decal.channels, 1)
  assert.equal(material.depthPrepass, true)
  assert.ok(Math.abs(material.alphaTestThreshold - 0.5) < 1 / 255)
  assert.equal(material.twoSided, true)
  assert.equal(material.layers.decal.wrapX, true)
  assert.equal(material.layers.decal.uvSource, 0)
  assert.equal((await decodeM3Geometry(native, budget)).primitives[0].positions.length, 9)
  assert.match(notes[0], /omitted source shader, normal, specular/)
  assert.equal(source.document.materials[0].extensions.UV_game_material.shader, 'foreign.fx')
})

test('OPAQUE ignores stored alpha and uses a lit, nonmetallic base color', async () => {
  const source = fixture()
  source.document.materials[0].alphaMode = 'OPAQUE'
  const material = (await decodeM3Materials(await encode(source, 'base-color-coverage'), budget))
    .materials[0].shader.parameters.renderModel.standard
  assert.equal(material.alphaTestThreshold, 0)
  assert.equal(material.unshaded, false)
  assert.equal(material.layers.alpha1, undefined)
  assert.equal(material.layers.diffuse.channels, 0)
  assert.equal(material.layers.diffuse.texturePath, 'Assets/Hull.dds')
  assert.equal(material.layers.decal, undefined)
  assert.equal(material.depthPrepass, true)
})

test('common RGB diffuse and independent alpha preserve texture slots and fractional coverage', async () => {
  let source=fixture()
  const common=(await decodeM3Materials(await encode(source,'base-color-coverage'),budget))
    .materials[0].shader.parameters.renderModel
  const layers=common.standard.layers
  layers.diffuse={...layers.decal,slot:'diffuse',channels:0,op:6}
  delete layers.decal
  // This authors a new portable program; stale native flag hints must not override its alpha flag.
  delete common.standard.sourceFlags; delete common.standard.sourceAdditionalFlags
  common.layers=[] // Drop the old native decal resource list along with its program slot.
  common.standard.blendMode=1;common.standard.alphaTestThreshold=0;common.standard.usesVertexAlpha=true
  source.document.materials[0].alphaMode='BLEND'
  source.document.materials[0].extensions.UV_game_material={shader:'modkit.render-material.v1',params:{renderModel:common}}
  const a=appendUvmAccessors(source,[{type:'VEC4',values:Float32Array.of(1,1,1,.25,1,1,1,.5,1,1,1,.75)}],
    {...DEFAULT_UVM_CONTAINER_BUDGET,maxScalarBytes:budget.maxScalarBytes})
  source=structuredClone(a.container);source.document.meshes[0].primitives[0].attributes.COLOR_0=a.accessors[0]
  const before=writeUvmContainer(source),native=await encode(source)
  const material=(await decodeM3Materials(native,budget)).materials[0].shader.parameters.renderModel.standard
  assert.equal(material.layers.diffuse.texturePath,'Assets/Hull.dds')
  assert.equal(material.layers.diffuse.channels,0);assert.equal(material.layers.diffuse.op,6)
  assert.equal(material.layers.decal,undefined)
  assert.equal(material.layers.alpha1.texturePath,'Assets/Hull.dds');assert.equal(material.layers.alpha1.channels,2)
  assert.equal(material.usesVertexAlpha,true)
  const colors=(await decodeM3Geometry(native,budget)).primitives[0].colors
  for(let i=0;i<3;i++)assert.ok(Math.abs(colors[i*4+3]-[.25,.5,.75][i])<=1/255)
  assert.deepEqual(writeUvmContainer(source),before)
})

test('common additive RGB and cut-out alpha avoid implicit diffuse team colour', async () => {
  const source = fixture()
  const common = (await decodeM3Materials(await encode(source, 'base-color-coverage'), budget))
    .materials[0].shader.parameters.renderModel
  const layers = common.standard.layers
  layers.diffuse = {...layers.decal, slot:'diffuse', op:2, channels:1, teamColorMode:0}
  delete layers.decal; delete layers.alpha1
  source.document.materials[0].extensions.UV_game_material = {
    shader:'modkit.render-material.v1', params:{renderModel:common},
  }
  const material = (await decodeM3Materials(await encode(source), budget))
    .materials[0].shader.parameters.renderModel.standard
  assert.equal(material.layers.diffuse.teamColorMode, 0)
  assert.equal(material.layers.decal.texturePath, 'Assets/Hull.dds')
  assert.equal(material.layers.decal.op, 2)
  assert.equal(material.layers.alpha1.channels, 2)
})

test('refuses unresolved/embedded/remote images, transformed/mirrored UVs and invalid coverage', async () => {
  for (const mutate of [
    (s: any) => { s.document.textures[0].source = 7 },
    (s: any) => { s.document.images[0].uri = 'data:image/png;base64,AA==' },
    (s: any) => { s.document.images[0].uri = 'https://example.test/Hull.png' },
    (s: any) => { s.document.images[0].uri = '../Hull.png' },
    (s: any) => { s.document.materials[0].pbrMetallicRoughness.baseColorTexture.extensions = { KHR_texture_transform: {} } },
    (s: any) => { s.document.samplers = [{ wrapS: 33648 }]; s.document.textures[0].sampler = 0 },
    (s: any) => { s.document.materials[0].alphaMode = 'UNKNOWN' },
  ]) {
    const source = fixture(); mutate(source)
    await assert.rejects(() => encode(source, 'base-color-coverage'), /unresolved|external image|portable asset|transformed|mirrored|tint|OPAQUE/)
  }
})

test('BLEND preserves texture alpha factor independently from RGB tint and skips depth prepass', async () => {
  const source=fixture()
  source.document.materials[0].alphaMode='BLEND'
  source.document.materials[0].pbrMetallicRoughness.baseColorFactor=[.5,.5,.5,.4]
  const material=(await decodeM3Materials(await encode(source,'base-color-coverage'),budget))
    .materials[0].shader.parameters.renderModel.standard
  assert.equal(material.blendMode,1);assert.equal(material.alphaTestThreshold,0)
  assert.equal(material.depthPrepass,false);assert.equal(material.layers.alpha1.channels,2)
  assert.equal(material.layers.alpha1.colorMultiply.value,Math.fround(.4))
  assert.equal(material.layers.decal.colorMultiply.value,.5)
})

test('unsupported scene reflection falls back only under explicit material approximation', async () => {
  const source=fixture()
  const common=(await decodeM3Materials(await encode(source,'base-color-coverage'),budget)).materials[0].shader.parameters.renderModel
  common.standard.layers.envi={...common.standard.layers.decal,slot:'envi',texturePath:null,sceneEnvironment:true}
  source.document.materials[0].extensions.UV_game_material={shader:'modkit.render-material.v1',params:{renderModel:common}}
  await assert.rejects(()=>encode(source),/sceneEnvironment/)
  const notes=[];const material=(await decodeM3Materials(await encode(source,'base-color-coverage',notes),budget)).materials[0].shader.parameters.renderModel.standard
  assert.equal(material.layers.envi,undefined)
  assert.ok(notes.some(note=>note.includes('scene environment')))
})

test('retains an existing common RenderMaterial rather than replacing it with PBR', async () => {
  const source = fixture()
  const common = (await decodeM3Materials(await encode(source, 'base-color-coverage'), budget))
    .materials[0].shader.parameters.renderModel
  source.document.materials[0].extensions.UV_game_material = {
    shader: 'modkit.render-material.v1', params: { renderModel: common, SourceDamageState: 7 },
  }
  const notes: string[] = []
  await assert.rejects(() => encode(source), /material parameters.SourceDamageState/)
  const native = await encode(source, 'base-color-coverage', notes)
  const actual = (await decodeM3Materials(native, budget)).materials[0].shader.parameters.renderModel
  assert.equal(actual.standard.layers.decal.texturePath, common.standard.layers.decal.texturePath)
  assert.equal(actual.standard.alphaTestThreshold, common.standard.alphaTestThreshold)
  assert.equal(actual.standard.twoSided, common.standard.twoSided)
  assert.match(notes[0], /retained the common RenderMaterial/)
  assert.ok(notes.every(note => !note.includes('approximated with base color')))
})

test('preserves glTF vertex color and MASK vertex alpha multipliers', async () => {
  const source = fixture()
  const result = appendUvmAccessors(source, [{ type: 'VEC4', values:
    Float32Array.of(1, 0, 0, 1, 0, 1, 0, 0.25, 0, 0, 1, 0.75) }],
    { ...DEFAULT_UVM_CONTAINER_BUDGET, maxScalarBytes: budget.maxScalarBytes })
  const colored: any = structuredClone(result.container)
  colored.document.meshes[0].primitives[0].attributes.COLOR_0 = result.accessors[0]
  const native = await encode(colored, 'base-color-coverage')
  const material = (await decodeM3Materials(native, budget)).materials[0].shader.parameters.renderModel.standard
  assert.equal(material.usesVertexColor, true)
  assert.equal(material.usesVertexAlpha, true)
  assert.ok((await decodeM3Geometry(native, budget)).primitives[0].colors.length > 0)
})

test('native encoder validates policy and returns conversion warnings with bytes', async () => {
  const lease = createProvider({ contract: 'common.model/native-encoder', major: 1,
    offerId: 'm3-from-uvm', contractSelectionKey: 'format=m3' }, { budgets: budget })
  try {
    const uvm = writeUvmContainer(fixture())
    await assert.rejects(() => lease.value.encode({ uvm, options: { materialPolicy: 'unknown' } }), /materialPolicy/)
    const result = await lease.value.encode({ uvm, options: { materialPolicy: 'base-color-coverage' } })
    assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 4)), '43DM')
    assert.ok(result.diagnostics.some(d => d.code === 'blizzard/m3-conversion-loss' && d.severity === 'warning'))
  } finally { await lease.release() }
})

test('explicit non-grey texture tint becomes native vertex RGB without multiplying alpha',async()=>{
  const source=fixture(),notes:string[]=[]
  source.document.materials[0].pbrMetallicRoughness.baseColorFactor=[1,.5,.25,.4]
  const before=structuredClone(source)
  const native=await encode(source,'base-color-coverage',notes)
  assert.deepEqual(source,before)
  const m=(await decodeM3Materials(native,budget)).materials[0].shader.parameters.renderModel.standard
  assert.equal(m.usesVertexColor,true);assert.equal(m.layers.alpha1.colorMultiply.value,Math.fround(.4))
  const colors=(await decodeM3Geometry(native,budget)).primitives[0].colors
  for(let i=0;i<3;i++)for(let k=0;k<4;k++)assert.ok(Math.abs(colors[i*4+k]-[1,.5,.25,1][k])<=1/255)
  assert.ok(notes.some(n=>n.includes('RGB factor moved')))
})

test.each(['rgb8','rgba16','rgbaFloat'])('RGB tint preserves existing %s vertex colors and alpha',async kind=>{
  let source=fixture()
  const raw=kind==='rgb8'?Uint16Array.of(255,128,64,255,128,64,255,128,64):kind==='rgba16'?Uint16Array.of(65535,32768,16384,32768,65535,32768,16384,32768,65535,32768,16384,32768):Float32Array.of(1,.5,.25,.5,1,.5,.25,.5,1,.5,.25,.5)
  const a=appendUvmAccessors(source,[{type:kind==='rgb8'?'VEC3':'VEC4',values:raw}],{...DEFAULT_UVM_CONTAINER_BUDGET,maxScalarBytes:budget.maxScalarBytes})
  source=structuredClone(a.container);source.document.meshes[0].primitives[0].attributes.COLOR_0=a.accessors[0]
  if(kind!=='rgbaFloat')source.document.accessors[a.accessors[0]].normalized=true
  if(kind==='rgb8'){const attr=source.document.accessors[a.accessors[0]],view=source.document.bufferViews[attr.bufferView];attr.componentType=5121;source.binary.set(Uint8Array.from(raw),view.byteOffset+(attr.byteOffset??0))}
  source.document.materials[0].pbrMetallicRoughness.baseColorFactor=[1,.5,.25,.4]
  const original=writeUvmContainer(source),native=await encode(source,'base-color-coverage')
  assert.deepEqual(writeUvmContainer(source),original)
  const colors=(await decodeM3Geometry(native,budget)).primitives[0].colors
  for(let v=0;v<3;v++)for(let k=0;k<4;k++)assert.ok(Math.abs(colors[v*4+k]-[1,.25,.0625,kind==='rgb8'?1:.5][k])<2/255)
})

test('uniform M3 layout fills only texture coordinate sets unused by that region',async()=>{
  let source=fixture()
  const a=appendUvmAccessors(source,[{type:'VEC2',values:Float32Array.of(.2,.3,.4,.5,.6,.7)},{type:'VEC4',values:Float32Array.of(1,0,0,1,1,0,0,1,1,0,0,1)}],{...DEFAULT_UVM_CONTAINER_BUDGET,maxScalarBytes:budget.maxScalarBytes})
  source=structuredClone(a.container)
  const p=structuredClone(source.document.meshes[0].primitives[0]);p.attributes.TEXCOORD_1=a.accessors[0];p.attributes.TANGENT=a.accessors[1]
  source.document.meshes[0].primitives.push(p)
  const native=await encode(source,'base-color-coverage')
  const g=await decodeM3Geometry(native,budget)
  assert.ok(g.primitives[0].textureCoordinateSets.find(s=>s.set===1).coordinates.every(v=>Math.abs(v)<1e-8))
  assert.ok(g.primitives[0].tangents)
  source.document.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord=1
  await assert.rejects(()=>encode(source,'base-color-coverage'),/missing sampled UV1/)
})
