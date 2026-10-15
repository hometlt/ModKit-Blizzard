/** M3 native writer: schema-backed scene/animation/material/physics construction and original-source
 * preserving writes. Fresh writes refuse native material losses and restore original CMS addresses. */
import { LAYER_FIELDS, materialLayerKey, materialLayerRecords, nativeCompositePassIndices, assertM3MaterialWritable } from '../uvm/material-layer-addresses.js'
// Adapted for MK3 from the repository-local Modkit M3 writer at pinned commit
// 6a1f728413c8bc1effde56e9efb79c07a77a02cd. This copy has no runtime dependency on Modkit.
import { splitTrianglesByBoneLimit } from '@modkit/codec-kit/model/skinning'
import { listRenderModelTextureRequests } from './render-model-compat.js'
import { M3SectionList } from './binary/sections.js'
import { M3StructureDescription, M3StructureHistory } from './binary/structures.js'
import { M3FieldBytes, M3FieldPrimitive, M3FieldStructure } from './binary/fields.js'
import { loadM3StructuresXml } from './binary/parser.js'
import {
  appendM3ReferencedRecord,
  appendM3Section,
  pointM3ReferenceAtSection,
  serializeM3SectionGraph,
} from './structural.js'
import { getDirname, getFs, getPath, initPlatform } from './platform.js'
const MD_VERSION = 34
const MODEL_VERSION = 29
const MATERIAL_VERSION = 20
const LAYER_VERSION = 26
const REGION_VERSION = 5
const VERTEX_POS = 1
const VERTEX_SKIN_0 = 32
const VERTEX_SKIN_1 = 64
const VERTEX_COLOR = 512
const VERTEX_UV0 = 131072
const VERTEX_UV1 = 262144
const VERTEX_UV2 = 524288
const VERTEX_UV3 = 1048576
const VERTEX_NORMAL = 8388608
const VERTEX_TANGENT = 16777216
const BONE_INHERIT = 1 | 2 | 4
const BONE_ANIMATED = 512
const BONE_SKINNED = 2048
const BONE_REAL = 8192
const MAT_GEOMETRY_VISIBLE = 2147483648
const SOURCE_BYTES = /* @__PURE__ */ new WeakMap()
function rememberM3SourceBytes(model, bytes) {
  SOURCE_BYTES.set(model, bytes.slice())
}
async function encodeM3RenderModel(model, options = {}, parserOptions = {}) {
  const issues = []
  const sourceBytes = SOURCE_BYTES.get(model)
  if (sourceBytes) {
    return encodePreservedM3Source(model, sourceBytes, options, parserOptions, issues)
  }
  assertM3MaterialWritable(model.metadata)
  const structures = withCanonicalPhysicsWriter(await loadEncoderStructures(parserOptions))
  const sections = createSectionList(structures, parserOptions)
  const modelVersion = validStructureVersion(
    structures['MODL'],
    options.m3ModelVersion,
    MODEL_VERSION,
  )
  const header = structures['MD34'].getVersion(11, MD_VERSION, structures).instance()
  header.tag = tagToUint32('MD34')
  const headerSection = appendM3Section(sections, 'MD34', 11, [header])
  const m3Model = structures['MODL'].getVersion(modelVersion, MD_VERSION, structures).instance()
  const modelSection = appendM3Section(sections, 'MODL', modelVersion, [m3Model])
  sections.model = m3Model
  headerSection.model = m3Model
  modelSection.model = m3Model
  pointReference(sections, header.model, modelSection)
  const outputName = options.fileName ?? 'model.m3'
  pointReference(
    sections,
    m3Model.model_name,
    appendString(sections, basenameWithoutExtension(outputName) || 'Model'),
  )
  m3Model.flags =
    finiteUint32(options.m3ModelFlags ?? model.metadata?.['m3ModelFlags']) ?? m3Model.flags
  m3Model.m3a_hash = finiteUint32(options.m3aHash ?? model.metadata?.['m3aHash']) ?? 0
  const m3aHashes = model.metadata?.['m3aHashes']
  if (m3aHashes !== undefined) {
    if (!Array.isArray(m3aHashes) || m3aHashes.some(value => finiteUint32(value) === undefined))
      throw new TypeError('M3 additional animation hashes must be uint32 values')
    if (m3aHashes.length > 0)
      pointReference(
        sections,
        m3Model.m3a_hashes,
        appendM3Section(sections, 'U32_', 0, m3aHashes.map(value => finiteUint32(value))),
      )
  }
  const sourceMeshes = model.meshes.filter(mesh => {
    if (mesh.primitiveTopology && mesh.primitiveTopology !== 'triangles') {
      issues.push({
        severity: 'warning',
        code: 'm3-topology-unsupported',
        message: `Skipped mesh "${mesh.name}" with ${mesh.primitiveTopology} topology.`,
      })
      return false
    }
    const vertexCount = Math.floor(mesh.positions.length / 3)
    if (vertexCount > 65535) {
      issues.push({
        severity: 'error',
        code: 'm3-region-vertex-limit',
        message: `Skipped mesh "${mesh.name}" because an M3 region is limited to 65,535 vertices.`,
      })
      return false
    }
    return vertexCount > 0 && mesh.indices.length >= 3
  })
  const skeleton = normalizedSkeleton(model)
  const animationIds = skeleton.map((bone, index) => ({
    location: animationId(`${index}:${bone.name}:location`),
    rotation: animationId(`${index}:${bone.name}:rotation`),
    scale: animationId(`${index}:${bone.name}:scale`),
    batching: animationId(`${index}:${bone.name}:batching`),
  }))
  // A region binds a bounded set of bones and addresses them with a one-byte lookup, so a mesh
  // that names more than the budget is split rather than written with its surplus rebound to
  // whatever bone the lookup's zero happens to be.
  const boundedMeshes = sourceMeshes.flatMap(mesh =>
    splitMeshToBoneBudget(mesh, skeleton.length, issues),
  )
  const vertexFlags = chooseVertexFlags(boundedMeshes)
  m3Model.vertex_flags = vertexFlags
  const vertexDescription = M3StructureDescription.getVertexDescription(vertexFlags, structures)
  const vertices = []
  const faces = []
  const boneLookup = []
  const preparedMeshes = []
  for (const mesh of boundedMeshes) {
    const prepared = prepareMesh(
      model,
      mesh,
      vertexDescription,
      vertices,
      faces,
      boneLookup,
      skeleton.length,
      options,
      issues,
    )
    if (prepared) preparedMeshes.push(prepared)
  }
  pointReference(sections, m3Model.vertices, appendM3Section(sections, 'U8__', 0, vertices))
  pointReference(sections, m3Model.bone_lookup, appendM3Section(sections, 'U16_', 0, boneLookup))
  const bounds = transformedBounds(model, preparedMeshes, options)
  assignBounds(m3Model.boundings, bounds)
  assignBounds(m3Model.collision_boundings, bounds)
  buildGeometrySections(sections, m3Model, preparedMeshes, faces, bounds)
  buildMaterialSections(sections, m3Model, model.materials, preparedMeshes, issues)
  buildSkeletonSections(sections, m3Model, model, skeleton, animationIds, options)
  buildAnimationSections(
    sections,
    m3Model,
    model,
    skeleton.length,
    animationIds,
    bounds,
    issues,
    options,
  )
  buildSceneFeatureSections(sections, m3Model, model, issues)
  applyAnimationReferenceIds(
    sections,
    model.metadata?.['m3AnimationReferenceIds'],
    model.metadata?.['m3EffectAnimationReferenceHeaders'],
    model.materials,
  )
  m3Model.skin_bone_count = skeleton.length
  const bytes = serializeM3SectionGraph(sections)
  const files =
    options.includeTextures === false || !options.assetResolver
      ? []
      : await copyTextures(model, options, issues)
  reportUnsupportedMetadata(model, issues)
  return { bytes, ...(files.length > 0 ? { files } : {}), issues }
}
function applyAnimationReferenceIds(sections, input, effectInput, materials) {
  if (input === undefined && effectInput === undefined) return
  if (input !== undefined && !Array.isArray(input))
    throw new TypeError('M3 animation reference ids must be an array')
  if (effectInput !== undefined && !Array.isArray(effectInput))
    throw new TypeError('M3 effect animation reference headers must be an array')
  const byTag = new Map()
  for (const section of sections) {
    const tag = section.desc.history.name, list = byTag.get(tag) ?? []
    list.push(section)
    byTag.set(tag, list)
  }
  const remap = new Map(), used = new Set()
  const applied = new WeakMap()
  const passIndices = materials.map(material => material.composite === undefined ? undefined
    : nativeCompositePassIndices(material.metadata, material.composite.passes.length))
  const layers = new Map(materialLayerRecords(sections, { passIndices }).map(({ record, materialLayer }) =>
    [materialLayerKey(materialLayer), record]))
  const apply = (reference, binding, key) => {
    if (reference && typeof reference === 'object') {
      const previous = applied.get(reference)
      if (previous) {
        if (previous.animId !== binding.animId || previous.interpolation !== binding.interpolation || previous.flags !== binding.flags)
          throw new TypeError(`M3 shared animation reference headers conflict at ${key}`)
        return
      }
      applied.set(reference, binding)
    }
    const generated = reference?.header?.id
    // A format residual may describe a native feature which the common scene did not project.
    // Its structured SD track keeps its original id; only reconstructed references participate
    // in the generated-id remap.
    if (!Number.isSafeInteger(generated) || generated === 0) return
    const previous = remap.get(generated)
    if (previous !== undefined && previous !== binding.animId)
      throw new TypeError(
        `M3 generated animation id ${generated} maps to both ${previous} and ${binding.animId} at ${key}`,
      )
    remap.set(generated, binding.animId)
    reference.header.id = binding.animId
    reference.header.interpolation = binding.interpolation
    reference.header.flags = binding.flags
  }
  for (const binding of input ?? []) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        typeof binding.tag !== 'string' || typeof binding.field !== 'string' ||
        !Number.isSafeInteger(binding.sectionOrdinal) || binding.sectionOrdinal < 0 ||
        !Number.isSafeInteger(binding.recordIndex) || binding.recordIndex < 0 ||
        !Number.isSafeInteger(binding.animId) || binding.animId < 0 || binding.animId > 0xffffffff ||
        !Number.isSafeInteger(binding.interpolation) || binding.interpolation < 0 || binding.interpolation > 0xffffffff ||
        !Number.isSafeInteger(binding.flags) || binding.flags < 0 || binding.flags > 0xffffffff)
      throw new TypeError('M3 animation reference id binding is invalid')
    let key = `${binding.tag}/${binding.sectionOrdinal}/${binding.recordIndex}/${binding.field}`
    let record
    if (binding.tag === 'LAYR') {
      const address = binding.materialLayer
      if (!address || !Number.isSafeInteger(address.materialIndex) || address.materialIndex < 0 ||
          typeof address.slot !== 'string' || !LAYER_FIELDS.some(([slot]) => slot === address.slot) ||
          (address.passIndex !== undefined && (!Number.isSafeInteger(address.passIndex) || address.passIndex < 0)))
        throw new TypeError('M3 LAYR animation binding needs a semantic materialLayer owner; re-import the native source before re-export')
      key = `LAYR/${materialLayerKey(address)}/${binding.field}`
      record = layers.get(materialLayerKey(address))
      if (!record?.[binding.field]?.header)
        throw new TypeError(`M3 material layer animation reference target is absent at ${key}`)
    } else {
      record = byTag.get(binding.tag)?.[binding.sectionOrdinal]?.content?.[binding.recordIndex]
    }
    if (used.has(key)) throw new TypeError('M3 animation reference id binding is duplicated')
    used.add(key)
    apply(record?.[binding.field], binding, key)
  }
  const effectRecords = {
    particles: sections.getSectionByReference(sections.model?.particle_systems)?.content ?? [],
    ribbons: sections.getSectionByReference(sections.model?.ribbons)?.content ?? [],
  }
  for (const binding of effectInput ?? []) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        (binding.kind !== 'particles' && binding.kind !== 'ribbons') ||
        typeof binding.field !== 'string' ||
        !Number.isSafeInteger(binding.emitterIndex) || binding.emitterIndex < 0 ||
        !Number.isSafeInteger(binding.animId) || binding.animId < 0 || binding.animId > 0xffffffff ||
        !Number.isSafeInteger(binding.interpolation) || binding.interpolation < 0 || binding.interpolation > 0xffffffff ||
        !Number.isSafeInteger(binding.flags) || binding.flags < 0 || binding.flags > 0xffffffff)
      throw new TypeError('M3 effect animation reference header binding is invalid')
    const key = `${binding.kind}/${binding.emitterIndex}/${binding.field}`
    if (used.has(key)) throw new TypeError('M3 effect animation reference header binding is duplicated')
    used.add(key)
    const record = effectRecords[binding.kind][binding.emitterIndex]
    if (!record) throw new TypeError(`M3 effect animation reference target is absent at ${key}`)
    apply(record[binding.field], binding, key)
  }
  for (const tag of ['STC_', 'STS_'])
    for (const section of byTag.get(tag) ?? [])
      for (const record of section.content) {
        const ids = sections.getSectionByReference(record.anim_ids)?.content
        if (!ids) continue
        for (let index = 0; index < ids.length; index++)
          if (remap.has(ids[index])) ids[index] = remap.get(ids[index])
      }
}
async function encodePreservedM3Source(model, sourceBytes, options, parserOptions, issues) {
  const scale = finiteNumber(options.scale) ?? 1
  const animationNames = options.animationNames
  const hasNameEdits =
    animationNames?.some(name => typeof name === 'string' && name.trim().length > 0) ?? false
  let bytes = sourceBytes.slice()
  if (scale !== 1 || hasNameEdits) {
    await initPlatform()
    let structuresXml = parserOptions.structuresXml ?? parserOptions.embeddedStructuresXml
    if (!structuresXml) {
      structuresXml = getFs().readFileSync(getPath().join(getDirname(), 'structures.xml'), 'utf8')
    }
    const buffer = new ArrayBuffer(sourceBytes.byteLength)
    new Uint8Array(buffer).set(sourceBytes)
    const sections = await M3SectionList.load(buffer, structuresXml)
    if (hasNameEdits) renamePreservedSequences(sections, animationNames ?? [])
    if (scale !== 1) scalePreservedM3(sections, scale)
    bytes = serializeM3SectionGraph(sections)
    issues.push({
      severity: 'info',
      code: 'm3-source-sections-preserved',
      message: `Preserved all ${sections.length} native M3 sections while applying export edits.`,
    })
  } else {
    issues.push({
      severity: 'info',
      code: 'm3-source-byte-preserved',
      message: 'Exported the native M3 section graph byte-for-byte.',
    })
  }
  const files =
    options.includeTextures === false || !options.assetResolver
      ? []
      : await copyTextures(model, options, issues)
  return { bytes, ...(files.length > 0 ? { files } : {}), issues }
}
function renamePreservedSequences(sections, animationNames) {
  const model = sections.model
  if (!model) return
  const groups = [
    referencedRecords(sections, model.sequences),
    referencedRecords(sections, model.sequence_transformation_collections),
    referencedRecords(sections, model.sequence_transformation_groups),
  ]
  for (let index = 0; index < animationNames.length; index += 1) {
    const name = animationNames[index]?.trim()
    if (!name) continue
    for (const records of groups) {
      const record = records[index]
      if (record?.name) pointReference(sections, record.name, appendString(sections, name))
    }
  }
}
function scalePreservedM3(sections, scale) {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`M3 export scale must be a positive finite number; received ${scale}.`)
  }
  const model = sections.model
  if (!model) return
  const animatedIds = /* @__PURE__ */ new Map()
  scaleBoundsValue(model.boundings, scale)
  scaleBoundsValue(model.collision_boundings, scale)
  scaleReferencedVectors(sections, model.collision_verts, scale)
  scaleM3Vertices(sections, model, scale)
  for (const bone of referencedRecords(sections, model.bones)) {
    scaleAnimationReference(bone.location, scale, 'vector', animatedIds)
  }
  for (const rest of referencedRecords(sections, model.bone_rests)) {
    scaleMatrixValue(rest.matrix, scale, false)
  }
  for (const sequence of referencedRecords(sections, model.sequences)) {
    scaleNumberField(sequence, 'movement_speed', scale)
    scaleBoundsValue(sequence.bounding_sphere, scale)
  }
  for (const section of sections) {
    const tag = section.desc.history.name
    for (const value of section.content) {
      if (!isStructureRecord(value)) continue
      scalePreservedRecord(sections, tag, value, scale, animatedIds)
    }
  }
  scalePreservedAnimationKeys(sections, animatedIds, scale)
}
function scalePreservedRecord(sections, tag, record, scale, animatedIds) {
  const animatedVectorFields = {
    PAR_: ['emit_shape_size', 'emit_shape_size_cutout', 'size', 'size2'],
    PROJ: ['offset'],
    RIB_: ['scale'],
  }
  const animatedScalarFields = {
    PAR_: [
      'emit_speed',
      'emit_speed_random',
      'gravity',
      'emit_shape_radius',
      'emit_shape_radius_cutout',
    ],
    RIB_: ['speed', 'speed2', 'length'],
    PROJ: [
      'near',
      'far',
      'box_offset_z_bottom',
      'box_offset_z_top',
      'box_offset_x_left',
      'box_offset_x_right',
      'box_offset_y_front',
      'box_offset_y_back',
      'attenuation_distance',
    ],
    FOR_: ['width', 'height', 'length'],
    WRP_: ['radius', 'unknown9306aac0'],
    CAM_: [
      'far_clip',
      'near_clip',
      'shadow_clip_distance',
      'focus_distance',
      'far_focus_range',
      'near_focus_range',
      'near_falloff_start',
      'near_falloff_end',
    ],
    LITE: ['attenuation_near'],
  }
  for (const field of animatedVectorFields[tag] ?? []) {
    scaleAnimationReference(record[field], scale, 'vector', animatedIds)
  }
  for (const field of animatedScalarFields[tag] ?? []) {
    scaleAnimationReference(record[field], scale, 'scalar', animatedIds)
  }
  const scalarFields = {
    PAR_: ['gravity', 'instance_tail', 'instance_distance'],
    RIB_: ['gravity_x', 'gravity_y', 'gravity'],
    LITE: ['attenuation_far'],
    CAM_: ['far_clip_static', 'near_clip_static'],
    SSGS: ['size0', 'size1', 'size2'],
    ATVL: ['size0', 'size1', 'size2'],
    PHSH: ['size0', 'size1', 'size2'],
  }
  for (const field of scalarFields[tag] ?? []) scaleNumberField(record, field, scale)
  if (tag === 'MSEC') scaleAnimationBoundsReference(record.bounding, scale)
  if (tag === 'SSGS' || tag === 'ATVL') scaleMatrixValue(record.matrix, scale, false)
  if (tag === 'PHSH' || tag === 'SHBX') scaleMatrixValue(record.matrix, scale, true)
  if (tag === 'PHSH') scaleReferencedVectors(sections, record.vertices, scale)
}
function scaleM3Vertices(sections, model, scale) {
  const vertexSection = sections.getSectionByReference(model.vertices)
  if (!vertexSection?.rawBytes) return
  const flags = finiteUint32(model.vertex_flags) ?? 0
  const description = M3StructureDescription.getVertexDescription(
    flags,
    sections.structureHistories,
  )
  const count = Math.floor(vertexSection.rawBytes.byteLength / description.size)
  const records = description.instances(vertexSection.rawBytes, count)
  const bytes = new Uint8Array(count * description.size)
  records.forEach((record, index) => {
    scaleVectorValue(record.pos, scale)
    record.toBuffer(bytes.buffer, index * description.size)
  })
  vertexSection.rawBytes = bytes.buffer
  vertexSection.content = [...bytes]
}
function scalePreservedAnimationKeys(sections, animatedIds, scale) {
  const fields = [
    'sdev',
    'sd2v',
    'sd3v',
    'sd4q',
    'sdcc',
    'sdr3',
    'sdu8',
    'sds6',
    'sdu6',
    'sds3',
    'sdu3',
    'sdfg',
    'sdmb',
  ]
  for (const stcSection of sections.filter(section => section.desc.history.name === 'STC_')) {
    for (const stc of stcSection.content) {
      if (!isStructureRecord(stc)) continue
      const ids = referencedNumbers(sections, stc.anim_ids)
      const references = referencedNumbers(sections, stc.anim_refs)
      ids.forEach((id, index) => {
        const kind = animatedIds.get(id >>> 0)
        const packed = references[index]
        if (!kind || packed === void 0) return
        const field = fields[(packed >>> 16) & 65535]
        if (!field) return
        const blocks = referencedRecords(sections, stc[field])
        const block = blocks[packed & 65535]
        if (!block) return
        const keySection = sections.getSectionByReference(block.keys)
        if (!keySection) return
        for (let keyIndex = 0; keyIndex < keySection.content.length; keyIndex += 1) {
          const key = keySection.content[keyIndex]
          if (kind === 'scalar' && typeof key === 'number') {
            keySection.content[keyIndex] = key * scale
          } else if (isStructureRecord(key)) {
            scaleVectorValue(key, scale)
          }
        }
      })
    }
  }
}
function scaleAnimationReference(value, scale, kind, ids) {
  if (!isStructureRecord(value)) return
  const header = value.header
  if (isStructureRecord(header) && typeof header.id === 'number') ids.set(header.id >>> 0, kind)
  if (kind === 'scalar') {
    if (typeof value.default === 'number') value.default *= scale
    if (typeof value.null === 'number') value.null *= scale
  } else {
    scaleVectorValue(value.default, scale)
    scaleVectorValue(value.null, scale)
  }
}
function scaleAnimationBoundsReference(value, scale) {
  if (!isStructureRecord(value)) return
  scaleBoundsValue(value.default, scale)
  scaleBoundsValue(value.null, scale)
}
function scaleBoundsValue(value, scale) {
  if (!isStructureRecord(value)) return
  scaleVectorValue(value.min, scale)
  scaleVectorValue(value.max, scale)
  scaleNumberField(value, 'radius', scale)
}
function scaleMatrixValue(value, scale, scaleBasis) {
  if (!isStructureRecord(value)) return
  if (scaleBasis) {
    scaleVectorValue(value.x, scale)
    scaleVectorValue(value.y, scale)
    scaleVectorValue(value.z, scale)
  }
  const translation = value.w
  if (isStructureRecord(translation)) {
    if (typeof translation.x === 'number') translation.x *= scale
    if (typeof translation.y === 'number') translation.y *= scale
    if (typeof translation.z === 'number') translation.z *= scale
  }
}
function scaleReferencedVectors(sections, value, scale) {
  const section = sections.getSectionByReference(value)
  if (!section) return
  for (const vector of section.content)
    if (isStructureRecord(vector)) scaleVectorValue(vector, scale)
}
function scaleVectorValue(value, scale) {
  if (!isStructureRecord(value)) return
  if (typeof value.x === 'number') value.x *= scale
  if (typeof value.y === 'number') value.y *= scale
  if (typeof value.z === 'number') value.z *= scale
}
function scaleNumberField(value, field, scale) {
  if (typeof value[field] === 'number') value[field] *= scale
}
function referencedRecords(sections, value) {
  const section = sections.getSectionByReference(value)
  return (section?.content ?? []).filter(isStructureRecord)
}
function referencedNumbers(sections, value) {
  const section = sections.getSectionByReference(value)
  return (section?.content ?? []).filter(entry => typeof entry === 'number')
}
function isStructureRecord(value) {
  return typeof value === 'object' && value !== null && 'desc' in value
}
function createSectionList(structures, parserOptions) {
  const sections = new M3SectionList()
  sections.mdVersion = MD_VERSION
  sections.structureHistories = structures
  sections.structuresXmlSource =
    parserOptions.structuresXml ?? parserOptions.embeddedStructuresXml ?? null
  return sections
}
async function loadEncoderStructures(options) {
  await initPlatform()
  let xml = options.structuresXml ?? options.embeddedStructuresXml
  if (!xml) xml = getFs().readFileSync(getPath().join(getDirname(), 'structures.xml'), 'utf8')
  return loadM3StructuresXml(xml)
}
function withCanonicalPhysicsWriter(source) {
  const structures = { ...source }
  const structured = (name, type) =>
    new M3FieldStructure(name, structures[type].getVersion(0, MD_VERSION, structures))
  const primitive = (name, type) => new M3FieldPrimitive(name, type)
  const fields = [
    structured('matrix', 'Matrix44'),
    primitive('shape', 'uint8'),
    primitive('shape_fb8', 'uint8'),
    primitive('shape_fb16', 'uint16'),
    structured('legacy_sizes', 'VEC3'),
    structured('reserved_reference', 'Reference'),
    primitive('size0', 'float'),
    primitive('size1', 'float'),
    primitive('size2', 'float'),
    structured('vertices', 'Reference'),
    structured('plane_equations', 'Reference'),
    structured('loops', 'Reference'),
    structured('polygons', 'Reference'),
    structured('polygons_center', 'VEC3'),
    primitive('vertices_count', 'uint32'),
    primitive('polygons_count', 'uint32'),
    primitive('loops_count', 'uint32'),
    primitive('unknown8d41b3f8', 'float'),
    primitive('unknown56fece2', 'float'),
    structured('mesh_bvh', 'Reference'),
    structured('mesh_vertices', 'Reference'),
    structured('mesh_triangles16', 'Reference'),
    structured('mesh_triangles32', 'Reference'),
    structured('mesh_bounds_center', 'VEC3'),
    structured('mesh_bounds_extent', 'VEC3'),
    structured('mesh_tolerance', 'VEC3'),
    primitive('mesh_bvh_count', 'uint32'),
    primitive('mesh_vertex_count', 'uint32'),
    primitive('mesh_triangle16_count', 'uint32'),
    primitive('mesh_triangle32_count', 'uint32'),
    primitive('mesh_unknown', 'uint32'),
    primitive('mesh_reserved', 'uint32'),
    primitive('mesh_tree_depth', 'uint32'),
    primitive('mesh_collision_margin', 'float'),
  ]
  structures.PHSH = new M3StructureHistory(
    'PHSH',
    new Map([[3, 300]]),
    fields.map(field => ({ field, sinceVersion: 3, tillVersion: 3 })),
  )
  return structures
}
function buildGeometrySections(sections, model, meshes, faces, bounds) {
  const division = instance(sections, 'DIV_', 2)
  const regions = meshes.map((mesh, index) => {
    const region = instance(sections, 'REGN', REGION_VERSION)
    region.id = index
    region.first_vertex_index = mesh.firstVertex
    region.vertex_count = mesh.vertexCount
    region.first_face_index = mesh.firstFace
    region.face_count = mesh.faceCount
    region.bone_count = mesh.boneLookup.length
    region.first_bone_lookup_index = mesh.firstBoneLookup
    region.bone_lookup_count = mesh.boneLookup.length
    region.vertex_lookups_used = Math.min(mesh.boneLookup.length, 255)
    region.root_bone = mesh.boneLookup[0] ?? 0
    region.uv_multiply = mesh.uvMultiply
    region.uv_offset = mesh.uvOffset
    return region
  })
  const batches = meshes.map((mesh, index) => {
    const batch = instance(sections, 'BAT_', 1)
    batch.region_index = index
    batch.bounds_index = 0
    batch.color_index = 0
    batch.material_reference_index = mesh.materialIndex
    // The bone whose batching toggles this batch on and off, when the region is shown and hidden.
    const toggle = mesh.source?.visibilityBone
    if (Number.isSafeInteger(toggle) && toggle >= 0 && toggle <= 0x7fff) batch.bone = toggle
    return batch
  })
  const msec = instance(sections, 'MSEC', 1)
  assignAnimatedBounds(msec.bounding, bounds)
  pointReference(sections, division.faces, appendM3Section(sections, 'U16_', 0, faces))
  pointReference(
    sections,
    division.regions,
    appendM3Section(sections, 'REGN', REGION_VERSION, regions),
  )
  pointReference(sections, division.batches, appendM3Section(sections, 'BAT_', 1, batches))
  pointReference(sections, division.msec, appendM3Section(sections, 'MSEC', 1, [msec]))
  pointReference(sections, model.divisions, appendM3Section(sections, 'DIV_', 2, [division]))
}
function buildSkeletonSections(sections, model, source, bones, ids, options) {
  const boneRecords = bones.map((bone, index) => {
    const record = instance(sections, 'BONE', 1)
    record.id = bone.index
    record.parent = bone.parentIndex
    record.flags = bone.flags ?? BONE_INHERIT | BONE_SKINNED | BONE_REAL | BONE_ANIMATED
    pointReference(sections, record.name, appendString(sections, bone.name || `Bone_${index}`))
    setAnimationReference(record.location, ids[index].location, [0, 0, 0])
    setAnimationReference(record.rotation, ids[index].rotation, [0, 0, 0, 1])
    setAnimationReference(record.scale, ids[index].scale, [1, 1, 1])
    // Batching is the toggle of the batches that name this bone; a region hidden at rest starts off.
    // A toggle bone's flag is stepped, as in StarCraft II's own models.
    setAnimationReference(record.batching, ids[index].batching, [bone.batching === 0 ? 0 : 1])
    if (bone.batching !== undefined) record.batching.header.interpolation = 0
    return record
  })
  const rests = bones.map(bone => {
    const record = instance(sections, 'IREF', 0)
    assignMatrix(record.matrix, convertedInverseBindMatrix(source, bone.inverseBindMatrix, options))
    return record
  })
  pointReference(sections, model.bones, appendM3Section(sections, 'BONE', 1, boneRecords))
  pointReference(sections, model.bone_rests, appendM3Section(sections, 'IREF', 0, rests))
}
function normalizedAnimationEvents(source, sequenceCount) {
  const input = source.metadata?.['m3AnimationEvents']
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new TypeError('M3 animation events must be an array')
  const integer = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new TypeError(`M3 animation event ${label} is invalid`)
    return value
  }
  return input.map((track, trackIndex) => {
    if (!track || typeof track !== 'object' || Array.isArray(track))
      throw new TypeError('M3 animation event track is invalid')
    const sequenceIndex = integer(track.sequenceIndex, 0, sequenceCount - 1, 'sequenceIndex')
    const stcOrder = integer(track.stcOrder, 0, 0xffff, 'stcOrder')
    const priority = integer(track.priority, 0, 0xffff, 'priority')
    const animId = integer(track.animId, 0, 0xffffffff, 'animId')
    const flags = integer(track.flags, 0, 0xffffffff, 'flags')
    const fend = integer(track.fend, 0, 0xffffffff, 'fend')
    if (!Array.isArray(track.frames) || !Array.isArray(track.events) || track.frames.length !== track.events.length || track.frames.length === 0)
      throw new TypeError('M3 animation event frames and values must be nonempty and aligned')
    const frames = track.frames.map(value => integer(value, 0, 0x7fffffff, 'frame'))
    if (frames.some((value, index) => index > 0 && value < frames[index - 1]))
      throw new TypeError('M3 animation event frames must be ordered')
    const events = track.events.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('M3 animation event value is invalid')
      if (typeof value.name !== 'string' || typeof value.payload !== 'string' || value.name.includes('\0') || value.payload.includes('\0'))
        throw new TypeError('M3 animation event strings are invalid')
      if (!Array.isArray(value.matrix) || value.matrix.length !== 16 || value.matrix.some(component => typeof component !== 'number' || !Number.isFinite(component)))
        throw new TypeError('M3 animation event matrix is invalid')
      return {
        name: value.name,
        payload: value.payload,
        id: integer(value.id, -0x80000000, 0x7fffffff, 'id'),
        bone: integer(value.bone, -0x8000, 0x7fff, 'bone'),
        flags: integer(value.flags, 0, 0xffffffff, 'flags'),
        dataParam0: integer(value.dataParam0, 0, 0xffffffff, 'dataParam0'),
        dataParam1: integer(value.dataParam1, 0, 0xffffffff, 'dataParam1'),
        version: integer(value.version, 0, 2, 'version'),
        matrix: value.matrix,
      }
    })
    if (events.some(value => value.version !== events[0].version))
      throw new TypeError('M3 animation event track cannot mix EVNT versions')
    return { sequenceIndex, stcOrder, priority, animId, flags, fend, frames, events, concurrent: track.concurrent === true, trackIndex }
  })
}
function appendAnimationEventStcs(sections, tracks, sequenceName, stcRecords, stsRecords) {
  const groups = new Map()
  for (const track of tracks) {
    const key = `${track.stcOrder}:${track.concurrent}:${track.priority}`
    const group = groups.get(key) ?? []
    group.push(track)
    groups.set(key, group)
  }
  const indices = []
  for (const group of [...groups.values()].sort((left, right) => left[0].stcOrder - right[0].stcOrder)) {
    const stc = instance(sections, 'STC_', 4)
    pointReference(sections, stc.name, appendString(sections, sequenceName))
    stc.concurrent = group[0].concurrent ? 1 : 0
    stc.priority = group[0].priority
    stc.sts_index = stsRecords.length
    stc.sts_index_fb = stsRecords.length
    const ids = [], refs = [], blocks = []
    for (const track of group.sort((left, right) => left.trackIndex - right.trackIndex)) {
      const events = track.events.map(value => {
        const event = instance(sections, 'EVNT', value.version)
        pointReference(sections, event.name, appendString(sections, value.name))
        if (value.payload.length > 0)
          pointReference(sections, event.payload, appendString(sections, value.payload))
        event.id = value.id
        event.bone = value.bone
        event.bone_fb = 0
        assignMatrixArray(event.matrix, value.matrix)
        event.flags = value.flags
        if (value.version >= 1) event.data_param0 = value.dataParam0
        if (value.version >= 2) event.data_param1 = value.dataParam1
        return event
      })
      const block = instance(sections, 'SDEV', 0)
      pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, track.frames))
      block.flags = track.flags
      block.fend = track.fend
      pointReference(sections, block.keys, appendM3Section(sections, 'EVNT', events[0].desc.version, events))
      ids.push(track.animId)
      refs.push(blocks.length)
      blocks.push(block)
    }
    pointReference(sections, stc.anim_ids, appendM3Section(sections, 'U32_', 0, ids))
    pointReference(sections, stc.anim_refs, appendM3Section(sections, 'U32_', 0, refs))
    pointReference(sections, stc.sdev, appendM3Section(sections, 'SDEV', 0, blocks))
    stc.ref_count = ids.length
    indices.push(stcRecords.length)
    stcRecords.push(stc)
    const sts = instance(sections, 'STS_', 0)
    pointReference(sections, sts.anim_ids, appendM3Section(sections, 'U32_', 0, ids))
    stsRecords.push(sts)
  }
  return indices
}
const RESIDUAL_SD = Object.freeze({
  sd2v: ['SD2V', 'VEC2', 1], sd3v: ['SD3V', 'VEC3', 2],
  sd4q: ['SD4Q', 'QUAT', 3], sdcc: ['SDCC', 'COL', 4],
  sdr3: ['SDR3', 'REAL', 5], sdu8: ['SDU8', 'U8__', 6],
  sds6: ['SDS6', 'I16_', 7], sdu6: ['SDU6', 'U16_', 8],
  sds3: ['SDS3', 'I32_', 9], sdu3: ['SDU3', 'U32_', 10],
  sdfg: ['SDFG', 'FLAG', 11], sdmb: ['SDMB', 'BNDS', 12],
})
function normalizedResidualAnimationTracks(source, sequenceCount) {
  const input = source.metadata?.['m3ResidualAnimationTracks']
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new TypeError('M3 residual animation tracks must be an array')
  const integer = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new TypeError(`M3 residual animation ${label} is invalid`)
    return value
  }
  return input.map((track, trackIndex) => {
    if (!track || typeof track !== 'object' || Array.isArray(track) || !RESIDUAL_SD[track.sdField])
      throw new TypeError('M3 residual animation track is invalid')
    if (!Array.isArray(track.frames) || !Array.isArray(track.values) || track.frames.length !== track.values.length || track.frames.length === 0)
      throw new TypeError('M3 residual animation keys must be nonempty and aligned')
    const frames = track.frames.map(value => integer(value, 0, 0x7fffffff, 'frame'))
    if (frames.some((value, index) => index > 0 && value < frames[index - 1]))
      throw new TypeError('M3 residual animation frames must be ordered')
    return {
      sequenceIndex: integer(track.sequenceIndex, 0, sequenceCount - 1, 'sequenceIndex'),
      stcOrder: integer(track.stcOrder, 0, 0xffff, 'stcOrder'),
      priority: integer(track.priority, 0, 0xffff, 'priority'),
      animId: integer(track.animId, 0, 0xffffffff, 'animId'),
      flags: integer(track.flags, 0, 0xffffffff, 'flags'),
      fend: integer(track.fend, 0, 0xffffffff, 'fend'),
      concurrent: track.concurrent === true,
      sdField: track.sdField,
      frames,
      values: track.values,
      trackIndex,
    }
  })
}
function residualAnimationKeys(sections, field, keyTag, values) {
  const finite = value => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new TypeError('M3 residual animation value is nonfinite')
    return value
  }
  if (field === 'sdr3')
    return values.map(value => {
      const result = finite(value)
      if (!Number.isFinite(Math.fround(result)))
        throw new TypeError('M3 residual REAL value exceeds float32')
      return result
    })
  const integerRanges = {
    sdu8: [0, 0xff],
    sds6: [-0x8000, 0x7fff],
    sdu6: [0, 0xffff],
    sds3: [-0x80000000, 0x7fffffff],
    sdu3: [0, 0xffffffff],
  }
  if (integerRanges[field]) {
    const [minimum, maximum] = integerRanges[field]
    return values.map(value => {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError(`M3 residual ${field.toUpperCase()} value is invalid`)
      return value
    })
  }
  if (field === 'sdfg')
    return values.map(value => {
      const flag = finiteUint32(value)
      if (flag === undefined) throw new TypeError('M3 residual FLAG value is invalid')
      return flag
    })
  if (field === 'sdmb')
    return values.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.min) || !Array.isArray(value.max) || value.min.length !== 3 || value.max.length !== 3)
        throw new TypeError('M3 residual bounds value is invalid')
      const record = instance(sections, 'BNDS', 0)
      assignVector(record.min, value.min.map(finite), 3)
      assignVector(record.max, value.max.map(finite), 3)
      record.radius = finite(value.radius)
      return record
    })
  const width = field === 'sd2v' ? 2 : field === 'sd3v' ? 3 : 4
  return values.map(value => {
    if (!Array.isArray(value) || value.length !== width) throw new TypeError('M3 residual vector value is invalid')
    const record = instance(sections, keyTag, 0)
    if (field === 'sdcc') {
      ;['r', 'g', 'b', 'a'].forEach((component, index) => {
        const item = value[index]
        if (!Number.isSafeInteger(item) || item < 0 || item > 255)
          throw new TypeError('M3 residual color value is invalid')
        record[component] = item
      })
    } else assignVector(record, value.map(finite), width)
    return record
  })
}
function appendResidualAnimationStcs(sections, tracks, sequenceName, stcRecords, stsRecords) {
  const indices = []
  for (const track of [...tracks].sort((left, right) => left.stcOrder - right.stcOrder || left.trackIndex - right.trackIndex)) {
    const [blockTag, keyTag, fieldIndex] = RESIDUAL_SD[track.sdField]
    const keys = residualAnimationKeys(sections, track.sdField, keyTag, track.values)
    const block = instance(sections, blockTag, 0)
    pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, track.frames))
    block.flags = track.flags
    block.fend = track.fend
    pointReference(sections, block.keys, appendM3Section(sections, keyTag, 0, keys))
    const stc = instance(sections, 'STC_', 4)
    pointReference(sections, stc.name, appendString(sections, sequenceName))
    stc.concurrent = track.concurrent ? 1 : 0
    stc.priority = track.priority
    stc.sts_index = stsRecords.length
    stc.sts_index_fb = stsRecords.length
    pointReference(sections, stc.anim_ids, appendM3Section(sections, 'U32_', 0, [track.animId]))
    pointReference(sections, stc.anim_refs, appendM3Section(sections, 'U32_', 0, [fieldIndex << 16]))
    pointReference(sections, stc[track.sdField], appendM3Section(sections, blockTag, 0, [block]))
    stc.ref_count = 1
    indices.push(stcRecords.length)
    stcRecords.push(stc)
    const sts = instance(sections, 'STS_', 0)
    pointReference(sections, sts.anim_ids, appendM3Section(sections, 'U32_', 0, [track.animId]))
    stsRecords.push(sts)
  }
  return indices
}
function mergeResidualAnimationTracks(
  sections,
  tracks,
  stcIndices,
  stcRecords,
  stsRecords,
) {
  const pending = []
  for (const track of [...tracks].sort((left, right) => left.stcOrder - right.stcOrder || left.trackIndex - right.trackIndex)) {
    const stcIndex = stcIndices[track.stcOrder]
    const stc = stcIndex === undefined ? undefined : stcRecords[stcIndex]
    if (!stc || Boolean(stc.concurrent) !== track.concurrent || Number(stc.priority) !== track.priority) {
      pending.push(track)
      continue
    }
    const [blockTag, keyTag, fieldIndex] = RESIDUAL_SD[track.sdField]
    const keys = residualAnimationKeys(sections, track.sdField, keyTag, track.values)
    const block = instance(sections, blockTag, 0)
    pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, track.frames))
    block.flags = track.flags
    block.fend = track.fend
    pointReference(sections, block.keys, appendM3Section(sections, keyTag, 0, keys))
    let blockIndex = 0
    if ((stc[track.sdField]?.entries ?? 0) === 0) {
      pointReference(sections, stc[track.sdField], appendM3Section(sections, blockTag, 0, [block]))
    } else {
      blockIndex = appendM3ReferencedRecord(sections, stc[track.sdField], block)
    }
    appendM3ReferencedRecord(sections, stc.anim_ids, track.animId)
    appendM3ReferencedRecord(sections, stc.anim_refs, (fieldIndex << 16) | blockIndex)
    stc.ref_count = stc.anim_ids.entries
    const sts = stsRecords[stc.sts_index]
    if (!sts) throw new TypeError('M3 residual animation STS target is absent')
    appendM3ReferencedRecord(sections, sts.anim_ids, track.animId)
  }
  return pending
}
function buildAnimationSections(sections, model, source, boneCount, ids, bounds, issues, options) {
  const sourceSequences = source.animations.filter(isRenderSequence)
  const sequences =
    sourceSequences.length > 0
      ? sourceSequences
      : [
          {
            name: 'Stand',
            durationSeconds: 1,
            looping: true,
            nodeTracks: [],
          },
        ]
  const sequenceRecords = []
  const stcRecords = []
  const stsRecords = []
  const stgRecords = []
  const animationEvents = normalizedAnimationEvents(source, sequences.length)
  const residualAnimationTracks = normalizedResidualAnimationTracks(source, sequences.length)
  sequences.forEach((sequence, sequenceIndex) => {
    const sequenceName = effectiveAnimationName(sequence, sequenceIndex, options.animationNames)
    const durationMs = Math.max(1, Math.round(Math.max(0, sequence.durationSeconds) * 1e3))
    const sequenceRecord = instance(sections, 'SEQS', 2)
    sequenceRecord.id = sequenceIndex
    sequenceRecord.index = sequenceIndex
    pointReference(sections, sequenceRecord.name, appendString(sections, sequenceName))
    sequenceRecord.anim_ms_start = 0
    sequenceRecord.anim_ms_end = durationMs
    sequenceRecord.movement_speed = sequence.movementSpeed ?? 0
    sequenceRecord.flags = sequence.looping ? 0 : 1
    sequenceRecord.frequency = 100
    sequenceRecord.ms_blend = finiteUint32(sequence.metadata?.['blendTimeMs']) ?? 100
    assignBounds(sequenceRecord.bounding_sphere, bounds)
    sequenceRecords.push(sequenceRecord)
    const materialTracks = materialAnimationTracks(source, sequenceIndex)
    const trackSets = new Map(sequence.nodeTracks.map(track => [track.boneIndex, track]))
    const modeOf = track => (track?.concurrent ?? sequence.concurrent) === true
    const modes = [false, true].filter(mode =>
      [...trackSets.values()].some(tracks =>
        ['translation', 'rotation', 'scale', 'visibility'].some(kind =>
          tracks[kind] && modeOf(tracks[kind]) === mode,
        ),
      ) || materialTracks.some(value => value.concurrent === mode),
    )
    if (modes.length === 0) modes.push(sequence.concurrent === true)
    const stcIndices = []
    for (const concurrent of modes) {
      const stc = instance(sections, 'STC_', 4)
      pointReference(sections, stc.name, appendString(sections, sequenceName))
      stc.concurrent = concurrent ? 1 : 0
      stc.priority = sequence.priority ?? 0
      stc.sts_index = stsRecords.length
      stc.sts_index_fb = stsRecords.length
      const animIds = []
      const animRefs = []
      const vectorBlocks = []
      const vector2Blocks = []
      const quaternionBlocks = []
      const colorBlocks = []
      const scalarBlocks = []
      const flagBlocks = []
      for (let boneIndex = 0; boneIndex < boneCount; boneIndex += 1) {
        const tracks = trackSets.get(boneIndex)
        if (!tracks) continue
        const selected = kind =>
          tracks[kind] && modeOf(tracks[kind]) === concurrent ? tracks[kind] : undefined
        addTrack(sections, selected('translation'), ids[boneIndex].location, 2, 'SD3V', 'VEC3', durationMs, vectorBlocks, animIds, animRefs, issues, value => convertTrackTranslation(source, value, options))
        addTrack(sections, selected('rotation'), ids[boneIndex].rotation, 3, 'SD4Q', 'QUAT', durationMs, quaternionBlocks, animIds, animRefs, issues, value => convertTrackQuaternion(source, value, options))
        addTrack(sections, selected('scale'), ids[boneIndex].scale, 2, 'SD3V', 'VEC3', durationMs, vectorBlocks, animIds, animRefs, issues)
        addFlagTrack(sections, selected('visibility'), ids[boneIndex].batching, durationMs, flagBlocks, animIds, animRefs, issues)
      }
      for (const value of materialTracks.filter(value => value.concurrent === concurrent)) {
        if (value.kind === 'scalar')
          addScalarTrack(sections, value.track, value.id, durationMs, scalarBlocks, animIds, animRefs, issues)
        else if (value.kind === 'vec2')
          addTrack(sections, value.track, value.id, 1, 'SD2V', 'VEC2', durationMs, vector2Blocks, animIds, animRefs, issues)
        else if (value.kind === 'vec3')
          addTrack(sections, value.track, value.id, 2, 'SD3V', 'VEC3', durationMs, vectorBlocks, animIds, animRefs, issues)
        else if (value.kind === 'color')
          addColorTrack(sections, value.track, value.id, durationMs, colorBlocks, animIds, animRefs, issues)
      }
      pointReference(sections, stc.anim_ids, appendM3Section(sections, 'U32_', 0, animIds))
      pointReference(sections, stc.anim_refs, appendM3Section(sections, 'U32_', 0, animRefs))
      stc.ref_count = animIds.length
      if (vector2Blocks.length > 0)
        pointReference(sections, stc.sd2v, appendM3Section(sections, 'SD2V', 0, vector2Blocks))
      if (vectorBlocks.length > 0)
        pointReference(sections, stc.sd3v, appendM3Section(sections, 'SD3V', 0, vectorBlocks))
      if (quaternionBlocks.length > 0)
        pointReference(sections, stc.sd4q, appendM3Section(sections, 'SD4Q', 0, quaternionBlocks))
      if (colorBlocks.length > 0)
        pointReference(sections, stc.sdcc, appendM3Section(sections, 'SDCC', 0, colorBlocks))
      if (scalarBlocks.length > 0)
        pointReference(sections, stc.sdr3, appendM3Section(sections, 'SDR3', 0, scalarBlocks))
      if (flagBlocks.length > 0)
        pointReference(sections, stc.sdfg, appendM3Section(sections, 'SDFG', 0, flagBlocks))
      stcIndices.push(stcRecords.length)
      stcRecords.push(stc)
      const sts = instance(sections, 'STS_', 0)
      pointReference(sections, sts.anim_ids, appendM3Section(sections, 'U32_', 0, animIds))
      stsRecords.push(sts)
    }
    stcIndices.push(...appendAnimationEventStcs(
      sections,
      animationEvents.filter(value => value.sequenceIndex === sequenceIndex),
      sequenceName,
      stcRecords,
      stsRecords,
    ))
    const pendingResidualTracks = mergeResidualAnimationTracks(
      sections,
      residualAnimationTracks.filter(value => value.sequenceIndex === sequenceIndex),
      stcIndices,
      stcRecords,
      stsRecords,
    )
    stcIndices.push(...appendResidualAnimationStcs(
      sections,
      pendingResidualTracks,
      sequenceName,
      stcRecords,
      stsRecords,
    ))
    const stg = instance(sections, 'STG_', 0)
    pointReference(sections, stg.name, appendString(sections, sequenceName))
    pointReference(sections, stg.stc_indices, appendM3Section(sections, 'U32_', 0, stcIndices))
    stgRecords.push(stg)
  })
  pointReference(sections, model.sequences, appendM3Section(sections, 'SEQS', 2, sequenceRecords))
  pointReference(
    sections,
    model.sequence_transformation_collections,
    appendM3Section(sections, 'STC_', 4, stcRecords),
  )
  pointReference(
    sections,
    model.sequence_transformation_groups,
    appendM3Section(sections, 'STG_', 0, stgRecords),
  )
  pointReference(sections, model.sts, appendM3Section(sections, 'STS_', 0, stsRecords))
}
function materialAnimationTracks(source, sequenceIndex) {
  const result = []
  for (const material of source.materials) {
    if ((material.presentation ?? material.metadata?.presentation) === 'screen-distortion') {
      for (const entry of material.standard?.parallaxHeight?.sequenceTracks ?? []) {
        if (entry.sequenceIndex !== sequenceIndex) continue
        result.push({
          id: animationId(`${material.name}:strength`),
          track: { ...entry.track, wrapSeconds: entry.wrapSeconds },
          concurrent: entry.concurrent === true,
          kind: 'scalar',
        })
      }
    }
    for (const [slot, layer] of Object.entries(material.standard?.layers ?? {})) {
      const parameters = [
        ['constantColor', 'color', 'color'],
        ['colorMultiply', 'multiply', 'scalar'],
        ['colorAdd', 'add', 'scalar'],
        ['alphaFactor', 'brightness', 'scalar'],
        ['uvOffset', 'offset', 'vec2'],
        ['uvAngle', 'angle', 'vec3'],
        ['uvTiling', 'tiling', 'vec2'],
        ['uvTriplanarOffset', 'triplanar-offset', 'vec3'],
        ['uvTriplanarScale', 'triplanar-scale', 'vec3'],
      ]
      for (const [field, suffix, kind] of parameters) {
        for (const entry of layer[field]?.sequenceTracks ?? []) {
          if (entry.sequenceIndex !== sequenceIndex) continue
          result.push({
            id: animationId(`${material.name}:${slot}:${suffix}`),
            track: { ...entry.track, wrapSeconds: entry.wrapSeconds },
            concurrent: entry.concurrent === true,
            kind,
          })
        }
      }
      for (const entry of layer.flipbook?.frame?.sequenceTracks ?? []) {
        if (entry.sequenceIndex === sequenceIndex) result.push({
          id: animationId(`${material.name}:${slot}:frame`),
          track: { ...entry.track, wrapSeconds: entry.wrapSeconds },
          concurrent: entry.concurrent === true,
          kind: 'scalar',
        })
      }
    }
  }
  const appendEffect = (entries, id, kind = 'scalar') => {
    for (const entry of entries ?? []) {
      if (entry.sequenceIndex !== sequenceIndex) continue
      result.push({
        id: animationId(id),
        track: { ...entry.track, wrapSeconds: entry.wrapSeconds },
        concurrent: entry.concurrent === true,
        kind,
      })
    }
  }
  const particleFields = {
    emissionRate: ['rate', 'scalar'], lifeSpan: ['lifespan', 'scalar'],
    speed: ['speed', 'scalar'], emitAngleX: ['angle-x', 'scalar'],
    emitAngleY: ['angle-y', 'scalar'], emitSpreadX: ['spread-x', 'scalar'],
    emitSpreadY: ['spread-y', 'scalar'], emitShapeRadius: ['shape-radius', 'scalar'],
    emitShapeSize: ['shape-size', 'vec3'], emitCount: ['emit-count', 'scalar'],
  }
  for (const [index, particle] of (source.effects?.particles ?? []).entries()) {
    for (const [field, [suffix, kind]] of Object.entries(particleFields))
      appendEffect(particle.sequenceAnimation?.[field], `particle:${index}:${suffix}`, kind)
  }
  const ribbonFields = {
    visibility: ['active', 'scalar'], lifeSpan: ['lifespan', 'scalar'],
    speed: ['speed', 'scalar'], pitch: ['pitch', 'scalar'], yaw: ['yaw', 'scalar'],
    spreadX: ['spread-x', 'scalar'], spreadY: ['spread-y', 'scalar'],
    maxLength: ['length', 'scalar'], color: ['color-base', 'color'],
    segmentColorStart: ['color-base', 'color'], segmentColorMiddle: ['color-mid', 'color'],
    segmentColorEnd: ['color-tip', 'color'],
  }
  for (const [index, ribbon] of (source.effects?.ribbons ?? []).entries()) {
    for (const [field, [suffix, kind]] of Object.entries(ribbonFields))
      appendEffect(ribbon.sequenceAnimation?.[field], `ribbon:${index}:${suffix}`, kind)
  }
  const unique = new Map()
  for (const value of result) {
    const key = `${value.id}:${value.concurrent}`
    if (!unique.has(key)) unique.set(key, value)
  }
  return [...unique.values()]
}
function trackEndMs(track, durationMs) {
  const seconds = track?.wrapSeconds
  if (seconds === undefined) return durationMs
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new TypeError('M3 animation wrapSeconds must be positive')
  return Math.max(1, Math.round(seconds * 1e3))
}
function addScalarTrack(sections, track, id, durationMs, blocks, animIds, animRefs, issues) {
  if (!track || track.keys.length === 0) return
  const endMs = trackEndMs(track, durationMs)
  const frames = []
  const keys = []
  for (const key of track.keys) {
    const value = key.vector[0]
    if (!Number.isFinite(key.frame) || !Number.isFinite(value)) {
      issues.push({
        severity: 'warning',
        code: 'm3-animation-key-invalid',
        message: 'Skipped an invalid scalar animation key.',
      })
      continue
    }
    frames.push(Math.max(0, Math.min(endMs, Math.round(key.frame * 1e3))))
    keys.push(value)
  }
  if (keys.length === 0) return
  const block = instance(sections, 'SDR3', 0)
  pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, frames))
  block.flags = track.lineType === 0 ? 0 : 1
  block.fend = endMs
  pointReference(sections, block.keys, appendM3Section(sections, 'REAL', 0, keys))
  animIds.push(id)
  animRefs.push((5 << 16) | (blocks.length & 65535))
  blocks.push(block)
}
/** A bone's batching is a flag (FlagAnimationReference, SDFG keys): on while the value is above
 * zero. It toggles, so it is stepped whatever the source interpolation. */
function addFlagTrack(sections, track, id, durationMs, blocks, animIds, animRefs, issues) {
  if (!track || track.keys.length === 0) return
  const endMs = trackEndMs(track, durationMs)
  const frames = []
  const keys = []
  for (const key of track.keys) {
    const value = key.vector[0]
    if (!Number.isFinite(key.frame) || !Number.isFinite(value)) {
      issues.push({
        severity: 'warning',
        code: 'm3-animation-key-invalid',
        message: 'Skipped an invalid flag animation key.',
      })
      continue
    }
    frames.push(Math.max(0, Math.min(endMs, Math.round(key.frame * 1e3))))
    keys.push(value > 0 ? 1 : 0)
  }
  if (keys.length === 0) return
  const block = instance(sections, 'SDFG', 0)
  pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, frames))
  block.flags = 0
  block.fend = endMs
  pointReference(sections, block.keys, appendM3Section(sections, 'FLAG', 0, keys))
  animIds.push(id)
  animRefs.push((11 << 16) | (blocks.length & 65535))
  blocks.push(block)
}
function addColorTrack(sections, track, id, durationMs, blocks, animIds, animRefs, issues) {
  if (!track || track.keys.length === 0) return
  const endMs = trackEndMs(track, durationMs)
  const frames = []
  const keys = []
  for (const key of track.keys) {
    if (key.vector.length < 4 || !Number.isFinite(key.frame) || key.vector.some(value => !Number.isFinite(value))) {
      issues.push({ severity: 'warning', code: 'm3-animation-key-invalid', message: 'Skipped an invalid SDCC animation key.' })
      continue
    }
    frames.push(Math.max(0, Math.min(endMs, Math.round(key.frame * 1e3))))
    const value = instance(sections, 'COL', 0)
    assignColorComponents(value, key.vector)
    keys.push(value)
  }
  if (keys.length === 0) return
  const block = instance(sections, 'SDCC', 0)
  pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, frames))
  block.flags = track.lineType === 0 ? 0 : 1
  block.fend = endMs
  pointReference(sections, block.keys, appendM3Section(sections, 'COL', 0, keys))
  animIds.push(id)
  animRefs.push((4 << 16) | (blocks.length & 65535))
  blocks.push(block)
}
function addTrack(
  sections,
  track,
  id,
  fieldIndex,
  blockTag,
  keyTag,
  durationMs,
  blocks,
  animIds,
  animRefs,
  issues,
  transform,
) {
  if (!track || track.keys.length === 0) return
  const vectorSize = blockTag === 'SD4Q' ? 4 : blockTag === 'SD2V' ? 2 : 3
  const endMs = trackEndMs(track, durationMs)
  const frames = []
  const keys = []
  for (const key of track.keys) {
    if (key.vector.length < vectorSize || !Number.isFinite(key.frame)) {
      issues.push({
        severity: 'warning',
        code: 'm3-animation-key-invalid',
        message: `Skipped an invalid ${blockTag} animation key.`,
      })
      continue
    }
    frames.push(Math.max(0, Math.min(endMs, Math.round(key.frame * 1e3))))
    const value = instance(sections, keyTag, 0)
    assignVector(value, transform ? transform(key.vector) : key.vector, vectorSize)
    keys.push(value)
  }
  if (keys.length === 0) return
  const block = instance(sections, blockTag, 0)
  pointReference(sections, block.frames, appendM3Section(sections, 'I32_', 0, frames))
  block.flags = track.lineType === 0 ? 0 : 1
  block.fend = endMs
  pointReference(sections, block.keys, appendM3Section(sections, keyTag, 0, keys))
  animIds.push(id)
  animRefs.push(((fieldIndex & 65535) << 16) | (blocks.length & 65535))
  blocks.push(block)
}
function buildMaterialSections(sections, model, sourceMaterials, meshes, issues) {
  if (sourceMaterials.length === 0 && meshes.length === 0) return
  const maximumMaterial = meshes.reduce((maximum, mesh) => Math.max(maximum, mesh.materialIndex), 0)
  const materials =
    sourceMaterials.length > 0
      ? [...sourceMaterials]
      : [{ name: 'Default', layers: [], baseColor: [0.8, 0.8, 0.8, 1] }]
  while (materials.length <= maximumMaterial)
    materials.push({ name: `Material_${materials.length}`, layers: [] })
  const standardRecords = []
  const compositeRecords = []
  const displacementRecords = []
  const references = materials.map(() => instance(sections, 'MATM', 0))
  const createStandardRecord = (material, typed, name) => {
    const standard = instance(sections, 'MAT_', MATERIAL_VERSION)
    pointReference(sections, standard.name, appendString(sections, name))
    standard.flags = materialFlags({ ...material, standard: typed })
    standard.additional_flags =
      typed?.sourceAdditionalFlags ??
      (typed ? (typed.usesVertexColor ? 4 : 0) | (typed.usesVertexAlpha ? 8 : 0) : 0)
    standard.material_class = typed?.materialClass ?? 0
    standard.blend_mode = typed?.blendMode ?? finiteNumber(material.metadata?.['blendMode']) ?? 0
    standard.priority = typed?.priority ?? finiteNumber(material.metadata?.['priority']) ?? 0
    standard.specularity = typed?.specularity ?? 0
    standard.alpha_test_threshold = Math.round(clamp01(typed?.alphaTestThreshold ?? 0) * 255)
    standard.hdr_spec = typed?.specMult ?? 1
    standard.hdr_emis = typed?.emisMult ?? 1
    standard.hdr_envi_const = typed?.environmentMultipliers?.[0] ?? 1
    standard.hdr_envi_diff = typed?.environmentMultipliers?.[1] ?? 0
    standard.hdr_envi_spec = typed?.environmentMultipliers?.[2] ?? 0
    standard.spec_mode = typed?.specMode ?? 0
    standard.blend_mode_layer = typed?.layers.diffuse?.op ?? typed?.layers.decal?.op ?? 2
    standard.blend_mode_emis1 = typed?.layers.emissive1?.op ?? 2
    standard.blend_mode_emis2 = typed?.layers.emissive2?.op ?? 2
    setAnimationField(standard, 'parallax_height', `${name}:parallax-height`, [
      typed?.parallaxHeight?.value ?? 0,
    ])
    if (typed?.normalBlendFactors && standard.normal_blend_mask_factor) {
      const factors = typed.normalBlendFactors.map((factor, factorIndex) => {
        const record = instance(sections, 'SR32', 0)
        setAnimationField(record, 'value', `${name}:normal-blend:${factorIndex}`, [factor.value])
        return record
      })
      pointReference(
        sections,
        standard.normal_blend_mask_factor,
        appendM3Section(sections, 'SR32', 0, factors),
      )
    }
    for (const [slot, field] of LAYER_FIELDS) {
      const layer = typed?.layers[slot] ?? legacyLayer(material, slot)
      const layerRecord = createLayer(sections, material, layer, slot)
      pointReference(
        sections,
        standard[field],
        appendM3Section(sections, 'LAYR', LAYER_VERSION, [layerRecord]),
      )
    }
    return standard
  }
  materials.forEach((material, materialIndex) => {
    assertM3MaterialWritable(material.metadata)
    const reference = references[materialIndex]
    const presentation = material.presentation ?? material.metadata?.presentation
    if (presentation !== undefined) {
      if (presentation !== 'screen-distortion' || material.composite)
        throw new TypeError(`M3 writer does not support material presentation ${presentation}`)
      if (Object.keys(material.standard?.layers ?? {}).some(slot => slot !== 'normal' && slot !== 'height'))
        throw new TypeError('M3 displacement materials support only normal and height layers')
      const displacement = instanceLatest(sections, 'DIS_')
      pointReference(sections, displacement.name, appendString(sections, material.name))
      displacement.flags = material.metadata?.flags ?? 0
      displacement.priority = material.standard?.priority ?? 0
      setAnimationField(displacement, 'strength_factor', `${material.name}:strength`, [
        material.standard?.parallaxHeight?.value ?? 0,
      ])
      for (const [slot, field] of [['normal', 'layer_norm'], ['height', 'layer_strength']]) {
        const layer = createLayer(sections, material, material.standard?.layers[slot], slot)
        pointReference(sections, displacement[field], appendM3Section(sections, 'LAYR', LAYER_VERSION, [layer]))
      }
      reference.type = 2
      reference.material_index = displacementRecords.length
      displacementRecords.push(displacement)
      return
    }
    if (material.composite) {
      const composite = instanceLatest(sections, 'CMP_')
      pointReference(
        sections,
        composite.name,
        appendString(sections, material.name || `Composite_${materialIndex}`),
      )
      composite.priority = material.composite.priority
      const passRecords = material.composite.passes.map((pass, passIndex) => {
        const nestedMaterial = {
          ...material,
          name: `${material.name || `Composite_${materialIndex}`}_Pass_${passIndex}`,
          standard: pass.material,
          composite: void 0,
        }
        const standardIndex2 = standardRecords.length
        standardRecords.push(
          createStandardRecord(nestedMaterial, pass.material, nestedMaterial.name),
        )
        const passReferenceIndex = references.length
        const passReference = instance(sections, 'MATM', 0)
        passReference.type = 1
        passReference.material_index = standardIndex2
        references.push(passReference)
        const passRecord = instanceLatest(sections, 'CMS_')
        passRecord.material_reference_index = passReferenceIndex
        setAnimationField(passRecord, 'alpha_factor', `${nestedMaterial.name}:alpha`, [
          pass.alphaFactor.value,
        ])
        return passRecord
      })
      pointReference(
        sections,
        composite.sections,
        appendM3Section(sections, 'CMS_', latestVersion(sections, 'CMS_'), passRecords),
      )
      reference.type = 3
      reference.material_index = compositeRecords.length
      compositeRecords.push(composite)
      return
    }
    const typed = material.standard
    const standardIndex = standardRecords.length
    standardRecords.push(
      createStandardRecord(material, typed, material.name || `Material_${materialIndex}`),
    )
    if (typed?.layers.emissiveMask) {
      issues.push({
        severity: 'info',
        code: 'm3-emissive-mask-approximated',
        message: `Material "${material.name}" emissiveMask has no direct MAT_ slot and was omitted.`,
      })
    }
    if (typed?.layers.teamColorMask) {
      // StarCraft II reads its team-colour mask from the diffuse alpha, so the common slot for a
      // separate mask texture has no MAT_ field to land in.
      issues.push({
        severity: 'info',
        code: 'm3-team-color-mask-omitted',
        message: `Material "${material.name}" teamColorMask has no direct MAT_ slot and was omitted; the material draws without player colour.`,
      })
    }
    reference.type = 1
    reference.material_index = standardIndex
  })
  pointReference(
    sections,
    model.material_references,
    appendM3Section(sections, 'MATM', 0, references),
  )
  pointReference(
    sections,
    model.materials_standard,
    appendM3Section(sections, 'MAT_', MATERIAL_VERSION, standardRecords),
  )
  if (compositeRecords.length > 0 && model.materials_composite) {
    pointReference(
      sections,
      model.materials_composite,
      appendM3Section(sections, 'CMP_', latestVersion(sections, 'CMP_'), compositeRecords),
    )
  }
  if (displacementRecords.length > 0) {
    pointReference(sections, model.materials_displacement,
      appendM3Section(sections, 'DIS_', latestVersion(sections, 'DIS_'), displacementRecords))
  }
}
function createLayer(sections, material, layer, slot) {
  const record = instance(sections, 'LAYR', LAYER_VERSION)
  const texturePath = layer ? (layer.texturePath ?? '') : (legacyLayerPath(material, slot) ?? '')
  pointReference(sections, record.color_bitmap, appendString(sections, texturePath))
  record.flags = layer
    ? (layer.wrapX ? 4 : 0) |
      (layer.wrapY ? 8 : 0) |
      (layer.invert ? 16 : 0) |
      (layer.clampResult ? 32 : 0) |
      (layer.colorAdd ? 64 : 0) |
      (layer.colorMultiply ? 128 : 0) |
      (texturePath ? 0 : 1024) |
      (layer.fresnel?.transformMode ? 16384 : 0) |
      (layer.fresnel?.transformMode === 2 ? 32768 : 0) |
      (layer.fresnel?.localTransform ? 65536 : 0) |
      (layer.fresnel?.doNotMirror ? 131072 : 0)
    : texturePath
      ? 12
      : 0
  record.uv_source = layer?.uvSource ?? 0
  record.color_channels = layer?.channels ?? 0
  setAnimationReference(
    record.color_value,
    animationId(`${material.name}:${slot}:color`),
    layer?.constantColor?.value ?? material.baseColor ?? [1, 1, 1, 1],
    true,
  )
  setAnimationReference(record.color_multiply, animationId(`${material.name}:${slot}:multiply`), [
    layer?.colorMultiply?.value ?? 1,
  ])
  setAnimationReference(record.color_add, animationId(`${material.name}:${slot}:add`), [
    layer?.colorAdd?.value ?? 0,
  ])
  setAnimationReference(
    record.color_brightness,
    animationId(`${material.name}:${slot}:brightness`),
    [layer?.alphaFactor?.value ?? 1],
  )
  setAnimationReference(
    record.uv_offset,
    animationId(`${material.name}:${slot}:offset`),
    layer?.uvOffset?.value ?? [0, 0],
  )
  setAnimationReference(
    record.uv_angle,
    animationId(`${material.name}:${slot}:angle`),
    layer?.uvAngle?.value ?? [0, 0, 0],
  )
  setAnimationReference(
    record.uv_tiling,
    animationId(`${material.name}:${slot}:tiling`),
    layer?.uvTiling?.value ?? [1, 1],
  )
  setAnimationField(
    record,
    'uv_triplanar_offset',
    `${material.name}:${slot}:triplanar-offset`,
    layer?.uvTriplanarOffset?.value ?? [0, 0, 0],
  )
  setAnimationField(
    record,
    'uv_triplanar_scale',
    `${material.name}:${slot}:triplanar-scale`,
    layer?.uvTriplanarScale?.value ?? [1, 1, 1],
  )
  record.uv_flipbook_rows = layer?.flipbook?.rows ?? 0
  record.uv_flipbook_cols = layer?.flipbook?.cols ?? 0
  setAnimationReference(record.uv_flipbook_frame, animationId(`${material.name}:${slot}:frame`), [
    layer?.flipbook?.frame.value ?? 0,
  ])
  const frameTracks = layer?.flipbook?.frame.sequenceTracks ?? []
  if (frameTracks.length > 0) {
    const lineTypes = new Set(frameTracks.map(value => value.track.lineType))
    if (lineTypes.size !== 1)
      throw new TypeError('M3 flipbook tracks require one interpolation mode')
    record.uv_flipbook_frame.header.interpolation = lineTypes.has(0) ? 0 : 1
  }
  record.fresnel_type = layer?.fresnel?.mode ?? 0
  record.fresnel_exponent = layer?.fresnel?.exponent ?? 4
  record.fresnel_min = layer?.fresnel?.min ?? 0
  record.fresnel_max_offset = layer?.fresnel?.maxOffset ?? 1
  if (layer?.fresnel) {
    assignVector(record.fresnel_translation, layer.fresnel.translation, 3)
    assignVector(record.fresnel_invert_mask, layer.fresnel.invertMask, 3)
    record.fresnel_yaw = layer.fresnel.rotation[0]
    record.fresnel_pitch = layer.fresnel.rotation[1]
  }
  return record
}
function buildSceneFeatureSections(sections, model, source, issues) {
  buildAttachmentSections(sections, model, metadataObjects(source, 'm3AttachmentPoints'))
  buildLightSections(sections, model, metadataObjects(source, 'm3Lights'))
  buildCameraSections(sections, model, metadataObjects(source, 'm3Cameras'))
  buildHitVolumeSections(sections, model, source.metadata?.['m3HitVolumes'])
  buildParticleSections(sections, model, source)
  buildRibbonSections(sections, model, source)
  buildProjectorSections(sections, model, source)
  buildForceSections(sections, model, source)
  buildWarpSections(sections, model, source)
  buildBillboardSections(sections, model, metadataObjects(source, 'm3Billboards'))
  buildShadowboxSections(sections, model, metadataObjects(source, 'm3Shadowboxes'))
  buildPhysicsSections(sections, model, source, issues)
  buildIkSections(sections, model, metadataObjects(source, 'm3Ik'))
  buildTurretSections(sections, model, metadataObjects(source, 'm3Turrets'))
}
function buildAttachmentSections(sections, model, attachments) {
  const records = attachments.map((attachment, index) => {
    const record = instanceLatest(sections, 'ATT_')
    record.unknown00 = -1
    record.bone = nonNegativeInteger(attachment['boneIndex'], 0)
    pointReference(
      sections,
      record.name,
      appendString(sections, stringValue(attachment['name'], `Attachment_${index}`)),
    )
    return record
  })
  pointModelRecords(sections, model, 'attachment_points', 'ATT_', records)
  if (records.length > 0) {
    pointModelNumbers(
      sections,
      model,
      'attachment_points_addon',
      'U16_',
      records.map((_, index) => index),
    )
  }
}
function buildLightSections(sections, model, lights) {
  const records = lights.map((light, index) => {
    const record = instanceLatest(sections, 'LITE')
    record.shape = nonNegativeInteger(light['type'], 1)
    record.bone = nonNegativeInteger(light['boneIndex'], 0)
    record.flags = nonNegativeInteger(light['flags'], 0)
    setAnimationField(record, 'color', `light:${index}:color`, tuple(light['color'], 3, 1))
    setAnimationField(record, 'intensity', `light:${index}:intensity`, [
      numberValue(light['intensity'], 1),
    ])
    setAnimationField(
      record,
      'spec_color',
      `light:${index}:spec-color`,
      tuple(light['specularColor'], 3, 1),
    )
    setAnimationField(record, 'spec_intensity', `light:${index}:spec-intensity`, [
      numberValue(light['specularIntensity'], 1),
    ])
    setAnimationField(record, 'decay', `light:${index}:decay`, [numberValue(light['decay'], 1)])
    record.attenuation_far = numberValue(light['attenuationFar'], 100)
    setAnimationField(record, 'attenuation_near', `light:${index}:attenuation-near`, [
      numberValue(light['attenuationNear'], 0),
    ])
    setAnimationField(record, 'hotspot', `light:${index}:hotspot`, [
      numberValue(light['hotspot'], 0),
    ])
    setAnimationField(record, 'falloff', `light:${index}:falloff`, [
      numberValue(light['falloff'], 0),
    ])
    return record
  })
  pointModelRecords(sections, model, 'lights', 'LITE', records)
}
function buildCameraSections(sections, model, cameras) {
  const records = cameras.map((camera, index) => {
    const record = instanceLatest(sections, 'CAM_')
    record.bone = nonNegativeInteger(camera['boneIndex'], 0)
    pointReference(
      sections,
      record.name,
      appendString(sections, stringValue(camera['name'], `Camera_${index}`)),
    )
    setAnimationField(record, 'field_of_view', `camera:${index}:fov`, [
      numberValue(camera['fieldOfView'], 0.5),
    ])
    record.use_vertical_fov = camera['useVerticalFov'] === false ? 0 : 1
    record.depth_of_field_type = nonNegativeInteger(camera['dofType'], 3)
    setAnimationField(record, 'far_clip', `camera:${index}:far`, [
      numberValue(camera['farClip'], 1e4),
    ])
    setAnimationField(record, 'near_clip', `camera:${index}:near`, [
      numberValue(camera['nearClip'], 0.1),
    ])
    setAnimationField(record, 'shadow_clip_distance', `camera:${index}:shadow`, [
      numberValue(camera['shadowClipDistance'] ?? camera['clip2'], 10),
    ])
    setAnimationField(record, 'focus_distance', `camera:${index}:focus`, [
      numberValue(camera['focusDistance'] ?? camera['focalDepth'], 2),
    ])
    setAnimationField(record, 'far_focus_range', `camera:${index}:far-focus`, [
      numberValue(camera['farFocusRange'] ?? camera['falloffStart'], 1),
    ])
    setAnimationField(record, 'near_focus_range', `camera:${index}:near-focus`, [
      numberValue(camera['nearFocusRange'] ?? camera['falloffEnd'], 2),
    ])
    setAnimationField(record, 'near_falloff_start', `camera:${index}:near-falloff-start`, [
      numberValue(camera['nearFalloffStart'], 0),
    ])
    setAnimationField(record, 'near_falloff_end', `camera:${index}:near-falloff-end`, [
      numberValue(camera['nearFalloffEnd'], 0),
    ])
    setAnimationField(record, 'depth_of_field', `camera:${index}:dof`, [
      numberValue(camera['depthOfField'], 0.5),
    ])
    setAnimationField(record, 'bokeh_f_stop', `camera:${index}:bokeh-stop`, [
      numberValue(camera['bokehFStop'], 0),
    ])
    setAnimationField(record, 'bokeh_max_coc_diameter', `camera:${index}:bokeh-coc`, [
      numberValue(camera['bokehMaxCoCDiameter'], 0),
    ])
    return record
  })
  pointModelRecords(sections, model, 'cameras', 'CAM_', records)
  if (records.length > 0)
    pointModelNumbers(
      sections,
      model,
      'cameras_addon',
      'U16_',
      records.map((_, index) => index),
    )
}
function buildHitVolumeSections(sections, model, value) {
  const source = asRecord(value)
  const tight = asRecord(source?.['tight'])
  if (tight && isStructureRecord(model.hittest_tight))
    fillHitVolume(sections, model.hittest_tight, tight, false)
  const hittests = objectArray(source?.['hittests'])
  const hitRecords = hittests.map(hit => {
    const record = instanceLatest(sections, 'SSGS')
    fillHitVolume(sections, record, hit, false)
    return record
  })
  pointModelRecords(sections, model, 'hittests', 'SSGS', hitRecords)
  const attachmentVolumes = objectArray(source?.['attachmentVolumes'])
  const attachmentRecords = attachmentVolumes.map(hit => {
    const record = instanceLatest(sections, 'ATVL')
    fillHitVolume(sections, record, hit, true)
    return record
  })
  pointModelRecords(sections, model, 'attachment_volumes', 'ATVL', attachmentRecords)
}
function fillHitVolume(sections, record, source, attachment) {
  record.shape = nonNegativeInteger(source['shape'], 0)
  record[attachment ? 'bone0' : 'bone'] = nonNegativeInteger(source['boneIndex'], 0)
  if (attachment) {
    record.bone1 = record.bone0
    record.bone2 = record.bone0
  } else {
    record.bone_fb = 0
  }
  assignMatrixArray(record.matrix, tuple(source['matrix4'], 16, 0, identityMatrix()))
  record.size0 = numberValue(source['size0'], 1)
  record.size1 = numberValue(source['size1'], 1)
  record.size2 = numberValue(source['size2'], 1)
  if (attachment && record.shape === 4) {
    const vertices = tupleArray(source['positions'], 3)
    const indices = numericArray(source['indices'])
    if (
      vertices.length === 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0 ||
      indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= vertices.length || index > 0xffff)
    ) throw new TypeError('M3 attachment mesh geometry is invalid')
    const vertexRecords = vertices.map(vertex => {
      const value = instance(sections, 'VEC3', 0)
      assignVector(value, vertex, 3)
      return value
    })
    pointReference(
      sections,
      record.vertices,
      appendM3Section(sections, 'VEC3', 0, vertexRecords),
    )
    pointReference(
      sections,
      record.face_data,
      appendM3Section(sections, 'U16_', 0, indices),
    )
  }
}
function buildParticleSections(sections, model, source) {
  const shapeCodes = {
    point: 0,
    plane: 1,
    sphere: 2,
    box: 3,
    cylinder: 4,
    disc: 5,
    mesh: 6,
    spline: 7,
  }
  const typeCodes = {
    billboard: 0,
    tail: 1,
    'face-travel-direction': 2,
    'face-world-direction': 3,
    'single-axis': 4,
    'terrain-oriented': 5,
    'terrain-direction-oriented': 6,
    'emitter-oriented': 7,
    'physics-oriented': 8,
    pinned: 9,
    trail: 10,
  }
  const records = source.effects.particles.map((particle, index) => {
    const record = instanceLatest(sections, 'PAR_')
    record.bone = Math.max(0, particle.boneIndex)
    record.material_reference_index = Math.max(0, particle.materialIndex)
    let additionalFlags = 0
    if (particle.randomizeSpeed) additionalFlags |= 1
    if (particle.randomizeLifeSpan) additionalFlags |= 2
    if (particle.randomizeMass) additionalFlags |= 4
    if (!particle.modelSpace) additionalFlags |= 8
    record.additional_flags = additionalFlags
    setAnimationField(record, 'emit_speed', `particle:${index}:speed`, [particle.speed ?? 1])
    setAnimationField(record, 'emit_speed_random', `particle:${index}:speed-random`, [
      particle.speedRandom ?? particle.speed ?? 1,
    ])
    setAnimationField(record, 'emit_angle_x', `particle:${index}:angle-x`, [
      particle.emitAngleX ?? 0,
    ])
    setAnimationField(record, 'emit_angle_y', `particle:${index}:angle-y`, [
      particle.emitAngleY ?? 0,
    ])
    setAnimationField(record, 'emit_spread_x', `particle:${index}:spread-x`, [
      particle.emitSpreadX ?? particle.latitude ?? 0,
    ])
    setAnimationField(record, 'emit_spread_y', `particle:${index}:spread-y`, [
      particle.emitSpreadY ?? particle.latitude ?? 0,
    ])
    setAnimationField(record, 'lifespan', `particle:${index}:lifespan`, [particle.lifeSpan ?? 1])
    setAnimationField(record, 'lifespan_random', `particle:${index}:lifespan-random`, [
      particle.lifeSpanRandom ?? particle.lifeSpan ?? 1,
    ])
    record.gravity = particle.gravity ?? 0
    record.drag = particle.drag ?? 0
    record.mass = particle.mass ?? 1
    record.mass2 = particle.massRandom ?? particle.mass ?? 1
    record.local_forces = particle.localForceChannels ?? 0
    record.world_forces = particle.worldForceChannels ?? 0
    record.local_forces_fb = particle.feedbackLocalForceChannels ?? 0
    record.world_forces_fb = particle.feedbackWorldForceChannels ?? 0
    record.world_forces_mass_mult = particle.worldForceMassMultiplier ?? 1
    record.noise_amplitude = particle.noiseAmplitude ?? 0
    record.noise_frequency = particle.noiseFrequency ?? 0
    record.noise_cohesion = particle.noiseCohesion ?? 0
    record.noise_edge = particle.noiseEdge ?? 0
    record.emit_max = particle.maxParticles ?? 100
    setAnimationField(record, 'emit_rate', `particle:${index}:rate`, [particle.emissionRate ?? 10])
    const shape = particle.emitShape ?? 'point'
    record.emit_shape = shapeCodes[shape.toLowerCase()] ?? nonNegativeInteger(shape, 0)
    const shapeSize = particle.emitShapeSize ?? [
      particle.width ?? 1,
      particle.length ?? 1,
      particle.width ?? 1,
    ]
    setAnimationField(record, 'emit_shape_size', `particle:${index}:shape-size`, shapeSize)
    setAnimationField(
      record,
      'emit_shape_size_cutout',
      `particle:${index}:shape-cutout-size`,
      particle.emitShapeCutoutSize ?? [0, 0, 0],
    )
    setAnimationField(record, 'emit_shape_radius', `particle:${index}:shape-radius`, [
      particle.emitShapeRadius ?? 1,
    ])
    setAnimationField(record, 'emit_shape_radius_cutout', `particle:${index}:shape-cutout-radius`, [
      particle.emitShapeCutoutRadius ?? 0,
    ])
    record.emit_type = particle.squirt ? 1 : 0
    const size = particle.lifecycleSize
    setAnimationField(
      record,
      'size',
      `particle:${index}:size`,
      size
        ? [size.start[0], size.middle[0], size.end[0]]
        : (particle.particleScaling ?? [
            particle.width ?? 0.1,
            particle.width ?? 0.1,
            particle.width ?? 0.1,
          ]),
    )
    record.size_anim_mid = size?.timeMiddle ?? particle.timeMiddle ?? 0.5
    record.size_randomize = particle.randomizeSize ? 1 : 0
    const randomSize = particle.lifecycleSizeRandom
    setAnimationField(
      record,
      'size2',
      `particle:${index}:size-random`,
      randomSize
        ? [randomSize.start[0], randomSize.middle[0], randomSize.end[0]]
        : size
          ? [size.start[0], size.middle[0], size.end[0]]
          : [0.1, 0.1, 0.1],
    )
    setAnimationField(
      record,
      'rotation',
      `particle:${index}:rotation`,
      lifecycleCurve(particle.lifecycleRotation),
    )
    setAnimationField(
      record,
      'rotation2',
      `particle:${index}:rotation-random`,
      lifecycleCurve(particle.lifecycleRotationRandom ?? particle.lifecycleRotation),
    )
    record.rotation_randomize = particle.randomizeRotation ? 1 : 0
    record.rotation_flags =
      (particle.rotationRelative ? 2 : 0) | (particle.rotationAlwaysSet ? 4 : 0)
    const colors = particle.segmentColors ?? [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]
    const alphas = particle.segmentAlphas ?? [
      particle.alpha ?? 1,
      particle.alpha ?? 1,
      particle.alpha ?? 1,
    ]
    setAnimationField(
      record,
      'color_init',
      `particle:${index}:color-init`,
      [...(colors[0] ?? [1, 1, 1]), alphas[0]],
      true,
    )
    setAnimationField(
      record,
      'color_mid',
      `particle:${index}:color-mid`,
      [...(colors[1] ?? colors[0] ?? [1, 1, 1]), alphas[1]],
      true,
    )
    setAnimationField(
      record,
      'color_end',
      `particle:${index}:color-end`,
      [...(colors[2] ?? colors[1] ?? [1, 1, 1]), alphas[2]],
      true,
    )
    record.color_anim_mid = particle.timeMiddle ?? 0.5
    record.color_randomize = particle.randomizeColor ? 1 : 0
    record.alpha_randomize = particle.randomizeAlpha ? 1 : 0
    setAnimationField(record, 'emit_count', `particle:${index}:emit-count`, [
      particle.emitCount ?? 0,
    ])
    record.uv_flipbook_rows = particle.rows ?? 0
    record.uv_flipbook_cols = particle.columns ?? 0
    record.bounce = particle.bounce ?? 0
    record.friction = particle.friction ?? 0
    record.collide_system = particle.collisionEmitterIndex ?? -1
    record.collide_emit_min = particle.collisionEmitMin ?? 0
    record.collide_emit_max = particle.collisionEmitMax ?? 0
    record.collide_emit_chance = particle.collisionEmitChance ?? 0
    record.collide_emit_energy = particle.collisionEmitEnergy ?? 0
    record.collide_events_cull = particle.maxCollisionEvents ?? 0
    record.particle_type = typeCodes[particle.orientationMode ?? 'billboard'] ?? 0
    record.instance_tail = particle.tailLength ?? 0
    setAnimationField(record, 'parent_velocity', `particle:${index}:parent-velocity`, [
      particle.parentVelocity ?? 0,
    ])
    record.wind_multiplier = particle.windMultiplier ?? 1
    record.trail_system = particle.trailEmitterIndex ?? -1
    record.trail_chance = particle.trailEmitChance ?? 0
    setAnimationField(record, 'trail_rate', `particle:${index}:trail-rate`, [
      particle.trailEmitRate ?? 0,
    ])
    record.collide_splat = particle.collisionProjectorIndex ?? -1
    record.collide_splat_chance = particle.collisionProjectorChance ?? 0
    record.ribbon_link_index = particle.bounceRibbonEmitterIndex ?? -1
    record.spawn_ribbon_on_bounce_chance = particle.bounceRibbonChance ?? 0
    record.flags =
      (particle.emitShapeCutout ? 1 : 0) |
      (particle.collideTerrain ? 2 : 0) |
      (particle.collideObjects ? 4 : 0)
    writeVariations(record, particle, `particle:${index}`)
    return record
  })
  pointModelRecords(sections, model, 'particle_systems', 'PAR_', records)
}
function buildRibbonSections(sections, model, source) {
  const typeCodes = { billboard: 0, planar: 1, cylinder: 2, star: 3 }
  const records = source.effects.ribbons.map((ribbon, index) => {
    const record = instanceLatest(sections, 'RIB_')
    record.bone = Math.max(0, ribbon.boneIndex)
    record.bone_fb = 0
    record.material_reference_index = Math.max(0, ribbon.materialIndex)
    record.additional_flags =
      (!ribbon.modelSpace ? 8 : 0) |
      (ribbon.randomizeLifeSpan ? 2 : 0) |
      (ribbon.randomizeSpeed ? 1 : 0) |
      (ribbon.randomizeMass ? 4 : 0)
    setAnimationField(record, 'speed', `ribbon:${index}:speed`, [ribbon.speed ?? 0])
    setAnimationField(record, 'speed2', `ribbon:${index}:speed-random`, [
      ribbon.speedRandom ?? ribbon.speed ?? 0,
    ])
    setAnimationField(record, 'pitch', `ribbon:${index}:pitch`, [ribbon.pitch ?? 0])
    setAnimationField(record, 'yaw', `ribbon:${index}:yaw`, [ribbon.yaw ?? 0])
    setAnimationField(record, 'spread_x', `ribbon:${index}:spread-x`, [ribbon.spreadX ?? 0])
    setAnimationField(record, 'spread_y', `ribbon:${index}:spread-y`, [ribbon.spreadY ?? 0])
    setAnimationField(record, 'lifespan', `ribbon:${index}:lifespan`, [ribbon.lifeSpan ?? 1])
    setAnimationField(record, 'lifespan2', `ribbon:${index}:lifespan-random`, [
      ribbon.lifeSpanRandom ?? ribbon.lifeSpan ?? 1,
    ])
    record.gravity_x = ribbon.gravity?.[0] ?? 0
    record.gravity_y = ribbon.gravity?.[1] ?? 0
    record.gravity = ribbon.gravity?.[2] ?? 0
    record.drag = ribbon.drag ?? 0
    record.mass = ribbon.mass ?? 1
    record.mass2 = ribbon.massRandom ?? ribbon.mass ?? 1
    record.local_forces = ribbon.localForceChannels ?? 0
    record.world_forces = ribbon.worldForceChannels ?? 0
    record.local_forces_fb = ribbon.feedbackLocalForceChannels ?? 0
    record.world_forces_fb = ribbon.feedbackWorldForceChannels ?? 0
    record.world_forces_mass_mult = ribbon.worldForceMassMultiplier ?? 1
    record.noise_amplitude = ribbon.noiseAmplitude ?? 0
    record.noise_frequency = ribbon.noiseFrequency ?? 0
    record.noise_cohesion = ribbon.noiseCohesion ?? 0
    record.noise_edge = ribbon.noiseEdge ?? 0
    record.ribbon_type = typeCodes[ribbon.ribbonType ?? 'billboard']
    record.divisions = ribbon.divisions ?? 8
    record.sides = ribbon.sides ?? 1
    record.star_ratio = ribbon.starRatio ?? 0.5
    setAnimationField(record, 'length', `ribbon:${index}:length`, [ribbon.maxLength ?? 0.2])
    const widths = ribbon.widths ?? [
      (ribbon.heightAbove ?? 0.5) + (ribbon.heightBelow ?? 0.5),
      (ribbon.heightAbove ?? 0.5) + (ribbon.heightBelow ?? 0.5),
      (ribbon.heightAbove ?? 0.5) + (ribbon.heightBelow ?? 0.5),
    ]
    setAnimationField(record, 'scale', `ribbon:${index}:scale`, widths)
    record.scale_anim_mid_time = ribbon.widthTimeMiddle ?? 0.5
    const colors = ribbon.segmentColors ?? [
      ribbon.color ?? [1, 1, 1],
      ribbon.color ?? [1, 1, 1],
      ribbon.color ?? [1, 1, 1],
    ]
    const alphas = ribbon.segmentAlphas ?? [ribbon.alpha ?? 1, ribbon.alpha ?? 1, ribbon.alpha ?? 1]
    setAnimationField(
      record,
      'color_base',
      `ribbon:${index}:color-base`,
      [...colors[0], alphas[0]],
      true,
    )
    setAnimationField(
      record,
      'color_mid',
      `ribbon:${index}:color-mid`,
      [...colors[1], alphas[1]],
      true,
    )
    setAnimationField(
      record,
      'color_tip',
      `ribbon:${index}:color-tip`,
      [...colors[2], alphas[2]],
      true,
    )
    record.color_anim_mid_time = ribbon.colorTimeMiddle ?? 0.5
    setAnimationField(record, 'active', `ribbon:${index}:active`, [ribbon.visibility ?? 1])
    record.flags =
      (ribbon.collideTerrain ? 2 : 0) |
      (ribbon.collideObjects ? 4 : 0) |
      (ribbon.lengthAndTime ? 8 : 0)
    record.friction = ribbon.friction ?? 0
    record.bounce = ribbon.bounce ?? 0
    setAnimationField(record, 'parent_velocity', `ribbon:${index}:parent-velocity`, [
      ribbon.parentVelocity ?? 0,
    ])
    writeVariations(record, ribbon, `ribbon:${index}`)
    return record
  })
  pointModelRecords(sections, model, 'ribbons', 'RIB_', records)
}
function buildProjectorSections(sections, model, source) {
  const records = (source.effects.projectors ?? []).map((projector, index) => {
    const record = instanceLatest(sections, 'PROJ')
    record.projection_type = projector.projectionType === 'perspective' ? 1 : 0
    record.bone = Math.max(0, projector.boneIndex)
    record.material_reference_index = Math.max(0, projector.materialIndex)
    for (const [field, value] of [
      ['offset', projector.offset],
      ['pitch', [projector.pitch]],
      ['yaw', [projector.yaw]],
      ['roll', [projector.roll]],
      ['field_of_view', [projector.fieldOfView]],
      ['aspect_ratio', [projector.aspectRatio]],
      ['near', [projector.near]],
      ['far', [projector.far]],
      ['box_offset_z_bottom', [projector.boxOffsetZBottom]],
      ['box_offset_z_top', [projector.boxOffsetZTop]],
      ['box_offset_x_left', [projector.boxOffsetXLeft]],
      ['box_offset_x_right', [projector.boxOffsetXRight]],
      ['box_offset_y_front', [projector.boxOffsetYFront]],
      ['box_offset_y_back', [projector.boxOffsetYBack]],
      ['active', [projector.active]],
    ])
      setAnimationField(record, field, `projector:${index}:${field}`, value)
    record.falloff = projector.falloff
    record.alpha_init = projector.alphaInit
    record.alpha_mid = projector.alphaMid
    record.alpha_end = projector.alphaEnd
    record.lifetime_attack = projector.lifetimeAttack ?? 0
    record.lifetime_attack_to = projector.lifetimeAttackTo ?? 0
    record.lifetime_hold = projector.lifetimeHold ?? 0
    record.lifetime_hold_to = projector.lifetimeHoldTo ?? 0
    record.lifetime_decay = projector.lifetimeDecay ?? 0
    record.lifetime_decay_to = projector.lifetimeDecayTo ?? 0
    record.attenuation_distance = projector.attenuationDistance
    record.layer = projector.layer
    record.flags = projector.flags
    return record
  })
  pointModelRecords(sections, model, 'projections', 'PROJ', records)
}
function buildForceSections(sections, model, source) {
  const forceTypes = { radial: 0, wind: 1, explosion: 2 }
  const shapes = { sphere: 0, cylinder: 1, box: 2, hemisphere: 3 }
  const records = (source.effects.forces ?? []).map((force, index) => {
    const record = instanceLatest(sections, 'FOR_')
    record.force_type = forceTypes[force.type]
    record.shape = shapes[force.shape]
    record.bone = Math.max(0, force.boneIndex)
    record.flags =
      (force.falloff ? 1 : 0) | (force.heightGradient ? 2 : 0) | (force.unbounded ? 4 : 0)
    record.channels = force.channels
    setAnimationField(record, 'strength', `force:${index}:strength`, [force.strength])
    setAnimationField(record, 'width', `force:${index}:width`, [force.width])
    setAnimationField(record, 'height', `force:${index}:height`, [force.height])
    setAnimationField(record, 'length', `force:${index}:length`, [force.length])
    return record
  })
  pointModelRecords(sections, model, 'forces', 'FOR_', records)
}
function buildWarpSections(sections, model, source) {
  const records = (source.effects.warps ?? []).map((warp, index) => {
    const record = instanceLatest(sections, 'WRP_')
    record.unknown861f507b = warp.warpType
    record.bone = Math.max(0, warp.boneIndex)
    setAnimationField(record, 'radius', `warp:${index}:radius`, [warp.radius])
    setAnimationField(record, 'unknown9306aac0', `warp:${index}:height`, [warp.height])
    setAnimationField(record, 'strength', `warp:${index}:strength`, [warp.strength])
    setAnimationField(record, 'unknown50c7f2b4', `warp:${index}:angular`, [warp.angular])
    setAnimationField(record, 'unknown8d9c977c', `warp:${index}:axial`, [warp.axial])
    setAnimationField(record, 'unknownca6025a2', `warp:${index}:radial`, [warp.radial])
    return record
  })
  pointModelRecords(sections, model, 'warps', 'WRP_', records)
}
function buildBillboardSections(sections, model, billboards) {
  const typeCodes = { yaw: 0, pitch: 1, full: 2 }
  const records = billboards.map(billboard => {
    const record = instanceLatest(sections, 'BBSC')
    record.bone = nonNegativeInteger(billboard['boneIndex'], 0)
    const code = typeof billboard['billboardType'] === 'number' ? billboard['billboardType'] : billboard['type']
    record.billboard_type =
      typeof code === 'number'
        ? nonNegativeInteger(code, 0)
        : typeCodes[stringValue(code, 'yaw').toLowerCase()] ?? 0
    record.camera_look_at = billboard['cameraLookAt'] === false ? 0 : 1
    for (const field of ['up', 'forward']) {
      const value = billboard[field]
      if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite))
        assignVector(record[field], value, 4)
    }
    return record
  })
  pointModelRecords(sections, model, 'billboards', 'BBSC', records)
}
function buildShadowboxSections(sections, model, shadowboxes) {
  const records = shadowboxes.map(shadowbox => {
    const record = instanceLatest(sections, 'SHBX')
    assignMatrixArray(record.matrix, tuple(shadowbox['matrix4'], 16, 0, identityMatrix()))
    return record
  })
  pointModelRecords(sections, model, 'shadow_boxes', 'SHBX', records)
}
function buildPhysicsSections(sections, model, source, issues) {
  const metadataBodies = metadataObjects(source, 'm3RigidBodies')
  const bodies =
    metadataBodies.length > 0
      ? metadataBodies
      : (source.collisionShapes ?? []).map((shape, index) => ({
          name: `Collision_${index}`,
          boneIndex: shape.boneIndex,
          mass: 1,
          friction: 0.5,
          restitution: 0.2,
          flags: 1,
          shapes: [
            {
              shape: shape.kind,
              matrix4: shape.matrix,
              size: shape.size,
              vertices: shape.vertices ?? [],
            },
          ],
        }))
  const shapeCodes = {
    box: 0,
    sphere: 1,
    capsule: 2,
    cylinder: 3,
    'convex-hull': 4,
    mesh: 5,
    Box: 0,
    Sphere: 1,
    Capsule: 2,
    Cylinder: 3,
    ConvexHull: 4,
    Mesh: 5,
  }
  const bodyRecords = bodies.map((body, bodyIndex) => {
    const bodyRecord = instanceLatest(sections, 'PHRB')
    bodyRecord.simulation_type = nonNegativeInteger(body['simulationType'], 1)
    bodyRecord.bone = nonNegativeInteger(body['boneIndex'], 0)
    bodyRecord.physical_material = nonNegativeInteger(body['physicalMaterial'], 0)
    bodyRecord.mass = numberValue(body['mass'], 1)
    bodyRecord.friction = numberValue(body['friction'], 0.5)
    bodyRecord.bounce = numberValue(body['restitution'], 0.2)
    bodyRecord.damping_linear = numberValue(body['dampingLinear'], 1e-3)
    bodyRecord.damping_angular = numberValue(body['dampingAngular'], 1e-3)
    bodyRecord.gravity_factor = numberValue(body['gravityFactor'], 1)
    bodyRecord.flags = nonNegativeInteger(body['flags'], 1)
    bodyRecord.local_forces = nonNegativeInteger(body['localForces'], 0)
    bodyRecord.world_forces = nonNegativeInteger(body['worldForces'], 0)
    bodyRecord.priority = nonNegativeInteger(body['priority'], 0)
    const shapeRecords = objectArray(body['shapes']).map(shape => {
      const shapeRecord = instanceLatest(sections, 'PHSH')
      if (shape['nativeRecord'] !== undefined) {
        const native = shape['nativeRecord']
        if (native?.version !== 3 || !Array.isArray(native.bytes) || native.bytes.length !== 300 ||
            !native.bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
          throw new TypeError('M3 degenerate PHSH record is invalid')
        const bytes = Uint8Array.from(native.bytes)
        const decoded = shapeRecord.desc.instance(bytes.buffer, 0)
        for (const [name, field] of Object.entries(decoded.desc.fields))
          if (field.desc?.history.name === 'Reference' && decoded[name].entries !== 0)
            throw new TypeError('M3 degenerate PHSH record has an external reference')
        const matrix = ['x', 'y', 'z', 'w'].flatMap(column =>
          ['x', 'y', 'z', 'w'].map(component => decoded.matrix[column][component]))
        const size = [decoded.size0, decoded.size1, decoded.size2]
        if (![2, 3].includes(decoded.shape) || decoded.shape !== shape.shapeCode ||
            !size.every(Number.isFinite) || size[0] < 0 || size[1] < 0 ||
            (size[0] !== 0 && size[1] !== 0) ||
            size.some((value, index) => value !== shape.size?.[index]) ||
            matrix.some((value, index) => !Number.isFinite(value) || value !== shape.matrix4?.[index]))
          throw new TypeError('M3 degenerate PHSH record disagrees with its descriptor')
        // All references are empty. Keep uninitialised native fields, signed zero and NaN bits
        // exactly, through the existing structural writer's opaque-record facility.
        const desc = new M3StructureDescription(shapeRecord.desc.history, 3,
          { raw: new M3FieldBytes('raw', 300, bytes) }, 300)
        return desc.instance(bytes.buffer, 0)
      }
      const shapeName = stringValue(shape['shape'], 'box')
      shapeRecord.shape = shapeCodes[shapeName] ?? 0
      shapeRecord.shape_fb8 = shapeRecord.shape
      shapeRecord.shape_fb16 = shapeRecord.shape
      assignMatrixArray(shapeRecord.matrix, tuple(shape['matrix4'], 16, 0, identityMatrix()))
      const size = tuple(shape['size'], 3, 1)
      shapeRecord.size0 = size[0]
      shapeRecord.size1 = size[1]
      shapeRecord.size2 = size[2]
      const vertices = tupleArray(shape['vertices'], 3)
      if (vertices.length > 0) {
        const mesh = shapeRecord.shape === 5
        const vertexRecords = vertices.map(vertex => {
          const record = instance(sections, mesh ? 'VEC4' : 'VEC3', 0)
          assignVector(record, mesh ? [...vertex, 0] : vertex, mesh ? 4 : 3)
          return record
        })
        pointReference(
          sections,
          mesh ? shapeRecord.mesh_vertices : shapeRecord.vertices,
          appendM3Section(sections, mesh ? 'VEC4' : 'VEC3', 0, vertexRecords),
        )
        if (mesh) shapeRecord.mesh_vertex_count = vertexRecords.length
        else shapeRecord.vertices_count = vertexRecords.length
        const indices = numericArray(shape['indices'])
        if (mesh && indices.length > 0) {
          if (indices.length % 3 !== 0 || indices.some(index => index >= vertexRecords.length))
            throw new TypeError('M3 rigid mesh triangle indices are invalid')
          const tag = indices.some(index => index > 0xffff) ? 'MT32' : 'MT16'
          const triangles = []
          for (let offset = 0; offset < indices.length; offset += 3) {
            const triangle = instance(sections, tag, 0)
            triangle.unknown4c11db70 = indices[offset]
            triangle.unknown2e003dc5 = indices[offset + 1]
            triangle.unknownfa325055 = indices[offset + 2]
            triangles.push(triangle)
          }
          pointReference(
            sections,
            tag === 'MT16' ? shapeRecord.mesh_triangles16 : shapeRecord.mesh_triangles32,
            appendM3Section(sections, tag, 0, triangles),
          )
          if (tag === 'MT16') shapeRecord.mesh_triangle16_count = triangles.length
          else shapeRecord.mesh_triangle32_count = triangles.length
        }
      }
      return shapeRecord
    })
    if (shapeRecords.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'm3-rigid-body-without-shape',
        message: `Rigid body ${bodyIndex} has no encodable physics shape.`,
      })
    }
    pointReference(
      sections,
      bodyRecord.physics_shape,
      appendM3Section(sections, 'PHSH', latestVersion(sections, 'PHSH'), shapeRecords),
    )
    return bodyRecord
  })
  pointModelRecords(sections, model, 'physics_rigidbodies', 'PHRB', bodyRecords)
  const constraints = metadataObjects(source, 'm3PhysicsConstraints').map(constraint => {
    const record = instanceLatest(sections, 'PHCT')
    pointReference(
      sections,
      record.dependents,
      appendM3Section(sections, 'U16_', 0, numericArray(constraint['dependentIndices'])),
    )
    record.rigid_body1 = nonNegativeInteger(constraint['rigidBodyIndex0'], 0)
    record.rigid_body2 = nonNegativeInteger(constraint['rigidBodyIndex1'], 0)
    assignPrimitive(record.flags, nonNegativeInteger(constraint['flags'], 0))
    record.break_force = numberValue(constraint['breakForce'], 0)
    return record
  })
  pointModelRecords(sections, model, 'physics_constraints', 'PHCT', constraints)
  const joints = metadataObjects(source, 'm3PhysicsJoints').map(joint => {
    const record = instanceLatest(sections, 'PHYJ')
    record.joint_type = jointTypeCode(joint['type'])
    record.bone1 = nonNegativeInteger(joint['boneIndex0'], 0)
    record.bone2 = nonNegativeInteger(joint['boneIndex1'], 0)
    assignMatrixArray(record.matrix1, identityMatrix())
    assignMatrixArray(record.matrix2, identityMatrix())
    const limits = asRecord(joint['limits'])
    record.limit_bool = limits ? 1 : 0
    record.limit_min = numberValue(limits?.['min'], 0)
    record.limit_max = numberValue(limits?.['max'], 90)
    return record
  })
  pointModelRecords(sections, model, 'physics_joints', 'PHYJ', joints)
  const cloths = metadataObjects(source, 'm3PhysicsCloths').map(cloth => {
    const record = instanceLatest(sections, 'PHCL')
    const bones = numericArray(cloth['boneIndices'])
    pointReference(sections, record.skin_bones, appendM3Section(sections, 'U16_', 0, bones))
    record.stiffness_stretching = numberValue(cloth['stiffness'], 0.5)
    return record
  })
  pointModelRecords(sections, model, 'physics_cloths', 'PHCL', cloths)
}
function buildIkSections(sections, model, values) {
  const records = values.map(value => {
    const record = instanceLatest(sections, 'IKJT')
    record.bone_base = nonNegativeInteger(value['boneIndex'] ?? value['effectorBoneIndex'], 0)
    record.bone_target = nonNegativeInteger(value['targetBoneIndex'], 0)
    record.search_up = numberValue(value['searchUp'], 1)
    record.search_down = numberValue(value['searchDown'], 1)
    record.search_speed = numberValue(value['weight'], 1)
    record.goal_threshold =
      value['enabled'] === false ? 0 : numberValue(value['goalThreshold'], 0.01)
    return record
  })
  pointModelRecords(sections, model, 'ik_joints', 'IKJT', records)
}
function buildTurretSections(sections, model, turrets) {
  const partRecords = []
  const turretRecords = turrets.map((turret, turretIndex) => {
    const record = instanceLatest(sections, 'TRGD')
    pointReference(
      sections,
      record.name,
      appendString(sections, stringValue(turret['name'], `Turret_${turretIndex}`)),
    )
    const partIndices = objectArray(turret['parts']).map((part, partIndex) => {
      const partRecord = instanceLatest(sections, 'PATU')
      assignMatrixArray(partRecord.matrix_forward, identityMatrix())
      partRecord.bone = nonNegativeInteger(part['boneIndex'], 0)
      partRecord.flags = partIndex === 0 ? 1 : 0
      const index = partRecords.length
      partRecords.push(partRecord)
      return index
    })
    pointReference(sections, record.parts, appendM3Section(sections, 'U32_', 0, partIndices))
    return record
  })
  pointModelRecords(sections, model, 'turret_parts', 'PATU', partRecords)
  pointModelRecords(sections, model, 'turrets', 'TRGD', turretRecords)
}
function setAnimationField(record, field, id, components, color = false) {
  if (isStructureRecord(record[field])) {
    setAnimationReference(record[field], animationId(id), components, color)
  }
}
function pointModelRecords(sections, model, field, tag, records) {
  if (!model[field] || records.length === 0) return
  pointReference(
    sections,
    model[field],
    appendM3Section(sections, tag, latestVersion(sections, tag), records),
  )
}
function pointModelNumbers(sections, model, field, tag, records) {
  if (!model[field] || records.length === 0) return
  pointReference(
    sections,
    model[field],
    appendM3Section(sections, tag, latestVersion(sections, tag), records),
  )
}
function instanceLatest(sections, tag) {
  return instance(sections, tag, latestVersion(sections, tag))
}
function latestVersion(sections, tag) {
  const history = sections.structureHistories[tag]
  if (!history) throw new Error(`M3 encoder schema is missing ${tag}`)
  return Math.max(...history.versionToSize.keys())
}
function metadataObjects(model, key) {
  return objectArray(model.metadata?.[key])
}
function objectArray(value) {
  return Array.isArray(value) ? value.map(asRecord).filter(entry => !!entry) : []
}
function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : void 0
}
function numericArray(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? Array.from(value).map(entry => numberValue(entry, 0))
    : []
}
function tupleArray(value, size) {
  return Array.isArray(value)
    ? value.map(entry => tuple(entry, size, 0)).filter(entry => entry.length === size)
    : []
}
function tuple(value, size, fallback, fallbackValues) {
  const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : fallbackValues
  return Array.from({ length: size }, (_, index) => numberValue(source?.[index], fallback))
}
function lifecycleCurve(value) {
  return value ? [value.start[0] ?? 0, value.middle[0] ?? 0, value.end[0] ?? 0] : [0, 0, 0]
}
function writeVariations(record, source, idPrefix) {
  for (const prefix of [
    'pitch',
    'yaw',
    'speed',
    'size',
    'alpha',
    'color',
    'rotation',
    'spreadX',
    'spreadY',
    'length',
    'scale',
  ]) {
    const variation = asRecord(source[`${prefix}Variation`])
    if (!variation) continue
    const schemaPrefix = prefix
      .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
      .replace(/^spread_/, 'spread_')
    const shape = variationShape(variation['shape'])
    if (typeof record[`${schemaPrefix}_var_shape`] === 'number')
      record[`${schemaPrefix}_var_shape`] = shape
    setAnimationField(record, `${schemaPrefix}_var_amplitude`, `${idPrefix}:${prefix}:variation-amplitude`, [
      numberValue(variation['amplitude'], 0),
    ])
    setAnimationField(record, `${schemaPrefix}_var_frequency`, `${idPrefix}:${prefix}:variation-frequency`, [
      numberValue(variation['frequency'], 0),
    ])
  }
}
function variationShape(value) {
  if (typeof value === 'number') return Math.max(0, Math.floor(value))
  return { none: 0, sine: 1, triangle: 2, square: 3, saw: 4, noise: 5 }[String(value)] ?? 0
}
function jointTypeCode(value) {
  if (typeof value === 'number') return Math.max(0, Math.floor(value))
  return { hinge: 0, spherical: 1, cone: 2, weld: 3 }[String(value).toLowerCase()] ?? 0
}
function assignPrimitive(value, number) {
  if (isStructureRecord(value)) value.value = number
}
function assignMatrixArray(value, source) {
  const matrix = value
  assignVector(
    matrix.x,
    Array.from({ length: 4 }, (_, index) => numberValue(source[index], index === 0 ? 1 : 0)),
    4,
  )
  assignVector(
    matrix.y,
    Array.from({ length: 4 }, (_, index) => numberValue(source[index + 4], index === 1 ? 1 : 0)),
    4,
  )
  assignVector(
    matrix.z,
    Array.from({ length: 4 }, (_, index) => numberValue(source[index + 8], index === 2 ? 1 : 0)),
    4,
  )
  assignVector(
    matrix.w,
    Array.from({ length: 4 }, (_, index) => numberValue(source[index + 12], index === 3 ? 1 : 0)),
    4,
  )
}
function numberValue(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function nonNegativeInteger(value, fallback) {
  const number = numberValue(value, fallback)
  return Math.max(0, Math.floor(number))
}
function stringValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
function prepareMesh(
  model,
  mesh,
  vertexDescription,
  vertexBytes,
  faces,
  boneLookup,
  boneCount,
  options,
  issues,
) {
  const vertexCount = Math.floor(mesh.positions.length / 3)
  const firstVertex = vertexBytes.length / vertexDescription.size
  const firstFace = faces.length
  const uvRange = meshUvRange(mesh)
  const uvOffset = (uvRange.min + uvRange.max) / 2
  const uvMultiply = Math.max(1 / 2048, ((uvRange.max - uvRange.min) / 2) * (32768 / 32767))
  const usedBones = usedMeshBones(mesh, boneCount)
  const firstBoneLookup = boneLookup.length
  boneLookup.push(...usedBones)
  const lookupIndices = new Map(usedBones.map((bone, index) => [bone, index]))
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const record = vertexDescription.instance()
    assignVector(record.pos, convertPosition(model, mesh.positions, vertex, options), 3)
    if (record.normal)
      assignPackedDirection(
        record.normal,
        convertDirection(model, mesh.normals, vertex, options, [0, 0, 1]),
      )
    if (record.tan) {
      const tangent = convertDirection(model, mesh.tangents, vertex, options, [1, 0, 0], 4)
      assignPackedDirection(record.tan, tangent)
      record.unused = tangent[3] === void 0 || tangent[3] >= 0 ? 255 : 0
      record.sign = record.unused
    }
    if (record.col) assignColor(record.col, mesh.colors, vertex)
    assignUv(record.uv0, mesh.uvs, vertex, uvMultiply, uvOffset)
    assignUv(record.uv1, mesh.uvs1, vertex, uvMultiply, uvOffset)
    assignUv(record.uv2, mesh.uvs2, vertex, uvMultiply, uvOffset)
    assignUv(record.uv3, mesh.uvs3, vertex, uvMultiply, uvOffset)
    const weights = normalizedWeights(mesh, vertex)
    for (let influence = 0; influence < 4; influence += 1) {
      record[`weight${influence}`] = weights.weights[influence]
      record[`lookup${influence}`] = lookupIndices.get(weights.bones[influence]) ?? 0
    }
    const bytes = new Uint8Array(vertexDescription.size)
    record.toBuffer(bytes.buffer)
    vertexBytes.push(...bytes)
  }
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const a = mesh.indices[index],
      b = mesh.indices[index + 1],
      c = mesh.indices[index + 2]
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      issues.push({
        severity: 'warning',
        code: 'm3-index-out-of-range',
        message: `Skipped an invalid face in mesh "${mesh.name}".`,
      })
      continue
    }
    faces.push(a, b, c)
  }
  return {
    source: mesh,
    firstVertex,
    vertexCount,
    firstFace,
    faceCount: faces.length - firstFace,
    materialIndex: Math.max(0, mesh.materialIndex),
    uvMultiply,
    uvOffset,
    firstBoneLookup,
    boneLookup: usedBones,
  }
}
function chooseVertexFlags(meshes) {
  let flags = VERTEX_POS | VERTEX_SKIN_0 | VERTEX_SKIN_1 | VERTEX_UV0 | VERTEX_NORMAL
  if (meshes.some(mesh => !!mesh.tangents)) flags |= VERTEX_TANGENT
  if (meshes.some(mesh => !!mesh.colors)) flags |= VERTEX_COLOR
  if (meshes.some(mesh => !!mesh.uvs1)) flags |= VERTEX_UV1
  if (meshes.some(mesh => !!mesh.uvs2)) flags |= VERTEX_UV2
  if (meshes.some(mesh => !!mesh.uvs3)) flags |= VERTEX_UV3
  return flags >>> 0
}
function normalizedSkeleton(model) {
  if (model.skeleton.bones.length > 0) {
    return model.skeleton.bones.map((bone, index) => ({
      ...bone,
      index,
      parentIndex: bone.parentIndex >= index ? -1 : bone.parentIndex,
    }))
  }
  return [
    {
      index: 0,
      name: 'Root',
      parentIndex: -1,
      flags: BONE_INHERIT | BONE_SKINNED | BONE_REAL,
      inverseBindMatrix: identityMatrix(),
    },
  ]
}
function isRenderSequence(animation) {
  return Array.isArray(animation.nodeTracks)
}
function instance(sections, tag, version) {
  const history = sections.structureHistories[tag]
  if (!history) throw new Error(`M3 encoder schema is missing ${tag}`)
  return history.getVersion(version, sections.mdVersion, sections.structureHistories).instance()
}
function appendString(sections, value) {
  const bytes = new TextEncoder().encode(`${value}\0`)
  return appendM3Section(sections, 'CHAR', 0, [...bytes])
}
function pointReference(sections, value, section) {
  pointM3ReferenceAtSection(sections, value, section)
}
function setAnimationReference(value, id, components, color = false) {
  const reference = value
  const header = reference.header
  header.interpolation = 1
  header.flags = 0
  header.id = id
  if (color) {
    assignColorComponents(reference.default, components)
    assignColorComponents(reference.null, components)
  } else if (typeof reference.default === 'number') {
    reference.default = components[0] ?? 0
    reference.null = components[0] ?? 0
  } else {
    assignVector(reference.default, components, components.length)
    assignVector(reference.null, components, components.length)
  }
}
function assignAnimatedBounds(value, bounds) {
  const reference = value
  const header = reference.header
  header.interpolation = 0
  header.flags = 0
  header.id = animationId('model:bounds')
  assignBounds(reference.default, bounds)
  assignBounds(reference.null, bounds)
}
function assignVector(value, components, size) {
  const vector = value
  vector.x = finiteNumber(components[0]) ?? 0
  if (size >= 2) vector.y = finiteNumber(components[1]) ?? 0
  if (size >= 3) vector.z = finiteNumber(components[2]) ?? 0
  if (size >= 4) vector.w = finiteNumber(components[3]) ?? 1
}
function assignPackedDirection(value, components) {
  const vector = value
  vector.x = packSignedUnit(components[0])
  vector.y = packSignedUnit(components[1])
  vector.z = packSignedUnit(components[2])
}
function assignColor(value, colors, vertex) {
  const source =
    colors && colors.length >= vertex * 4 + 4
      ? [colors[vertex * 4], colors[vertex * 4 + 1], colors[vertex * 4 + 2], colors[vertex * 4 + 3]]
      : [1, 1, 1, 1]
  assignColorComponents(value, source)
}
function assignColorComponents(value, color) {
  value.r = Math.round(clamp01(color[0] ?? 1) * 255)
  value.g = Math.round(clamp01(color[1] ?? 1) * 255)
  value.b = Math.round(clamp01(color[2] ?? 1) * 255)
  value.a = Math.round(clamp01(color[3] ?? 1) * 255)
}
function assignUv(value, uvs, vertex, multiply, offset) {
  if (!value) return
  const uv = value
  uv.x = clampInt16(Math.round((((uvs?.[vertex * 2] ?? 0) - offset) * 32768) / multiply))
  uv.y = clampInt16(Math.round((((uvs?.[vertex * 2 + 1] ?? 0) - offset) * 32768) / multiply))
}
function assignBounds(value, bounds) {
  const target = value
  assignVector(target.min, bounds.min, 3)
  assignVector(target.max, bounds.max, 3)
  target.radius = bounds.radius
}
function assignMatrix(value, source) {
  const matrix = value
  const elements = source && source.length >= 16 ? source : identityMatrix()
  assignVector(matrix.x, elements.subarray(0, 4), 4)
  assignVector(matrix.y, elements.subarray(4, 8), 4)
  assignVector(matrix.z, elements.subarray(8, 12), 4)
  assignVector(matrix.w, elements.subarray(12, 16), 4)
}
function effectiveAnimationName(animation, index, names) {
  const edited = names?.[index]?.trim()
  return edited || animation.name?.trim() || `Sequence_${index}`
}
function convertTrackTranslation(model, value, options) {
  const scale = finiteNumber(options.scale) ?? 1
  const converted = [(value[0] ?? 0) * scale, (value[1] ?? 0) * scale, (value[2] ?? 0) * scale]
  return sourceUpAxis(model, options) === 'y'
    ? [converted[0], -converted[2], converted[1]]
    : converted
}
function convertTrackQuaternion(model, value, options) {
  const quaternion = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1]
  if (sourceUpAxis(model, options) !== 'y') return normalizedQuaternion(quaternion)
  const half = Math.SQRT1_2
  const conversion = [half, 0, 0, half]
  const inverse = [-half, 0, 0, half]
  return normalizedQuaternion(
    multiplyQuaternion(multiplyQuaternion(conversion, quaternion), inverse),
  )
}
function convertedInverseBindMatrix(model, source, options) {
  let matrix = new Float32Array(source && source.length >= 16 ? source : identityMatrix())
  if (sourceUpAxis(model, options) === 'y') {
    const conversion = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])
    const inverse = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1])
    matrix = multiplyMatrix4(multiplyMatrix4(conversion, matrix), inverse)
  }
  const scale = finiteNumber(options.scale) ?? 1
  matrix[12] *= scale
  matrix[13] *= scale
  matrix[14] *= scale
  return matrix
}
function multiplyQuaternion(left, right) {
  const [ax, ay, az, aw] = left
  const [bx, by, bz, bw] = right
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}
function normalizedQuaternion(value) {
  const length = Math.hypot(value[0], value[1], value[2], value[3]) || 1
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}
function multiplyMatrix4(left, right) {
  const output = new Float32Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0
      for (let inner = 0; inner < 4; inner += 1) {
        value += left[inner * 4 + row] * right[column * 4 + inner]
      }
      output[column * 4 + row] = value
    }
  }
  return output
}
function convertPosition(model, values, index, options) {
  const scale = finiteNumber(options.scale) ?? 1
  const source = [
    values[index * 3] * scale,
    values[index * 3 + 1] * scale,
    values[index * 3 + 2] * scale,
  ]
  return sourceUpAxis(model, options) === 'y' ? [source[0], -source[2], source[1]] : source
}
function convertDirection(model, values, index, options, fallback, stride = 3) {
  const source =
    values && values.length >= index * stride + 3
      ? [
          values[index * stride],
          values[index * stride + 1],
          values[index * stride + 2],
          ...(stride === 4 ? [values[index * stride + 3]] : []),
        ]
      : [...fallback]
  return sourceUpAxis(model, options) === 'y'
    ? [source[0], -source[2], source[1], ...(source.length > 3 ? [source[3]] : [])]
    : source
}
function sourceUpAxis(model, options) {
  return options.upAxis ?? (model.metadata?.['coordinateSystem'] === 'Y_UP' ? 'y' : 'z')
}
/**
 * Bones one M3 region may bind.
 *
 * The file format's own ceiling is the one-byte per-vertex lookup index, but StarCraft II's
 * skinning binds far fewer matrices than that byte could address. Blizzard's own models stay well
 * under this number - the largest region across the installed coop model set names 51 bones - so
 * a mesh that exceeds it was not authored for this target and is divided into regions that were.
 */
const M3_REGION_BONE_BUDGET = 64

/** Per-vertex attributes a region carries, with how many numbers each vertex takes. */
const M3_VERTEX_ATTRIBUTES = [
  ['positions', 3],
  ['normals', 3],
  ['tangents', 4],
  ['colors', 4],
  ['uvs', 2],
  ['uvs1', 2],
  ['uvs2', 2],
  ['uvs3', 2],
  ['boneIndices', 4],
  ['boneWeights', 4],
]

/**
 * Divide a mesh into regions that each stay inside the bone budget.
 *
 * Returns the mesh untouched when it already fits, which is every model authored for this game.
 */
function splitMeshToBoneBudget(mesh, boneCount, issues) {
  void boneCount
  let parts
  try {
    parts = splitTrianglesByBoneLimit(mesh.indices, mesh.boneIndices, mesh.boneWeights, {
      maxBones: M3_REGION_BONE_BUDGET,
    })
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'm3-region-bone-budget',
      message: `Kept mesh "${mesh.name}" whole: ${error instanceof Error ? error.message : String(error)}.`,
    })
    return [mesh]
  }
  if (parts.length <= 1) return [mesh]
  issues.push({
    severity: 'warning',
    code: 'm3-region-bone-budget',
    message: `Split mesh "${mesh.name}" into ${parts.length} regions: one M3 region binds at most ${M3_REGION_BONE_BUDGET} bones.`,
  })
  return parts.map((part, ordinal) => {
    const split = { ...mesh, name: `${mesh.name}-${ordinal}`, indices: part.indices }
    for (const [attribute, stride] of M3_VERTEX_ATTRIBUTES) {
      const source = mesh[attribute]
      if (!source) continue
      const target = new source.constructor(part.vertices.length * stride)
      for (let vertex = 0; vertex < part.vertices.length; vertex += 1) {
        const from = part.vertices[vertex] * stride
        for (let component = 0; component < stride; component += 1)
          target[vertex * stride + component] = source[from + component] ?? 0
      }
      split[attribute] = target
    }
    return split
  })
}

function usedMeshBones(mesh, boneCount) {
  const used = /* @__PURE__ */ new Set()
  if (mesh.boneIndices && mesh.boneWeights) {
    for (let index = 0; index < mesh.boneIndices.length; index += 1) {
      const bone = mesh.boneIndices[index]
      if ((mesh.boneWeights[index] ?? 0) > 0 && bone >= 0 && bone < boneCount) used.add(bone)
    }
  }
  if (used.size === 0) used.add(0)
  return [...used].slice(0, 255)
}
function normalizedWeights(mesh, vertex) {
  const influences = Array.from({ length: 4 }, (_, index) => ({
    bone: mesh.boneIndices?.[vertex * 4 + index] ?? 0,
    weight: Math.max(0, mesh.boneWeights?.[vertex * 4 + index] ?? (index === 0 ? 1 : 0)),
  })).sort((left, right) => right.weight - left.weight)
  const total = influences.reduce((sum, influence) => sum + influence.weight, 0) || 1
  const weights = influences.map(influence => Math.round((influence.weight / total) * 255))
  const difference = 255 - weights.reduce((sum, weight) => sum + weight, 0)
  weights[0] = Math.max(0, Math.min(255, weights[0] + difference))
  return { bones: influences.map(influence => influence.bone), weights }
}
function meshUvRange(mesh) {
  let min = 0,
    max = 0
  for (const values of [mesh.uvs, mesh.uvs1, mesh.uvs2, mesh.uvs3]) {
    if (!values) continue
    for (const value of values) {
      if (!Number.isFinite(value)) continue
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  }
  return { min, max }
}
function transformedBounds(model, meshes, options) {
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (const mesh of meshes) {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      const value = convertPosition(model, mesh.source.positions, vertex, options)
      min = [Math.min(min[0], value[0]), Math.min(min[1], value[1]), Math.min(min[2], value[2])]
      max = [Math.max(max[0], value[0]), Math.max(max[1], value[1]), Math.max(max[2], value[2])]
    }
  }
  if (!Number.isFinite(min[0])) min = max = [0, 0, 0]
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  let radius = 0
  for (const mesh of meshes) {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      const value = convertPosition(model, mesh.source.positions, vertex, options)
      radius = Math.max(
        radius,
        Math.hypot(value[0] - center[0], value[1] - center[1], value[2] - center[2]),
      )
    }
  }
  return { min, max, radius }
}
function materialFlags(material) {
  const standard = material.standard
  if (standard?.sourceFlags !== undefined) return standard.sourceFlags >>> 0
  let flags = MAT_GEOMETRY_VISIBLE
  if (standard?.usesVertexColor) flags |= 1
  if (standard?.usesVertexAlpha) flags |= 2
  if (standard?.twoSided) flags |= 8
  if (standard?.unshaded) flags |= 16
  if (standard?.depthPrepass) flags |= 256
  if (standard?.doubleLambert) flags |= 524288
  if (standard?.clampOutput) flags |= 1073741824
  // SimulateRoughness: a material that states no specular dim (another game's) keeps its highlight.
  if (standard?.specularEnergyConservation === false) flags |= 0x800
  return flags >>> 0
}
function legacyLayer(material, slot) {
  const path = legacyLayerPath(material, slot)
  if (!path) return void 0
  return {
    slot,
    texturePath: path,
    uvSource: 0,
    channels: 0,
    op: 0,
    teamColorMode: 0,
    invert: false,
    clampResult: false,
    wrapX: true,
    wrapY: true,
  }
}
function legacyLayerPath(material, slot) {
  const aliases = {
    diffuse: ['diff', 'base', 'color'],
    normal: ['normal', 'bump'],
    specular: ['spec'],
    emissive1: ['emis', 'glow'],
    gloss: ['gloss', 'rough'],
    ao: ['ao', 'occlusion'],
  }
  const labels = aliases[slot] ?? [slot.toLowerCase()]
  return material.layers.find(layer =>
    labels.some(label => layer.label.toLowerCase().includes(label)),
  )?.path
}
async function copyTextures(model, options, issues) {
  const files = []
  const seen = /* @__PURE__ */ new Set()
  for (const request of listRenderModelTextureRequests(model)) {
    const path = safeRelativePath(request.path)
    if (seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    try {
      const bytes = await options.assetResolver.resolve({ path: request.path, role: 'texture' })
      if (bytes) files.push({ path, bytes, role: 'texture' })
      else
        issues.push({
          severity: 'warning',
          code: 'm3-texture-not-found',
          message: `Could not copy texture "${request.path}".`,
        })
    } catch (error) {
      issues.push({
        severity: 'warning',
        code: 'm3-texture-read-failed',
        message: `Could not copy texture "${request.path}": ${String(error)}`,
      })
    }
  }
  return files
}
function reportUnsupportedMetadata(model, issues) {
  const unsupported = [
    ['particle copies', arrayLength(model.metadata?.['m3ParticleCopies'])],
    [
      'morph targets',
      model.meshes.reduce((count, mesh) => count + (mesh.morphTargets?.length ?? 0), 0),
    ],
  ]
  for (const [label, count] of unsupported) {
    if (count > 0)
      issues.push({
        severity: 'warning',
        code: `m3-${label.replace(/\s+/g, '-')}-not-encoded`,
        message: `${count} ${label} are retained in RenderModel metadata but are not yet synthesized into M3 sections.`,
      })
  }
  const particleFields = new Set(['emissionRate', 'lifeSpan', 'speed', 'emitAngleX', 'emitAngleY', 'emitSpreadX', 'emitSpreadY', 'emitShapeRadius', 'emitShapeSize', 'emitCount'])
  const ribbonFields = new Set(['visibility', 'lifeSpan', 'speed', 'pitch', 'yaw', 'spreadX', 'spreadY', 'maxLength', 'color', 'segmentColorStart', 'segmentColorMiddle', 'segmentColorEnd'])
  let unsupportedAnimatedEffects = 0
  for (const effect of model.effects.particles)
    unsupportedAnimatedEffects += Object.keys(effect.sequenceAnimation ?? {}).filter(key => !particleFields.has(key)).length + (effect.animation ? 1 : 0)
  for (const effect of model.effects.ribbons)
    unsupportedAnimatedEffects += Object.keys(effect.sequenceAnimation ?? {}).filter(key => !ribbonFields.has(key)).length + (effect.animation ? 1 : 0)
  if (unsupportedAnimatedEffects > 0) {
    issues.push({
      severity: 'warning',
      code: 'm3-effect-animation-partial',
      message: `${unsupportedAnimatedEffects} effect animation channel(s) are not yet rebound to STC data.`,
    })
  }
}
function animationId(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}
function tagToUint32(tag) {
  const bytes = tag
    .padEnd(4, '\0')
    .split('')
    .reverse()
    .map(value => value.charCodeAt(0))
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
}
function validStructureVersion(history, value, fallback) {
  const version = finiteNumber(value)
  return version !== void 0 && history?.versionToSize.has(version) ? version : fallback
}
function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}
function packSignedUnit(value) {
  return Math.round((Math.max(-1, Math.min(1, value ?? 0)) * 0.5 + 0.5) * 255)
}
function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}
function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, value))
}
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : void 0
}
function finiteUint32(value) {
  const number = finiteNumber(value)
  return number !== void 0 && number >= 0 ? Math.floor(number) >>> 0 : void 0
}
function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0
}
function basenameWithoutExtension(value) {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? value
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
function safeRelativePath(value) {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..' && !part.includes(':'))
  return parts.join('/') || 'texture.bin'
}
export { encodeM3RenderModel, rememberM3SourceBytes }
