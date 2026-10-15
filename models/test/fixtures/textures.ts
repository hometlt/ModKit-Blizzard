import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../../dist/m3/native/platform.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  replaceM3ReferencedRecords,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'
import type { M3Reference, M3StructureData } from '../../dist/m3/native/types.js'

/** Actual material/layer references and unrelated CHAR sections authored by the frozen writer. */
export async function textureReferenceFixture(options: {
  readonly paths: readonly string[]
  readonly unreferencedPaths?: readonly string[]
  readonly inputBytes?: Uint8Array
  readonly structuresXml?: string
}): Promise<Uint8Array> {
  installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })
  const input =
    options.inputBytes ??
    new Uint8Array(await readFile(new URL('./m3/model.m3', import.meta.url)))
  const sections = await M3SectionList.load(
    input.slice().buffer,
    options.structuresXml ??
      (await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')),
  )
  const reference = sections.model!['materials_standard'] as M3Reference
  const original = sections.getSectionByReference(reference)!.content[0] as M3StructureData
  const originalBytes = new ArrayBuffer(original.desc.size)
  original.toBuffer(originalBytes)
  const chars = (value: string) =>
    appendM3Section(sections, 'CHAR', 0, Array.from(new TextEncoder().encode(`${value}\0`)))
  const records = options.paths.map(path => {
    const material = original.desc.instance(originalBytes.slice(0))
    for (const [key, value] of Object.entries(material)) {
      if (
        key.startsWith('layer_') &&
        value !== null &&
        typeof value === 'object' &&
        'entries' in value
      )
        (value as M3Reference).entries = 0
    }
    const layer = appendM3Section(sections, 'LAYR', 22)
    const record = layer.desc.instance()
    pointM3ReferenceAtSection(sections, record['color_bitmap'] as M3Reference, chars(path))
    layer.content = [record]
    pointM3ReferenceAtSection(sections, material['layer_diff'] as M3Reference, layer)
    return material
  })
  replaceM3ReferencedRecords(sections, reference, records)
  for (const path of options.unreferencedPaths ?? []) chars(path)
  return serializeM3SectionGraph(sections)
}
