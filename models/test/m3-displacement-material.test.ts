import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
const budget = { maxInputBytes: 16777216n, maxScalarBytes: 16777216,
  maxNodes: 100000, maxDepth: 96, maxDiagnostics: 100 }
const animated = (a: number[], b: number[]) => ({ value: a.length === 1 ? a[0] : a,
  sequenceTracks: [{ sequenceIndex: 0, track: { lineType: 1, keys: [
    { frame: 0, vector: a }, { frame: 1, vector: b },
  ] } }] })

function fixture(): any {
  const layer = (slot: string) => ({ slot, texturePath: `Assets/${slot}.dds`, uvSource: 1,
    channels: 1, op: 2, teamColorMode: 0, wrapX: true, wrapY: true,
    invert: false, clampResult: false, uvOffset: animated([0, 0], [0.25, 0.5]) })
  return { format: 'm3', meshes: [], skeleton: { bones: [] },
    materials: [{ name: 'Distortion', layers: [],
      metadata: { presentation: 'screen-distortion', sourceMaterialTag: 'DIS_', matmType: 2, flags: 5 },
      standard: { priority: -3, parallaxHeight: animated([0.25], [0.75]),
        layers: { normal: layer('normal'), height: layer('height') } } }],
    animations: [{ name: 'Pulse', durationSeconds: 1, looping: true, nodeTracks: [] }],
    effects: { particles: [], ribbons: [] }, bounds: null }
}

it('writes native DIS_ and retains animated strength and both UV layers', async () => {
  const encoded = await encodeM3JsonModel(fixture(), {}, budget)
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(encoded.bytes.slice().buffer, xml)
  const references = sections.getSectionByReference(sections.model!['material_references'] as any)!
  expect(references.content).toMatchObject([{ type: 2, material_index: 0 }])
  const displacement = sections.getSectionByReference(sections.model!['materials_displacement'] as any)!
  expect(displacement.desc.history.name).toBe('DIS_')
  expect(displacement.content[0]).toMatchObject({ flags: 5, priority: -3 })
  const { decodeM3Materials } = await import(new URL('../src/m3/runtime/material.js', import.meta.url).href) as {
    decodeM3Materials(bytes: Uint8Array, resourceBudget: typeof budget): Promise<{
      materials: { shader: { parameters: { renderModel: unknown } } }[]
    }>
  }
  const decoded = await decodeM3Materials(encoded.bytes, budget)
  const material = decoded.materials[0]!.shader.parameters.renderModel as any
  expect(material.presentation ?? material.metadata?.presentation).toBe('screen-distortion')
  expect(material.metadata).toMatchObject({ sourceMaterialTag: 'DIS_', matmType: 2, flags: 5 })
  expect(material.standard.priority).toBe(-3)
  expect(material.standard.parallaxHeight).toMatchObject({ value: 0.25,
    sequenceTracks: [{ sequenceIndex: 0, track: { lineType: 1, keys: [
      { frame: 0, vector: [0.25] }, { frame: 1, vector: [0.75] },
    ] } }] })
  for (const slot of ['normal', 'height']) {
    expect(material.standard.layers[slot]).toMatchObject({ texturePath: `Assets/${slot}.dds`, uvSource: 1,
      uvOffset: { sequenceTracks: [{ sequenceIndex: 0, track: { lineType: 1, keys: [
        { frame: 0, vector: [0, 0] }, { frame: 1, vector: [0.25, 0.5] },
      ] } }] } })
  }
})

it('refuses other presentations and non-DIS_ texture slots', async () => {
  const source = fixture()
  source.materials[0].metadata.presentation = 'terrain-splat'
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/presentation/)
  source.materials[0].metadata.presentation = 'screen-distortion'
  source.materials[0].standard.layers.diffuse = source.materials[0].standard.layers.normal
  await expect(encodeM3JsonModel(source, {}, budget)).rejects.toThrow(/normal and height/)
})
