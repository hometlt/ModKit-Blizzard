import { M3_BILLBOARD } from '../skeleton-projection.js'

/**
 * What a fresh M3 needs of the common rig projection (`@modkit/scene/uvm/rig-model`) beyond bones
 * and tracks: M3 shows and hides a draw only through a bone, and turns a bone toward the camera
 * only through its own basis. Both are stated here in the projection the encoder reads.
 */
type Quaternion = readonly [number, number, number, number]
interface TrackKey {
  readonly frame: number
  readonly vector: readonly number[]
  readonly inTan?: readonly number[]
  readonly outTan?: readonly number[]
}
interface Track {
  readonly lineType: number
  readonly keys: readonly TrackKey[]
  readonly concurrent?: boolean
  readonly wrapSeconds?: number
}
interface NodeTracks {
  readonly boneIndex: number
  readonly rotation?: Track
  readonly [kind: string]: unknown
}
interface MeshTracks {
  readonly meshIndex: number
  readonly visibility: Track
}
interface Animation {
  readonly nodeTracks: readonly NodeTracks[]
  readonly meshTracks?: readonly MeshTracks[]
  readonly [field: string]: unknown
}
interface Bone {
  readonly index: number
  readonly name: string
  readonly parentIndex: number
  readonly inverseBindMatrix: readonly number[]
  readonly [field: string]: unknown
}
interface RestPose extends Bone {
  readonly translation: readonly number[]
  readonly rotation: readonly number[]
  readonly scale: readonly number[]
}
type Billboard =
  | { readonly boneIndex: number; readonly mode: 'inverse-camera'; readonly basisRotations: readonly Quaternion[] }
  | { readonly boneIndex: number; readonly mode: 'face-camera' }
  | { readonly boneIndex: number; readonly mode: 'aim' }
interface RigModel {
  readonly skeleton: { readonly bones: readonly Bone[]; readonly [field: string]: unknown }
  readonly meshes: readonly Readonly<Record<string, unknown>>[]
  readonly animations: readonly Animation[]
  readonly meshVisibility?: readonly { readonly meshIndex: number; readonly value: number }[]
  readonly [field: string]: unknown
}
export interface FreshRigProjection {
  readonly model: RigModel
  readonly restPoses: readonly RestPose[]
  readonly billboards?: readonly Billboard[]
  readonly [field: string]: unknown
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const

/**
 * M3 shows and hides a batch through the batching of the bone the batch names (BAT_.bone). A
 * region a clip shows or hides - a Warcraft III geoset its geoset animation fades out, a part kept
 * hidden until a clip shows it - gets a bone of its own at the model root, never skinned, whose
 * batching carries that visibility: shown while the source value is above zero, keyed as steps.
 * Its default is the region's rest visibility.
 */
export function withBatchVisibilityBones<T extends FreshRigProjection>(projected: T): T {
  const animations = projected.model.animations
  const restHidden = new Set(
    (projected.model.meshVisibility ?? []).filter(entry => entry.value <= 0).map(entry => entry.meshIndex),
  )
  const toggled = [
    ...new Set([
      ...restHidden,
      ...animations.flatMap(animation => (animation.meshTracks ?? []).map(track => track.meshIndex)),
    ]),
  ].sort((left, right) => left - right)
  const { meshVisibility: _visibility, ...model } = projected.model
  const plain = animations.map(({ meshTracks: _tracks, ...animation }) => animation)
  if (toggled.length === 0) return { ...projected, model: { ...model, animations: plain } }
  const bones = model.skeleton.bones
  if (bones.length + toggled.length > 0x7fff)
    throw new RangeError('fresh M3 batch visibility bones exceed the bone index range')
  if (toggled.some(meshIndex => !Number.isSafeInteger(meshIndex) || meshIndex < 0 || meshIndex >= model.meshes.length))
    throw new TypeError('fresh M3 batch visibility names no region')
  const boneOf = new Map(toggled.map((meshIndex, ordinal) => [meshIndex, bones.length + ordinal]))
  const toggle = (meshIndex: number) => ({
    index: boneOf.get(meshIndex)!,
    name: `Batch_Visibility_${meshIndex}`,
    parentIndex: -1,
    inverseBindMatrix: [...IDENTITY],
  })
  const shown = (value: readonly number[]) => ((value[0] ?? 0) > 0 ? 1 : 0)
  return {
    ...projected,
    model: {
      ...model,
      skeleton: {
        ...model.skeleton,
        bones: [
          ...bones,
          // As StarCraft II's own toggle bones (a building's Batch_Placement): real, batch1 and
          // batch2, nothing inherited or skinned.
          ...toggled.map(meshIndex => ({
            ...toggle(meshIndex),
            flags: 0xe000,
            batching: restHidden.has(meshIndex) ? 0 : 1,
          })),
        ],
      },
      meshes: model.meshes.map((mesh, meshIndex) =>
        boneOf.has(meshIndex) ? { ...mesh, visibilityBone: boneOf.get(meshIndex) } : mesh,
      ),
      animations: animations.map(({ meshTracks, ...animation }) => ({
        ...animation,
        nodeTracks: [
          ...animation.nodeTracks,
          ...(meshTracks ?? []).map(track => ({
            boneIndex: boneOf.get(track.meshIndex)!,
            visibility: {
              ...track.visibility,
              lineType: 0,
              keys: track.visibility.keys.map(key => ({ frame: key.frame, vector: [shown(key.vector)] })),
            },
          })),
        ],
      })),
    },
    restPoses: [
      ...projected.restPoses,
      ...toggled.map(meshIndex => ({
        ...toggle(meshIndex),
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      })),
    ],
  }
}

/** Hamilton product, left times right; not normalised, so it turns tangents as well as keys. */
function product(left: Quaternion, right: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = left
  const [bx = 0, by = 0, bz = 0, bw = 0] = right
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}
const conjugate = ([x, y, z, w]: Quaternion): Quaternion => [-x, -y, -z, w]
const basisOf = (rotations: readonly Quaternion[]): Quaternion =>
  rotations.reduce<Quaternion>((turned, rotation) => product(turned, rotation), [0, 0, 0, 1])

/**
 * The fresh encoder writes a y-up projection into StarCraft II's z-up frame by turning every bone,
 * vertex and camera by this rotation (+90 degrees about X: y to z, z to -y).
 */
const M3_FROM_Y_UP: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]

/**
 * A bone turned toward the camera takes camera * basis * its own rotation (mdx-m3-viewer), and
 * StarCraft II has one basis for it. A joint whose source states another - Warcraft III turns a
 * node's +X toward the viewer from a different start - keeps its drawn pose when its own rotation,
 * rest and every key, first turns by X = (B_m3 * P)^-1 * B, B being the source basis in the
 * projection's frame and P how the encoder turns that frame into the file's. An M3 source's basis
 * is StarCraft II's, X is the identity, and nothing is rewritten.
 */
export function withM3BillboardBasis<T extends FreshRigProjection>(projected: T, yUp: boolean): T {
  const turns = new Map<number, Quaternion>()
  for (const billboard of projected.billboards ?? []) {
    // An aim rule is StarCraft II's own BBSC record: it is written back as it was read.
    if (billboard.mode === 'aim') {
      if (yUp) throw new TypeError('fresh M3 writes an aim billboard only from an M3 source')
      continue
    }
    if (billboard.mode !== 'inverse-camera')
      throw new TypeError('fresh M3 supports only inverse-camera and aim billboards')
    const target = basisOf(M3_BILLBOARD.basisRotations)
    const turn = product(
      conjugate(yUp ? product(target, M3_FROM_Y_UP) : target),
      basisOf(billboard.basisRotations),
    )
    const length = Math.hypot(...turn)
    if (!(length > 0)) throw new TypeError('fresh M3 billboard basis is not a rotation')
    const unit = turn.map(value => value / length) as unknown as Quaternion
    if (Math.abs(unit[3]) < 1 - 1e-12) turns.set(billboard.boneIndex, unit)
  }
  if (turns.size === 0) return projected
  const turned = (turn: Quaternion, value: readonly number[]) => product(turn, value)
  return {
    ...projected,
    model: {
      ...projected.model,
      animations: projected.model.animations.map(animation => ({
        ...animation,
        nodeTracks: animation.nodeTracks.map(tracks => {
          const turn = turns.get(tracks.boneIndex)
          if (turn === undefined || tracks.rotation === undefined) return tracks
          return {
            ...tracks,
            rotation: {
              ...tracks.rotation,
              keys: tracks.rotation.keys.map(key => ({
                ...key,
                vector: turned(turn, key.vector),
                ...(key.inTan === undefined ? {} : { inTan: turned(turn, key.inTan) }),
                ...(key.outTan === undefined ? {} : { outTan: turned(turn, key.outTan) }),
              })),
            },
          }
        }),
      })),
    },
    restPoses: projected.restPoses.map(pose => {
      const turn = turns.get(pose.index)
      return turn === undefined ? pose : { ...pose, rotation: turned(turn, pose.rotation) }
    }),
  }
}
