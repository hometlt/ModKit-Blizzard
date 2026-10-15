import { readFile } from 'node:fs/promises'
import { createM3CollisionSplatFixture } from './m3-collision-splats.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  serializeM3SectionGraph,
  pointM3ReferenceAtSection,
} from '../../dist/m3/native/structural.js'
/** Source emitter collides with actual PHSH and spawns its native PAR_ ordinal 1, whose own rate is zero. */
export async function createM3LinkedEmissionFixture() {
  const bytes = await createM3CollisionSplatFixture(),
    xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    sections = await M3SectionList.load(bytes.slice().buffer, xml),
    particles = sections.getSectionByReference(sections.model.particle_systems),
    source = particles.content[0],
    child = particles.desc.instance()
  source.collide_system = 1
  source.collide_emit_min = 1
  source.collide_emit_max = 1
  source.collide_emit_chance = 1
  source.collide_emit_energy = 1
  child.bone = 0
  child.material_reference_index = 0
  child.emit_max = 32
  child.emit_rate.default = 0
  child.lifespan.default = 2
  child.emit_speed.default = 0
  Object.assign(child.size.default, { x: 0.25, y: 0.25, z: 0.25 })
  for (const key of ['color_init', 'color_mid', 'color_end'])
    Object.assign(child[key].default, { r: 0, g: 255, b: 0, a: 255 })
  particles.content.push(child)
  pointM3ReferenceAtSection(sections, sections.model.particle_systems, particles)
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
