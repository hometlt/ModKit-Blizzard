import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'

interface Section {
  readonly desc: { instance(): Record<string, unknown> }
  readonly content: unknown[]
}
interface Sections {
  readonly model: Record<string, unknown>
  getSectionByReference(reference: unknown): Section | null
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('native fixture structure is absent')
  return value as Record<string, unknown>
}

/** Synthetic coverage derived from the pinned Harbinger fixture; not an independent retail model.
 * Replace only ATVL[0] with an indexed tetrahedron and authored local translation, using the
 * existing native structural writer. The exported M3 is then reopened through the ordinary codec.
 */
export async function m3AttachmentMeshFixture(
  variant: 'valid' | 'bad-index' | 'bad-reference' | 'analytic' = 'valid',
): Promise<Uint8Array> {
  // Narrow test-only declarations for the existing JS structural writer. The product converter
  // remains strict and portable; it never imports these fixture construction APIs.
  const { M3SectionList } = (await import(
    new URL('../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const { installM3PlatformAdapters } = (await import(
    new URL('../dist/m3/native/platform.js', import.meta.url).href
  )) as {
    installM3PlatformAdapters(adapters: { DOMParser: typeof DOMParser }): void
  }
  const { appendM3Section, pointM3ReferenceAtSection, serializeM3SectionGraph } = (await import(
    new URL('../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    appendM3Section(
      sections: Sections,
      tag: string,
      version: number,
      values?: readonly number[],
    ): Section
    pointM3ReferenceAtSection(sections: Sections, reference: unknown, section: Section): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  installM3PlatformAdapters({ DOMParser })
  const bytes = await readFile(
    new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url),
  )
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  const sections = await M3SectionList.load(buffer, xml)
  const volume = record(
    sections.getSectionByReference(sections.model['attachment_volumes'])?.content[0],
  )
  if (volume['bone0'] !== 9 || volume['shape'] !== 1)
    throw new Error('Harbinger ATVL fixture changed')
  if (variant === 'analytic') {
    const volumes = sections.getSectionByReference(sections.model['attachment_volumes'])?.content
    if (volumes?.length !== 4) throw new Error('Harbinger volume count changed')
    volumes.forEach((item, i) => {
      const volume = record(item)
      volume['shape'] = i
      volume['size0'] = 1
      volume['size1'] = 2
      volume['size2'] = 3
    })
    return serializeM3SectionGraph(sections)
  }
  const vertices = appendM3Section(sections, 'VEC3', 0)
  for (const [x, y, z] of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const vertex = vertices.desc.instance()
    vertex['x'] = x
    vertex['y'] = y
    vertex['z'] = z
    vertices.content.push(vertex)
  }
  const faces = appendM3Section(sections, 'U16_', 0, [
    variant === 'bad-index' ? 65535 : 0,
    2,
    1,
    0,
    1,
    3,
    0,
    3,
    2,
    1,
    2,
    3,
  ])
  volume['shape'] = 4
  const translation = record(record(volume['matrix'])['w'])
  translation['x'] = 1
  translation['y'] = 2
  translation['z'] = 3
  pointM3ReferenceAtSection(sections, volume['vertices'], vertices)
  pointM3ReferenceAtSection(sections, volume['face_data'], faces)
  if (variant === 'bad-reference') record(volume['vertices'])['entries'] = 5
  return serializeM3SectionGraph(sections)
}
