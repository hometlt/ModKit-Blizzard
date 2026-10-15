import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'

interface Description {
  instance(): Record<string, unknown>
}
interface Section {
  desc: Description
  content: unknown[]
}
interface Sections {
  readonly model: Record<string, unknown>
  getSectionByReference(reference: unknown): Section | null
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('native binding fixture record is absent')
  return value as Record<string, unknown>
}

/** Author actual MATM/MAT_/SEQS/STC_/SDR3 bytes through the existing native structural writer.
 * The material-only variant declares an empty BONE/IREF table; it does not damage either table.
 */
export async function createM3aMaterialBindingFixture(
  options: {
    readonly bones?: boolean
    readonly hash?: number
    readonly value?: number
    readonly keys?: readonly number[]
    readonly malformedSkeleton?: boolean
  } = {},
): Promise<Uint8Array> {
  const { buildAnimationM3 } = (await import(new URL('./animation.ts', import.meta.url).href)) as {
    buildAnimationM3(options: { start: number; end: number }): Promise<Uint8Array>
  }
  const input = await buildAnimationM3({ start: 100, end: 1100 })
  const { installM3PlatformAdapters } = (await import(
    new URL('../../dist/m3/native/platform.js', import.meta.url).href
  )) as {
    installM3PlatformAdapters(options: { DOMParser: typeof globalThis.DOMParser }): void
  }
  installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })
  const { M3SectionList } = (await import(
    new URL('../../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const { appendM3Section, pointM3ReferenceAtSection, serializeM3SectionGraph } = (await import(
    new URL('../../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    appendM3Section(sections: Sections, tag: string, version: number): Section
    pointM3ReferenceAtSection(sections: Sections, reference: unknown, section: Section): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  const buffer = new ArrayBuffer(input.length)
  new Uint8Array(buffer).set(input)
  const sections = await M3SectionList.load(
    buffer,
    await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
  )
  const model = sections.model
  model['m3a_hash'] = options.hash ?? 0
  record(model['m3a_hashes'])['entries'] = 0
  if (options.bones === false) {
    record(model['bones'])['entries'] = 0
    record(model['bone_rests'])['entries'] = 0
  } else {
    const bones = sections.getSectionByReference(model['bones'])?.content
    if (bones?.length !== 1) throw new TypeError('binding fixture requires its one authored root')
    const bone = record(bones[0])
    const translation = record(record(bone['location'])['default'])
    const rotation = record(record(bone['rotation'])['default'])
    const scale = record(record(bone['scale'])['default'])
    if (
      bone['parent'] !== -1 ||
      rotation['x'] !== 0 ||
      rotation['y'] !== 0 ||
      rotation['z'] !== 0 ||
      rotation['w'] !== 1 ||
      scale['x'] !== 1 ||
      scale['y'] !== 1 ||
      scale['z'] !== 1 ||
      ![translation['x'], translation['y'], translation['z']].every(
        value => typeof value === 'number' && Number.isFinite(value),
      )
    )
      throw new TypeError(
        'binding fixture root must have a finite translation and identity rotation/scale',
      )
    const rests = appendM3Section(sections, 'IREF', 0)
    const rest = rests.desc.instance(),
      matrix = record(rest['matrix'])
    Object.assign(record(matrix['x']), { x: 1, y: 0, z: 0, w: 0 })
    Object.assign(record(matrix['y']), { x: 0, y: 1, z: 0, w: 0 })
    Object.assign(record(matrix['z']), { x: 0, y: 0, z: 1, w: 0 })
    // Invert the exact authored root translation. An identity fallback would erase its bind pose.
    Object.assign(record(matrix['w']), {
      x: -Number(translation['x']),
      y: -Number(translation['y']),
      z: -Number(translation['z']),
      w: 1,
    })
    rests.content = [rest]
    pointM3ReferenceAtSection(sections, model['bone_rests'], rests)
  }
  if (options.malformedSkeleton) Object.assign(record(model['bones']), { entries: 1, index: 0 })
  const add = (tag: string, version: number, values: readonly unknown[]) => {
    const section = appendM3Section(sections, tag, version)
    section.content = [...values]
    return section
  }
  const materialSection = appendM3Section(sections, 'MAT_', 15)
  const material = materialSection.desc.instance()
  const parallax = record(material['parallax_height'])
  parallax['default'] = options.value ?? 0
  const header = record(parallax['header'])
  header['id'] = 0x10203040
  header['interpolation'] = 1
  header['flags'] = 6
  materialSection.content = [material]
  pointM3ReferenceAtSection(sections, model['materials_standard'], materialSection)
  const mapping = appendM3Section(sections, 'MATM', 0)
  mapping.content = [Object.assign(mapping.desc.instance(), { type: 1, material_index: 0 })]
  pointM3ReferenceAtSection(sections, model['material_references'], mapping)
  const stc = record(
    sections.getSectionByReference(model['sequence_transformation_collections'])?.content[0],
  )
  record(stc['sd3v'])['entries'] = 0
  const refs = add('U32_', 0, [5 << 16]) // Native STC SD field 5 = SDR3.
  pointM3ReferenceAtSection(sections, stc['anim_refs'], refs)
  const scalar = appendM3Section(sections, 'SDR3', 0)
  const block = scalar.desc.instance()
  block['fend'] = 1100
  pointM3ReferenceAtSection(sections, block['frames'], add('I32_', 0, [100, 1100]))
  pointM3ReferenceAtSection(sections, block['keys'], add('REAL', 0, options.keys ?? [2, 6]))
  scalar.content = [block]
  pointM3ReferenceAtSection(sections, stc['sdr3'], scalar)
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
