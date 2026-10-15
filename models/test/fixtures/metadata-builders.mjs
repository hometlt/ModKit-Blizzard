// Authored metadata fixtures: actual native section graphs, never mocked getter results.
import { DOMParser } from '@xmldom/xmldom'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../../dist/m3/native/platform.js'
import {
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from '../../dist/m3/native/structural.js'

const MAX_BYTES = 4_194_304
const MAX_VERTICES = 100_000
export const metadataFixtureProfiles = Object.freeze({
  effects: ['projections', 'forces', 'billboards', 'warps'],
  physics: ['rigidBodies', 'physicsJoints', 'physicsCloths'],
  constraints: ['rigidBodies', 'physicsConstraints'],
  // The pinned getters use nonexistent field names. These bytes prove section presence only.
  solvers: [],
})
function required(value, label) {
  if (value === undefined || value === null)
    throw new TypeError(`authored metadata: missing ${label}`)
  return value
}
function set(record, values) {
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(record.desc.fields, key))
      throw new TypeError(`authored metadata: absent field ${record.desc.history.name}.${key}`)
    record[key] = value
  }
  return record
}
function vector(record, values) {
  return set(
    record,
    Object.fromEntries(values.map((value, index) => [['x', 'y', 'z', 'w'][index], value])),
  )
}
function matrix(record, translation = [0, 0, 0], scale = [1, 1, 1]) {
  vector(record.x, [scale[0], 0, 0, 0])
  vector(record.y, [0, scale[1], 0, 0])
  vector(record.z, [0, 0, scale[2], 0])
  vector(record.w, [...translation, 1])
}
function anim(record, key, value) {
  const field = required(record[key], key)
  set(field.header, { interpolation: 0, flags: 0, id: 0 })
  if (Array.isArray(value)) {
    vector(field.default, value)
    vector(field.null, value)
  } else set(field, { default: value, null: value })
}

/** Authored section graphs serialized to real M3 bytes; no facade/getter patches.
 * The caller provides the immutable pinned base blob and XML. These synthetic cases
 * exercise metadata serialization and do not claim retail physics simulation fidelity.
 */
export async function createMetadataBuilderFixture(inputBytes, structuresXml, profile) {
  if (!Object.hasOwn(metadataFixtureProfiles, profile))
    throw new TypeError('unknown metadata fixture profile')
  if (inputBytes.byteLength > MAX_BYTES)
    throw new RangeError('authored metadata base exceeds budget')
  installM3PlatformAdapters({ DOMParser })
  const sections = await M3SectionList.load(Uint8Array.from(inputBytes).buffer, structuresXml)
  let model = required(sections.model, 'MODL')
  // PHCL is a genuine MODL28+ field. Preserve all existing base fields when upgrading.
  if (model.desc.version < 28) {
    const section = required(
      sections.find(section => section.content.includes(model)),
      'model section',
    )
    const description = sections.structureHistories.MODL.getVersion(
      29,
      sections.mdVersion,
      sections.structureHistories,
    )
    const upgraded = description.instance()
    for (const key of Object.keys(description.fields))
      if (Object.hasOwn(model.desc.fields, key)) upgraded[key] = model[key]
    section.desc = description
    section.indexEntry.version = 29
    section.rawBytes = null
    section.content = [upgraded]
    model = upgraded
    sections.model = model
  }
  const records = reference =>
    required(sections.getSectionByReference(reference), 'referenced section').content
  const bones = records(model.bones)
  if (bones.length < 1 || records(model.material_references).length < 1)
    throw new Error('fixture requires a real base bone and material')
  const secondBone = Math.min(1, bones.length - 1)
  const authored = []
  const add = (owner, field, tag, version, count, configure) => {
    required(owner[field], field)
    const section = appendM3Section(sections, tag, version)
    section.content = Array.from({ length: count }, (_, index) => {
      const value = section.desc.instance()
      configure(value, index)
      return value
    })
    pointM3ReferenceAtSection(sections, owner[field], section)
    authored.push({ tag, version, count })
    return section.content
  }
  const scalars = (owner, field, tag, values) => {
    required(owner[field], field)
    const section = appendM3Section(sections, tag, 0, values)
    pointM3ReferenceAtSection(sections, owner[field], section)
    authored.push({ tag, version: 0, count: values.length })
  }
  if (profile === 'effects') {
    add(model, 'projections', 'PROJ', 5, 2, (value, index) => {
      set(value, {
        projection_type: index,
        bone: index === 0 ? 0 : secondBone,
        material_reference_index: 0,
        falloff: 0.25,
        alpha_init: 0.75,
        alpha_mid: 0.5,
        alpha_end: 0.125,
        lifetime_attack: 0.25,
        lifetime_attack_to: 0.5,
        lifetime_hold: 1,
        lifetime_hold_to: 2,
        lifetime_decay: 0.75,
        lifetime_decay_to: 1.25,
        attenuation_distance: 12,
        layer: 2,
        flags: 1,
      })
      anim(value, 'offset', [1, 2, 3])
      for (const [key, number] of Object.entries({
        pitch: 0.25,
        yaw: -0.5,
        roll: 0.125,
        field_of_view: 1,
        aspect_ratio: 1.5,
        near: 0.125,
        far: 24,
        box_offset_z_bottom: -2,
        box_offset_z_top: 3,
        box_offset_x_left: -4,
        box_offset_x_right: 5,
        box_offset_y_front: -6,
        box_offset_y_back: 7,
        active: 1,
      }))
        anim(value, key, number)
    })
    add(model, 'forces', 'FOR_', 2, 3, (value, index) => {
      set(value, {
        force_type: index,
        shape: index,
        bone: 0,
        flags: 1 << index,
        channels: 5 + index,
      })
      for (const [key, number] of Object.entries({
        strength: 2 + index,
        width: 3,
        height: 4,
        length: 5,
      }))
        anim(value, key, number)
    })
    add(model, 'billboards', 'BBSC', 0, 2, (value, index) => {
      set(value, {
        bone: index === 0 ? 0 : secondBone,
        billboard_type: index === 0 ? 0 : 6,
        camera_look_at: 1,
      })
      vector(value.up, [0, 0, 0, 1])
      vector(value.forward, [0, 0, 1, 0])
      scalars(value, 'dependents', 'U16_', [0, secondBone])
    })
    add(model, 'warps', 'WRP_', 1, 1, value => {
      set(value, { bone: 0 })
      for (const [key, number] of Object.entries({
        radius: 8,
        unknown9306aac0: 3,
        strength: 0.75,
        unknown50c7f2b4: 0.25,
        unknown8d9c977c: 0.5,
        unknownca6025a2: 1.25,
      }))
        anim(value, key, number)
    })
  }
  if (profile === 'physics' || profile === 'constraints') {
    add(model, 'physics_rigidbodies', 'PHRB', 4, 2, (body, index) => {
      set(body, {
        bone: index === 0 ? 0 : secondBone,
        simulation_type: 1,
        physical_material: 2,
        mass: 5 + index,
        friction: 0.25,
        bounce: 0.125,
        damping_linear: 0.0625,
        damping_angular: 0.03125,
        gravity_factor: 0.5,
        flags: 9,
        local_forces: 5,
        world_forces: 3,
        priority: 2,
      })
      // PHSH1 has an unambiguous 132-byte schema, unlike known duplicate-field PHSH3 layouts.
      add(body, 'physics_shape', 'PHSH', 1, 2, (shape, shapeIndex) => {
        set(shape, { shape: shapeIndex, size0: 2, size1: 3, size2: 4 })
        matrix(shape.matrix, [1 + index, 2, 3])
      })
    })
  }
  if (profile === 'constraints') {
    add(model, 'physics_constraints', 'PHCT', 0, 1, value => {
      set(value, { rigid_body1: 0, rigid_body2: 1, break_force: 17.5 })
      // This is a real nested FLAG, which the pinned getter returns as a structure.
      set(value.flags, { value: 5 })
      scalars(value, 'dependents', 'U16_', [0, 1])
    })
  }
  if (profile === 'physics') {
    add(model, 'physics_joints', 'PHYJ', 0, 2, (value, index) => {
      set(value, {
        joint_type: index,
        bone1: 0,
        bone2: secondBone,
        limit_bool: 1,
        limit_min: -0.5 - index,
        limit_max: 1.25 + index,
        limit_angle: 0.75,
        friction_bool: 1,
        friction: 0.25,
        damping_ratio: 0.5,
        angular_frequency: 4,
        break_threshold: 2,
        shape_collision_value: -1,
      })
      matrix(value.matrix1, [1, 2, 3])
      matrix(value.matrix2, [-2, 1, 4])
    })
    const division = required(records(model.divisions)[0], 'base division')
    const region = required(records(division.regions)[0], 'base region')
    const count = region.vertex_count
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_VERTICES)
      throw new RangeError('cloth vertex count exceeds fixture budget')
    add(model, 'physics_cloths', 'PHCL', 4, 1, value => {
      set(value, {
        simulation_region_index: 0,
        density: 2,
        tracking: 0.25,
        stiffness_stretching: 0.75,
        stiffness_horizontal: 0.5,
        stiffness_blending: 0.25,
        damping: 0.125,
        friction: 0.25,
        gravity: 9.5,
        explosion_scale: 0.5,
        wind_scale: 0.75,
        stiffness_shear: 0.625,
        drag_factor: 0.25,
        lift_factor: 0.125,
        stiffness_spheres: 0.5,
        skin_collision: 1,
        skin_offset: 0.0625,
        skin_exponent: 2,
        skin_stiffness: 0.75,
        local_channels: 5,
      })
      anim(value, 'active', 1)
      vector(value.local_wind, [1, 2, 3])
      scalars(value, 'skin_bones', 'U16_', [0, secondBone])
      scalars(
        value,
        'vertex_simulated',
        'U8__',
        Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1)),
      )
      scalars(value, 'vertex_bones', 'U32_', Array(count).fill(0))
      scalars(value, 'vertex_weights', 'U32_', Array(count).fill(255))
      add(value, 'constraints', 'PHCC', 0, 1, constraint => {
        matrix(constraint.matrix, [1, 2, 3])
        set(constraint, { radius: 2, height: 4, bone: 0 })
      })
      add(value, 'influence_map', 'PHAC', 0, 1, influence => {
        set(influence, { influenced_region_index: 0, simulation_region_index: 0 })
        // Four packed uint16 vertex0 indices and four packed uint8 weights.
        scalars(influence, 'simulation_vert_lookups', 'U64_', Array(count).fill(0n))
        scalars(influence, 'simulation_vert_weights', 'U32_', Array(count).fill(255))
      })
    })
  }
  if (profile === 'solvers') {
    add(model, 'shadow_boxes', 'SHBX', 0, 2, (value, index) =>
      matrix(value.matrix, [1 + index, 2, 3], [2, 3, 4]),
    )
    for (const [field, tag] of [
      ['ik_two_joints', 'IK2J'],
      ['ik_ccd', 'IKCC'],
      ['ik_joints', 'IKJT'],
    ]) {
      add(model, field, tag, 0, 1, value => {
        set(value, { bone_base: 0, bone_target: secondBone, search_up: 2.5, search_down: 1.5 })
        scalars(value, 'dependents', 'U16_', [0, secondBone])
        if (tag === 'IK2J') {
          set(value, { bone_end: secondBone, cos_min_hinge_angle: -0.5, cos_max_hinge_angle: 0.75 })
          vector(value.hinge_axis, [0, 1, 0])
        }
        if (tag === 'IKJT') set(value, { search_speed: 0.75, goal_threshold: 0.0625 })
      })
    }
    add(model, 'one_bone_solvers', 'PAOB', 0, 1, value => {
      set(value, { bone: 0, flags: 3, angle: 0.5 })
      scalars(value, 'dependents', 'U16_', [secondBone])
    })
  }
  const bytes = serializeM3SectionGraph(sections)
  if (bytes.byteLength > MAX_BYTES || sections.length > 2048)
    throw new RangeError('authored metadata output exceeds budget')
  return { bytes, authored }
}
