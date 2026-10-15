/**
 * Diablo III appearance -> MK3 model facets.
 *
 * The decode is the ported implementation in `appearance.ts`; this module only restates its
 * `RenderModel` in the common facet vocabulary. Diablo stores three PRS records per bone, and the
 * parser already separated them: PRS2 is the parent-local default the nodes rest in (its chain is
 * PRS0, pose A), PRS4 the inverse bind of pose B the vertices are skinned in. Hardpoints become
 * socket nodes under their bones and collision capsules declared volumes on them (the parser stores
 * both relative to their bone's pose A); the bones' own collision shapes ride their bone nodes.
 */
import type {
  RenderMaterial,
  RenderMesh,
  RenderModel,
  RenderSequence,
} from '@modkit/codec-kit/legacy/models'
import { createModelSkeletonNodes } from '@modkit/codec-kit/model/skeleton'
import type { JsonValue } from '@modkit/sdk'
import type {
  Diablo3Attachment,
  Diablo3BoneShape,
  Diablo3Capsule,
  Diablo3ClipEvent,
  Diablo3RenderPass,
} from './appearance.js'

export const DIABLO3_ROOT_NODE_ID = 'model'

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

interface Diablo3Node {
  readonly index: number
  readonly name: string
  readonly parentIndex: number
  readonly translation: readonly [number, number, number]
  readonly rotation: readonly [number, number, number, number]
  readonly scaling: readonly [number, number, number]
  readonly inverseBindMatrix: readonly number[]
}

const triple = (value: unknown): readonly [number, number, number] | undefined =>
  Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
    ? [value[0] as number, value[1] as number, value[2] as number]
    : undefined

const quaternion = (value: unknown): readonly [number, number, number, number] | undefined =>
  Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(Number.isFinite)
    ? [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
    : undefined

/** The parser's own node records, read back without inventing a missing one. */
export function diablo3Nodes(model: RenderModel): readonly Diablo3Node[] {
  const raw = model.metadata?.['war3Nodes']
  if (!Array.isArray(raw)) return []
  const nodes: Diablo3Node[] = []
  for (const [ordinal, candidate] of raw.entries()) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const translation = triple(record['translation'])
    const rotation = quaternion(record['rotation'])
    const scaling = triple(record['scaling'])
    const inverseBindMatrix = record['inverseBindMatrix']
    if (translation === undefined || rotation === undefined || scaling === undefined) continue
    if (!Array.isArray(inverseBindMatrix) || inverseBindMatrix.length !== 16) continue
    const index = Number.isSafeInteger(record['index']) ? (record['index'] as number) : ordinal
    const parentIndex = Number.isSafeInteger(record['parentIndex'])
      ? (record['parentIndex'] as number)
      : -1
    nodes.push({
      index,
      name: typeof record['name'] === 'string' ? record['name'] : `Bone ${String(index)}`,
      parentIndex,
      translation,
      rotation,
      scaling,
      inverseBindMatrix: inverseBindMatrix as readonly number[],
    })
  }
  return nodes
}

const nodeId = (index: number): string => `bone-${String(index)}`
const meshId = (index: number): string => `mesh-${String(index)}`
const primitiveId = (index: number): string => `primitive-${String(index)}`
const materialId = (index: number): string => `material-${String(index)}`

const isMatrix = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.length === 16 && value.every(Number.isFinite)

/** The parser's hardpoints (`metadata.hardpoints`), dropping a record it could not have written. */
export function diablo3Hardpoints(model: RenderModel): readonly Diablo3Attachment[] {
  const raw = model.metadata?.['hardpoints']
  if (!Array.isArray(raw)) return []
  return raw.flatMap(record =>
    typeof record === 'object' &&
    record !== null &&
    typeof record.name === 'string' &&
    Number.isSafeInteger(record.parentIndex) &&
    isMatrix(record.matrix)
      ? [record as Diablo3Attachment]
      : [],
  )
}

/** The parser's collision capsules (`metadata.capsules`). */
export function diablo3Capsules(model: RenderModel): readonly Diablo3Capsule[] {
  const raw = model.metadata?.['capsules']
  if (!Array.isArray(raw)) return []
  return raw.flatMap(record =>
    typeof record === 'object' &&
    record !== null &&
    Number.isSafeInteger(record.parentIndex) &&
    isMatrix(record.matrix) &&
    Number.isFinite(record.radius) &&
    Number.isFinite(record.length)
      ? [record as Diablo3Capsule]
      : [],
  )
}

const hardpointNodeId = (index: number): string => `hardpoint-${String(index)}`
/** The node a hardpoint or capsule rides on: its bone's, or the model root. */
const attachmentParentId = (model: RenderModel, parentIndex: number): string =>
  parentIndex >= 0 && parentIndex < model.skeleton.bones.length ? nodeId(parentIndex) : DIABLO3_ROOT_NODE_ID

export function diablo3SceneNodes(model: RenderModel) {
  const bindings = diablo3SkeletonBindings(model)
  // Bone nodes come from the shared builder the UVM rig checks them against bit for bit; a matrix
  // composed here in float64 disagrees with its float32 one on any real rotation.
  const builtBoneNodes =
    bindings.length === 0 ? [] : createModelSkeletonNodes(bindings, DIABLO3_ROOT_NODE_ID)
  const roots = bindings.filter(bone => bone.parentBoneIndex === null).map(bone => bone.nodeId)
  // Every hardpoint is a node of its own under its bone (a bone often carries several, and a node
  // carries one socket), holding the hardpoint's transform relative to that bone's bind pose.
  const hardpoints = diablo3Hardpoints(model)
  const hardpointNodes = hardpoints.map((hardpoint, index) => ({
    id: hardpointNodeId(index),
    name: hardpoint.name === '' ? `Hardpoint ${String(index)}` : hardpoint.name,
    childIds: Object.freeze([]),
    meshIds: Object.freeze([]),
    transform: Object.freeze([...hardpoint.matrix]),
  }))
  const hardpointsOf = new Map<string, string[]>()
  hardpoints.forEach((hardpoint, index) => {
    const parent = attachmentParentId(model, hardpoint.parentIndex)
    hardpointsOf.set(parent, [...(hardpointsOf.get(parent) ?? []), hardpointNodeId(index)])
  })
  const boneNodes = builtBoneNodes.map(node =>
    hardpointsOf.has(node.id)
      ? { ...node, childIds: Object.freeze([...node.childIds, ...hardpointsOf.get(node.id)!]) }
      : node,
  )
  // A glTF node carries at most one mesh, so every submesh gets its own node under the root.
  const meshNodes = model.meshes.map((_mesh, index) => ({
    id: `mesh-node-${String(index)}`,
    name: `Submesh ${String(index)}`,
    childIds: Object.freeze([]),
    meshIds: Object.freeze([meshId(index)]),
    transform: IDENTITY,
  }))
  return [
    {
      id: DIABLO3_ROOT_NODE_ID,
      name: 'Diablo III appearance',
      childIds: Object.freeze([
        ...meshNodes.map(node => node.id),
        ...roots,
        ...(hardpointsOf.get(DIABLO3_ROOT_NODE_ID) ?? []),
      ]),
      meshIds: Object.freeze([]),
      transform: IDENTITY,
    },
    ...meshNodes,
    ...boneNodes,
    ...hardpointNodes,
  ]
}

/**
 * Hardpoints as sockets (`common.view/model-socket-source`, `UV_game_socket`). The native name is
 * kept: effect groups and scripts attach by it (`HP_rightWeapon`, `Default`). Only names that say
 * what they are narrow the role — weapon, shield and helm mounts are swappable equipment, the feet
 * touch the ground; the rest are plain attach points.
 */
export function diablo3Sockets(model: RenderModel) {
  return diablo3Hardpoints(model).map((hardpoint, index) => {
    const name = hardpoint.name.toLowerCase()
    const role = /weapon|shield|helm/u.test(name)
      ? 'hardpoint'
      : /foot/u.test(name)
        ? 'ground-contact'
        : 'attach'
    return {
      id: hardpointNodeId(index),
      nodeId: hardpointNodeId(index),
      role,
      ...(hardpoint.name === '' ? {} : { sourceName: hardpoint.name }),
    }
  })
}

/** The parser's bone collision shapes (`metadata.boneShapes`). */
export function diablo3BoneShapes(model: RenderModel): readonly Diablo3BoneShape[] {
  const raw = model.metadata?.['boneShapes']
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (record): record is Diablo3BoneShape =>
      typeof record === 'object' &&
      record !== null &&
      Number.isSafeInteger(record.boneIndex) &&
      (record.kind === 0 || record.kind === 1 || record.kind === 2),
  )
}

/**
 * The column-major matrix that carries local +z onto the segment a→b and the origin to its middle:
 * the frame of a capsule given by its two hemisphere centres.
 */
function segmentFrame(a: readonly number[], b: readonly number[]): number[] {
  const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const length = Math.hypot(d[0]!, d[1]!, d[2]!)
  const [x, y, z] = length > 0 ? d.map(v => v / length) : [0, 0, 1]
  // Rodrigues for the rotation of +z onto (x, y, z); the antiparallel case turns half about x.
  const k = z! > -1 + 1e-9 ? 1 / (1 + z!) : 0
  const columns =
    k === 0
      ? [1, 0, 0, 0, -1, 0, 0, 0, -1]
      : [1 - x! * x! * k, -x! * y! * k, -x!, -x! * y! * k, 1 - y! * y! * k, -y!, x!, y!, z!]
  return [
    ...columns.slice(0, 3), 0,
    ...columns.slice(3, 6), 0,
    ...columns.slice(6, 9), 0,
    (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2, 1,
  ]
}

/**
 * Collision volumes (`common.view/model-collision-source`, `UV_game_collision`).
 *
 * Structure capsules: a capsule's `height` is the length between its hemisphere centres — the
 * reading of the scene's collision overlay — along its local z; one of length 0 is a sphere.
 * Bone shapes: spheres, capsules between their two points and convex hulls of the cooked polytope's
 * vertices, all in their bone node's frame. Their types name the LOD (`lod-0` the full collider set,
 * `lod-1` the ragdoll proxy), `dynamic` when the bone gets mass at that LOD and `anchor` for the
 * kinematic anchor of a hanging rig.
 */
export function diablo3Collisions(model: RenderModel) {
  const capsules = diablo3Capsules(model).flatMap((capsule, index) =>
    capsule.radius > 0
      ? [
          {
            id: `capsule-${String(index)}`,
            kind: capsule.length > 0 ? 'capsule' : 'sphere',
            origin: 'declared-volume' as const,
            types: Object.freeze(['collision-capsule']),
            nodeId: attachmentParentId(model, capsule.parentIndex),
            role: 'physics' as const,
            shape:
              capsule.length > 0
                ? {
                    kind: 'capsule' as const,
                    radius: capsule.radius,
                    height: capsule.length,
                    axis: 'z' as const,
                    matrix: [...capsule.matrix],
                  }
                : { kind: 'sphere' as const, radius: capsule.radius, matrix: [...capsule.matrix] },
          },
        ]
      : [],
  )
  const shapes = diablo3BoneShapes(model)
  const dynamic = new Set(shapes.filter(shape => shape.density > 0).map(shape => `${String(shape.boneIndex)}/${String(shape.lod)}`))
  const boneShapes = shapes.map((shape, index) => {
    const types = Object.freeze([
      'bone-collision-shape',
      `lod-${String(shape.lod)}`,
      ...(dynamic.has(`${String(shape.boneIndex)}/${String(shape.lod)}`) ? ['dynamic'] : []),
      ...(shape.anchor ? ['anchor'] : []),
    ])
    const kind = shape.kind === 0 ? 'sphere' : shape.kind === 1 ? 'capsule' : 'convex-hull'
    return {
      id: `bone-shape-${String(index)}`,
      kind,
      origin: 'declared-volume' as const,
      types,
      nodeId: attachmentParentId(model, shape.boneIndex),
      role: 'physics' as const,
      shape:
        shape.kind === 0
          ? {
              kind: 'sphere' as const,
              radius: shape.radius,
              matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...shape.a, 1],
            }
          : shape.kind === 1
            ? {
                kind: 'capsule' as const,
                radius: shape.radius,
                height: Math.hypot(shape.b[0] - shape.a[0], shape.b[1] - shape.a[1], shape.b[2] - shape.a[2]),
                axis: 'z' as const,
                matrix: segmentFrame(shape.a, shape.b),
              }
            : { kind: 'convex-hull' as const, positions: Float32Array.from(shape.points ?? []) },
    }
  })
  return [...capsules, ...boneShapes]
}

export function diablo3SceneMeshes(model: RenderModel) {
  return model.meshes.map((mesh: RenderMesh, index: number) => ({
    id: meshId(index),
    name: mesh.name === '' ? `Submesh ${String(index)}` : mesh.name,
    primitiveIds: Object.freeze([primitiveId(index)]),
  }))
}

/** Whether a material samples a baked lightmap (texture type 2 on the second UV set). */
const lightmapOf = (material: RenderMaterial | undefined) =>
  material?.layers.find(layer => layer.label === 'lightmap' && layer.path !== '')

export function diablo3ScenePrimitives(model: RenderModel) {
  return model.meshes.map((mesh: RenderMesh, index: number) => {
    const material = model.materials[mesh.materialIndex]
    const lightmapped = mesh.uvs !== undefined && mesh.uvs1 !== undefined && lightmapOf(material) !== undefined
    return {
      id: primitiveId(index),
      topology: 'triangles' as const,
      positions: mesh.positions,
      indices: mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices),
      ...(mesh.normals === undefined ? {} : { normals: mesh.normals }),
      ...(mesh.uvs === undefined ? {} : { textureCoordinates: mesh.uvs }),
      ...(lightmapped
        ? {
            textureCoordinateSets: Object.freeze([
              Object.freeze({ set: 0, coordinates: mesh.uvs! }),
              Object.freeze({ set: 1, coordinates: mesh.uvs1! }),
            ]),
          }
        : {}),
      // RGB 1: the file's vertex RGB is a lighting or layer-weight term, only its alpha fades
      ...(mesh.colors === undefined ? {} : { colors: mesh.colors }),
      ...(mesh.boneIndices === undefined || mesh.boneWeights === undefined
        ? {}
        : {
            boneIndices: Uint32Array.from(mesh.boneIndices),
            boneWeights: mesh.boneWeights,
            hierarchyId: DIABLO3_ROOT_NODE_ID,
          }),
      ...(mesh.materialIndex >= 0 && mesh.materialIndex < model.materials.length
        ? { materialId: materialId(mesh.materialIndex) }
        : {}),
      // Another look's geometry, a physics proxy or an equipment tier the default look does not
      // wear: kept in the model, not drawn (the parser's hiddenReason says which).
      ...(mesh.metadata?.['defaultVisible'] === false ? { hidden: true as const } : {}),
    }
  })
}

/** The engine's blend factors a pass names (WhiteoutFlakes `d3_surface_table.h`, BSD-3-Clause). */
const BLEND_ZERO = 1
const BLEND_ONE = 2
const BLEND_SOURCE_COLOR = 3
const BLEND_DESTINATION_COLOR = 7
const ALPHA_GREATER = 5
const ALPHA_NOT_EQUAL = 6
const ALPHA_GREATER_EQUAL = 7

interface Diablo3Coverage {
  readonly alphaMode: 'opaque' | 'mask' | 'blend'
  readonly alphaCutoff?: number
  readonly blendMode: 'opaque' | 'alpha-test' | 'alpha-blend' | 'additive' | 'modulate' | 'modulate2x'
  /** `StandardMaterialModel.blendMode` (SC2 MAT_ table): 0 opaque, 1 blend, 3 additive, 4/5 modulate. */
  readonly standardBlend: number
  readonly alphaTestThreshold: number
}

/**
 * How a pass covers what is behind it, in glTF and render-material terms. An alpha test keeps texels
 * past its reference (foliage 192: 0.75) whether or not the pass also blends; a pass that blends
 * without writing depth, or blends past an alpha test at 0, is translucent; one that blends and writes
 * depth with no test (the `alphacomp` actor programs) draws as opaque.
 */
function coverageOf(pass: Diablo3RenderPass): Diablo3Coverage {
  const tested =
    pass.alphaTest &&
    [ALPHA_GREATER, ALPHA_NOT_EQUAL, ALPHA_GREATER_EQUAL].includes(pass.alphaFunc) &&
    pass.alphaRef > 0
  const threshold = tested
    ? Math.min(1, (pass.alphaRef + (pass.alphaFunc === ALPHA_GREATER_EQUAL ? 0 : 1)) / 255)
    : pass.alphaTest && pass.alphaFunc === ALPHA_GREATER
      ? 1 / 255
      : 0
  if (pass.blend && pass.blendDestination === BLEND_ONE)
    return { alphaMode: 'blend', blendMode: 'additive', standardBlend: 3, alphaTestThreshold: threshold }
  if (pass.blend && pass.blendSource === BLEND_DESTINATION_COLOR && pass.blendDestination === BLEND_ZERO)
    return { alphaMode: 'blend', blendMode: 'modulate', standardBlend: 4, alphaTestThreshold: threshold }
  if (pass.blend && pass.blendSource === BLEND_DESTINATION_COLOR && pass.blendDestination === BLEND_SOURCE_COLOR)
    return { alphaMode: 'blend', blendMode: 'modulate2x', standardBlend: 5, alphaTestThreshold: threshold }
  if (tested)
    return { alphaMode: 'mask', alphaCutoff: threshold, blendMode: 'alpha-test', standardBlend: 0, alphaTestThreshold: threshold }
  if (pass.blend && (!pass.depthWrite || pass.alphaTest))
    return { alphaMode: 'blend', blendMode: 'alpha-blend', standardBlend: 1, alphaTestThreshold: threshold }
  return { alphaMode: 'opaque', blendMode: 'opaque', standardBlend: 0, alphaTestThreshold: 0 }
}

/** The reflection programs draw water from their environment and refraction; type 1 is its normal map. */
const isWaterPass = (pass: Diablo3RenderPass | undefined) => pass?.effect.toLowerCase() === 'reflection.fx'
/**
 * No Modkit renderer has the water program, so water is drawn as a translucent tint faded by its
 * vertex alpha — a stand-in for the reflection, stated in the material's metadata.
 */
const WATER_TINT = Object.freeze([0.16, 0.27, 0.31, 0.75] as const)

/** The layer's slot for glTF readers: its type name, except a water program's type 1 (a normal map). */
const gltfSlot = (label: string, water: boolean): string => (water && label === 'diffuse' ? 'normal' : label)

/**
 * A texture entry's matrix as the render-material vocabulary's tiling and offset (SC2 scales about
 * the UV centre: uv' = (uv − ½ − offset)·tiling + ½, where the entry states uv' = uv·s + t), and its
 * scroll (UV per second, the entry's tAnimU/V) as an offset track over the time of the show.
 */
function uvTransformOf(layer: RenderMaterial['layers'][number]): Record<string, JsonValue> {
  const matrix = layer.metadata?.['uvTransform']
  const scroll = layer.metadata?.['uvScroll']
  if (!Array.isArray(matrix) || matrix.length !== 9) return {}
  const [su = 1, , , , sv = 1, , tu = 0, tv = 0] = matrix as readonly number[]
  const [vu = 0, vv = 0] = Array.isArray(scroll) ? (scroll as readonly number[]) : []
  if (su === 0 || sv === 0) return {}
  const offset = (t: number, s: number) => Math.fround((0.5 - t) / s - 0.5)
  const identity = su === 1 && sv === 1 && tu === 0 && tv === 0 && vu === 0 && vv === 0
  if (identity) return {}
  const horizon = 3600
  return {
    uvTiling: { value: [Math.fround(su), Math.fround(sv)] },
    uvOffset: {
      value: [offset(tu, su), offset(tv, sv)],
      ...(vu === 0 && vv === 0
        ? {}
        : {
            track: {
              lineType: 1,
              globalSeqId: null,
              keys: [
                { frame: 0, vector: [offset(tu, su), offset(tv, sv)] },
                { frame: horizon, vector: [offset(tu + vu * horizon, su), offset(tv + vv * horizon, sv)] },
              ],
            },
          }),
    },
  }
}

const standardLayer = (slot: string, texturePath: string | null, uvSource: number, extra: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
  slot,
  texturePath,
  uvSource,
  // RGBA, added onto the black start: the texel is the colour (as the Warcraft III projection states it)
  channels: 1,
  op: 6,
  teamColorMode: 0,
  invert: false,
  clampResult: false,
  wrapX: true,
  wrapY: true,
  ...extra,
})

export function diablo3Materials(model: RenderModel) {
  // a material fades by vertex alpha when every mesh drawing it carries one
  const fading = new Set<number>()
  for (const [materialIndex] of model.materials.entries()) {
    const users = model.meshes.filter(mesh => mesh.materialIndex === materialIndex)
    if (users.length > 0 && users.every(mesh => mesh.colors !== undefined)) fading.add(materialIndex)
  }
  return model.materials.map((material: RenderMaterial, index: number) => {
    const pass = material.metadata?.['renderPass'] as Diablo3RenderPass | undefined
    const water = isWaterPass(pass)
    const layers = material.layers.map(layer => ({
      slot: gltfSlot(layer.label.trim().toLowerCase() || 'diffuse', water),
      ...(layer.path === '' ? {} : { resourceId: layer.path }),
      ...(layer.label === 'lightmap' ? { uvSource: 1 } : {}),
    }))
    const base = {
      id: materialId(index),
      name: material.name === '' ? `Material ${String(index)}` : material.name,
      layers,
    }
    if (pass === undefined) return base
    const coverage = coverageOf(pass)
    // A pass's stages name the texture types it samples (2 lightmap, 6 glow): a material may list a
    // texture its program never reads, as the ghost's additive Legacy pass (stages 1, 0) lists a glow.
    const sampled = (layer: RenderMaterial['layers'][number] | undefined) =>
      layer !== undefined && (pass.stages.length === 0 || pass.stages.includes(Number(layer.metadata?.['slot'])))
    const diffuse = material.layers.find(layer => layer.label === 'diffuse' && layer.path !== '')
    const lightmap = sampled(lightmapOf(material)) ? lightmapOf(material) : undefined
    const glow = material.layers.find(layer => layer.label === 'emissive' && layer.path !== '' && sampled(layer))
    // Normal, gloss and environment are read as the `ActorIrrad.fx` programs (actors, cloth) use them,
    // checked against their compiled ps_3_0; Scene.fx and Prop.fx project their environment and
    // light it by vertex and shadow, which the render-material vocabulary does not state.
    const actorProgram = pass.effect.toLowerCase() === 'actorirrad.fx'
    const bound = (label: string) =>
      actorProgram ? material.layers.find(layer => layer.label === label && layer.path !== '' && sampled(layer)) : undefined
    const normal = bound('normal')
    const environment = bound('environment')
    const gloss = environment === undefined ? undefined : bound('specular')
    const standardLayers: Record<string, JsonValue> = {
      diffuse: water
        ? standardLayer('diffuse', null, 0, { constantColor: { value: WATER_TINT } })
        : diffuse === undefined
          ? standardLayer('diffuse', null, 0, { constantColor: { value: [...(material.baseColor ?? [0.7, 0.7, 0.7, 1])] } })
          : standardLayer('diffuse', diffuse.path, 0, uvTransformOf(diffuse)),
      ...(lightmap === undefined ? {} : { lightMap: standardLayer('lightMap', lightmap.path, 1) }),
      ...(glow === undefined ? {} : { emissive1: standardLayer('emissive1', glow.path, 0, { op: 2, ...uvTransformOf(glow) }) }),
      ...(normal === undefined ? {} : { normal: standardLayer('normal', normal.path, 0, uvTransformOf(normal)) }),
      ...(environment === undefined
        ? {}
        : { envi: standardLayer('envi', environment.path, 3, { channels: 0, op: 2 }) }),
      ...(gloss === undefined ? {} : { enviMask: standardLayer('enviMask', gloss.path, 0, { channels: 0, ...uvTransformOf(gloss) }) }),
    }
    const blend = water && coverage.alphaMode === 'opaque' ? { ...coverage, alphaMode: 'blend' as const, blendMode: 'alpha-blend' as const, standardBlend: 1 } : coverage
    const standard = {
      layers: standardLayers,
      blendMode: blend.standardBlend,
      priority: 0,
      specularity: 0,
      specMult: 0,
      emisMult: glow === undefined ? 0 : 1,
      specMode: 0,
      alphaTestThreshold: blend.alphaTestThreshold,
      // drawn two-sided like the MK2 reference viewer; the pass's own cull stays in metadata
      twoSided: true,
      unshaded: false,
      doubleLambert: false,
      clampOutput: true,
      usesVertexColor: false,
      // an opaque pass ignores the vertex alpha (many opaque meshes leave it at 0)
      usesVertexAlpha: fading.has(index) && blend.alphaMode !== 'opaque',
      // actor2 `_bump` programs: texld normalMap; *2-1 — a full RGB vector in the vertex's explicit frame
      ...(normal === undefined ? {} : { normalMapFormat: 'rgb8', normalMapSpace: 'tangent' }),
      // actor2 `_gloss` programs add environment(reflection) * gloss * (0.5 + 0.5 * point-light Phong):
      // the only highlight they draw, so `specularity` stays 0
      ...(environment === undefined ? {} : { environmentMultipliers: [0.5, 0, 0.5] }),
    }
    return {
      ...base,
      alphaMode: blend.alphaMode,
      ...(blend.alphaCutoff === undefined ? {} : { alphaCutoff: blend.alphaCutoff }),
      blendMode: blend.blendMode,
      shader: {
        id: 'modkit.render-material.v1',
        parameters: {
          renderModel: {
            version: 1,
            // the textures the program draws, by its slots (as Warcraft III states them): a target
            // writer carries each into its own layer, so the unbound ones (environment, looks'
            // overlays) stay in the material's layer list only
            layers: Object.entries(standardLayers).flatMap(([slot, layer]) => {
              const path = (layer as { texturePath?: unknown }).texturePath
              return typeof path === 'string' ? [{ label: slot, path }] : []
            }),
            standard,
            metadata: {
              source: 'diablo3',
              shader: pass.shader,
              effect: pass.effect,
              pixelEntry: pass.pixelEntry,
              cull: pass.cull,
              depthWrite: pass.depthWrite,
              alphaTest: pass.alphaTest,
              alphaFunc: pass.alphaFunc,
              alphaRef: pass.alphaRef,
              blend: pass.blend,
              blendSource: pass.blendSource,
              blendDestination: pass.blendDestination,
              stages: [...pass.stages],
              ...(water ? { presentation: 'water-tint-stand-in' } : {}),
              // the game indexes its 2D environment map by the reflection's world-horizontal axes
              // (Z up: uv = R.xy * -0.5 + 0.5); the render-material vocabulary's sphere is in view space
              ...(environment === undefined ? {} : { environmentProjection: 'world-z-up-reflection-sphere' }),
            },
          },
        },
      },
    }
  })
}

export function diablo3ResourceReferences(model: RenderModel) {
  const seen = new Set<string>()
  const references: { id: string; role: 'texture'; provenance: 'reference-only' }[] = []
  for (const material of model.materials)
    for (const layer of material.layers) {
      if (layer.path === '' || seen.has(layer.path)) continue
      seen.add(layer.path)
      references.push({ id: layer.path, role: 'texture', provenance: 'reference-only' })
    }
  return references
}

export function diablo3SkeletonBindings(model: RenderModel) {
  const nodes = diablo3Nodes(model)
  const known = new Set(nodes.map(node => node.index))
  return nodes.map(node => ({
    partId: DIABLO3_ROOT_NODE_ID,
    boneIndex: node.index,
    boneName: node.name === '' ? null : node.name,
    provenance: 'direct' as const,
    hierarchyId: DIABLO3_ROOT_NODE_ID,
    parentBoneIndex: node.parentIndex >= 0 && known.has(node.parentIndex) ? node.parentIndex : null,
    nodeId: nodeId(node.index),
    // PRS2, the parent-local default the appearance itself declares.
    localPose: { translation: node.translation, rotation: node.rotation, scale: node.scaling },
    // PRS4, the inverse of pose B the vertices are skinned in.
    inverseBindMatrix: node.inverseBindMatrix,
  }))
}

/**
 * One clip's bone tracks as TRS channels of the bone nodes, keyed in seconds.
 *
 * The attach fills a bone the clip does not move with a single key of its rest pose; that key
 * states nothing and is left out, so a clip carries only the bones it animates. ANI keys are
 * linear, so rotations are spherical-linear as glTF samples them; an ANI quaternion is stored
 * compressed and decodes only near unit length, so it is normalised, and a key that does not
 * advance the float32 clock is dropped — glTF samples neither.
 */
function diablo3Channels(model: RenderModel, animation: RenderSequence) {
  const rest = new Map(diablo3Nodes(model).map(node => [node.index, node]))
  return animation.nodeTracks.flatMap(set => {
    const node = rest.get(set.boneIndex)
    if (node === undefined) return []
    return (['translation', 'rotation', 'scale'] as const).flatMap(kind => {
      let previous = -Infinity
      const keys = (set[kind]?.keys ?? []).filter(key => {
        const advances = Math.fround(key.frame) > previous
        if (advances) previous = Math.fround(key.frame)
        return advances
      })
      const resting = kind === 'scale' ? node.scaling : node[kind]
      if (keys.length === 0 || (keys.length === 1 && keys[0]!.vector.every((value, at) => value === resting[at])))
        return []
      return [
        {
          target: nodeId(node.index),
          kind,
          firstFrame: 0,
          lastFrame: keys.length - 1,
          interpolation: kind === 'rotation' ? ('spherical-linear' as const) : ('linear' as const),
          samples: keys.map((key, frame) => {
            const length = kind === 'rotation' ? Math.hypot(...key.vector) : 1
            // stated in float32 already: glTF stores nothing finer, and a rounded key is a note per channel
            return {
              frame,
              timeSeconds: Math.fround(key.frame),
              value: key.vector.map(value => Math.fround(value / length)),
            }
          }),
        },
      ]
    })
  })
}

/**
 * The clips, with their channels only when asked: the UVM export samples them, while the facet
 * publishes the clip list — every sample of a boss's sets (x1_malthael) would not fit the subject's
 * JSON snapshot.
 */
/**
 * SNO groups an event spawns (the executable registry's group numbers), named as the event says
 * what it does (SPEC_UVM §12.3): `sound`, `spawn_effect`, `spawn_object`; the explosion, camera
 * shake and controller vibration have no registered name and keep their own.
 */
const EVENT_GROUPS: Readonly<Record<number, { readonly extension: string; readonly name: string }>> = {
  1: { extension: '.acr', name: 'spawn_object' },
  5: { extension: '.ams', name: 'sound' },
  14: { extension: '.efg', name: 'spawn_effect' },
  17: { extension: '.xpl', name: 'explosion' },
  23: { extension: '.lit', name: 'spawn_effect' },
  27: { extension: '.prt', name: 'spawn_effect' },
  32: { extension: '.rop', name: 'spawn_effect' },
  38: { extension: '.shk', name: 'camera_shake' },
  40: { extension: '.snd', name: 'sound' },
  45: { extension: '.trl', name: 'spawn_effect' },
  68: { extension: '.vib', name: 'vibration' },
}

const isClipEvent = (value: unknown): value is Diablo3ClipEvent =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as Diablo3ClipEvent).frame) &&
  Array.isArray((value as Diablo3ClipEvent).hardpoints)

/**
 * A clip's events in seconds (the file counts frames), at the socket of the first hardpoint they
 * name when the appearance has it. What an event spawns is its SNO, kept as data; a look switch is
 * `swap_variant` with the look's name. An event naming neither — the game's own markers (an
 * attack's hit frames among them) — keeps its native kind and flags as `trigger`.
 */
function diablo3ClipEvents(model: RenderModel, animation: RenderModel['animations'][number]) {
  const raw = animation.metadata?.['events']
  const fps = Number(animation.metadata?.['fps'])
  if (!Array.isArray(raw) || !(fps > 0)) return []
  const socketOf = new Map(diablo3Hardpoints(model).map((hardpoint, index) => [hardpoint.name.toLowerCase(), hardpointNodeId(index)]))
  return raw.filter(isClipEvent).flatMap(event => {
    const timeSeconds = event.frame / fps
    const nodeId = event.hardpoints.map(name => socketOf.get(name.toLowerCase())).find(id => id !== undefined)
    const node = nodeId === undefined ? {} : { nodeId }
    const place = event.hardpoints.length === 0 ? {} : { hardpoints: [...event.hardpoints] }
    const spawned = event.snoId > 0 ? EVENT_GROUPS[event.snoGroup] : undefined
    const records: { timeSeconds: number; name: string; nodeId?: string; payload: Record<string, JsonValue> }[] = []
    if (event.snoId > 0)
      records.push({
        timeSeconds,
        name: spawned?.name ?? 'spawn',
        ...node,
        payload: { sno: event.snoId, snoGroup: event.snoGroup, ...(spawned === undefined ? {} : { group: spawned.extension }), ...place },
      })
    if (event.look !== undefined)
      records.push({ timeSeconds, name: 'swap_variant', ...node, payload: { look: event.look, ...place } })
    if (records.length === 0)
      records.push({
        timeSeconds,
        name: 'trigger',
        ...node,
        payload: { kind: event.kind, flags: event.flags, ...place },
      })
    return records
  }).sort((left, right) => left.timeSeconds - right.timeSeconds)
}

export function diablo3AnimationClips(model: RenderModel, withChannels = false) {
  return model.animations.map((animation, index) => {
    const events = diablo3ClipEvents(model, animation)
    return {
      id: `diablo3-clip-${String(index)}`,
      name: animation.name === '' ? `Clip ${String(index)}` : animation.name,
      kind: 'animation' as const,
      provenance: 'companion' as const,
      frames: Math.max(0, Math.round((animation.endFrame ?? 0) - (animation.startFrame ?? 0))),
      durationSeconds: animation.durationSeconds,
      sequenceIndex: index,
      hierarchyId: DIABLO3_ROOT_NODE_ID,
      ...(events.length === 0 ? {} : { events }),
      // the attach adds sequences; a clip without bone tracks has nothing to play
      ...('nodeTracks' in animation
        ? {
            looping: (animation as RenderSequence).looping,
            channels: withChannels ? diablo3Channels(model, animation as RenderSequence) : [],
          }
        : { channels: [] }),
    }
  })
}

export function diablo3SceneInfo(model: RenderModel, textures: number) {
  const bounds = model.bounds
  return {
    scenes: 1,
    nodes: diablo3Nodes(model).length + model.meshes.length + 1,
    meshes: model.meshes.length,
    primitives: model.meshes.length,
    materials: model.materials.length,
    textures,
    animations: model.animations.length,
    ...(bounds === undefined || bounds === null
      ? {}
      : {
          bounds: {
            min: [bounds.min.x, bounds.min.y, bounds.min.z] as const,
            max: [bounds.max.x, bounds.max.y, bounds.max.z] as const,
          },
        }),
    // StarCraft II, Warcraft III and Diablo III all publish z-up geometry; a viewer that
    // assumed the glTF default would lay the model on its side.
    upAxis: '+z' as const,
    geometryAccess: 'decoded' as const,
  }
}
