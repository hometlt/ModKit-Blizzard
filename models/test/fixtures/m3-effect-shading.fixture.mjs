// Intended models/test/fixtures: real native bytes, static color/size, no shader vertex flags.
import { readFile } from 'node:fs/promises'
import { createM3CollisionSplatFixture } from './m3-collision-splats.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { appendM3Section, pointM3ReferenceAtSection, serializeM3SectionGraph } from '../../dist/m3/native/structural.js'
export async function createM3EffectShadingFixture({ litParts = false, unshaded = false, mixed = false } = {}) {
  const bytes = await createM3CollisionSplatFixture(),
    xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    sections = await M3SectionList.load(bytes.slice().buffer, xml),
    particle = sections.getSectionByReference(sections.model.particle_systems).content[0]
  particle.flags = litParts ? 0x8000 : 0
  // The camera sees the back of the pinned live-particle quad. Author its native two-sided flag;
  // vertex color/alpha shader flags remain disabled, as the test requires.
  const diffuse = appendM3Section(sections, 'LAYR', 20)
  const layer = diffuse.desc.instance()
  layer.flags = 0x400
  Object.assign(layer.color_value.default, { r: 255, g: 255, b: 255, a: 255 })
  layer.color_brightness.default = 1
  diffuse.content.push(layer)
  for (const material of sections.getSectionByReference(sections.model.materials_standard).content) {
    material.flags = (material.flags & ~0x10) | 0x8 | (unshaded ? 0x10 : 0)
    material.blend_mode_layer = 2
    pointM3ReferenceAtSection(sections, material.layer_diff, diffuse)
  }
  particle.emit_max = 32
  particle.collide_splat = -1
  particle.emit_speed.default = 0
  Object.assign(particle.size.default, { x: 1, y: 1, z: 1 })
  particle.size.header.id = 0
  particle.size.header.flags = 0
  for (const key of ['color_init', 'color_mid', 'color_end']) {
    Object.assign(particle[key].default, { r: 128, g: 64, b: 255, a: 255 })
    particle[key].header.id = 0
    particle[key].header.flags = 0
  }
  // MAT_ instance defaults retain usesVertexColor/usesVertexAlpha false; the host test checks them.
  if (mixed) {
    const table = sections.getSectionByReference(sections.model.particle_systems)
    const second = Object.assign(table.desc.instance(), particle)
    second.flags ^= 0x8000
    table.content.push(second)
    sections.model.particle_systems.entries = table.content.length
  }
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
