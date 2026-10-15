import { expect, it } from 'vitest'
import { revisionId } from '@modkit/sdk'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAccessor } from '@modkit/uv/model/accessor'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { createUvmCollisionOverlay } from '@modkit/scene/uvm/collision-overlay'
import { openUvmDocument } from '@modkit/scene/uvm'
import { convertM3ProjectionToUvm, exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { createPhysicsLayoutFixture } from './fixtures/physics-layout.js'
import {
  budget,
  sha256,
  object,
  list,
  required,
  native,
  shapes,
  evidence,
} from './fixtures/physics-proof.js'
const points = [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4]
const indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
const local = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
function projection(): ModelProjection {
  return {
    info: {
      scenes: 1,
      nodes: 1,
      meshes: 0,
      primitives: 0,
      materials: 0,
      textures: 0,
      animations: 0,
      geometryAccess: 'decoded',
    },
    nodes: [
      {
        id: 'bone/0',
        childIds: [],
        meshIds: [],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      },
    ],
    meshes: [],
    primitives: [],
    materials: [],
    animations: [],
    skeleton: [
      {
        partId: 'native',
        hierarchyId: 'native/bones',
        boneIndex: 0,
        boneName: 'PhysicsRoot',
        nodeId: 'bone/0',
        provenance: 'direct',
        parentBoneIndex: null,
        localPose: { translation: [3, 4, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, -4, -5, 1],
      },
    ],
  }
}
async function convert(bytes: Uint8Array, decoded?: Awaited<ReturnType<typeof native>>) {
  const value = decoded ?? (await native(bytes))
  return convertM3ProjectionToUvm(bytes, projection(), value.metadata, {
    assetId: 'authored-physics-layout',
    subjectRevision: revisionId(`content-hash.sha256:${sha256(bytes)}`),
    sourceFormat: 'm3a',
    metersPerSourceUnit: 2,
    budget,
    rigidBodies: value.rigidBodies,
  })
}
it.each([
  [1, 'mesh16'],
  [2, 'mesh16'],
  [3, 'mesh16'],
  [3, 'mesh32'],
] as const)(
  'projects PHSH v%s %s triangles into source-free UVM and canonical M3',
  async (version, variant) => {
    const bytes = await createPhysicsLayoutFixture(version, variant)
    const decoded = await native(bytes)
    const body = required(decoded.rigidBodies[0]),
      shape = required(body.shapes[0])
    expect(shape.matrix4).toEqual(local)
    expect(shape.geometry?.positions.flat()).toEqual(points)
    if (shape.geometry?.kind !== 'mesh') throw new TypeError('native mesh geometry absent')
    expect(shape.geometry.indices).toEqual(indices)
    expect(shape.geometry.source['version']).toBe(version)
    expect(shape.geometry.source['triangleTag']).toBe(
      version === 1 ? 'U16_' : version === 2 ? 'DMMT' : variant === 'mesh32' ? 'MT32' : 'MT16',
    )
    const output = await convert(bytes, decoded),
      reopened = readUvmContainer(output.bytes, budget)
    const collision = required(shapes(reopened.document)[0])
    expect(collision.role).toBe('physics')
    expect(collision.shape['kind']).toBe('mesh')
    expect(collision.shape['matrix']).toEqual(local)
    expect(
      Array.from(
        readUvmAccessor(
          reopened.document,
          reopened.binary,
          collision.shape['positions'],
          budget,
          'positions',
        ).values,
      ),
    ).toEqual(points)
    expect(
      Array.from(
        readUvmAccessor(
          reopened.document,
          reopened.binary,
          collision.shape['indices'],
          budget,
          'indices',
        ).values,
      ),
    ).toEqual(indices)
    const envelope = object(object(reopened.document['extras'])['BlizzardM3'])
    expect(envelope['metadata']).toBeUndefined()
    expect(envelope['source']).toBeUndefined()
    expect(object(envelope['residual'])['mdVersion']).toBe(34)
    expect(object(envelope['mapping'])['rigidBodies']).toBeUndefined()
    expect(output.receipt.lostFacetIds).not.toContain('common.view/model-collision-source@1')
    const encoded = await exportM3FromUvm(reopened, budget)
    const canonical = await native(encoded)
    const canonicalShape = required(required(canonical.rigidBodies[0]).shapes[0])
    expect(canonicalShape.matrix4).toEqual(local)
    expect(canonicalShape.geometry?.kind).toBe('mesh')
    expect(canonicalShape.geometry?.positions.flat()).toEqual(points)
    if (canonicalShape.geometry?.kind !== 'mesh') throw new TypeError('canonical mesh absent')
    expect(canonicalShape.geometry.indices).toEqual(indices)
    await evidence(`v${version}-${variant}`, bytes, output.bytes, {
      corpus: 'authored-fixed-byte',
      nativeMetadata: decoded.metadata,
      geometry: object(shape.geometry),
      receipt: object(output.receipt),
    })
  },
)

it.each([1, 2, 3] as const)(
  'projects PHSH v%s convex VEC3 points while preserving separate nonzero-distance VEC4 planes',
  async version => {
    const bytes = await createPhysicsLayoutFixture(version, 'hull'),
      decoded = await native(bytes)
    const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      indexOffset = raw.getUint32(4, true),
      sectionCount = raw.getUint32(8, true)
    const shapeIndex = required(
      Array.from({ length: sectionCount }, (_, index) => index).find(
        index => raw.getUint32(indexOffset + index * 16, true) === 0x50485348,
      ),
    )
    const shapeOffset = raw.getUint32(indexOffset + shapeIndex * 16 + 4, true),
      vertexIndex = raw.getUint32(shapeOffset + (version === 1 ? 76 : 108), true),
      planeIndex = raw.getUint32(shapeOffset + (version === 1 ? 112 : 120), true)
    expect(vertexIndex).not.toBe(planeIndex)
    expect(raw.getUint32(indexOffset + vertexIndex * 16, true)).toBe(0x56454333)
    expect(raw.getUint32(indexOffset + planeIndex * 16, true)).toBe(0x56454334)
    const vertexOffset = raw.getUint32(indexOffset + vertexIndex * 16 + 4, true),
      planeOffset = raw.getUint32(indexOffset + planeIndex * 16 + 4, true)
    expect(
      Array.from({ length: 12 }, (_, index) => raw.getFloat32(vertexOffset + index * 4, true)),
    ).toEqual(points)
    expect(raw.getFloat32(planeOffset + 3 * 16 + 12, true)).toBe(Math.fround(12 / Math.sqrt(61)))
    const expectedPlanes = Array.from({ length: 4 }, (_, index) =>
      Array.from({ length: 4 }, (_, component) =>
        raw.getFloat32(planeOffset + index * 16 + component * 4, true),
      ),
    )
    for (const plane of expectedPlanes) {
      const residuals = Array.from(
        { length: 4 },
        (_, index) =>
          required(plane[0]) * required(points[index * 3]) +
          required(plane[1]) * required(points[index * 3 + 1]) +
          required(plane[2]) * required(points[index * 3 + 2]) -
          required(plane[3]),
      )
      expect(Math.abs(Math.max(...residuals))).toBeLessThan(2e-7)
    }
    const geometry = required(required(decoded.rigidBodies[0]).shapes[0]).geometry
    expect(geometry?.kind).toBe('convex-hull')
    expect(geometry?.positions.flat()).toEqual(points)
    expect(geometry?.source['vertexField']).toBe('vertices')
    expect(geometry?.source['vertexSection']).toBe(vertexIndex)
    const output = await convert(bytes, decoded)
    const collision = required(shapes(output.container.document)[0]).shape
    expect(collision['kind']).toBe('convex-hull')
    expect(
      Array.from(
        readUvmAccessor(
          output.container.document,
          output.container.binary,
          collision['positions'],
          budget,
          'positions',
        ).values,
      ),
    ).toEqual(points)
    const envelope = object(object(output.container.document['extras'])['BlizzardM3'])
    expect(envelope['metadata']).toBeUndefined()
    expect(envelope['source']).toBeUndefined()
    const canonical = await native(await exportM3FromUvm(output.container, budget))
    const canonicalGeometry = required(required(canonical.rigidBodies[0]).shapes[0]).geometry
    expect(canonicalGeometry?.kind).toBe('convex-hull')
    expect(canonicalGeometry?.positions.flat()).toEqual(points)
    await evidence(`v${version}-hull`, bytes, output.bytes, {
      corpus: 'authored-fixed-byte',
      vertexIndex,
      planeIndex,
      expectedPlanes,
      nativeMetadata: decoded.metadata,
      geometry: object(geometry),
    })
  },
)

it('decodes the actual PHSH v2 geometry without interpreting its six-field tail as geometry', async () => {
  const bytes = await createPhysicsLayoutFixture(2)
  const decoded = await native(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const indexOffset = view.getUint32(4, true), sectionCount = view.getUint32(8, true)
  const section = required(Array.from({ length: sectionCount }, (_, index) => index).find(
    index => view.getUint32(indexOffset + index * 16, true) === 0x50485348,
  ))
  const at = view.getUint32(indexOffset + section * 16 + 4, true)
  expect([268, 272, 276, 280, 284, 288].map(offset => view.getUint32(at + offset, true))).toEqual([
    0, 4, 4, 0, 0x12345678, 0x13579bdf,
  ])
  expect(required(required(decoded.rigidBodies[0]).shapes[0]).geometry?.positions.flat()).toEqual(points)
})

it('decodes both physical 300-byte PHSH v3 records and canonicalizes their common geometry', async () => {
  const bytes = await createPhysicsLayoutFixture(3, 'two-shapes'),
    decoded = await native(bytes)
  expect(required(decoded.rigidBodies[0]).shapes).toHaveLength(2)
  expect(required(required(decoded.rigidBodies[0]).shapes[1]).matrix4.slice(12, 15)).toEqual([
    5, 7, 11,
  ])
  const output = await convert(bytes, decoded)
  const { scene, rig } = readUvmModel(output.container.document, output.container.binary, budget)
  const sampler = createModelSceneSampler(
    { ...scene, skeleton: rig.bindings },
    { maxBytes: budget.maxScalarBytes },
  )
  const overlay = createUvmCollisionOverlay(
    output.container.document,
    output.container.binary,
    budget,
  )
  const frames = overlay.sample(sampler.sample(0).nodeTransforms)
  expect(frames).toHaveLength(2)
  // The +z-up turn is a rotation node: its quaternion leaves float dust where the axes swap.
  const near = (actual: Float32Array | undefined, expected: readonly number[]) =>
    expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 9))
  near(required(frames[0]).transform, [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 8, 16, -12, 1])
  near(required(frames[1]).transform, [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 16, 32, -22, 1])
  for (const frame of frames) {
    expect(Array.from(frame.positions)).toEqual(points)
    expect(Array.from(required(frame.indices))).toEqual(indices)
  }
  const canonical = await native(await exportM3FromUvm(output.container, budget))
  expect(required(canonical.rigidBodies[0]).shapes).toHaveLength(2)
  for (const shape of required(canonical.rigidBodies[0]).shapes) {
    expect(shape.geometry?.positions.flat()).toEqual(points)
    if (shape.geometry?.kind !== 'mesh') throw new TypeError('canonical mesh absent')
    expect(shape.geometry.indices).toEqual(indices)
  }
})

it.each([
  [1, 'bad-index'],
  [2, 'bad-index'],
  [3, 'bad-index'],
  [3, 'both-streams'],
  [1, 'bad-tag'],
  [2, 'bad-tag'],
  [3, 'bad-tag'],
  [3, 'bad-count'],
  [3, 'nonzero-w'],
] as const)(
  'refuses native PHSH v%s %s without returning fabricated geometry',
  async (version, variant) => {
    const bytes = await createPhysicsLayoutFixture(version, variant),
      before = Uint8Array.from(bytes)
    await expect(native(bytes)).rejects.toThrow()
    expect(bytes).toEqual(before)
  },
)

it('writes triangle edits through common UVM accessors and restores them through undo', async () => {
  const bytes = await createPhysicsLayoutFixture(3),
    decoded = await native(bytes),
    output = await convert(bytes, decoded)
  const document = openUvmDocument(output.bytes, { budget })
  try {
    const collision = required(shapes(output.container.document)[0])
    const accessor = required(
      list(output.container.document['accessors'])[Number(collision.shape['indices'])],
    )
    const view = required(
      list(output.container.document['bufferViews'])[Number(accessor['bufferView'])],
    )
    expect(accessor['componentType']).toBe(5125)
    const replacement = new Uint8Array(4)
    new DataView(replacement.buffer).setUint32(0, 1, true)
    document.apply({
      expectedRevision: 0,
      binary: [
        {
          byteOffset: Number(view['byteOffset'] ?? 0) + Number(accessor['byteOffset'] ?? 0),
          bytes: replacement,
        },
      ],
    })
    const edited = await native(
      await exportM3FromUvm(readUvmContainer(document.serialize(1), budget), budget),
    )
    const editedGeometry = required(required(edited.rigidBodies[0]).shapes[0]).geometry
    if (editedGeometry?.kind !== 'mesh') throw new TypeError('edited mesh absent')
    expect(editedGeometry.indices[0]).toBe(1)
    document.undo(1)
    const restored = await native(
      await exportM3FromUvm(readUvmContainer(document.serialize(2), budget), budget),
    )
    const restoredGeometry = required(required(restored.rigidBodies[0]).shapes[0]).geometry
    if (restoredGeometry?.kind !== 'mesh') throw new TypeError('restored mesh absent')
    expect(restoredGeometry.indices).toEqual(indices)
  } finally {
    document.dispose()
  }
})

it('retains cancellation and bounded geometry processing', async () => {
  const bytes = await createPhysicsLayoutFixture(3)
  await expect(native(bytes, budget, AbortSignal.abort())).rejects.toThrow()
  await expect(native(bytes, { ...budget, maxScalarBytes: 200 })).rejects.toThrow()
})
