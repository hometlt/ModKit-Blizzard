/**
 * World of Warcraft M2 as a Modkit model scene — the projection half of `blizzard/wow-m2` (owner:
 * GAME-WOW). From a decoded model (`./reader.ts`) and its first skin profile it builds the facets
 * the codec publishes (`common.view/model-*-source`) and the `ModelProjection` that
 * `model.export-uvm` hands to the one UVM materializer of `@modkit/uv`.
 *
 * Frame: WoW is z-up and right-handed, in yards. The scene states `upAxis: '+z'` and the
 * materializer turns it and applies the unit scale; nothing here rotates or scales geometry.
 *
 * Nodes: a `root` node holding every mesh, the bones under it (`bone-<i>`) and one child node per
 * attachment (`attachment-<i>`). A bone's rest pose is its pivot relative to its parent's pivot;
 * an animated translation key adds that offset back, since the client composes
 * `parent · T(pivot) · T(t) · R · S · T(−pivot)` (WhiteoutFlakes `M2BoneLocal`). The inverse bind
 * matrix is `T(−pivot)`. A spherical billboard bone (flag 0x8 alone) faces the camera with the
 * Blizzard card rule shared with MDX; axis-locked and mixed billboard bits are not projected.
 *
 * Geometry: one mesh per drawn skin submesh, one primitive per batch (texture unit) on it — a
 * second-layer batch is a separate primitive with its own material, drawn after by `priority`.
 * Vertices are gathered through the skin's two-level indirection; both UV sets are published.
 * Skinning uses the vertex's global bone indices and weights / 255.
 *
 * Materials: one per batch. Blend modes map to `UV_game_material` names (opaque, alpha-key,
 * alpha-blend, additive, add-alpha, modulate, modulate2x); BlendAdd (7, premultiplied over) has no
 * registered name and is published as a blend with its native mode in the shader parameters.
 * Material flag 0x10 disables depth writes and 0x08 depth tests (WhiteoutFlakes, from the client's
 * SetupMaterial; the wiki names them the other way round). Static colour × alpha × texture
 * weight at the first key of sequence 0 is the fallback base colour factor. Qualified unlit,
 * single-texture batches retain separate animated RGB/alpha/weight and translation-only UV tracks
 * through the existing material program; other combiners are explicitly partial.
 * Textures: type 0 names its file (`filedataid/<TXID>` or the in-file path); other types are
 * chosen by the game from its tables; an explicit resolved native slot map binds them. Without
 * that map they stay unresolved, stated in the parameters.
 *
 * Animation: one clip per sequence, bone translation/rotation/scale channels sampled from the
 * sequence's own keyframe list. Per the client, a track with fewer lists than sequences reads list
 * 0; an alias sequence (0x40) plays its `aliasNext` target; a global-sequence track runs in every
 * clip on its own clock (`concurrent`, wrapping at its loop). Bezier/Hermite bone tracks carry no
 * tangents in M2 and are published linearly. Events become clip events at their bone.
 *
 * Adapted from WhiteoutFlakes (BSD-3-Clause, © 2026 Fernando Sahmkow): `m2_model_adapter.cpp`,
 * `m2_animation.h`, `profiles/wow/m2_material.*`. See NOTICE.md.
 */
import { withoutHeldSamples } from '@modkit/codec-kit/model/animation'
import { composeTrsMatrix } from '@modkit/codec-kit/model-math/sequence-pose'
import { projectBatchMaterial } from './materials.js'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import type {
  ModelAnimationChannel,
  ModelAnimationClip,
  ModelAnimationEvent,
  ModelBoneBinding,
  ModelMaterialLayerRef,
  ModelMaterialRef,
  ModelMesh,
  ModelNode,
  ModelPrimitive,
  ModelResourceRef,
  ModelSceneInfo,
  ModelSocketRef,
  JsonValue,
} from '@modkit/sdk'
import {
  SEQUENCE_ALIAS,
  type M2Keys,
  type M2Model,
  type M2Skin,
  type M2Track,
  type Quat,
  type Vec3,
} from './reader.js'

/** One WoW world unit (a yard), in metres. */
export const WOW_METERS_PER_UNIT = 0.9144
export const SKELETON = 'skeleton'
export const ROOT = 'root'
export const boneNode = (index: number): string => `bone-${String(index)}`
export const attachmentNode = (index: number): string => `attachment-${String(index)}`
export const clipId = (index: number): string => `sequence-${String(index)}`
export const fileDataIdPath = (fileId: number): string => `filedataid/${String(fileId)}`

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
/** A column-major translation matrix, exact in doubles (inverse bind matrices). */
const translation = (t: Vec3): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]
/**
 * A node's local matrix for a pure translation, composed by the shared TRS kernel in float32 — the
 * matrix the materializer rebuilds from the bone's local pose and compares bit for bit.
 */
function restMatrix(t: Vec3): number[] {
  const matrix = new Float32Array(16)
  composeTrsMatrix(matrix, 0, t, [0, 0, 0, 1], [1, 1, 1])
  return [...matrix]
}
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/**
 * The Blizzard card rule for a spherical billboard: the node's +X toward the viewer, Z upright —
 * the same basis the client installs for MDX (WAR3_BILLBOARD in blizzard-warcraft-3) and, per
 * WhiteoutFlakes, for an unrotated M2 bone (rows (0,0,−1) (1,0,0) (0,1,0) of a left-handed view).
 */
const SPHERICAL_BILLBOARD = Object.freeze({
  mode: 'inverse-camera' as const,
  basisRotations: Object.freeze([
    Object.freeze([0, -Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as const),
    Object.freeze([-Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)] as const),
  ]),
})

/** Attachment ids the format documents, by role name (M2 spec §10.1). */
const ATTACHMENT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Shield', 1: 'HandRight', 2: 'HandLeft', 3: 'ElbowRight', 4: 'ElbowLeft', 5: 'ShoulderRight',
  6: 'ShoulderLeft', 7: 'KneeRight', 8: 'KneeLeft', 9: 'HipRight', 10: 'HipLeft', 11: 'Helm',
  12: 'Back', 17: 'Breath', 18: 'PlayerName', 19: 'Base', 20: 'Head', 21: 'SpellLeftHand',
  22: 'SpellRightHand', 26: 'SheathMainHand', 27: 'SheathOffHand', 28: 'SheathShield',
  29: 'PlayerNameMounted', 34: 'Chest', 47: 'LeftFoot', 48: 'RightFoot',
})

/** `M2Material.blendingMode` → `UV_game_material` blend, coverage. */
const BLENDS: readonly { readonly alphaMode: 'opaque' | 'mask' | 'blend'; readonly blendMode?: string; readonly name: string }[] = [
  { alphaMode: 'opaque', blendMode: 'opaque', name: 'opaque' },
  { alphaMode: 'mask', blendMode: 'alpha-key', name: 'alpha-key' },
  { alphaMode: 'blend', blendMode: 'alpha-blend', name: 'alpha' },
  { alphaMode: 'blend', blendMode: 'additive', name: 'no-alpha-add' },
  { alphaMode: 'blend', blendMode: 'add-alpha', name: 'add' },
  { alphaMode: 'blend', blendMode: 'modulate', name: 'mod' },
  { alphaMode: 'blend', blendMode: 'modulate2x', name: 'mod2x' },
  { alphaMode: 'blend', name: 'blend-add' },
]
/** The client's alpha-key reference: a cvar defaulting to 128. */
const ALPHA_KEY_CUTOFF = 128 / 255

/** The native hierarchy; invalid references cannot be replaced with invented roots. */
function parentsOf(model: M2Model): number[] {
  const parents = model.bones.map((bone, index) => {
    if (bone.parent < -1 || bone.parent >= model.bones.length || bone.parent === index)
      throw new TypeError(`M2 bone ${String(index)} has an invalid parent`)
    return bone.parent
  })
  for (let index = 0; index < parents.length; index += 1) {
    // A chain longer than the bone count necessarily contains a cycle.
    let at = parents[index]!
    for (let steps = 0; at >= 0 && steps <= parents.length; steps += 1) at = parents[at]!
    if (at >= 0) throw new TypeError('M2 bone hierarchy contains a cycle')
  }
  return parents
}

/** What the projection derives from one model and skin, computed once per codec open. */
export interface M2Scene {
  readonly info: ModelSceneInfo
  readonly nodes: readonly ModelNode[]
  readonly meshes: readonly ModelMesh[]
  readonly primitives: readonly ModelPrimitive[]
  readonly materials: readonly ModelMaterialRef[]
  readonly skeleton: readonly ModelBoneBinding[]
  readonly sockets: readonly ModelSocketRef[]
  readonly clips: readonly ModelAnimationClip[]
  readonly textures: readonly ModelResourceRef[]
  /** Facts the codec reports as warnings. */
  readonly notes: readonly string[]
}

/** Explicit native texture slots supplied by the selected appearance resolver. */
export interface M2SceneOptions {
  readonly replaceableTextures?: ReadonlyMap<number, string>
}

/** The texture's own logical id, or its explicitly resolved game-selected slot. */
function textureId(model: M2Model, index: number, replacements?: ReadonlyMap<number, string>): string | undefined {
  const texture = model.textures[index]
  if (texture === undefined) return undefined
  if (texture.type !== 0) return replacements?.get(texture.type)
  const fileId = model.fileIds.textures[index]
  if (fileId !== undefined && fileId !== 0) return fileDataIdPath(fileId)
  return texture.filename === '' ? undefined : texture.filename
}

/** A track's value at the start of sequence 0, or `fallback` when it keys nothing there. */
function restValue<T>(track: M2Track<T> | undefined, fallback: T): T {
  return track?.perSequence[0]?.values[0] ?? fallback
}

/** The scene of a model drawn with one skin profile (absent: metadata only). */
export function buildM2Scene(model: M2Model, skin: M2Skin | undefined, options: M2SceneOptions = {}): M2Scene {
  const replacements = options.replaceableTextures
  for (const [type, resource] of replacements ?? []) {
    if (!Number.isInteger(type) || type < 1 || type > 0xffffffff || typeof resource !== 'string' || !/^filedataid\/[1-9][0-9]*$/u.test(resource) ||
      Number(resource.slice('filedataid/'.length)) > 0xffffffff)
      throw new TypeError('M2 appearance requires a native nonzero texture slot and FileDataID')
  }
  const notes: string[] = []
  const parents = parentsOf(model)
  const nodes = buildNodes(model, parents)
  const textures = model.textures
    .map((_, index) => textureId(model, index, replacements))
    .filter((id, index, all): id is string => id !== undefined && all.indexOf(id) === index)
    .map((id): ModelResourceRef => ({ id, role: 'texture', provenance: 'reference-only' }))
  const geometry = skin === undefined ? undefined : buildGeometry(model, skin, notes, replacements)
  if (geometry !== undefined) {
    const root = nodes[0]!
    nodes[0] = { ...root, meshIds: geometry.meshes.map(mesh => mesh.id) }
  }
  const skeleton = model.bones.map(
    (bone, index): ModelBoneBinding => ({
      partId: SKELETON,
      boneIndex: index,
      boneName: null,
      provenance: 'direct',
      hierarchyId: SKELETON,
      parentBoneIndex: parents[index]! < 0 ? null : parents[index]!,
      nativeFlags: bone.flags,
      nodeId: boneNode(index),
      localPose: {
        translation: minus(bone.pivot, parents[index]! < 0 ? [0, 0, 0] : model.bones[parents[index]!]!.pivot),
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      inverseBindMatrix: translation([-bone.pivot[0], -bone.pivot[1], -bone.pivot[2]]),
    }),
  )
  const sockets = model.attachments.map(
    (attachment, index): ModelSocketRef => ({
      id: attachmentNode(index),
      nodeId: attachmentNode(index),
      role: 'attach',
      sourceName: ATTACHMENT_NAMES[attachment.id] ?? `Attachment${String(attachment.id)}`,
    }),
  )
  const clips = buildClips(model, parents, notes)
  if (model.bones.some(bone => (bone.flags & 0x280) !== 0 && (bone.flags & 0x400) === 0 && bone.rotation.perSequence.some(keys => keys.values.length > 1 &&
    (keys.interpolation ?? bone.rotation.interpolation) !== 0)))
    notes.push('rotation-nlerp: common spherical-linear interpolation approximates native no-sign-flip NLERP')
  if (model.attachments.some(attachment => attachment.enabled.perSequence.some(keys => keys.values.some(value => value === 0))))
    notes.push('attachment-visibility: disabled socket intervals are not projected by the socket contract')
  if (model.bones.some(bone => (bone.flags & 7) !== 0))
    notes.push('bone-inheritance: native parent-component suppression is retained as flags but not projected')
  if (model.bones.some(bone => (bone.flags & 0x400) !== 0))
    notes.push('kinematic-physics: kinematic joints inherit their parent without a native physics solver')
  const partialMaterials = geometry === undefined || geometry.materials.some(material => material.shader?.id === 'blizzard.wow-m2.batch')
  if (model.textureTransforms.length > 0 && partialMaterials)
    notes.push('texture-transform: native UV tracks are decoded; their pre-multiplied matrix is not projected')
  if (partialMaterials && (model.colors.some(color => [color.color, color.alpha].some(track => track.perSequence.some(keys => keys.values.length > 1))) ||
    model.textureWeights.some(track => track.perSequence.some(keys => keys.values.length > 1))))
    notes.push('material-animation: this batch projection uses the first colour, alpha and weight key')
  if (model.textures.some((texture, index) => texture.type !== 0 && textureId(model, index, replacements) === undefined))
    notes.push('texture-appearance: game-selected texture slots need an explicit resolved display or character context')
  if (model.events.some(event => event.times.globalSequence !== null ||
    event.times.perSequence.some(keys => keys.globalPeriodMilliseconds !== undefined)))
    notes.push('event-global-clock: independent global events are not projected as clip events')
  const billboarded = model.bones.filter(bone => (bone.flags & 0x78) !== 0 && (bone.flags & 0x78) !== 0x8).length
  if (billboarded > 0) notes.push(`${String(billboarded)} axis-locked or mixed billboard bones are drawn unbillboarded`)
  const info: ModelSceneInfo = {
    scenes: 1,
    nodes: nodes.length,
    meshes: geometry?.meshes.length ?? 0,
    primitives: geometry?.primitives.length ?? 0,
    materials: geometry?.materials.length ?? 0,
    textures: textures.length,
    animations: clips.length,
    bounds: { min: model.boundsMin, max: model.boundsMax },
    upAxis: '+z',
    geometryAccess: geometry === undefined ? 'metadata-only' : 'decoded',
  }
  return {
    info,
    nodes,
    meshes: geometry?.meshes ?? [],
    primitives: geometry?.primitives ?? [],
    materials: geometry?.materials ?? [],
    skeleton,
    sockets,
    clips,
    textures,
    notes,
  }
}

/** Root, bones and attachments as scene nodes. */
function buildNodes(model: M2Model, parents: readonly number[]): ModelNode[] {
  const children = new Map<string, string[]>()
  const add = (parent: string, child: string) => children.set(parent, [...(children.get(parent) ?? []), child])
  parents.forEach((parent, index) => add(parent < 0 ? ROOT : boneNode(parent), boneNode(index)))
  model.attachments.forEach((attachment, index) =>
    add(attachment.bone < model.bones.length ? boneNode(attachment.bone) : ROOT, attachmentNode(index)),
  )
  const pivotOf = (index: number): Vec3 => (index < 0 ? [0, 0, 0] : model.bones[index]!.pivot)
  return [
    { id: ROOT, name: model.name || 'M2', childIds: children.get(ROOT) ?? [], meshIds: [], transform: IDENTITY },
    ...model.bones.map((bone, index): ModelNode => {
      const rest = minus(bone.pivot, pivotOf(parents[index]!))
      const billboard = (bone.flags & 0x78) === 0x8 ? { billboard: SPHERICAL_BILLBOARD } : {}
      return {
        id: boneNode(index),
        name: bone.keyBoneId >= 0 ? `Bone ${String(index)} (key ${String(bone.keyBoneId)})` : `Bone ${String(index)}`,
        childIds: children.get(boneNode(index)) ?? [],
        meshIds: [],
        transform: restMatrix(rest),
        trs: { translation: rest, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        ...billboard,
      }
    }),
    ...model.attachments.map((attachment, index): ModelNode => {
      const local = minus(attachment.position, pivotOf(attachment.bone < model.bones.length ? attachment.bone : -1))
      return {
        id: attachmentNode(index),
        name: ATTACHMENT_NAMES[attachment.id] ?? `Attachment ${String(attachment.id)}`,
        childIds: [],
        meshIds: [],
        transform: restMatrix(local),
        trs: { translation: local, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }
    }),
  ]
}

/** Submesh meshes, batch primitives and their materials from the first skin profile. */
function buildGeometry(
  model: M2Model,
  skin: M2Skin,
  notes: string[],
  replacements?: ReadonlyMap<number, string>,
): { meshes: ModelMesh[]; primitives: ModelPrimitive[]; materials: ModelMaterialRef[] } {
  const v = model.vertices
  const skinned = model.bones.length > 0
  const geometry = new Map<number, Omit<ModelPrimitive, 'id' | 'materialId'> | undefined>()
  const geometryOf = (submeshIndex: number): Omit<ModelPrimitive, 'id' | 'materialId'> | undefined => {
    if (geometry.has(submeshIndex)) return geometry.get(submeshIndex)
    const submesh = skin.submeshes[submeshIndex]
    let built: Omit<ModelPrimitive, 'id' | 'materialId'> | undefined
    if (
      submesh !== undefined &&
      submesh.vertexCount > 0 &&
      submesh.indexCount > 0 &&
      submesh.vertexStart + submesh.vertexCount <= skin.vertices.length &&
      submesh.indexStart + submesh.indexCount <= skin.indices.length
    ) {
      const count = submesh.vertexCount
      const positions = new Float32Array(count * 3)
      const normals = new Float32Array(count * 3)
      const uv0 = new Float32Array(count * 2)
      const uv1 = new Float32Array(count * 2)
      const boneIndices = new Uint32Array(count * 4)
      const boneWeights = new Float32Array(count * 4)
      let outOfRange = 0
      for (let local = 0; local < count; local += 1) {
        const global = skin.lodVertexBase + skin.vertices[submesh.vertexStart + local]!
        if (global >= v.count) {
          outOfRange += 1 // a zeroed vertex, as the client draws it
          continue
        }
        positions.set(v.positions.subarray(global * 3, global * 3 + 3), local * 3)
        normals.set(v.normals.subarray(global * 3, global * 3 + 3), local * 3)
        uv0.set(v.uv0.subarray(global * 2, global * 2 + 2), local * 2)
        uv1.set(v.uv1.subarray(global * 2, global * 2 + 2), local * 2)
        for (let k = 0; k < 4; k += 1) {
          const bone = v.boneIndices[global * 4 + k]!
          const weight = v.boneWeights[global * 4 + k]! / 255
          boneIndices[local * 4 + k] = bone < model.bones.length ? bone : 0
          boneWeights[local * 4 + k] = weight
        }
      }
      if (outOfRange > 0) notes.push(`submesh ${String(submeshIndex)}: ${String(outOfRange)} vertex indices outside the model`)
      const indices = new Uint32Array(submesh.indexCount)
      let bad = false
      for (let index = 0; index < submesh.indexCount; index += 1) {
        const local = skin.indices[submesh.indexStart + index]! - submesh.vertexStart
        if (local < 0 || local >= count) bad = true
        indices[index] = local < 0 || local >= count ? 0 : local
      }
      if (bad) notes.push(`submesh ${String(submeshIndex)}: triangle indices outside its vertices were clamped`)
      built = {
        topology: 'triangles',
        positions,
        normals,
        indices,
        textureCoordinates: uv0,
        textureCoordinateSets: [
          { set: 0, coordinates: uv0 },
          { set: 1, coordinates: uv1 },
        ],
        ...(skinned ? { boneIndices, boneWeights, hierarchyId: SKELETON } : {}),
      }
    } else if (submesh !== undefined && submesh.vertexCount > 0) {
      notes.push(`submesh ${String(submeshIndex)} runs past its skin and is not drawn`)
    }
    geometry.set(submeshIndex, built)
    return built
  }
  const meshes = new Map<number, string[]>()
  const primitives: ModelPrimitive[] = []
  const materials: ModelMaterialRef[] = []
  skin.batches.forEach((batch, batchIndex) => {
    const shape = geometryOf(batch.submesh)
    if (shape === undefined) return
    const id = `batch-${String(batchIndex)}`
    const materialId = `material-${String(batchIndex)}`
    primitives.push({ id, materialId, ...shape })
    materials.push(batchMaterial(model, batch, materialId, notes, replacements))
    meshes.set(batch.submesh, [...(meshes.get(batch.submesh) ?? []), id])
  })
  return {
    meshes: [...meshes].map(([submesh, primitiveIds]) => ({
      id: `submesh-${String(submesh)}`,
      name: `Submesh ${String(submesh)} (section ${String(skin.submeshes[submesh]!.sectionId)})`,
      primitiveIds,
    })),
    primitives,
    materials,
  }
}

/** One batch's material: blend, depth, sides, textures and its static colour. */
function batchMaterial(model: M2Model, batch: M2Skin['batches'][number], id: string, notes: string[],
  replacements?: ReadonlyMap<number, string>): ModelMaterialRef {
  const native = model.materials[batch.materialIndex] ?? { flags: 0, blend: 0 }
  const blend = BLENDS[native.blend] ?? BLENDS[0]!
  const layers: ModelMaterialLayerRef[] = []
  const gameChosen: number[] = []
  for (let k = 0; k < batch.textureCount; k += 1) {
    const textureIndex = model.textureCombos[batch.textureComboIndex + k]
    if (textureIndex === undefined) continue
    const resourceId = textureId(model, textureIndex, replacements)
    const coord = model.textureCoordCombos[batch.textureCoordComboIndex + k]
    if (resourceId === undefined) {
      gameChosen.push(model.textures[textureIndex]?.type ?? -1)
      continue
    }
    layers.push({
      slot: k === 0 ? 'diffuse' : `layer${String(k)}`,
      resourceId,
      ...(coord === 0 || coord === 1 ? { uvSource: coord } : {}),
      ...(coord === 0xffff ? { flagNames: ['environment-mapped'] } : {}),
    })
  }
  const color = batch.colorIndex >= 0 ? model.colors[batch.colorIndex] : undefined
  const weightIndex = model.textureWeightCombos[batch.textureWeightComboIndex]
  const weight = weightIndex === undefined || (batch.flags & 0x40) !== 0 ? 1 : restValue(model.textureWeights[weightIndex], 1)
  const rgb = restValue<Vec3>(color?.color, [1, 1, 1])
  const alpha = restValue(color?.alpha, 1) * weight
  const unlit = (native.flags & 0x1) !== 0 || native.blend === 5 || native.blend === 6
  const firstTexture = model.textureCombos[batch.textureComboIndex]
  const program = projectBatchMaterial(model, batch, firstTexture === undefined ? undefined : textureId(model, firstTexture, replacements),
    model.sequences.map((_, index) => dataSequence(model, index)))
  if (program === undefined) notes.push(`shader-profile: batch ${id} keeps the partial native shader; its combiner is not qualified`)
  return {
    id,
    name: `Batch ${String(batch.submesh)}.${String(batch.materialLayer)}`,
    type: 'wow-m2',
    blendMode: blend.name,
    alphaMode: blend.alphaMode,
    ...(blend.alphaMode === 'mask' ? { alphaCutoff: ALPHA_KEY_CUTOFF } : {}),
    doubleSided: (native.flags & 0x4) !== 0,
    depthWrite: (native.flags & 0x10) === 0,
    ...(unlit ? { unlit: true } : {}),
    baseColorFactor: [rgb[0], rgb[1], rgb[2], alpha],
    priority: batch.priorityPlane * 16 + batch.materialLayer,
    nativeFlags: native.flags,
    layers,
    shader: {
      id: program === undefined ? 'blizzard.wow-m2.batch' : 'modkit.render-material.v1',
      parameters: {
        ...(program === undefined ? {} : { renderModel: { version: 1, standard: program } as unknown as JsonValue }),
        ...(blend.blendMode === undefined ? {} : { blendMode: blend.blendMode }),
        nativeBlend: native.blend,
        materialFlags: native.flags,
        depthTest: (native.flags & 0x8) === 0,
        depthWrite: (native.flags & 0x10) === 0,
        shaderId: batch.shaderId,
        materialLayer: batch.materialLayer,
        priorityPlane: batch.priorityPlane,
        ...(gameChosen.length === 0 ? {} : { replaceableTextureTypes: gameChosen }),
      },
    },
  }
}

/** Which keyframe list sequence `sequence` reads from a track (the client's clamp to list 0). */
const listOf = <T>(track: M2Track<T>, sequence: number): M2Keys<T> | undefined =>
  track.globalSequence !== null
    ? track.perSequence[0]
    : track.perSequence[sequence < track.perSequence.length ? sequence : 0]

/** The sequence whose data an alias plays: follows `aliasNext` until a non-alias. */
function dataSequence(model: M2Model, index: number): number {
  let at = index
  for (let steps = 0; steps <= model.sequences.length; steps += 1) {
    const sequence = model.sequences[at]
    if (sequence === undefined || (sequence.flags & SEQUENCE_ALIAS) === 0) return at
    if (sequence.aliasNext >= model.sequences.length) throw new TypeError('M2 alias links outside its sequence table')
    at = sequence.aliasNext
  }
  throw new TypeError('M2 animation alias cycle')
}

/** One bone channel of a clip, or none when the track keys nothing for it. */
function channel(
  model: M2Model,
  target: string,
  kind: 'translation' | 'rotation' | 'scale',
  track: M2Track<Vec3> | M2Track<Quat>,
  sequence: number,
  offset: Vec3,
): ModelAnimationChannel[] {
  const keys = listOf<Vec3 | Quat>(track, sequence)
  if (keys === undefined || keys.times.length === 0) return []
  const loop = keys.globalPeriodMilliseconds ?? (track.globalSequence === null ? undefined : model.globalLoops[track.globalSequence])
  if (track.globalSequence !== null && loop === undefined) throw new TypeError('M2 channel names a missing global sequence')
  const nativeInterpolation = keys.interpolation ?? track.interpolation
  const interpolation =
    nativeInterpolation === 0 || loop === 0 ? 'step' : kind === 'rotation' ? 'spherical-linear' : 'linear'
  // runs of a held value keep only their ends (the shared rule): exported creatures hold most keys
  const samples = withoutHeldSamples(
    (loop === 0 ? [0] : keys.times).map((time, frame) => {
      const value = keys.values[frame]!
      return {
        frame,
        timeMilliseconds: time,
        timeSeconds: time / 1000,
        value: kind === 'translation' ? [value[0] + offset[0], value[1] + offset[1], value[2] + offset[2]] : [...value],
      }
    }),
  ).map((sample, frame) => ({ ...sample, frame }))
  return [
    {
      target,
      kind,
      firstFrame: 0,
      lastFrame: samples.length - 1,
      interpolation,
      ...(loop === undefined || loop === 0 ? {} : { concurrent: true, wrapSeconds: loop / 1000 }),
      samples,
    },
  ]
}

/** Clips: one per sequence, with bone channels and events. */
function buildClips(model: M2Model, parents: readonly number[], notes: string[]): ModelAnimationClip[] {
  const missing = new Set<number>()
  for (const bone of model.bones)
    for (const track of [bone.translation, bone.rotation, bone.scale]) for (const index of track.missing) missing.add(index)
  if (missing.size > 0) notes.push(`${String(missing.size)} sequences keep their keyframes in .anim files that were not read`)
  return model.sequences.map((sequence, index): ModelAnimationClip => {
    const data = dataSequence(model, index)
    const channels = model.bones.flatMap((bone, boneIndex) => {
      // Native CM2Model gate: untransformed/kinematic bones inherit the parent rather than keys.
      if ((bone.flags & 0x280) === 0 || (bone.flags & 0x400) !== 0) return []
      const parent = parents[boneIndex]!
      const rest = minus(bone.pivot, parent < 0 ? [0, 0, 0] : model.bones[parent]!.pivot)
      return [
        ...channel(model, boneNode(boneIndex), 'translation', bone.translation, data, rest),
        ...channel(model, boneNode(boneIndex), 'rotation', bone.rotation, data, [0, 0, 0]),
        ...channel(model, boneNode(boneIndex), 'scale', bone.scale, data, [0, 0, 0]),
      ]
    })
    const events = model.events.flatMap((event, eventIndex): ModelAnimationEvent[] => {
      const keys = listOf(event.times, data)
      if (keys === undefined || event.times.globalSequence !== null || keys.globalPeriodMilliseconds !== undefined) return []
      return keys.times.map(time => ({
        timeSeconds: time / 1000,
        name: event.identifier,
        ...(event.bone < model.bones.length ? { nodeId: boneNode(event.bone) } : {}),
        payload: { data: event.data, event: eventIndex, position: [...event.position] },
      }))
    }).sort((a, b) => a.timeSeconds - b.timeSeconds)
    const durationSeconds = sequence.duration / 1000
    return {
      id: clipId(index),
      name: `Animation ${String(sequence.id)}.${String(sequence.variation)}`,
      kind: 'animation',
      provenance: data === index && missing.has(index) ? 'companion' : 'direct',
      frames: Math.max(1, sequence.duration),
      frameRate: 1000,
      durationSeconds,
      sequenceIndex: index,
      looping: (sequence.flags & 1) === 0,
      loop: (sequence.flags & 1) === 0 ? 'loop' : 'once',
      ...(sequence.blendIn > 0 ? { blendInSeconds: sequence.blendIn / 1000 } : {}),
      ...(sequence.blendOut > 0 ? { blendOutSeconds: sequence.blendOut / 1000 } : {}),
      ...(sequence.moveSpeed > 0 ? { movementSpeed: sequence.moveSpeed } : {}),
      ...(events.length === 0 ? {} : { events }),
      hierarchyId: SKELETON,
      nativeTimeBounds: { startMilliseconds: 0, endMilliseconds: sequence.duration },
      channels,
    }
  })
}

/** The projection `model.export-uvm` materializes. */
export function m2Projection(scene: M2Scene): ModelProjection {
  return {
    info: scene.info,
    nodes: scene.nodes,
    // a metadata-only scene states no geometry at all: the materializer refuses empty arrays there
    ...(scene.info.geometryAccess === 'decoded'
      ? { meshes: scene.meshes, primitives: scene.primitives, materials: scene.materials }
      : {}),
    skeleton: scene.skeleton,
    animations: scene.clips,
    sockets: scene.sockets,
    resourceClosure: {
      mode: 'logical',
      entries: scene.textures.map(texture => ({ role: 'texture', logicalId: texture.id })),
    },
  }
}
