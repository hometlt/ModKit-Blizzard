import type {
  JsonObject,
  MaterializationDiffEntry,
  ModelCollisionShape,
  ModelCollisionVolume,
} from '@modkit/sdk'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { RigidBodyInfo, RigidBodyShapeInfo } from '../../../dist/m3/native/types.js'

export type M3RigidShapeGeometry = {
  readonly positions: readonly (readonly [number, number, number])[]
  readonly source: JsonObject
} & (
  { readonly kind: 'mesh'; readonly indices: readonly number[] } | { readonly kind: 'convex-hull' }
)

export type M3RigidBodyShape = Readonly<
  Omit<RigidBodyShapeInfo, 'matrix4' | 'size' | 'vertices'>
> & {
  readonly matrix4: readonly number[]
  readonly size: readonly [number, number, number]
  readonly vertices: readonly (readonly [number, number, number])[]
  readonly geometry?: M3RigidShapeGeometry
  /** One reference-free PHSH v3 record, never an enclosing native file. */
  readonly nativeRecord?: { readonly version: 3; readonly bytes: readonly number[] }
}
export type M3RigidBody = Readonly<Omit<RigidBodyInfo, 'shapes'>> & {
  readonly shapes: readonly M3RigidBodyShape[]
}

/** Native PHSH semantic mapping, not a physics engine. Body filtering matches the frozen M3
 * RenderModel facade. Unlike ATVL, PHSH boxes carry full extents and axial shapes use local Y.
 * The native adapter supplies versioned mesh geometry. Unprojected descriptors retain an explicit loss.
 * The volumes go to `projection.collisions`; the materializer writes each under its bone's node.
 */
export function m3RigidBodyCollisions(
  input: readonly M3RigidBody[] | undefined,
  nodeIds: ReadonlySet<string>,
  budget: { readonly maxDepth: number; readonly maxNodes: number; readonly maxJsonBytes: number; readonly maxScalarBytes: number },
  signal?: AbortSignal,
) {
  const owned = snapshotJson(
    input ?? [],
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: Math.min(budget.maxJsonBytes, budget.maxScalarBytes),
    },
    signal,
  ) as unknown as readonly M3RigidBody[]
  if (!Array.isArray(owned)) throw new TypeError('M3 rigid bodies must be an array')
  const volumes: ModelCollisionVolume[] = []
  const warnings: string[] = []
  const losses: MaterializationDiffEntry[] = []
  const residualShapes: { bodyIndex: number; boneIndex: number; shape: M3RigidBodyShape }[] = []
  let hullBytes = 0
  const bodyIds = new Set<number>()
  for (const body of owned) {
    signal?.throwIfAborted()
    if (
      !Number.isSafeInteger(body.index) ||
      body.index < 0 ||
      bodyIds.has(body.index) ||
      !Number.isSafeInteger(body.flags) ||
      body.flags < 0 ||
      body.flags > 0xffffffff ||
      !Array.isArray(body.shapes)
    )
      throw new TypeError('invalid M3 rigid body descriptor')
    bodyIds.add(body.index)
    // Zero flags are accepted by the frozen facade, including older versions without flags.
    if (body.flags !== 0 && (body.flags & 1) === 0) continue
    const shapeIds = new Set<number>()
    for (const shape of body.shapes) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(shape.index) || shape.index < 0 || shapeIds.has(shape.index))
        throw new TypeError('invalid M3 rigid shape identity')
      shapeIds.add(shape.index)
      const names = ['Box', 'Sphere', 'Capsule', 'Cylinder', 'ConvexHull', 'Mesh']
      const kinds = ['box', 'sphere', 'capsule', 'cylinder', 'convex-hull', 'mesh'] as const
      const kind = kinds[shape.shapeCode]
      const id = `m3-rigid-body-${body.index}-shape-${shape.index}`
      const unrepresented = (note: string) => {
        warnings.push(note)
        losses.push({
          facetId: 'common.view/model-collision-source@1',
          change: 'absent-in-artifact',
          path: `/volumes/${id}`,
          note,
        })
      }
      if (kind === undefined) {
        if (shape.shape !== 'Unknown') throw new TypeError('M3 rigid shape code and name disagree')
        unrepresented(
          `M3 PHRB ${body.index} PHSH ${shape.index} has an unknown shape code; native data retained without an active collision.`,
        )
        continue
      }
      if (shape.shape !== names[shape.shapeCode])
        throw new TypeError('M3 rigid shape code and name disagree')
      if (shape.geometry !== undefined && shape.geometry.kind !== kind)
        throw new TypeError('M3 rigid native geometry and shape kind disagree')
      if (kind === 'mesh' && shape.geometry === undefined) {
        unrepresented(
          `M3 PHRB ${body.index} PHSH ${shape.index} mesh topology is not projected by the native builder; native data retained without fabricated collision triangles.`,
        )
        continue
      }
      const nodeId = `bone/${body.boneIndex}`
      if (!Number.isSafeInteger(body.boneIndex) || body.boneIndex < 0 || !nodeIds.has(nodeId))
        throw new TypeError('M3 rigid body requires an exact UVM bone binding')
      if (
        !Array.isArray(shape.matrix4) ||
        shape.matrix4.length !== 16 ||
        !shape.matrix4.every(Number.isFinite) ||
        [3, 7, 11].some(i => shape.matrix4[i] !== 0) ||
        shape.matrix4[15] !== 1
      )
        throw new TypeError('M3 rigid shape requires a finite affine matrix')
      if (
        !Array.isArray(shape.size) ||
        shape.size.length !== 3 ||
        !shape.size.every(Number.isFinite)
      )
        throw new TypeError('M3 rigid shape requires finite native dimensions')
      let target: ModelCollisionShape
      if (kind === 'box') {
        if (!shape.size.every((value: number) => value > 0))
          throw new TypeError('M3 rigid box extents must be positive')
        target = { kind, size: [shape.size[0], shape.size[1], shape.size[2]] }
      } else if (kind === 'sphere') {
        if (shape.size[0] <= 0) throw new TypeError('M3 rigid sphere radius must be positive')
        target = { kind, radius: shape.size[0] }
      } else if (kind === 'capsule' || kind === 'cylinder') {
        if (shape.size[0] >= 0 && shape.size[1] >= 0 && (shape.size[0] === 0 || shape.size[1] === 0)) {
          validateM3DegenerateShape(shape)
          residualShapes.push({ bodyIndex: body.index, boneIndex: body.boneIndex, shape })
          warnings.push(`M3 PHRB ${body.index} PHSH ${shape.index} has degenerate ${kind} dimensions; preserved in native residual without an active collision.`)
          continue
        }
        if (shape.size[0] <= 0 || shape.size[1] <= 0)
          throw new TypeError('M3 rigid axial dimensions must be positive')
        target = { kind, radius: shape.size[0], height: shape.size[1], axis: 'y' }
      } else {
        const geometry = shape.geometry
        const points = geometry?.positions ?? shape.vertices
        if (!Array.isArray(points) || points.length < (kind === 'mesh' ? 3 : 4))
          throw new TypeError('M3 rigid geometry requires enough native points')
        hullBytes += points.length * 12
        if (!Number.isSafeInteger(hullBytes) || hullBytes > budget.maxScalarBytes)
          throw new RangeError('M3 rigid geometry exceeds maxScalarBytes')
        const values = new Float32Array(points.length * 3)
        for (const [i, vertex] of points.entries()) {
          signal?.throwIfAborted()
          if (
            !Array.isArray(vertex) ||
            vertex.length !== 3 ||
            !vertex.every(value => Number.isFinite(value) && Math.fround(value) === value)
          )
            throw new TypeError('M3 rigid geometry requires exact float32 native vertices')
          values.set(vertex, i * 3)
        }
        let indices: Uint32Array | undefined
        if (kind === 'mesh') {
          if (
            geometry?.kind !== 'mesh' ||
            !Array.isArray(geometry.indices) ||
            geometry.indices.length === 0 ||
            geometry.indices.length % 3 !== 0
          )
            throw new TypeError('M3 rigid mesh requires complete native triangle indices')
          hullBytes += geometry.indices.length * 4
          if (!Number.isSafeInteger(hullBytes) || hullBytes > budget.maxScalarBytes)
            throw new RangeError('M3 rigid geometry exceeds maxScalarBytes')
          indices = new Uint32Array(geometry.indices.length)
          for (const [i, value] of geometry.indices.entries()) {
            signal?.throwIfAborted()
            if (!Number.isSafeInteger(value) || value < 0 || value >= points.length)
              throw new RangeError('M3 rigid mesh index exceeds its native vertices')
            indices[i] = value
          }
        }
        target = { kind, positions: values, ...(indices === undefined ? {} : { indices }) }
      }
      volumes.push({
        id,
        kind: `m3-rigid-${kind}`,
        origin: 'declared-volume',
        nodeId,
        role: 'physics',
        shape: { ...target, matrix: [...shape.matrix4] },
      })
    }
  }
  return { volumes, warnings, losses, residualShapes, bodies: owned }
}

/** Validate the bounded native-only record before either export direction uses it. */
export function validateM3DegenerateShape(shape: M3RigidBodyShape): Uint8Array {
  const native = shape.nativeRecord
  if (
    (shape.shapeCode !== 2 && shape.shapeCode !== 3) ||
    shape.shape !== (shape.shapeCode === 2 ? 'Capsule' : 'Cylinder') ||
    !Array.isArray(shape.size) || shape.size.length !== 3 ||
    !shape.size.every(Number.isFinite) || shape.size[0] < 0 || shape.size[1] < 0 ||
    (shape.size[0] !== 0 && shape.size[1] !== 0) ||
    !Array.isArray(shape.matrix4) || shape.matrix4.length !== 16 ||
    !shape.matrix4.every(Number.isFinite) ||
    [3, 7, 11].some(i => shape.matrix4[i] !== 0) || shape.matrix4[15] !== 1 ||
    !Array.isArray(shape.vertices) || shape.vertices.length !== 0 || shape.geometry !== undefined ||
    native?.version !== 3 || !Array.isArray(native.bytes) || native.bytes.length !== 300 ||
    !native.bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
  ) throw new TypeError('M3 degenerate shape requires an exact reference-free PHSH v3 record')
  return Uint8Array.from(native.bytes)
}

/** Restore native-only shapes without renumbering bodies referenced by joints/constraints. */
export function mergeM3DegenerateRigidShapes(
  input: unknown,
  bodies: Map<number, { boneIndex: number; shapes: M3RigidBodyShape[] }>,
  boneIndices: ReadonlySet<number>,
  bodyIndices: ReadonlySet<number>,
  budget: { readonly maxDepth: number; readonly maxNodes: number; readonly maxScalarBytes: number },
  signal?: AbortSignal,
): void {
  const owned = snapshotJson(input, {
    maxDepth: budget.maxDepth, maxNodes: budget.maxNodes,
    maxBytes: budget.maxScalarBytes,
  }, signal) as unknown as readonly { bodyIndex: number; boneIndex: number; shape: M3RigidBodyShape }[]
  if (!Array.isArray(owned)) throw new TypeError('M3 degenerate rigid shapes must be an array')
  for (const item of owned) {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(item.bodyIndex) || item.bodyIndex < 0 || !bodyIndices.has(item.bodyIndex) ||
        !Number.isSafeInteger(item.boneIndex) || !boneIndices.has(item.boneIndex) ||
        !Number.isSafeInteger(item.shape?.index) || item.shape.index < 0)
      throw new TypeError('M3 degenerate rigid shape identity or bone binding is invalid')
    validateM3DegenerateShape(item.shape)
    const body: { boneIndex: number; shapes: M3RigidBodyShape[] } =
      bodies.get(item.bodyIndex) ?? { boneIndex: item.boneIndex, shapes: [] }
    if (body.boneIndex !== item.boneIndex || body.shapes.some(shape => shape.index === item.shape.index))
      throw new TypeError('M3 degenerate rigid shape binding is ambiguous')
    body.shapes.push(item.shape)
    bodies.set(item.bodyIndex, body)
  }
}

