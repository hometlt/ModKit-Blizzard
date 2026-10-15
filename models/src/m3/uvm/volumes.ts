import type { ModelCollisionShape, ModelCollisionVolume } from '@modkit/sdk'
import type { HitVolume } from '../../../dist/m3/native/types.js'

export interface M3AttachmentVolume extends HitVolume {
  readonly bone1: number
  readonly bone2: number
  readonly vertices: number
  readonly faces: number
  readonly mesh?: { readonly positions: Float32Array; readonly indices: Uint16Array }
}

/** The projection node of an M3 bone, refused when the projection has none. */
function boneNode(boneIndex: number, nodeIds: ReadonlySet<string>, label: string): string {
  const nodeId = `bone/${boneIndex}`
  if (!nodeIds.has(nodeId)) throw new TypeError(`${label} requires a UVM bone binding`)
  return nodeId
}

/** Format mapping only. ATVL shape 2 is a capsule, 3 a cylinder; cuboid sizes are half extents.
 * The old XML prose is stale. See SC2Mapster/m3addon shared.updateBoneShapeOfAttachmentPoint
 * and Solstice245/m3studio bl_enum.volume_shape / bl_graphics_draw.draw (2026-09-08).
 * Their implementation is not copied. Native matrices/values stay intact in BlizzardM3.
 * The materializer writes each volume as a child of its bone's node (`projection.collisions`).
 */
export function mapM3AttachmentVolumes(
  volumes: readonly M3AttachmentVolume[],
  nodeIds: ReadonlySet<string>,
): readonly ModelCollisionVolume[] {
  return volumes.map(volume => {
    if (volume.bone1 !== volume.boneIndex || volume.bone2 !== volume.boneIndex)
      throw new TypeError('M3 attachment volume requires an exact single-bone UVM binding')
    const nodeId = boneNode(volume.boneIndex, nodeIds, 'M3 attachment volume')
    if (volume.shape !== 4 && (volume.vertices !== 0 || volume.faces !== 0))
      throw new TypeError('analytic M3 attachment volume has unrepresented mesh data')
    const matrix = affineMatrix(volume.matrix4, 'M3 attachment volume')
    let shape: ModelCollisionShape | undefined = analyticShape(volume)
    if (volume.shape === 4) {
      const mesh = volume.mesh
      if (
        mesh === undefined ||
        volume.vertices <= 0 ||
        volume.faces <= 0 ||
        mesh.positions.length !== volume.vertices * 3 ||
        mesh.indices.length !== volume.faces ||
        volume.faces % 3 !== 0
      )
        throw new TypeError('M3 attachment mesh has no exact UVM geometry')
      for (const index of mesh.indices)
        if (index >= volume.vertices)
          throw new RangeError('M3 attachment mesh index exceeds its vertices')
      shape = { kind: 'mesh', positions: Float32Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices) }
    }
    if (shape === undefined) throw new TypeError(`unsupported M3 attachment volume shape ${volume.shape}`)
    return {
      id: `m3-attachment-volume-${volume.index}`,
      kind: `m3-shape-${volume.shape}`,
      origin: 'declared-volume',
      nodeId,
      // ATVL describes areas for attached effects (e.g. Target/Shield), not physics solids.
      role: 'effect',
      shape: { ...shape, matrix },
    }
  })
}

/** The analytic shapes both volume kinds share: box (half extents), sphere, capsule, cylinder. */
function analyticShape(volume: HitVolume): ModelCollisionShape | undefined {
  switch (volume.shape) {
    case 0:
      return { kind: 'box', size: [2 * volume.size0, 2 * volume.size1, 2 * volume.size2] }
    case 1:
      return { kind: 'sphere', radius: volume.size0 }
    case 2:
      return { kind: 'capsule', radius: volume.size0, height: volume.size1, axis: 'z' }
    case 3:
      return { kind: 'cylinder', radius: volume.size0, height: volume.size1, axis: 'z' }
    default:
      return undefined
  }
}

function affineMatrix(matrix: readonly number[], label: string): number[] {
  if (
    matrix.length !== 16 ||
    !matrix.every(Number.isFinite) ||
    [3, 7, 11].some(i => matrix[i] !== 0) ||
    matrix[15] !== 1
  )
    throw new TypeError(`${label} requires a finite affine matrix`)
  return [...matrix]
}

/**
 * M3 hit tests (SSGS): the volumes a click or a projectile tests, each on one bone. They are the
 * UV `hit` role — the one Warcraft III's collision shapes carry — so a fresh M3 writes them back.
 */
export function mapM3HitTests(
  hitTests: readonly HitVolume[],
  nodeIds: ReadonlySet<string>,
): readonly ModelCollisionVolume[] {
  return hitTests.map(hit => {
    const nodeId = boneNode(hit.boneIndex, nodeIds, 'M3 hit test')
    const shape = analyticShape(hit)
    if (shape === undefined) throw new TypeError(`unsupported M3 hit test shape ${hit.shape}`)
    const matrix = affineMatrix(hit.matrix4, 'M3 hit test')
    return {
      id: `m3-hittest-${hit.index}`,
      kind: `m3-shape-${hit.shape}`,
      origin: 'declared-volume',
      nodeId,
      role: 'hit',
      shape: { ...shape, matrix },
    }
  })
}
