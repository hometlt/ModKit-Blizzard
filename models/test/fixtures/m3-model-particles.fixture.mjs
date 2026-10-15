import { readFile } from 'node:fs/promises'
import { createM3EffectShadingFixture } from './m3-effect-shading.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'

export const previewAnimationIds = Object.freeze({
  cameraFov: 0x4c490001,
  cameraNear: 0x4c490002,
  cameraFar: 0x4c490003,
  lightColor: 0x4c490004,
  lightIntensity: 0x4c490005,
})

/** Actual PAR_/SCHR/CHAR, CAM_5 and LITE7 records through the native structural writer. */
export async function createM3ModelParticleFixture(paths) {
  const bytes = await createM3EffectShadingFixture()
  const sections = await M3SectionList.load(
    bytes.slice().buffer,
    await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
  )
  const add = (tag, version = 0, content = []) => appendM3Section(sections, tag, version, content)
  const point = (ref, target) => pointM3ReferenceAtSection(sections, ref, target)
  const animated = (ref, id) => Object.assign(ref.header, { id, flags: 6, interpolation: 1 })
  const strings = add('SCHR')
  for (const path of paths) {
    const record = strings.desc.instance(),
      chars = add('CHAR')
    chars.content = [...path].map(char => char.charCodeAt(0)).concat(0)
    point(record.path, chars)
    strings.content.push(record)
  }
  const particle = sections.getSectionByReference(sections.model.particle_systems).content[0]
  point(particle.model_paths, strings)
  particle.flags |= 0x400000 | 0x800000
  const cameras = add('CAM_', 5),
    camera = cameras.desc.instance()
  camera.bone = 0
  camera.field_of_view.default = 1
  camera.near_clip.default = 0.1
  camera.far_clip.default = 20
  animated(camera.field_of_view, previewAnimationIds.cameraFov)
  animated(camera.near_clip, previewAnimationIds.cameraNear)
  animated(camera.far_clip, previewAnimationIds.cameraFar)
  cameras.content.push(camera)
  point(sections.model.cameras, cameras)
  const lights = add('LITE', 7)
  for (const shape of [0, 1, 2]) {
    const light = lights.desc.instance()
    light.shape = shape
    light.bone = 0
    Object.assign(light.color.default, { x: 0.5, y: 1, z: 0.25 })
    light.intensity.default = 1
    light.attenuation_far = 10
    light.attenuation_near.default = 1
    light.decay.default = 2
    light.hotspot.default = 0.25
    light.falloff.default = 0.75
    lights.content.push(light)
  }
  animated(lights.content[0].color, previewAnimationIds.lightColor)
  animated(lights.content[0].intensity, previewAnimationIds.lightIntensity)
  point(sections.model.lights, lights)
  const stcs = sections.getSectionByReference(
    sections.model.sequence_transformation_collections,
  ).content
  const sets = sections.getSectionByReference(sections.model.sts).content
  for (const stc of stcs) {
    const ids = sections.getSectionByReference(stc.anim_ids).content.slice()
    const refs = sections.getSectionByReference(stc.anim_refs).content.slice()
    const scalars = sections.getSectionByReference(stc.sdr3)
    const vectors = add('SD3V')
    for (const [id, values] of [
      [previewAnimationIds.cameraFov, [1, 0.5]],
      [previewAnimationIds.cameraNear, [0.1, 0.2]],
      [previewAnimationIds.cameraFar, [20, 30]],
      [previewAnimationIds.lightIntensity, [1, 0.5]],
    ]) {
      const block = scalars.desc.instance(), ordinal = scalars.content.length
      point(block.frames, add('I32_', 0, [100, 1100]))
      block.fend = 1100
      point(block.keys, add('REAL', 0, values))
      scalars.content.push(block)
      ids.push(id)
      refs.push((5 << 16) | ordinal)
    }
    const color = vectors.desc.instance(), colorOrdinal = vectors.content.length
    point(color.frames, add('I32_', 0, [100, 1100]))
    color.fend = 1100
    const colorKeys = add('VEC3')
    colorKeys.content = [
      [0.5, 1, 0.25],
      [1, 0, 0],
    ].map(value => {
      const record = colorKeys.desc.instance()
      Object.assign(record, { x: value[0], y: value[1], z: value[2] })
      return record
    })
    point(color.keys, colorKeys)
    vectors.content.push(color)
    ids.push(previewAnimationIds.lightColor)
    refs.push((2 << 16) | colorOrdinal)
    point(stc.sdr3, scalars)
    point(stc.sd3v, vectors)
    point(stc.anim_ids, add('U32_', 0, ids))
    point(stc.anim_refs, add('U32_', 0, refs))
    point(sets[stc.sts_index].anim_ids, add('U32_', 0, ids))
    stc.ref_count = ids.length
  }
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
