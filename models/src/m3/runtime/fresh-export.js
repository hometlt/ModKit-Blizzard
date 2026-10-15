// Native fresh export validates omitted M3 material families before any approximation or write.
import { assertM3MaterialWritable } from '../../../dist/m3/uvm/material-layer-addresses.js'
/** M3-family native encoder: common UVM geometry, rigs and representable material programs.
 * Strict conversion is the default. Explicit base-color-coverage approximates foreign shader
 * materials and reports losses; no source-game detection, image conversion or asset storage.
 * Used by common.model/native-encoder (models/providers/m3-native-encoder/provider.json).
 * Existing budget, cancellation, native readback and unknown-data refusals remain authoritative. */
import { projectUvmStaticModel } from '@modkit/scene/uvm/static-model'
import { projectUvmRigModel } from '@modkit/scene/uvm/rig-model'
import { prepareFreshM3RigModel, restoreFreshM3Rig } from './fresh-rig.js'
import { prepareRigidM3Container } from './fresh-rigid.js'
import { encodeM3JsonModel } from '../writer.js'
import { decodeM3Materials } from './material.js'
import { decodeM3Geometry, decodeM3UvmSource } from './geometry.js'
import { generateUvmVertexNormals } from '@modkit/scene/uvm/normals'
import { decodeM3Attachments } from './attachments.js'
import { removeUvmFrameWrappers } from '@modkit/uv/model/frame'
import { appendUvmAccessors } from '@modkit/uv/model/accessor-write'
import { readUvmAccessor } from '@modkit/uv/model/accessor'
import {
  withBatchVisibilityBones,
  withM3BillboardBasis,
} from '../../../dist/m3/uvm/fresh-rig-authoring.js'
import { M3_BILLBOARD } from '../../../dist/m3/skeleton-projection.js'
import { mergeM3DegenerateRigidShapes } from '../../../dist/m3/uvm/rigid-bodies.js'
import * as uvmScene from '@modkit/scene/uvm'
import { uvmImageLogicalId } from '@modkit/uv/model/container'

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`)
  return value
}
function materialPreflight(value, path = '', depth = 0, displacement = value?.presentation === 'screen-distortion') {
  if (depth > 96) throw new RangeError('fresh material exceeds depth budget')
  if (Array.isArray(value)) {
    value.forEach((item, index) => materialPreflight(item, `${path}/${index}`, depth + 1, displacement))
    return
  }
  if (value === null || typeof value !== 'object') return
  assertM3MaterialWritable(value.metadata)
  for (const [key, item] of Object.entries(value)) {
    const next = `${path}/${key}`
    const layerTrack = /^\/standard\/layers\/[^/]+\/(?:constantColor|colorMultiply|colorAdd|alphaFactor|uvOffset|uvAngle|uvTiling|uvTriplanarOffset|uvTriplanarScale)(?:\/sequenceTracks(?:\/\d+\/track(?:\/globalSeqId)?)?)?$/u.test(next)
    const atlasTrack = /^\/standard\/layers\/[^/]+\/flipbook\/frame\/sequenceTracks(?:\/\d+\/track(?:\/globalSeqId)?)?$/u.test(next)
    const strengthTrack = displacement && /^\/(?:standard\/parallaxHeight|metadata\/strength)\/sequenceTracks(?:\/\d+\/track(?:\/globalSeqId)?)?$/u.test(next)
    if (
      ['animation', 'sequenceAnimation', 'sequenceTracks', 'track', 'globalSeqId'].includes(key) &&
      !atlasTrack && !layerTrack && !strengthTrack
    )
      throw new TypeError(`fresh M3 cannot encode animated material ${next}`)
    if (key === 'globalSeqId' && item !== null)
      throw new TypeError(`fresh M3 cannot encode global material animation ${next}`)
    if (key === 'uvSource' && (!Number.isSafeInteger(item) || item < 0 || item > 0xffffffff))
      throw new TypeError(`fresh M3 material UV source is invalid: ${next}=${String(item)}`)
    if (
      key === 'texturePath' &&
      item !== null &&
      item !== '' &&
      (typeof item !== 'string' ||
        !/^(?![a-z]+:)(?![\\/])[^\0]+$/iu.test(item) ||
        item.split(/[\\/]/u).some(part => !part || part === '.' || part === '..'))
    )
      throw new TypeError(`fresh M3 texture path is not a portable asset reference: ${next}`)
    materialPreflight(item, next, depth + 1, displacement)
  }
}
function list(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}
/** `rebased`: the rig projection stated its billboards, and `withM3BillboardBasis` has turned any
 * other basis into StarCraft II's; without that statement only StarCraft II's own basis is exact. */
function projectM3BillboardsFromUvm(container, nodeBoneIndices, rebased = false) {
  const billboards = []
  for (const [nodeIndex, node] of (container.document.nodes ?? []).entries()) {
    const extension = node.extensions?.UV_node_billboard
    if (extension === undefined) continue
    const value = record(extension, `UV_node_billboard node ${nodeIndex}`)
    const boneIndex = nodeBoneIndices[nodeIndex]
    if (!Number.isSafeInteger(boneIndex))
      throw new TypeError(`fresh M3 billboard node ${nodeIndex} is not a rig joint`)
    if (value.schemaVersion === 1 && value.mode === 'aim') {
      billboards.push(bbscOfAim(boneIndex, value))
      continue
    }
    if (
      value.schemaVersion !== 1 ||
      value.mode !== 'inverse-camera' ||
      (!rebased && JSON.stringify(value.basisRotations) !== JSON.stringify(M3_BILLBOARD.basisRotations))
    )
      throw new TypeError('fresh M3 supports only the exact common M3 inverse-camera billboard')
    // The inverse-camera rule is the BONE 0x10 flag. The game turns bones by BBSC, whose full
    // billboard (free type, aimed along the view) reaches the M3 inverse-camera basis only through
    // the `forward` correction, which the engine composes on child bones alone and which drops the
    // bone's own rotation; so no BBSC record is written for it rather than an inexact one.
    billboards.push({ boneIndex, flagOnly: true })
  }
  return billboards
}
/** A BBSC record back from an `aim` rule (skeleton-projection `m3AimBillboard` read it). */
const AIM_BBSC_TYPES = { 'frame-x': 0, 'frame-y': 1, 'frame-z': 2, 'own-x': 3, 'own-y': 5, free: 6 }
function bbscOfAim(boneIndex, value) {
  const type = AIM_BBSC_TYPES[value.lock]
  if (type === undefined || (value.aim !== 'view' && value.aim !== 'eye'))
    throw new TypeError('fresh M3 cannot write this aim billboard')
  const correction = value.correction ?? [0, 0, 0, 1]
  return {
    boneIndex,
    type,
    cameraLookAt: value.aim === 'eye',
    up: type <= 2 ? correction : [0, 0, 0, 1],
    forward: type === 6 ? correction : [0, 0, 0, 1],
  }
}

function projectM3StaticPreviewFromUvm(container, residual, metersPerNativeUnit) {
  if (residual === undefined) return { cameras: [], lights: [] }
  const value = record(residual, 'BlizzardM3 preview residual')
  const dense = (projected, unprojected, label) => {
    const entries = [
      ...projected,
      ...list(unprojected, `${label} unprojected`).map(value => {
        const item = record(value, `${label} unprojected item`)
        return { nativeIndex: item.nativeIndex, record: record(item.record, `${label} native record`) }
      }),
    ].sort((left, right) => left.nativeIndex - right.nativeIndex)
    entries.forEach((entry, index) => {
      if (entry.nativeIndex !== index) throw new TypeError(`fresh M3 ${label} native indices must be dense`)
    })
    return entries.map(entry => entry.record)
  }
  const projectedCameras = []
  if (value.camera !== undefined) {
    const mapping = record(value.camera, 'M3 camera residual')
    if (!Number.isSafeInteger(mapping.nativeIndex) || !Number.isSafeInteger(mapping.camera))
      throw new TypeError('M3 camera residual indices are invalid')
    const camera = record(list(container.document.cameras, 'UVM cameras')[mapping.camera], 'UVM camera')
    const perspective = record(camera.perspective, 'UVM perspective camera')
    if (camera.type !== 'perspective') throw new TypeError('M3 supports only a perspective preview camera')
    const finitePositive = (entry, label) => {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0)
        throw new TypeError(`M3 camera ${label} must be positive`)
      return entry
    }
    const { nativeIndex, camera: _camera, ...native } = mapping
    projectedCameras.push({
      nativeIndex,
      record: {
        ...native,
        name: typeof camera.name === 'string' ? camera.name : `Camera_${nativeIndex}`,
        fieldOfView: finitePositive(perspective.yfov, 'yfov'),
        nearClip: finitePositive(perspective.znear, 'znear') / metersPerNativeUnit,
        farClip: finitePositive(perspective.zfar, 'zfar') / metersPerNativeUnit,
      },
    })
  }
  const lightExtension = container.document.extensions?.UV_scene_lights
  const commonLights = lightExtension === undefined
    ? []
    : list(record(lightExtension, 'UV_scene_lights').lights, 'UV scene lights')
  const projectedLights = list(value.lights, 'M3 light residuals').map(raw => {
    const mapping = record(raw, 'M3 light residual'), light = record(commonLights[mapping.light], 'UVM light')
    if (!Number.isSafeInteger(mapping.nativeIndex) || !Number.isSafeInteger(mapping.boneIndex))
      throw new TypeError('M3 light residual indices are invalid')
    const intensity = mapping.intensity
    if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0)
      throw new TypeError('M3 light residual intensity is invalid')
    const commonColor = list(light.color, 'UVM light color')
    if (commonColor.length !== 3 || commonColor.some(value => typeof value !== 'number' || !Number.isFinite(value)))
      throw new TypeError('UVM light color is invalid')
    const color = intensity === 0
      ? list(mapping.zeroIntensityColor, 'M3 zero-intensity color')
      : commonColor.map(value => value / intensity)
    if (color.length !== 3 || color.some(value => typeof value !== 'number' || !Number.isFinite(value)))
      throw new TypeError('M3 native light color is invalid')
    const specularColor = list(mapping.specularColor, 'M3 specular color')
    if (
      specularColor.length !== 3 ||
      specularColor.some(value => typeof value !== 'number' || !Number.isFinite(value))
    )
      throw new TypeError('M3 specular color is invalid')
    if (!Number.isSafeInteger(mapping.flags) || mapping.flags < 0 || mapping.flags > 0xffff)
      throw new TypeError('M3 light flags are invalid')
    if (
      typeof mapping.specularIntensity !== 'number' ||
      !Number.isFinite(mapping.specularIntensity)
    )
      throw new TypeError('M3 specular intensity is invalid')
    for (const key of ['hotspot', 'falloff'])
      if (
        mapping[key] !== undefined &&
        (typeof mapping[key] !== 'number' || !Number.isFinite(mapping[key]))
      )
        throw new TypeError(`M3 light ${key} residual is invalid`)
    const type = { directional: 0, point: 1, spot: 2 }[light.type]
    if (type === undefined) throw new TypeError('UVM light type cannot be written to M3')
    return {
      nativeIndex: mapping.nativeIndex,
      record: {
        type,
        boneIndex: mapping.boneIndex,
        flags: mapping.flags,
        color,
        intensity,
        specularColor,
        specularIntensity: mapping.specularIntensity,
        attenuationNear: light.attenuationStart ?? 0,
        attenuationFar: light.attenuationEnd ?? light.range ?? 0,
        decay: light.decayExponent ?? 1,
        hotspot: mapping.hotspot ?? light.innerConeAngle ?? 0,
        falloff: mapping.falloff ?? light.outerConeAngle ?? 0,
      },
    }
  })
  return {
    cameras: dense(projectedCameras, value.unprojectedCameras, 'camera'),
    lights: dense(projectedLights, value.unprojectedLights, 'light'),
  }
}
export function projectM3EffectsFromUvm(container, nodeBoneIndices, budget, signal) {
  const extension = container.document.extensions?.UV_game_effects
  if (extension === undefined) return undefined
  const source = record(extension, 'UV_game_effects')
  if ((source.profile ?? 'common') !== 'm3')
    throw new TypeError('fresh M3 requires the m3 common effect profile')
  if ((source.trackTimeUnit ?? 'seconds') !== 'seconds')
    throw new TypeError('fresh M3 effect tracks require seconds')
  if (source.spaceNode !== undefined)
    throw new TypeError('fresh M3 effect spaceNode must be normalized before encoding')
  const remap = value => {
    signal?.throwIfAborted()
    if (Array.isArray(value)) return value.map(remap)
    if (value === null || typeof value !== 'object') return value
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'node') {
        const bone = nodeBoneIndices[item]
        const unbound = container.document.nodes?.[item]?.name === 'M3 unbound effects'
        if (!Number.isSafeInteger(bone) && !unbound)
          throw new TypeError(`M3 effect node ${String(item)} is not a rig joint`)
        output.boneIndex = unbound ? -1 : bone
      } else if (key === 'material') {
        if (!Number.isSafeInteger(item) || item < 0)
          throw new TypeError('M3 effect material is invalid')
        output.materialIndex = item
      } else output[key] = remap(item)
    }
    return output
  }
  const effects = {}
  for (const kind of ['particles', 'ribbons', 'forces', 'warps', 'projectors'])
    effects[kind] = list(source[kind], `UV_game_effects.${kind}`).map((value, ordinal) => {
      const converted = remap(record(value, `${kind}[${ordinal}]`))
      if (kind !== 'particles' || converted.emitShapeMeshes === undefined) return converted
      converted.emitShapeMeshes = list(converted.emitShapeMeshes, 'emitShapeMeshes').map(
        (mesh, meshIndex) => {
          const value = record(mesh, `emitShapeMeshes[${meshIndex}]`)
          return {
            positions: Array.from(
              readUvmAccessor(
                container.document,
                container.binary,
                value.positions,
                { maxScalarBytes: budget.maxScalarBytes },
                'M3 emission positions',
                signal,
              ).values,
            ),
            indices: Array.from(
              readUvmAccessor(
                container.document,
                container.binary,
                value.indices,
                { maxScalarBytes: budget.maxScalarBytes },
                'M3 emission indices',
                signal,
              ).values,
            ),
          }
        },
      )
      return converted
    })
  return effects
}

export function projectM3AttachmentsFromUvm(container, nodeBoneIndices, nodeParents, budget, signal, residualBodies = [], notes = [], degenerateRigidShapes = []) {
  const nodes = container.document.nodes ?? []
  const parentBone = index => {
    const parent = nodeParents[index]
    const bone = nodeBoneIndices[parent]
    if (!Number.isSafeInteger(bone))
      throw new TypeError(`M3 scene node ${index} requires a direct rig-joint parent`)
    return bone
  }
  // A socket or volume on a joint itself (Warcraft III's attachment and collision nodes are) binds
  // to that joint's bone; a helper node below a joint binds to its parent's.
  const isJoint = index => Number.isSafeInteger(nodeBoneIndices[index])
  const boneOf = index => (isJoint(index) ? nodeBoneIndices[index] : parentBone(index))
  const sockets = []
  const volumes = []
  const hittests = []
  const rigidShapes = new Map()
  const attachmentShapeCode = { box: 0, sphere: 1, capsule: 2, cylinder: 3, mesh: 4 }
  const physicsShapeCode = { box: 0, sphere: 1, capsule: 2, cylinder: 3, 'convex-hull': 4, mesh: 5 }
  for (const [index, node] of nodes.entries()) {
    const socket = node.extensions?.UV_game_socket
    if (socket !== undefined) {
      const value = record(socket, `UV_game_socket node ${index}`)
      if (typeof value.role !== 'string' || !value.role || typeof value.sourceName !== 'string' || !value.sourceName)
        throw new TypeError('fresh M3 socket requires a role and sourceName')
      // A helper carries no transform of its own: M3 places an attachment point at its bone.
      if (
        !isJoint(index) && (
          node.name !== value.sourceName ||
          node.translation !== undefined ||
          node.rotation !== undefined ||
          node.scale !== undefined ||
          node.matrix !== undefined)
      )
        throw new TypeError('fresh M3 socket helper cannot encode a local transform or name alias mismatch')
      // M3's own attach sockets keep their numbered order; other roles (origin, overhead, … with
      // numbers per role) follow in scene order.
      const numbered = value.role === 'attach' && Number.isSafeInteger(value.index)
      sockets.push({ order: numbered ? [0, value.index, index] : [1, index, 0], name: value.sourceName, boneIndex: boneOf(index) })
    }
    const collision = node.extensions?.UV_game_collision
    if (collision === undefined) continue
    const value = record(collision, `UV_game_collision node ${index}`)
    if (value.role !== 'effect' && value.role !== 'physics' && value.role !== 'hit')
      throw new TypeError('fresh M3 collision requires effect, physics or hit role')
    const shapes = list(value.shapes, 'UV_game_collision.shapes')
    if (shapes.length !== 1) throw new TypeError('fresh M3 attachment volume requires one shape')
    const shape = record(shapes[0], 'UV_game_collision shape')
    const code = (value.role === 'physics' ? physicsShapeCode : attachmentShapeCode)[shape.kind]
    if (code === undefined) throw new TypeError(`fresh M3 collision kind is unsupported: ${String(shape.kind)}`)
    if ((code === 2 || code === 3) && shape.axis !== (value.role === 'physics' ? 'y' : 'z'))
      throw new TypeError(`fresh M3 capsule/cylinder requires the native ${value.role === 'physics' ? 'y' : 'z'} axis`)
    const matrix = shape.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite))
      throw new TypeError('fresh M3 attachment volume requires a finite matrix')
    if (value.role === 'physics') {
      const match = /^m3-rigid-body-(\d+)-shape-(\d+)$/u.exec(value.extras?.modkit?.id ?? '')
      if (match === null) throw new TypeError('fresh M3 physics collision requires its stable body/shape identity')
      const bodyIndex = Number(match[1]), shapeIndex = Number(match[2])
      let vertices = []
      if (shape.positions !== undefined) {
        const values = Array.from(readUvmAccessor(container.document, container.binary, shape.positions, { maxScalarBytes: budget.maxScalarBytes }, 'M3 rigid vertices', signal).values)
        if (values.length % 3 !== 0) throw new TypeError('fresh M3 rigid vertices require VEC3 data')
        for (let offset = 0; offset < values.length; offset += 3) vertices.push(values.slice(offset, offset + 3))
      }
      let indices = []
      if (shape.indices !== undefined) {
        indices = Array.from(readUvmAccessor(container.document, container.binary, shape.indices, { maxScalarBytes: budget.maxScalarBytes }, 'M3 rigid triangles', signal).values)
        if (indices.length === 0 || indices.length % 3 !== 0 ||
            !indices.every(value => Number.isSafeInteger(value) && value >= 0 && value < vertices.length))
          throw new TypeError('fresh M3 rigid triangle indices are invalid')
      }
      const nativeShape = {
        index: shapeIndex,
        shape: ['Box', 'Sphere', 'Capsule', 'Cylinder', 'ConvexHull', 'Mesh'][code],
        shapeCode: code,
        matrix4: matrix,
        size: code === 0 ? shape.size : code === 1 ? [shape.radius, 1, 1] : code <= 3 ? [shape.radius, shape.height, 1] : [1, 1, 1],
        vertices,
        ...(indices.length === 0 ? {} : { indices }),
      }
      const entry = rigidShapes.get(bodyIndex) ?? { boneIndex: boneOf(index), shapes: [] }
      if (entry.boneIndex !== boneOf(index) || entry.shapes.some(item => item.index === shapeIndex))
        throw new TypeError('fresh M3 rigid body shape binding is ambiguous')
      entry.shapes.push(nativeShape)
      rigidShapes.set(bodyIndex, entry)
      continue
    }
    if (value.role === 'hit') {
      // Hit tests: the volumes a click or a projectile tests against. M3 keeps them as boxes,
      // spheres, capsules and cylinders; a mesh has no hit-test form and is left out, said so.
      if (code === 4) {
        notes.push(`hit volume on node ${index} is a mesh, which an M3 hit test cannot hold; it was not written`)
        continue
      }
      hittests.push({
        shape: code,
        boneIndex: boneOf(index),
        matrix4: matrix,
        size0: code === 0 ? shape.size?.[0] / 2 : shape.radius,
        size1: code === 0 ? shape.size?.[1] / 2 : code >= 2 ? shape.height : 1,
        size2: code === 0 ? shape.size?.[2] / 2 : 1,
      })
      if (![hittests.at(-1).size0, hittests.at(-1).size1, hittests.at(-1).size2].every(Number.isFinite))
        throw new TypeError('fresh M3 hit volume has invalid dimensions')
      continue
    }
    let mesh
    if (code === 4) {
      if (shape.positions === undefined || shape.indices === undefined)
        throw new TypeError('fresh M3 attachment mesh requires positions and indices')
      const flatPositions = Array.from(readUvmAccessor(container.document, container.binary, shape.positions, { maxScalarBytes: budget.maxScalarBytes }, 'M3 attachment vertices', signal).values)
      const indices = Array.from(readUvmAccessor(container.document, container.binary, shape.indices, { maxScalarBytes: budget.maxScalarBytes }, 'M3 attachment faces', signal).values)
      if (flatPositions.length === 0 || flatPositions.length % 3 !== 0 ||
          indices.length === 0 || indices.length % 3 !== 0 ||
          !indices.every(value => Number.isSafeInteger(value) && value >= 0 && value < flatPositions.length / 3 && value <= 0xffff))
        throw new TypeError('fresh M3 attachment mesh geometry is invalid')
      const positions = []
      for (let offset = 0; offset < flatPositions.length; offset += 3)
        positions.push(flatPositions.slice(offset, offset + 3))
      mesh = { positions, indices }
    }
    const volume = {
      ordinal: Number(/^m3-attachment-volume-(\d+)$/u.exec(value.extras?.modkit?.id ?? '')?.[1]),
      shape: code,
      boneIndex: boneOf(index),
      matrix4: matrix,
      size0: code === 0 ? shape.size?.[0] / 2 : code === 4 ? 1 : shape.radius,
      size1: code === 0 ? shape.size?.[1] / 2 : code === 4 ? 1 : code >= 2 ? shape.height : 1,
      size2: code === 0 ? shape.size?.[2] / 2 : 1,
      ...(mesh === undefined ? {} : mesh),
    }
    if (
      !Number.isSafeInteger(volume.ordinal) ||
      ![volume.size0, volume.size1, volume.size2].every(Number.isFinite)
    )
      throw new TypeError('fresh M3 attachment volume has invalid ordinal or dimensions')
    volumes.push(volume)
  }
  mergeM3DegenerateRigidShapes(degenerateRigidShapes, rigidShapes,
    new Set(Object.values(nodeBoneIndices)), new Set(residualBodies.map(body => body.index)), budget, signal)
  const ordered = (values, label) => values.sort((a, b) => a.ordinal - b.ordinal).map((value, ordinal) => {
    if (value.ordinal !== ordinal) throw new TypeError(`fresh M3 ${label} ordinals must be dense`)
    const { ordinal: _ordinal, ...result } = value
    return result
  })
  const byOrder = (left, right) =>
    left.order[0] - right.order[0] || left.order[1] - right.order[1] || left.order[2] - right.order[2]
  return {
    sockets: sockets.sort(byOrder).map(({ order: _order, ...socket }) => socket),
    volumes: ordered(volumes, 'attachment volume'),
    hittests,
    rigidBodies: [...rigidShapes].sort(([a], [b]) => a - b).map(([index, value], ordinal) => {
      if (index !== ordinal) throw new TypeError('fresh M3 rigid body ordinals must be dense')
      const residual = residualBodies.find(item => item?.index === index) ?? {}
      const shapes = value.shapes.sort((a, b) => a.index - b.index)
      if (shapes.some((shape, ordinal) => shape.index !== ordinal))
        throw new TypeError('fresh M3 rigid shape ordinals must be dense')
      return { ...residual, index, boneIndex: value.boneIndex, shapes }
    }),
  }
}

/** M3 applies team colour through a non-RGB diffuse layer's alpha. For a common material whose
 * diffuse layer adds or multiplies uncoloured RGB, the native decal slot is the equivalent base-colour
 * carrier and does not have that implicit behaviour. A team-coloured diffuse draws with alpha one,
 * so a material that blends (a Warcraft III layer over its team colour) or cuts by that texture's
 * alpha takes it from alpha1 over the same texture. */
function adaptPortableMaterialToM3(material, foreign = true) {
  const worldToMaterial = material?.worldToMaterial
  if (worldToMaterial !== undefined) {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    if (
      !Array.isArray(worldToMaterial) ||
      worldToMaterial.length !== identity.length ||
      worldToMaterial.some((value, index) => value !== identity[index])
    )
      throw new TypeError('fresh M3 cannot encode a non-identity common material frame')
    const { worldToMaterial: _worldToMaterial, ...portable } = material
    material = portable
  }
  const sourceStandard = material?.standard
  const standard = sourceStandard && {
    ...(material.presentation === 'screen-distortion' ? {} : {
      environmentMultipliers: [1, 0, 0],
      // Foreign opaque/cut-out surfaces must populate SC2's depth prepass for mutual occlusion.
      depthPrepass: (sourceStandard.blendMode ?? 0) === 0,
      // A source without StarCraft II's specular dim keeps its highlight (MAT_ SimulateRoughness).
      specularEnergyConservation: false,
    }),
    ...sourceStandard,
    layers: Object.fromEntries(
      Object.entries(sourceStandard.layers).map(([slot, source]) => {
        // The writer stores a texture path with forward slashes (a Warcraft III path has back ones).
        const layer =
          typeof source.texturePath === 'string'
            ? { ...source, texturePath: source.texturePath.replaceAll('\\', '/') }
            : source
        if (layer.flipbook?.frameSize === undefined) return [slot, layer]
        const { frameSize, ...flipbook } = layer.flipbook
        const cols = Math.round(1 / frameSize[0])
        const rows = Math.round(1 / frameSize[1])
        if (
          cols <= 0 || rows <= 0 ||
          Math.abs(cols * frameSize[0] - 1) > 1e-6 ||
          Math.abs(rows * frameSize[1] - 1) > 1e-6
        ) throw new TypeError('fresh M3 requires reciprocal-integer atlas frameSize')
        return [slot, { ...layer, flipbook: { ...flipbook, rows, cols } }]
      }),
    ),
  }
  const diffuse = standard?.layers?.diffuse
  const alphaCarried = standard?.alphaTestThreshold !== 0 || standard?.blendMode !== 0
  // An M3 source's diffuse without team colour (an RGB channel select) writes back as it is.
  if (
    foreign &&
    diffuse?.channels !== 0 &&
    diffuse?.teamColorMode === 0 &&
    (diffuse.op === 6 || diffuse.op === 0 || diffuse.op === 2) &&
    standard.layers.decal === undefined
  ) {
    const { diffuse: _diffuse, ...layers } = standard.layers
    const neutralDiffuse = {
      slot: 'diffuse',
      texturePath: null,
      uvSource: 0,
      channels: 0,
      op: diffuse.op,
      // An RGB diffuse takes no team colour (the game gates it on ChannelSelect != RGB).
      teamColorMode: 0,
      invert: false,
      clampResult: false,
      wrapX: false,
      wrapY: false,
      constantColor: { value: diffuse.op === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1] },
    }
    return {
      ...material,
      standard: {
        ...standard,
        layers: {
          ...layers,
          diffuse: neutralDiffuse,
          decal: { ...diffuse, slot: 'decal' },
          // Alpha starts at the diffuse layer, which is neutral now: an alpha-tested texture
          // (Warzone PIE cut-outs) keeps its cut, and a blended one its opacity, through alpha1
          // over the same texture, selecting AAAA rather than forcing alpha to one with RGB.
          ...(alphaCarried && standard.layers.alpha1 === undefined
            ? { alpha1: { ...diffuse, slot: 'alpha1', channels: 2 } } : {}),
        },
      },
    }
  }
  return standard === undefined ? material : { ...material, standard }
}

function portableAtlasScales(materials) {
  return materials.map(material => {
    const scales = new Map()
    for (const layer of Object.values(material.standard?.layers ?? {})) {
      const size = layer.flipbook?.frameSize
      if (size === undefined) continue
      const scale = [1 / size[0], 1 / size[1]]
      const previous = scales.get(layer.uvSource)
      if (previous && (previous[0] !== scale[0] || previous[1] !== scale[1]))
        throw new TypeError('fresh M3 requires one atlas stride per material UV set')
      scales.set(layer.uvSource, scale)
    }
    return scales
  })
}

/** Explicit base-color approximation moves non-grey RGB factors to native vertex colors.
 * Texture alpha and existing vertex alpha remain independent; M3 RGBA8 quantization is reported. */
function prepareM3RgbTint(container, budget, signal, notes) {
  const materials=container.document.materials ?? [], factors=new Map(), inputs=[], colorBindings=new Map()
  for(const [i,m]of materials.entries()) {
    const ref=m.extensions?.UV_game_material
    if(ref?.shader==='modkit.render-material.v1' &&
       !Object.values(ref.params?.renderModel?.standard?.layers ?? {}).some(l=>l?.sceneEnvironment===true))continue
    const c=m.pbrMetallicRoughness?.baseColorFactor
    if(m.pbrMetallicRoughness?.baseColorTexture && Array.isArray(c)&&c.length===4&&
       c.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&(c[0]!==c[1]||c[1]!==c[2]))factors.set(i,c)
  }
  if(!factors.size)return container
  let bytes=0
  const meshes=(container.document.meshes ?? []).map(mesh=>({...mesh,primitives:mesh.primitives.map(p=>{
    const c=factors.get(p.material);if(!c)return p
    signal?.throwIfAborted()
    const pos=readUvmAccessor(container.document,container.binary,p.attributes.POSITION,budget,'tint positions',signal)
    const color=p.attributes.COLOR_0===undefined?undefined:readUvmAccessor(container.document,container.binary,p.attributes.COLOR_0,budget,'tint colors',signal)
    if(color&&(color.count!==pos.count||![3,4].includes(color.width)||
      !(color.componentType===5126&&!color.normalized||[5121,5123].includes(color.componentType)&&color.normalized)))
      throw new TypeError('M3 tint requires normalized RGB/RGBA colors matching positions')
    const divisor=color?.componentType===5121?255:color?.componentType===5123?65535:1
    bytes+=pos.count*16;if(bytes>budget.maxScalarBytes)throw new RangeError('M3 tint exceeds scalar budget')
    const values=new Float32Array(pos.count*4)
    for(let v=0;v<pos.count;v++)for(let k=0;k<4;k++) {
      const prior=!color||k>=color.width?1:color.values[v*color.width+k]/divisor
      if(!Number.isFinite(prior)||prior<0||prior>1)throw new TypeError('M3 tint vertex color is outside 0..1')
      values[v*4+k]=prior*(k===3?1:c[k])
    }
    const input=inputs.length;inputs.push({type:'VEC4',values})
    const owned={...p,attributes:{...p.attributes}}
    colorBindings.set(owned,input)
    return owned
  })}))
  const a=appendUvmAccessors(container,inputs,{maxInputBytes:Number(budget.maxInputBytes>0xffffffffn?0xffffffffn:budget.maxInputBytes),maxJsonBytes:budget.maxScalarBytes,maxScalarBytes:budget.maxScalarBytes,maxDepth:budget.maxDepth,maxNodes:budget.maxNodes},signal)
  for(const mesh of meshes)mesh.primitives=mesh.primitives.map(p=>{if(!colorBindings.has(p))return p;return {...p,attributes:{...p.attributes,COLOR_0:a.accessors[colorBindings.get(p)]}}})
  const ownedMaterials=materials.map((m,i)=>factors.has(i)?{...m,pbrMetallicRoughness:{...m.pbrMetallicRoughness,baseColorFactor:[1,1,1,factors.get(i)[3]]}}:m)
  for(const i of factors.keys())notes.push(`Material ${i}: RGB factor moved to owned vertex colors; native RGBA8 quantization <= 1/255, alpha factor retained independently.`)
  return {...a.container,document:{...a.container.document,meshes,materials:ownedMaterials}}
}

/** UV's plain material fallback renders opaque base color without PBR lighting. Represent
 * exactly that bounded profile with the existing common unshaded standard program. */
function preparePlainM3Materials(container, materialPolicy = 'strict', notes = []) {
  let changed = false
  const materials = (container.document.materials ?? []).map((candidate, index) => {
    const material = record(candidate, 'M3 input material')
    if (materialPolicy === 'base-color-coverage') {
      const reference = material.extensions?.UV_game_material
      if (reference?.shader === 'modkit.render-material.v1') {
        const params = record(reference.params, 'common material parameters')
        if (Object.values(params.renderModel?.standard?.layers ?? {}).some(layer => layer?.sceneEnvironment === true)) {
          changed = true
          notes.push(`Material ${index}: native M3 cannot carry the common scene environment binding; explicitly approximated the program with glTF base color and coverage.`)
          return approximateM3BaseColor(container.document, material, index, notes)
        }
        if (Object.keys(params).some(key => key !== 'renderModel')) {
          changed = true
          notes.push(`Material ${index}: omitted auxiliary source shader parameters; retained the common RenderMaterial program.`)
          return { ...material, extensions: { ...material.extensions,
            UV_game_material: { ...reference, params: { renderModel: params.renderModel } } } }
        }
        return material
      }
      // Approximate only glTF base colour/coverage. Common shader programs remain exact.
      changed = true
      return approximateM3BaseColor(container.document, material, index, notes)
    }
    if (material.extensions?.UV_game_material !== undefined) return material
    const pbr = record(material.pbrMetallicRoughness, 'M3 plain color material')
    if (
      Object.keys(material).some(
        key => !['name', 'pbrMetallicRoughness', 'extras', 'alphaMode'].includes(key),
      ) ||
      Object.keys(pbr).some(
        key => !['baseColorFactor', 'metallicFactor', 'roughnessFactor'].includes(key),
      ) ||
      pbr.metallicFactor !== 0 ||
      pbr.roughnessFactor !== 1 ||
      (material.alphaMode !== undefined && material.alphaMode !== 'OPAQUE')
    )
      throw new TypeError(
        'fresh M3 plain color fallback requires opaque nonmetallic rough material',
      )
    const color = pbr.baseColorFactor ?? [1, 1, 1, 1]
    if (
      !Array.isArray(color) ||
      color.length !== 4 ||
      color[3] !== 1 ||
      color.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    )
      throw new TypeError('fresh M3 plain color fallback requires opaque finite RGBA')
    changed = true
    const { alphaMode: _alphaMode, ...plain } = material
    return {
      ...plain,
      extensions: {
        UV_game_material: {
          shader: 'modkit.render-material.v1',
          params: {
            renderModel: {
              version: 1,
              standard: {
                layers: {
                  diffuse: {
                    slot: 'diffuse',
                    texturePath: null,
                    uvSource: 0,
                    channels: 0,
                    op: 6,
                    teamColorMode: 0,
                    invert: false,
                    clampResult: false,
                    wrapX: false,
                    wrapY: false,
                    constantColor: { value: color },
                  },
                },
                blendMode: 0,
                priority: 0,
                specularity: 0,
                specMult: 0,
                emisMult: 0,
                environmentMultipliers: [1, 0, 0],
                specMode: 0,
                alphaTestThreshold: 0,
                twoSided: false,
                unshaded: true,
                depthPrepass: true,
                doubleLambert: false,
                clampOutput: false,
                usesVertexColor: false,
                usesVertexAlpha: false,
              },
            },
          },
        },
      },
    }
  })
  return changed
    ? {
        ...container,
        document: {
          ...container.document,
          materials,
          extensionsUsed: [
            ...new Set([...(container.document.extensionsUsed ?? []), 'UV_game_material']),
          ],
        },
      }
    : container
}

/** Explicit foreign-material approximation, using UVM's shared image identity and M3 adapter.
 * Refuses unresolved images and transformed/mirrored UVs rather than guessing. */
function approximateM3BaseColor(document, material, index, notes) {
  const pbr = record(material.pbrMetallicRoughness, 'M3 base color material')
  const mode = material.alphaMode ?? 'OPAQUE'
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(mode))
    throw new TypeError('M3 base-color-coverage requires OPAQUE, MASK or BLEND')
  const color = pbr.baseColorFactor ?? [1, 1, 1, 1]
  if (!Array.isArray(color) || color.length !== 4 ||
      color.some(value => !Number.isFinite(value) || value < 0 || value > 1))
    throw new TypeError('M3 base-color-coverage requires finite RGBA in 0..1')
  const cutoff = mode === 'MASK' ? material.alphaCutoff ?? 0.5 : 0
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1)
    throw new TypeError('M3 base-color-coverage requires alphaCutoff in 0..1')
  let texturePath = null, uvSource = 0, wrapX = false, wrapY = false
  if (pbr.baseColorTexture !== undefined) {
    const info = record(pbr.baseColorTexture, 'M3 base color texture')
    if (Object.keys(info).some(key => !['index', 'texCoord'].includes(key)))
      throw new TypeError('M3 base-color-coverage cannot approximate transformed texture coordinates')
    const textures = document.textures ?? [], images = document.images ?? []
    if (!Number.isSafeInteger(info.index) || info.index < 0 || info.index >= textures.length)
      throw new TypeError('M3 base-color-coverage base texture is unresolved')
    const texture = record(textures[info.index], 'M3 texture')
    if (!Number.isSafeInteger(texture.source) || texture.source < 0 || texture.source >= images.length)
      throw new TypeError('M3 base-color-coverage image is unresolved')
    const image = record(images[texture.source], 'M3 image')
    if (typeof image.uri !== 'string' || image.uri.startsWith('data:') || image.bufferView !== undefined)
      throw new TypeError('M3 base-color-coverage requires an external image resource')
    materialPreflight({ texturePath: uvmImageLogicalId(image.uri) })
    if (typeof uvmScene.uvmImageResourceId !== 'function')
      throw new TypeError('M3 base-color-coverage requires the shared UVM image-identity capability')
    texturePath = uvmScene.uvmImageResourceId(document, texture.source)
    uvSource = info.texCoord ?? 0
    if (!Number.isSafeInteger(uvSource) || uvSource < 0 || uvSource > 3)
      throw new TypeError('M3 base-color-coverage requires UV0..UV3')
    const samplers = document.samplers ?? []
    if (texture.sampler !== undefined && (!Number.isSafeInteger(texture.sampler) ||
        texture.sampler < 0 || texture.sampler >= samplers.length))
      throw new TypeError('M3 base-color-coverage sampler is unresolved')
    const sampler = texture.sampler === undefined ? {} : record(samplers[texture.sampler], 'M3 sampler')
    if (![10497, 33071].includes(sampler.wrapS ?? 10497) ||
        ![10497, 33071].includes(sampler.wrapT ?? 10497))
      throw new TypeError('M3 base-color-coverage cannot represent mirrored texture wrapping')
    wrapX = (sampler.wrapS ?? 10497) === 10497
    wrapY = (sampler.wrapT ?? 10497) === 10497
  }
  if (texturePath !== null && (color[0] !== color[1] || color[1] !== color[2]))
    throw new TypeError('M3 base-color-coverage textured RGB tint requires image conversion')
  const covered = mode !== 'OPAQUE'
  const layer = { slot: 'diffuse', texturePath, uvSource, channels: covered ? 1 : 0,
    op: 6, teamColorMode: 0, invert: false, clampResult: false, wrapX, wrapY,
    ...(texturePath === null
      ? { constantColor: { value: mode === 'OPAQUE' ? [...color.slice(0, 3), 1] : color } }
      : { colorMultiply: { value: color[0] } }) }
  const vertexColors = (document.meshes ?? []).some(mesh => (mesh.primitives ?? [])
    .some(primitive => primitive.material === index && primitive.attributes?.COLOR_0 !== undefined))
  notes.push(`Material ${index}: approximated with base color and ${mode} coverage; omitted source shader, normal, specular, emissive and PBR lighting behavior.`)
  return { ...(material.name === undefined ? {} : { name: material.name }), extensions: {
    UV_game_material: { shader: 'modkit.render-material.v1', params: {
      renderModel: { version: 1, standard: { layers: { diffuse: layer,
        ...(covered ? {alpha1:{...layer,slot:'alpha1',channels:2,
          ...(texturePath===null?{}:{colorMultiply:{value:color[3]}})}} : {}) }, blendMode: mode === 'BLEND' ? 1 : 0,
        priority: 0, specularity: 0, specMult: 0, emisMult: 0, environmentMultipliers: [1, 0, 0],
        specMode: 0, alphaTestThreshold: cutoff, twoSided: material.doubleSided ?? false,
        unshaded: false, depthPrepass: mode !== 'BLEND', doubleLambert: false, clampOutput: false,
        usesVertexColor: vertexColors, usesVertexAlpha: vertexColors && covered } } } } } }
}

function adaptPortableAtlasUvs(mesh, scales) {
  if (scales.size === 0) return mesh
  const result = { ...mesh }
  for (const [set, scale] of scales) {
    const key = set === 0 ? 'uvs' : `uvs${set}`
    const values = mesh[key]
    if (!values) throw new TypeError(`fresh M3 atlas material requires UV${set}`)
    result[key] = values.map((value, component) =>
      Math.fround(value * scale[component % 2]),
    )
  }
  return result
}

/** Check every authored field against reopened native material data. Native-generated defaults
 * may add fields; an authored field cannot disappear. Arrays have exact length/order. */
/**
 * Common material slots StarCraft II has no MAT_ field for.
 *
 * The shared vocabulary is a superset of this format's: it lists twenty layer slots and MAT_ maps
 * eighteen. A material using one of the other two is using the contract correctly, so the round
 * trip must stop expecting it back rather than refusing the model - the encoder reports what it
 * left out, and that report is what reaches the caller.
 */
const UNWRITABLE_LAYER_SLOTS = ['teamColorMask', 'emissiveMask']

/**
 * Standard-material fields that were never file content.
 *
 * `normalMapFormat` is filled by the texture pipeline at bind time, and the space and transform
 * describe how to decode a normal texture that StarCraft II always decodes its own way. None of
 * them has a MAT_ field, and none is content the model authored.
 */
const RUNTIME_ONLY_STANDARD_FIELDS = ['normalMapFormat', 'normalMapSpace', 'normalMapTransform']

function withoutUnwritableMaterialFields(material) {
  const standard = material?.standard
  if (standard === undefined || standard === null) return material
  const layers = standard.layers ?? {}
  const droppedSlots = UNWRITABLE_LAYER_SLOTS.filter(slot => layers[slot] !== undefined)
  const droppedFields = RUNTIME_ONLY_STANDARD_FIELDS.filter(
    field => standard[field] !== undefined,
  )
  if (droppedSlots.length === 0 && droppedFields.length === 0) return material
  const keptLayers = Object.fromEntries(
    Object.entries(layers).filter(([slot]) => !droppedSlots.includes(slot)),
  )
  const keptStandard = Object.fromEntries(
    Object.entries(standard).filter(([field]) => !droppedFields.includes(field)),
  )
  return { ...material, standard: { ...keptStandard, layers: keptLayers } }
}

export function requireAuthoredMaterial(actual, expected, path = '') {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual) || !Number.isFinite(expected))
      throw new TypeError(`fresh material nonfinite at ${path}`)
    const color = /(?:\/baseColor\/\d+|\/constantColor\/value\/\d+|\/alphaTestThreshold)$/u.test(
      path,
    )
    if (
      actual !== expected &&
      Math.fround(actual) !== Math.fround(expected) &&
      !(color && Math.abs(actual - expected) <= 1 / 255 + 1e-8)
    )
      throw new TypeError(
        `fresh material is not natively representable at ${path}: expected ${expected}, reopened ${actual}`,
      )
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      throw new TypeError(`fresh material array differs at ${path}`)
    expected.forEach((value, index) =>
      requireAuthoredMaterial(actual[index], value, `${path}/${index}`),
    )
  } else if (expected !== null && typeof expected === 'object') {
    record(actual, path)
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key))
        throw new TypeError(
          `fresh M3 omitted authored material ${path}/${key}: ${JSON.stringify(value)}`,
        )
      requireAuthoredMaterial(actual[key], value, `${path}/${key}`)
    }
  } else if (actual !== expected)
    throw new TypeError(
      `fresh material differs at ${path}: expected ${JSON.stringify(expected)}, reopened ${JSON.stringify(actual)}`,
    )
}

function portableStandardFields(value) {
  const {
    sourceFlags: _sourceFlags,
    sourceAdditionalFlags: _sourceAdditionalFlags,
    materialClass: _materialClass,
    ...portable
  } = record(value, 'standard material')
  return portable
}

/**
 * Extensions this format has no field for, with what writing the model without them costs.
 *
 * Refusing the whole conversion over one of these stopped a model from reaching StarCraft II for
 * reasons that had nothing to do with whether its geometry could be written. Each is dropped and
 * reported, and the note says what the converted model will look like - a caller that cannot
 * accept the loss still learns about it, rather than getting a file that quietly differs.
 *
 * This is not a licence to drop anything unrecognised. An extension that would make the written
 * model wrong, rather than plainer, still refuses: that is the difference between a conversion
 * with a known cost and a file that lies about what it contains.
 */
const DROPPED_EXTENSIONS = new Map([
  [
    'UV_game_model_states',
    'named model states reference sibling model files, which StarCraft II keeps in its data catalog rather than in the model; the converted model is the base state alone',
  ],
  [
    // StarCraft II takes its team-colour mask from the diffuse texture's own alpha channel - its
    // standard material has no mask slot, and the diffuse layer's team-colour mode is a fixed
    // property of that slot rather than a field a writer can set. A source that keeps the mask in
    // a separate texture, as Warzone does, could only be carried by compositing that mask into the
    // diffuse alpha and writing a new texture, which a model writer has no business doing.
    'UV_game_material_team_color',
    'the team-colour mask is a separate texture, and StarCraft II reads its mask from the diffuse alpha; the converted model draws its base texture with no player colour',
  ],
])

/**
 * Take the dropped extensions out before anything reads the document.
 *
 * Both projections this writer can take - the rigid one and the static one - refuse a document
 * declaring an extension they cannot represent, and they are right to: a projection states what
 * it read. The decision to convert anyway belongs here, in the writer, where the target format is
 * known and the cost can be reported.
 */
function dropUnwritableExtensions(container, notes) {
  const document = container.document
  const declared = new Set([
    ...Object.keys(document.extensions ?? {}),
    ...(document.extensionsUsed ?? []),
    ...(document.extensionsRequired ?? []),
    ...(document.materials ?? []).flatMap(material => Object.keys(material.extensions ?? {})),
  ])
  const dropped = [...declared].filter(name => DROPPED_EXTENSIONS.has(name))
  if (dropped.length === 0) return container
  for (const name of dropped) notes.push(`${name} was dropped: ${DROPPED_EXTENSIONS.get(name)}`)
  const without = value =>
    Object.fromEntries(Object.entries(value ?? {}).filter(([name]) => !dropped.includes(name)))
  return {
    ...container,
    document: {
      ...document,
      // A dropped extension can sit on a material as well as on the document, and leaving one
      // there while removing its `extensionsUsed` entry makes the document invalid.
      ...(document.materials === undefined
        ? {}
        : {
            materials: document.materials.map(material => {
              if (material.extensions === undefined) return material
              const kept = without(material.extensions)
              const { extensions: _extensions, ...rest } = material
              return Object.keys(kept).length === 0 ? rest : { ...rest, extensions: kept }
            }),
          }),
      ...(document.extensions === undefined ? {} : { extensions: without(document.extensions) }),
      ...Object.fromEntries(
        ['extensionsUsed', 'extensionsRequired']
          .filter(key => document[key] !== undefined)
          .map(key => [key, document[key].filter(name => !dropped.includes(name))]),
      ),
    },
  }
}

export async function exportFreshM3FromUvm(
  container,
  metersPerNativeUnit,
  budget,
  signal,
  requestedFormat = 'm3',
  /** Collects what the target format had nowhere to put, for a caller that can report it. */
  notes = [],
  materialPolicy = 'strict',
) {
  signal?.throwIfAborted()
  if (!['strict', 'base-color-coverage'].includes(materialPolicy))
    throw new TypeError('unknown M3 materialPolicy')
  if (!Number.isFinite(metersPerNativeUnit) || metersPerNativeUnit <= 0)
    throw new TypeError('fresh M3 needs positive metersPerNativeUnit')
  const envelope = container.document.extras?.BlizzardM3
  assertM3MaterialWritable(envelope?.residual)
  let format = requestedFormat
  let sourceIsNative = false
  if (envelope !== undefined) {
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      envelope.schemaVersion !== 1 ||
      (envelope.format !== 'm3' && envelope.format !== 'm3a')
    )
      throw new TypeError('BlizzardM3 residual must use source-free schemaVersion 1')
    const frame = envelope.mapping?.frame
    if (!frame || typeof frame !== 'object')
      throw new TypeError('source-free M3 UVM requires its common import-frame mapping')
    // A frame node of its own (`matrix`) is how conversions before the materializer framed scenes
    // wrote it; such a document is converted again rather than read a second way.
    if (frame.matrix !== undefined)
      throw new TypeError('this M3 UVM predates the materializer frame; convert the model again')
    if (frame.dataCoordinates !== undefined && frame.dataCoordinates !== 'm3-native')
      throw new TypeError('source-free M3 UVM has an unknown source coordinate declaration')
    sourceIsNative = frame.dataCoordinates === 'm3-native'
    const containerBudget = {
      maxInputBytes: Number(
        budget.maxInputBytes > 0xffffffffn ? 0xffffffffn : budget.maxInputBytes,
      ),
      maxJsonBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    }
    const unframed = removeUvmFrameWrappers(container, containerBudget, signal)
    if (
      unframed.frame.upAxis !== '+z' ||
      unframed.frame.handedness !== 'right' ||
      unframed.frame.metersPerSourceUnit !== metersPerNativeUnit
    )
      throw new TypeError(
        `source-free M3 UVM frame is not the one its conversion wrote (${unframed.frame.upAxis}, ${unframed.frame.handedness}, ${unframed.frame.metersPerSourceUnit} against ${metersPerNativeUnit} m per unit)`,
      )
    container = unframed.container
    const extras = { ...(container.document.extras ?? {}) }
    delete extras.BlizzardM3
    if (Object.keys(extras).length > 0)
      throw new TypeError('fresh M3 cannot encode common document extras')
    container = { ...container, document: { ...container.document, extras } }
  }
  if (format !== 'm3' && format !== 'm3a')
    throw new TypeError('fresh Blizzard model format invalid')
  if (container.extraChunks.length)
    throw new TypeError('fresh M3 cannot discard unknown UVM binary chunks')
  for (const material of container.document.materials ?? [])
    assertM3MaterialWritable(material.extensions?.UV_game_material?.params?.renderModel?.metadata)
  container = prepareRigidM3Container(
    preparePlainM3Materials(materialPolicy === 'base-color-coverage'
      ? prepareM3RgbTint(dropUnwritableExtensions(container, notes), budget, signal, notes)
      : dropUnwritableExtensions(container, notes), materialPolicy, notes),
    budget,
    signal,
  )
  const projected =
    Array.isArray(container.document.skins) && container.document.skins.length > 0
      ? withM3BillboardBasis(
          withBatchVisibilityBones(
            projectUvmRigModel(
              container,
              { ...budget, spatialRoundoff: metersPerNativeUnit * 2 ** -149 },
              signal,
            ),
          ),
          !sourceIsNative,
        )
      : projectUvmStaticModel(container, budget, signal)
  const atlasScales = portableAtlasScales(projected.model.materials)
  const portableEffects = projectM3EffectsFromUvm(
    container,
    projected.nodeBoneIndices ?? {},
    budget,
    signal,
  )
  const attachments = projectM3AttachmentsFromUvm(
    container,
    projected.nodeBoneIndices ?? {},
    projected.nodeParents ?? {},
    budget,
    signal,
    envelope?.residual?.rigidBodies ?? [],
    notes,
    envelope?.residual?.degenerateRigidShapes ?? [],
  )
  const billboards = projectM3BillboardsFromUvm(
    container,
    projected.nodeBoneIndices ?? {},
    projected.billboards !== undefined,
  )
  const staticPreview = projectM3StaticPreviewFromUvm(
    container,
    envelope?.residual?.preview,
    metersPerNativeUnit,
  )
  const billboardBones = new Set(billboards.filter(value => value.flagOnly).map(value => value.boneIndex))
  const bbscRecords = billboards.filter(value => !value.flagOnly)
  const boneFlagXor = new Map()
  for (const value of envelope?.residual?.boneFlagXor ?? []) {
    if (
      !value ||
      !Number.isSafeInteger(value.boneIndex) ||
      value.boneIndex < 0 ||
      !Number.isSafeInteger(value.xor) ||
      value.xor < 0 ||
      value.xor > 0xffffffff ||
      boneFlagXor.has(value.boneIndex)
    )
      throw new TypeError('fresh M3 bone flag residual is invalid')
    boneFlagXor.set(value.boneIndex, value.xor)
  }
  if ([...boneFlagXor.keys()].some(index => index >= (projected.model.skeleton?.bones.length ?? 0)))
    throw new TypeError('fresh M3 bone flag residual target is absent')
  // One vertex layout serves every region. A region without vertex colour beside one with it (a
  // Warcraft III geoset tinted by its geoset animation) reads white, which is what it drew.
  const whiteWhereUncoloured =
    projected.model.meshes.some(mesh => mesh.colors) &&
    projected.model.meshes.some(mesh => !mesh.colors)
  const model = {
    ...projected.model,
    ...(projected.model.skeleton === undefined
      ? {}
      : {
          skeleton: {
            ...projected.model.skeleton,
            bones: projected.model.skeleton.bones.map((bone, index) => ({
              ...bone,
              flags:
                ((bone.flags ?? (0x2a07 | (billboardBones.has(index) ? 0x10 : 0))) ^
                  (boneFlagXor.get(index) ?? 0)) >>>
                0,
            })),
          },
        }),
    meshes: projected.model.meshes
      .map(mesh =>
        whiteWhereUncoloured && !mesh.colors
          ? { ...mesh, colors: new Array((mesh.positions.length / 3) * 4).fill(1) }
          : mesh,
      )
      .map(mesh =>
        adaptPortableAtlasUvs(
          mesh.normals === undefined
            ? { ...mesh, normals: [...generateUvmVertexNormals(mesh.positions, mesh.indices, signal)] }
            : mesh,
          atlasScales[mesh.materialIndex] ?? new Map(),
        ),
      ),
    materials: projected.model.materials.map(material =>
      adaptPortableMaterialToM3(material, envelope === undefined),
    ),
    ...(portableEffects === undefined ? {} : { effects: portableEffects }),
    metadata: {
      ...(projected.model.metadata ?? {}),
      ...(format === 'm3a' ? { assetKind: 'm3a-animation-bundle' } : {}),
      ...(Number.isSafeInteger(envelope?.residual?.m3aHash)
        ? { m3aHash: envelope.residual.m3aHash }
        : {}),
      ...(Array.isArray(envelope?.residual?.m3aHashes)
        ? { m3aHashes: envelope.residual.m3aHashes }
        : {}),
      ...(Array.isArray(envelope?.residual?.animationEvents)
        ? { m3AnimationEvents: envelope.residual.animationEvents }
        : {}),
      ...(Array.isArray(envelope?.residual?.animationTracks)
        ? { m3ResidualAnimationTracks: envelope.residual.animationTracks }
        : {}),
      ...(Array.isArray(envelope?.residual?.animationReferenceIds)
        ? { m3AnimationReferenceIds: envelope.residual.animationReferenceIds }
        : {}),
      ...(Array.isArray(envelope?.residual?.effectAnimationReferenceHeaders)
        ? { m3EffectAnimationReferenceHeaders: envelope.residual.effectAnimationReferenceHeaders }
        : {}),
      ...(bbscRecords.length ? { m3Billboards: bbscRecords } : {}),
      ...(attachments.sockets.length ? { m3AttachmentPoints: attachments.sockets.map(value => ({ name: value.name, boneIndex: value.boneIndex })) } : {}),
      ...(attachments.volumes.length || attachments.hittests.length
        ? { m3HitVolumes: { tight: null, hittests: attachments.hittests, attachmentVolumes: attachments.volumes } }
        : {}),
      ...(attachments.rigidBodies.length ? { m3RigidBodies: attachments.rigidBodies } : {}),
      ...(staticPreview.cameras.length ? { m3Cameras: staticPreview.cameras } : {}),
      ...(staticPreview.lights.length ? { m3Lights: staticPreview.lights } : {}),
    },
  }
  // The render program is the requirement. A foreign source's own layer list and metadata (a
  // Warcraft III layer's filter mode and texture list) describe that source's file: the reopened
  // M3 lists its own MAT_ layers instead, so only an M3 source is held to them.
  const materialRequirements = projected.materialRequirements
    .map(material => adaptPortableMaterialToM3(material, envelope === undefined))
    .map(withoutUnwritableMaterialFields)
    .map(material =>
      envelope === undefined
        ? Object.fromEntries(
            Object.entries(material).filter(([key]) => key !== 'layers' && key !== 'metadata'),
          )
        : material,
    )
  // M3 has one UV layout. Pad only coordinates never sampled by this region's program;
  // preserve every authored coordinate and refuse a missing set a material actually needs.
  for (const key of ['uvs1','uvs2','uvs3']) {
    if (!model.meshes.some(mesh=>mesh[key])) continue
    const set=Number(key.slice(-1))
    for (const mesh of model.meshes) if (!mesh[key]) {
      const program=model.materials[mesh.materialIndex]?.standard
      if (!program || Object.values(program.layers ?? {}).some(layer=>layer.texturePath && layer.uvSource===set))
        throw new TypeError(`fresh M3 cannot fill missing sampled UV${set}`)
      mesh[key]=new Array(mesh.positions.length/3*2).fill(0)
      notes.push(`Region ${mesh.name}: filled unused UV${set} with zero for the uniform M3 layout.`)
    }
  }
  if(model.meshes.some(mesh=>mesh.tangents)) for(const mesh of model.meshes) if(!mesh.tangents) {
    const program=model.materials[mesh.materialIndex]?.standard
    if(!program || Object.keys(program.layers ?? {}).some(slot=>/normal|bump/iu.test(slot)))
      throw new TypeError('fresh M3 cannot fill missing sampled tangent basis')
    mesh.tangents=Array.from({length:mesh.positions.length/3},()=>[1,0,0,1]).flat()
    notes.push(`Region ${mesh.name}: filled unused tangent basis for the uniform M3 layout.`)
  }
  const preparedRig =
    projected.restPoses === undefined
      ? undefined
      : prepareFreshM3RigModel(model, projected.restPoses, metersPerNativeUnit, sourceIsNative)
  const attributes = ['normals', 'tangents', 'colors', 'uvs', 'uvs1', 'uvs2', 'uvs3']
  if (format === 'm3a' && model.meshes.length !== 0)
    throw new TypeError('fresh M3A animation bundle cannot contain render meshes')
  const layout = attributes.map(key => model.meshes[0] && Object.hasOwn(model.meshes[0], key))
  for (const mesh of model.meshes) {
    if (!mesh.normals || !mesh.uvs)
      throw new TypeError(
        'fresh M3 requires explicit normals and UV0; native defaults must not invent shading inputs',
      )
    if (mesh.positions.length === 0 || mesh.positions.length / 3 > 65535 || mesh.indices.length < 3)
      throw new RangeError(
        'fresh M3 requires nonempty triangle regions with at most 65535 vertices',
      )
    if (attributes.some((key, index) => Object.hasOwn(mesh, key) !== layout[index]))
      throw new TypeError('fresh M3 requires one uniform vertex attribute layout across regions')
    if (mesh.positions.some(value => !Number.isFinite(Math.fround(value / metersPerNativeUnit))))
      throw new RangeError('fresh M3 position scaling exceeds float32')
  }
  materialRequirements.forEach(value => materialPreflight(value))
  const encoded = await encodeM3JsonModel(
    preparedRig?.model ?? model,
    {
      fileName: format === 'm3a' ? 'animation.m3a' : 'model.m3',
      upAxis: sourceIsNative ? 'z' : 'y',
      scale: 1 / metersPerNativeUnit,
      includeTextures: false,
    },
    budget,
    signal,
  )
  // An informational issue is the encoder saying what it wrote and what it left out, which is a
  // report; a warning or an error is something having gone wrong. Treating both as a refusal
  // meant a material using a slot the common vocabulary has and StarCraft II does not - a
  // separate team-colour mask, an emissive mask - stopped the whole conversion.
  const refusing = encoded.issues.filter(issue => issue.severity !== 'info')
  if (refusing.length || encoded.files?.length)
    throw new TypeError(
      `fresh M3 encoder refused complete output: ${refusing.map(issue => issue.code).join(', ')}`,
    )
  for (const issue of encoded.issues) notes.push(`${issue.code}: ${issue.message}`)
  const nativeBytes =
    preparedRig === undefined
      ? encoded.bytes
      : await restoreFreshM3Rig(
          encoded.bytes,
          model,
          projected.restPoses,
          projected.bounds,
          metersPerNativeUnit,
          preparedRig.interpolations,
          budget,
          signal,
          sourceIsNative,
        )
  const geometry = await decodeM3Geometry(nativeBytes, budget)
  if (geometry.primitives.length !== model.meshes.length)
    throw new TypeError('fresh M3 region count changed')
  const compare = (actual, expected, tolerance, label) => {
    if (
      !actual ||
      actual.length !== expected.length ||
      expected.some(
        (value, index) =>
          !Number.isFinite(actual[index]) || Math.abs(actual[index] - value) > tolerance,
      )
    )
      throw new TypeError(`fresh M3 geometry differs: ${label}`)
  }
  const basis = (values, width, scale = 1) =>
    sourceIsNative
      ? values.map(value => Math.fround(value * scale))
      :
    values.flatMap((_value, index) =>
      index % width === 0
        ? [
            Math.fround(values[index] * scale),
            Math.fround(-values[index + 2] * scale),
            Math.fround(values[index + 1] * scale),
            ...(width === 4 ? [values[index + 3]] : []),
          ]
        : [],
    )
  model.meshes.forEach((mesh, index) => {
    const actual = geometry.primitives[index]
    compare(actual.positions, basis(mesh.positions, 3, 1 / metersPerNativeUnit), 0, 'positions')
    compare(actual.indices, mesh.indices, 0, 'indices')
    if (mesh.normals)
      compare(actual.normals, basis(mesh.normals, 3), 1 / 255 + 1e-7, 'packed normals')
    if (mesh.tangents)
      compare(actual.tangents, basis(mesh.tangents, 4), 1 / 255 + 1e-7, 'packed tangents')
    if (mesh.colors) compare(actual.colors, mesh.colors, 1 / 255 + 1e-8, 'RGBA8')
    const uvSets = ['uvs', 'uvs1', 'uvs2', 'uvs3'].filter(key => mesh[key] !== undefined)
    const allUv = uvSets.flatMap(key => mesh[key])
    let minimum = 0,
      maximum = 0
    for (const value of allUv) {
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    const multiplier = Math.max(1 / 2048, ((maximum - minimum) / 2) * (32768 / 32767))
    const tolerance = multiplier / 65536 + Math.max(Math.abs(minimum), Math.abs(maximum), 1) * 2e-7
    uvSets.forEach((key, set) =>
      compare(
        actual.textureCoordinateSets.find(value => value.set === set)?.coordinates,
        mesh[key],
        tolerance,
        `UV${set}`,
      ),
    )
  })
  const reopened = await decodeM3Materials(nativeBytes, budget, signal)
  if (reopened.fatal || reopened.materials.length !== materialRequirements.length)
    throw new TypeError('fresh M3 material reopen differs')
  for (const [index, expected] of materialRequirements.entries()) {
    const ref = reopened.materials[index],
      render = ref?.shader?.parameters?.renderModel
    if (!render || render.version !== 1)
      throw new TypeError('fresh M3 material program is absent after encode')
    const { version: _version, ...fields } = render
    requireAuthoredMaterial({ name: ref.name, ...fields }, expected, `material ${index} `)
    // Standard shader defaults are behavior too: a native-added layer must not create an
    // unrequested emissive/specular contribution. Require the complete standard program both ways.
    requireAuthoredMaterial(
      portableStandardFields(expected.standard),
      portableStandardFields(fields.standard),
      `material ${index} /standard`,
    )
  }
  const reopenedAttachments = await decodeM3Attachments(nativeBytes, budget, signal)
  if (
    reopenedAttachments.fatal ||
    reopenedAttachments.sockets.length !== attachments.sockets.length ||
    reopenedAttachments.volumes.filter(volume => volume.types?.includes('attachment')).length !== attachments.volumes.length
  )
    throw new TypeError('fresh M3 attachment reopen differs')
  attachments.sockets.forEach((expected, index) => {
    const actual = reopenedAttachments.sockets[index]
    if (actual?.sourceName !== expected.name || actual.nodeId !== `bone/${expected.boneIndex}`)
      throw new TypeError('fresh M3 socket reopen differs')
  })
  const reopenedSource = await decodeM3UvmSource(nativeBytes, budget, signal)
  const reopenedVolumes = reopenedSource.attachmentVolumes
  if (reopenedSource.hittests.length !== attachments.hittests.length)
    throw new TypeError('fresh M3 hit test reopen differs')
  attachments.hittests.forEach((expected, index) => {
    const actual = reopenedSource.hittests[index]
    if (
      !actual ||
      actual.shape !== expected.shape ||
      actual.boneIndex !== expected.boneIndex ||
      actual.size0 !== expected.size0 ||
      actual.size1 !== expected.size1 ||
      actual.size2 !== expected.size2 ||
      actual.matrix4.some((value, component) => value !== expected.matrix4[component])
    )
      throw new TypeError('fresh M3 hit test reopen differs')
  })
  attachments.volumes.forEach((expected, index) => {
    const actual = reopenedVolumes[index]
    const expectedPositions = expected.positions?.flat()
    const meshDiffers = expected.positions !== undefined && (
      actual?.mesh?.positions === undefined ||
      actual.mesh.positions.length !== expectedPositions.length ||
      Array.from(actual.mesh.positions).some((value, component) => value !== expectedPositions[component]) ||
      actual?.mesh?.indices === undefined ||
      actual.mesh.indices.length !== expected.indices.length ||
      Array.from(actual.mesh.indices).some((value, component) => value !== expected.indices[component])
    )
    if (
      !actual ||
      actual.shape !== expected.shape ||
      actual.boneIndex !== expected.boneIndex ||
      actual.bone1 !== expected.boneIndex ||
      actual.bone2 !== expected.boneIndex ||
      actual.size0 !== expected.size0 ||
      actual.size1 !== expected.size1 ||
      actual.size2 !== expected.size2 ||
      actual.matrix4.some((value, component) => value !== expected.matrix4[component]) ||
      meshDiffers
    )
      throw new TypeError('fresh M3 attachment volume reopen differs')
  })
  signal?.throwIfAborted()
  return nativeBytes
}
