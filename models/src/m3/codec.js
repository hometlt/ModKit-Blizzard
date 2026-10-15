/** M3/M3A native owner: geometry, animation admission, source-free UVM and verified writers.
 * Explicit animationResources are read through Host and composed with the existing scene bundle
 * owner; native files remain unchanged. Model cameras retain bone linkage and authored FOV axis.
 */
import { projectM3MaterialBatches } from '../../dist/m3/material-batches.js'
import { projectM3SkinBindings } from '../../dist/m3/skeleton-projection.js'
import { bindM3SequenceIndices } from '../../dist/m3/uvm/animation-binding.js'
import { writeM3UvmRequest } from '../../dist/m3/uvm/write-operation.js'
import {
  bindM3MaterialTracks,
  bindM3MaterialTimelines,
} from '../../dist/m3/uvm/material-binding.js'
import {
  M3A_STANDALONE_ASSET_KIND,
  projectStandaloneM3Bundle,
} from '../../dist/m3/uvm/standalone.js'
import {
  createInspectionCodec,
  createModelAnimationSource,
  createModelCollisionSource,
  createModelMaterialSource,
  createModelResourceRefsSource,
  createModelSceneSource,
  createModelSkeletonSource,
  createModelCameraSource,
  createModelEffectSource,
  createModelLightSource,
  createModelNodeBehaviourSource,
  createModelPhysicsSource,
  createModelSocketSource,
  createProjectionReceipt,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { CANCELLED_CODE, throwIfAborted } from '@modkit/core'
import { createUvmConversionCache, createUvmJsonEditInputSchema } from '@modkit/scene/uvm'

/** M3 layer UV sources that sample a vertex UV set (0 explicit UV0, 6 particle flipbook over UV0,
 * 1 UV1, 9 UV2, 10 UV3), by the set they sample. */
const M3_UV_SET = new Map([
  [0, 0],
  [6, 0],
  [1, 1],
  [9, 2],
  [10, 3],
])

const TEXTURE_REQUIREMENT = 'textures'

/**
 * What one M3 source unit is, in metres, when the caller states nothing.
 *
 * A game's model units are a property of that game, not of the person converting: StarCraft II
 * authors at one unit to the cell a medium unit occupies, so its scale is 1. A caller with a
 * better number — a map that stores its own, a person typing one into the editing form — still
 * wins. This exists so a model nobody has told anything about converts at the size the game draws
 * it, instead of being refused.
 */
const M3_METERS_PER_SOURCE_UNIT = 1
const COUNTER_SEMANTICS = 'm3-declared-executable-v1'
/** Bytes `planInput` reads from the front of the file to find its string table. */
const PLAN_SCAN_BYTES = 512 * 1024
const MAX_TEXTURE_REFERENCES = 64
/** A reference must be a relative asset path; anything naming a location is refused. */
const LOCATION_LIKE = /^[A-Za-z]:|^[\\/]|(?:^|[\\/])\.\.(?:[\\/]|$)|^[a-z][a-z0-9+.-]*:/u
const TEXTURE_FILE = /\.(?:dds|tga)$/iu

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function reversedTag(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new TypeError('M3 tag is truncated')
  return String.fromCharCode(
    bytes[offset + 3],
    bytes[offset + 2],
    bytes[offset + 1],
    bytes[offset],
  ).replaceAll('\0', '')
}

function parseM3(bytes, maxNodes) {
  const tag = reversedTag(bytes, 0)
  if (tag !== 'MD33' && tag !== 'MD34') throw new TypeError(`unsupported M3 header ${tag}`)
  const headerBytes = tag === 'MD33' ? 20 : 24
  if (bytes.byteLength < headerBytes) throw new TypeError('M3 header is truncated')
  const view = viewOf(bytes)
  const indexOffset = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  if (indexCount > maxNodes) throw new RangeError('M3 section index exceeds maxNodes budget')
  const indexBytes = indexCount * 16
  if (
    !Number.isSafeInteger(indexBytes) ||
    indexOffset < headerBytes ||
    indexOffset + indexBytes > bytes.byteLength
  ) {
    throw new TypeError('M3 section index is outside the file')
  }
  const sections = []
  for (let index = 0; index < indexCount; index += 1) {
    const offset = indexOffset + index * 16
    const sectionOffset = view.getUint32(offset + 4, true)
    if (sectionOffset > bytes.byteLength)
      throw new TypeError(`M3 section ${index} is outside the file`)
    sections.push({
      index,
      tag: reversedTag(bytes, offset),
      offset: sectionOffset,
      repetitions: view.getUint32(offset + 8, true),
      version: view.getUint32(offset + 12, true),
      byteLength: 0,
    })
  }
  const orderedOffsets = [...new Set([...sections.map(section => section.offset), indexOffset])]
    .filter(offset => offset >= 0 && offset <= bytes.byteLength)
    .sort((left, right) => left - right)
  for (const section of sections) {
    const next = orderedOffsets.find(offset => offset > section.offset) ?? bytes.byteLength
    section.byteLength = Math.max(0, next - section.offset)
  }
  return Object.freeze({ tag, indexOffset, sections: Object.freeze(sections) })
}

const RAW_ROW_BYTES = 16

function hex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(' ')
}

function createM3NativeTreeSource(model, bytes) {
  const ref = (id, hasChildren) => Object.freeze({ id, hasChildren })
  const page = (items, request) => {
    if (!Number.isSafeInteger(request?.limit) || request.limit <= 0 || request.limit > 4096)
      throw new RangeError('M3 tree page limit must be between 1 and 4096')
    const start = request.cursor === undefined ? 0 : Number(request.cursor)
    if (!Number.isSafeInteger(start) || start < 0 || start > items.length)
      throw new TypeError('invalid M3 tree cursor')
    const values = items.slice(start, start + request.limit)
    return Object.freeze({
      items: Object.freeze(values),
      ...(start + values.length < items.length
        ? { nextCursor: String(start + values.length) }
        : {}),
    })
  }
  const fieldRef = (section, field) => ref(`m3:/sections/${section.index}/${field}`, false)
  const sectionRefs = model.sections.map(section => ref(`m3:/sections/${section.index}`, true))
  const rawRows = Math.ceil(bytes.byteLength / RAW_ROW_BYTES)
  return Object.freeze({
    async root() {
      return ref('m3:', true)
    },
    async children(node, request, signal) {
      signal?.throwIfAborted()
      if (node.id === 'm3:')
        return page(
          [ref('m3:/header', true), ref('m3:/sections', true), ref('m3:/raw', true)],
          request,
        )
      if (node.id === 'm3:/header')
        return page(
          ['tag', 'indexOffset', 'sectionCount'].map(field => ref(`m3:/header/${field}`, false)),
          request,
        )
      if (node.id === 'm3:/sections') return page(sectionRefs, request)
      if (node.id === 'm3:/raw') {
        if (!Number.isSafeInteger(request?.limit) || request.limit <= 0 || request.limit > 4096)
          throw new RangeError('M3 tree page limit must be between 1 and 4096')
        const start = request.cursor === undefined ? 0 : Number(request.cursor)
        if (!Number.isSafeInteger(start) || start < 0 || start > rawRows)
          throw new TypeError('invalid M3 raw tree cursor')
        const rows = []
        for (let index = start; index < Math.min(rawRows, start + request.limit); index += 1)
          rows.push(ref(`m3:/raw/${index * RAW_ROW_BYTES}`, false))
        return Object.freeze({
          items: Object.freeze(rows),
          ...(start + rows.length < rawRows ? { nextCursor: String(start + rows.length) } : {}),
        })
      }
      const sectionMatch = /^m3:\/sections\/(\d+)$/u.exec(node.id)
      if (sectionMatch !== null) {
        const section = model.sections[Number(sectionMatch[1])]
        if (section === undefined) throw new TypeError('unknown M3 section')
        return page(
          ['tag', 'version', 'repetitions', 'offset', 'byteLength'].map(field =>
            fieldRef(section, field),
          ),
          request,
        )
      }
      return page([], request)
    },
    async facts(node) {
      if (node.id === 'm3:')
        return Object.freeze({
          kind: 'model',
          label: `${model.tag} native document`,
          preview: `${bytes.byteLength} bytes`,
        })
      if (node.id === 'm3:/header') return Object.freeze({ kind: 'structure', label: 'Header' })
      if (node.id === 'm3:/sections')
        return Object.freeze({
          kind: 'collection',
          label: 'Sections',
          preview: `${model.sections.length}`,
        })
      if (node.id === 'm3:/raw')
        return Object.freeze({
          kind: 'binary',
          label: 'Raw native bytes',
          preview: `${bytes.byteLength} bytes, editable in ${RAW_ROW_BYTES}-byte rows`,
        })
      const headerField = /^m3:\/header\/(tag|indexOffset|sectionCount)$/u.exec(node.id)?.[1]
      if (headerField !== undefined) {
        const values = {
          tag: model.tag,
          indexOffset: model.indexOffset,
          sectionCount: model.sections.length,
        }
        return Object.freeze({
          kind: typeof values[headerField],
          label: headerField,
          value: values[headerField],
          semanticPath: Object.freeze(['header', headerField]),
        })
      }
      const sectionMatch =
        /^m3:\/sections\/(\d+)(?:\/(tag|version|repetitions|offset|byteLength))?$/u.exec(node.id)
      if (sectionMatch !== null) {
        const section = model.sections[Number(sectionMatch[1])]
        if (section === undefined) throw new TypeError('unknown M3 section')
        const field = sectionMatch[2]
        if (field === undefined)
          return Object.freeze({
            kind: 'section',
            label: `${section.index}: ${section.tag}`,
            preview: `v${section.version}, ${section.repetitions} record(s), ${section.byteLength} bytes`,
            spans: Object.freeze([
              {
                bindingId: 'content',
                offset: BigInt(section.offset),
                length: BigInt(section.byteLength),
              },
            ]),
          })
        return Object.freeze({
          kind: typeof section[field],
          label: field,
          value: section[field],
          semanticPath: Object.freeze(['sections', String(section.index), field]),
        })
      }
      const rawMatch = /^m3:\/raw\/(\d+)$/u.exec(node.id)
      if (rawMatch !== null) {
        const offset = Number(rawMatch[1])
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= bytes.byteLength ||
          offset % RAW_ROW_BYTES !== 0
        )
          throw new TypeError('unknown M3 raw row')
        const value = hex(
          bytes.subarray(offset, Math.min(bytes.byteLength, offset + RAW_ROW_BYTES)),
        )
        return Object.freeze({
          kind: 'binary-row',
          label: `0x${offset.toString(16).padStart(8, '0')}`,
          value,
          preview: value,
          type: Object.freeze({ kind: 'text' }),
          semanticPath: Object.freeze(['raw', String(offset)]),
          editable: Object.freeze({ write: Object.freeze({ operation: 'edit.field' }) }),
          spans: Object.freeze([
            {
              bindingId: 'content',
              offset: BigInt(offset),
              length: BigInt(Math.min(RAW_ROW_BYTES, bytes.byteLength - offset)),
            },
          ]),
        })
      }
      throw new TypeError('unknown M3 tree node')
    },
    async *search(query, signal) {
      const needle = query.pattern.toLowerCase()
      for (const section of model.sections) {
        signal?.throwIfAborted()
        if (`${section.index} ${section.tag} ${section.version}`.toLowerCase().includes(needle))
          yield ref(`m3:/sections/${section.index}`, true)
      }
    },
  })
}

function nativeFieldHandler(bytes, context) {
  return async (input, options = {}) => {
    const signal = options.signal ?? context.signal
    const request = snapshotJson(
      input,
      {
        maxBytes: context.budget.maxScalarBytes,
        maxNodes: context.budget.maxNodes,
        maxDepth: context.budget.maxDepth,
      },
      signal,
    )
    if (request === null || typeof request !== 'object' || Array.isArray(request))
      throw new TypeError('M3 native field request must be an object')
    const path = request.path
    if (
      request.groupId !== 'tree' ||
      !Array.isArray(path) ||
      path.length !== 2 ||
      path[0] !== 'raw' ||
      typeof path[1] !== 'string' ||
      request.key !== path[1] ||
      typeof request.value !== 'string' ||
      Object.keys(request).some(key => !['groupId', 'key', 'path', 'value'].includes(key))
    )
      throw new TypeError('M3 native field write requires one complete raw row path')
    const offset = Number(path[1])
    const expected = Math.min(RAW_ROW_BYTES, bytes.byteLength - offset)
    const tokens = request.value.trim() === '' ? [] : request.value.trim().split(/\s+/u)
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % RAW_ROW_BYTES !== 0 ||
      expected <= 0 ||
      tokens.length !== expected ||
      tokens.some(token => !/^[0-9a-f]{2}$/iu.test(token))
    )
      throw new TypeError('M3 native row must contain the exact number of hexadecimal bytes')
    const candidate = bytes.slice()
    candidate.set(
      tokens.map(token => Number.parseInt(token, 16)),
      offset,
    )
    parseM3(candidate, context.budget.maxNodes)
    const base = editPlanFromInput(context.input, {
      planId: `m3-native-edit:${context.input.revisions.revision}`,
      edits: [],
      fidelity: {
        roundTrip: 'byte-identical',
        preservesUnknownData: true,
        notes: [
          'Only the explicitly selected native byte row changes; the M3 container index is revalidated.',
        ],
      },
    })
    const target =
      base.targets.find(item => item.targetId === context.input.primaryBindingId) ?? base.targets[0]
    if (target === undefined) throw new TypeError('M3 native edit has no target')
    const digest = await sha256Hex(candidate)
    return {
      kind: 'edit-plan',
      plan: Object.freeze({
        ...base,
        planId: `${base.planId}:${digest}`,
        edits: Object.freeze([
          Object.freeze({
            ...replaceBytes(0, bytes.byteLength, candidate, 'Edit native M3 bytes'),
            targetId: target.targetId,
            source: target.ownerSource,
          }),
        ]),
      }),
    }
  }
}

function metadataSceneOf(model, animations, materials, textures, skeletonNodes = []) {
  const sectionNodes = model.sections.map(section => ({
    id: `section/${section.index}`,
    name: `${section.tag} v${section.version}`,
    childIds: [],
    meshIds: [],
    transform: IDENTITY,
  }))
  return createModelSceneSource({
    info: {
      scenes: 1,
      nodes: sectionNodes.length + skeletonNodes.length + 1,
      meshes: 0,
      primitives: 0,
      materials,
      textures,
      animations,
      // StarCraft II publishes z-up geometry; a viewer that assumed the glTF default would
      // lay the model on its side.
      upAxis: '+z',
      geometryAccess: 'metadata-only',
    },
    nodes: [
      {
        id: 'model',
        name: `${model.tag} section graph`,
        childIds: sectionNodes.map(node => node.id),
        meshIds: [],
        transform: IDENTITY,
      },
      ...sectionNodes,
      ...skeletonNodes,
    ],
    meshes: [],
  })
}

function decodedSceneOf(geometry, animations, materials, textures) {
  return createModelSceneSource({
    info: {
      scenes: 1,
      nodes: geometry.nodes.length,
      meshes: geometry.meshes.length,
      primitives: geometry.primitives.length,
      materials,
      textures,
      animations,
      ...(geometry.bounds === undefined ? {} : { bounds: geometry.bounds }),
      // StarCraft II publishes z-up geometry; a viewer that assumed the glTF default would
      // lay the model on its side.
      upAxis: '+z',
      geometryAccess: 'decoded',
    },
    nodes: geometry.nodes,
    meshes: geometry.meshes,
    primitives: geometry.primitives,
  })
}

async function geometryOf(bytes, budget) {
  const { decodeM3Geometry } = await import('./runtime/geometry.js')
  return decodeM3Geometry(bytes, budget)
}

async function skeletonOf(bytes, budget, signal) {
  const { decodeM3Skeleton } = await import('./runtime/skeleton.js')
  return decodeM3Skeleton(bytes, budget, signal)
}

async function animationOf(bytes, budget, signal) {
  const { decodeM3Animations } = await import('./runtime/animation.js')
  return decodeM3Animations(bytes, budget, signal)
}

async function materialOf(bytes, budget, signal) {
  const { decodeM3Materials } = await import('./runtime/material.js')
  return decodeM3Materials(bytes, budget, signal)
}

async function attachmentOf(bytes, budget, signal) {
  const { decodeM3Attachments } = await import('./runtime/attachments.js')
  return decodeM3Attachments(bytes, budget, signal)
}

/**
 * The emitters and fields an M3 declares, as facet records.
 *
 * The decoder already reads every one of these for the UVM export; this restates them in the
 * common vocabulary so a viewer can list them without knowing what an M3 is. Parameters are
 * carried in the model's own words, because `squirt` and `tailLength` have no portable meaning.
 */
const EFFECT_KINDS = Object.freeze([
  ['particles', 'particle'],
  ['ribbons', 'ribbon'],
  ['forces', 'force'],
  ['warps', 'warp'],
  ['projectors', 'projector'],
])

/** Fields that are addresses into other facets rather than settings of the effect itself. */
const EFFECT_ADDRESS_KEYS = Object.freeze([
  'name',
  'boneIndex',
  'materialIndex',
  'texturePath',
])

function effectRecordsOf(effects) {
  if (effects === null || typeof effects !== 'object') return []
  const records = []
  for (const [field, kind] of EFFECT_KINDS) {
    const list = effects[field]
    if (!Array.isArray(list)) continue
    for (const [ordinal, entry] of list.entries()) {
      if (entry === null || typeof entry !== 'object') continue
      const properties = []
      for (const [key, value] of Object.entries(entry)) {
        if (EFFECT_ADDRESS_KEYS.includes(key)) continue
        // A track is an animated value; the record says so rather than printing an object.
        if (value !== null && typeof value === 'object') {
          // A track is an animated value and says so; a list is structured data that does not fit a
          // scalar, and calling it animated would be a claim the file never made.
          if (Array.isArray(value)) properties.push({ key, value: 'list' })
          else properties.push({ key, value: 'track', animated: true })
          continue
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          properties.push({ key, value })
      }
      records.push({
        id: `${kind}-${String(ordinal)}`,
        kind,
        ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
        ...(Number.isSafeInteger(entry.boneIndex)
          ? { nodeId: `bone/${String(entry.boneIndex)}` }
          : {}),
        ...(Number.isSafeInteger(entry.materialIndex)
          ? { materialId: `material/${String(entry.materialIndex)}` }
          : {}),
        ...(typeof entry.texturePath === 'string' && entry.texturePath !== ''
          ? { resourceId: entry.texturePath }
          : {}),
        ...(properties.length === 0 ? {} : { properties }),
      })
    }
  }
  return records
}

/** Scalars an M3 record carries, minus the fields that are addresses into other facets. */
function propertiesOf(record, addresses) {
  const properties = []
  for (const [key, value] of Object.entries(record)) {
    if (addresses.includes(key)) continue
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) properties.push({ key, value: 'list' })
      else properties.push({ key, value: 'track', animated: true })
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      properties.push({ key, value })
  }
  return properties
}

const boneNodeId = index =>
  Number.isSafeInteger(index) && index >= 0 ? `bone/${String(index)}` : undefined

/**
 * Lights, cameras, simulation bodies and runtime node behaviours, as facet records.
 *
 * Every one of these is already extracted by the frozen MK2 builders for the UVM export; this
 * restates them in the common vocabulary. The typed fields are the ones a consumer can act on
 * without knowing the format — a light's colour, a camera's field of view, a joint's two nodes —
 * and everything else stays in the model's own words.
 */
async function nativeMetadataOf(bytes, budget, signal) {
  try {
    const { M3SectionList } = await import('../../dist/m3/native/binary/sections.js')
    const { schemaText } = await import('./runtime/schema.js')
    const {
      buildLights,
      buildCameras,
      buildTurrets,
      buildIk,
      buildBillboards,
      buildRigidBodies,
      buildPhysicsJoints,
      buildPhysicsCloths,
    } = await import('../../dist/m3/native/builder/metadata.js')
    const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, await schemaText())
    const model = sections.model
    if (model === null) return undefined
    signal?.throwIfAborted()
    return {
      lights: buildLights(model, sections),
      cameras: buildCameras(model, sections),
      turrets: buildTurrets(model, sections),
      ik: buildIk(model, sections),
      billboards: buildBillboards(model, sections),
      rigidBodies: buildRigidBodies(model, sections),
      joints: buildPhysicsJoints(model, sections),
      cloths: buildPhysicsCloths(model, sections),
    }
  } catch {
    // A model whose optional sections cannot be read still inspects; these facets are simply
    // absent, exactly as they are for an M3 that declares none of them.
    return undefined
  }
}

const LIGHT_KINDS = Object.freeze(['directional', 'point', 'spot'])

function lightRecordsOf(native) {
  return (native?.lights ?? []).map((light, ordinal) => ({
    id: `light-${String(light.index ?? ordinal)}`,
    // M3 states the shape as a number; its own `shape` string is used where it wrote one.
    kind:
      typeof light.shape === 'string' && light.shape !== ''
        ? light.shape.toLowerCase()
        : (LIGHT_KINDS[light.type] ?? 'light'),
    ...(light.name ? { name: light.name } : {}),
    ...(boneNodeId(light.boneIndex) === undefined
      ? {}
      : { nodeId: boneNodeId(light.boneIndex) }),
    ...(Array.isArray(light.color) && light.color.length >= 3
      ? { color: [light.color[0], light.color[1], light.color[2]] }
      : {}),
    ...(Number.isFinite(light.intensity) ? { intensity: light.intensity } : {}),
    properties: propertiesOf(light, ['index', 'name', 'boneIndex', 'shape', 'type', 'color', 'intensity']),
  }))
}

function cameraRecordsOf(native) {
  return (native?.cameras ?? []).map((camera, ordinal) => ({
    id: `camera-${String(camera.index ?? ordinal)}`,
    fieldOfViewAxis: camera.useVerticalFov ? 'vertical' : 'horizontal',
    ...(camera.name ? { name: camera.name } : {}),
    ...(boneNodeId(camera.boneIndex) === undefined
      ? {}
      : { nodeId: boneNodeId(camera.boneIndex) }),
    ...(Number.isFinite(camera.fieldOfView) ? { fieldOfViewRadians: camera.fieldOfView } : {}),
    ...(Number.isFinite(camera.nearClip) ? { nearClip: camera.nearClip } : {}),
    ...(Number.isFinite(camera.farClip) ? { farClip: camera.farClip } : {}),
    properties: propertiesOf(camera, [
      'index',
      'name',
      'boneIndex',
      'fieldOfView',
      'nearClip',
      'farClip',
    ]),
  }))
}

function physicsRecordsOf(native) {
  const records = []
  for (const [ordinal, body] of (native?.rigidBodies ?? []).entries()) {
    records.push({
      id: `rigid-body-${String(body.index ?? ordinal)}`,
      kind: 'rigid-body',
      ...(body.name ? { name: body.name } : {}),
      ...(boneNodeId(body.boneIndex) === undefined ? {} : { nodeId: boneNodeId(body.boneIndex) }),
      ...(typeof body.shape === 'string' && body.shape !== ''
        ? { shape: body.shape.toLowerCase() }
        : {}),
      properties: propertiesOf(body, ['index', 'name', 'boneIndex', 'shape', 'shapes']),
    })
    for (const [shapeOrdinal, shape] of (body.shapes ?? []).entries())
      records.push({
        id: `rigid-body-${String(body.index ?? ordinal)}-shape-${String(shapeOrdinal)}`,
        kind: 'shape',
        ...(boneNodeId(body.boneIndex) === undefined ? {} : { nodeId: boneNodeId(body.boneIndex) }),
        ...(typeof shape.shape === 'string' ? { shape: shape.shape.toLowerCase() } : {}),
        properties: propertiesOf(shape, ['index', 'shape', 'matrix4', 'vertices']),
      })
  }
  for (const [ordinal, joint] of (native?.joints ?? []).entries())
    records.push({
      id: `joint-${String(joint.index ?? ordinal)}`,
      kind: 'joint',
      ...(joint.name ? { name: joint.name } : {}),
      ...(boneNodeId(joint.boneIndex0) === undefined ? {} : { nodeId: boneNodeId(joint.boneIndex0) }),
      ...(boneNodeId(joint.boneIndex1) === undefined
        ? {}
        : { secondNodeId: boneNodeId(joint.boneIndex1) }),
      properties: propertiesOf(joint, [
        'index',
        'name',
        'boneIndex0',
        'boneIndex1',
        'boneName0',
        'boneName1',
      ]),
    })
  for (const [ordinal, cloth] of (native?.cloths ?? []).entries())
    records.push({
      id: `cloth-${String(cloth.index ?? ordinal)}`,
      kind: 'cloth',
      ...(cloth.name ? { name: cloth.name } : {}),
      properties: propertiesOf(cloth, ['index', 'name', 'boneIndices']),
    })
  return records
}

function behaviourRecordsOf(native) {
  const records = []
  for (const [ordinal, turret] of (native?.turrets ?? []).entries()) {
    const nodeIds = (turret.parts ?? [])
      .map(part => boneNodeId(part.boneIndex))
      .filter(id => id !== undefined)
    records.push({
      id: `turret-${String(turret.index ?? ordinal)}`,
      kind: 'turret',
      ...(turret.name ? { name: turret.name } : {}),
      ...(nodeIds.length === 0 ? {} : { nodeId: nodeIds[0], nodeIds }),
      properties: [{ key: 'parts', value: (turret.parts ?? []).length }],
    })
  }
  for (const [ordinal, chain] of (native?.ik ?? []).entries()) {
    const nodeIds = [chain.boneIndex, chain.targetBoneIndex, chain.effectorBoneIndex]
      .map(boneNodeId)
      .filter(id => id !== undefined)
    records.push({
      id: `ik-${String(chain.index ?? ordinal)}`,
      kind: 'ik',
      ...(chain.name ? { name: chain.name } : {}),
      ...(boneNodeId(chain.boneIndex) === undefined ? {} : { nodeId: boneNodeId(chain.boneIndex) }),
      ...(nodeIds.length === 0 ? {} : { nodeIds }),
      properties: propertiesOf(chain, [
        'index',
        'name',
        'boneIndex',
        'targetBoneIndex',
        'effectorBoneIndex',
      ]),
    })
  }
  for (const [ordinal, billboard] of (native?.billboards ?? []).entries())
    records.push({
      id: `billboard-${String(billboard.index ?? ordinal)}`,
      kind: 'billboard',
      ...(billboard.name ? { name: billboard.name } : {}),
      ...(boneNodeId(billboard.boneIndex) === undefined
        ? {}
        : { nodeId: boneNodeId(billboard.boneIndex) }),
      properties: propertiesOf(billboard, ['index', 'name', 'boneIndex']),
    })
  return records
}

async function effectsOf(bytes, budget, signal, primitives) {
  try {
    const { decodeM3Effects } = await import('./runtime/effects.js')
    return await decodeM3Effects(bytes, budget, signal, primitives)
  } catch {
    // An unreadable effect section is not a reason to refuse the whole model: the facet is simply
    // absent, exactly as it is for an M3 that declares no emitters.
    return undefined
  }
}

/**
 * The places an M3's textures are looked for, in priority order.
 *
 * The path the document spells is always first: inside a mod, or in a copy that kept the game's
 * asset layout, it is simply right. The rest exist because a model carried out of its mod keeps
 * naming `Assets/Textures/Foo.dds` while the file now sits beside it, or one folder down in
 * `Textures/` — the two arrangements an exported model actually arrives in.
 *
 * Only the directories are listed here; the host pairs each with the referenced file's own name
 * and stops at the first that resolves.
 */
function textureSpellings(names) {
  const patterns = [...names]
  for (const directory of ['Textures', 'Assets/Textures']) {
    for (const name of names) {
      const bare = name.replaceAll('\\', '/').split('/').at(-1) ?? name
      const spelling = `${directory}/${bare}`
      if (!patterns.includes(spelling)) patterns.push(spelling)
    }
  }
  return patterns
}

/**
 * Texture paths an M3 names, read from its own `CHAR` string table.
 *
 * M3 keeps every string in `CHAR` sections and points at them from `LAYR` entries. Following that
 * indirection means decoding the layer records; reading the string table does not, and the paths
 * are unambiguous on their own — `Assets/Textures/SM_HML_Artifact_diff512.dds` is a texture
 * reference whichever layer points at it. So this walks the section index (fixed-size headers, no
 * record decoding) and collects the strings that name a texture file.
 *
 * These are *paths*, not bare names, and that matters on the host side too: the resolver matches a
 * pattern containing `/` against the whole logical id and derives a listing prefix from it, so a
 * container with hundreds of thousands of entries is searched by directory instead of scanned.
 */
function scanTextureReferences(bytes) {
  const empty = Object.freeze({ names: Object.freeze([]), truncated: true })
  const tag = bytes.byteLength >= 4 ? reversedTag(bytes, 0) : ''
  if (tag !== 'MD33' && tag !== 'MD34') return empty
  const headerBytes = tag === 'MD33' ? 20 : 24
  if (bytes.byteLength < headerBytes) return empty
  const view = viewOf(bytes)
  const indexOffset = view.getUint32(4, true)
  const indexCount = view.getUint32(8, true)
  const indexBytes = indexCount * 16
  if (
    !Number.isSafeInteger(indexBytes) ||
    indexOffset < headerBytes ||
    indexOffset + indexBytes > bytes.byteLength
  ) {
    // the scan window cut the index, or the file is malformed: declare nothing rather than guess
    return empty
  }
  const sections = []
  for (let index = 0; index < indexCount; index += 1) {
    const offset = indexOffset + index * 16
    sections.push({ tag: reversedTag(bytes, offset), offset: view.getUint32(offset + 4, true) })
  }
  const bounds = [...new Set([...sections.map(section => section.offset), indexOffset])]
    .filter(offset => offset >= 0 && offset <= bytes.byteLength)
    .sort((left, right) => left - right)
  const decoder = new TextDecoder('latin1')
  const names = []
  const seen = new Set()
  let truncated = false
  for (const section of sections) {
    if (section.tag !== 'CHAR' || section.offset > bytes.byteLength) continue
    const end = bounds.find(offset => offset > section.offset) ?? bytes.byteLength
    for (const part of decoder.decode(bytes.subarray(section.offset, end)).split('\u0000')) {
      const value = part.trim()
      if (!TEXTURE_FILE.test(value) || LOCATION_LIKE.test(value)) continue
      const normalized = value.split(String.fromCharCode(92)).join('/')
      const key = normalized.toLowerCase()
      if (seen.has(key)) continue
      if (names.length >= MAX_TEXTURE_REFERENCES) {
        truncated = true
        break
      }
      seen.add(key)
      names.push(normalized)
    }
  }
  return Object.freeze({ names: Object.freeze(names), truncated })
}

/** Reads the texture bindings the host resolved; the codec binds them, it does not decode them. */
async function readTextureBindings(input, signal) {
  const bindings = input.bindingsFor?.(TEXTURE_REQUIREMENT) ?? []
  const resolved = []
  for (const binding of bindings) {
    const lease = await input.openBinding(binding.bindingId, signal)
    try {
      if (lease.value.kind !== 'bytes') continue
      resolved.push(
        Object.freeze({
          bindingId: binding.bindingId,
          uri: binding.source.uri,
          bytes: Number(lease.value.size ?? 0n),
        }),
      )
    } finally {
      await lease.release()
    }
  }
  return Object.freeze(resolved)
}

/**
 * The axes M3 vertex positions arrive in — the file's own, because nothing converts them.
 *
 * `preserved`, not `normalized`: the decoder copies each position verbatim, so the projected space
 * is the M3 space. Z-up right-handed with +X forward is the format's documented convention rather
 * than something read out of these bytes, which is why the receipt states it as `declared`.
 */
const M3_BASIS = Object.freeze({
  handedness: 'right',
  upAxis: 'z',
  forwardAxis: '+x',
  unit: 'source-unit',
  sourceUnit: 'm3-model-unit',
})

async function animationSidecarsOf(bytes, attachments, context) {
  const empty = { clips: [], references: [], accepted: [], provenance: [], diagnostics: [] }
  const hasHashes = (attachments?.animationHashes.length ?? 0) > 0
  const resources = context.logicalResources
  let code = 'm3a-discovery-unavailable'
  let message =
    'M3A binding hashes are declared, but this open has no logical resource discovery capability'
  if (resources !== undefined && typeof resources.discover === 'function') {
    try {
      const { discoverM3AnimationSidecars } = await import('./runtime/sidecar-projection.js')
      return await discoverM3AnimationSidecars({
        baseBytes: bytes,
        candidateDiscovery: {
          discover: signal =>
            resources.discover({ role: 'sidecar', extension: '.m3a', timeoutMs: 5000 }, signal),
        },
        resources,
        budget: context.budget,
        signal: context.signal,
        includeSources: true,
        // The main inspection already publishes these base decoder issues exactly once.
        includeBaseDiagnostics: false,
      })
    } catch (error) {
      throwIfAborted(context.signal)
      if (error?.code === CANCELLED_CODE || error?.name === 'AbortError') throw error
      // Invalid provider candidate data cannot turn a readable base into partially attached clips.
      // Host lifecycle/permission errors remain errors; they must not publish a stale descriptor.
      if (!(error instanceof TypeError)) throw error
      code = 'm3a-discovery-invalid'
      message = error.message
    }
  }
  if (!hasHashes) return empty
  return {
    ...empty,
    diagnostics: [
      {
        id: `x3.m3/${code}`,
        code: `x3.m3/${code}`,
        category: 'dependency',
        severity: 'warning',
        message,
      },
    ],
  }
}

/** The attested entrypoint fixes interpretation before any asynchronous probe or inspection. */
export function createM3FamilyCodec(context, sourceFormat = 'm3') {
  if (sourceFormat !== 'm3' && sourceFormat !== 'm3a')
    throw new TypeError('M3 codec source format must be m3 or m3a')
  const standalone = sourceFormat === 'm3a'
  const ID = standalone ? 'blizzard/m3a' : 'blizzard/m3'
  const definition = Object.freeze({
    id: ID,
    version: '1.0.0',
    deferInspection: true,
    format: Object.freeze({
      id: sourceFormat,
      label: standalone ? 'StarCraft II M3A animation bundle' : 'StarCraft II M3/M3A',
    }),
    operations: Object.freeze([
      Object.freeze({
        id: 'model.render',
        handlerId: 'render-m3-scene',
        mutatesSource: false,
        requiredPermissions: Object.freeze(['read-source']),
        outputKinds: Object.freeze(['bytes']),
      }),
      Object.freeze({
        id: 'model.edit',
        handlerId: 'edit-m3-scene',
        inputSchema: createUvmJsonEditInputSchema({
          reference: 'modkit://blizzard/m3/model-edit-v1',
          baseInput: { schemaVersion: 1 },
          fields: [
            {
              key: 'metersPerSourceUnit',
              label: 'Meters per source unit',
              type: { kind: 'number', min: Number.MIN_VALUE, unit: 'm' },
              inputPath: ['metersPerSourceUnit'],
              required: true,
              initial: 1,
              description:
                'Use the same scale as your exported model working document. For example, 2 means each original model unit represents two meters.',
            },
          ],
        }),
        mutatesSource: true,
        requiredPermissions: Object.freeze(['read-source', 'write-source']),
        outputKinds: Object.freeze(['edit-plan']),
      }),
      Object.freeze({
        id: 'edit.field',
        handlerId: 'edit-m3-native-field',
        mutatesSource: true,
        requiredPermissions: Object.freeze(['read-source', 'write-source']),
        outputKinds: Object.freeze(['edit-plan']),
      }),
      Object.freeze({
        id: 'model.export-uvm',
        ...(!standalone ? {inputSchema: {"$ref":"modkit://blizzard/m3/export-uvm.v1","document":{"type":"object","required":["schemaVersion"],"additionalProperties":false,"properties":{"schemaVersion":{"const":1},"metersPerSourceUnit":{"type":"number","exclusiveMinimum":0},"parameters":{"type":"object","additionalProperties":{"type":"string"}},"animationNames":{"type":"array","minItems":1,"maxItems":128,"items":{"type":"string","minLength":1,"maxLength":512},"description":"Presentation subset of M3A animation-property requests; names containing all requested properties with the fewest extra properties are selected across attachments, retaining tied variants. Omit for full attachment."},"animationResources":{"type":"array","maxItems":64,"items":{"type":"object","required":["id","logicalId","role","scopes"],"additionalProperties":false,"properties":{"id":{"type":"string","minLength":1},"logicalId":{"type":"string","minLength":1},"role":{"const":"sidecar"},"scopes":{"type":"array","items":{"type":"string"}},"parentResourceId":{"type":"string"},"alternatives":{"type":"array","items":{"type":"string"}}}}}}}}} : {}),
        handlerId: 'model-export-uvm',
        mutatesSource: false,
        requiredPermissions: Object.freeze(['read-source']),
        outputKinds: Object.freeze(['bytes']),
      }),
      Object.freeze({
        id: 'model.write',
        handlerId: 'model-write',
        mutatesSource: false,
        requiredPermissions: Object.freeze(['read-source']),
        outputKinds: Object.freeze(['bytes']),
      }),
    ]),
    async planInput(source, _detection, signal) {
      if (standalone) {
        return Object.freeze({
          originKind: 'single',
          candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' }),
          requirements: Object.freeze([]),
        })
      }
      const size = Number(source.size ?? 0n)
      const window = Math.min(size, PLAN_SCAN_BYTES)
      const bytes = window === 0 ? new Uint8Array(0) : await source.read(0n, window, signal)
      const scan = scanTextureReferences(bytes)
      if (scan.names.length === 0) {
        return Object.freeze({
          originKind: 'single',
          candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' }),
          requirements: Object.freeze([]),
        })
      }
      return Object.freeze({
        originKind: 'bundle',
        candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' }),
        requirements: Object.freeze([
          Object.freeze({
            id: TEXTURE_REQUIREMENT,
            role: 'texture',
            ownership: 'companion',
            /*
             * The name the document spells, then the directories an M3's textures actually sit in.
             *
             * A Blizzard model names a texture by file name and expects the game's own asset
             * layout to supply the folder. Outside a mod that folder is usually beside the model:
             * a loose export keeps its `Textures/`, and a copy taken out of an SC2Mod keeps
             * `Assets/Textures/`. The host tries these in this order and stops at the first hit,
             * so a texture beside the model still wins over one a layer down.
             */
            patterns: Object.freeze(textureSpellings(scan.names)),
            scopes: Object.freeze([
              'sibling-directory',
              'workspace-dependency-layer',
              'current-mount',
              'enclosing-container',
            ]),
            // an M3 whose textures ship in another mod layer is a complete, readable model
            cardinality: 'many',
            required: false,
          }),
        ]),
      })
    },
    async detect(prefix) {
      const tag = prefix.byteLength >= 4 ? reversedTag(prefix, 0) : ''
      return tag === 'MD33' || tag === 'MD34'
        ? {
            confidence: standalone ? 1 : 0.99,
            kind: 'magic',
            note: standalone ? `${tag}; host-selected M3A suffix contribution` : tag,
          }
        : { confidence: 0, kind: 'magic', note: 'signature-mismatch' }
    },
    async inspect(bytes, context) {
      const model = parseM3(bytes, context.budget.maxNodes)
      const scannedReferences = scanTextureReferences(bytes)
      const skeleton = await skeletonOf(bytes, context.budget, context.signal)
      const baseAnimation = await animationOf(bytes, context.budget, context.signal)
      let material = await materialOf(bytes, context.budget, context.signal)
      const baseMaterial = material
      const references = material?.resourceReferences ?? scannedReferences
      const attachments = await attachmentOf(bytes, context.budget, context.signal)
      const skeletonBudgetRefusal = skeleton?.issues.find(
        item => item.code === 'x3.m3/skeleton-budget-exceeded',
      )
      if (skeletonBudgetRefusal !== undefined) {
        // A resource budget is a hard host boundary, not a feature that may silently disappear.
        // Structural BONE damage remains inspectable below, but exhaustion must fail closed just as
        // the geometry decoder does.
        throw new RangeError(`M3 ${skeletonBudgetRefusal.message}`)
      }
      const animationBudgetRefusal = baseAnimation?.issues.find(
        item => item.code === 'x3.m3/animation-budget-exceeded',
      )
      if (animationBudgetRefusal !== undefined) {
        throw new RangeError(`M3 ${animationBudgetRefusal.message}`)
      }
      const materialBudgetRefusal = material?.issues.find(
        item => item.code === 'x3.m3/material-budget-exceeded',
      )
      if (materialBudgetRefusal !== undefined) {
        throw new RangeError(`M3 ${materialBudgetRefusal.message}`)
      }
      const attachmentBudgetRefusal = attachments?.issues.find(
        item => item.code === 'x3.m3/attachment-budget-exceeded',
      )
      if (attachmentBudgetRefusal !== undefined) {
        throw new RangeError(`M3 ${attachmentBudgetRefusal.message}`)
      }
      const sidecars = standalone
        ? { clips: [], references: [], accepted: [], provenance: [], diagnostics: [] }
        : await animationSidecarsOf(bytes, attachments, context)
      const sequenceBindings = bindM3SequenceIndices(
        {
          clips: baseAnimation?.clips ?? [],
          nativeSequenceIndices: baseAnimation?.nativeSequenceIndices ?? [],
        },
        sidecars.accepted.map(item => ({
          logicalId: item.logicalId,
          clips: item.clipIds.map(id => ({ id })),
          nativeSequenceIndices: item.nativeSequenceIndices,
        })),
        context.budget,
        context.signal,
      )
      const baseSequenceBindings = bindM3SequenceIndices(
        {
          clips: baseAnimation?.clips ?? [],
          nativeSequenceIndices: baseAnimation?.nativeSequenceIndices ?? [],
        },
        [],
        context.budget,
        context.signal,
      )
      const materialBinding =
        material === undefined || material.fatal
          ? { materials: material?.materials ?? [], sources: [], baseUnmappedTracks: 0 }
          : bindM3MaterialTracks(
              material.materials,
              sidecars.accepted.map(item => ({
                logicalId: item.logicalId,
                materials: item.materials,
              })),
              sequenceBindings,
              context.budget,
              context.signal,
            )
      if (material !== undefined) material = { ...material, materials: materialBinding.materials }
      const materialBindingDiagnostics = materialBinding.sources
        .filter(item => item.unmappedTracks > 0)
        .map(item => ({
          id: `m3a:${encodeURIComponent(item.logicalId)}:material-tracks-unmapped`,
          code: 'x3.m3/m3a-material-tracks-unmapped',
          category: 'dependency',
          severity: 'warning',
          message: `M3A «${item.logicalId}»: ${item.mergedTracks} of ${item.sourceTracks} native material tracks matched MATM/layer and sequence layout; ${item.unmappedTracks} remain preserved in native source only`,
        }))
      if (materialBinding.baseUnmappedTracks > 0)
        materialBindingDiagnostics.push({
          id: 'x3.m3/material-sequence-unmapped',
          code: 'x3.m3/material-sequence-unmapped',
          category: 'structure',
          severity: 'warning',
          message: `${materialBinding.baseUnmappedTracks} base material track(s) name native sequences rejected by decoding; retained in native source only`,
        })
      const sidecarChannels = sidecars.accepted.reduce(
        (sum, item) => sum + item.supportedChannels,
        0,
      )
      const sidecarUnsupportedChannels = sidecars.accepted.reduce(
        (sum, item) => sum + item.unsupportedChannels,
        0,
      )
      const sidecarBindingComplete =
        standalone ||
        ((attachments?.animationHashes.length ?? 0) === 0 &&
          (sidecars.discovery === undefined ||
            (sidecars.discovery.complete && sidecars.admissionComplete !== false))) ||
        (sidecars.admissionComplete === true &&
          attachments.animationHashes.every(hash =>
            sidecars.accepted.some(item => item.hashes.includes(hash)),
          ))
      let animation =
        baseAnimation === undefined
          ? undefined
          : {
              ...baseAnimation,
              clips: [...baseAnimation.clips, ...sidecars.clips].map((clip, index) => ({
                ...clip,
                sequenceIndex: sequenceBindings[index].combinedSequenceIndex,
              })),
              supportedChannels: baseAnimation.supportedChannels + sidecarChannels,
              unsupportedChannels: baseAnimation.unsupportedChannels + sidecarUnsupportedChannels,
              decodedBytes:
                baseAnimation.decodedBytes +
                sidecars.accepted.reduce((sum, item) => sum + item.decodedBytes, 0),
            }
      const materialTimeline = bindM3MaterialTimelines(
        animation?.clips ?? [],
        materialBinding.materials,
        context.budget,
        context.signal,
      )
      if (animation !== undefined) animation = { ...animation, clips: materialTimeline.clips }
      if (
        animation !== undefined &&
        new Set(animation.clips.map(clip => clip.id)).size !== animation.clips.length
      ) {
        throw new TypeError('M3 base and sidecar clips must have unique stable ids')
      }
      // A truncated BONE table makes the schema parser unsafe for geometry too: both paths load the
      // same section list. Keep the subject inspectable as a section graph and report the refusal.
      const decodedGeometry =
        skeleton?.fatal === true ||
        animation?.fatal === true ||
        material?.fatal === true ||
        attachments?.fatal === true
          ? undefined
          : await geometryOf(bytes, context.budget)
      const batchedGeometry =
        decodedGeometry === undefined
          ? undefined
          : projectM3MaterialBatches(
              decodedGeometry,
              material?.primitiveBindings ?? [],
              context.budget,
              context.signal,
            )
      const skinProjection =
        batchedGeometry === undefined
          ? undefined
          : projectM3SkinBindings(
              batchedGeometry,
              skeleton?.bindings ?? [],
              skeleton?.sceneNodes ?? [],
              context.budget,
              context.signal,
            )
      const geometry = skinProjection?.geometry
      const boundTextures = standalone
        ? []
        : await readTextureBindings(context.input, context.signal)
      const tree = createM3NativeTreeSource(model, bytes)
      /*
       * The base scene counts executable motion. SEQS-only metadata remains visible in the optional
       * animation facet, whose `channelled` count names the distinction. Counting an unsupported
       * timestamp list here made a UVM artifact claim motion it could not truthfully write.
       */
      const animationCount =
        animation?.clips.filter(clip => clip.kind === 'animation' && clip.channels.length > 0)
          .length ?? 0
      const declaredMaterialCount = model.sections
        .filter(section => section.tag === 'MATM')
        .reduce((total, section) => total + section.repetitions, 0)
      const materialCount =
        material?.fatal === false ? material.materials.length : declaredMaterialCount
      const rawScene =
        geometry === undefined || geometry.primitives.length === 0
          ? metadataSceneOf(
              model,
              animationCount,
              materialCount,
              references.names.length,
              skeleton?.sceneNodes ?? [],
            )
          : decodedSceneOf(geometry, animationCount, materialCount, references.names.length)
      const standaloneProjection = standalone
        ? projectStandaloneM3Bundle({
            info: {
              ...(await rawScene.info()),
              geometryAccess: geometry === undefined ? 'metadata-only' : 'decoded',
            },
            nodes: skeleton?.sceneNodes ?? [],
            skeleton: skeleton?.bindings ?? [],
            animations: animation?.clips ?? [],
            sockets: attachments?.sockets ?? [],
            excludedFacetIds: [],
          })
        : undefined
      const scene =
        standaloneProjection === undefined
          ? rawScene
          : createModelSceneSource({
              info: standaloneProjection.info,
              nodes: standaloneProjection.nodes,
              meshes: standaloneProjection.meshes,
              primitives: standaloneProjection.primitives,
            })
      const info = await scene.info()
      const geometryAccess = info.geometryAccess
      const counterComplete =
        geometry !== undefined &&
        animation !== undefined &&
        !animation.fatal &&
        material !== undefined &&
        !material.fatal
      /*
       * The six facet contracts, published as contracts rather than as a shape inside `summary`.
       *
       * Material/layer references supply texture paths. Skeleton bindings follow
       * `MODL.bones → BONE.name → CHAR`, with explicit node ids, default local TRS and inverse bind
       * matrices. SEQS supplies complete extracted tracks and a projected key timeline; raw SD
       * timestamp counts remain container metadata. No frame rate is inferred.
       * MATM supplies stable identity, MAT_ supplies standard names and semantics, LAYR texture
       * strings join to resource ids, and BAT_ binds regions to material ids.
       *
       * Every reference stays `reference-only`. The texture requirement is `many`, so a bound
       * companion cannot be attributed to one name without inspecting the resolved URI, which is the
       * line block 9 drew: the bound companions are recorded in the receipt instead, by binding id.
       */
      const resourceFacet =
        references.names.length === 0 && sidecars.references.length === 0
          ? {}
          : {
              // an empty facet is not a facet: a model that names no texture publishes no resource
              // source rather than an empty page a consumer would read as "the references are gone"
              'common.view/model-resource-refs-source': createModelResourceRefsSource({
                references: [
                  ...references.names.map(value => ({
                    id: value,
                    role: 'texture',
                    provenance: 'reference-only',
                  })),
                  ...sidecars.references,
                ],
                truncated: references.truncated,
              }),
            }
      const skeletonFacet =
        skeleton === undefined || skeleton.bindings.length === 0
          ? {}
          : {
              'common.view/model-skeleton-source': createModelSkeletonSource({
                bindings: skeleton.bindings,
                budget: {
                  maxDepth: context.budget.maxDepth,
                  maxNodes: context.budget.maxNodes,
                  maxBytes: context.budget.maxScalarBytes,
                },
                ...(skeleton.hierarchyComplete ? { hierarchies: 1 } : {}),
              }),
            }
      const animationFacet =
        animation === undefined || animation.clips.length === 0
          ? {}
          : {
              'common.view/model-animation-source': createModelAnimationSource({
                clips: animation.clips,
                budget: {
                  maxDepth: context.budget.maxDepth,
                  maxNodes: context.budget.maxNodes,
                  maxBytes: context.budget.maxScalarBytes,
                },
              }),
            }
      const materialRefsOf = source =>
        source === undefined
          ? []
          : source.materials.map(item => ({
              id: item.id,
              ...(item.name === undefined ? {} : { name: item.name }),
              type: item.typeName,
              ...(item.blendModeName === undefined ? {} : { blendMode: item.blendModeName }),
              ...(Number.isFinite(item.priority) ? { priority: item.priority } : {}),
              ...(item.flags === undefined ? {} : { nativeFlags: item.flags }),
              ...(item.flagNames === undefined ? {} : { flagNames: item.flagNames }),
              ...(item.flagNames?.includes('no-shadows-cast') ? { castShadows: false } : {}),
              ...(item.flagNames?.includes('no-shadows-receive')
                ? { receiveShadows: false }
                : {}),
              // MAT_ two-sided culls no face; unshaded draws the colour without lighting.
              ...(item.flagNames?.includes('two-sided') ? { doubleSided: true } : {}),
              ...(item.flagNames?.includes('unshaded') ? { unlit: true } : {}),
              ...(item.shader === undefined ? {} : { shader: item.shader }),
              layers: item.layers.map(layer => ({
                slot: layer.slot,
                ...(layer.resourceId === undefined ? {} : { resourceId: layer.resourceId }),
                // The common layer reference names the UV set a layer samples (the UVM texCoord).
                // M3's own source enum lives on in the render program; a projected or environment
                // source samples no set, so it names none.
                ...(M3_UV_SET.get(layer.uvSource) === undefined
                  ? {}
                  : { uvSource: M3_UV_SET.get(layer.uvSource) }),
                ...(layer.colorChannels === undefined
                  ? {}
                  : { colorChannels: layer.colorChannels }),
                ...(layer.flags === undefined ? {} : { nativeFlags: layer.flags }),
                ...(layer.flagNames === undefined ? {} : { flagNames: layer.flagNames }),
              })),
            }))
      const materialRefs = materialRefsOf(material)
      const standaloneMaterialTimeline = standalone
        ? bindM3MaterialTimelines(
            animation?.clips ?? [],
            material?.materials ?? [],
            context.budget,
            context.signal,
          )
        : undefined
      const baseMaterialTimeline = bindM3MaterialTimelines(
        baseAnimation?.clips ?? [],
        baseMaterial?.materials ?? [],
        context.budget,
        context.signal,
      )
      const baseMaterialRefs = materialRefsOf(baseMaterial)
      const sourceFreeBaseAnimation =
        baseAnimation === undefined
          ? undefined
          : {
              ...baseAnimation,
              clips: baseMaterialTimeline.clips.map((clip, index) => ({
                ...clip,
                sequenceIndex: baseSequenceBindings[index]?.combinedSequenceIndex ?? index,
              })),
            }
      const materialFacet =
        standalone || material === undefined || material.fatal || material.materials.length === 0
          ? {}
          : {
              'common.view/model-material-source': createModelMaterialSource({
                budget: {
                  maxDepth: context.budget.maxDepth,
                  maxNodes: context.budget.maxNodes,
                  maxBytes: context.budget.maxScalarBytes,
                },
                materials: materialRefs,
              }),
            }
      // Effects are projected after the geometry, because an emission shape names a REGN buffer.
      const effectProjection = await effectsOf(
        bytes,
        context.budget,
        context.signal,
        decodedGeometry?.primitives ?? [],
      )
      const effectRecords = effectRecordsOf(effectProjection?.effects)
      const native = await nativeMetadataOf(bytes, context.budget, context.signal)
      const lightRecords = lightRecordsOf(native)
      const cameraRecords = cameraRecordsOf(native)
      let cameraProjectionResolved = false
      let projectedCameraId = null
      let projectedCameraIndex = 0
      const physicsRecords = physicsRecordsOf(native)
      const behaviourRecords = behaviourRecordsOf(native)
      const effectFacet =
        effectRecords.length === 0
          ? {}
          : {
              'common.view/model-effect-source': createModelEffectSource({
                effects: effectRecords,
                profile: 'm3',
              }),
            }
      const lightFacet =
        lightRecords.length === 0
          ? {}
          : { 'common.view/model-light-source': createModelLightSource({ lights: lightRecords }) }
      const cameraFacet =
        cameraRecords.length === 0
          ? {}
          : {
              'common.view/model-camera-source': (() => {
                const source = createModelCameraSource({cameras:cameraRecords})
                return {...source, async cameras(page,signal) {
                  const result=await source.cameras(page,signal)
                  return {...result,items:result.items.map(camera=>({...camera,
                    ...(cameraProjectionResolved ? {projectedCameraIndex:camera.id===projectedCameraId?projectedCameraIndex:null} : {})}))}
                }}
              })(),
            }
      const physicsFacet =
        physicsRecords.length === 0
          ? {}
          : {
              'common.view/model-physics-source': createModelPhysicsSource({
                bodies: physicsRecords,
              }),
            }
      const behaviourFacet =
        behaviourRecords.length === 0
          ? {}
          : {
              'common.view/model-node-behaviour-source': createModelNodeBehaviourSource({
                behaviours: behaviourRecords,
              }),
            }
      const socketFacet =
        attachments === undefined || attachments.fatal || attachments.sockets.length === 0
          ? {}
          : {
              'common.view/model-socket-source': createModelSocketSource({
                sockets: attachments.sockets,
              }),
            }
      const collisionFacet =
        attachments === undefined || attachments.fatal || attachments.volumes.length === 0
          ? {}
          : {
              'common.view/model-collision-source': createModelCollisionSource({
                volumes: attachments.volumes,
              }),
            }
      const materialComplete =
        material !== undefined &&
        !material.fatal &&
        material.materials.length > 0 &&
        material.exoticMaterials === 0 &&
        material.rejectedNames === 0 &&
        material.rejectedLayerReferences === 0 &&
        material.unresolvedLayerResources === 0 &&
        material.rejectedMaterialReferences === 0 &&
        material.ambiguousPrimitiveBindings === 0 &&
        material.unsupportedBlendModes === 0 &&
        material.unknownFlagRecords === 0
      const projectionReceipt = createProjectionReceipt({
        adapter: { id: ID, version: '1.0.0' },
        subjectRevision: context.input.revisions.revision,
        companions: standalone
          ? []
          : [
              {
                requirementId: TEXTURE_REQUIREMENT,
                role: 'texture',
                state: boundTextures.length > 0 ? 'bound' : 'absent',
                ...(boundTextures[0] === undefined
                  ? {}
                  : { bindingId: boundTextures[0].bindingId }),
              },
            ],
        basis: M3_BASIS,
        planes: [
          {
            planeId: 'geometry',
            state: standalone ? 'normalized' : geometryAccess === 'decoded' ? 'preserved' : 'lost',
            note: standalone
              ? 'standalone M3A has no active geometry or bounds; original geometry remains in native metadata and source bytes'
              : geometryAccess === 'decoded'
                ? 'vertex positions are copied in the file’s own axes'
                : 'the geometry decoder is Node-only; this open produced the section graph alone',
          },
          { planeId: 'structure', state: 'preserved', note: 'the M3 section index, verbatim' },
          {
            planeId: 'skeleton-scene-nodes',
            state: (skeleton?.sceneNodes.length ?? 0) > 0 ? 'normalized' : 'lost',
            note: `${skeleton?.sceneNodes.length ?? 0} exact bone node(s) with authored local TRS; IREF is separately published as inverseBindMatrix`,
          },
          {
            planeId: 'geometry-skin-hierarchy',
            state: standalone
              ? 'preserved'
              : (geometry?.primitives.some(primitive => primitive.hierarchyId !== undefined) ??
                  false)
                ? 'normalized'
                : 'lost',
            note: standalone
              ? 'standalone geometry and skin associations are native preservation-only; the active skeleton has no mesh targets'
              : `${geometry?.primitives.filter(primitive => primitive.hierarchyId !== undefined).length ?? 0} primitive(s) joined to the bone hierarchy; ${skinProjection?.rejected ?? 0} incomplete binding(s) remain unbound`,
          },
          {
            planeId: 'resources',
            state: references.truncated ? 'lost' : 'preserved',
            note:
              material === undefined
                ? 'bounded CHAR hints; full declared-reference decoding is unavailable in this environment'
                : 'texture paths follow declared material/layer references and pinned material builders',
          },
          {
            planeId: 'materials',
            state: standalone ? 'preserved' : materialComplete ? 'normalized' : 'lost',
            note: standalone
              ? 'native material records remain inspectable; standalone M3A publishes no active materials or render texture closure'
              : material === undefined || material.materials.length === 0
                ? 'this open published no decoded MATM material identity'
                : `${material.materials.length} MATM material(s), ${material.decodedLayers} LAYR slot(s), ` +
                  `${material.linkedLayers} resource foreign key(s), and ${material.primitiveBindings.length} BAT_ primitive binding(s) decoded`,
          },
          {
            planeId: 'material-layer-facet-fields',
            state: standalone
              ? 'preserved'
              : material !== undefined && !material.fatal
                ? 'normalized'
                : 'lost',
            note: standalone
              ? 'native layer fields remain in metadata and source bytes; no standalone material facet is activated'
              : material !== undefined && !material.fatal
                ? `${material.decodedLayers} layer slot(s) publish resource joins and native flags, UV source and channel mask where available`
                : 'this open published no safe material layer fields',
          },
          {
            planeId: 'material-shader-parameters',
            state: standalone
              ? 'preserved'
              : material?.shaderParametersComplete
                ? 'normalized'
                : 'lost',
            note: standalone
              ? 'native shader parameters are preservation-only in a standalone animation bundle'
              : `${material?.shaderMaterials ?? 0} material parameter block(s) projected using modkit.render-material.v1; renderer pixel equivalence is not asserted`,
          },
          ...(skeleton === undefined || skeleton.bindings.length === 0
            ? [
                {
                  planeId: 'skeleton-bindings',
                  state: 'lost',
                  note: 'this open published no BONE bindings',
                },
              ]
            : [
                {
                  planeId: 'skeleton-bindings',
                  state: skeleton.rejectedNames === 0 ? 'preserved' : 'lost',
                  note: `${skeleton.bindings.length} BONE index/name binding(s) decoded through their CHAR references`,
                },
              ]),
          {
            planeId: 'skeleton-hierarchy',
            state: skeleton?.hierarchyComplete ? 'preserved' : 'lost',
            note:
              skeleton === undefined
                ? 'the Node-only BONE decoder did not run'
                : skeleton.hierarchyComplete
                  ? `${skeleton.roots} root(s) and every BONE parent link are published`
                  : `${skeleton.rejectedParentLinks} parent link(s) were refused`,
          },
          {
            planeId: 'skeleton-flags',
            state: skeleton === undefined ? 'lost' : 'preserved',
            note:
              skeleton === undefined
                ? 'the Node-only BONE decoder did not run'
                : `native flags and known bit names are published for ${skeleton.bindings.length} BONE record(s)`,
          },
          {
            planeId: 'skeleton-rest-pose',
            state: skeleton?.restPoseComplete ? 'preserved' : 'lost',
            note: skeleton?.restPoseComplete
              ? `${skeleton.bindings.length} finite IREF matrices are joined by exact BONE index`
              : `${skeleton?.rejectedRestPoses ?? 0} IREF record(s) refused; authored local TRS is published separately when valid`,
          },
          {
            planeId: 'animation',
            state: animation !== undefined && animation.clips.length > 0 ? 'normalized' : 'lost',
            note:
              animation !== undefined && animation.clips.length > 0
                ? `${baseAnimation.clips.length} base SEQS clip(s) and ${sidecars.clips.length} admitted companion clip(s) with extracted tracks, initial-value fallbacks and explicit playback timing`
                : 'this open published no valid SEQS record',
          },
          {
            planeId: 'animation-native-time-bounds',
            state: animation !== undefined && animation.clips.length > 0 ? 'preserved' : 'lost',
            note:
              animation !== undefined && animation.clips.length > 0
                ? 'SEQS millisecond start/end bounds are published separately from normalized frame counts'
                : 'this open published no valid SEQS time bounds',
          },
          {
            planeId: 'animation-bone-targets',
            state: (animation?.supportedChannels ?? 0) > 0 ? 'normalized' : 'lost',
            note:
              (animation?.supportedChannels ?? 0) > 0
                ? `${animation.supportedChannels} bone and batch-visibility tracks retain their explicit target identities`
                : 'no sequence supplies bone or batch-visibility tracks',
          },
          {
            planeId: 'animation-sd-keyframes',
            state: (animation?.supportedChannels ?? 0) > 0 ? 'preserved' : 'lost',
            note:
              (animation?.supportedChannels ?? 0) > 0
                ? `${animation.supportedChannels} common bone/batch tracks retain finite keys, interpolation, sequence boundaries and independent wrapping; non-bone tracks are projected separately and ${animation.unsupportedChannels} native STC reference(s) remain unmapped`
                : `${animation?.unsupportedChannels ?? 0} STC channel(s) remain unsupported`,
          },
          {
            planeId: 'attachments',
            state:
              attachments !== undefined &&
              !attachments.fatal &&
              attachments.rejectedNames === 0 &&
              attachments.rejectedBones === 0
                ? 'normalized'
                : 'lost',
            note: `${attachments?.sockets.length ?? 0} ATT_ attachment point(s) projected with stable ids and exact bone targets`,
          },
          {
            planeId: 'attachment-orientation',
            state: 'lost',
            note: 'ATT_ declares a bone and source name but no portable forward/up axes',
          },
          {
            planeId: 'attachment-volume-fields',
            state: 'lost',
            note: `${attachments?.volumes.length ?? 0} ATVL/SSGS volume(s) retain kind/identity; native matrices, sizes, and vertices are outside model-collision-source@1`,
          },
          {
            planeId: 'external-m3a-sidecars',
            state:
              standalone || (sidecars.accepted.length > 0 && sidecarBindingComplete)
                ? 'normalized'
                : 'lost',
            note: standalone
              ? 'standalone M3A is the primary animation source and never recursively discovers companions'
              : `${sidecars.accepted.length} source(s), ${sidecars.clips.length} native sequence clip(s) admitted through hash or host-attested sibling identity, native skeleton compatibility and revision checks; binding coverage ${sidecarBindingComplete ? 'complete' : 'incomplete'} for ${attachments?.animationHashes.length ?? 0} declared hash(es); ${sidecarUnsupportedChannels} companion STC reference(s) remain unmapped`,
          },
          {
            planeId: 'm3a-material-sequence-binding',
            state: materialBindingDiagnostics.length === 0 ? 'normalized' : 'lost',
            note: `${sequenceBindings.length} native-to-combined sequence mappings; ${materialBinding.sources.reduce((sum, item) => sum + item.mergedTracks, 0)} companion material tracks merged through exact native MATM/layer compatibility; ${materialBinding.sources.reduce((sum, item) => sum + item.unmappedTracks, 0)} companion and ${materialBinding.baseUnmappedTracks} base tracks remain unmapped`,
          },
        ],
        evidence: [
          {
            kind: 'declared',
            statement: 'M3 authors in a right-handed Z-up space with +X forward',
            source: 'm3-format-convention',
          },
          {
            kind: 'observed',
            statement:
              `${model.sections.length} sections indexed, ${references.names.length} texture path(s) read from CHAR, ` +
              `${skeleton?.bindings.length ?? 0} BONE binding(s), ${baseAnimation?.clips.length ?? 0} base SEQS clip(s), ` +
              `${baseAnimation?.supportedChannels ?? 0} base BONE channel target(s), ${material?.materials.length ?? 0} MATM material(s), ` +
              `${material?.decodedLayers ?? 0} LAYR slot(s), ${material?.linkedLayers ?? 0} resource link(s), ` +
              `${material?.primitiveBindings.length ?? 0} BAT_ primitive binding(s), ${attachments?.sockets.length ?? 0} ATT_ socket(s), and ` +
              `${attachments?.volumes.length ?? 0} ATVL/SSGS volume(s) decoded`,
            bytesRead: BigInt(bytes.byteLength),
          },
          ...sidecars.accepted.map(item => ({
            kind: 'observed',
            statement: `M3A logical resource ${JSON.stringify(item.logicalId)} at revision ${JSON.stringify(item.revision)}: ${item.clips} admitted native sequence clip(s), ${item.declaredSequences} declared sequence(s), ${item.unsupportedChannels} native STC reference(s) remain unmapped; ${item.binding} admission; source bytes are retained only by the open native session and are never embedded into UVM`,
            bytesRead: BigInt(item.bytes),
          })),
          ...(sidecars.discovery === undefined
            ? []
            : [
                {
                  kind: 'observed',
                  statement: `M3A discovery receipt: complete=${sidecars.discovery.complete}, pages=${sidecars.discovery.pages}, entries=${sidecars.discovery.entries}, candidates=${sidecars.discovery.candidates}, candidateBytes=${sidecars.discovery.bytes}; admissionComplete=${sidecars.admissionComplete === true}`,
                },
              ]),
          ...sidecars.provenance
            .filter(record => record.role === 'sidecar')
            .map(record => ({
              kind: 'observed',
              statement: `Logical sidecar provenance: ${JSON.stringify({ ...record, ...(record.bytes === undefined ? {} : { bytes: String(record.bytes) }) })}`,
            })),
          ...[...sidecars.diagnostics, ...materialBindingDiagnostics].map(item => ({
            kind: 'diagnostic',
            code: item.code,
            message: item.message,
          })),
          ...(references.truncated
            ? [
                {
                  kind: 'diagnostic',
                  code:
                    material === undefined
                      ? 'x3.m3/texture-scan-truncated'
                      : 'x3.m3/texture-references-partial',
                  message:
                    material === undefined
                      ? `the texture hint scan stopped at its budget of ${MAX_TEXTURE_REFERENCES} references`
                      : 'some material texture references could not be published as scoped logical paths',
                },
              ]
            : []),
        ],
        confidence:
          geometryAccess === 'decoded' &&
          (skeleton?.issues.length ?? 0) === 0 &&
          (material?.issues.length ?? 0) === 0 &&
          (attachments?.issues.length ?? 0) === 0 &&
          sidecars.diagnostics.length === 0 &&
          materialBindingDiagnostics.length === 0 &&
          sidecarBindingComplete
            ? 'high'
            : 'partial',
      })
      const conversionCache = createUvmConversionCache(context.budget.maxScalarBytes)
      const convertScene = async (requested, options) => {
        const input =
          requested !== null &&
          typeof requested === 'object' &&
          !Array.isArray(requested) &&
          requested.metersPerSourceUnit === undefined
            ? { ...requested, metersPerSourceUnit: M3_METERS_PER_SOURCE_UNIT }
            : requested
        if (
          input === null ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          input.schemaVersion !== 1 ||
          typeof input.metersPerSourceUnit !== 'number' ||
          !Number.isFinite(input.metersPerSourceUnit) ||
          input.metersPerSourceUnit <= 0
        )
          throw new TypeError(
            'model.export-uvm requires {schemaVersion: 1, metersPerSourceUnit: positive number} and emits source-free schema 1 UVM',
          )
        if (geometry === undefined)
          throw new TypeError('model.export-uvm requires decoded native M3 data')
        if (input.animationNames !== undefined && (!Array.isArray(input.animationNames) || input.animationNames.length < 1 || input.animationNames.length > 128 || input.animationNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 512)))
          throw new TypeError('M3 animationNames requires 1..128 non-empty animation property requests')
        if (input.animationNames !== undefined && input.animationResources === undefined)
          throw new TypeError('M3 animationNames currently requires explicit animationResources')
        if (
          attachments?.fatal ||
          (attachments?.rejectedNames ?? 0) > 0 ||
          (attachments?.rejectedBones ?? 0) > 0
        )
          throw new TypeError('M3 attachment points could not be projected completely')
        // Read-only attachment: native M3 validates exact authored M3A references; common scene
        // composes portable bundles. The base and animation assets are never written.
        if (input.animationResources !== undefined) {
          if (standalone || !Array.isArray(input.animationResources) || input.animationResources.length > 64)
            throw new TypeError('M3 animationResources requires at most 64 explicit M3A resources')
          if (input.animationResources.some(r => typeof r.logicalId !== 'string' || !/\.m3a$/iu.test(r.logicalId)))
            throw new TypeError('M3 animationResources must name explicit M3A logical files')
          if (context.modelResources === undefined || context.logicalResources === undefined)
            throw new TypeError('M3 explicit animations require Host model/resource ports')
          const { resolveM3AnimationSidecars } = await import('./runtime/sidecar-projection.js')
          const conversionStep = async (phase, work) => {
            try { return await work() } catch (error) {
              if (error instanceof Error && error.name !== 'AbortError' && error.code !== CANCELLED_CODE)
                error.message = `M3 animation attachment (${phase}): ${error.message}`
              throw error
            }
          }
          const admitted = await conversionStep('native animation binding', () => resolveM3AnimationSidecars({baseBytes: bytes,
            candidates: input.animationResources, resources: context.logicalResources,
            budget: context.budget, signal: options?.signal, includeSources: true,
            includeBaseDiagnostics: false, bindingContext: { explicit: true }, animationNames: input.animationNames}))
          if (admitted.accepted.length !== input.animationResources.length)
            throw new TypeError('M3 refused explicit animation binding: '+admitted.diagnostics.map(d=>d.message).join('; '))
          const { animationResources, animationNames, ...baseInput } = input
          const base = await conversionStep('base conversion', () => convertScene(baseInput, options))
          const {readUvmContainer,writeUvmContainer} = await import('@modkit/uv/model/container')
          const {readUvmAnimationClips} = await import('@modkit/uv/model/animation-clips')
          const {composeUvmAnimationBundle} = await import('@modkit/scene/uvm')
          const {animationSnapshotBudget,modelAnimationNameMatchScore} = await import('@modkit/codec-kit/model/animation')
          // A presentation subset needs the same closest property matches the common player uses,
          // not every "Stand ..." clip from every RequiredAnims bundle. Keep all tied variants.
          const selectedClips = input.animationNames === undefined ? undefined : new Set(input.animationNames.flatMap(name => {
            const matches = admitted.accepted.flatMap(sidecar => sidecar.boundClips)
              .map(clip => ({clip,score:modelAnimationNameMatchScore(clip.name,name)}))
              .filter(match => match.score !== undefined)
            const minimum = Math.min(...matches.map(match => match.score))
            return matches.filter(match => match.score === minimum).map(match => match.clip)
          }))
          if (selectedClips !== undefined && ![...selectedClips].some(clip =>
            clip.channels.some(channel => ['translation','rotation','scale'].includes(channel.kind))))
            throw new TypeError('M3 closest requested animation subset has no bound TRS channels')
          // Native node counts and expanded animation JSON counts are different domains.
          // Charge the already decoded clips with the materializer's existing measured allowance;
          // keep the caller's byte/depth caps and the native parser budget unchanged.
          const attachmentAnimationBudget = animationSnapshotBudget(admitted.accepted.flatMap(sidecar => sidecar.boundClips)
            .filter(clip => selectedClips === undefined || selectedClips.has(clip)))
          const containerBudget = { maxInputBytes: Number(context.budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : context.budget.maxInputBytes),
            maxJsonBytes: context.budget.maxScalarBytes, maxDepth: context.budget.maxDepth,
            maxNodes: context.budget.maxNodes + attachmentAnimationBudget.maxNodes }
          let target=await conversionStep('base container read', () => readUvmContainer(base.value, containerBudget, options?.signal))
          const {materializeUvmCore} = await import('@modkit/uv/model/materializer')
          const {readUvmFormatResidual,attachUvmFormatResidual} = await import('@modkit/uv/model/format-residual')
          const baseNodeIndices = readUvmFormatResidual(target,'BlizzardM3').mapping.nodes
          // Use the materializer's own explicit id bindings instead of names: the base conversion
          // preserves original node IDs in its provenance mapping.
          for (const sidecar of admitted.accepted) {
            if (sidecar.boundClips.length === 0) continue
            const clips = sidecar.boundClips.filter(clip=>selectedClips === undefined || selectedClips.has(clip))
              .map(clip=>({...clip,channels:clip.channels.filter(ch=>['translation','rotation','scale'].includes(ch.kind))}))
            if (clips.length === 0) continue
            const materialized = await conversionStep('animation materialization', () => materializeUvmCore({info:{...info,nodes:geometry.nodes.length,meshes:0,primitives:0,materials:0,textures:0,animations:clips.length,upAxis:'+z'},
              nodes:geometry.nodes.map(node=>({...node,meshIds:[]})), meshes:[],primitives:[],materials:[], skeleton:skeleton?.bindings, animations:clips},
              {scope:{scopeId:'model-interchange-v1',version:'1.0.0'},profile:'UVM/core@1.0',subjectRevision:context.input.revisions.revision,
                options:{assetId:sidecar.logicalId,sourceFormat:'m3a',units:{sourceUnit:'sc2-game-unit',metersPerSourceUnit:input.metersPerSourceUnit}}},
              {signal:options?.signal,animationBudget:{maxDepth:context.budget.maxDepth,maxNodes:Math.max(context.budget.maxNodes,animationSnapshotBudget(clips).maxNodes),maxBytes:context.budget.maxScalarBytes},skeletonBudget:{maxDepth:context.budget.maxDepth,maxNodes:context.budget.maxNodes,maxBytes:context.budget.maxScalarBytes}}))
            if(materialized.receipt.diff.some(entry=>entry.change==='not-represented' && entry.path?.startsWith('/animations'))) throw new TypeError('M3A bone animation materialization lost channels')
            const bundle=await conversionStep('animation container read', () => readUvmContainer(materialized.bytes, containerBudget, options?.signal))
            if((bundle.document.animations??[]).reduce((sum,a)=>sum+(a.channels??[]).length,0)!==clips.reduce((sum,c)=>sum+c.channels.length,0))
              throw new TypeError('M3A bone animation channels were not completely materialized: '+JSON.stringify({
                losses: materialized.receipt.diff.filter(entry=>entry.path?.startsWith('/animations') && entry.note !== 'key times or values were rounded to the glTF float32 representation').slice(0,8),
                firstChannels: clips[0]?.channels.slice(0,2).map(channel=>({kind:channel.kind,target:channel.target,count:channel.samples.length,first:channel.samples.slice(0,3),last:channel.samples.slice(-2)})),
              }))
            const destination=readUvmAnimationClips(target.document) ?? []
            const next=1+Math.max(-1,...destination.map(c=>c.sourceSequenceIndex))
            const nodes=[]
            for(const [id,sourceIndex] of Object.entries(materialized.bindings.nodes)) {
              const targetIndex=baseNodeIndices[id]
              if(Number.isSafeInteger(targetIndex) && targetIndex>=0) nodes.push({source:sourceIndex,target:targetIndex})
            }
            target=(await conversionStep('animation composition', () => composeUvmAnimationBundle(target,bundle,{id:sidecar.logicalId,nodes,
              clips:readUvmAnimationClips(bundle.document).map((clip,index)=>({sourceId:clip.id,id:sidecar.logicalId+'/'+clip.id,sequenceIndex:next+index}))},
              {budget:containerBudget,maxWorkingBytes:context.budget.maxScalarBytes,signal:options?.signal}))).container
          }
          const residual = readUvmFormatResidual(target,'BlizzardM3')
          const {BlizzardM3: _previousResidual,...extras} = target.document.extras
          target = await conversionStep('binding receipt', () => attachUvmFormatResidual({...target,document:{...target.document,extras}},{namespace:'BlizzardM3',...residual,
            residual:{...residual.residual,animationBindings:admitted.accepted.map(sidecar=>({logicalId:sidecar.logicalId,
              revision:String(sidecar.revision),...sidecar.bindingReport,
              ...(input.animationNames === undefined ? {} : { selectedAnimationNames: input.animationNames,
                projectedClipIds: sidecar.boundClips.filter(clip=>selectedClips.has(clip)).map(clip=>clip.id),
                selectionProfile: 'closest-animation-property-set', completeness: 'partial' }),
              limitations:['Side-only bone channels and non-TRS/material animation are not played by this attachment.',
                ...((sidecar.bindingReport?.boundaryResampledChannels ?? 0) > 0 ? ['Leading duplicate-time channels use native samples at 0 and 1 ms; the open (0,1 ms) interval is approximate. Original native assets are not modified.'] : [])]}))}}, containerBudget, options?.signal))
          return {kind:'bytes',value:await conversionStep('container write', () => writeUvmContainer(target, containerBudget, options?.signal))}
        }
        const signal = options?.signal
        const sourceFreeBase = !standalone
        signal?.throwIfAborted()
        const conversionKey = `${input.schemaVersion}:${input.metersPerSourceUnit}`
        const cached = conversionCache.get(conversionKey, signal)
        if (cached !== undefined) return { kind: 'bytes', value: cached }
        const { decodeM3UvmSource } = await import('./runtime/geometry.js')
        const {
          metadata,
          attachmentVolumes,
          hittests,
          rigidBodies,
          effects,
          staticPreview,
          animationReferenceIds,
        } = await decodeM3UvmSource(
          bytes,
          context.budget,
          signal,
          standalone ? undefined : decodedGeometry.primitives,
        )
        const selectedAnimation = sourceFreeBase ? sourceFreeBaseAnimation : animation
        const selectedMaterialRefs = sourceFreeBase ? baseMaterialRefs : materialRefs
        const selectedSequenceBindings = sourceFreeBase ? baseSequenceBindings : sequenceBindings
        if ((selectedAnimation?.unsupportedChannels ?? 0) > 0)
          throw new TypeError(
            `source-free ${sourceFormat.toUpperCase()} refuses ${selectedAnimation.unsupportedChannels} unmapped native animation channel(s)`,
          )
        const nativeBudget = {
          ...context.budget,
          maxInputBytes: Number(
            context.budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : context.budget.maxInputBytes,
          ),
        }
        // Admission supplies owned sources. Check the complete retained collection before
        // parsing companions, then charge each bounded JSON projection once as it arrives.
        let retainedBytes = bytes.length
        for (const sidecar of sourceFreeBase ? [] : sidecars.accepted) {
          throwIfAborted(signal)
          retainedBytes += sidecar.sourceBytes.length
          if (
            !Number.isSafeInteger(retainedBytes) ||
            retainedBytes > nativeBudget.maxInputBytes ||
            retainedBytes > nativeBudget.maxScalarBytes
          )
            throw new RangeError('M3 animation companion sources exceed aggregate byte budget')
        }
        let retainedNodes = 0
        const chargeProjection = value => {
          const json = JSON.stringify(value, (_key, entry) => {
            throwIfAborted(signal)
            if (++retainedNodes > nativeBudget.maxNodes)
              throw new RangeError(
                'M3 animation companion projections exceed aggregate node budget',
              )
            return entry
          })
          retainedBytes += new TextEncoder().encode(json).length
          if (!Number.isSafeInteger(retainedBytes) || retainedBytes > nativeBudget.maxScalarBytes)
            throw new RangeError('M3 animation companion projections exceed aggregate byte budget')
        }
        const animationSidecars = []
        const effectSidecars = []
        const effectBinder =
          !standalone && effects !== undefined && sidecars.accepted.length > 0
            ? await import('../../dist/m3/uvm/effect-sidecar-source.js')
            : undefined
        for (const sidecar of sourceFreeBase ? [] : sidecars.accepted) {
          throwIfAborted(signal)
          const decoded = await decodeM3UvmSource(sidecar.sourceBytes, context.budget, signal)
          chargeProjection(decoded.metadata)
          animationSidecars.push({
            logicalId: sidecar.logicalId,
            revision: sidecar.revision,
            bytes: sidecar.sourceBytes,
            metadata: decoded.metadata,
            clipIds: sidecar.clipIds,
            nativeSequenceIndices: sidecar.nativeSequenceIndices,
          })
          if (effectBinder !== undefined) {
            const bound = await effectBinder.decodeM3EffectSidecarBinding(
              bytes,
              sidecar.sourceBytes,
              sidecar.logicalId,
              nativeBudget,
              signal,
              decodedGeometry.primitives,
            )
            chargeProjection(bound)
            effectSidecars.push(bound)
          }
        }
        const combinedEffects =
          sourceFreeBase || effectBinder === undefined
            ? effects
            : (await import('../../dist/m3/uvm/effect-sidecar-binding.js')).bindM3EffectSidecars(
                effects,
                effectSidecars,
                sequenceBindings,
                nativeBudget,
                signal,
              )
        const { convertM3ProjectionToUvm } = await import('../../dist/m3/uvm/converter.js')
        const result = await convertM3ProjectionToUvm(
          bytes,
          standaloneProjection === undefined
            ? {
                info: {
                  ...info,
                  nodes: geometry.nodes.length,
                  meshes: geometry.meshes.length,
                  primitives: geometry.primitives.length,
                  geometryAccess: 'decoded',
                },
                nodes: geometry.nodes,
                meshes: geometry.meshes,
                primitives: geometry.primitives,
                ...(skeleton === undefined ? {} : { skeleton: skeleton.bindings }),
                ...(selectedAnimation === undefined ? {} : { animations: selectedAnimation.clips }),
                ...(baseMaterial === undefined && sourceFreeBase
                  ? {}
                  : { materials: selectedMaterialRefs }),
                ...(attachments === undefined ? {} : { sockets: attachments.sockets }),
                excludedFacetIds: [],
                resourceClosure: {
                  mode: 'logical',
                  entries: references.names.map(logicalId => ({ role: 'image', logicalId })),
                },
              }
            : {
                ...standaloneProjection,
                animations: standaloneMaterialTimeline?.clips ?? standaloneProjection.animations,
              },
          metadata,
          {
            assetId: context.source.ref.id,
            ...(standalone ? {} : { attachmentVolumes, hitTests: hittests }),
            rigidBodies,
            ...(animationSidecars.length === 0 ? {} : { animationSidecars }),
            sequenceBindings: selectedSequenceBindings,
            ...(combinedEffects === undefined ? {} : { effects: combinedEffects }),
            ...(standalone || staticPreview === undefined ? {} : { staticPreview }),
            ...(animationReferenceIds === undefined ? {} : { animationReferenceIds }),
            materialBinding: {
              sources: materialBinding.sources,
              baseUnmappedTracks: materialBinding.baseUnmappedTracks,
            },
            ...(standalone && materialRefs.length > 0
              ? { animationMaterialTargets: materialRefs }
              : {}),
            subjectRevision: context.input.revisions.revision,
            sourceFormat,
            ...(attachments?.primaryAnimationHash
              ? { m3aHash: attachments.primaryAnimationHash }
              : {}),
            ...(attachments?.additionalAnimationHashes === undefined
              ? {}
              : { m3aHashes: attachments.additionalAnimationHashes }),
            ...(animation?.animationEvents?.length
              ? { animationEvents: animation.animationEvents }
              : {}),
            ...(animation?.residualAnimationTracks?.length
              ? { residualAnimationTracks: animation.residualAnimationTracks }
              : {}),
            metersPerSourceUnit: input.metersPerSourceUnit,
            budget: {
              maxDepth: context.budget.maxDepth,
              maxNodes: context.budget.maxNodes,
              maxScalarBytes: context.budget.maxScalarBytes,
              maxJsonBytes: context.budget.maxScalarBytes,
              maxInputBytes: Number(
                context.budget.maxInputBytes > 0xffffffffn
                  ? 0xffffffffn
                  : context.budget.maxInputBytes,
              ),
            },
            ...(signal === undefined ? {} : { signal }),
          },
        )
        const cameraMapping = result.container.document.extras?.BlizzardM3?.residual?.preview?.camera
        projectedCameraId = cameraMapping === undefined ? null : cameraRecords[cameraMapping.nativeIndex]?.id ?? null
        projectedCameraIndex = cameraMapping?.camera ?? 0
        cameraProjectionResolved = true
        conversionCache.set(conversionKey, result.bytes, signal)
        return { kind: 'bytes', value: result.bytes }
      }
      return {
        summary: {
          format: sourceFormat,
          ...(standalone ? { assetKind: M3A_STANDALONE_ASSET_KIND } : {}),
          container: model.tag,
          sections: model.sections.length,
          sectionTags: [...new Set(model.sections.map(section => section.tag))],
          /*
           * The texture references and their bindings are gone from here on purpose (slice 12-2).
           * `common.view/model-resource-refs-source@1` publishes the names the document spells, and
           * the projection receipt records which companions the host actually bound. Keeping a third
           * copy in the summary meant three places to update and two of them silently wrong.
           */
          geometryAccess,
          nodes: info.nodes,
          meshes: info.meshes,
          primitives: info.primitives,
          scenes: info.scenes,
          materials: info.materials,
          textures: info.textures,
          animations: info.animations,
        },
        metadata: [
          ...(standalone
            ? [
                {
                  id: 'm3a-standalone',
                  label: 'Standalone M3A animation bundle',
                  entries: [
                    { key: 'assetKind', value: M3A_STANDALONE_ASSET_KIND },
                    { key: 'm3aHashes', value: attachments?.animationHashes ?? [] },
                    { key: 'activeGeometry', value: false },
                    { key: 'activeMaterials', value: false },
                    { key: 'activeEffects', value: false },
                    { key: 'nativeTextureReferences', value: references.names.length },
                  ],
                },
              ]
            : []),
          {
            id: 'm3-container',
            label: 'M3 container',
            entries: [
              { key: 'container', value: model.tag },
              { key: 'counterState', value: counterComplete ? 'complete' : 'unavailable' },
              ...(counterComplete ? [{ key: 'counterSemantics', value: COUNTER_SEMANTICS }] : []),
              { key: 'indexOffset', value: model.indexOffset },
              { key: 'sections', value: model.sections.length },
              { key: 'geometryAccess', value: geometryAccess },
              { key: 'nodes', value: info.nodes },
              { key: 'meshPartitions', value: geometry?.meshPartitions ?? 0 },
              { key: 'meshes', value: info.meshes },
              { key: 'primitives', value: info.primitives },
              { key: 'scenes', value: info.scenes },
              { key: 'materials', value: info.materials },
              { key: 'textures', value: info.textures },
              { key: 'animations', value: info.animations },
            ],
          },
          ...(animation === undefined
            ? []
            : [
                {
                  id: 'm3-animation',
                  label: 'M3 animation',
                  entries: [
                    { key: 'declaredSequences', value: animation.declaredSequences },
                    {
                      key: 'baseSampleableClips',
                      value: baseAnimation.clips.filter(clip => clip.channels.length > 0).length,
                    },
                    {
                      key: 'sidecarBindingState',
                      value: standalone
                        ? 'standalone'
                        : (attachments?.animationHashes.length ?? 0) === 0 &&
                            sidecars.discovery === undefined
                          ? 'not-required'
                          : sidecarBindingComplete
                            ? 'complete'
                            : 'incomplete',
                    },
                    { key: 'sidecarSources', value: sidecars.accepted.length },
                    {
                      key: 'sidecarDeclaredSequences',
                      value: sidecars.accepted.reduce(
                        (sum, item) => sum + item.declaredSequences,
                        0,
                      ),
                    },
                    {
                      key: 'sidecarSampleableClips',
                      value: sidecars.clips.filter(clip => clip.channels.length > 0).length,
                    },
                    { key: 'sidecarNativeSequenceClips', value: sidecars.clips.length },
                    {
                      key: 'sidecarMaterialTracks',
                      value: materialBinding.sources.reduce(
                        (sum, item) => sum + item.mergedTracks,
                        0,
                      ),
                    },
                    {
                      key: 'sidecarUnmappedMaterialTracks',
                      value: materialBinding.sources.reduce(
                        (sum, item) => sum + item.unmappedTracks,
                        0,
                      ),
                    },
                    {
                      key: 'sidecarExecutableClips',
                      value: sidecars.clips.filter(clip => clip.kind === 'animation').length,
                    },
                    { key: 'sidecarUnsupportedChannels', value: sidecarUnsupportedChannels },
                    { key: 'executableClips', value: animationCount },
                    { key: 'sequences', value: animation.clips.length },
                    { key: 'nativeSequenceClips', value: animation.clips.length },
                    {
                      key: 'materialAnimatedSequences',
                      value: materialTimeline.materialAnimatedSequences,
                    },
                    { key: 'timelineContainers', value: animation.timelineContainers.length },
                    { key: 'supportedBoneChannels', value: animation.supportedChannels },
                    { key: 'unsupportedChannels', value: animation.unsupportedChannels },
                    {
                      key: 'sampleFrames',
                      value: animation.clips.reduce((total, clip) => total + clip.frames, 0),
                    },
                    {
                      key: 'timelineNames',
                      value: animation.timelineContainers.map(item => item.name).join(', '),
                    },
                  ],
                },
              ]),
          ...(material === undefined
            ? []
            : [
                {
                  id: 'm3-materials',
                  label: 'M3 materials',
                  entries: [
                    { key: 'layerRecords', value: material.decodedLayers },
                    { key: 'logicalResources', value: references.names.length },
                    { key: 'materialReferences', value: material.materials.length },
                    { key: 'standardMaterials', value: material.standardMaterials },
                    { key: 'exoticMaterials', value: material.exoticMaterials },
                    { key: 'layerSlots', value: material.decodedLayers },
                    { key: 'resourceLinkedLayers', value: material.linkedLayers },
                    { key: 'primitiveBindings', value: material.primitiveBindings.length },
                    { key: 'rejectedReferences', value: material.rejectedMaterialReferences },
                    { key: 'unresolvedLayerResources', value: material.unresolvedLayerResources },
                    {
                      key: 'layerFacetState',
                      value: standalone
                        ? 'preservation-only/standalone'
                        : 'normalized/model-material-source@1',
                    },
                  ],
                },
              ]),
        ],
        traits: [
          ...(!standalone && geometryAccess === 'decoded'
            ? [
                {
                  id: 'model.geometry',
                  parameters: { meshes: info.meshes, primitives: info.primitives },
                },
              ]
            : []),
          ...(skeleton === undefined || skeleton.bindings.length === 0
            ? []
            : [
                {
                  id: 'model.skeleton',
                  parameters: {
                    bindings: skeleton.bindings.length,
                    named: skeleton.bindings.filter(item => item.boneName !== null).length,
                    roots: skeleton.roots,
                    rejectedParentLinks: skeleton.rejectedParentLinks,
                  },
                },
              ]),
          ...(animation === undefined || animation.clips.length === 0
            ? []
            : [
                {
                  id: 'model.animations',
                  parameters: {
                    clips: animation.clips.length,
                    channels: animation.supportedChannels,
                    unsupportedChannels: animation.unsupportedChannels,
                  },
                },
              ]),
          ...(standalone || material === undefined || material.materials.length === 0
            ? []
            : [
                {
                  id: 'model.materials',
                  parameters: {
                    materials: material.materials.length,
                    standard: material.standardMaterials,
                    exotic: material.exoticMaterials,
                    layers: material.decodedLayers,
                    resourceLinks: material.linkedLayers,
                    primitiveBindings: material.primitiveBindings.length,
                  },
                },
              ]),
          ...(!standalone && references.names.length > 0
            ? [{ id: 'model.textures', parameters: { textures: references.names.length } }]
            : []),
          { id: 'structure.hierarchy', parameters: { sections: model.sections.length } },
          { id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } },
        ],
        dataSources: {
          'common.view/tree-data-source': tree,
          'common.view/model-scene-source': scene,
          ...resourceFacet,
          ...skeletonFacet,
          ...animationFacet,
          ...materialFacet,
          ...socketFacet,
          ...collisionFacet,
          ...effectFacet,
          ...lightFacet,
          ...cameraFacet,
          ...physicsFacet,
          ...behaviourFacet,
        },
        handlers: {
          'model-export-uvm': convertScene,
          'render-m3-scene': async (input, options) => {
            if (context.contracts === undefined)
              throw new TypeError('host renderer capability is absent')
            if (input === null || typeof input !== 'object' || Array.isArray(input))
              throw new TypeError(
                'model.render requires a UVM render request and metersPerSourceUnit',
              )
            const { metersPerSourceUnit, ...render } = input
            const converted = await convertScene({ schemaVersion: 1, metersPerSourceUnit }, options)
            const { renderUvmPng } = await import('@modkit/scene/uvm/render')
            return renderUvmPng(converted.value, render, {
              contracts: context.contracts,
              budget: context.budget,
              ...(context.modelResources === undefined
                ? {}
                : { modelResources: context.modelResources }),
              ...(context.rasterResources === undefined
                ? {}
                : { rasterResources: context.rasterResources }),
              ...options,
            })
          },
          'edit-m3-scene': async (input, options) => {
            const { prepareM3UvmEdit } = await import('../../dist/m3/uvm/edit-operation.js')
            return prepareM3UvmEdit(bytes, input, context, convertScene, options?.signal)
          },
          'edit-m3-native-field': nativeFieldHandler(bytes, context),
          'model-write': async (input, options) => {
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new TypeError(
                'model.write requires a UVM request or bounded authoring compatibility input',
              )
            }
            if (Object.hasOwn(input, 'uvmBytesHex')) {
              return writeM3UvmRequest(
                input,
                context.budget,
                options?.signal ?? context.signal,
                sourceFormat,
              )
            }
            if (input.schemaVersion !== 1 || !('model' in input)) {
              throw new TypeError('model.write requires schemaVersion 1 and model')
            }
            const { encodeM3JsonModel } = await import('./writer.js')
            const result = await encodeM3JsonModel(
              input.model,
              input.options,
              context.budget,
              options?.signal ?? context.signal,
            )
            const errors = result.issues.filter(item => item.severity === 'error')
            if (errors.length > 0) {
              throw new TypeError(`model.write encoder refused the model: ${errors[0].message}`)
            }
            return { kind: 'bytes', value: result.bytes }
          },
        },
        operationStates: [
          ...(context.contracts === undefined
            ? [
                {
                  id: 'model.render',
                  state: 'dependency-required',
                  reason:
                    'M3 rendering requires the native UVM importer and host renderer capability',
                },
              ]
            : []),
        ],
        projectionReceipt,
        diagnostics: [
          ...(standalone
            ? [
                {
                  id: 'x3.m3/m3a-sidecar-standalone',
                  code: 'x3.m3/m3a-sidecar-standalone',
                  category: 'dependency',
                  severity: 'information',
                  message:
                    'M3A is an external animation bundle; attach it to a matching M3 model for rendering.',
                },
              ]
            : []),
          ...(skeleton?.issues ?? []),
          ...(animation?.issues ?? []),
          ...(material?.issues ?? []),
          ...(attachments?.issues ?? []),
          ...sidecars.diagnostics,
          ...materialBindingDiagnostics,
        ],
        maxDecodedBytes: BigInt(
          Math.max(
            bytes.byteLength,
            geometry?.decodedBytes ?? 0,
            skeleton?.decodedBytes ?? 0,
            animation?.decodedBytes ?? 0,
            material?.decodedBytes ?? 0,
            attachments?.decodedBytes ?? 0,
            sidecars.accepted.reduce((sum, item) => sum + item.bytes, 0),
          ),
        ),
        companions: standalone
          ? []
          : [
              {
                id: TEXTURE_REQUIREMENT,
                role: 'texture',
                cardinality: 'many',
                required: false,
                ...(boundTextures.length === 0
                  ? { state: 'missing' }
                  : { state: 'resolved', bindingIds: boundTextures.map(item => item.bindingId) }),
              },
            ],
        unsupportedFeatures: [
          ...(geometryAccess === 'decoded' ? [] : ['decoded-geometry-buffers']),
          ...(standalone
            ? []
            : material === undefined || material.materials.length === 0
              ? ['materials']
              : []),
          ...(standalone || (material !== undefined && !material.fatal)
            ? []
            : ['material-layer-facet-fields']),
          ...(standalone || material?.shaderParametersComplete
            ? []
            : ['material-shader-parameters']),
          ...(standalone || (material?.exoticMaterials ?? 0) === 0
            ? []
            : ['exotic-material-rendering']),
          ...(standalone ? [] : ['texture-decoding']),
          ...(skeleton?.hierarchyComplete ? [] : ['skeleton-parent-links']),
          ...(skeleton === undefined ? ['skeleton-flags'] : []),
          ...(skeleton?.restPoseComplete ? [] : ['skeleton-rest-pose']),
          ...(animation === undefined || animation.clips.length === 0 ? ['animations'] : []),
          ...((animation?.supportedChannels ?? 0) > 0 ? [] : ['animation-sd-keyframes']),
          ...((animation?.unsupportedChannels ?? 0) > 0
            ? ['animation-unsupported-sd-channels']
            : []),
          ...(sidecarBindingComplete ? [] : ['external-m3a-sidecars-require-resource-session']),
        ],
      }
    },
  })
  return createInspectionCodec(definition, context)
}

export const abiVersion = 1
export const createCodec = context => createM3FamilyCodec(context, 'm3')
