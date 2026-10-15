/**
 * UVM -> Warcraft III MDX/MDL.
 *
 * Geometry, skin and the scene come from the common UVM structures; every native declaration comes
 * from the `BlizzardMDX` residual this repository's exporter writes. Nothing is reconstructed from
 * a name or a guess: a document without that residual is built from the common structures alone,
 * including the emitters `UV_game_effects` states in this renderer's own normalised vocabulary.
 * Both paths preserve all four supported UV sets and refuse missing/malformed authored channels.
 * Residual material reconstruction restores HD Fresnel vectors and gain/Fresnel tracks, including
 * their native interpolation, tangents and global clocks; this does not claim their render support.
 * Residual lights restore static Color/AmbColor as native float vectors, leaving their tracks intact;
 * static RGB requires exactly three finite numeric float32-range components, without coercion/clamp.
 * this is native MDX/MDL storage fidelity, not common light/DNC playback qualification.
 * An admitted static KMTE gain header survives MDX reconstruction. The shared game-owned header
 * guard refuses invalid carriers and non-default animated headers in MDL, not silent fallback loss.
 * Ribbon KRCO colour tracks use the existing common sequence vocabulary on the source-free path.
 * Source-free PRE2 keeps static standard-material priority/Unshaded and qualified WC3 material
 * metadata ReplaceableId/SortPrimsFarZ/Unfogged. Scene's public sampler owns validation; animated,
 * multi-pass/non-surface or unrepresentable PRE2 materials refuse rather than baking a first key.
 * Existing common lineEmitter/modelSpace/xyQuad booleans restore their native PRE2 bits alongside
 * the existing head/tail and squirt fields; no simulation or native visual fidelity is implied.
 * Canonical declaration: providers/war3-mdx-native-encoder/provider.json.
 */
import type { JsonObject, JsonValue, ModelPrimitive } from '@modkit/sdk'
import { admitWar3MaterialHeaders } from './native-material-headers.js'
import { readUvmContainer, type UvmContainerBudget } from '@modkit/uv/model/container'
import { readUvmFormatResidual } from '@modkit/uv/model/format-residual'
import { readUvmModel, type UvmGeometry, type UvmRig } from '@modkit/scene/uvm/model'
import { createRenderMaterialSampler, RENDER_MATERIAL_SHADER } from '@modkit/scene/materials'
type UvmScene = UvmGeometry
type UvmRigFacets = UvmRig
import { generateMDL, generateMDX, model as War3Native } from '../lib/war3-model/index.js'

export interface War3EncodeOptions {
  /** Target encoding; the residual records the source encoding but the caller chooses the target. */
  readonly encoding?: 'mdx' | 'mdl'
  /**
   * Metres per target unit, the inverse of the export scale. Warcraft III units have no declared
   * metre length, so a caller that scaled on the way in states the same number on the way out.
   */
  readonly metersPerTargetUnit?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Rebuild every authored UV set; a gap is not filled with invented coordinates. */
function nativeUvSets(primitive: ModelPrimitive, vertexCount: number): Float32Array[] {
  const sets = new Map((primitive.textureCoordinateSets ?? []).map(channel => [channel.set, channel.coordinates]))
  if (!sets.has(0) && primitive.textureCoordinates !== undefined) sets.set(0, primitive.textureCoordinates)
  if (sets.size === 0) return [new Float32Array(vertexCount * 2)]
  const last = Math.max(...sets.keys())
  if (last > 3) throw new RangeError('Warcraft III export supports at most four UV sets')
  return Array.from({ length: last + 1 }, (_, set) => {
    const coordinates = sets.get(set)
    if (coordinates === undefined || coordinates.length !== vertexCount * 2)
      throw new TypeError(`Warcraft III export UV set ${String(set)} is absent or malformed`)
    return Float32Array.from(coordinates)
  })
}

const numberOf = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const floats = (value: unknown, length: number): Float32Array => {
  const out = new Float32Array(length)
  const source = array(value)
  for (let index = 0; index < length; index += 1) out[index] = numberOf(source[index])
  return out
}

/** Typed arrays the writer expects, rebuilt from the residual's plain JSON numbers. */
function reviveAnimVector(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['Keys'])) return undefined
  return {
    LineType: numberOf(value['LineType']),
    ...(value['GlobalSeqId'] === null || value['GlobalSeqId'] === undefined
      ? {}
      : { GlobalSeqId: numberOf(value['GlobalSeqId']) }),
    Keys: value['Keys'].filter(isRecord).map(key => ({
      Frame: numberOf(key['Frame']),
      Vector: Float32Array.from(array(key['Vector']).map(item => numberOf(item))),
      ...(key['InTan'] === undefined
        ? {}
        : { InTan: Float32Array.from(array(key['InTan']).map(item => numberOf(item))) }),
      ...(key['OutTan'] === undefined
        ? {}
        : { OutTan: Float32Array.from(array(key['OutTan']).map(item => numberOf(item))) }),
    })),
  }
}

const TRACK_KEYS = [
  'Translation',
  'Rotation',
  'Scaling',
  'Visibility',
  'Alpha',
  'Color',
  'EmissiveGain',
  'FresnelColor',
  'FresnelOpacity',
  'FresnelTeamColor',
  'TextureID',
  'EmissionRate',
  'LifeSpan',
  'Speed',
  'Width',
  'Length',
  'Latitude',
  'Gravity',
  'Variation',
  'HeightAbove',
  'HeightBelow',
  'AttenuationStart',
  'AttenuationEnd',
  'Intensity',
  'AmbColor',
  'AmbIntensity',
]

/** Restore native records: plain JSON back into the typed shapes the writer reads. */
function reviveRecord(value: unknown, vectorKeys: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (TRACK_KEYS.includes(key) && isRecord(item) && Array.isArray(item['Keys'])) {
      const track = reviveAnimVector(item)
      if (track !== undefined) out[key] = track
      continue
    }
    if (vectorKeys.includes(key) && Array.isArray(item)) {
      out[key] = Float32Array.from(item.map(entry => numberOf(entry)))
      continue
    }
    out[key] = item
  }
  return out
}

const NODE_VECTORS = ['PivotPoint'] as const

/**
 * The surface the triangles describe, for geometry that states no normals of its own.
 *
 * Warcraft III stores a normal per vertex and a reader refuses a zero-length one, so writing
 * zeros produced a file this repository's own MDX reader would not take back. A source without
 * normals - Warzone's PIE has none - still describes a surface, and the area-weighted average of
 * the faces meeting at a vertex is that surface rather than an invented direction.
 */
function surfaceNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let triangle = 0; triangle + 2 < indices.length; triangle += 3) {
    const corners = [indices[triangle]!, indices[triangle + 1]!, indices[triangle + 2]!]
    if (corners.some(corner => corner * 3 + 2 >= positions.length)) continue
    const point = (corner: number): readonly number[] => [
      positions[corner * 3] ?? 0,
      positions[corner * 3 + 1] ?? 0,
      positions[corner * 3 + 2] ?? 0,
    ]
    const a = point(corners[0]!)
    const u = [0, 1, 2].map(axis => point(corners[1]!)[axis]! - a[axis]!)
    const v = [0, 1, 2].map(axis => point(corners[2]!)[axis]! - a[axis]!)
    // Cross product, unnormalised: its length is twice the triangle area, which weights a large
    // face more than a sliver meeting the same vertex.
    const face = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ]
    for (const corner of corners)
      for (let axis = 0; axis < 3; axis += 1)
        normals[corner * 3 + axis] = (normals[corner * 3 + axis] ?? 0) + face[axis]!
  }
  for (let vertex = 0; vertex + 2 < normals.length; vertex += 3) {
    const length = Math.hypot(normals[vertex]!, normals[vertex + 1]!, normals[vertex + 2]!)
    // A vertex no triangle reaches keeps a unit direction rather than a zero the reader refuses.
    if (length < 1e-12) normals[vertex + 2] = 1
    else for (let axis = 0; axis < 3; axis += 1) normals[vertex + axis]! /= length
  }
  return normals
}

/**
 * Undo the export scale.
 *
 * The exporter's z-up-to-y-up change is carried by a `Source coordinate frame` node, not by the
 * vertex buffers, so decoded positions are already in Warcraft III axes and rotating them here
 * would turn the model on its side. Only the unit scale has to come back out.
 */
function unrebase(values: Float32Array, scale: number, rotateOnly: boolean): Float32Array {
  if (rotateOnly || scale === 1) return Float32Array.from(values)
  const out = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) out[index] = values[index]! / scale
  return out
}

/** Matrix groups, rebuilt from the portable four-weight skin the exporter wrote. */
function matrixGroups(
  boneIndices: Uint32Array | undefined,
  boneWeights: Float32Array | undefined,
  vertexCount: number,
  /** The bone unskinned geometry rides, which every Warcraft III geoset has to name. */
  rigidBone: number,
): { vertexGroup: Uint8Array; groups: number[][] } {
  const vertexGroup = new Uint8Array(vertexCount)
  const groups: number[][] = []
  const byKey = new Map<string, number>()
  if (boneIndices === undefined || boneWeights === undefined) {
    // No skin. A group naming no matrices is not "unbound", it is a vertex whose weights sum to
    // zero, which this repository's own reader refuses - so the geometry names the one bone it
    // rides, which is what an unskinned mesh in this format is.
    return { vertexGroup, groups: [[rigidBone]] }
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const influences: number[] = []
    for (let slot = 0; slot < 4; slot += 1) {
      const offset = vertex * 4 + slot
      if ((boneWeights[offset] ?? 0) > 0) influences.push(boneIndices[offset] ?? 0)
    }
    const key = influences.join(',')
    let group = byKey.get(key)
    if (group === undefined) {
      group = groups.length
      groups.push(influences)
      byKey.set(key, group)
    }
    if (group > 255) throw new RangeError('Warcraft III geoset exceeds 256 matrix groups')
    vertexGroup[vertex] = group
  }
  return { vertexGroup, groups: groups.length === 0 ? [[]] : groups }
}



/**
 * UVM is y-up; Warcraft III is z-up. One fixed mapping relates them: (x, y, z) -> (x, -z, y).
 *
 * A document written by this repository carries that change in a `Source coordinate frame` node
 * rather than in its buffers, so composing a mesh node's world matrix and then converting axes
 * cancels out and leaves the native coordinates untouched. A document from another game is handled
 * by the same two steps without a special case.
 */
const uvmToWar3 = (x: number, y: number, z: number): [number, number, number] => [x, -z, y]

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function multiply(left: readonly number[], right: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let row = 0; row < 4; row += 1)
    for (let col = 0; col < 4; col += 1)
      for (let k = 0; k < 4; k += 1)
        out[col * 4 + row] =
          numberOf(out[col * 4 + row]) +
          numberOf(left[k * 4 + row]) * numberOf(right[col * 4 + k])
  return out
}

/** Column-major world matrix of a scene node, composed from its ancestors. */
function worldMatrices(nodes: readonly { id: string; childIds: readonly string[]; transform: readonly number[] }[]) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const parents = new Map<string, string>()
  for (const node of nodes) for (const child of node.childIds) parents.set(child, node.id)
  const cache = new Map<string, readonly number[]>()
  const resolve = (id: string, guard: Set<string>): readonly number[] => {
    const known = cache.get(id)
    if (known !== undefined) return known
    if (guard.has(id)) return IDENTITY_MATRIX
    guard.add(id)
    const node = byId.get(id)
    if (node === undefined) return IDENTITY_MATRIX
    const parentId = parents.get(id)
    const world =
      parentId === undefined ? [...node.transform] : multiply(resolve(parentId, guard), node.transform)
    cache.set(id, world)
    return world
  }
  return (id: string) => resolve(id, new Set())
}

/** Apply a world matrix to a position buffer, then land it in Warcraft III axes. */
function toWar3Positions(values: Float32Array, world: readonly number[], scale: number): Float32Array {
  const out = new Float32Array(values.length)
  for (let index = 0; index + 2 < values.length; index += 3) {
    const x = values[index]!,
      y = values[index + 1]!,
      z = values[index + 2]!
    const wx = numberOf(world[0]) * x + numberOf(world[4]) * y + numberOf(world[8]) * z + numberOf(world[12])
    const wy = numberOf(world[1]) * x + numberOf(world[5]) * y + numberOf(world[9]) * z + numberOf(world[13])
    const wz = numberOf(world[2]) * x + numberOf(world[6]) * y + numberOf(world[10]) * z + numberOf(world[14])
    const [ax, ay, az] = uvmToWar3(wx, wy, wz)
    out[index] = ax / scale
    out[index + 1] = ay / scale
    out[index + 2] = az / scale
  }
  return out
}

/** Directions take the rotation but neither the translation nor the scale. */
function toWar3Directions(values: Float32Array, world: readonly number[]): Float32Array {
  const out = new Float32Array(values.length)
  for (let index = 0; index + 2 < values.length; index += 3) {
    const x = values[index]!,
      y = values[index + 1]!,
      z = values[index + 2]!
    const wx = numberOf(world[0]) * x + numberOf(world[4]) * y + numberOf(world[8]) * z
    const wy = numberOf(world[1]) * x + numberOf(world[5]) * y + numberOf(world[9]) * z
    const wz = numberOf(world[2]) * x + numberOf(world[6]) * y + numberOf(world[10]) * z
    const [ax, ay, az] = uvmToWar3(wx, wy, wz)
    const length = Math.hypot(ax, ay, az) || 1
    out[index] = ax / length
    out[index + 1] = ay / length
    out[index + 2] = az / length
  }
  return out
}

/**
 * Animation tracks from the common clips.
 *
 * Warcraft III keeps every sequence on one timeline, so each clip's samples are offset into the
 * interval the caller laid out for it. Values change basis with the same axis mapping as the
 * geometry: a translation is a point difference, a rotation is conjugated by the axis change, and
 * a scale permutes with it.
 *
 * A `cubic-spline` channel is written as Hermite (line type 2): MDX states a tangent over the key
 * interval, so each derivative per second is multiplied by the seconds to the neighbouring key.
 * The mapping is linear, so a tangent changes basis exactly as its value does.
 *
 * A translation channel replaces the node's rest translation, while an MDX key moves the node from
 * its pivot, whose offset from the parent's pivot is that rest translation; `rest` (the node's rest
 * translation in UVM axes) is taken off each value.
 */
/**
 * The global sequences of the written model: the emitters' cycles and those of concurrent node
 * tracks, one entry per distinct length; each node track gets the GlobalSeqId of its length.
 */
function withGlobalNodeTracks(
  globalSequences: number[],
  tracks: readonly { readonly track: Record<string, unknown>; readonly lengthMilliseconds: number }[],
): number[] {
  for (const { track, lengthMilliseconds } of tracks) {
    const known = globalSequences.indexOf(lengthMilliseconds)
    track['GlobalSeqId'] = known === -1 ? globalSequences.push(lengthMilliseconds) - 1 : known
  }
  return globalSequences
}

function trackFromChannels(
  channels: readonly {
    kind: string
    samples?: readonly {
      timeSeconds?: number
      frame: number
      value: readonly number[]
      inTangent?: readonly number[]
      outTangent?: readonly number[]
    }[]
    interpolation?: string
  }[],
  kind: 'translation' | 'rotation' | 'scale',
  startMilliseconds: number,
  rest: readonly number[] = [0, 0, 0],
): Record<string, unknown> | undefined {
  const channel = channels.find(entry => entry.kind === kind)
  const samples = channel?.samples
  if (channel === undefined || samples === undefined || samples.length === 0) return undefined
  const cubic =
    channel.interpolation === 'cubic-spline' &&
    samples.every(sample => sample.inTangent !== undefined && sample.outTangent !== undefined)
  const lineType = channel.interpolation === 'step' ? 0 : cubic ? 2 : 1
  // r = -90 degrees about X takes UVM's y-up into Warcraft III's z-up; the rotation in the new
  // basis is r * q * r^-1, which for this r is the same component permutation with one sign.
  const war3 = (vector: readonly number[], w = 1): number[] => {
    const mapped = uvmToWar3(numberOf(vector[0]), numberOf(vector[1]), numberOf(vector[2]))
    return kind === 'rotation' ? [...mapped, numberOf(vector[3], w)] : mapped
  }
  const seconds = (index: number) => numberOf(samples[index]?.timeSeconds)
  const keys = samples.map((sample, index) => {
    const frame = Math.round(startMilliseconds + seconds(index) * 1000)
    let value = war3(
      kind === 'translation'
        ? [0, 1, 2].map(axis => numberOf(sample.value[axis]) - numberOf(rest[axis]))
        : sample.value,
    )
    // A scale is per-axis magnitude: it permutes with the axes and never takes their sign, and
    // its tangent follows whatever sign the magnitude dropped.
    const signs = value.map(component => (kind === 'scale' && component < 0 ? -1 : 1))
    if (kind === 'scale') value = value.map(Math.abs)
    if (!cubic) return { Frame: frame, Vector: Float32Array.from(value) }
    const tangent = (derivative: readonly number[], span: number) =>
      Float32Array.from(war3(derivative, 0).map((component, axis) => component * signs[axis]! * span))
    return {
      Frame: frame,
      Vector: Float32Array.from(value),
      InTan: tangent(sample.inTangent!, index === 0 ? 0 : seconds(index) - seconds(index - 1)),
      OutTan: tangent(
        sample.outTangent!,
        index === samples.length - 1 ? 0 : seconds(index + 1) - seconds(index),
      ),
    }
  })
  return { LineType: lineType, Keys: keys }
}

/**
 * A Warcraft III model from common UVM structures alone.
 *
 * This is the path a document from another game takes: StarCraft II exports UVM with a
 * `BlizzardM3` residual, which says nothing about MDX, so the target format is built from what
 * every UVM document has — nodes, meshes, materials, the skin and the clips. Native chunks that
 * Warcraft III requires and UVM does not carry get their format defaults, and that is stated
 * rather than dressed up as recovered data.
 */
/** Node flag values Warcraft III uses to say what kind of node a record is. */
const ATTACHMENT_NODE = 2048
const PARTICLE_EMITTER_NODE = 4096
const COLLISION_SHAPE_NODE = 8192
const RIBBON_EMITTER_NODE = 16384

/**
 * Attachment points and collision volumes a foreign document already marks on its own nodes.
 *
 * Both are ordinary nodes in Warcraft III, so nothing new is created: the node the common
 * document annotated becomes the ATCH or CLID record, keeping the transform the scene gave it.
 * A volume whose shape this format has no word for - a capsule, a hull, a mesh - is reported
 * instead of being squared off into a box the source never declared.
 */
function spatialFromCommon(
  document: JsonObject,
  nodes: readonly { readonly ObjectId: number; readonly PivotPoint: Float32Array }[],
  notes: string[],
): {
  readonly attachments: Record<string, unknown>[]
  readonly collisionShapes: Record<string, unknown>[]
  readonly kinds: ReadonlyMap<number, number>
} {
  const attachments: Record<string, unknown>[] = []
  const collisionShapes: Record<string, unknown>[] = []
  const kinds = new Map<number, number>()
  const documentNodes = array(document['nodes'])
  for (const [index, candidate] of documentNodes.entries()) {
    if (!isRecord(candidate)) continue
    const extensions = isRecord(candidate['extensions'])
      ? (candidate['extensions'] as Record<string, unknown>)
      : undefined
    if (extensions === undefined) continue
    const node = nodes[index]
    if (node === undefined) continue

    const socket = extensions['UV_game_socket']
    if (isRecord(socket)) {
      kinds.set(node.ObjectId, ATTACHMENT_NODE)
      attachments.push({
        ...node,
        Flags: ATTACHMENT_NODE,
        AttachmentID: attachments.length,
        Path: '',
      })
    }

    const collision = extensions['UV_game_collision']
    if (!isRecord(collision)) continue
    const shape = array(collision['shapes'])[0]
    if (!isRecord(shape)) continue
    const matrix = array(shape['matrix']).map(value => numberOf(value))
    const centre =
      matrix.length === 16 ? [matrix[12]!, matrix[13]!, matrix[14]!] : [0, 0, 0]
    if (shape['kind'] === 'box') {
      const size = array(shape['size']).map(value => numberOf(value))
      if (size.length !== 3 || size.some(value => !(value > 0))) {
        notes.push(`collision volume on node ${String(index)} has no usable extents`)
        continue
      }
      kinds.set(node.ObjectId, COLLISION_SHAPE_NODE)
      collisionShapes.push({
        ...node,
        Flags: COLLISION_SHAPE_NODE,
        Shape: 0,
        Vertices: Float32Array.from([
          centre[0]! - size[0]! / 2, centre[1]! - size[1]! / 2, centre[2]! - size[2]! / 2,
          centre[0]! + size[0]! / 2, centre[1]! + size[1]! / 2, centre[2]! + size[2]! / 2,
        ]),
      })
      continue
    }
    if (shape['kind'] === 'sphere') {
      const radius = numberOf(shape['radius'], -1)
      if (!(radius > 0)) {
        notes.push(`collision volume on node ${String(index)} has no usable radius`)
        continue
      }
      kinds.set(node.ObjectId, COLLISION_SHAPE_NODE)
      collisionShapes.push({
        ...node,
        Flags: COLLISION_SHAPE_NODE,
        // War3.CollisionShapeType.Sphere is 2; the value is stated rather than dereferenced.
        Shape: 2,
        Vertices: Float32Array.from(centre),
        BoundsRadius: radius,
      })
      continue
    }
    notes.push(
      `collision volume on node ${String(index)} is a ${String(shape['kind'])}, which Warcraft III cannot state`,
    )
  }
  return { attachments, collisionShapes, kinds }
}

/**
 * Emitters a foreign document already states, in the vocabulary `UV_game_effects` uses.
 *
 * That vocabulary is this renderer's own: `buildEffects` normalises a Warcraft III emitter into
 * it, and StarCraft II's codec publishes the same field names for the same concepts, so writing a
 * ParticleEmitter2 back out is that normalisation inverted rather than a translation between two
 * games' private words.
 *
 * A native emitter is a fixed-width record, so every field is written whether or not the source
 * named it. The unnamed ones get the value the format treats as "nothing here" - white segments,
 * no scroll, one frame - which is what a native authoring tool would have stored for an emitter
 * that says nothing about them.
 *
 * Animated properties arrive as `sequenceAnimation`: per source sequence, keys in the document's
 * `trackTimeUnit` (seconds unless stated) from that sequence's start. Warcraft III keeps one track
 * per property on the shared millisecond timeline, so each sequence's keys are placed in the slot
 * its clip was laid out in. A property with no Warcraft III track, and a whole-timeline
 * `animation` track, are reported: an emitter that pulses in the source and stands still in the
 * target is a difference the caller has to know about.
 */
/** Common animated property -> the ParticleEmitter2 field whose KP2* track carries it. */
const PARTICLE_TRACKS = Object.freeze({
  visibility: ['Visibility', false],
  emissionRate: ['EmissionRate', false],
  width: ['Width', false],
  length: ['Length', false],
  speed: ['Speed', false],
  latitude: ['Latitude', false],
  gravity: ['Gravity', false],
  variation: ['Variation', false],
} as const)

/** Common animated property -> the RibbonEmitter field whose KR* track carries it. */
const RIBBON_TRACKS = Object.freeze({
  color: ['Color', false],
  visibility: ['Visibility', false],
  heightAbove: ['HeightAbove', false],
  heightBelow: ['HeightBelow', false],
  alpha: ['Alpha', false],
  textureSlot: ['TextureSlot', true],
} as const)

/** Static PRE2 storage facts, not a promise of common-renderer particle sorting. */
interface ParticleMaterialStyle {
  readonly priorityPlane: number
  readonly replaceableId: number
  readonly flags: number
}

/** Translate effect records; the validated material callback supplies only native PRE2 facts. */
function emittersFromCommon(
  document: JsonObject,
  nodeIndexOf: (value: unknown) => number | undefined,
  textureIndexFor: (path: string) => number,
  materialStyleOf: (index: unknown) => ParticleMaterialStyle,
  nextObjectId: () => number,
  slotOf: (sequenceIndex: number) => { readonly start: number; readonly duration: number } | undefined,
  notes: string[],
): {
  readonly particles: Record<string, unknown>[]
  readonly ribbons: Record<string, unknown>[]
  readonly nodes: Record<string, unknown>[]
  readonly globalSequences: number[]
} {
  const extensions = isRecord(document['extensions'])
    ? (document['extensions'] as Record<string, unknown>)
    : {}
  const effects = isRecord(extensions['UV_game_effects'])
    ? (extensions['UV_game_effects'] as Record<string, unknown>)
    : undefined
  const particles: Record<string, unknown>[] = []
  const ribbons: Record<string, unknown>[] = []
  const nodes: Record<string, unknown>[] = []
  // Lengths in milliseconds of the concurrent tracks' own cycles, written as global sequences.
  const globalSequences: number[] = []
  if (effects === undefined) return { particles, ribbons, nodes, globalSequences }

  const millisecondsPerUnit = effects['trackTimeUnit'] === 'milliseconds' ? 1 : 1000
  const unplaced = new Set<string>()
  let mixedLineTypes = 0
  /** The native tracks of one emitter, keyed by the record field each one replaces. */
  const tracksOf = (
    effect: Record<string, unknown>,
    mapping: Readonly<Record<string, readonly [field: string, integer: boolean]>>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const animation = effect['sequenceAnimation']
    if (!isRecord(animation)) return out
    for (const [property, perSequence] of Object.entries(animation)) {
      const target = mapping[property]
      if (target === undefined) {
        unplaced.add(property)
        continue
      }
      const [field, integer] = target
      const vector = (values: unknown): Float32Array | Int32Array =>
        integer
          ? Int32Array.from(array(values).map(value => Math.round(numberOf(value))))
          : Float32Array.from(array(values).map(value => numberOf(value)))
      // A track on its own cycle in every sequence is a global sequence: one native track on that
      // clock, not a copy cut into each sequence.
      const cycle = array(perSequence).find(
        entry =>
          isRecord(entry) &&
          entry['concurrent'] === true &&
          typeof entry['wrapSeconds'] === 'number' &&
          entry['wrapSeconds'] > 0 &&
          isRecord(entry['track']),
      ) as Record<string, unknown> | undefined
      if (cycle !== undefined) {
        const length = Math.round(numberOf(cycle['wrapSeconds']) * 1000)
        const known = globalSequences.indexOf(length)
        const GlobalSeqId = known === -1 ? globalSequences.push(length) - 1 : known
        const track = cycle['track'] as Record<string, unknown>
        const lineType = numberOf(track['lineType'], 1)
        const keys = array(track['keys']).filter(isRecord).map(key => ({
          Frame: Math.round(numberOf(key['frame']) * millisecondsPerUnit),
          Vector: vector(key['vector']),
          ...(key['inTan'] === undefined ? {} : { InTan: vector(key['inTan']) }),
          ...(key['outTan'] === undefined ? {} : { OutTan: vector(key['outTan']) }),
        }))
        if (keys.length > 0)
          out[field] = {
            LineType: (lineType === 2 || lineType === 3) && keys.every(key => key.InTan !== undefined && key.OutTan !== undefined) ? lineType : lineType === 0 ? 0 : 1,
            GlobalSeqId,
            Keys: keys,
          }
        continue
      }
      const lineTypes = new Set<number>()
      const keys: { Frame: number; Vector: Float32Array | Int32Array; InTan?: unknown; OutTan?: unknown }[] = []
      for (const entry of array(perSequence)) {
        if (!isRecord(entry) || !isRecord(entry['track'])) continue
        const slot = slotOf(numberOf(entry['sequenceIndex'], -1))
        if (slot === undefined) continue
        const track = entry['track'] as Record<string, unknown>
        lineTypes.add(numberOf(track['lineType'], 1))
        for (const key of array(track['keys'])) {
          if (!isRecord(key)) continue
          const offset = Math.round(numberOf(key['frame']) * millisecondsPerUnit)
          if (offset < 0 || offset > slot.duration) continue
          keys.push({
            Frame: slot.start + offset,
            Vector: vector(key['vector']),
            ...(key['inTan'] === undefined ? {} : { InTan: vector(key['inTan']) }),
            ...(key['outTan'] === undefined ? {} : { OutTan: vector(key['outTan']) }),
          })
        }
      }
      if (keys.length === 0) continue
      // One native track has one line type. Sequences that disagree are written linear; a curve
      // is kept only when every key carries both tangents it needs.
      if (lineTypes.size > 1) mixedLineTypes += 1
      const [only] = lineTypes
      const curve =
        lineTypes.size === 1 &&
        (only === 2 || only === 3) &&
        keys.every(key => key.InTan !== undefined && key.OutTan !== undefined)
      out[field] = {
        LineType: curve ? only : lineTypes.size === 1 && only === 0 ? 0 : 1,
        Keys: keys.sort((left, right) => left.Frame - right.Frame),
      }
    }
    return out
  }

  let animated = 0
  const scalar = (effect: Record<string, unknown>, key: string): number | undefined => {
    const value = effect[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const triple = (value: unknown): [number, number, number] | undefined => {
    const values = array(value)
    return values.length === 3
      ? [numberOf(values[0]), numberOf(values[1]), numberOf(values[2])]
      : undefined
  }
  const nodeRecord = (
    effect: Record<string, unknown>,
    kind: number,
    ordinal: number,
    label: string,
  ): Record<string, unknown> => {
    if (isRecord(effect['animation'])) animated += 1
    return {
      Name: (typeof effect['name'] === 'string' && effect['name'] !== ''
        ? effect['name']
        : `${label}-${String(ordinal)}`
      ).slice(0, 80),
      ObjectId: nextObjectId(),
      // The emitter rides the node the source hung it on, which already carries its pivot.
      Parent: nodeIndexOf(effect['node']) ?? null,
      PivotPoint: Float32Array.from([0, 0, 0]),
      Flags: kind,
    }
  }

  for (const [ordinal, candidate] of array(effects['particles']).entries()) {
    if (!isRecord(candidate)) continue
    const effect = candidate as Record<string, unknown>
    const style = materialStyleOf(effect['material'])
    const texture = effect['texturePath']
    const segments = array(effect['segmentColors'])
      .map(entry => triple(entry))
      .filter((entry): entry is [number, number, number] => entry !== undefined)
    const alphas = triple(effect['segmentAlphas']) ??
      (scalar(effect, 'alpha') === undefined
        ? undefined
        : ([scalar(effect, 'alpha')!, scalar(effect, 'alpha')!, scalar(effect, 'alpha')!] as [
            number,
            number,
            number,
          ]))
    const record: Record<string, unknown> = {
      ...nodeRecord(effect, PARTICLE_EMITTER_NODE, ordinal, 'particles'),
      Flags: PARTICLE_EMITTER_NODE | style.flags |
        (effect['lineEmitter'] === true ? War3Native.ParticleEmitter2Flags.LineEmitter : 0) |
        (effect['modelSpace'] === true ? War3Native.ParticleEmitter2Flags.ModelSpace : 0) |
        (effect['xyQuad'] === true ? War3Native.ParticleEmitter2Flags.XYQuad : 0),
      Speed: scalar(effect, 'speed') ?? 0,
      Variation: scalar(effect, 'variation') ?? 0,
      Latitude: scalar(effect, 'latitude') ?? 0,
      Gravity: scalar(effect, 'gravity') ?? 0,
      LifeSpan: scalar(effect, 'lifeSpan') ?? 1,
      EmissionRate: scalar(effect, 'emissionRate') ?? 0,
      Width: scalar(effect, 'width') ?? 0,
      Length: scalar(effect, 'length') ?? 0,
      FilterMode: scalar(effect, 'filterMode') ?? 0,
      Rows: scalar(effect, 'rows') ?? 1,
      Columns: scalar(effect, 'columns') ?? 1,
      // Head and tail are two booleans in the common record and one bit field in the native one.
      // An emitter that claims neither still has to draw something, so it draws heads.
      FrameFlags:
        ((effect['head'] === true ? 1 : 0) | (effect['tail'] === true ? 2 : 0)) || 1,
      TailLength: scalar(effect, 'tailLength') ?? 0,
      Time: scalar(effect, 'timeMiddle') ?? 0.5,
      SegmentColor:
        segments.length === 3
          ? segments.map(color => Float32Array.from(color))
          : [1, 1, 1].map(() => Float32Array.from([1, 1, 1])),
      Alpha: Uint8Array.from(
        (alphas ?? [1, 1, 1]).map(value => Math.max(0, Math.min(255, Math.round(value * 255)))),
      ),
      ParticleScaling: Float32Array.from(triple(effect['particleScaling']) ?? [1, 1, 1]),
      LifeSpanUVAnim: Uint32Array.from(triple(effect['lifeSpanUvAnim']) ?? [0, 0, 0]),
      DecayUVAnim: Uint32Array.from(triple(effect['decayUvAnim']) ?? [0, 0, 0]),
      TailUVAnim: Uint32Array.from(triple(effect['tailUvAnim']) ?? [0, 0, 0]),
      TailDecayUVAnim: Uint32Array.from(triple(effect['tailDecayUvAnim']) ?? [0, 0, 0]),
      TextureID: typeof texture === 'string' && texture !== '' ? textureIndexFor(texture) : 0,
      Squirt: effect['squirt'] === true,
      PriorityPlane: style.priorityPlane,
      ReplaceableId: style.replaceableId,
    }
    particles.push({ ...record, ...tracksOf(effect, PARTICLE_TRACKS) })
  }

  for (const [ordinal, candidate] of array(effects['ribbons']).entries()) {
    if (!isRecord(candidate)) continue
    const effect = candidate as Record<string, unknown>
    const material = effect['material']
    const record: Record<string, unknown> = {
      ...nodeRecord(effect, RIBBON_EMITTER_NODE, ordinal, 'ribbons'),
      HeightAbove: scalar(effect, 'heightAbove') ?? 0,
      HeightBelow: scalar(effect, 'heightBelow') ?? 0,
      Alpha: scalar(effect, 'alpha') ?? 1,
      Color: Float32Array.from(triple(effect['color']) ?? [1, 1, 1]),
      ColorFallback: Float32Array.from(triple(effect['color']) ?? [1, 1, 1]),
      LifeSpan: scalar(effect, 'lifeSpan') ?? 1,
      TextureSlot: scalar(effect, 'textureSlot') ?? 0,
      EmissionRate: Math.round(scalar(effect, 'emissionRate') ?? 0),
      Rows: Math.round(scalar(effect, 'rows') ?? 1),
      Columns: Math.round(scalar(effect, 'columns') ?? 1),
      MaterialID:
        typeof material === 'number' && Number.isSafeInteger(material) && material >= 0
          ? material
          : 0,
      Gravity: scalar(effect, 'gravity') ?? 0,
    }
    ribbons.push({ ...record, ...tracksOf(effect, RIBBON_TRACKS) })
  }

  nodes.push(...particles, ...ribbons)
  if (animated > 0)
    notes.push(
      `${String(animated)} emitter(s) carry whole-timeline \`animation\` tracks with no sequence ` +
        'to place them in; they keep their static values',
    )
  if (unplaced.size > 0)
    notes.push(
      'animated emitter properties with no Warcraft III track keep their static values: ' +
        [...unplaced].sort().join(', '),
    )
  if (mixedLineTypes > 0)
    notes.push(
      `${String(mixedLineTypes)} emitter track(s) change interpolation between sequences and are ` +
        'written linear: a Warcraft III track has one line type',
    )
  return { particles, ribbons, nodes, globalSequences }
}

/** Build a fresh native model, preserving representable common channels without format residual. */
function nativeFromCommon(
  model: { readonly scene: UvmScene; readonly rig: UvmRigFacets },
  document: JsonObject,
  scale: number,
  notes: string[],
  budget: UvmContainerBudget,
  signal?: AbortSignal,
): Record<string, unknown> {
  const sceneNodes = model.scene.nodes
  const indexById = new Map(sceneNodes.map((node, index) => [node.id, index]))
  const parentById = new Map<string, string>()
  for (const node of sceneNodes)
    for (const childId of node.childIds) parentById.set(childId, node.id)

  // MDX pivots are absolute, so each node's world translation is its chain of local ones.
  const pivotWorld = worldMatrices(sceneNodes)
  const worldPivot = (nodeId: string): [number, number, number] => {
    const world = pivotWorld(nodeId)
    const [x, y, z] = uvmToWar3(numberOf(world[12]), numberOf(world[13]), numberOf(world[14]))
    return [x / scale, y / scale, z / scale]
  }

  const boneNodeIds = new Set(
    model.rig.bindings.map(binding => binding.nodeId).filter((id): id is string => id !== undefined),
  )
  const nodes = sceneNodes.map((node, index) => {
    const pivot = worldPivot(node.id)
    const parentId = parentById.get(node.id)
    const parent = parentId === undefined ? null : (indexById.get(parentId) ?? null)
    return {
      Name: (node.name ?? node.id).slice(0, 80),
      ObjectId: index,
      Parent: parent,
      PivotPoint: Float32Array.from(pivot),
      Flags: 0,
    }
  })
  // Concurrent node channels (a global sequence in the source: flies, flags, rotors) are one track
  // on a global sequence of their wrap length, written once; their GlobalSeqId is set once the
  // emitters' global sequences are known.
  const globalNodeTracks: { readonly track: Record<string, unknown>; readonly lengthMilliseconds: number }[] = []
  const attachTracks = () => {
    const writtenGlobal = new Set<string>()
    for (const clip of clips) {
      const start = clipStart.get(clip.id) ?? 0
      const byTarget = new Map<string, typeof clip.channels>()
      for (const channel of clip.channels) {
        const cycle = channel as { concurrent?: boolean; wrapSeconds?: number }
        if (cycle.concurrent === true && typeof cycle.wrapSeconds === 'number' && cycle.wrapSeconds > 0) {
          const id = `${channel.target}|${channel.kind}`
          const node = nodes[indexById.get(channel.target) ?? -1]
          const key = ({ translation: 'Translation', rotation: 'Rotation', scale: 'Scaling' } as Record<string, string>)[channel.kind]
          if (writtenGlobal.has(id) || node === undefined || key === undefined) continue
          writtenGlobal.add(id)
          const transform = sceneNodes[indexById.get(channel.target) ?? -1]?.transform ?? []
          const rest = [12, 13, 14].map(index => numberOf(transform[index]))
          const track = trackFromChannels([channel] as never, channel.kind as 'translation' | 'rotation' | 'scale', 0, rest)
          if (track === undefined) continue
          ;(node as Record<string, unknown>)[key] = track
          globalNodeTracks.push({ track, lengthMilliseconds: Math.round(cycle.wrapSeconds * 1000) })
          continue
        }
        const list = byTarget.get(channel.target)
        if (list === undefined) byTarget.set(channel.target, [channel])
        else (list as unknown[]).push(channel)
      }
      for (const [target, channels] of byTarget) {
        const node = nodes[indexById.get(target) ?? -1]
        if (node === undefined) continue
        for (const [kind, key] of [
          ['translation', 'Translation'],
          ['rotation', 'Rotation'],
          ['scale', 'Scaling'],
        ] as const) {
          const transform = sceneNodes[indexById.get(target) ?? -1]?.transform ?? []
          const rest = [12, 13, 14].map(index => numberOf(transform[index]))
          const track = trackFromChannels(channels as never, kind, start, rest)
          if (track === undefined) continue
          const existing = (node as Record<string, unknown>)[key] as
            | { Keys: unknown[] }
            | undefined
          // Warcraft III keeps one track per node per property across every sequence, so a second
          // clip appends its keys to the same track rather than replacing it.
          if (existing === undefined) (node as Record<string, unknown>)[key] = track
          else existing.Keys.push(...(track['Keys'] as unknown[]))
        }
      }
    }
  }

  const documentMaterials = array(document['materials'])
  const particleStyles = new Map<number, ParticleMaterialStyle>()
  const defaultParticleStyle: ParticleMaterialStyle = Object.freeze({ priorityPlane: 0, replaceableId: 0, flags: 0 })
  /** Reuse common material validation once per index; only native-specific facts are read here. */
  const materialStyleOf = (index: unknown): ParticleMaterialStyle => {
    signal?.throwIfAborted()
    if (index === undefined) return defaultParticleStyle
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= documentMaterials.length)
      throw new TypeError('PRE2 material index must reference a document material')
    const cached = particleStyles.get(index)
    if (cached !== undefined) return cached
    const material = documentMaterials[index]
    const extensions = isRecord(material) && isRecord(material['extensions']) ? material['extensions'] : {}
    const game = extensions['UV_game_material']
    if (!isRecord(game) || game['shader'] !== RENDER_MATERIAL_SHADER) {
      particleStyles.set(index, defaultParticleStyle)
      return defaultParticleStyle
    }
    const sampler = createRenderMaterialSampler(game['params'], {
      maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes,
    }, signal)
    if (!sampler.timeless || sampler.presentation !== 'surface')
      throw new TypeError('source-free PRE2 material must be static and surface-presented')
    const passes = sampler.sample({ time: 0 }, signal)
    if (passes.length !== 1) throw new TypeError('source-free PRE2 material must have one standard pass')
    const pass = passes[0]!
    if (!Number.isInteger(pass.priority) || pass.priority < -0x80000000 || pass.priority > 0x7fffffff)
      throw new TypeError('PRE2 priority must fit a signed native int32')
    const params = isRecord(game['params']) ? game['params'] : {}
    const render = isRecord(params['renderModel']) ? params['renderModel'] : {}
    const metadata = isRecord(render['metadata']) ? render['metadata'] : {}
    const native = metadata['source'] === 'war3' && metadata['emitter'] === 'particles' ? metadata : {}
    const replaceableId = native['replaceableId'] === undefined ? 0 : native['replaceableId']
    if (typeof replaceableId !== 'number' || !Number.isInteger(replaceableId) || replaceableId < 0 || replaceableId > 0x7fffffff)
      throw new TypeError('PRE2 ReplaceableId must fit a nonnegative native int32')
    const sort = native['sortPrimsFarZ']
    if (sort !== undefined && sort !== 0 && sort !== 1) throw new TypeError('PRE2 SortPrimsFarZ metadata must be 0 or 1')
    const unfogged = native['unfogged']
    if (unfogged !== undefined && unfogged !== 0 && unfogged !== 1) throw new TypeError('PRE2 Unfogged metadata must be 0 or 1')
    const style = {
      priorityPlane: pass.priority, replaceableId,
      flags: (pass.material.unshaded ? War3Native.ParticleEmitter2Flags.Unshaded : 0) |
        (sort === 1 ? War3Native.ParticleEmitter2Flags.SortPrimsFarZ : 0) |
        (unfogged === 1 ? War3Native.ParticleEmitter2Flags.Unfogged : 0),
    }
    particleStyles.set(index, style)
    return style
  }
  const images = array(document['images'])
  const documentTextures = array(document['textures'])
  const textures: Record<string, unknown>[] = []
  const textureIndexByPath = new Map<string, number>()
  const textureIndexFor = (path: string): number => {
    const existing = textureIndexByPath.get(path)
    if (existing !== undefined) return existing
    const index = textures.length
    textures.push({ Image: path.replaceAll('/', String.fromCharCode(92)), ReplaceableId: 0, Flags: 0 })
    textureIndexByPath.set(path, index)
    return index
  }

  /**
   * The diffuse texture a material names.
   *
   * A base-colour glTF material states it directly. A game material states it in its own layer
   * list — `UV_game_material` params, or the bounded native envelope beside them — which is where
   * StarCraft II, and any other publisher using the shared material vocabulary, actually puts it.
   * All three are the source's own declaration; none of them is a guess.
   */
  const diffusePathOf = (material: Record<string, unknown>): string | undefined => {
    const pbr = isRecord(material['pbrMetallicRoughness'])
      ? (material['pbrMetallicRoughness'] as Record<string, unknown>)
      : {}
    const baseColor = isRecord(pbr['baseColorTexture'])
      ? (pbr['baseColorTexture'] as Record<string, unknown>)
      : undefined
    if (baseColor !== undefined) {
      const texture = documentTextures[numberOf(baseColor['index'], -1)]
      const source = isRecord(texture) ? numberOf(texture['source'], -1) : -1
      const image = images[source]
      const uri = isRecord(image) && typeof image['uri'] === 'string' ? image['uri'] : undefined
      if (uri !== undefined) return uri
    }
    const extensions = isRecord(material['extensions'])
      ? (material['extensions'] as Record<string, unknown>)
      : {}
    const game = isRecord(extensions['UV_game_material'])
      ? (extensions['UV_game_material'] as Record<string, unknown>)
      : undefined
    const params = game !== undefined && isRecord(game['params'])
      ? (game['params'] as Record<string, unknown>)
      : {}
    const renderModel = isRecord(params['renderModel'])
      ? (params['renderModel'] as Record<string, unknown>)
      : {}
    for (const entry of array(renderModel['layers'])) {
      if (!isRecord(entry)) continue
      if (entry['label'] !== 'diffuse') continue
      if (typeof entry['path'] === 'string' && entry['path'] !== '') return entry['path']
    }
    const extras = isRecord(material['extras']) ? (material['extras'] as Record<string, unknown>) : {}
    const modkit = isRecord(extras['modkit']) ? (extras['modkit'] as Record<string, unknown>) : {}
    const native = isRecord(modkit['material']) ? (modkit['material'] as Record<string, unknown>) : {}
    const fields = isRecord(native['fields']) ? (native['fields'] as Record<string, unknown>) : {}
    for (const entry of array(fields['layers'])) {
      if (!isRecord(entry)) continue
      if (entry['slot'] !== 'diffuse') continue
      if (typeof entry['resourceId'] === 'string' && entry['resourceId'] !== '')
        return entry['resourceId']
    }
    return undefined
  }

  const materials = documentMaterials.map(entry => {
    const material = isRecord(entry) ? entry : {}
    const path = diffusePathOf(material)
    return {
      PriorityPlane: 0,
      RenderMode: 0,
      Layers: [
        {
          // Blend is the safe Warcraft III default for an unknown coverage mode: it shows the
          // model rather than discarding texels an alpha test would have cut.
          FilterMode: material['alphaMode'] === 'OPAQUE' || material['alphaMode'] === 'opaque' ? 0 : 2,
          Shading: 0,
          TextureID: path === undefined ? 0 : textureIndexFor(path),
          CoordId: 0,
          Alpha: 1,
        },
      ],
    }
  })
  if (textures.length === 0) textures.push({ Image: '', ReplaceableId: 1, Flags: 0 })

  const clips = model.rig.clips
  const clipStart = new Map<string, number>()
  let cursor = 0
  const sequences = clips.map(clip => {
    clipStart.set(clip.id, cursor)
    const duration = Math.max(1, Math.round(numberOf(clip.durationSeconds, 1) * 1000))
    const interval = Uint32Array.from([cursor, cursor + duration])
    // Warcraft III sequences share one timeline, so foreign clips are laid out end to end with a
    // gap; overlapping intervals would make one clip play another's keys.
    cursor += duration + 100
    return {
      Name: clip.name.slice(0, 80),
      Interval: interval,
      NonLooping: clip.looping === false,
      MinimumExtent: new Float32Array(3),
      MaximumExtent: new Float32Array(3),
      BoundsRadius: 0,
      MoveSpeed: 0,
      Rarity: 0,
    }
  })
  if (sequences.length === 0)
    sequences.push({
      Name: 'Stand',
      Interval: Uint32Array.from([0, 1000]),
      NonLooping: false,
      MinimumExtent: new Float32Array(3),
      MaximumExtent: new Float32Array(3),
      BoundsRadius: 0,
      MoveSpeed: 0,
      Rarity: 0,
    })

  const worldOf = worldMatrices(sceneNodes)
  const nodeOfPrimitive = new Map<string, string>()
  for (const node of sceneNodes)
    for (const meshId of node.meshIds) {
      const mesh = model.scene.meshes.find(entry => entry.id === meshId)
      for (const primitiveId of mesh?.primitiveIds ?? []) nodeOfPrimitive.set(primitiveId, node.id)
    }
  // Tracks are attached once the sequence intervals exist: every clip's keys are offset into the
  // slot that clip was laid out in on the shared Warcraft III timeline.
  attachTracks()

  // Every geoset names at least one matrix. A document with no skin still has a node its geometry
  // rides, and the first bone is that node: the writer marks the scene's own root as a bone when
  // the rig names none, so this index always exists.
  const rigidBoneId = nodes.find(node => boneNodeIds.has(sceneNodes[node.ObjectId]?.id ?? ''))
    ?.ObjectId ?? 0
  const geosets = model.scene.primitives.map(primitive => {
    // A Warcraft III geoset has no transform of its own, so the node placing the mesh has to be
    // baked into the vertices; dropping it silently moves parts of the model.
    const world = worldOf(nodeOfPrimitive.get(primitive.id) ?? '')
    const positions = toWar3Positions(primitive.positions, world, scale)
    const vertexCount = Math.floor(positions.length / 3)
    const { vertexGroup, groups } = matrixGroups(
      primitive.boneIndices,
      primitive.boneWeights,
      vertexCount,
      rigidBoneId,
    )
    const materialIndex = materials.findIndex(
      (_value, index) => `material-${String(index)}` === primitive.materialId,
    )
    const extent = bounds(positions)
    const faces =
      primitive.indices === undefined
        ? Uint16Array.from({ length: vertexCount }, (_value, slot) => slot)
        : Uint16Array.from(primitive.indices)
    return {
      Vertices: positions,
      Normals:
        primitive.normals === undefined
          ? surfaceNormals(positions, faces)
          : toWar3Directions(primitive.normals, world),
      TVertices: nativeUvSets(primitive, vertexCount),
      VertexGroup: vertexGroup,
      Faces: faces,
      Groups: groups,
      TotalGroupsCount: groups.reduce((sum, group) => sum + group.length, 0),
      MinimumExtent: extent.minimum,
      MaximumExtent: extent.maximum,
      BoundsRadius: extent.radius,
      Anims: [
        { MinimumExtent: extent.minimum, MaximumExtent: extent.maximum, BoundsRadius: extent.radius },
      ],
      MaterialID: materialIndex < 0 ? 0 : materialIndex,
      SelectionGroup: 0,
      Unselectable: false,
    }
  })

  // Emitters arrive as extra nodes, so they are built after the scene's own nodes are numbered.
  // Attachments and collision volumes are nodes the document already carries, so they are read
  // before the emitters, which are the only ones that need new node numbers.
  const spatial = spatialFromCommon(document, nodes, notes)
  let emitterObjectId = nodes.length
  const emitters = emittersFromCommon(
    document,
    value =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < nodes.length
        ? value
        : undefined,
    textureIndexFor,
    materialStyleOf,
    () => emitterObjectId++,
    sequenceIndex => {
      const position = clips.findIndex(clip => clip.sequenceIndex === sequenceIndex)
      const clip = clips[position === -1 ? sequenceIndex : position]
      const sequence = clip === undefined ? undefined : sequences[clips.indexOf(clip)]
      if (sequence === undefined) return undefined
      const [start = 0, end = start] = sequence.Interval
      return { start, duration: end - start }
    },
    notes,
  )
  const allNodes = [...nodes, ...emitters.nodes]

  const modelExtent = bounds(
    Float32Array.from(geosets.flatMap(geoset => Array.from(geoset.Vertices))),
  )
  const name = typeof document['name'] === 'string' ? document['name'] : 'ConvertedModel'
  return {
    Version: 800,
    Info: {
      Name: name.slice(0, 80),
      BlendTime: 150,
      MinimumExtent: modelExtent.minimum,
      MaximumExtent: modelExtent.maximum,
      BoundsRadius: modelExtent.radius,
    },
    Sequences: sequences,
    GlobalSequences: withGlobalNodeTracks(emitters.globalSequences, globalNodeTracks),
    Textures: textures,
    Materials: materials.length === 0 ? [{ PriorityPlane: 0, RenderMode: 0, Layers: [{ FilterMode: 2, Shading: 0, TextureID: 0, CoordId: 0, Alpha: 1 }] }] : materials,
    TextureAnims: [],
    Geosets: geosets,
    GeosetAnims: [],
    Bones: nodes
      .filter(
        node =>
          boneNodeIds.has(sceneNodes[node.ObjectId]?.id ?? '') && !spatial.kinds.has(node.ObjectId),
      )
      .map(node => ({
      ...node,
      GeosetId: null,
      GeosetAnimId: null,
    })),
    Helpers: nodes.filter(
      node =>
        !boneNodeIds.has(sceneNodes[node.ObjectId]?.id ?? '') && !spatial.kinds.has(node.ObjectId),
    ),
    // A node that is an attachment or a collision volume keeps that flag in the node list too,
    // which is how the format says which record it belongs to.
    Nodes: allNodes.map(node => {
      const kind = spatial.kinds.get(node['ObjectId'] as number)
      return kind === undefined ? node : { ...node, Flags: kind }
    }),
    PivotPoints: allNodes.map(node => node['PivotPoint'] as Float32Array),
    Attachments: spatial.attachments,
    CollisionShapes: spatial.collisionShapes,
    EventObjects: [],
    Cameras: [],
    Lights: [],
    ParticleEmitters: [],
    ParticleEmitters2: emitters.particles,
    RibbonEmitters: emitters.ribbons,
  }
}

function bounds(values: Float32Array) {
  const minimum = Float32Array.from([Infinity, Infinity, Infinity])
  const maximum = Float32Array.from([-Infinity, -Infinity, -Infinity])
  for (let index = 0; index + 2 < values.length; index += 3)
    for (let axis = 0; axis < 3; axis += 1) {
      const value = values[index + axis]!
      if (value < minimum[axis]!) minimum[axis] = value
      if (value > maximum[axis]!) maximum[axis] = value
    }
  if (!minimum.every(Number.isFinite)) {
    minimum.fill(0)
    maximum.fill(0)
  }
  let radius = 0
  for (let axis = 0; axis < 3; axis += 1)
    radius = Math.max(radius, Math.abs(minimum[axis]!), Math.abs(maximum[axis]!))
  return { minimum, maximum, radius }
}

/** Read bounded UVM and encode through residual or common facts; notes describe conversion losses. */
export function exportWar3FromUvm(
  uvm: Uint8Array,
  budget: UvmContainerBudget,
  options: War3EncodeOptions = {},
  signal?: AbortSignal,
  /** Collects what the target format could not hold, for a caller that has somewhere to say it. */
  notes: string[] = [],
): Uint8Array {
  const scale = options.metersPerTargetUnit ?? 1
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('invalid metres per target unit')
  const container = readUvmContainer(uvm, budget, signal)
  // A document from another game has no extras of ours — and may have no extras at all, which the
  // reader treats as malformed rather than as absence. Ask only when the envelope is actually there.
  const extras = (container.document as JsonObject)['extras']
  const residual = (
    isRecord(extras) && isRecord(extras['BlizzardMDX'])
      ? readUvmFormatResidual(container, 'BlizzardMDX').residual
      : undefined
  ) as JsonObject | undefined
  const encoding =
    options.encoding ?? (residual?.['encoding'] === 'mdl' ? ('mdl' as const) : ('mdx' as const))
  const model = readUvmModel(
    container.document as JsonObject,
    container.binary,
    { maxScalarBytes: budget.maxJsonBytes },
    signal,
  )

  if (residual === undefined) {
    // No Warcraft III residual: the document came from somewhere else, and the target format is
    // built from the common structures alone.
    const converted = nativeFromCommon(
      model,
      container.document as JsonObject,
      scale,
      notes,
      budget,
      signal,
    ) as unknown as Parameters<typeof generateMDX>[0]
    admitWar3MaterialHeaders(converted, encoding, signal)
    return encoding === 'mdl'
      ? new TextEncoder().encode(generateMDL(converted))
      : new Uint8Array(generateMDX(converted) as unknown as ArrayBufferLike)
  }

  const geosetMeta = array(residual['geosets'])
  const geosets = model.scene.primitives.map((primitive, index) => {
    signal?.throwIfAborted()
    const meta = isRecord(geosetMeta[index]) ? (geosetMeta[index] as Record<string, unknown>) : {}
    const positions = unrebase(primitive.positions, scale, false)
    const vertexCount = Math.floor(positions.length / 3)
    const faces =
      primitive.indices === undefined
        ? Uint16Array.from({ length: vertexCount }, (_value, slot) => slot)
        : Uint16Array.from(primitive.indices)
    const { vertexGroup, groups } = matrixGroups(
      primitive.boneIndices,
      primitive.boneWeights,
      vertexCount,
      0,
    )
    return {
      Vertices: positions,
      Normals:
        primitive.normals === undefined
          ? surfaceNormals(positions, faces)
          : unrebase(primitive.normals, scale, true),
      TVertices: nativeUvSets(primitive, vertexCount),
      VertexGroup: vertexGroup,
      Faces: faces,
      Groups: groups,
      TotalGroupsCount: groups.reduce((sum, group) => sum + group.length, 0),
      MinimumExtent: floats(meta['minimumExtent'], 3),
      MaximumExtent: floats(meta['maximumExtent'], 3),
      BoundsRadius: numberOf(meta['boundsRadius']),
      Anims: array(meta['anims']).map(anim => {
        const record = reviveRecord(anim)
        return {
          MinimumExtent: floats(record['MinimumExtent'] ?? record['minimumExtent'], 3),
          MaximumExtent: floats(record['MaximumExtent'] ?? record['maximumExtent'], 3),
          BoundsRadius: numberOf(record['BoundsRadius'] ?? record['boundsRadius']),
        }
      }),
      MaterialID: numberOf(meta['materialId']),
      SelectionGroup: numberOf(meta['selectionGroup']),
      Unselectable: meta['unselectable'] === true,
      ...(typeof meta['name'] === 'string' ? { Name: meta['name'] } : {}),
    }
  })

  const info = isRecord(residual['info']) ? (residual['info'] as Record<string, unknown>) : {}
  const nodes = array(residual['nodes']).map(node => reviveRecord(node, NODE_VECTORS))
  const boneMeta = new Map(
    array(residual['bones'])
      .filter(isRecord)
      .map(bone => [numberOf(bone['objectId'], -1), bone]),
  )
  const bones = nodes.filter(node => boneMeta.has(numberOf(node['ObjectId'], -1)))
  for (const bone of bones) {
    const meta = boneMeta.get(numberOf(bone['ObjectId'], -1))
    bone['GeosetId'] = meta?.['geosetId'] ?? null
    bone['GeosetAnimId'] = meta?.['geosetAnimId'] ?? null
  }
  const helpers = nodes.filter(node => !boneMeta.has(numberOf(node['ObjectId'], -1)))

  const native = {
    Version: numberOf(residual['formatVersion'], 800),
    Info: {
      Name: typeof info['Name'] === 'string' ? info['Name'] : '',
      BlendTime: numberOf(info['BlendTime']),
      MinimumExtent: floats(info['MinimumExtent'], 3),
      MaximumExtent: floats(info['MaximumExtent'], 3),
      BoundsRadius: numberOf(info['BoundsRadius']),
    },
    Sequences: array(residual['sequences']).map(sequence => {
      const record = reviveRecord(sequence, ['MinimumExtent', 'MaximumExtent'])
      return {
        ...record,
        Interval: Uint32Array.from(array(record['Interval']).map(item => numberOf(item))),
      }
    }),
    GlobalSequences: array(residual['globalSequences']).map(item => numberOf(item)),
    Textures: array(residual['textures']).map(texture => reviveRecord(texture)),
    Materials: array(residual['materials']).map(material => {
      const record = reviveRecord(material)
      return { ...record, Layers: array(record['Layers']).map(layer => reviveRecord(layer, ['FresnelColor'])) }
    }),
    TextureAnims: array(residual['textureAnims']).map(item => reviveRecord(item)),
    Geosets: geosets,
    GeosetAnims: array(residual['geosetAnims']).map(item =>
      reviveRecord(item, ['MinimumExtent', 'MaximumExtent', 'Color']),
    ),
    Bones: bones,
    Helpers: helpers,
    Nodes: nodes,
    PivotPoints: array(residual['pivotPoints']).map(point => floats(point, 3)),
    Attachments: array(residual['attachments']).map(item => reviveRecord(item, NODE_VECTORS)),
    CollisionShapes: array(residual['collisionShapes']).map(item =>
      reviveRecord(item, [...NODE_VECTORS, 'Vertices']),
    ),
    EventObjects: array(residual['eventObjects']).map(item => reviveRecord(item, NODE_VECTORS)),
    Cameras: array(residual['cameras']).map(item =>
      reviveRecord(item, ['Position', 'TargetPosition']),
    ),
    Lights: array(residual['lights']).map(item => {
      // Only static RGB arrays are newly admitted here; track records retain existing restoration.
      if (isRecord(item)) for (const field of ['Color', 'AmbColor']) {
        const value = item[field]
        if (Array.isArray(value) && (value.length !== 3 || value.some(component =>
          typeof component !== 'number' || !Number.isFinite(component) || !Number.isFinite(Math.fround(component)))))
          throw new TypeError(`Warcraft III native light ${field} requires exactly three finite float32-range numbers`)
      }
      return reviveRecord(item, [...NODE_VECTORS, 'Color', 'AmbColor'])
    }),
    ParticleEmitters: array(residual['particleEmitters']).map(item =>
      reviveRecord(item, NODE_VECTORS),
    ),
    ParticleEmitters2: array(residual['particleEmitters2']).map(item =>
      reviveRecord(item, [...NODE_VECTORS, 'SegmentColor', 'Alpha', 'ParticleScaling']),
    ),
    RibbonEmitters: array(residual['ribbonEmitters']).map(item =>
      reviveRecord(item, [...NODE_VECTORS, 'Color', 'ColorFallback']),
    ),
    ...(residual['particleEmitterPopcorns'] === undefined
      ? {}
      : {
          ParticleEmitterPopcorns: array(residual['particleEmitterPopcorns']).map(item =>
            reviveRecord(item, NODE_VECTORS),
          ),
        }),
    ...(residual['faceFX'] === undefined
      ? {}
      : { FaceFX: array(residual['faceFX']).map(item => reviveRecord(item)) }),
    ...(residual['bindPoses'] === undefined
      ? {}
      : { BindPoses: array(residual['bindPoses']).map(item => reviveRecord(item)) }),
  } as unknown as Parameters<typeof generateMDX>[0]

  admitWar3MaterialHeaders(native, encoding, signal)
  if (encoding === 'mdl') return new TextEncoder().encode(generateMDL(native))
  // The writer returns a fresh buffer; the codec contract is bytes.
  return new Uint8Array(generateMDX(native) as unknown as ArrayBufferLike)
}

export const war3EncoderMediaType = (encoding: 'mdx' | 'mdl'): string =>
  encoding === 'mdl' ? 'model/x-warcraft3-mdl' : 'model/x-warcraft3-mdx'

export const war3EncoderResidual = (container: JsonValue): JsonValue => container
