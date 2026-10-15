/** Bounded native M3 geometry, bounds, physics, preview, effects and animation-reference projection.
 * Source-wide material loss facts use the canonical Models classifier for UVM write admission. */
import { m3MaterialLossMetadata } from '../../../dist/m3/native/builder/standard-material.js'
import { schemaText } from './schema.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
import { M3StructureDescription } from '../../../dist/m3/native/binary/structures.js'
import { M3FieldPrimitive } from '../../../dist/m3/native/binary/fields.js'
import { buildVertexObject } from '../../../dist/m3/native/utils/vertex.js'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { createM3NativeFacade } from './native-builders.js'
import { M3AnimationReferenceTrackExtractor } from '../../../dist/m3/native/animation/tracks.js'
import { materialLayerRecords } from '../../../dist/m3/uvm/material-layer-addresses.js'

function captureStaticPreview(sections, budget, signal) {
  const facade = createM3NativeFacade(sections),
    cameras = facade.cameras,
    lights = facade.lights
  if (cameras.length === 0 && lights.length === 0) return undefined
  const binds = sections.getSectionByReference(sections.model.bone_rests)?.content ?? []
  if (
    cameras.length + lights.length + binds.length * 17 > budget.maxNodes ||
    binds.length * 128 > budget.maxScalarBytes
  )
    throw new RangeError('M3 static preview exceeds node budget')
  const fields = (value, keys) =>
    Object.fromEntries(
      keys.map(key => {
        const item = value[key]
        return [key, typeof item === 'number' && !Number.isFinite(item) ? null : (item ?? null)]
      }),
    )
  const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections)
  const cameraRecords = sections.getSectionByReference(sections.model.cameras)?.content ?? []
  const lightRecords = sections.getSectionByReference(sections.model.lights)?.content ?? []
  const sequenceAnimation = (record, mapping) => {
    const result = {}
    for (const [source, target] of mapping) {
      signal?.throwIfAborted()
      const tracks = extractor.extract(record?.[source])
      if (tracks.length > 0) result[target] = tracks
    }
    return Object.keys(result).length === 0 ? undefined : result
  }
  return snapshotJson(
    {
      cameras: cameras.map((value, index) => ({
        ...fields(value, [
          'name',
          'boneIndex',
          'nearClip',
          'farClip',
          'fieldOfView',
          'useVerticalFov',
          'shadowClipDistance',
          'focusDistance',
          'farFocusRange',
          'nearFocusRange',
          'nearFalloffStart',
          'nearFalloffEnd',
          'dofType',
          'depthOfField',
          'bokehFStop',
          'bokehMaxCoCDiameter',
        ]),
        ...((animation) =>
          animation === undefined ? {} : { sequenceAnimation: animation })(
          sequenceAnimation(cameraRecords[index], [
            ['field_of_view', 'fieldOfView'],
            ['near_clip', 'nearClip'],
            ['far_clip', 'farClip'],
          ]),
        ),
      })),
      lights: lights.map((value, index) => ({
        ...fields(value, [
          'name',
          'boneIndex',
          'type',
          'intensity',
          'attenuationNear',
          'attenuationFar',
          'decay',
          'hotspot',
          'falloff',
          'flags',
          'specularIntensity',
        ]),
        color: value.color.map(component => (Number.isFinite(component) ? component : 0)),
        specularColor: value.specularColor.map(component => (Number.isFinite(component) ? component : 0)),
        ...((animation) =>
          animation === undefined ? {} : { sequenceAnimation: animation })(
          sequenceAnimation(lightRecords[index], [
            ['color', 'color'],
            ['intensity', 'intensity'],
            ['attenuation_near', 'attenuationNear'],
            ['decay', 'decay'],
            ['hotspot', 'hotspot'],
            ['falloff', 'falloff'],
          ]),
        ),
      })),
      inverseBindMatrices: binds.map(record => {
        signal?.throwIfAborted()
        const values = ['x', 'y', 'z', 'w'].flatMap(column =>
          ['x', 'y', 'z', 'w'].map(row => record.matrix?.[column]?.[row]),
        )
        return values.every(Number.isFinite) ? values : null
      }),
    },
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxScalarBytes },
    signal,
  )
}

const ANIMATION_REFERENCE_TAGS = new Set([
  'BONE', 'LAYR', 'PAR_', 'RIB_', 'FOR_', 'WRP_', 'PROJ', 'LITE', 'CAM_',
])
function captureAnimationReferenceIds(sections, budget, signal) {
  const ordinals = new Map(), bindings = []
  const layerOwners = new Map()
  for (const { record, materialLayer } of materialLayerRecords(sections, { maxNodes: budget.maxNodes, signal })) {
    const owners = layerOwners.get(record) ?? []
    owners.push(materialLayer)
    layerOwners.set(record, owners)
  }
  for (const section of sections) {
    signal?.throwIfAborted()
    const tag = section.desc.history.name
    if (!ANIMATION_REFERENCE_TAGS.has(tag)) continue
    const sectionOrdinal = ordinals.get(tag) ?? 0
    ordinals.set(tag, sectionOrdinal + 1)
    for (const [recordIndex, record] of section.content.entries()) {
      for (const [field, value] of Object.entries(record)) {
        const header = value && typeof value === 'object' && !Array.isArray(value)
          ? value.header
          : undefined
        const animId = header && typeof header === 'object' && !Array.isArray(header)
          ? header.id
          : undefined
        if (!Number.isSafeInteger(animId) || animId < 0 || animId > 0xffffffff) continue
        const interpolation = header.interpolation
        const flags = header.flags
        if (!Number.isSafeInteger(interpolation) || interpolation < 0 || interpolation > 0xffffffff ||
            !Number.isSafeInteger(flags) || flags < 0 || flags > 0xffffffff)
          throw new TypeError('M3 animation reference header is invalid')
        const owners = tag === 'LAYR' ? layerOwners.get(record) : undefined
        for (const materialLayer of owners ?? [undefined]) {
          if (bindings.length >= budget.maxNodes)
            throw new RangeError('M3 animation reference bindings exceed node budget')
          bindings.push({ tag, sectionOrdinal, recordIndex, field, animId, interpolation, flags,
            ...(materialLayer === undefined ? {} : { materialLayer }) })
        }
      }
    }
  }
  return bindings
}

function arrayBufferOf(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function boundsOf(primitives) {
  if (primitives.length === 0) return undefined
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const primitive of primitives) {
    for (let offset = 0; offset < primitive.positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = primitive.positions[offset + axis]
        min[axis] = Math.min(min[axis], value)
        max[axis] = Math.max(max[axis], value)
      }
    }
  }
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) })
}

function regionIndices(
  faceIndices,
  firstFaceIndex,
  faceCount,
  firstVertexIndex,
  regionVersion,
  vertexCount,
) {
  const values = []
  const faceEnd = firstFaceIndex + faceCount
  for (let index = firstFaceIndex; index < faceEnd && index + 2 < faceIndices.length; index += 3) {
    const origin = regionVersion <= 2 ? firstVertexIndex : 0
    const a = (faceIndices[index] ?? 0) - origin
    const b = (faceIndices[index + 1] ?? 0) - origin
    const c = (faceIndices[index + 2] ?? 0) - origin
    if ([a, b, c].some(value => value < 0 || value >= vertexCount)) {
      throw new RangeError('M3 region face references a vertex outside the region')
    }
    values.push(a, b, c)
  }
  return new Uint32Array(values)
}

function decodeSections(sections, budget) {
  const model = sections.model
  if (model === null) throw new TypeError('M3 model section is missing')
  const vertexFlags = Number(model.vertex_flags ?? 0)
  const vertexSection = sections.getSectionByReference(model.vertices)
  const divisionSection = sections.getSectionByReference(model.divisions)
  if (vertexSection?.rawBytes === null || vertexSection === null || divisionSection === null) {
    return Object.freeze({
      nodes: [],
      meshes: [],
      primitives: [],
      meshPartitions: 0,
      decodedBytes: 0,
    })
  }
  const vertexDescription = M3StructureDescription.getVertexDescription(
    vertexFlags,
    sections.structureHistories,
  )
  const vertexCount = Math.floor(vertexSection.rawBytes.byteLength / vertexDescription.size)
  if (vertexCount > budget.maxNodes) throw new RangeError('M3 vertices exceed maxNodes budget')
  const vertices = vertexDescription.instances(vertexSection.rawBytes, vertexCount)
  const hasSkinning = (vertexFlags & 0x60) !== 0
  const boneLookup = (sections.getSectionByReference(model.bone_lookup)?.content ?? []).filter(
    value => typeof value === 'number',
  )
  const primitives = []
  let meshPartitions = 0
  let decodedBytes = 0

  for (const division of divisionSection.content) {
    const faceSection = sections.getSectionByReference(division.faces)
    const regionSection = sections.getSectionByReference(division.regions)
    if (regionSection === null) continue
    const regionOffset = meshPartitions
    meshPartitions += regionSection.content.length
    if (faceSection === null) continue
    const faces = faceSection.content
    for (const [regionIndex, region] of regionSection.content.entries()) {
      const firstVertexIndex = Number(region.first_vertex_index ?? 0)
      const count = Number(region.vertex_count ?? 0)
      const firstFaceIndex = Number(region.first_face_index ?? 0)
      const faceCount = Number(region.face_count ?? 0)
      const uvMultiply = Number(region.uv_multiply ?? 16)
      const uvOffset = Number(region.uv_offset ?? 0)
      if (
        !Number.isSafeInteger(firstVertexIndex) ||
        !Number.isSafeInteger(count) ||
        firstVertexIndex < 0 ||
        count < 0 ||
        firstVertexIndex + count > vertices.length
      ) {
        throw new RangeError('M3 region vertex range is invalid')
      }
      const positions = new Float32Array(count * 3)
      const normals = new Float32Array(count * 3)
      const textureCoordinates = new Float32Array(count * 2)
      const textureCoordinateSets = new Map()
      const tangents = new Float32Array(count * 4)
      const colors = new Float32Array(count * 4)
      const boneIndices = hasSkinning ? new Uint32Array(count * 4) : undefined
      const boneWeights = hasSkinning ? new Float32Array(count * 4) : undefined
      const firstBoneLookupIndex = Number(region.first_bone_lookup_index ?? 0)
      let normalCount = 0
      let tangentCount = 0
      let colorCount = 0
      for (let index = 0; index < count; index += 1) {
        const vertex = buildVertexObject(vertices[firstVertexIndex + index], uvMultiply, uvOffset)
        positions.set(vertex.position, index * 3)
        if (vertex.normal !== undefined) {
          normals.set(vertex.normal, index * 3)
          normalCount += 1
        }
        textureCoordinates.set(vertex.uv0 ?? vertex.fuv0 ?? [0, 0], index * 2)
        if (vertex.uv0 !== undefined || vertex.fuv0 !== undefined)
          textureCoordinateSets.set(0, textureCoordinates)
        // The pinned vertex decoder supports five packed UV sets and four float sets.
        for (let set = 1; set < 5; set += 1) {
          const coordinates = vertex[`uv${set}`] ?? vertex[`fuv${set}`]
          if (coordinates === undefined) continue
          if (!textureCoordinateSets.has(set))
            textureCoordinateSets.set(set, new Float32Array(count * 2))
          textureCoordinateSets.get(set).set(coordinates, index * 2)
        }
        if (vertex.tangent !== undefined) {
          tangents.set(vertex.tangent, index * 4)
          tangentCount += 1
        }
        if (vertex.color !== undefined) {
          colors.set(vertex.color, index * 4)
          colorCount += 1
        }
        if (boneIndices !== undefined && boneWeights !== undefined) {
          for (let influence = 0; influence < 4; influence += 1) {
            const lookupIndex = vertex.boneIndices?.[influence]
            boneIndices[index * 4 + influence] =
              lookupIndex === undefined ? 0 : (boneLookup[firstBoneLookupIndex + lookupIndex] ?? 0)
            boneWeights[index * 4 + influence] =
              vertex.weights?.[influence] ?? (influence === 0 ? 1 : 0)
          }
        }
      }
      const indices = regionIndices(
        faces,
        firstFaceIndex,
        faceCount,
        firstVertexIndex,
        Number(region.desc?.version ?? 0),
        count,
      )
      decodedBytes += positions.byteLength + indices.byteLength + textureCoordinates.byteLength
      if (normalCount > 0) decodedBytes += normals.byteLength
      if (tangentCount > 0) decodedBytes += tangents.byteLength
      if (colorCount === count) decodedBytes += colors.byteLength
      decodedBytes += (boneIndices?.byteLength ?? 0) + (boneWeights?.byteLength ?? 0)
      // The source owns a separate compatibility UV0 copy as well as all authored sets.
      for (const coordinates of textureCoordinateSets.values())
        decodedBytes += coordinates.byteLength
      if (decodedBytes > budget.maxScalarBytes) {
        throw new RangeError('M3 decoded geometry exceeds maxScalarBytes budget')
      }
      // Stable REGN ordinal even when an earlier division has no face data. Material batch
      // projection joins this identity before assigning the final dense draw-primitive ids.
      const primitiveId = `mesh-0-primitive-${regionOffset + regionIndex}`
      primitives.push({
        id: primitiveId,
        topology: 'triangles',
        positions,
        indices,
        ...(normalCount > 0 ? { normals } : {}),
        ...(tangentCount > 0 ? { tangents } : {}),
        ...(colorCount === count ? { colors } : {}),
        ...(boneIndices === undefined ? {} : { boneIndices, boneWeights }),
        textureCoordinates,
        textureCoordinateSets: [...textureCoordinateSets].map(([set, coordinates]) => ({
          set,
          coordinates,
        })),
        // REGN flag 0x4 (ClothSimulated) marks a cloth's simulation cage, which the game never
        // draws, simulated or not (WhiteoutFlakes). Drawn, it laid the garment's material over
        // the cage's own UVs. The geometry is kept, hidden.
        ...((Number(region.flags ?? 0) & 0x4) !== 0 ? { hidden: true } : {}),
      })
    }
  }
  // Keep the decoded REGN buffers in one scene mesh. The material-batch adapter expands their
  // draw primitives before publication, retaining every batch without inventing child nodes.
  const meshes =
    primitives.length === 0
      ? []
      : [
          {
            id: 'mesh-0',
            name: 'M3 model geometry',
            primitiveIds: primitives.map(primitive => primitive.id),
          },
        ]
  const bounds = boundsOf(primitives)
  return Object.freeze({
    nodes:
      meshes.length === 0
        ? []
        : [
            {
              id: 'node-0',
              name: 'M3 model',
              childIds: [],
              meshIds: ['mesh-0'],
              transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            },
          ],
    meshes,
    primitives,
    meshPartitions,
    decodedBytes,
    ...(bounds === undefined ? {} : { bounds }),
  })
}

export async function decodeM3Geometry(bytes, budget) {
  const sections = await M3SectionList.load(arrayBufferOf(bytes), await schemaText())
  return decodeSections(sections, budget)
}

/** Preserve schema fields through the same bounded native parser used for geometry. */
export async function decodeM3UvmSource(bytes, budget, signal, effectsPrimitives) {
  signal?.throwIfAborted()
  const sourceBytes = Uint8Array.from(bytes)
  const sections = await M3SectionList.load(sourceBytes.buffer, await schemaText())
  const { repairM3PhysicsSections, projectM3PhysicsBodies } =
    await import('../../../dist/m3/uvm/physics-native.js')
  repairM3PhysicsSections(
    sections,
    new Uint8Array(sections.fileBuffer),
    (type, buffer, offset) => {
      if (['uint8', 'uint16', 'uint32', 'float'].includes(type)) {
        const target = {}
        new M3FieldPrimitive('value', type).fromBuffer(target, buffer, offset)
        return target.value
      }
      return sections.structureHistories[type]
        .getVersion(0, sections.mdVersion, sections.structureHistories)
        .instance(buffer, offset)
    },
    budget,
    signal,
  )
  const metadata = { mdVersion: sections.mdVersion, ...m3MaterialLossMetadata(sections.model, sections) }
  const { buildHitVolumes, buildRigidBodies } = await import('../../../dist/m3/native/builder/metadata.js')
  const bodyRecords =
    sections.getSectionByReference(sections.model.physics_rigidbodies)?.content ?? []
  if (bodyRecords.length !== (sections.model.physics_rigidbodies?.entries ?? 0))
    throw new TypeError('M3 rigid body references are incomplete')
  for (const body of bodyRecords) {
    signal?.throwIfAborted()
    const shapes = sections.getSectionByReference(body.physics_shape)?.content ?? []
    if (shapes.length !== (body.physics_shape?.entries ?? 0))
      throw new TypeError('M3 rigid body shape references are incomplete')
  }
  const rigidBodies = snapshotJson(
    projectM3PhysicsBodies(sections, buildRigidBodies(sections.model, sections), budget, signal),
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  )
  const records = sections.getSectionByReference(sections.model.attachment_volumes)?.content ?? []
  const hitVolumes = buildHitVolumes(sections.model, sections)
  const projected = hitVolumes.attachmentVolumes
  if (
    records.length !== (sections.model.attachment_volumes?.entries ?? 0) ||
    projected.length !== records.length
  )
    throw new TypeError('M3 attachment volume extraction is incomplete')
  let meshBytes = 0
  const attachmentVolumes = projected.map(volume => {
    const raw = records[volume.index]
    if (!raw) throw new TypeError('M3 attachment volume source is absent')
    const result = {
      ...volume,
      bone1: raw.bone1,
      bone2: raw.bone2,
      vertices: raw.vertices.entries,
      faces: raw.face_data.entries,
    }
    if (volume.shape !== 4) return result
    signal?.throwIfAborted()
    const vertices = sections.getSectionByReference(raw.vertices)
    const faces = sections.getSectionByReference(raw.face_data)
    if (
      vertices?.desc.history.name !== 'VEC3' ||
      faces?.desc.history.name !== 'U16_' ||
      vertices.content.length !== result.vertices ||
      faces.content.length !== result.faces ||
      result.vertices === 0 ||
      result.faces === 0 ||
      result.faces % 3 !== 0
    )
      throw new TypeError('M3 attachment mesh has invalid VEC3/U16 references')
    meshBytes += result.vertices * 12 + result.faces * 2
    if (!Number.isSafeInteger(meshBytes) || meshBytes > budget.maxScalarBytes)
      throw new RangeError('M3 attachment mesh exceeds maxScalarBytes')
    const positions = new Float32Array(result.vertices * 3)
    for (let i = 0; i < result.vertices; i++) {
      if (i % 4096 === 0) signal?.throwIfAborted()
      const vertex = vertices.content[i]
      if (![vertex.x, vertex.y, vertex.z].every(Number.isFinite))
        throw new TypeError('M3 attachment mesh has nonfinite vertices')
      positions.set([vertex.x, vertex.y, vertex.z], i * 3)
    }
    const indices = new Uint16Array(result.faces)
    for (let i = 0; i < result.faces; i++) {
      if (i % 4096 === 0) signal?.throwIfAborted()
      const index = faces.content[i]
      if (!Number.isInteger(index) || index < 0 || index > 65535 || index >= result.vertices)
        throw new RangeError('M3 attachment mesh index exceeds vertices')
      indices[i] = index
    }
    return { ...result, mesh: { positions, indices } }
  })
  const effects =
    effectsPrimitives === undefined
      ? undefined
      : (await import('./effects.js')).projectM3Effects(sections, effectsPrimitives, budget, signal)
  const staticPreview = captureStaticPreview(sections, budget, signal)
  const animationReferenceIds = captureAnimationReferenceIds(sections, budget, signal)
  return {
    metadata,
    attachmentVolumes,
    hittests: hitVolumes.hittests,
    rigidBodies,
    effects,
    staticPreview,
    animationReferenceIds,
  }
}
