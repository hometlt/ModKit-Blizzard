// Diablo III APP layout details are based on WhiteoutLib's corpus-derived specification.
// See ../../THIRD-PARTY-NOTICES.md for the retained BSD-3-Clause and AI-derived-work notices.
import type {
  CodecIssue,
  ModelCodec,
} from '@modkit/codec-kit/legacy/models/codec'
import type {
  Bounds,
  RenderAnimation,
  RenderMaterial,
  RenderMesh,
  RenderModel,
  RenderScalarAnimationTrack,
  RenderSequence,
} from '@modkit/codec-kit/legacy/models'
import { multiplyAffine } from '@modkit/codec-kit/model-math/transform'

const MAGIC = 0xdeadbeef
const VERSION = 260
const HEADER_SIZE = 0x228
const SUBMESH_SIZE = 400
const VERTEX_SIZE = 44
const BONE_SIZE = 312
const MATERIAL_SIZE = 144
const TEXTURE_ENTRY_SIZE = 160
const SUB_OBJECT_APPEARANCE_SIZE = 248
const LOOK_SIZE = 64
const HARDPOINT_SIZE = 96
const CAPSULE_SIZE = 104
const MAX_RECORDS = 1_000_000
const ANI_VERSION = 118
const ANI_BLOCK_SIZE = 408
const ANI_BONE_NAME_SIZE = 64
const ANI_TRACK_DESCRIPTOR_SIZE = 24
const ANI_EVENT_SIZE = 412
const ANIM_SET_VERSION = 24
const ACTOR_VERSION = 282
const TAG_MAP_ENTRY_SIZE = 12

/**
 * The appearance frame the parser reads into: a file vector (x, y, z) becomes (y, −x, z)·17 — a
 * quarter turn about z (the game's forward +x becomes −y, which the z-up rebase turns into glTF's
 * front +z) and the 3ds Max importer's scale of 17, which the format itself does not state. Scenes,
 * navigation meshes and markers stay in the game's own frame; a world places an appearance by the
 * inverse of both.
 */
export const DIABLO3_APPEARANCE_SCALE = 17
/** The quarter turn about +z that takes the appearance frame back to the game's (x, y, z, w). */
export const DIABLO3_APPEARANCE_TO_GAME: readonly [number, number, number, number] = Object.freeze([0, 0, Math.SQRT1_2, Math.SQRT1_2])

type Vector3Tuple = readonly [number, number, number]
type QuaternionTuple = readonly [number, number, number, number]

interface Diablo3Transform {
  rotation: QuaternionTuple
  translation: Vector3Tuple
  scale: number
}

export interface Diablo3AnimationTrack {
  lineType: number
  globalSeqId: null
  keys: Array<{ frame: number; vector: number[]; interpolation: 'LINEAR' }>
}

export interface Diablo3BoneAnimation {
  name: string
  translation?: Diablo3AnimationTrack
  rotation?: Diablo3AnimationTrack
  scaling?: Diablo3AnimationTrack
}

export interface Diablo3AnimationClip {
  name: string
  frameCount: number
  fps: number
  durationSeconds: number
  bones: Diablo3BoneAnimation[]
  metadata: Record<string, unknown>
}

/**
 * One timed event of a clip (registry `KeyframedAttachment`, 412 bytes): the frame it fires on,
 * then a `TriggerEvent` — what it spawns (an SNO by group and id), where (up to two hardpoint
 * names) and the look it switches to. `kind` (TriggerEvent +0x28) follows what is spawned (1
 * particles, 3 sound, 6 explosion, 11 camera shake); `flags` is TriggerEvent +0x00, not yet read.
 */
export interface Diablo3ClipEvent {
  readonly frame: number
  readonly kind: number
  readonly flags: number
  readonly snoGroup: number
  readonly snoId: number
  readonly hardpoints: readonly string[]
  readonly look?: string
}

export interface Diablo3AnimationFile {
  snoId: number
  modelSnoRef: number
  clips: Diablo3AnimationClip[]
}

export interface Diablo3AnimationInput {
  bytes: Uint8Array
  hint?: string
}

export interface Diablo3AnimSetEntry {
  type: number
  tagId: number
  animationSnoId: number
}

export interface Diablo3AnimSet {
  snoId: number
  parentAnimSetSnoId: number
  animations: Diablo3AnimSetEntry[]
}

export interface Diablo3ActorLinks {
  snoId: number
  appearanceSnoId: number
  animSetSnoId: number
}

/** Longest-prefix ANI families used when an APP is opened directly from a VFS. */
export function diablo3AniSidecarPatterns(hint: string): string[] {
  const normalized = hint.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const directory = slash >= 0 ? normalized.slice(0, slash) : ''
  const parentSlash = directory.lastIndexOf('/')
  const parent = parentSlash >= 0 ? directory.slice(0, parentSlash) : ''
  const fileName = slash >= 0 ? normalized.slice(slash + 1) : normalized
  let prefix = fileName.replace(/\.app$/i, '')
  const animationDirectory = `${parent ? `${parent}/` : ''}Anim/`
  const patterns: string[] = []
  while (prefix.length > 0) {
    patterns.push(`${animationDirectory}${prefix}*.ani`)
    const cut = prefix.lastIndexOf('_')
    if (cut <= 0) break
    prefix = prefix.slice(0, cut)
  }
  return patterns
}

/**
 * A texture entry's own type (`EMaterialTextureType`, entry +0x00): the engine binds an entry to
 * the pass stage that declares its type, never by position. Named after the samplers the game's
 * programs give them (WhiteoutFlakes `io/d3/d3_types.h`, BSD-3-Clause); 13, 15 and 17 are the
 * further diffuse layers of the five-layer landscape programs, which list them after 1 and 11.
 */
const TEXTURE_SLOTS: Readonly<Record<number, string>> = {
  1: 'diffuse',
  2: 'lightmap',
  3: 'normal',
  4: 'environment',
  5: 'specular',
  6: 'emissive',
  8: 'irradiance',
  11: 'diffuse2',
  12: 'alpha-mask',
  13: 'diffuse3',
  14: 'alpha-mask2',
  15: 'diffuse4',
  17: 'diffuse5',
  19: 'alpha-mask3',
  54: 'tint-mask',
}

/** The engine's opaque-pass tag chain over a ShaderMap: the first tag that names a Shaders wins. */
export const DIABLO3_SHADER_TAG_CHAIN: readonly number[] = Object.freeze([0x30502, 0x30850, 0x30830, 0x30600, 0x30500])

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function isRange(bytes: Uint8Array, offset: number, size: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(size) &&
    offset >= 0 &&
    size >= 0 &&
    offset + size <= bytes.length
  )
}

function checkedCount(count: number, label: string): number {
  if (count > MAX_RECORDS) throw new Error(`Diablo III APP has invalid ${label} count ${count}`)
  return count
}

function dataOffset(bytes: Uint8Array, storedOffset: number, size: number, label: string): number {
  const offset = storedOffset + 16
  if (!isRange(bytes, offset, size)) throw new Error(`Diablo III APP ${label} is out of range`)
  return offset
}

function stringAt(bytes: Uint8Array, offset: number, maxLength: number): string {
  const endLimit = Math.min(bytes.length, offset + maxLength)
  let end = offset
  while (end < endLimit && bytes[end] !== 0) end += 1
  return new TextDecoder('latin1').decode(bytes.subarray(offset, end))
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value, 1)))
}

/** -0 and 0 are the same number and different bytes; published geometry uses the positive one. */
function cleanZero(value: number): number {
  return value === 0 ? 0 : value
}

function decodeVector(byte: number): number {
  return Math.max(-1, Math.min(1, (byte - 127) / 127))
}

function normalizeQuaternion(value: QuaternionTuple): QuaternionTuple {
  const length = Math.hypot(value[0], value[1], value[2], value[3])
  if (!(length > 0)) return [0, 0, 0, 1]
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}

function inverseQuaternion(value: QuaternionTuple): QuaternionTuple {
  const normalized = normalizeQuaternion(value)
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]]
}

function rotateVector(rotation: QuaternionTuple, value: Vector3Tuple): Vector3Tuple {
  const [x, y, z, w] = normalizeQuaternion(rotation)
  const [vx, vy, vz] = value
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

function transformMatrix(transform: Diablo3Transform): Float32Array {
  const [x, y, z, w] = normalizeQuaternion(transform.rotation)
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  const scale = transform.scale
  const matrix = new Float32Array(16)
  matrix[0] = (1 - (yy + zz)) * scale
  matrix[1] = (xy + wz) * scale
  matrix[2] = (xz - wy) * scale
  matrix[4] = (xy - wz) * scale
  matrix[5] = (1 - (xx + zz)) * scale
  matrix[6] = (yz + wx) * scale
  matrix[8] = (xz + wy) * scale
  matrix[9] = (yz - wx) * scale
  matrix[10] = (1 - (xx + yy)) * scale
  matrix[12] = transform.translation[0]
  matrix[13] = transform.translation[1]
  matrix[14] = transform.translation[2]
  matrix[15] = 1
  return matrix
}

function inverseTransformMatrix(transform: Diablo3Transform): Float32Array {
  const inverseScale = transform.scale !== 0 ? 1 / transform.scale : 1
  const inverseRotation = inverseQuaternion(transform.rotation)
  const translation = rotateVector(inverseRotation, [
    -transform.translation[0] * inverseScale,
    -transform.translation[1] * inverseScale,
    -transform.translation[2] * inverseScale,
  ])
  return transformMatrix({ rotation: inverseRotation, translation, scale: inverseScale })
}

/** A PRS record; a PR record (hardpoints, capsules) has no scale after it, so `scaled` is false. */
function readTransform(dv: DataView, offset: number, scaled = true): Diablo3Transform {
  // APP serializes vectors/quaternions as (Y, X, Z[, W]). Convert the complete
  // transform into the renderer's right-handed (X, -Y, Z) basis here.
  return {
    rotation: normalizeQuaternion([
      finite(dv.getFloat32(offset + 4, true)),
      -finite(dv.getFloat32(offset, true)),
      finite(dv.getFloat32(offset + 8, true)),
      finite(dv.getFloat32(offset + 12, true), 1),
    ]),
    translation: [
      finite(dv.getFloat32(offset + 20, true)) * DIABLO3_APPEARANCE_SCALE,
      -finite(dv.getFloat32(offset + 16, true)) * DIABLO3_APPEARANCE_SCALE,
      finite(dv.getFloat32(offset + 24, true)) * DIABLO3_APPEARANCE_SCALE,
    ],
    scale: scaled ? finite(dv.getFloat32(offset + 28, true), 1) || 1 : 1,
  }
}

function parseMaterials(bytes: Uint8Array, dv: DataView, issues: CodecIssue[]): RenderMaterial[] {
  const count = checkedCount(dv.getUint32(0x1b4, true), 'material')
  if (count === 0) return [{ name: 'Default', layers: [], baseColor: [0.7, 0.7, 0.7, 1] }]
  const table = dataOffset(
    bytes,
    dv.getUint32(0x1b8, true),
    count * MATERIAL_SIZE,
    'material table',
  )
  const materials: RenderMaterial[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = table + index * MATERIAL_SIZE
    const name = stringAt(bytes, entry, 128) || `Material ${index}`
    const shaderOffset = dv.getUint32(entry + 0x80, true)
    const shaderSize = dv.getUint32(entry + 0x84, true)
    const layers: RenderMaterial['layers'] = []
    let baseColor: readonly [number, number, number, number] = [0.7, 0.7, 0.7, 1]
    const metadata: Record<string, unknown> = {
      shaderDataOffset: shaderOffset,
      shaderDataSize: shaderSize,
    }
    if (shaderSize >= 0x6c && isRange(bytes, shaderOffset + 16, shaderSize)) {
      // The block is one SubObjectAppearance (248 bytes) per look of the appearance: flags +0x00
      // (bit 0: the material is drawn in that look), then its UberMaterial at +0x18 — ShaderMap SNO,
      // Material colours at +0x04, texture entries at +0x4c. The codec draws look 0.
      const shader = shaderOffset + 16
      const looks = Math.floor(shaderSize / SUB_OBJECT_APPEARANCE_SIZE)
      metadata['lookVisible'] = Array.from(
        { length: looks },
        (_, look) => (dv.getUint32(shader + look * SUB_OBJECT_APPEARANCE_SIZE, true) & 1) === 1,
      )
      metadata['shaderMapSnoId'] = dv.getInt32(shader + 0x18, true)
      baseColor = [
        clamp01(dv.getFloat32(shader + 0x1c, true)),
        clamp01(dv.getFloat32(shader + 0x20, true)),
        clamp01(dv.getFloat32(shader + 0x24, true)),
        clamp01(dv.getFloat32(shader + 0x28, true)),
      ]
      const textureOffset = dv.getUint32(shader + 0x64, true)
      const textureSize = dv.getUint32(shader + 0x68, true)
      const textureCount = Math.floor(textureSize / TEXTURE_ENTRY_SIZE)
      if (
        textureCount <= MAX_RECORDS &&
        isRange(bytes, textureOffset + 16, textureCount * TEXTURE_ENTRY_SIZE)
      ) {
        const textureTable = textureOffset + 16
        const textureSnoIds: number[] = []
        for (let textureIndex = 0; textureIndex < textureCount; textureIndex += 1) {
          const texture = textureTable + textureIndex * TEXTURE_ENTRY_SIZE
          const slot = dv.getUint32(texture, true)
          const snoId = dv.getInt32(texture + 8, true)
          const textureFlags = dv.getUint32(texture + 0x0c, true)
          const uvMatrix = Array.from({ length: 16 }, (_, component) =>
            finite(dv.getFloat32(texture + 0x10 + component * 4, true)),
          )
          textureSnoIds.push(snoId)
          layers.push({
            label: TEXTURE_SLOTS[slot] ?? `slot-${slot}`,
            path: `Textures/${snoId}.tex`,
            metadata: {
              snoId,
              slot,
              textureFlags,
              textureType: dv.getUint32(texture + 0x98, true),
              // D3 appearance UVs are authored for GL_REPEAT and commonly fall outside [0, 1].
              // Clamping collapses an entire geoset onto an atlas edge texel.
              wrapS: 'repeat',
              wrapT: 'repeat',
              ...(textureFlags !== 0
                ? {
                    uvTransform: [
                      uvMatrix[0],
                      uvMatrix[1],
                      0,
                      uvMatrix[4],
                      uvMatrix[5],
                      0,
                      uvMatrix[12],
                      uvMatrix[13],
                      1,
                    ],
                    uvScroll: [
                      finite(dv.getFloat32(texture + 0x54, true)),
                      finite(dv.getFloat32(texture + 0x60, true)),
                    ],
                  }
                : {}),
            },
          })
        }
        metadata['textureSnoIds'] = textureSnoIds
      }
    } else if (shaderSize !== 0) {
      issues.push({
        severity: 'warning',
        code: 'model-format-truncated: diablo3-app-material',
        message: `Material '${name}' has an out-of-range shader data block.`,
      })
    }
    // Blend, alpha test and culling are not in the appearance: they are the render pass its
    // ShaderMap selects (`withRenderPasses` reads them beside the actor's clips).
    materials.push({ name, layers, baseColor, metadata })
  }
  return materials
}

/** Look names (`AppearanceLook`, 64 bytes each at Appearance+0x1b8); look 0 is the one drawn. */
function parseLooks(bytes: Uint8Array, dv: DataView): string[] {
  const size = dv.getUint32(0x1cc, true)
  const count = Math.floor(size / LOOK_SIZE)
  const offset = dv.getUint32(0x1c8, true) + 16
  if (count === 0 || count > MAX_RECORDS || !isRange(bytes, offset, count * LOOK_SIZE)) return []
  return Array.from({ length: count }, (_, look) => stringAt(bytes, offset + look * LOOK_SIZE, LOOK_SIZE))
}

function materialIndexForMesh(name: string, materials: readonly RenderMaterial[]): number {
  const normalized = name.toLowerCase()
  let best = 0
  let bestLength = 0
  for (let index = 0; index < materials.length; index += 1) {
    const candidate = materials[index]!.name.toLowerCase()
    if (candidate.length > bestLength && normalized.includes(candidate)) {
      best = index
      bestLength = candidate.length
    }
  }
  return best
}

function isDiablo3PhysicsMesh(name: string, shapeName: string): boolean {
  if (/^phys(?:ics)?$/i.test(name.trim())) return true
  return /_phys_/i.test(shapeName) || /_phys$/i.test(shapeName) || /_physics/i.test(shapeName)
}

function isDiablo3InvisibleMaterial(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    normalized.startsWith('invis') ||
    normalized.replaceAll('_', '').startsWith('notvisible') ||
    normalized.startsWith('donotrender')
  )
}

function equalNumberArrays(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function hideExactDuplicateDiablo3Meshes(meshes: RenderMesh[]): void {
  const byName = new Map<string, RenderMesh[]>()
  for (const mesh of meshes) {
    // A mesh hidden for another reason cannot stand for its copy: followers' naked (NKD) body repeats
    // the hidden LIT armour vertex for vertex, and hiding it as that copy left them with no body.
    if (mesh.metadata?.['hiddenReason'] !== undefined) continue
    const key = mesh.name.toLowerCase()
    const group = byName.get(key)
    if (group) group.push(mesh)
    else byName.set(key, [mesh])
  }

  for (const group of byName.values()) {
    for (let anchorIndex = 0; anchorIndex < group.length; anchorIndex += 1) {
      const anchor = group[anchorIndex]
      if (!anchor) continue
      if (anchor.metadata?.['exactDuplicateOf'] !== undefined) continue
      for (
        let candidateIndex = anchorIndex + 1;
        candidateIndex < group.length;
        candidateIndex += 1
      ) {
        const candidate = group[candidateIndex]
        if (!candidate) continue
        if (candidate.metadata?.['exactDuplicateOf'] !== undefined) continue
        if (
          !equalNumberArrays(anchor.positions, candidate.positions) ||
          !equalNumberArrays(anchor.indices, candidate.indices)
        ) {
          continue
        }
        candidate.metadata = {
          ...candidate.metadata,
          defaultVisible: false,
          viewerHidden: true,
          hiddenReason: 'exact duplicate',
          exactDuplicateOf: anchor.metadata?.['sourceSubmeshIndex'],
        }
      }
    }
  }
}

function parseMeshes(
  bytes: Uint8Array,
  dv: DataView,
  materials: readonly RenderMaterial[],
  issues: CodecIssue[],
): RenderMesh[] {
  const count = checkedCount(dv.getUint32(0x0a8, true), 'submesh')
  if (count === 0) return []
  const table = dataOffset(bytes, dv.getUint32(0x0ac, true), count * SUBMESH_SIZE, 'submesh table')
  const fullMeshPaths = Array.from({ length: count }, (_, meshIndex) =>
    stringAt(bytes, table + meshIndex * SUBMESH_SIZE + 0xdc, 128),
  )
  const hasEquipmentVariants = ['_HVY', '_LIT', '_MED', '_NKD'].every(tier =>
    fullMeshPaths.some(path => path.toUpperCase().includes(tier)),
  )
  // Character APPs may package the normal body alongside mutually-exclusive
  // destruction states. Rendering those together duplicates hands/fingers and
  // exposes internal skeleton/intestine geometry. Only classify them as
  // alternates when a normal geoset is present, so standalone skeleton props
  // remain visible.
  const hasNormalAppearanceMesh = fullMeshPaths.some(path =>
    /(?:^|[_\\])normal(?:[_\\]|$)/i.test(path),
  )
  const boneCount = dv.getUint32(0x24, true)
  const meshes: RenderMesh[] = []
  for (let meshIndex = 0; meshIndex < count; meshIndex += 1) {
    const entry = table + meshIndex * SUBMESH_SIZE
    const renderFlags = dv.getUint32(entry, true)
    const vertexCount = checkedCount(dv.getUint32(entry + 4, true), `submesh ${meshIndex} vertex`)
    const indexCount = checkedCount(dv.getUint32(entry + 0x28, true), `submesh ${meshIndex} index`)
    const name = stringAt(bytes, entry + 0x5c, 128) || `Submesh ${meshIndex}`
    const fullMeshPath = fullMeshPaths[meshIndex] ?? ''
    if (vertexCount === 0 || indexCount < 3) continue
    const vertices = dataOffset(
      bytes,
      dv.getUint32(entry + 8, true),
      vertexCount * VERTEX_SIZE,
      `submesh ${meshIndex} vertices`,
    )
    const indexOffset = dataOffset(
      bytes,
      dv.getUint32(entry + 0x2c, true),
      indexCount * 2,
      `submesh ${meshIndex} indices`,
    )
    const positions = new Float32Array(vertexCount * 3)
    // APP's fixed 44-byte vertex record always contains packed normals and UVs.
    const normals = new Float32Array(vertexCount * 3)
    const tangents = renderFlags & 0x8 ? new Float32Array(vertexCount * 4) : undefined
    const uvs = new Float32Array(vertexCount * 2)
    // The second UV set (+0x1c) carries the scene lightmaps; the first colour's alpha (+0x13) is the
    // vertex alpha the translucent programs fade by (mist, water edges). Its RGB is not a tint.
    const lightmapUvs = new Float32Array(vertexCount * 2)
    const vertexAlpha = new Float32Array(vertexCount)
    let fadesByVertex = false
    const weightStoredOffset = dv.getUint32(entry + 0x18, true)
    const weightDataSize = dv.getUint32(entry + 0x1c, true)
    const hasWeights = weightStoredOffset !== 0 && weightDataSize >= vertexCount * 24
    const weightOffset = hasWeights
      ? dataOffset(bytes, weightStoredOffset, vertexCount * 24, `submesh ${meshIndex} weights`)
      : 0
    const boneIndices = hasWeights ? new Uint16Array(vertexCount * 4) : undefined
    const boneWeights = hasWeights ? new Float32Array(vertexCount * 4) : undefined
    // SubObject+0x54 is the bone a submesh without weights follows (a chest lid, a door leaf); a
    // scene has no bones and its value there names none.
    const ownBone = dv.getInt32(entry + 0x54, true)
    const rigidBone = ownBone >= 0 && ownBone < boneCount ? ownBone : undefined
    const rigidIndices = !hasWeights && rigidBone !== undefined ? new Uint16Array(vertexCount * 4) : undefined
    const rigidWeights = !hasWeights && rigidBone !== undefined ? new Float32Array(vertexCount * 4) : undefined
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const source = vertices + vertexIndex * VERTEX_SIZE
      const position = vertexIndex * 3
      positions[position] = finite(dv.getFloat32(source + 4, true)) * DIABLO3_APPEARANCE_SCALE
      positions[position + 1] = cleanZero(-finite(dv.getFloat32(source, true)) * DIABLO3_APPEARANCE_SCALE)
      positions[position + 2] = cleanZero(finite(dv.getFloat32(source + 8, true)) * DIABLO3_APPEARANCE_SCALE)
      normals[position] = cleanZero(decodeVector(bytes[source + 0x0d]!))
      // MK3 deviation: negating a decoded zero produced -0, which is the same number but a
      // different serialized value. The MK3 codec this replaces normalised it, and so does this.
      normals[position + 1] = cleanZero(-decodeVector(bytes[source + 0x0c]!))
      normals[position + 2] = cleanZero(decodeVector(bytes[source + 0x0e]!))
      if (tangents) {
        const tangent = vertexIndex * 4
        tangents[tangent] = cleanZero(decodeVector(bytes[source + 0x21]!))
        tangents[tangent + 1] = cleanZero(-decodeVector(bytes[source + 0x20]!))
        tangents[tangent + 2] = cleanZero(decodeVector(bytes[source + 0x22]!))
        // The vertex carries its binormal explicitly (+0x24); the programs build the frame from it,
        // so the bitangent sign is sign(dot(cross(N, T), B)) rather than assumed.
        const n = [normals[position]!, normals[position + 1]!, normals[position + 2]!]
        const t = [tangents[tangent]!, tangents[tangent + 1]!, tangents[tangent + 2]!]
        const b = [decodeVector(bytes[source + 0x25]!), -decodeVector(bytes[source + 0x24]!), decodeVector(bytes[source + 0x26]!)]
        const handedness =
          (n[1]! * t[2]! - n[2]! * t[1]!) * b[0]! +
          (n[2]! * t[0]! - n[0]! * t[2]!) * b[1]! +
          (n[0]! * t[1]! - n[1]! * t[0]!) * b[2]!
        tangents[tangent + 3] = handedness < 0 ? -1 : 1
      }
      const uv = vertexIndex * 2
      uvs[uv] = cleanZero(-(32767 - dv.getUint16(source + 0x18, true)) / 512)
      // Equivalent to the reference's bottom-origin decode followed by its renderer V flip.
      uvs[uv + 1] = cleanZero(-(32767 - dv.getUint16(source + 0x1a, true)) / 512)
      // the lightmap set spans its 0..1 atlas in 8192 steps (installed scenes: 32768..40960)
      lightmapUvs[uv] = cleanZero(-(32767 - dv.getUint16(source + 0x1c, true)) / 8192)
      lightmapUvs[uv + 1] = cleanZero(-(32767 - dv.getUint16(source + 0x1e, true)) / 8192)
      const alpha = bytes[source + 0x13]!
      vertexAlpha[vertexIndex] = alpha / 255
      if (alpha !== 255) fadesByVertex = true
      if (boneIndices && boneWeights) {
        const sourceWeight = weightOffset + vertexIndex * 24
        const targetWeight = vertexIndex * 4
        let weightSum = 0
        for (let influence = 0; influence < 3; influence += 1) {
          const boneIndex = dv.getUint32(sourceWeight + influence * 8, true)
          const weight = Math.max(0, finite(dv.getFloat32(sourceWeight + influence * 8 + 4, true)))
          boneIndices[targetWeight + influence] = Math.min(0xffff, boneIndex)
          boneWeights[targetWeight + influence] = weight
          weightSum += weight
        }
        if (weightSum > 0) {
          for (let influence = 0; influence < 3; influence += 1) {
            const value = boneWeights[targetWeight + influence] ?? 0
            boneWeights[targetWeight + influence] = value / weightSum
          }
        } else {
          // no weight: the submesh's own bone, as a rigid submesh has (+0x10 is a colour, not a bone)
          boneIndices[targetWeight] = rigidBone ?? 0
          boneWeights[targetWeight] = 1
        }
      } else if (rigidIndices && rigidWeights) {
        rigidIndices[vertexIndex * 4] = rigidBone!
        rigidWeights[vertexIndex * 4] = 1
      }
    }
    const indices = new Uint16Array(indexCount)
    let valid = true
    for (let index = 0; index < indexCount; index += 1) {
      // Swapping X/Y and negating Y has determinant +1, so file winding is preserved.
      const value = dv.getUint16(indexOffset + index * 2, true)
      indices[index] = value
      if (value >= vertexCount) valid = false
    }
    // MK3 deviation: upstream recorded this as an issue and dropped the submesh, which turns a
    // corrupt file into a silently smaller model. An index outside the vertex range is not
    // readable geometry, and this profile refuses rather than hides.
    if (!valid)
      throw new Error(
        `Diablo III APP submesh '${name}' index is out of range for its ${vertexCount} vertices`,
      )
    const materialIndex = materialIndexForMesh(name, materials)
    const equipmentVariantHidden =
      hasEquipmentVariants && !fullMeshPath.toUpperCase().includes('_NKD')
    const equipmentTier = /_(NKD|LIT|MED|HVY)(?:_|\b)/i.exec(fullMeshPath)?.[1]?.toUpperCase()
    const equipmentGroup = equipmentTier
      ? fullMeshPath.replace(new RegExp(`_${equipmentTier}(?=_|\\b)`, 'i'), '_{tier}')
      : undefined
    const physicsMesh = isDiablo3PhysicsMesh(name, fullMeshPath)
    const invisibleMaterial =
      isDiablo3InvisibleMaterial(name) ||
      isDiablo3InvisibleMaterial(materials[materialIndex]?.name ?? '')
    // The game draws a material in a look by its SubObjectAppearance flag. Without look data the
    // name heuristic stands in (it hides every state of a skeleton-named body, so it is only a fallback).
    const lookVisible = materials[materialIndex]?.metadata?.['lookVisible']
    const hasLooks = Array.isArray(lookVisible) && lookVisible.length > 0
    const outsideDefaultLook = hasLooks && lookVisible[0] !== true
    const appearanceVariant =
      hasNormalAppearanceMesh && !hasLooks ? diablo3AppearanceVariant(name, fullMeshPath) : undefined
    const hiddenReason = physicsMesh
      ? 'physics/destruction mesh'
      : invisibleMaterial
        ? 'invisible material'
        : outsideDefaultLook
          ? 'not in the default look'
          : equipmentVariantHidden
            ? 'equipment variant'
            : appearanceVariant
              ? 'alternate appearance state'
              : undefined
    const colors = fadesByVertex ? new Float32Array(vertexCount * 4).fill(1) : undefined
    if (colors) for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) colors[vertexIndex * 4 + 3] = vertexAlpha[vertexIndex]!
    meshes.push({
      name,
      materialIndex,
      positions,
      normals,
      ...(tangents ? { tangents } : {}),
      uvs,
      uvs1: lightmapUvs,
      ...(colors ? { colors } : {}),
      ...(boneIndices ? { boneIndices } : rigidIndices ? { boneIndices: rigidIndices } : {}),
      ...(boneWeights ? { boneWeights } : rigidWeights ? { boneWeights: rigidWeights } : {}),
      indices,
      metadata: {
        renderFlags,
        // +0x50 is the submesh's surface (SNO group 43, `.srf`); +0x54 its own bone
        surfaceSnoId: dv.getInt32(entry + 0x50, true),
        ...(rigidBone === undefined ? {} : { rigidBone }),
        sourceSubmeshIndex: meshIndex,
        fullMeshPath,
        ...(equipmentTier ? { equipmentTier } : {}),
        ...(equipmentGroup ? { equipmentGroup } : {}),
        ...(appearanceVariant ? { diablo3AppearanceVariant: appearanceVariant } : {}),
        defaultVisible: hiddenReason === undefined,
        viewerHidden: hiddenReason !== undefined,
        ...(hiddenReason ? { hiddenReason } : {}),
        ...(physicsMesh ? { physicsMesh: true } : {}),
        ...(invisibleMaterial ? { invisibleMaterial: true } : {}),
      },
    })
  }
  hideExactDuplicateDiablo3Meshes(meshes)
  return meshes
}

function diablo3AppearanceVariant(name: string, fullMeshPath: string): string | undefined {
  const value = `${name} ${fullMeshPath}`
  if (/decap/i.test(value)) return 'decap'
  if (/dismember/i.test(value)) return 'dismember'
  if (/intestine/i.test(value)) return 'intestine'
  if (/skeleton/i.test(value)) return 'skeleton'
  return undefined
}

interface ParsedBones {
  skeleton: RenderModel['skeleton']
  nodes: Array<Record<string, unknown>>
  /** Inverse of each bone's pose A (PRS0): the frame hardpoints and capsules are authored in. */
  restInverse: Float32Array[]
}

/**
 * Bone entries are 312 bytes with five PRS records from +0x6c. PRS0 is pose A in model space and
 * equals the chain of the parent-local PRS2 defaults on every bone of the installed game, so the
 * nodes rest there. PRS3 (+0xcc) is pose B, the pose the vertices are skinned in, and PRS4 (+0xec)
 * is its exact inverse, the palette the engine skins with. A and B differ on 5.5 % of bones (capes,
 * hair, carried props: 600 of 10 910 in a 1-in-7 corpus sample), so the inverse bind is PRS4, while
 * hardpoints keep the inverse of pose A.
 */
function parseBones(bytes: Uint8Array, dv: DataView): ParsedBones {
  const count = checkedCount(dv.getUint32(0x24, true), 'bone')
  if (count === 0) return { skeleton: { bones: [] }, nodes: [], restInverse: [] }
  const table = dataOffset(bytes, dv.getUint32(0x28, true), count * BONE_SIZE, 'bone table')
  const parents: number[] = []
  const names: string[] = []
  const restInverse: Float32Array[] = []
  const inverseBinds: Float32Array[] = []
  const defaultLocalTransforms: Diablo3Transform[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = table + index * BONE_SIZE
    const parent = dv.getUint32(entry + 0x40, true)
    parents.push(parent === 0xffffffff || parent >= count ? -1 : parent)
    names.push(stringAt(bytes, entry, 64) || `Bone ${index}`)
    restInverse.push(inverseTransformMatrix(readTransform(dv, entry + 0x6c)))
    inverseBinds.push(transformMatrix(readTransform(dv, entry + 0xec)))
    defaultLocalTransforms.push(readTransform(dv, entry + 0xac))
  }
  const bones = inverseBinds.map((inverseBindMatrix, index) => ({
    index,
    name: names[index]!,
    parentIndex: parents[index]!,
    inverseBindMatrix,
  }))
  return {
    skeleton: { bones },
    restInverse,
    nodes: defaultLocalTransforms.map((local, index) => ({
      index,
      name: names[index],
      parentIndex: parents[index],
      pivot: [0, 0, 0],
      flags: 0,
      translation: [...local.translation],
      rotation: [...local.rotation],
      scaling: [local.scale, local.scale, local.scale],
      inverseBindMatrix: Array.from(bones[index]!.inverseBindMatrix),
    })),
  }
}

/** A hardpoint or capsule, its transform in the frame of its parent bone's node (or the model's). */
export interface Diablo3Attachment {
  readonly name: string
  /** The bone it rides on, or -1 for the model itself. */
  readonly parentIndex: number
  readonly matrix: readonly number[]
}

export interface Diablo3Capsule extends Diablo3Attachment {
  readonly radius: number
  /** Distance between the two hemisphere centres along the local z axis; 0 makes a sphere. */
  readonly length: number
}

/**
 * The attach points and collision capsules of the appearance's Structure.
 *
 * Registry `Hardpoint` (96 bytes): name, parent bone, PRTransform at +0x44; the Structure counts
 * them at file 0x100 and points at the table from 0x104. Registry `CollisionCapsule` (104 bytes):
 * radius, length, then a Hardpoint; counted at 0xe8, table from 0xec. Their transforms are
 * model-space bind poses, not parent-local: on the installed game a hand hardpoint lies 0–13 units
 * from its wrist bone's PRS0 position. Each is therefore stored relative to its bone's pose A (PRS0),
 * which is the frame of that bone's node at rest; one without a bone stays in the model's frame.
 * Capsule radius and length are in the file's unit and scaled like every other length here; the
 * capsule axis is its local z (the skinned vertices of the thigh bones spread furthest along it).
 */
function parseAttachments(
  bytes: Uint8Array,
  dv: DataView,
  restInverse: readonly Float32Array[],
  issues: CodecIssue[],
): { hardpoints: Diablo3Attachment[]; capsules: Diablo3Capsule[] } {
  const table = (countAt: number, offsetAt: number, size: number, label: string): number[] => {
    if (!isRange(bytes, offsetAt, 4)) return []
    const count = dv.getUint32(countAt, true)
    if (count === 0) return []
    const start = dv.getUint32(offsetAt, true) + 16
    if (count > MAX_RECORDS || !isRange(bytes, start, count * size)) {
      issues.push({
        severity: 'warning',
        code: 'model-format-truncated: diablo3-app-attachments',
        message: `The ${label} table of the Diablo III appearance is out of range; it is left out.`,
      })
      return []
    }
    return Array.from({ length: count }, (_, index) => start + index * size)
  }
  const placed = (entry: number): Diablo3Attachment => {
    const parent = dv.getInt32(entry + 0x40, true)
    const parentIndex = parent >= 0 && parent < restInverse.length ? parent : -1
    const model = Array.from(transformMatrix(readTransform(dv, entry + 0x44, false)))
    const inverse = parentIndex >= 0 ? restInverse[parentIndex] : undefined
    return {
      name: stringAt(bytes, entry, 64),
      parentIndex,
      matrix: inverse === undefined ? model : multiplyAffine(Array.from(inverse), model),
    }
  }
  return {
    hardpoints: table(0x100, 0x104, HARDPOINT_SIZE, 'hardpoint').map(placed),
    capsules: table(0xe8, 0xec, CAPSULE_SIZE, 'collision capsule').map(entry => ({
      ...placed(entry + 8),
      radius: Math.max(0, finite(dv.getFloat32(entry, true))) * DIABLO3_APPEARANCE_SCALE,
      length: Math.max(0, finite(dv.getFloat32(entry + 4, true))) * DIABLO3_APPEARANCE_SCALE,
    })),
  }
}

/** One `CollisionShape` of a bone, in that bone's frame (axes and units as vertices). */
export interface Diablo3BoneShape {
  readonly boneIndex: number
  /** 0 sphere (centre `a`), 1 capsule (`a`–`b`), 2 cooked convex polytope (`points`). */
  readonly kind: 0 | 1 | 2
  /** `CollisionShape::nLodIndex`: 0 the full collider set, 1 the per-limb ragdoll proxy. */
  readonly lod: number
  /** Flag bit 0 marks the kinematic anchor a hanging rig is fixed to. */
  readonly anchor: boolean
  /** `flScaleX`, the density multiplier: a bone with a positive one at a LOD is a dynamic body. */
  readonly density: number
  readonly a: readonly [number, number, number]
  readonly b: readonly [number, number, number]
  readonly radius: number
  readonly points?: readonly number[]
}

const BONE_SHAPE_SIZE = 80
const POLYTOPE_HEADER_SIZE = 96
/** The client builds no fixture from a cook whose volume is below this or not finite. */
const POLYTOPE_MIN_VOLUME = 4.4143e-6

/**
 * The bones' collision shapes (`BoneStructure` +268 count, +272 offset/size of 80-byte records).
 * A record holds flags at +0, the kind at +4, the LOD at +8, `flScaleX` at +16, the polytope
 * cook's offset/size at +28, points A and B at +48/+60 and the radius at +72; kinds 0 and 1 always
 * carry a radius and never a cook, kind 2 the reverse (WhiteoutFlakes `d3_collision.h`, confirmed
 * on 5 506 shapes of a 1-in-7 corpus sample: 15 spheres, 1 679 capsules, 3 812 polytopes). A cook is
 * a 96-byte header — centroid +32, vertex/face/half-edge counts +44/+48/+52, volume +56, then the
 * vertex array's offset/size at +64 — whose counts satisfy Euler's V + F = E/2 + 2. The shapes carry
 * no matrix: their points are in the bone's own frame, so they ride the bone node as they are.
 * A record or cook out of range is left out with one warning.
 */
function parseBoneShapes(bytes: Uint8Array, dv: DataView, issues: CodecIssue[]): Diablo3BoneShape[] {
  const count = dv.getUint32(0x24, true)
  if (count === 0 || count > MAX_RECORDS) return []
  const table = dv.getUint32(0x28, true) + 16
  if (!isRange(bytes, table, count * BONE_SIZE)) return []
  const point = (offset: number): [number, number, number] => [
    finite(dv.getFloat32(offset + 4, true)) * DIABLO3_APPEARANCE_SCALE,
    -finite(dv.getFloat32(offset, true)) * DIABLO3_APPEARANCE_SCALE,
    finite(dv.getFloat32(offset + 8, true)) * DIABLO3_APPEARANCE_SCALE,
  ]
  const shapes: Diablo3BoneShape[] = []
  let dropped = 0
  for (let boneIndex = 0; boneIndex < count; boneIndex += 1) {
    const entry = table + boneIndex * BONE_SIZE
    const shapeCount = dv.getUint32(entry + 268, true)
    if (shapeCount === 0) continue
    const start = dv.getUint32(entry + 272, true) + 16
    if (shapeCount > 64 || !isRange(bytes, start, shapeCount * BONE_SHAPE_SIZE)) {
      dropped += shapeCount
      continue
    }
    for (let index = 0; index < shapeCount; index += 1) {
      const record = start + index * BONE_SHAPE_SIZE
      const kind = dv.getInt32(record + 4, true)
      const base = {
        boneIndex,
        lod: dv.getInt32(record + 8, true),
        anchor: (dv.getUint32(record, true) & 1) !== 0,
        density: finite(dv.getFloat32(record + 16, true)),
        a: point(record + 48),
        b: point(record + 60),
        radius: Math.max(0, finite(dv.getFloat32(record + 72, true))) * DIABLO3_APPEARANCE_SCALE,
      }
      if (kind === 0 || kind === 1) {
        if (base.radius > 0) shapes.push({ ...base, kind })
        else dropped += 1
        continue
      }
      const header = dv.getUint32(record + 28, true) + 16
      const points = kind === 2 && dv.getUint32(record + 32, true) === POLYTOPE_HEADER_SIZE &&
        isRange(bytes, header, POLYTOPE_HEADER_SIZE) ? polytopePoints(bytes, dv, header, point) : undefined
      if (points === undefined) dropped += 1
      else shapes.push({ ...base, kind: 2, points })
    }
  }
  if (dropped > 0)
    issues.push({
      severity: 'warning',
      code: 'model-format-truncated: diablo3-app-bone-shapes',
      message: `${String(dropped)} bone collision shape(s) of the Diablo III appearance are out of range or empty; they are left out.`,
    })
  return shapes
}

/** The vertices of a cooked convex polytope, or undefined when the cook fails the client's checks. */
function polytopePoints(
  bytes: Uint8Array,
  dv: DataView,
  header: number,
  point: (offset: number) => [number, number, number],
): number[] | undefined {
  const vertices = dv.getUint32(header + 44, true)
  const faces = dv.getUint32(header + 48, true)
  const halfEdges = dv.getUint32(header + 52, true)
  const volume = dv.getFloat32(header + 56, true)
  if (!(volume >= POLYTOPE_MIN_VOLUME) || !Number.isFinite(volume)) return undefined
  if (vertices < 4 || vertices > 65_536 || vertices + faces !== halfEdges / 2 + 2) return undefined
  const offset = dv.getUint32(header + 64, true) + 16
  if (dv.getUint32(header + 68, true) !== vertices * 12 || !isRange(bytes, offset, vertices * 12)) return undefined
  return Array.from({ length: vertices }, (_, index) => point(offset + index * 12)).flat()
}

function boundsFromMeshes(meshes: readonly RenderMesh[]): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const mesh of meshes) {
    for (let index = 0; index < mesh.positions.length; index += 3) {
      minX = Math.min(minX, mesh.positions[index]!)
      minY = Math.min(minY, mesh.positions[index + 1]!)
      minZ = Math.min(minZ, mesh.positions[index + 2]!)
      maxX = Math.max(maxX, mesh.positions[index]!)
      maxY = Math.max(maxY, mesh.positions[index + 1]!)
      maxZ = Math.max(maxZ, mesh.positions[index + 2]!)
    }
  }
  if (!Number.isFinite(minX)) return null
  const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, radius }
}

function aniDataOffset(
  bytes: Uint8Array,
  storedOffset: number,
  size: number,
  label: string,
): number {
  const offset = storedOffset + 16
  if (!isRange(bytes, offset, size)) throw new Error(`Diablo III ANI ${label} is out of range`)
  return offset
}

function aniTrack(
  bytes: Uint8Array,
  dv: DataView,
  descriptor: number,
  keyframeSize: number,
  dimensions: number,
  decode: (offset: number) => number[],
): Diablo3AnimationTrack | undefined {
  const count = checkedCount(dv.getUint32(descriptor, true), 'ANI keyframe')
  if (count === 0) return undefined
  const declaredSize = dv.getUint32(descriptor + 8, true)
  const expectedSize = count * keyframeSize
  if (declaredSize < expectedSize) throw new Error('Diablo III ANI keyframe section is truncated')
  const keyframes = aniDataOffset(
    bytes,
    dv.getUint32(descriptor + 4, true),
    expectedSize,
    'keyframe section',
  )
  const keys: Diablo3AnimationTrack['keys'] = []
  for (let index = 0; index < count; index += 1) {
    const offset = keyframes + index * keyframeSize
    const vector = decode(offset)
    if (vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) continue
    keys.push({ frame: dv.getUint32(offset, true), vector, interpolation: 'LINEAR' })
  }
  if (keys.length === 0) return undefined
  return { lineType: 1, globalSeqId: null, keys }
}

/** Diablo III AnimSet (.ans) default tag map: animation tag -> Animation SNO. */
export function isDiablo3AnimSet(bytes: Uint8Array): boolean {
  if (bytes.length < 0x30) return false
  const dv = view(bytes)
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== ANIM_SET_VERSION) return false
  const storedOffset = dv.getUint32(0x20, true)
  const declaredSize = dv.getUint32(0x24, true)
  return declaredSize >= 4 && isRange(bytes, storedOffset + 16, declaredSize)
}

export function parseDiablo3AnimSet(bytes: Uint8Array): Diablo3AnimSet {
  if (!isDiablo3AnimSet(bytes)) throw new Error('invalid or unsupported Diablo III ANS header')
  const dv = view(bytes)
  const table = dv.getUint32(0x20, true) + 16
  const declaredSize = dv.getUint32(0x24, true)
  const count = checkedCount(dv.getUint32(table, true), 'ANS animation')
  if (4 + count * TAG_MAP_ENTRY_SIZE > declaredSize) {
    throw new Error('Diablo III ANS default animation tag map is truncated')
  }
  const animations: Diablo3AnimSetEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = table + 4 + index * TAG_MAP_ENTRY_SIZE
    const type = dv.getInt32(entry, true)
    const tagId = dv.getInt32(entry + 4, true)
    const animationSnoId = dv.getInt32(entry + 8, true)
    if (animationSnoId < 0) continue
    animations.push({ type, tagId, animationSnoId })
  }
  return {
    snoId: dv.getInt32(0x10, true),
    parentAnimSetSnoId: dv.getInt32(0x1c, true),
    animations,
  }
}

/** Current retail Actor (.acr) links used to locate its appearance/animation set. */
export function isDiablo3Actor(bytes: Uint8Array): boolean {
  if (bytes.length < 0x7c) return false
  const dv = view(bytes)
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== ACTOR_VERSION) return false
  const storedOffset = dv.getUint32(0x68, true)
  const declaredSize = dv.getUint32(0x6c, true)
  return declaredSize >= 4 && isRange(bytes, storedOffset + 16, declaredSize)
}

export function parseDiablo3ActorLinks(bytes: Uint8Array): Diablo3ActorLinks {
  if (!isDiablo3Actor(bytes)) throw new Error('invalid or unsupported Diablo III ACR header')
  const dv = view(bytes)
  return {
    snoId: dv.getInt32(0x10, true),
    // MK2 read 0x28; on the installed game 0x24 holds the linked appearance's own SNO id.
    appearanceSnoId: dv.getInt32(0x24, true),
    animSetSnoId: dv.getInt32(0x78, true),
  }
}

export function isDiablo3Animation(bytes: Uint8Array): boolean {
  if (bytes.length < 56) return false
  const dv = view(bytes)
  const blockCount = dv.getUint32(0x30, true)
  return (
    dv.getUint32(0, true) === MAGIC &&
    dv.getUint32(4, true) === ANI_VERSION &&
    blockCount <= MAX_RECORDS &&
    isRange(bytes, dv.getUint32(0x28, true), blockCount * ANI_BLOCK_SIZE)
  )
}

export function parseDiablo3Animation(bytes: Uint8Array, hint = ''): Diablo3AnimationFile {
  if (!isDiablo3Animation(bytes)) throw new Error('invalid or unsupported Diablo III ANI header')
  const dv = view(bytes)
  const blockOffset = dv.getUint32(0x28, true)
  const blockCount = checkedCount(dv.getUint32(0x30, true), 'ANI block')
  const clips: Diablo3AnimationClip[] = []
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const block = blockOffset + blockIndex * ANI_BLOCK_SIZE
    const boneCount = checkedCount(dv.getUint32(block + 0x88, true), 'ANI bone')
    const boneNames = aniDataOffset(
      bytes,
      dv.getUint32(block + 0x8c, true),
      boneCount * ANI_BONE_NAME_SIZE,
      'bone name table',
    )
    const translationDescriptors = aniDataOffset(
      bytes,
      dv.getUint32(block + 0xa4, true),
      boneCount * ANI_TRACK_DESCRIPTOR_SIZE,
      'translation descriptor table',
    )
    const rotationDescriptors = aniDataOffset(
      bytes,
      dv.getUint32(block + 0xb8, true),
      boneCount * ANI_TRACK_DESCRIPTOR_SIZE,
      'rotation descriptor table',
    )
    const scaleDescriptors = aniDataOffset(
      bytes,
      dv.getUint32(block + 0xc8, true),
      boneCount * ANI_TRACK_DESCRIPTOR_SIZE,
      'scale descriptor table',
    )
    const bones: Diablo3BoneAnimation[] = []
    for (let boneIndex = 0; boneIndex < boneCount; boneIndex += 1) {
      const name = stringAt(bytes, boneNames + boneIndex * ANI_BONE_NAME_SIZE, ANI_BONE_NAME_SIZE)
      const translation = aniTrack(
        bytes,
        dv,
        translationDescriptors + boneIndex * ANI_TRACK_DESCRIPTOR_SIZE,
        16,
        3,
        offset => [
          finite(dv.getFloat32(offset + 8, true)) * DIABLO3_APPEARANCE_SCALE,
          -finite(dv.getFloat32(offset + 4, true)) * DIABLO3_APPEARANCE_SCALE,
          finite(dv.getFloat32(offset + 12, true)) * DIABLO3_APPEARANCE_SCALE,
        ],
      )
      const rotation = aniTrack(
        bytes,
        dv,
        rotationDescriptors + boneIndex * ANI_TRACK_DESCRIPTOR_SIZE,
        12,
        4,
        offset => [
          ...normalizeQuaternion([
            dv.getInt16(offset + 6, true) / 32767,
            -dv.getInt16(offset + 4, true) / 32767,
            dv.getInt16(offset + 8, true) / 32767,
            dv.getInt16(offset + 10, true) / 32767,
          ]),
        ],
      )
      const scaling = aniTrack(
        bytes,
        dv,
        scaleDescriptors + boneIndex * ANI_TRACK_DESCRIPTOR_SIZE,
        8,
        3,
        offset => {
          const scale = finite(dv.getFloat32(offset + 4, true), 1)
          return [scale, scale, scale]
        },
      )
      bones.push({
        name: name || `Bone ${boneIndex}`,
        ...(translation ? { translation } : {}),
        ...(rotation ? { rotation } : {}),
        ...(scaling ? { scaling } : {}),
      })
    }
    const frameCount = checkedCount(dv.getUint32(block + 0xa0, true), 'ANI frame')
    const storedTimingRate = dv.getUint32(block + 0x74, true)
    // Frames per engine tick (+0x58) at the engine's 60 ticks a second: 0.5 → 30 fps on 344 of 400
    // sampled clips, the rest from 20 to 41 (WhiteoutFlakes `d3_model_adapter.cpp`, BSD-3-Clause).
    // The stored +0x74 is 100 on almost every clip and is no rate; without +0x58, 30 fps.
    const framesPerTick = finite(dv.getFloat32(block + 0x58, true))
    const fps = framesPerTick > 0 && framesPerTick <= 4 ? framesPerTick * 60 : 30
    const authoredDuration = finite(dv.getFloat32(block + 0x64, true))
    const durationSeconds = Math.max(0, frameCount - 1) / fps
    const events = parseAniEvents(bytes, dv, block)
    const fileName =
      hint
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.replace(/\.ani$/i, '') ?? ''
    clips.push({
      name: stringAt(bytes, block + 0x14, 64) || fileName || `Animation ${blockIndex}`,
      frameCount,
      fps,
      durationSeconds,
      bones,
      metadata: {
        source: hint,
        nameHash: dv.getUint32(block + 8, true),
        flags: dv.getUint32(block + 0x6c, true),
        flags2: dv.getUint32(block + 0x70, true),
        speed: finite(dv.getFloat32(block + 0x78, true), 1),
        authoredDuration,
        storedTimingRate,
        timingSource: framesPerTick > 0 && framesPerTick <= 4 ? 'frames-per-tick×60' : 'frame-index/30fps',
        ...(events.length === 0 ? {} : { events }),
      },
    })
  }
  return {
    snoId: dv.getInt32(0x10, true),
    modelSnoRef: dv.getInt32(0x24, true),
    clips,
  }
}

/**
 * The clip's timed events: the permutation counts them at block +0x124 and points at the table from
 * +0x11c (registry AnimPermutation +0x114 / +0x10c). The time is a frame index — events of a
 * 21-frame attack fall on frames 2 to 16, of a 91-frame opening on frame 20. A table out of range
 * is dropped as a whole rather than read in part; an empty name is "- None -" in the editor.
 */
function parseAniEvents(bytes: Uint8Array, dv: DataView, block: number): Diablo3ClipEvent[] {
  const count = dv.getUint32(block + 0x124, true)
  if (count === 0 || count > MAX_RECORDS) return []
  const table = dv.getUint32(block + 0x11c, true) + 16
  if (!isRange(bytes, table, count * ANI_EVENT_SIZE)) return []
  const named = (offset: number): string | undefined => {
    const value = stringAt(bytes, offset, 64)
    return value === '' || value === '- None -' ? undefined : value
  }
  return Array.from({ length: count }, (_, index) => {
    const entry = table + index * ANI_EVENT_SIZE
    const look = named(entry + 0xd0)
    return {
      frame: Math.max(0, finite(dv.getFloat32(entry, true))),
      kind: dv.getInt32(entry + 0x2c, true),
      flags: dv.getInt32(entry + 0x04, true),
      snoGroup: dv.getInt32(entry + 0x30, true),
      snoId: dv.getInt32(entry + 0x34, true),
      hardpoints: [named(entry + 0x48), named(entry + 0x8c)].filter(
        (name): name is string => name !== undefined,
      ),
      ...(look === undefined ? {} : { look }),
    }
  })
}

/** Most of a clip's bones are the rig's: at least half, and at least one. */
function sharesRig(clip: Diablo3AnimationClip, rig: ReadonlyMap<string, number>): boolean {
  if (clip.bones.length === 0) return false
  const known = clip.bones.filter(bone => rig.has(bone.name.toLowerCase())).length
  return known > 0 && known * 2 >= clip.bones.length
}

export function attachDiablo3Animations(
  model: RenderModel,
  inputs: readonly Diablo3AnimationInput[],
): RenderModel {
  const issues = Array.isArray(model.metadata?.['issues'])
    ? ([...(model.metadata?.['issues'] as CodecIssue[])] as CodecIssue[])
    : []
  const modelSnoId = Number(model.metadata?.['snoId'])
  const animations: RenderAnimation[] = [...model.animations]
  const rawNodes = Array.isArray(model.metadata?.['war3Nodes'])
    ? (model.metadata?.['war3Nodes'] as Array<Record<string, unknown>>).map(node => ({ ...node }))
    : []
  const nodesByName = new Map(
    rawNodes.map(node => [String(node['name'] ?? '').toLowerCase(), node]),
  )
  const sources: string[] = []
  // one warning per missing bone, not one per clip: a hero's cosmetic bones recur in every clip
  const unknownBones = new Set<string>()
  const boneIndexByName = new Map(
    model.skeleton.bones.map(bone => [bone.name.toLowerCase(), bone.index]),
  )

  const bindTrack = (vector: readonly number[]): RenderScalarAnimationTrack => ({
    lineType: 1,
    globalSeqId: null,
    keys: [{ frame: 0, vector }],
  })
  const timedTrack = (
    track: Diablo3AnimationTrack | undefined,
    fallback: readonly number[],
    clip: Diablo3AnimationClip,
  ): RenderScalarAnimationTrack => ({
    lineType: track?.lineType ?? 1,
    globalSeqId: null,
    keys:
      track?.keys.map(key => ({
        frame: key.frame / clip.fps,
        vector: key.vector,
      })) ?? bindTrack(fallback).keys,
  })
  // war3Nodes/WebGL compatibility tracks use the historical millisecond
  // convention, unlike RenderSequence nodeTracks whose key times are seconds.
  const millisecondTrack = (
    track: Diablo3AnimationTrack | undefined,
    clip: Diablo3AnimationClip,
  ): RenderScalarAnimationTrack | undefined =>
    track
      ? {
          lineType: track.lineType,
          globalSeqId: null,
          keys: track.keys.map(key => ({
            frame: (key.frame / clip.fps) * 1000,
            vector: key.vector,
          })),
        }
      : undefined

  for (const input of inputs) {
    try {
      const animationFile = parseDiablo3Animation(input.bytes, input.hint)
      // A variant (`ghoul_b`) plays the clips its family authored on another appearance
      // (`ghoul`): the actor's set names them, and a clip joins the rig by bone name. A clip of
      // another model is kept when most of its bones are this rig's.
      if (
        Number.isFinite(modelSnoId) &&
        animationFile.modelSnoRef !== modelSnoId &&
        animationFile.modelSnoRef !== -1 &&
        !animationFile.clips.every(clip => sharesRig(clip, boneIndexByName))
      ) {
        continue
      }
      for (const clip of animationFile.clips) {
        const animationIndex = animations.length
        const animatedBones = new Map(clip.bones.map(bone => [bone.name.toLowerCase(), bone]))
        const nodeTracks: RenderSequence['nodeTracks'] = rawNodes.map((node, boneIndex) => {
          const bone = animatedBones.get(String(node['name'] ?? '').toLowerCase())
          const translation = Array.isArray(node['translation'])
            ? (node['translation'] as number[])
            : [0, 0, 0]
          const rotation = Array.isArray(node['rotation'])
            ? (node['rotation'] as number[])
            : [0, 0, 0, 1]
          const scaling = Array.isArray(node['scaling']) ? (node['scaling'] as number[]) : [1, 1, 1]
          return {
            boneIndex,
            translation: timedTrack(bone?.translation, translation, clip),
            rotation: timedTrack(bone?.rotation, rotation, clip),
            scale: timedTrack(bone?.scaling, scaling, clip),
          }
        })
        const flags = Number(clip.metadata['flags']) || 0
        const sequence: RenderSequence = {
          name: clip.name,
          durationSeconds: clip.durationSeconds,
          looping: (flags & 0x8) !== 0,
          nodeTracks,
          startFrame: 0,
          endFrame: clip.durationSeconds * 1000,
          metadata: { ...clip.metadata, fps: clip.fps, sourceFormat: 'diablo3-ani' },
        }
        animations.push(sequence)
        for (const bone of clip.bones) {
          const node = nodesByName.get(bone.name.toLowerCase())
          if (!node) continue
          const animation: Record<string, unknown> = {}
          const translation = millisecondTrack(bone.translation, clip)
          const rotation = millisecondTrack(bone.rotation, clip)
          const scaling = millisecondTrack(bone.scaling, clip)
          if (translation) animation['translation'] = translation
          if (rotation) animation['rotation'] = rotation
          if (scaling) animation['scaling'] = scaling
          if (Object.keys(animation).length === 0) continue
          const animationClips = Array.isArray(node['animationClips'])
            ? [...(node['animationClips'] as unknown[])]
            : []
          animationClips.push({ animationIndex, name: clip.name, animation })
          node['animationClips'] = animationClips
        }
        for (const bone of clip.bones) {
          if (!boneIndexByName.has(bone.name.toLowerCase()) && !unknownBones.has(bone.name.toLowerCase())) {
            unknownBones.add(bone.name.toLowerCase())
            issues.push({
              severity: 'warning',
              code: 'model-format-unmatched: diablo3-ani-bone',
              message: `Animation '${clip.name}' references unknown bone '${bone.name}'.`,
            })
          }
        }
      }
      if (input.hint) sources.push(input.hint)
    } catch (error) {
      issues.push({
        severity: 'warning',
        code: 'model-format-invalid: diablo3-ani',
        message: `Could not attach Diablo III animation '${input.hint ?? 'ANI'}': ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    ...model,
    animations,
    metadata: {
      ...model.metadata,
      issues,
      war3Nodes: rawNodes,
      diablo3AnimationSources: sources,
    },
  }
}

export function isDiablo3Appearance(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE) return false
  const dv = view(bytes)
  return (
    dv.getUint32(0, true) === MAGIC &&
    dv.getUint32(4, true) === VERSION &&
    dv.getUint32(0x0a8, true) <= MAX_RECORDS &&
    dv.getUint32(0x1b4, true) <= MAX_RECORDS
  )
}

export function parseDiablo3Appearance(bytes: Uint8Array, hint = ''): RenderModel {
  if (!isDiablo3Appearance(bytes)) throw new Error('invalid or unsupported Diablo III APP header')
  const dv = view(bytes)
  const issues: CodecIssue[] = []
  const materials = parseMaterials(bytes, dv, issues)
  const meshes = parseMeshes(bytes, dv, materials, issues)
  const parsedBones = parseBones(bytes, dv)
  const attachments = parseAttachments(bytes, dv, parsedBones.restInverse, issues)
  if (meshes.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'model-format-empty: diablo3-app',
      message: 'The Diablo III appearance has no previewable render meshes.',
    })
  }
  return {
    format: 'sno',
    meshes,
    skeleton: parsedBones.skeleton,
    materials,
    animations: [],
    bounds: boundsFromMeshes(meshes),
    effects: { particles: [], ribbons: [] },
    metadata: {
      source: 'diablo3-app',
      fileName: hint.replace(/\\/g, '/').split('/').pop() ?? '',
      version: VERSION,
      snoId: dv.getInt32(0x10, true),
      objectType: dv.getUint32(0x20, true),
      looks: parseLooks(bytes, dv),
      war3Nodes: parsedBones.nodes,
      hardpoints: attachments.hardpoints,
      capsules: attachments.capsules,
      boneShapes: parseBoneShapes(bytes, dv, issues),
      issues,
    },
  }
}

/**
 * The render state of a material that the appearance does not hold: the pass its ShaderMap selects.
 * Fields are the executable registry's RenderPass/RenderParams offsets (file offset = field + 0x10);
 * their meaning was read off the installed game's 1,856 passes against their shaders' names (an
 * opaque pass writes depth and does not blend; an alpha-tested one keeps texels past its reference).
 */
export interface Diablo3RenderPass {
  readonly shader: string
  readonly effect: string
  readonly pixelEntry: string
  /** D3DCULL: 1 none, 2 clockwise, 3 counter-clockwise. */
  readonly cull: number
  readonly depthWrite: boolean
  readonly alphaTest: boolean
  /** D3DCMPFUNC of the alpha test: 5 greater, 7 greater-equal, 4 less-equal (a wipe). */
  readonly alphaFunc: number
  /** 0–255. */
  readonly alphaRef: number
  readonly blend: boolean
  /** The engine's blend factors: 1 zero, 2 one, 5 source alpha, 6 inverse source alpha, 7 destination colour, 11 constant. */
  readonly blendSource: number
  readonly blendDestination: number
  /** The `EMaterialTextureType` each texture stage samples, in stage order. */
  readonly stages: readonly number[]
}

const SHADER_MAP_VERSION_OFFSET = 4
const RENDER_PASS_SIZE = 568
const TEXTURE_STAGE_SIZE = 24

/** A ShaderMap (`.shm`): its tag map (count, then type/tag/value triples) of Shaders SNOs. */
export function parseDiablo3ShaderMap(bytes: Uint8Array): ReadonlyMap<number, number> {
  const dv = view(bytes)
  if (bytes.length < 0x30 || dv.getUint32(0, true) !== MAGIC || dv.getUint32(SHADER_MAP_VERSION_OFFSET, true) === 0)
    throw new Error('invalid Diablo III ShaderMap header')
  const offset = dv.getUint32(0x20, true) + 16
  const size = dv.getUint32(0x24, true)
  if (size < 4 || !isRange(bytes, offset, size)) throw new Error('Diablo III ShaderMap tag map is out of range')
  const count = dv.getUint32(offset, true)
  if (4 + count * TAG_MAP_ENTRY_SIZE > size) throw new Error('Diablo III ShaderMap tag map is truncated')
  const tags = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 4 + index * TAG_MAP_ENTRY_SIZE
    tags.set(dv.getUint32(entry + 4, true), dv.getInt32(entry + 8, true))
  }
  return tags
}

/** The Shaders a ShaderMap resolves to along the engine's opaque tag chain. */
export function diablo3ShaderOf(tags: ReadonlyMap<number, number>, known?: (snoId: number) => boolean): number | undefined {
  for (const tag of DIABLO3_SHADER_TAG_CHAIN) {
    const snoId = tags.get(tag)
    if (snoId !== undefined && snoId > 0 && (known?.(snoId) ?? true)) return snoId
  }
  return undefined
}

/** A Shaders (`.shd`) file's first render pass: the state the material draws with. */
export function parseDiablo3Shaders(bytes: Uint8Array): Diablo3RenderPass {
  const dv = view(bytes)
  if (bytes.length < 0x138 || dv.getUint32(0, true) !== MAGIC) throw new Error('invalid Diablo III Shaders header')
  const offset = dv.getUint32(0x28, true) + 16
  const size = dv.getUint32(0x2c, true)
  if (size < RENDER_PASS_SIZE || !isRange(bytes, offset, RENDER_PASS_SIZE)) throw new Error('Diablo III Shaders has no render pass')
  const params = offset + 0x8
  const u = (at: number) => dv.getUint32(params + at, true)
  const stagesOffset = dv.getUint32(offset + 0x70, true) + 16
  const stageCount = Math.floor(dv.getUint32(offset + 0x74, true) / TEXTURE_STAGE_SIZE)
  const stages =
    stageCount <= 64 && isRange(bytes, stagesOffset, stageCount * TEXTURE_STAGE_SIZE)
      ? Array.from({ length: stageCount }, (_, stage) => dv.getUint32(stagesOffset + stage * TEXTURE_STAGE_SIZE, true))
      : []
  return {
    shader: stringAt(bytes, 0x38, 256),
    effect: stringAt(bytes, offset + 0x84, 256),
    pixelEntry: stringAt(bytes, offset + 0x1c4, 64),
    cull: u(0x00),
    depthWrite: u(0x04) !== 0,
    alphaTest: u(0x2c) !== 0,
    alphaFunc: u(0x30),
    alphaRef: u(0x34) & 0xff,
    blend: u(0x4c) !== 0,
    blendSource: u(0x54),
    blendDestination: u(0x58),
    stages,
  }
}

export const diablo3AppearanceModelCodec: ModelCodec = {
  id: 'diablo3-app',
  displayName: 'Diablo III appearance',
  format: 'sno',
  extensions: ['.app'],
  capabilities: { skeleton: true, animations: true, effects: false },
  canParse: isDiablo3Appearance,
  async parse(bytes, hint, options = {}) {
    const sourceHint = hint ?? ''
    const model = parseDiablo3Appearance(bytes, sourceHint)
    const resolver = options.assetResolver
    if (!resolver?.list) return model
    for (const pattern of diablo3AniSidecarPatterns(sourceHint)) {
      const paths = (await resolver.list(pattern, 'animation')).slice(0, 128)
      if (paths.length === 0) continue
      const resolved = await Promise.all(
        paths.map(async path => ({
          hint: path,
          bytes: await resolver.resolve({ path, role: 'animation' }),
        })),
      )
      const inputs: Diablo3AnimationInput[] = []
      for (const input of resolved) {
        if (input.bytes) inputs.push({ hint: input.hint, bytes: input.bytes })
      }
      return attachDiablo3Animations(model, inputs)
    }
    return model
  },
}
