// Check authored payload structure independently of native getter projections.
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createMetadataBuilderFixture } from './fixtures/metadata-builders.mjs'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { readFile } from 'node:fs/promises'

const [base, xml] = await Promise.all([
  readFile(new URL('./fixtures/m3/model.m3', import.meta.url)),
  readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8'),
])
async function fixture(profile) {
  const { bytes } = await createMetadataBuilderFixture(base, xml, profile)
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, xml)
  const records = reference => {
    const section = sections.getSectionByReference(reference)
    assert.ok(section)
    assert.equal(reference.entries, section.content.length)
    return section.content
  }
  return { model: sections.model, records }
}
test('authored effect payloads retain nondefault parameters and valid anchors', async () => {
  const { model, records } = await fixture('effects')
  const projections = records(model.projections)
  assert.equal(projections.length, 2)
  assert.deepEqual(
    projections.map(value => value.projection_type),
    [0, 1],
  )
  assert.equal(projections[0].offset.default.z, 3)
  assert.equal(projections[1].far.default, 24)
  assert.ok(projections.every(value => value.bone < records(model.bones).length))
  assert.ok(
    projections.every(
      value => value.material_reference_index < records(model.material_references).length,
    ),
  )
  assert.deepEqual(
    records(model.forces).map(value => value.strength.default),
    [2, 3, 4],
  )
  assert.equal(records(model.billboards).length, 2)
  assert.equal(records(records(model.billboards)[0].dependents).length, 2)
  assert.equal(records(model.warps)[0].unknownca6025a2.default, 1.25)
})
test('authored rigid bodies, joints and cloth retain nested nonempty native records', async () => {
  const { model, records } = await fixture('physics')
  const bodies = records(model.physics_rigidbodies)
  assert.equal(bodies.length, 2)
  assert.deepEqual(
    records(bodies[0].physics_shape).map(value => value.shape),
    [0, 1],
  )
  assert.equal(records(bodies[1].physics_shape)[0].matrix.w.x, 2)
  assert.equal(records(model.physics_joints)[1].limit_max, 2.25)
  const cloth = records(model.physics_cloths)[0]
  assert.equal(cloth.stiffness_stretching, 0.75)
  assert.equal(records(cloth.skin_bones).length, 2)
  const region = records(records(model.divisions)[0].regions)[0]
  for (const key of ['vertex_simulated', 'vertex_bones', 'vertex_weights'])
    assert.equal(records(cloth[key]).length, region.vertex_count)
  assert.equal(records(cloth.constraints)[0].height, 4)
  const influence = records(cloth.influence_map)[0]
  assert.equal(records(influence.simulation_vert_lookups)[0], 0n)
  assert.equal(records(influence.simulation_vert_weights)[0], 255)
})
test('authored PHCT retains nested FLAG and dependent body indices', async () => {
  const { model, records } = await fixture('constraints')
  const value = records(model.physics_constraints)[0]
  assert.equal(value.flags.desc.history.name, 'FLAG')
  assert.equal(value.flags.value, 5)
  assert.deepEqual(records(value.dependents), [0, 1])
  assert.equal(value.rigid_body2, 1)
  assert.equal(value.break_force, 17.5)
})
test('authored SHBX and all four IK sections exist despite pinned getter field-name gaps', async () => {
  const { model, records } = await fixture('solvers')
  assert.equal(records(model.shadow_boxes)[1].matrix.w.x, 2)
  for (const key of ['ik_two_joints', 'ik_ccd', 'ik_joints', 'one_bone_solvers']) {
    const values = records(model[key])
    assert.equal(values.length, 1)
    assert.ok(records(values[0].dependents).length > 0)
  }
  assert.equal(records(model.ik_two_joints)[0].hinge_axis.y, 1)
  assert.equal(records(model.ik_joints)[0].goal_threshold, 0.0625)
  // Evidence of the pinned projection's actual limitation; do not invent reader aliases.
  assert.equal(model.shadowboxes, undefined)
  assert.equal(model.ik, undefined)
})
