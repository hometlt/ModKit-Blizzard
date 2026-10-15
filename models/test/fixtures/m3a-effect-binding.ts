import { readFile } from 'node:fs/promises'
import { createM3aMaterialBindingFixture } from './m3a-material-binding.js'

interface Section {
  readonly desc: { instance(): Record<string, unknown> }
  content: unknown[]
}
interface Sections {
  readonly model: Record<string, unknown>
  getSectionByReference(reference: unknown): Section | null
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('effect fixture record absent')
  return value as Record<string, unknown>
}
export const effectFixtureIds = {
  rate: 0x12340001,
  count: 0x12340002,
  speed: 0x12340003,
  copyRate: 0x12340004,
  copyCount: 0x12340005,
} as const

/** Actual writer-produced PAR_12/PARC0, SEQS2/STG0/STC4/STS0, SDR3/SDS6 fixture.
 * The sidecar deliberately has no native effect declarations: only IDs in animation tables. */
export async function createM3aEffectBindingFixture(
  options: {
    readonly sidecar?: boolean
    readonly duplicateBaseId?: boolean
    readonly duplicateStcId?: boolean
    readonly incompatibleSdType?: boolean
  } = {},
): Promise<Uint8Array> {
  const input = await createM3aMaterialBindingFixture()
  const { M3SectionList } = (await import(
    new URL('../../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const native = (await import(
    new URL('../../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    appendM3Section(sections: Sections, tag: string, version: number): Section
    pointM3ReferenceAtSection(sections: Sections, reference: unknown, section: Section): void
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  const sections = await M3SectionList.load(
    Uint8Array.from(input).buffer,
    await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
  )
  const model = sections.model
  const add = (tag: string, version = 0): Section => native.appendM3Section(sections, tag, version)
  const point = (reference: unknown, target: Section): void =>
    native.pointM3ReferenceAtSection(sections, reference, target)
  const primitive = (tag: string, values: readonly unknown[]): Section => {
    const target = add(tag)
    target.content = [...values]
    return target
  }
  const reference = (
    owner: Record<string, unknown>,
    field: string,
    id: number,
    value: number,
  ): void => {
    const ref = object(owner[field])
    ref['default'] = value
    Object.assign(object(ref['header']), {
      id,
      interpolation: field === 'emit_count' ? 0 : 1,
      flags: 6,
    })
  }
  if (!options.sidecar) {
    const particles = add('PAR_', 12),
      particle = particles.desc.instance()
    particle['bone'] = 0
    particle['material_reference_index'] = 0
    reference(particle, 'emit_rate', effectFixtureIds.rate, 2)
    reference(particle, 'emit_count', effectFixtureIds.count, 0)
    reference(
      particle,
      'emit_speed',
      options.duplicateBaseId ? effectFixtureIds.rate : effectFixtureIds.speed,
      1,
    )
    object(particle['lifespan'])['default'] = 3
    const copies = add('PARC'),
      copy = copies.desc.instance()
    copy['bone'] = 0
    reference(copy, 'emit_rate', effectFixtureIds.copyRate, 4)
    reference(copy, 'emit_count', effectFixtureIds.copyCount, 0)
    copies.content = [copy]
    point(model['particle_copies'], copies)
    point(particle['copy_indices'], primitive('U32_', [0]))
    particles.content = [particle]
    point(model['particle_systems'], particles)
  }
  const seqs = add('SEQS', 2),
    groups = add('STG_'),
    collections = add('STC_', 4),
    sets = add('STS_')
  const clipCount = options.sidecar ? 2 : 1
  for (let sequence = 0; sequence < clipCount; sequence++) {
    const seq = seqs.desc.instance(),
      group = groups.desc.instance(),
      stc = collections.desc.instance(),
      sts = sets.desc.instance()
    const name = primitive('CHAR', [
      ...new TextEncoder().encode(`${options.sidecar ? 'Side' : 'Base'}${sequence}\0`),
    ])
    seq['id'] = sequence
    seq['index'] = sequence
    seq['anim_ms_start'] = 100
    seq['anim_ms_end'] = 1100
    seq['frequency'] = 100
    point(seq['name'], name)
    point(group['name'], name)
    point(stc['name'], name)
    point(group['stc_indices'], primitive('U32_', [sequence]))
    stc['sts_index'] = sequence
    stc['sts_index_fb'] = sequence
    const ids: number[] = [effectFixtureIds.rate, effectFixtureIds.speed, effectFixtureIds.copyRate]
    if (options.sidecar)
      ids.push(sequence === 0 ? effectFixtureIds.count : effectFixtureIds.copyCount)
    if (options.duplicateStcId) ids.push(effectFixtureIds.rate)
    const scalars = add('SDR3'),
      shorts = add('SDS6'),
      packed: number[] = []
    for (const id of ids) {
      const count = id === effectFixtureIds.count || id === effectFixtureIds.copyCount
      const target = count && !options.incompatibleSdType ? shorts : scalars
      const block = target.desc.instance(),
        ordinal = target.content.length
      block['fend'] = 1100
      point(block['frames'], primitive('I32_', [100, 1100]))
      point(
        block['keys'],
        primitive(
          target === shorts ? 'I16_' : 'REAL',
          count ? [3, 5] : [2 + sequence, 6 + sequence],
        ),
      )
      target.content.push(block)
      packed.push(((target === shorts ? 7 : 5) << 16) | ordinal)
    }
    point(stc['sdr3'], scalars)
    if (shorts.content.length > 0) point(stc['sds6'], shorts)
    point(stc['anim_ids'], primitive('U32_', ids))
    point(stc['anim_refs'], primitive('U32_', packed))
    point(sts['anim_ids'], primitive('U32_', [...new Set(ids)]))
    stc['ref_count'] = ids.length
    seqs.content.push(seq)
    groups.content.push(group)
    collections.content.push(stc)
    sets.content.push(sts)
  }
  point(model['sequences'], seqs)
  point(model['sequence_transformation_groups'], groups)
  point(model['sequence_transformation_collections'], collections)
  point(model['sts'], sets)
  return Uint8Array.from(native.serializeM3SectionGraph(sections))
}
