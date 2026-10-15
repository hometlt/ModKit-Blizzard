import type {
  ModelBoneBinding,
  ModelBoneLocalPose,
  ModelNode,
  ModelNodeBillboard,
  ModelPrimitive,
  ResourceBudget,
} from '@modkit/sdk'
import { createModelSkeletonNodes, snapshotModelSkeleton } from '@modkit/codec-kit/model/skeleton'
import { parseAnimationReference } from '../../dist/m3/native/animation/evaluator.js'
import type { M3StructureData } from '../../dist/m3/native/types.js'

const HIERARCHY_ID = 'm3/bone-table'

/**
 * A billboard bone's camera rule (BONE flag 0x10, the pinned billboard1): mdx-m3-viewer's
 * `m3/node.ts` convertBasis — rotateZ(π/2), then rotateY(-π/2) — which turns the bone's +X toward
 * the viewer. Scene nodes state it (`ModelNode.billboard`) and `uvm/billboards.ts` writes the same.
 */
export const M3_BILLBOARD = Object.freeze({
  mode: 'inverse-camera' as const,
  // Pinned quatFromAxisAngle: sin(π/4) and cos(π/4) differ in the last bit, and the writer and its
  // tests compare the basis exactly.
  basisRotations: Object.freeze([
    Object.freeze([0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] as const),
    Object.freeze([0, -Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as const),
  ]),
})
type Quaternion = readonly [number, number, number, number]
/** The `aim` camera rule of a BBSC record. */
type M3AimBillboard = Extract<ModelNodeBillboard, { readonly mode: 'aim' }>

/** One BBSC record as read: its bone, `billboard_type`, `camera_look_at` and correction quaternions. */
export interface M3BillboardBehaviour {
  readonly bone: number
  readonly type: number
  readonly cameraLookAt: boolean
  readonly up?: Quaternion
  readonly forward?: Quaternion
}

/** BBSC billboard types by the lock they build (CBBSolver::ApplyBillboard, as WhiteoutFlakes
 * reads it): 0/1/2 lock the world X/Y/Z, 3/5 the bone's own X/Y, 6 is free. Type 4 is parsed and
 * never applied by the engine. */
const BBSC_LOCKS: Readonly<Record<number, M3AimBillboard['lock']>> = {
  0: 'frame-x',
  1: 'frame-y',
  2: 'frame-z',
  3: 'own-x',
  5: 'own-y',
  6: 'free',
}

// Stored corrections are float32: the identity reads back as w = 0.99999988.
const isIdentity = (q: Quaternion | undefined) =>
  q === undefined ||
  (Math.abs(q[0]) < 1e-5 && Math.abs(q[1]) < 1e-5 && Math.abs(q[2]) < 1e-5 && Math.abs(Math.abs(q[3]) - 1) < 1e-5)
const usable = (q: Quaternion | undefined) =>
  q !== undefined && q.every(Number.isFinite) && Math.hypot(...q) > 0 && !isIdentity(q)

/**
 * The camera rule of one BBSC record. The engine composes the axis-locked types' `up` on every
 * bone, the free type's `forward` only on a bone with a bone parent, and neither on types 3/5.
 */
export function m3AimBillboard(record: M3BillboardBehaviour): M3AimBillboard | undefined {
  const lock = BBSC_LOCKS[record.type]
  if (lock === undefined) return undefined
  const aim = record.cameraLookAt ? ('eye' as const) : ('view' as const)
  if (record.type <= 2 && usable(record.up))
    return { mode: 'aim', aim, lock, correction: record.up!, rootCorrection: record.up! }
  if (record.type === 6 && usable(record.forward))
    return { mode: 'aim', aim, lock, correction: record.forward! }
  return { mode: 'aim', aim, lock }
}
type Budget = Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>
const jsonBudget = (budget: Budget) => ({
  maxDepth: budget.maxDepth,
  maxNodes: budget.maxNodes,
  maxBytes: budget.maxScalarBytes,
})

/** Only the boundary is new: default values come from the frozen animation-reference parser. */
export function projectM3SkeletonBindings(
  sourceBones: readonly M3StructureData[],
  bindings: readonly ModelBoneBinding[],
  budget: Budget,
  signal?: AbortSignal,
  behaviours: readonly M3BillboardBehaviour[] = [],
): {
  readonly bindings: readonly ModelBoneBinding[]
  readonly sceneNodes: readonly ModelNode[]
  readonly rejectedLocalPoses: number
} {
  if (sourceBones.length !== bindings.length)
    throw new TypeError('M3 bone projection count differs')
  let rejectedLocalPoses = 0
  const projected = bindings.map((binding, index): ModelBoneBinding => {
    const source = sourceBones[index]!
    const translation = parseAnimationReference(
      source['location'] as M3StructureData | undefined,
    )?.initValue
    const rotation = parseAnimationReference(
      source['rotation'] as M3StructureData | undefined,
    )?.initValue
    const scale = parseAnimationReference(source['scale'] as M3StructureData | undefined)?.initValue
    const valid = (
      value: readonly number[] | undefined,
      size: number,
    ): value is readonly number[] =>
      value !== undefined && value.length === size && value.every(Number.isFinite)
    const localPose: ModelBoneLocalPose | undefined =
      valid(translation, 3) && valid(rotation, 4) && valid(scale, 3)
        ? {
            translation: [translation[0]!, translation[1]!, translation[2]!],
            rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
            scale: [scale[0]!, scale[1]!, scale[2]!],
          }
        : undefined
    if (localPose === undefined) rejectedLocalPoses++
    return {
      ...binding,
      ...(localPose === undefined ? {} : { localPose }),
      // The compatibility field is retained; the new field explicitly declares IREF semantics.
      ...(binding.restMatrix === undefined ? {} : { inverseBindMatrix: binding.restMatrix }),
    }
  })
  const complete =
    projected.length > 0 &&
    rejectedLocalPoses === 0 &&
    projected.every(bone => bone.hierarchyId === HIERARCHY_ID && bone.parentBoneIndex !== undefined)
  const owned = snapshotModelSkeleton(
    projected.map(bone => ({ ...bone, ...(complete ? { nodeId: `bone/${bone.boneIndex}` } : {}) })),
    jsonBudget(budget),
    signal,
  )
  // A billboard bone faces the camera wherever the scene is drawn: the viewer reads the rule from
  // the node, the materializer writes it as UV_node_billboard.
  // BBSC records are what the game billboards by (WhiteoutFlakes: no bone of the 51 469 files sets
  // BONE 0x10); the first record of a bone wins, a BONE flag is the fallback.
  const aimed = new Map<string, M3AimBillboard>()
  for (const record of behaviours) {
    const nodeId = owned.find(bone => bone.boneIndex === record.bone)?.nodeId
    const billboard = m3AimBillboard(record)
    if (nodeId !== undefined && billboard !== undefined && !aimed.has(nodeId)) aimed.set(nodeId, billboard)
  }
  const billboarded = new Set(
    owned.flatMap(bone => (((bone.nativeFlags ?? 0) & 0x10) !== 0 && bone.nodeId !== undefined ? [bone.nodeId] : [])),
  )
  return {
    bindings: owned,
    sceneNodes: complete
      ? createModelSkeletonNodes(owned, HIERARCHY_ID, jsonBudget(budget), signal).map(
          (node): ModelNode => {
            const aim = aimed.get(node.id)
            if (aim !== undefined) return { ...node, billboard: aim }
            return billboarded.has(node.id) ? { ...node, billboard: M3_BILLBOARD } : node
          },
        )
      : [],
    rejectedLocalPoses,
  }
}

/** Join decoded model-space vertices to the same exact hierarchy used by scene nodes and clips. */
export function projectM3SkinBindings<
  T extends {
    readonly nodes: readonly ModelNode[]
    readonly primitives: readonly ModelPrimitive[]
  },
>(
  geometry: T,
  bindings: readonly ModelBoneBinding[],
  sceneNodes: readonly ModelNode[],
  budget: Budget,
  signal?: AbortSignal,
): { readonly geometry: T; readonly rejected: number } {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  if (geometry.nodes.length + sceneNodes.length > budget.maxNodes)
    throw new RangeError('M3 scene nodes exceed maxNodes')
  const indices = new Set(
    bindings
      .filter(bone => bone.nodeId !== undefined && bone.hierarchyId === HIERARCHY_ID)
      .map(bone => bone.boneIndex),
  )
  let rejected = 0
  const primitives = geometry.primitives.map(primitive => {
    if (primitive.boneIndices === undefined && primitive.boneWeights === undefined) return primitive
    const valid =
      sceneNodes.length > 0 &&
      primitive.boneIndices !== undefined &&
      primitive.boneWeights !== undefined &&
      primitive.boneIndices.length === (primitive.positions.length / 3) * 4 &&
      primitive.boneWeights.length === primitive.boneIndices.length &&
      primitive.boneIndices.every(index => indices.has(index))
    if (!valid) {
      rejected++
      const { hierarchyId: _unboundHierarchy, ...unbound } = primitive
      return unbound
    }
    return { ...primitive, hierarchyId: HIERARCHY_ID }
  })
  return {
    geometry: { ...geometry, nodes: [...geometry.nodes, ...sceneNodes], primitives },
    rejected,
  }
}
