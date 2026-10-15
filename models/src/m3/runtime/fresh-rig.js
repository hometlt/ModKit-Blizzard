// Intended for models/src/m3/runtime. Native representation checks only; no new evaluator.
import { schemaText } from './schema.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
import { M3StructureDescription } from '../../../dist/m3/native/binary/structures.js'
import { M3FieldBytes } from '../../../dist/m3/native/binary/fields.js'
import { serializeM3SectionGraph } from '../../../dist/m3/native/structural.js'
import { decodeM3Animations } from './animation.js'
import { decodeM3Geometry } from './geometry.js'
import { CUBIC_SPLINE_LINE_TYPE, sampleTrackValue } from '@modkit/codec-kit/model-math/sequence-pose'

const slots = ['x', 'y', 'z', 'w']
const mapping = {
  translation: 'location',
  rotation: 'rotation',
  scale: 'scale',
}
function finite32(value) {
  const result = Math.fround(value)
  if (!Number.isFinite(result)) throw new RangeError('fresh rig scalar exceeds finite float32')
  return result
}
function nativeVector(values, kind, units, sourceIsNative = false) {
  if (sourceIsNative) {
    if (kind === 'rotation') {
      const length = Math.hypot(...values)
      return values.map(value => finite32(value / length))
    }
    if (kind === 'scale') return values.map(finite32)
    return values.map(value => finite32(value / units))
  }
  if (kind === 'scale') return [values[0], values[2], values[1]].map(finite32)
  if (kind === 'rotation') {
    const length = Math.hypot(...values)
    return [values[0] / length, -values[2] / length, values[1] / length, values[3] / length].map(
      finite32,
    )
  }
  return [values[0] / units, -values[2] / units, values[1] / units].map(finite32)
}
function nativeMatrix(values, units, sourceIsNative = false) {
  if (sourceIsNative)
    return Array.from({ length: 16 }, (_value, index) =>
      finite32(values[index] / (Math.floor(index / 4) === 3 && index % 4 < 3 ? units : 1)),
    )
  const axis = [0, 2, 1, 3],
    sign = [1, -1, 1, 1]
  return Array.from({ length: 16 }, (_value, index) => {
    const row = index % 4,
      column = Math.floor(index / 4)
    return finite32(
      (sign[row] * sign[column] * values[axis[column] * 4 + axis[row]]) /
        (column === 3 && row < 3 ? units : 1),
    )
  })
}
function records(sections, ref, tag, count) {
  const section = sections.getSectionByReference(ref)
  if (
    !section ||
    section.desc.history.name !== tag ||
    section.content.length !== count ||
    ref.entries !== count
  )
    throw new TypeError(`fresh ${tag} correspondence differs`)
  return section.content
}
function near(actual, expected, label, tolerance = 1e-6) {
  if (
    actual.length !== expected.length ||
    expected.some(
      (value, index) =>
        !Number.isFinite(actual[index]) ||
        (tolerance === 0
          ? !Object.is(actual[index], value)
          : Math.abs(actual[index] - value) > tolerance),
    )
  )
    throw new TypeError(`fresh native rig differs: ${label}`)
}
function vector(record) {
  return slots.filter(key => typeof record[key] === 'number').map(key => record[key])
}
function setVector(record, value) {
  value.forEach((item, index) => {
    if (!Object.hasOwn(record, slots[index])) throw new TypeError('fresh rig schema vector differs')
    record[slots[index]] = item
  })
}
function outwardFloat32(value) {
  const nearest = finite32(value)
  if (nearest >= value) return nearest
  const bytes = new ArrayBuffer(4),
    view = new DataView(bytes)
  view.setFloat32(0, nearest, true)
  view.setUint32(0, view.getUint32(0, true) + 1, true)
  const result = view.getFloat32(0, true)
  if (!Number.isFinite(result)) throw new RangeError('fresh rig outward bounds overflow float32')
  return result
}
function nativeBounds(sections, sequenceCount) {
  const values = [
    sections.model.boundings,
    sections.model.collision_boundings,
    ...records(sections, sections.model.sequences, 'SEQS', sequenceCount).map(
      sequence => sequence.bounding_sphere,
    ),
  ].map(bounds => ({ bounds, frame: 'model' }))
  for (const division of records(sections, sections.model.divisions, 'DIV_', 1)) {
    for (const msec of records(sections, division.msec, 'MSEC', 1)) {
      if (
        msec.node_index !== 0 ||
        msec.bounding.header.flags !== 0 ||
        msec.bounding.header.interpolation !== 0
      )
        throw new TypeError('fresh MSEC is not the expected static node-zero bound')
      values.push(
        { bounds: msec.bounding.default, frame: 'msec' },
        { bounds: msec.bounding.null, frame: 'msec' },
      )
    }
  }
  if (values.some(({ bounds }) => !bounds || bounds.desc.history.name !== 'BNDS'))
    throw new TypeError('fresh declared bounds schema differs')
  return values
}

const BAKE_STEP_MS = 1000 / 30
/** M3 plays a track stepped or linear, nothing curved. A cubic-spline track (its tangents from
 * MDX Hermite/Bezier or glTF CUBICSPLINE) becomes the linear track the shared sampler draws: its
 * keys kept exactly, and the curve sampled at 30 frames per second between them. */
function bakeCubicTrack(track, kind) {
  if (track?.lineType !== CUBIC_SPLINE_LINE_TYPE) return track
  const frames = track.keys.map(key => key.frame)
  const taken = new Set(frames.map(frame => Math.round(frame * 1000)))
  const first = frames[0] ?? 0
  const last = frames.at(-1) ?? 0
  for (let step = Math.ceil((first * 1000) / BAKE_STEP_MS); step * BAKE_STEP_MS < last * 1000; step += 1) {
    const ms = Math.round(step * BAKE_STEP_MS)
    if (taken.has(ms)) continue
    taken.add(ms)
    frames.push(ms / 1000)
  }
  frames.sort((left, right) => left - right)
  return {
    ...track,
    lineType: 1,
    keys: frames.map(frame => ({
      frame,
      vector: sampleTrackValue(track, frame, [], { isQuat: kind === 'rotation' }),
    })),
  }
}

/** Validate native limits before invoking the frozen encoder, and adapt only the scale
 * tracks which that encoder does not permute with upAxis=y. Own copy, no UVM mutation. */
export function prepareFreshM3RigModel(sourceModel, restPoses, units, sourceIsNative = false) {
  if (!Number.isFinite(units) || units <= 0 || restPoses.length !== sourceModel.skeleton.bones.length)
    throw new TypeError('fresh rig mapping is invalid')
  const model = {
    ...sourceModel,
    animations: sourceModel.animations.map(sequence => ({
      ...sequence,
      nodeTracks: sequence.nodeTracks.map(trackSet => {
        const baked = { ...trackSet }
        for (const kind of Object.keys(mapping)) if (trackSet[kind]) baked[kind] = bakeCubicTrack(trackSet[kind], kind)
        return baked
      }),
    })),
  }
  const interpolations = new Map()
  const varies = track => {
    const first = track.keys[0]?.vector
    return track.keys.some(key =>
      key.vector.some((value, component) => value !== first?.[component]),
    )
  }
  // M3 stores one interpolation header per BONE property. Resolve that header from
  // tracks with a real interval first; sequence-local constant fallbacks are removed
  // below and reconstructed from the BONE default by the native reader.
  for (const sequence of model.animations)
    for (const trackSet of sequence.nodeTracks)
      for (const kind of Object.keys(mapping)) {
        const track = trackSet[kind]
        if (!track || !varies(track)) continue
        const identity = `${trackSet.boneIndex}/${kind}`,
          previous = interpolations.get(identity)
        if (previous !== undefined && previous !== track.lineType)
          throw new TypeError(
            `M3 cannot encode different interpolation for bone property ${identity}: ${previous} and ${track.lineType}`,
          )
        interpolations.set(identity, track.lineType)
      }
  for (const mesh of model.meshes) {
    if (
      mesh.boneIndices.length !== (mesh.positions.length / 3) * 4 ||
      mesh.boneWeights.length !== mesh.boneIndices.length
    )
      throw new TypeError('fresh influence count differs')
    const used = new Set(mesh.boneIndices.filter((_bone, index) => mesh.boneWeights[index] > 0))
    if (used.size > 255) throw new RangeError('M3 region uses more than 255 bones')
  }
  const animations = model.animations.map(sequence => {
    const durationMs = Math.round(sequence.durationSeconds * 1000)
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 0x7fffffff)
      throw new RangeError('M3 sequence duration is outside signed millisecond range')
    const nodeTracks = sequence.nodeTracks.map(trackSet => {
      const mapped = { ...trackSet }
      for (const kind of Object.keys(mapping)) {
        const track = trackSet[kind]
        if (!track) continue
        const identity = `${trackSet.boneIndex}/${kind}`,
          previous = interpolations.get(identity)
        // The BONE header describes the default value. Per-sequence SD* blocks carry their own
        // interpolation flags, so different clips may legitimately use STEP and LINEAR.
        const first = track.keys[0]?.vector
        const varying = track.keys.some(key =>
          key.vector.some((value, component) => value !== first?.[component]),
        )
        if (varying && previous !== undefined && previous !== track.lineType)
          throw new TypeError(
            `M3 cannot encode different interpolation for bone property ${identity}: ${previous} and ${track.lineType}`,
          )
        let priorMs = -1
        for (const key of track.keys) {
          const ms = Math.round(key.frame * 1000)
          if (!Number.isSafeInteger(ms) || ms < 0 || ms > durationMs || ms <= priorMs)
            throw new TypeError(
              'M3 key times collapse or escape the sequence after millisecond rounding',
            )
          priorMs = ms
          nativeVector(key.vector, kind, units, sourceIsNative)
        }
        if (kind === 'scale')
          mapped[kind] = {
            ...track,
            keys: track.keys.map(key => ({
              ...key,
              vector: nativeVector(key.vector, kind, units, sourceIsNative),
            })),
          }
      }
      return mapped
    })
    return { ...sequence, nodeTracks }
  })
  return { model: { ...model, animations }, interpolations }
}

/** Only freshly emitted bytes: patch declared BONE defaults/nulls/interpolation and IREF
 * by the checked parent-before-child map, then serialize/reopen using frozen primitives. */
export async function restoreFreshM3Rig(
  bytes,
  sourceModel,
  restPoses,
  commonBounds,
  units,
  interpolations,
  budget,
  signal,
  sourceIsNative = false,
) {
  signal?.throwIfAborted()
  if (bytes.byteLength > budget.maxScalarBytes || BigInt(bytes.byteLength) > budget.maxInputBytes)
    throw new RangeError('fresh rig bytes exceed budget')
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, await schemaText())
  if (sections.length > budget.maxNodes) throw new RangeError('fresh rig sections exceed budget')
  const bones = records(sections, sections.model.bones, 'BONE', restPoses.length)
  const rests = records(sections, sections.model.bone_rests, 'IREF', restPoses.length)
  if (
    !Number.isFinite(commonBounds.radius) ||
    commonBounds.radius < 0 ||
    !Number.isFinite(commonBounds.msecRadius) ||
    commonBounds.msecRadius < commonBounds.radius
  )
    throw new TypeError('fresh rig requires complete global and root-frame bounds')
  const radii = {
    model: outwardFloat32(commonBounds.radius / units),
    msec: outwardFloat32(commonBounds.msecRadius / units),
  }
  // Preserve both interpretations of the undocumented MSEC node-zero frame.
  // MODL/SEQS retain model-space extents; only MSEC takes their union with root-local.
  for (const { bounds, frame } of nativeBounds(sections, sourceModel.animations.length || 1)) {
    const radius = radii[frame]
    setVector(bounds.min, [-radius, -radius, -radius])
    setVector(bounds.max, [radius, radius, radius])
    bounds.radius = radius
  }
  for (const [index, pose] of restPoses.entries()) {
    signal?.throwIfAborted()
    const bone = bones[index]
    if (
      bone.desc.version !== 1 ||
      rests[index].desc.version !== 0 ||
      bone.id !== index ||
      bone.parent !== pose.parentIndex ||
      pose.index !== index
    )
      throw new TypeError('fresh bone index/parent/schema differs')
    for (const [kind, field] of Object.entries(mapping)) {
      const values = nativeVector(pose[kind], kind, units, sourceIsNative)
      setVector(bone[field].default, values)
      setVector(bone[field].null, values)
      // A varying common channel owns interpolation. Constant projection tracks do not carry
      // enough behavior to replace the original static AnimationReference header.
      bone[field].header.interpolation =
        interpolations.get(`${index}/${kind}`) ?? bone[field].header.interpolation
    }
    const matrix = nativeMatrix(pose.inverseBindMatrix, units, sourceIsNative)
    slots.forEach((column, offset) =>
      setVector(rests[index].matrix[column], matrix.slice(offset * 4, offset * 4 + 4)),
    )
  }
  // Rig restoration never edits PHSH or its references. Preserve these freshly encoded records
  // as bytes: a second float read/write otherwise quietens signalling NaNs in unused fields.
  for (const section of sections) {
    if (section.desc.history.name !== 'PHSH') continue
    const size = section.desc.size, raw = section.rawBytes
    if (raw === null || raw.byteLength !== size * section.content.length)
      throw new TypeError('fresh rig PHSH source range is incomplete')
    const desc = new M3StructureDescription(section.desc.history, section.desc.version,
      { raw: new M3FieldBytes('raw', size, new Uint8Array(size)) }, size)
    section.content = section.content.map((_, index) => desc.instance(raw, index * size))
  }
  const output = serializeM3SectionGraph(sections)
  if (output.byteLength > budget.maxScalarBytes || BigInt(output.byteLength) > budget.maxInputBytes)
    throw new RangeError('fresh rig output exceeds budget')
  const reopened = await M3SectionList.load(Uint8Array.from(output).buffer, await schemaText())
  const actualBones = records(reopened, reopened.model.bones, 'BONE', restPoses.length),
    actualRests = records(reopened, reopened.model.bone_rests, 'IREF', restPoses.length)
  for (const { bounds, frame } of nativeBounds(reopened, sourceModel.animations.length || 1)) {
    const radius = radii[frame]
    near(vector(bounds.min), [-radius, -radius, -radius], 'bounds min', 0)
    near(vector(bounds.max), [radius, radius, radius], 'bounds max', 0)
    near([bounds.radius], [radius], 'bounds radius', 0)
  }
  restPoses.forEach((pose, index) => {
    for (const [kind, field] of Object.entries(mapping)) {
      const expected = nativeVector(pose[kind], kind, units, sourceIsNative)
      near(vector(actualBones[index][field].default), expected, `default ${index}/${kind}`, 0)
      near(vector(actualBones[index][field].null), expected, `null ${index}/${kind}`, 0)
    }
    near(
      slots.flatMap(column => vector(actualRests[index].matrix[column])),
      nativeMatrix(pose.inverseBindMatrix, units, sourceIsNative),
      `IREF ${index}`,
      0,
    )
  })
  const geometry = await decodeM3Geometry(output, budget)
  sourceModel.meshes.forEach((mesh, index) => {
    const actual = geometry.primitives[index]
    if (
      !actual?.boneIndices ||
      !actual.boneWeights ||
      actual.boneIndices.length !== mesh.boneIndices.length
    )
      throw new TypeError('fresh native influences absent')
    for (let offset = 0; offset < mesh.boneIndices.length; offset += 4) {
      const expected = new Map(),
        found = new Map()
      for (let slot = 0; slot < 4; slot++) {
        const sourceBone = mesh.boneIndices[offset + slot],
          actualBone = actual.boneIndices[offset + slot]
        expected.set(sourceBone, (expected.get(sourceBone) ?? 0) + mesh.boneWeights[offset + slot])
        found.set(actualBone, (found.get(actualBone) ?? 0) + actual.boneWeights[offset + slot])
      }
      for (const bone of new Set([...expected.keys(), ...found.keys()]))
        near(
          [found.get(bone) ?? 0],
          [expected.get(bone) ?? 0],
          `weights ${index}/${offset}/${bone}`,
          2 / 255 + 1e-7,
        )
    }
  })
  const animation = await decodeM3Animations(output, budget, signal)
  if (animation.fatal || animation.clips.length !== (sourceModel.animations.length || 1))
    throw new TypeError(
      `fresh sequence reopen differs: ${
        animation.fatal
          ? (animation.issues ?? []).map(item => `${item.code}: ${item.message}`).join('; ')
          : `${animation.clips.length} clip(s) reopened, ${sourceModel.animations.length || 1} written`
      }`,
    )
  sourceModel.animations.forEach((expected, index) => {
    const actual = animation.clips[index]
    if (
      actual.name !== expected.name ||
      actual.looping !== expected.looping ||
      actual.durationSeconds !== Math.round(expected.durationSeconds * 1000) / 1000
    )
      throw new TypeError(
        `fresh sequence identity differs: expected ${JSON.stringify({ name: expected.name, looping: expected.looping, durationSeconds: Math.round(expected.durationSeconds * 1000) / 1000 })}, got ${JSON.stringify(actual && { name: actual.name, looping: actual.looping, durationSeconds: actual.durationSeconds })}`,
      )
    for (const trackSet of expected.nodeTracks)
      for (const kind of Object.keys(mapping)) {
        const track = trackSet[kind]
        if (!track) continue
        const channel = actual.channels.find(
          value => value.target === `bone/${trackSet.boneIndex}` && value.kind === kind,
        )
        const expectedInterpolation =
          track.lineType === 0 ? 'step' : kind === 'rotation' ? 'spherical-linear' : 'linear'
        const firstValue = track.keys[0]?.vector
        const varying = track.keys.some(key =>
          key.vector.some((value, component) => value !== firstValue?.[component]),
        )
        // A single key has no interpolation interval. M3 keeps this flag on the shared
        // AnimationReference, so constant sequence fallbacks normalize to that shared flag.
        if (!channel || (varying && channel.interpolation !== expectedInterpolation))
          throw new TypeError(
            `fresh animation interpolation differs at ${index}/${trackSet.boneIndex}/${kind}: ` +
              `${channel?.interpolation ?? 'absent'} != ${expectedInterpolation}`,
          )
        for (const key of track.keys) {
          const sample = channel.samples.find(
            value => value.timeSeconds === Math.round(key.frame * 1000) / 1000,
          )
          if (!sample) throw new TypeError('fresh animation key absent')
          const wanted = nativeVector(key.vector, kind, units, sourceIsNative),
            dot = sample.value.reduce((sum, value, index) => sum + value * wanted[index], 0)
          near(
            sample.value,
            kind === 'rotation' && dot < 0 ? wanted.map(value => -value) : wanted,
            'animation key',
          )
        }
      }
  })
  signal?.throwIfAborted()
  return output
}
