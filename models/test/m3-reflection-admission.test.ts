// Synthetic native REF_ admission and write-loss controls; no installed content or pixel parity.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { revisionId } from '@modkit/sdk'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { M3Model } from '../dist/m3/native/model.js'
import { appendM3Section, pointM3ReferenceAtSection, serializeM3SectionGraph } from '../dist/m3/native/structural.js'
import { buildRenderMaterials, assertM3MaterialProjection, m3MaterialProjectionRefusals, m3MaterialLossMetadata } from '../dist/m3/native/builder/standard-material.js'
import { nativeCompositePassIndices, materialLayerRecords } from '../dist/m3/uvm/material-layer-addresses.js'
import { decodeMaterialParameters } from '../dist/m3/material-parameters.js'
import { bindM3MaterialTracks } from '../dist/m3/uvm/material-binding.js'
import { decodeM3Materials } from '../src/m3/runtime/material.js'
import { decodeM3UvmSource } from '../src/m3/runtime/geometry.js'
import { convertM3ProjectionToUvm, exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { exportFreshM3FromUvm } from '../src/m3/runtime/fresh-export.js'

const budget = { maxInputBytes: 16777216n, maxScalarBytes: 16777216, maxNodes: 100000,
  maxDepth: 128, maxDiagnostics: 100 }
const limits = { ...budget, maxInputBytes: Number(budget.maxInputBytes), maxJsonBytes: budget.maxScalarBytes }
const xml = () => readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
async function parse(bytes: Uint8Array): Promise<any> {
  return M3SectionList.load(Uint8Array.from(bytes).buffer, await xml())
}
function source(composite = true, used = true): any {
  const standard = (index: number) => ({ layers: { diffuse: { slot: 'diffuse',
    texturePath: `Assets/control-${index}.dds`, uvSource: 0, channels: 1,
    uvOffset: { value: [0, 0], sequenceTracks: [{ sequenceIndex: 0, track: { lineType: 1,
      keys: [{ frame: 0, vector: [0, 0] }, { frame: 1, vector: [index + 1, 0] }] } }] } } },
    blendMode: 2, priority: index })
  return { format: 'm3', skeleton: { bones: [] },
    meshes: used ? [{ name: 'triangle', materialIndex: 0, positions: [0,0,0,1,0,0,0,1,0],
      normals: [0,0,1,0,0,1,0,0,1], uvs: [0,0,1,0,0,1], indices: [0,1,2] }] : [],
    materials: [composite
      ? { name: 'Composite', layers: [], composite: { priority: 7,
          passes: [0,1,2].map(index => ({ material: standard(index), alphaFactor: { value: (index + 1) / 4 } })) } }
      : { name: 'Standalone', layers: [], standard: standard(0) }],
    animations: [{ name: 'Stand', durationSeconds: 1, looping: true, nodeTracks: [] }],
    effects: { particles: [], ribbons: [] }, bounds: null }
}
async function fixture(positions: number[], composite = true, used = true) {
  const original = source(composite, used)
  // Native composite tracks come from real animated MAT_ records; the fresh composite writer
  // does not author them. Alias CMS to these generated standalone MAT_ records before REF_ edit.
  if (composite) original.materials.push(...original.materials[0].composite.passes.map((pass: any,index: number) =>
    ({ name: `Animated_${index}`, layers: [], standard: structuredClone(pass.material) })))
  const sections = await parse((await encodeM3JsonModel(original, {}, budget)).bytes)
  const native = sections.model
  const references = sections.getSectionByReference(native.material_references).content
  const record = sections.structureHistories.REF_.getVersion(3, 34, sections.structureHistories).instance()
  const standards=sections.getSectionByReference(native.materials_standard).content
  Object.assign(record.layer_reflection,standards[0].layer_diff)
  pointM3ReferenceAtSection(sections, native.materials_reflection,
    appendM3Section(sections, 'REF_', 3, [record]))
  const passes = composite
    ? sections.getSectionByReference(sections.getSectionByReference(native.materials_composite).content[0].sections).content
    : undefined
  if (passes) passes.forEach((pass: any,index: number) => { pass.material_reference_index=index+1 })
  for (const index of positions) {
    const reference = references[passes ? passes[index].material_reference_index : 0]
    reference.type = 10
    reference.material_index = 0
  }
  return { original, sections, bytes: serializeM3SectionGraph(sections) }
}

it.each([0,1,2])('omits only REF_ at CMS %s and retains supported animation/order/alpha', async position => {
  const { sections, original } = await fixture([position])
  const decoded = buildRenderMaterials(sections.model, sections)
  const material = decoded.materials[0]
  const expected = [0,1,2].filter(index => index !== position)
  expect(material.metadata.m3NativeCompositePassIndices).toEqual(expected)
  expect(material.metadata.m3UnsupportedMaterialFamilies).toEqual(['REF_'])
  expect(material.composite.priority).toBe(7)
  expect(material.composite.passes.map((pass: any) => pass.alphaFactor.value)).toEqual(expected.map(index => (index + 1)/4))
  expect(material.composite.passes.map((pass: any) => pass.material.blendMode)).toEqual([2,2])
  expect(material.composite.passes.map((pass: any) => pass.material.layers.diffuse.texturePath))
    .toEqual(expected.map(index => `Assets/control-${index}.dds`))
  for (const [projected, nativeIndex] of expected.entries()) {
    const offset = material.composite.passes[projected].material.layers.diffuse.uvOffset
    expect(offset.sequenceTracks[0].track.keys.at(-1).vector).toEqual([nativeIndex + 1, 0])
    expect(material.composite.passes[projected].material.layers.envi).toBeUndefined()
  }
  expect(() => assertM3MaterialProjection(m3MaterialProjectionRefusals(decoded.materials), [0])).not.toThrow()
  expect(decoded.diagnostics.some((item: any) => item.code === 'material-reference-invalid')).toBe(false)
  expect(decoded.diagnostics.some((item: any) => item.code === 'material-reflection-unsupported')).toBe(true)
  const projected = decodeMaterialParameters(sections, budget).materials
  const binding = bindM3MaterialTracks(projected.map((material: any, referenceIndex: number) => ({ ...material, referenceIndex })),
    [], [{ source: 'base', nativeSequenceIndex: 0, combinedSequenceIndex: 0 }], budget)
  const program = binding.materials[0].shader.parameters.renderModel
  expect(program.metadata.m3UnsupportedMaterialFamilies).toEqual(['REF_'])
  expect(program.metadata.m3NativeCompositePassIndices).toEqual(expected)
  await expect(encodeM3JsonModel({ ...original, materials: [{ name: 'Composite', ...program }] }, {}, budget))
    .rejects.toThrow(/unsupported native material REF_/)
})

it('distinguishes a missing REF_ record from supported-native-but-unrendered reflection', async () => {
  const { sections } = await fixture([0])
  const references = sections.getSectionByReference(sections.model.material_references).content
  const reflection = references.find((record: any) => record.type === 10)
  reflection.material_index = 99
  const decoded = buildRenderMaterials(sections.model, sections)
  expect(decoded.diagnostics).toContainEqual(expect.objectContaining({ code: 'material-reference-invalid' }))
  expect(decoded.materials[references.indexOf(reflection)].metadata.sourceMaterialTag).toBeUndefined()
})

it('maps compact emitted pass headers back to original CMS addresses in the existing writer', async () => {
  const original = source()
  original.materials[0].metadata = { m3NativeCompositePassIndices: [1,3,5] }
  const initial = await parse((await encodeM3JsonModel(original, {}, budget)).bytes)
  const bindings = materialLayerRecords(initial, { passIndices: [[1,3,5]] })
    .filter((item: any) => item.materialLayer.materialIndex === 0 && item.materialLayer.slot === 'diffuse')
    .map(({ materialLayer }: any, index: number) => ({ tag: 'LAYR', sectionOrdinal: 0, recordIndex: 0,
      field: 'uv_offset', animId: 800 + index, interpolation: 1, flags: 6, materialLayer }))
  original.metadata = { m3AnimationReferenceIds: bindings }
  const restored = await parse((await encodeM3JsonModel(original, {}, budget)).bytes)
  const headers = materialLayerRecords(restored, { passIndices: [[1,3,5]] })
    .filter((item: any) => item.materialLayer.materialIndex === 0 && item.materialLayer.slot === 'diffuse')
  expect(headers.map((item: any) => item.materialLayer.passIndex)).toEqual([1,3,5])
  expect(headers.map((item: any) => item.record.uv_offset.header.id)).toEqual([800,801,802])
})

it.each([[0,0], [1,0], [1,1], [-1], ['0']].map(values=>[values]))('rejects malformed original CMS mapping %j', values => {
  expect(() => nativeCompositePassIndices({ m3NativeCompositePassIndices: values }, values.length)).toThrow(/mapping is invalid/)
})

it.each([false,true])('refuses referenced standalone/all-REF composite; unused native inspection remains possible (%s)', async composite => {
  const { bytes, sections } = await fixture(composite ? [0,1,2] : [0], composite)
  expect(new M3Model(sections).materials.length).toBeGreaterThan(0)
  const decoded = buildRenderMaterials(sections.model, sections)
  expect(() => assertM3MaterialProjection(m3MaterialProjectionRefusals(decoded.materials), [])).not.toThrow()
  expect(() => new M3Model(sections).toRenderModel()).toThrow(/unsupported reflection render projection/)
  const result = await decodeM3Materials(bytes, budget)
  expect(result.fatal).toBe(true)
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'x3.m3/material-projection-unsupported' }))
  const unused = await fixture(composite ? [0,1,2] : [0], composite, false)
  expect((await decodeM3Materials(unused.bytes, budget)).fatal).toBe(false)
})

it.each([['particle_systems','PAR_',24], ['ribbons','RIB_',9], ['projections','PROJ',5]])('refuses effect reference to standalone REF_ through %s', async (field, tag, version) => {
  const { sections } = await fixture([0], false, false)
  const effect = sections.structureHistories[tag].getVersion(version,34,sections.structureHistories).instance()
  effect.material_reference_index = 0
  pointM3ReferenceAtSection(sections,sections.model[field],appendM3Section(sections,tag,version,[effect]))
  expect(() => new M3Model(sections).toRenderModel()).toThrow(/unsupported reflection render projection/)
  const result = await decodeM3Materials(serializeM3SectionGraph(sections),budget)
  expect(result.fatal).toBe(true)
  expect(result.issues).toContainEqual(expect.objectContaining({ code:'x3.m3/material-projection-unsupported' }))
  effect.material_reference_index=99
  const invalid=await decodeM3Materials(serializeM3SectionGraph(sections),budget)
  expect(invalid.issues.some((item: any)=>item.code==='x3.m3/material-projection-unsupported')).toBe(false)
})

it('keeps bounded snapshot and decoder failure precedence for REF_ material admission', async () => {
  const { bytes,sections }=await fixture([1])
  const result=await decodeM3Materials(bytes,budget)
  expect(result.fatal).toBe(false)
  const refused=await decodeM3Materials(bytes,{...budget,maxScalarBytes:result.decodedBytes-1})
  expect(refused.fatal).toBe(true)
  expect(refused.issues).toContainEqual(expect.objectContaining({code:'x3.m3/material-budget-exceeded'}))
  expect(()=>decodeMaterialParameters(sections,{...budget,maxNodes:3})).toThrow(/maxNodes/)
  expect(()=>decodeMaterialParameters(sections,budget,AbortSignal.abort())).toThrow(/cancelled/)
})

const emptyProjection: any = { info: { scenes:1,nodes:0,meshes:0,primitives:0,materials:0,textures:0,animations:0,geometryAccess:'decoded' },
  nodes:[],meshes:[],primitives:[],materials:[],animations:[] }
it('carries UNUSED native REF_ source-wide loss through UVM and refuses both fresh policies before fallback', async () => {
  const { bytes,sections } = await fixture([0],false,false)
  const decoded = await decodeM3UvmSource(bytes,budget)
  expect(decoded.metadata.m3UnsupportedMaterialFamilies).toEqual(['REF_'])
  expect(m3MaterialLossMetadata(sections.model,sections)).toEqual({m3UnsupportedMaterialFamilies:['REF_']})
  const output = await convertM3ProjectionToUvm(bytes,emptyProjection,decoded.metadata,{assetId:'reflection',
    subjectRevision:revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),metersPerSourceUnit:1,budget:limits})
  const residual = output.container.document.extras.BlizzardM3.residual
  expect(residual.m3UnsupportedMaterialFamilies).toEqual(['REF_'])
  expect(residual.sourceBytes).toBeUndefined()
  for(const policy of ['strict','base-color-coverage'])
    await expect(exportFreshM3FromUvm(output.container,1,limits,undefined,'m3',[],policy)).rejects.toThrow(/unsupported native material REF_/)
  for(const invalid of [null,false,[],{},'REF_']) {
    const container=structuredClone(output.container)
    container.document.extras.BlizzardM3.residual.m3UnsupportedMaterialFamilies=invalid
    await expect(exportFreshM3FromUvm(container,1,limits)).rejects.toThrow(/unsupported native material REF_/)
  }
  await expect(encodeM3JsonModel({...source(false,false),metadata:decoded.metadata},{},budget)).rejects.toThrow(/unsupported native material REF_/)
})

it('leaves nonREF surfaces, native capture, and source-free-without-marker behavior working', async () => {
  const bytes=(await encodeM3JsonModel(source(false,false),{},budget)).bytes
  const sections=await parse(bytes)
  expect(m3MaterialLossMetadata(sections.model,sections)).toEqual({})
  expect((await decodeM3Materials(bytes,budget)).fatal).toBe(false)
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  const plainProjection={...emptyProjection,
    info:{...emptyProjection.info,nodes:1,meshes:1,primitives:1,materials:1},
    nodes:[{id:'draw',childIds:[],meshIds:['mesh'],transform:identity}],
    meshes:[{id:'mesh',primitiveIds:['triangle']}],
    primitives:[{id:'triangle',topology:'triangles',positions:new Float32Array([0,0,0,1,0,0,0,1,0]),
      normals:new Float32Array([0,0,1,0,0,1,0,0,1]),textureCoordinates:new Float32Array([0,0,1,0,0,1]),
      indices:new Uint32Array([0,1,2]),materialId:'plain'}],
    materials:[{id:'plain',baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:1,alphaMode:'opaque'}]}
  const result=await convertM3ProjectionToUvm(bytes,plainProjection,{mdVersion:34},{assetId:'plain',
    subjectRevision:revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),metersPerSourceUnit:1,budget:limits})
  expect(result.container.document.extras.BlizzardM3.residual.m3UnsupportedMaterialFamilies).toBeUndefined()
  const rewritten=await exportM3FromUvm(result.container,limits)
  expect(rewritten).toBeDefined()
})
