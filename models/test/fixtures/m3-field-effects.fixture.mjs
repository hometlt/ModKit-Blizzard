// Intended for models/test/fixtures. Real native writer output; no mocked section loader.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createM3aEffectBindingFixture } from './m3a-effect-binding.ts'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'

export const fieldIds = {
  strength: 0x44550001,
  width: 0x44550002,
  height: 0x44550003,
  length: 0x44550004,
  radius: 0x44550005,
  warpStrength: 0x44550006,
  unknownWarp: 0x44550007,
  projectorActive: 0x44550008,
}
export async function createM3FieldEffectsFixture({ sidecar = false } = {}) {
  const bytes = await createM3aEffectBindingFixture({ sidecar })
  const xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, xml)
  const add = (tag, version = 0, content = []) => appendM3Section(sections, tag, version, content)
  const point = (ref, target) => pointM3ReferenceAtSection(sections, ref, target)
  const anim = (ref, id, initial) => {
    ref.default = initial
    Object.assign(ref.header, { id, flags: 6, interpolation: 1 })
  }
  if (!sidecar) {
    for (const [tag, version, table] of [
      ['FOR_', 2, 'forces'],
      ['WRP_', 1, 'warps'],
      ['PROJ', 5, 'projections'],
    ]) {
      const section = add(tag, version),
        record = section.desc.instance()
      record.bone = 0
      section.content.push(record)
      point(sections.model[table], section)
      if (tag === 'FOR_') {
        record.force_type = 1
        record.flags = 4
        record.channels = 1
        for (const key of ['strength', 'width', 'height', 'length'])
          anim(record[key], fieldIds[key], key === 'strength' ? 0 : 8)
      } else if (tag === 'WRP_') {
        anim(record.radius, fieldIds.radius, 8)
        anim(record.strength, fieldIds.warpStrength, 0)
        anim(record.unknown50c7f2b4, fieldIds.unknownWarp, 1)
      } else {
        record.material_reference_index = 0
        anim(record.active, fieldIds.projectorActive, 1)
        record.active.header.interpolation = 0
      }
    }
  }
  const stcs = sections.getSectionByReference(
    sections.model.sequence_transformation_collections,
  ).content
  const sets = sections.getSectionByReference(sections.model.sts).content
  for (const [sequence, stc] of stcs.entries()) {
    const scalars = sections.getSectionByReference(stc.sdr3),
      integers = add('SDU3')
    const ids = sections.getSectionByReference(stc.anim_ids).content.slice()
    const refs = sections.getSectionByReference(stc.anim_refs).content.slice()
    for (const [key, id] of Object.entries(fieldIds)) {
      const target = key === 'projectorActive' ? integers : scalars,
        block = target.desc.instance()
      const ordinal = target.content.length
      point(block.frames, add('I32_', 0, [100, 1100]))
      block.fend = 1100
      const values = key === 'projectorActive' ? [1, 0] : [2 + sequence, 6 + sequence]
      point(block.keys, add(key === 'projectorActive' ? 'U32_' : 'REAL', 0, values))
      target.content.push(block)
      ids.push(id)
      refs.push(((key === 'projectorActive' ? 10 : 5) << 16) | ordinal)
    }
    point(stc.sdr3, scalars)
    point(stc.sdu3, integers)
    point(stc.anim_ids, add('U32_', 0, ids))
    point(stc.anim_refs, add('U32_', 0, refs))
    point(sets[sequence].anim_ids, add('U32_', 0, ids))
    stc.ref_count = ids.length
  }
  const result = Uint8Array.from(serializeM3SectionGraph(sections))
  assert.ok(result.length < 4 * 1024 * 1024)
  return result
}
