import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { serializeM3SectionGraph } from '../dist/m3/native/structural.js'
import { materialLayerRecords } from '../dist/m3/uvm/material-layer-addresses.js'

const budget = { maxInputBytes: 16777216n, maxScalarBytes: 16777216,
  maxNodes: 100000, maxDepth: 96, maxDiagnostics: 100 }
const xml = () => readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
async function parse(bytes: Uint8Array) {
  return M3SectionList.load(bytes.slice().buffer, await xml())
}
function fixture(): any {
  const layer = (slot: string) => ({ slot, texturePath: `Assets/${slot}.dds`, uvSource: 0,
    channels: 1, wrapX: true, wrapY: true, uvOffset: { value: [0, 0], sequenceTracks: [
      { sequenceIndex: 0, track: { lineType: 1, keys: [
        { frame: 0, vector: [0, 0] }, { frame: 1, vector: [0.25, 0.5] },
      ] } },
    ] } })
  return { format: 'm3', meshes: [], skeleton: { bones: [] },
    materials: [
      { name: 'First', layers: [], standard: { layers: {} } },
      { name: 'Second', layers: [], standard: { layers: { emissive1: layer('emissive1') } } },
      { name: 'Displacement', layers: [], metadata: { presentation: 'screen-distortion' },
        standard: { layers: { normal: layer('normal') } } },
    ], animations: [{ name: 'Pulse', durationSeconds: 1, looping: true, nodeTracks: [] }],
    effects: { particles: [], ribbons: [] }, bounds: null }
}

/** Earlier MAT_ authors wrote 14 slots, before the four normal-blend slots. */
function oldLayout(sections: M3SectionList) {
  const remove = new Set<number>()
  const standards = sections.getSectionByReference(sections.model!['materials_standard'] as any)!
  for (const record of standards.content as any[]) {
    for (const field of ['layer_norm_blend1_mask', 'layer_norm_blend2_mask', 'layer_norm_blend1', 'layer_norm_blend2']) {
      remove.add(record[field].index)
      record[field].entries = 0
      record[field].index = 0
    }
  }
  const indices = new Map<number, number>()
  let next = 0
  for (let index = 0; index < sections.length; index++)
    if (!remove.has(index)) indices.set(index, next++)
  const seen = new WeakSet<object>()
  const relocate = (value: any) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Number.isInteger(value.entries) && Number.isInteger(value.index) && value.entries > 0)
      value.index = indices.get(value.index)
    for (const child of Object.values(value)) relocate(child)
  }
  for (const section of sections) for (const record of section.content) relocate(record)
  for (const index of [...remove].sort((a, b) => b - a)) sections.splice(index, 1)
}

it('restores material-layer headers by MATM owner across 14-slot and 18-slot layouts', async () => {
  const source = fixture()
  const original = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  oldLayout(original)
  const targets = materialLayerRecords(original).filter(({ materialLayer }: any) =>
    materialLayer.materialIndex === 1 && materialLayer.slot === 'emissive1' ||
    materialLayer.materialIndex === 2 && materialLayer.slot === 'normal')
  expect(targets).toHaveLength(2)
  const expectedIds = targets.map(({ record }: any, index: number) => {
    const previous = record.uv_offset.header.id
    const id = 700 + index
    Object.assign(record.uv_offset.header, { id, interpolation: 1, flags: 6 + index })
    for (const section of original.filter(value => ['STC_', 'STS_'].includes(value.desc.history.name)))
      for (const record of section.content as any[]) {
        const ids = original.getSectionByReference(record.anim_ids)?.content ?? []
        for (let offset = 0; offset < ids.length; offset++) if (ids[offset] === previous) ids[offset] = id
      }
    return id
  })
  const { decodeM3UvmSource } = await import(new URL('../src/m3/runtime/geometry.js', import.meta.url).href) as {
    decodeM3UvmSource(bytes: Uint8Array, resourceBudget: typeof budget): Promise<{ animationReferenceIds: any[] }>
  }
  const residual = await decodeM3UvmSource(serializeM3SectionGraph(original), budget)
  const captured = residual.animationReferenceIds.filter(binding => expectedIds.includes(binding.animId))
  expect(captured).toMatchObject([
    { materialLayer: { materialIndex: 1, slot: 'emissive1' }, field: 'uv_offset', sectionOrdinal: 18 },
    { materialLayer: { materialIndex: 2, slot: 'normal' }, field: 'uv_offset', sectionOrdinal: 28 },
  ])
  source.metadata = { m3AnimationReferenceIds: residual.animationReferenceIds }
  const rewritten = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  const rewrittenTargets = materialLayerRecords(rewritten).filter(({ materialLayer }: any) =>
    materialLayer.materialIndex === 1 && materialLayer.slot === 'emissive1' ||
    materialLayer.materialIndex === 2 && materialLayer.slot === 'normal')
  expect(rewrittenTargets).toHaveLength(2)
  rewrittenTargets.forEach(({ record }: any, index: number) => {
    expect(record.uv_offset).toMatchObject({ header: { id: expectedIds[index], interpolation: 1, flags: 6 + index }, default: { x: 0, y: 0 } })
  })
  const animationSections = rewritten.filter(value => ['STC_', 'STS_'].includes(value.desc.history.name))
  expect(Array.from(animationSections, value => value.desc.history.name).sort()).toEqual(['STC_', 'STS_'])
  for (const section of animationSections) {
    expect(section.content).toHaveLength(1)
    for (const record of section.content as any[]) {
      const ids = rewritten.getSectionByReference(record.anim_ids)?.content ?? []
      for (const id of expectedIds) expect(ids).toContain(id)
    }
  }
})

it('refuses legacy physical-only, missing and duplicate layer owners', async () => {
  const source = fixture()
  const binding: any = { tag: 'LAYR', sectionOrdinal: 18, recordIndex: 0,
    field: 'uv_offset', animId: 700, interpolation: 1, flags: 6 }
  source.metadata = { m3AnimationReferenceIds: [binding] }
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/semantic materialLayer owner/)
  binding.materialLayer = { materialIndex: 99, slot: 'emissive1' }
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/target is absent/)
  binding.materialLayer.materialIndex = 1
  source.metadata.m3AnimationReferenceIds.push({ ...binding, sectionOrdinal: 22 })
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/duplicated/)
})

it('captures composite pass aliases and restores shared native headers consistently', async () => {
  const source = fixture()
  const standard = source.materials[1].standard
  source.materials = [{ name: 'Composite', layers: [], composite: { priority: 0, passes: [
    { material: structuredClone(standard), alphaFactor: { value: 1 } },
    { material: structuredClone(standard), alphaFactor: { value: 1 } },
  ] } }]
  const original = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  const standards = original.getSectionByReference(original.model!['materials_standard'] as any)!.content as any[]
  // Two MATM surface references and their CMS passes now share the first native LAYR.
  Object.assign(standards[1].layer_emis1, standards[0].layer_emis1)
  const first = original.getSectionByReference(standards[0].layer_emis1)!.content[0] as any
  Object.assign(first.uv_offset.header, { id: 900, interpolation: 1, flags: 7 })
  const { decodeM3UvmSource } = await import(new URL('../src/m3/runtime/geometry.js', import.meta.url).href) as {
    decodeM3UvmSource(bytes: Uint8Array, resourceBudget: typeof budget): Promise<{ animationReferenceIds: any[] }>
  }
  const residual = await decodeM3UvmSource(serializeM3SectionGraph(original), budget)
  const aliases = residual.animationReferenceIds.filter(binding => binding.animId === 900)
  expect(aliases.map(binding => binding.materialLayer)).toEqual([
    { materialIndex: 0, passIndex: 0, slot: 'emissive1' },
    { materialIndex: 0, passIndex: 1, slot: 'emissive1' },
    { materialIndex: 1, slot: 'emissive1' },
    { materialIndex: 2, slot: 'emissive1' },
  ])
  // The displaced orphan remains explicitly physical-only, so fresh export refuses the full residual.
  expect(residual.animationReferenceIds.some(binding => binding.tag === 'LAYR' && !binding.materialLayer)).toBe(true)
  source.metadata = { m3AnimationReferenceIds: residual.animationReferenceIds }
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/semantic materialLayer owner/)
  source.metadata.m3AnimationReferenceIds = residual.animationReferenceIds.filter(binding => binding.materialLayer)
  const rewritten = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  const targets = materialLayerRecords(rewritten).filter(({ materialLayer }: any) => materialLayer.slot === 'emissive1')
  expect(targets).toHaveLength(4)
  for (const { record } of targets as any[])
    expect(record.uv_offset.header).toMatchObject({ id: 900, interpolation: 1, flags: 7 })
  source.metadata.m3AnimationReferenceIds = aliases.map(binding => structuredClone(binding))
  source.metadata.m3AnimationReferenceIds[2].flags = 8
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/shared animation reference headers conflict/)
})

it('bounds and cancels material traversal and refuses direct composite cycles', async () => {
  const source = fixture()
  const sections = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  expect(() => materialLayerRecords(sections, { maxNodes: 1 })).toThrow(/node budget/)
  const controller = new AbortController()
  controller.abort()
  expect(() => materialLayerRecords(sections, { maxNodes: budget.maxNodes, signal: controller.signal })).toThrow(/abort/i)
  source.materials = [{ name: 'Composite', layers: [], composite: { priority: 0, passes: [
    { material: { layers: {} }, alphaFactor: { value: 1 } },
  ] } }]
  const cyclic = await parse((await encodeM3JsonModel(source, {}, budget)).bytes)
  const composite = cyclic.getSectionByReference(cyclic.model!['materials_composite'] as any)!.content[0] as any
  const pass = cyclic.getSectionByReference(composite.sections)!.content[0] as any
  pass.material_reference_index = 0
  expect(() => materialLayerRecords(cyclic)).toThrow(/reference cycle/)
})
