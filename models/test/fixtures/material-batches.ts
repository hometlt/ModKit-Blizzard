import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../../dist/m3/native/platform.js'
import { appendM3Section, pointM3ReferenceAtSection, replaceM3ReferencedRecords, serializeM3SectionGraph } from '../../dist/m3/native/structural.js'
import type { M3Reference, M3StructureData } from '../../dist/m3/native/types.js'

/** Author actual BAT_/MATM bytes with the frozen structural writer, then exercise the normal reader. */
export async function materialBatchFixture(options: {
  readonly materialIndices?: readonly number[]
  readonly emptyFirstDivision?: boolean
  readonly compositeAlphas?: readonly number[]
  readonly inputBytes?: Uint8Array
  readonly structuresXml?: string
} = {}): Promise<Uint8Array> {
  installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })
  const input = options.inputBytes ?? new Uint8Array(await readFile(new URL('./m3/model.m3', import.meta.url)))
  const sections = await M3SectionList.load(input.slice().buffer, options.structuresXml ?? await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'))
  const model = sections.model!
  const records = (reference: M3Reference) => sections.getSectionByReference(reference)!.content as M3StructureData[]
  const clone = (record: M3StructureData) => {
    const buffer = new ArrayBuffer(record.desc.size)
    record.toBuffer(buffer)
    return record.desc.instance(buffer)
  }
  const materialRef = model['material_references'] as M3Reference
  const material = records(materialRef)[0]!
  const secondMaterial = clone(material)
  replaceM3ReferencedRecords(sections, materialRef, [material, secondMaterial])
  if (options.compositeAlphas !== undefined) {
    const compositeSection = appendM3Section(sections, 'CMP_', 2)
    const passesSection = appendM3Section(sections, 'CMS_', 0)
    const composite = compositeSection.desc.instance()
    composite['priority'] = 7
    passesSection.content = options.compositeAlphas.map(alpha => {
      const pass = passesSection.desc.instance()
      pass['material_reference_index'] = 0
      ;(pass['alpha_factor'] as M3StructureData)['default'] = alpha
      return pass
    })
    pointM3ReferenceAtSection(sections, composite['sections'] as M3Reference, passesSection)
    compositeSection.content = [composite]
    pointM3ReferenceAtSection(sections, model['materials_composite'] as M3Reference, compositeSection)
    secondMaterial['type'] = 3
    secondMaterial['material_index'] = 0
  }
  const divisionRef = model['divisions'] as M3Reference
  const division = records(divisionRef)[0]!
  const batchRef = division['batches'] as M3Reference
  const batch = records(batchRef)[0]!
  const batches = (options.materialIndices ?? [1, 0, 1]).map(materialIndex => {
    const copy = clone(batch)
    copy['material_reference_index'] = materialIndex
    return copy
  })
  replaceM3ReferencedRecords(sections, batchRef, batches)
  if (options.emptyFirstDivision) {
    const empty = clone(division)
    ;(empty['faces'] as M3Reference).entries = 0
    ;(empty['batches'] as M3Reference).entries = 0
    replaceM3ReferencedRecords(sections, divisionRef, [empty, division])
  }
  return serializeM3SectionGraph(sections)
}
