import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decodeM3Materials } from '../src/m3/material.node.js'
import { decodeMaterialParameters } from '../dist/m3/material-parameters.js'

const fixtures = new URL('./fixtures/m3/', import.meta.url)
const budget = { maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 256 * 1024 * 1024 }

describe('M3 material parameters through the MK3 boundary', () => {
  for (const file of ['model.m3', 'corpus/portrait.m3', 'corpus/Harbinger.m3', 'corpus/analysisterminal.m3', 'corpus/aiur_cliffrocks_00.m3']) {
    it(`decodes every material within its budget for ${file}`, async () => {
      const bytes = new Uint8Array(await readFile(new URL(file, fixtures)))
      const decoded = await decodeM3Materials(bytes, budget)
      expect(decoded.fatal).toBe(false)
      const refused = await decodeM3Materials(bytes, { ...budget, maxScalarBytes: decoded.decodedBytes - 1 })
      expect(refused.fatal).toBe(true)
      expect(refused.issues).toContainEqual(expect.objectContaining({ code: 'x3.m3/material-budget-exceeded' }))
    })
  }

  it('bounds repeated composite passes and preserves their alpha and priority', () => {
    const table: { content: unknown[] }[] = []
    const ref = (content: unknown[]) => { table.push({ content }); return { entries: content.length, index: table.length - 1 } }
    const standard = { blend_mode: 2, priority: 3 }
    const composite = { priority: 7, sections: ref([
      { material_reference_index: 0, alpha_factor: { default: 0.25 } },
      { material_reference_index: 0, alpha_factor: { default: 0.75 } },
    ]) }
    const model = {
      material_references: ref([{ type: 1, material_index: 0 }, { type: 3, material_index: 0 }]),
      materials_standard: ref([standard]), materials_composite: ref([composite]),
    }
    const sections = { model, getSectionByReference: (value: { index: number }) => table[value.index] }
    const decoded = decodeMaterialParameters(sections, budget)
    expect(decoded.diagnostics).toEqual([])
    const passes = decoded.materials[1].shader.parameters.renderModel.composite
    expect(passes.priority).toBe(7)
    expect(passes.passes.map(pass => pass.alphaFactor.value)).toEqual([0.25, 0.75])
    expect(passes.passes.map(pass => pass.material.blendMode)).toEqual([2, 2])
    expect(() => decodeMaterialParameters(sections, { ...budget, maxNodes: 3 })).toThrow(/maxNodes/)
    expect(() => decodeMaterialParameters(sections, budget, AbortSignal.abort())).toThrow(/cancelled/)
    model.materials_standard.entries = 2
    expect(() => decodeMaterialParameters(sections, budget)).toThrow(/exceeds its section/)
  })

  it('does not draw a displacement modifier as an opaque composite color pass', () => {
    const table: { content: unknown[] }[] = []
    const ref = (content: unknown[]) => { table.push({ content }); return { entries: content.length, index: table.length - 1 } }
    const composite = { priority: 0, sections: ref([
      { material_reference_index: 0, alpha_factor: { default: 1 } },
      { material_reference_index: 1, alpha_factor: { default: 1 } },
    ]) }
    const model = {
      material_references: ref([
        { type: 1, material_index: 0 },
        { type: 2, material_index: 0 },
        { type: 3, material_index: 0 },
      ]),
      materials_standard: ref([{ blend_mode: 1 }]),
      materials_displacement: ref([{}]),
      materials_composite: ref([composite]),
    }
    const sections = { model, getSectionByReference: (value: { index: number }) => table[value.index] }
    const decoded = decodeMaterialParameters(sections, budget)
    expect(decoded.materials[2].shader.parameters.renderModel.composite.passes).toHaveLength(1)
    expect(decoded.diagnostics).toContainEqual(expect.objectContaining({
      code: 'composite-pass-presentation-unrendered',
    }))
  })
})
