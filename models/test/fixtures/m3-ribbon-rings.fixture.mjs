import { readFile } from 'node:fs/promises'
import { createM3CollisionSplatFixture } from './m3-collision-splats.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'
/** Actual RIB_8 records with native planar/cylinder/star declarations and varying RGBA. */
export async function createM3RibbonRingsFixture() {
  const bytes = await createM3CollisionSplatFixture(),
    xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    sections = await M3SectionList.load(bytes.slice().buffer, xml)
  sections.model.particle_systems.entries = 0
  const ribbons = appendM3Section(sections, 'RIB_', 8, [])
  const scalar = (record, key, value) => {
    record[key].default = value
    record[key].header.id = 0
    record[key].header.flags = 0
  }
  for (const type of [1, 2, 3]) {
    const ribbon = ribbons.desc.instance()
    ribbon.bone = 0
    ribbon.material_reference_index = 0
    ribbon.ribbon_type = type
    ribbon.sides = 3
    ribbon.star_ratio = 0.25
    ribbon.divisions = 10
    scalar(ribbon, 'active', 1)
    scalar(ribbon, 'speed', 1)
    scalar(ribbon, 'lifespan', 2)
    Object.assign(ribbon.scale.default, { x: 1, y: 1, z: 1 })
    ribbon.scale_anim_mid = 0.5
    ribbon.color_anim_mid = 0.5
    ribbon.alpha_anim_mid = 0.5
    ribbon.scale_anim_mid_time = 0.5
    ribbon.color_anim_mid_time = 0.5
    ribbon.alpha_anim_mid_time = 0.5
    for (const [key, rgba] of [
      ['color_base', [255, 0, 0, 255]],
      ['color_mid', [0, 255, 0, 128]],
      ['color_tip', [0, 0, 255, 0]],
    ]) {
      Object.assign(
        ribbon[key].default,
        Object.fromEntries(['r', 'g', 'b', 'a'].map((channel, index) => [channel, rgba[index]])),
      )
      ribbon[key].header.id = 0
      ribbon[key].header.flags = 0
    }
    ribbons.content.push(ribbon)
  }
  pointM3ReferenceAtSection(sections, sections.model.ribbons, ribbons)
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
