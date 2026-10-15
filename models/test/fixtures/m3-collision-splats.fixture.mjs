// Intended models/test/fixtures. Actual PAR_12/PROJ5/PHRB3/PHSH1 writer bytes.
import { readFile } from 'node:fs/promises'
import { createM3FieldEffectsFixture } from './m3-field-effects.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'
export async function createM3CollisionSplatFixture() {
  const input = await createM3FieldEffectsFixture(),
    xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    sections = await M3SectionList.load(input.slice().buffer, xml),
    model = sections.model
  const scalar = (record, key, value) => {
    record[key].default = value
    record[key].header.id = 0
    record[key].header.flags = 0
  }
  // Give the native emitter, rigid shape and test receiver one explicit identity bind frame.
  const matrix = (record, translation = [0, 0, 0]) => {
    for (const [column, values] of Object.entries({
      x: [1, 0, 0, 0],
      y: [0, 1, 0, 0],
      z: [0, 0, 1, 0],
      w: [...translation, 1],
    }))
      Object.assign(
        record[column],
        Object.fromEntries(['x', 'y', 'z', 'w'].map((axis, index) => [axis, values[index]])),
      )
  }
  const bone = sections.getSectionByReference(model.bones).content[0]
  Object.assign(bone.location.default, { x: 0, y: 0, z: 0 })
  bone.location.header.id = 0
  bone.location.header.flags = 0
  matrix(sections.getSectionByReference(model.bone_rests).content[0].matrix)
  const particle = sections.getSectionByReference(model.particle_systems).content[0]
  scalar(particle, 'emit_rate', 10)
  scalar(particle, 'emit_speed', 10)
  scalar(particle, 'lifespan', 2)
  scalar(particle, 'emit_count', 0)
  for (const key of ['emit_angle_x', 'emit_angle_y', 'emit_spread_x', 'emit_spread_y'])
    scalar(particle, key, 0)
  particle.flags = 4
  // Explicit zero means no particles in the native/shared simulator contract.
  particle.emit_max = 32
  particle.collide_splat = 0
  particle.collide_splat_chance = 1
  particle.collide_events_cull = 1
  particle.bounce = 0
  particle.gravity = 0
  particle.local_forces = 0
  particle.world_forces = 0
  model.particle_copies.entries = 0
  particle.copy_indices.entries = 0
  model.forces.entries = 0
  model.warps.entries = 0
  const projector = sections.getSectionByReference(model.projections).content[0]
  scalar(projector, 'active', 0)
  for (const [key, value] of Object.entries({
    near: 0.1,
    far: 1,
    field_of_view: 1,
    aspect_ratio: 1,
    box_offset_x_left: -2,
    box_offset_x_right: 2,
    box_offset_y_back: -2,
    box_offset_y_front: 2,
  }))
    scalar(projector, key, value)
  Object.assign(projector, {
    alpha_init: 1,
    alpha_mid: 1,
    alpha_end: 0,
    lifetime_attack: 0,
    lifetime_attack_to: 0,
    lifetime_hold: 2,
    lifetime_hold_to: 2,
    lifetime_decay: 1,
    lifetime_decay_to: 1,
  })
  const bodies = appendM3Section(sections, 'PHRB', 3, []),
    body = bodies.desc.instance(),
    shapes = appendM3Section(sections, 'PHSH', 1, []),
    shape = shapes.desc.instance()
  body.bone = 0
  body.flags = 1
  shape.shape = 0
  shape.size0 = 20
  shape.size1 = 20
  shape.size2 = 0.5
  matrix(shape.matrix, [0, 0, 2])
  bodies.content.push(body)
  shapes.content.push(shape)
  pointM3ReferenceAtSection(sections, body.physics_shape, shapes)
  pointM3ReferenceAtSection(sections, model.physics_rigidbodies, bodies)
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
