import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { createM3aMaterialBindingFixture } from './m3a-material-binding.js'

interface Field {
  readonly name: string
  readonly size: number
}
interface Description {
  readonly fields: Readonly<Record<string, Field>>
  instance(): NativeRecord
}
interface NativeRecord extends Record<string, unknown> {
  readonly desc: Description
}
interface Section {
  readonly desc: Description
  readonly indexEntry: { readonly offset: number }
  content: unknown[]
}
interface Sections {
  readonly model: NativeRecord
  getSectionByReference(reference: unknown): Section | null
}
function record(value: unknown): NativeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('desc' in value))
    throw new TypeError('material fixture native record absent')
  return value as NativeRecord
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new TypeError('material fixture value absent')
  return value
}
async function native() {
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
  const structural = (await import(
    new URL('../../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    appendM3Section(sections: Sections, tag: string, version: number): Section
    pointM3ReferenceAtSection(sections: Sections, reference: unknown, section: Section): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  const xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')
  return {
    ...structural,
    load: (bytes: Uint8Array) => M3SectionList.load(Uint8Array.from(bytes).buffer, xml),
  }
}

/** Structural authoring only: native defaults, aliases and analytic ATVL are explicit inputs. */
export async function createM3MaterialExportFixture(
  options: {
    readonly aliases?: boolean
    readonly composite?: boolean
    readonly materialVersion?: 15 | 20
  } = {},
): Promise<Uint8Array> {
  const input = await createM3aMaterialBindingFixture({ value: 0 })
  const {
    load,
    appendM3Section: append,
    pointM3ReferenceAtSection: point,
    serializeM3SectionGraph: serialize,
  } = await native()
  const sections = await load(input),
    model = sections.model
  const old = record(
    required(sections.getSectionByReference(model['materials_standard'])).content[0],
  )
  const mats = append(sections, 'MAT_', options.materialVersion ?? 20),
    mat = mats.desc.instance()
  Object.assign(mat, { specularity: 8, hdr_spec: 2, hdr_emis: 3 })
  if (options.materialVersion !== 15)
    Object.assign(mat, { hdr_envi_const: 1, hdr_envi_diff: 2, hdr_envi_spec: 4 })
  // Two genuine native keys force default edits to retain the complete animation header and track.
  mat['parallax_height'] = old['parallax_height']
  mats.content = [mat]
  point(sections, model['materials_standard'], mats)
  const layers = append(sections, 'LAYR', 26),
    layer = layers.desc.instance()
  layer['flags'] = 0x400
  Object.assign(record(record(layer['color_value'])['default']), { r: 255, g: 255, b: 255, a: 255 })
  for (const [field, values] of [
    ['uv_offset', { x: 0, y: 0 }],
    ['uv_tiling', { x: 1, y: 1 }],
    ['uv_angle', { x: 0, y: 0, z: 0 }],
    ['uv_triplanar_offset', { x: 0, y: 0, z: 0 }],
    ['uv_triplanar_scale', { x: 1, y: 1, z: 1 }],
  ] as const)
    Object.assign(record(record(layer[field])['default']), values)
  layers.content = [layer]
  point(sections, mat['layer_diff'], layers)
  if (options.aliases) point(sections, mat['layer_spec'], layers)
  const mappings = required(sections.getSectionByReference(model['material_references']))
  mappings.content = [Object.assign(mappings.desc.instance(), { type: 1, material_index: 0 })]
  if (options.aliases)
    mappings.content.push(Object.assign(mappings.desc.instance(), { type: 1, material_index: 0 }))
  if (options.composite) {
    const passes = append(sections, 'CMS_', 0),
      pass = passes.desc.instance()
    pass['material_reference_index'] = 0
    record(pass['alpha_factor'])['default'] = 1
    passes.content = [pass]
    const composites = append(sections, 'CMP_', 2),
      composite = composites.desc.instance()
    point(sections, composite['sections'], passes)
    composites.content = [composite]
    point(sections, model['materials_composite'], composites)
    mappings.content.push(Object.assign(mappings.desc.instance(), { type: 3, material_index: 0 }))
  }
  point(sections, model['material_references'], mappings)
  const volumes = append(sections, 'ATVL', 0),
    volume = volumes.desc.instance()
  Object.assign(volume, { bone0: 0, bone1: 0, bone2: 0, shape: 1, size0: 2, size1: 0, size2: 0 })
  const matrix = record(volume['matrix'])
  for (const [index, key] of ['x', 'y', 'z', 'w'].entries())
    Object.assign(record(matrix[key]), {
      x: Number(index === 0),
      y: Number(index === 1),
      z: Number(index === 2),
      w: Number(index === 3),
    })
  volumes.content = [volume]
  point(sections, model['attachment_volumes'], volumes)
  return Uint8Array.from(serialize(sections))
}

/** Independent parser/descriptor oracle; it never consults the product writer mapping. */
export async function inspectM3MaterialExportSource(bytes: Uint8Array): Promise<{
  readonly values: Readonly<Record<string, number>>
  readonly offsets: Readonly<Record<string, number>>
}> {
  const sections = await (await native()).load(bytes),
    model = sections.model
  const mats = required(sections.getSectionByReference(model['materials_standard']))
  const mat = record(mats.content[0])
  const layers = required(sections.getSectionByReference(mat['layer_diff']))
  const volumes = required(sections.getSectionByReference(model['attachment_volumes']))
  const values: Record<string, number> = {},
    offsets: Record<string, number> = {}
  const field = (name: string, section: Section, path: readonly string[]): void => {
    let value: unknown = section.content[0],
      offset = section.indexEntry.offset
    for (const part of path) {
      const current = record(value),
        fields = Object.values(current.desc.fields)
      const index = fields.findIndex(field => field.name === part)
      if (index < 0) throw new TypeError(`material fixture field ${part} absent`)
      offset += fields.slice(0, index).reduce((total, field) => total + field.size, 0)
      value = current[part]
    }
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new TypeError('material fixture float absent')
    values[name] = value
    offsets[name] = offset
  }
  for (const [name, path] of [
    ['specularity', ['specularity']],
    ['specMult', ['hdr_spec']],
    ['emisMult', ['hdr_emis']],
    ['parallaxHeight', ['parallax_height', 'default']],
  ] as const)
    field(name, mats, path)
  if ('hdr_envi_const' in mat)
    for (const [index, key] of ['hdr_envi_const', 'hdr_envi_diff', 'hdr_envi_spec'].entries())
      field(`environmentMultipliers.${index}`, mats, [key])
  for (const [name, key, components] of [
    ['uvOffset', 'uv_offset', ['x', 'y']],
    ['uvTiling', 'uv_tiling', ['x', 'y']],
    ['uvAngle', 'uv_angle', ['x', 'y', 'z']],
    ['uvTriplanarOffset', 'uv_triplanar_offset', ['x', 'y', 'z']],
    ['uvTriplanarScale', 'uv_triplanar_scale', ['x', 'y', 'z']],
  ] as const)
    for (const [index, component] of components.entries())
      field(`${name}.${index}`, layers, [key, 'default', component])
  field('atvl.radius', volumes, ['size0'])
  return { values, offsets }
}
