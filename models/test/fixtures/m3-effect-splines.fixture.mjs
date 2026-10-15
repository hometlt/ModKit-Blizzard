// Destination models/test/fixtures. Authored native sections, serialized and reopened by real code.
import { readFile } from 'node:fs/promises'
import { createM3aEffectBindingFixture } from './m3a-effect-binding.ts'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'

export const splineIds = { point: 0x53500001, velocity: 0x53500002, yaw: 0x53500003 }
export async function createM3EffectSplinesFixture() {
  const input = await createM3aEffectBindingFixture()
  const sections = await M3SectionList.load(
    Uint8Array.from(input).buffer,
    await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
  )
  const add = (tag, version = 0, values = []) => appendM3Section(sections, tag, version, values)
  const point = (ref, target) => pointM3ReferenceAtSection(sections, ref, target)
  const vec = (target, value) => Object.assign(target, { x: value[0], y: value[1], z: value[2] })
  const anim = (target, value, id) => {
    if (Array.isArray(value)) vec(target.default, value)
    else target.default = value
    if (id !== undefined) Object.assign(target.header, { id, interpolation: 1, flags: 6 })
  }
  const particle = sections.getSectionByReference(sections.model.particle_systems).content[0]
  particle.emit_shape = 6
  particle.flags = 0
  anim(particle.emit_rate, 8)
  anim(particle.emit_speed, 0)
  point(particle.copy_indices, add('U32_'))
  const points = add('SVC3')
  for (const [ordinal, position] of [
    [1, 2, 3],
    [4, 2, 3],
  ].entries()) {
    const record = points.desc.instance()
    anim(record.location, position, ordinal === 0 ? splineIds.point : undefined)
    points.content.push(record)
  }
  point(particle.emit_shape_spline, points)
  // A separate real cutout emitter exercises the supported volume route, not a spline fallback.
  const cutout = sections.getSectionByReference(sections.model.particle_systems).desc.instance()
  cutout.bone = 0
  cutout.material_reference_index = 0
  cutout.emit_shape = 2
  cutout.flags = 0x10
  anim(cutout.emit_rate, 8)
  anim(cutout.emit_speed, 0)
  anim(cutout.lifespan, 3)
  anim(cutout.emit_shape_radius, 2)
  anim(cutout.emit_shape_radius_cutout, 0.5)
  anim(cutout.emit_shape_size_cutout, [0.25, 0.5, 0.75])
  sections.getSectionByReference(sections.model.particle_systems).content.push(cutout)
  point(
    sections.model.particle_systems,
    sections.getSectionByReference(sections.model.particle_systems),
  )
  const ribbons = add('RIB_', 9),
    ribbon = ribbons.desc.instance()
  ribbon.bone = 0
  ribbon.material_reference_index = 0
  ribbon.divisions = 4
  ribbon.ribbon_type = 1
  anim(ribbon.lifespan, 2)
  anim(ribbon.active, 1)
  anim(ribbon.speed, 1)
  anim(ribbon.scale, [1, 1, 1])
  ribbons.content.push(ribbon)
  point(sections.model.ribbons, ribbons)
  const endpoints = add('SRIB'),
    endpoint = endpoints.desc.instance()
  endpoint.bone = 0
  vec(endpoint.emission_offset, [4, 0, 0])
  vec(endpoint.emission_vector, [0, 1, 0])
  anim(endpoint.velocity, 1, splineIds.velocity)
  anim(endpoint.velocity_base_fac, 0.5)
  anim(endpoint.velocity_end_fac, 1.5)
  anim(endpoint.yaw, 0, splineIds.yaw)
  anim(endpoint.pitch, 10)
  endpoints.content.push(endpoint)
  point(ribbon.spline, endpoints)
  const stc = sections.getSectionByReference(sections.model.sequence_transformation_collections)
    .content[0]
  const sts = sections.getSectionByReference(sections.model.sts).content[0]
  const ids = sections.getSectionByReference(stc.anim_ids).content.slice(),
    refs = sections.getSectionByReference(stc.anim_refs).content.slice()
  const vectors = add('SD3V'),
    scalars = sections.getSectionByReference(stc.sdr3)
  for (const [id, values] of [
    [
      splineIds.point,
      [
        [1, 2, 3],
        [1, 5, 3],
      ],
    ],
    [splineIds.velocity, [1, 3]],
    [splineIds.yaw, [0, 45]],
  ]) {
    const vector = Array.isArray(values[0]),
      target = vector ? vectors : scalars,
      block = target.desc.instance(),
      index = target.content.length
    point(block.frames, add('I32_', 0, [100, 1100]))
    block.fend = 1100
    const keys = add(vector ? 'VEC3' : 'REAL')
    keys.content = vector ? values.map(value => vec(keys.desc.instance(), value)) : values
    point(block.keys, keys)
    target.content.push(block)
    ids.push(id)
    refs.push(((vector ? 2 : 5) << 16) | index)
  }
  point(stc.sd3v, vectors)
  point(stc.sdr3, scalars)
  point(stc.anim_ids, add('U32_', 0, ids))
  point(stc.anim_refs, add('U32_', 0, refs))
  point(sts.anim_ids, add('U32_', 0, ids))
  stc.ref_count = ids.length
  const output = Uint8Array.from(serializeM3SectionGraph(sections))
  if (output.byteLength > 4 * 1024 * 1024) throw new RangeError('spline fixture unexpectedly large')
  return output
}
