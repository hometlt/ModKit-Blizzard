import { beforeAll, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { revisionId, type JsonObject } from '@modkit/sdk'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmAccessor } from '@modkit/uv/model/accessor'
import { openUvmDocument } from '@modkit/scene/uvm'
import { createUvmCollisionOverlay } from '@modkit/scene/uvm/collision-overlay'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { convertM3ProjectionToUvm, exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import type { M3RigidBody } from '../dist/m3/uvm/rigid-bodies.js'
import {
  createLegacyRigidBodyNativeFixture,
  createRigidBodyNativeFixture,
} from './fixtures/rigid-body.js'

const budget = {
  maxInputBytes: 16_777_216,
  maxScalarBytes: 16_777_216,
  maxJsonBytes: 8_388_608,
  maxDepth: 128,
  maxNodes: 100_000,
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const local = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
let bytes: Uint8Array, metadata: JsonObject, bodies: readonly M3RigidBody[]
async function decodeNative(input: Uint8Array) {
  const { decodeM3UvmSource } = (await import(
    new URL('../src/m3/geometry.node.js', import.meta.url).href
  )) as {
    decodeM3UvmSource(
      bytes: Uint8Array,
      limits: typeof budget,
    ): Promise<{
      metadata: JsonObject
      rigidBodies: readonly M3RigidBody[]
    }>
  }
  return decodeM3UvmSource(input, budget)
}
beforeAll(async () => {
  bytes = await createRigidBodyNativeFixture()
  const decoded = await decodeNative(bytes)
  metadata = decoded.metadata
  bodies = decoded.rigidBodies
  const directory = process.env['MODKIT_M3A_RIGID_EVIDENCE_DIR']
  if (directory !== undefined) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'm3-uvm-m3a-standalone-physics-v1.m3a'), bytes, { flag: 'wx' })
    await writeFile(
      join(directory, 'm3-uvm-m3a-standalone-physics-v1-source.json'),
      JSON.stringify(
        {
          corpus: 'authored-native',
          layout: 'PHSH-v1/132-bytes',
          recipe: 'models/test/fixtures/rigid-body.ts::createRigidBodyNativeFixture',
          sha256: sha256(bytes),
          bytes: bytes.length,
          bodies,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    )
  }
})
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('physics fixture object absent')
  return value as JsonObject
}
function list(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError('physics fixture array absent')
  return value.map(object)
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('physics fixture value absent')
  return value
}
function projection(): ModelProjection {
  const transform = [...identity]
  transform[12] = 3
  transform[13] = 4
  transform[14] = 5
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
    nodes: [{ id: 'bone/0', childIds: [], meshIds: [], transform }],
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
const options = (rigidBodies: readonly M3RigidBody[] = bodies) => ({
  assetId: 'authored-physics',
  subjectRevision: revisionId(`content-hash.sha256:${sha256(bytes)}`),
  sourceFormat: 'm3a' as const,
  metersPerSourceUnit: 2,
  rigidBodies,
  budget,
})
function physicsShapes(document: JsonObject) {
  return list(document['nodes']).flatMap((node, nodeIndex) => {
    const extension =
      node['extensions'] === undefined ? undefined : object(node['extensions'])['UV_game_collision']
    return extension === undefined
      ? []
      : list(object(extension)['shapes']).map(shape => ({
          nodeIndex,
          role: object(extension)['role'],
          shape,
        }))
  })
}

it('decodes real authored PHRB/PHSH and preserves exact shapes through standalone UVM and native export', async () => {
  // Fixed native layout offsets are independent of the XML parser/metadata/semantic writer.
  const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(raw.getUint32(0, true)).toBe(0x4d443334) // MD34, stored in reversed tag byte order.
  const indexOffset = raw.getUint32(4, true),
    indexCount = raw.getUint32(8, true)
  expect(indexOffset + indexCount * 16).toBe(bytes.length)
  const entries = Array.from({ length: indexCount }, (_, index) => {
    const at = indexOffset + index * 16
    return {
      tag: raw.getUint32(at, true),
      offset: raw.getUint32(at + 4, true),
      repetitions: raw.getUint32(at + 8, true),
      version: raw.getUint32(at + 12, true),
    }
  })
  const physicsEntries = entries.filter(entry => entry.tag === 0x50485348) // PHSH.
  expect(physicsEntries).toHaveLength(1)
  const physics = required(physicsEntries[0])
  expect(physics.version).toBe(1)
  expect(physics.repetitions).toBe(1)
  expect(raw.getUint8(physics.offset + 68)).toBe(0)
  expect(
    Array.from({ length: 16 }, (_, i) => raw.getFloat32(physics.offset + i * 4, true)),
  ).toEqual(local)
  expect([120, 124, 128].map(offset => raw.getFloat32(physics.offset + offset, true))).toEqual([
    2, 3, 4,
  ])
  const nextOffset = Math.min(
    indexOffset,
    ...entries.filter(entry => entry.offset > physics.offset).map(entry => entry.offset),
  )
  expect(nextOffset).toBe(Math.ceil((physics.offset + 132) / 16) * 16)
  expect([...bytes.subarray(physics.offset + 132, nextOffset)].every(byte => byte === 0xaa)).toBe(
    true,
  )
  expect(bodies).toHaveLength(1)
  expect(required(bodies[0])).toMatchObject({
    index: 0,
    boneIndex: 0,
    flags: 1,
    shapes: [
      { index: 0, shape: 'Box', shapeCode: 0, matrix4: local, size: [2, 3, 4], vertices: [] },
    ],
  })
  const output = await convertM3ProjectionToUvm(bytes, projection(), metadata, options())
  const container = readUvmContainer(output.bytes, budget)
  const envelope = object(object(container.document['extras'])['BlizzardM3'])
  expect(envelope['schemaVersion']).toBe(1)
  expect(envelope['metadata']).toBeUndefined()
  expect(envelope['source']).toBeUndefined()
  expect(physicsShapes(container.document)).toEqual([
    { nodeIndex: 1, role: 'physics', shape: { kind: 'box', size: [2, 3, 4], matrix: local } },
  ])
  const canonical = await decodeNative(await exportM3FromUvm(container, budget))
  expect(required(required(canonical.rigidBodies[0]).shapes[0])).toMatchObject({
    shape: 'Box',
    matrix4: local,
    size: [2, 3, 4],
  })
})

it('repairs PHSH v3 physical slots locally while preserving the frozen registry and exact source', async () => {
  const legacy = await createLegacyRigidBodyNativeFixture()
  const original = Uint8Array.from(legacy)
  // Pins the failed candidate, whose exact recipe is preserved outside the source package.
  expect(sha256(legacy)).toBe('661f3be1b285edb65bea22e88dd38caf3ccf4abd145597eb865827b93438af82')
  interface Field {
    readonly name: string
    readonly size: number
    readonly type?: string
    readonly refTo?: string
  }
  const { M3SectionList } = (await import(
    new URL('../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: {
      load(
        buffer: ArrayBuffer,
        xml: string,
      ): Promise<
        readonly {
          readonly rawBytes: ArrayBuffer
          readonly desc: {
            readonly size: number
            readonly fields: Readonly<Record<string, Field>>
            readonly history: {
              readonly name: string
              readonly fieldRecords: readonly {
                readonly field: Field
                readonly sinceVersion: number
                readonly tillVersion: number
              }[]
            }
          }
        }[]
      >
    }
  }
  const buffer = new ArrayBuffer(legacy.length)
  new Uint8Array(buffer).set(legacy)
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(buffer, xml)
  const native = required(sections.find(section => section.desc.history.name === 'PHSH'))
  expect(native.desc.size).toBe(300)
  expect(native.rawBytes.byteLength).toBe(300)
  const active = native.desc.history.fieldRecords.filter(
    item => item.sinceVersion <= 3 && item.tillVersion >= 3,
  )
  expect(active.reduce((size, item) => size + item.field.size, 0)).toBe(336)
  const names = active.map(item => item.field.name)
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([
    'unknown90e72e22',
    'unknown9836ec85',
    'unknownac0ac492',
  ])
  let offset = 0
  const slots = Object.values(native.desc.fields).map(field => {
    const slot = {
      name: field.name,
      size: field.size,
      offset,
      type: field.type,
      refTo: field.refTo,
    }
    offset += field.size
    return slot
  })
  // Independent native reference: Whiteout PHSH v3 stores VEC4 Reference (12 bytes) at 196.
  // The pinned schema instead exposes a float, although its total size still equals 300.
  expect(slots.find(slot => slot.offset === 196)).toEqual({
    name: 'unknown9836ec85',
    size: 4,
    offset: 196,
    type: 'float',
    refTo: undefined,
  })
  const decoded = await decodeNative(legacy)
  expect(decoded.rigidBodies).toHaveLength(1)
  expect(required(required(decoded.rigidBodies[0]).shapes[0])).toMatchObject({
    shape: 'Box',
    shapeCode: 0,
    matrix4: local,
    size: [2, 3, 4],
  })
  // The native registry remains untouched; only the per-conversion section view is repaired.
  expect(native.desc.fields['unknown9836ec85']?.type).toBe('float')
  const output = await convertM3ProjectionToUvm(legacy, projection(), decoded.metadata, {
    ...options(decoded.rigidBodies),
    subjectRevision: revisionId(`content-hash.sha256:${sha256(legacy)}`),
  })
  const canonical = await decodeNative(await exportM3FromUvm(output.container, budget))
  expect(required(required(canonical.rigidBodies[0]).shapes[0])).toMatchObject({
    shape: 'Box',
    matrix4: local,
    size: [2, 3, 4],
  })
  expect(legacy).toEqual(original)
})

it('applies the bone transform, local matrix and global conversion once in the common collision overlay', async () => {
  const output = await convertM3ProjectionToUvm(bytes, projection(), metadata, options())
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
  expect(frames).toHaveLength(1)
  const shape = required(frames[0])
  // The +z-up turn is a rotation node: its quaternion leaves float dust where the axes swap.
  ;[2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 8, 16, -12, 1].forEach((value, index) =>
    expect(shape.transform?.[index]).toBeCloseTo(value, 9),
  )
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < shape.positions.length; i += 3) {
    const point = [
      2 * required(shape.positions[i]) + 8,
      2 * required(shape.positions[i + 2]) + 16,
      -2 * required(shape.positions[i + 1]) - 12,
    ]
    point.forEach((value, axis) => {
      minimum[axis] = Math.min(required(minimum[axis]), value)
      maximum[axis] = Math.max(required(maximum[axis]), value)
    })
  }
  expect(minimum).toEqual([6, 12, -15])
  expect(maximum).toEqual([10, 20, -9])
})

it.each([
  { shape: 'Sphere', shapeCode: 1, expected: { kind: 'sphere', radius: 2 } },
  {
    shape: 'Capsule',
    shapeCode: 2,
    expected: { kind: 'capsule', radius: 2, height: 3, axis: 'y' },
  },
  {
    shape: 'Cylinder',
    shapeCode: 3,
    expected: { kind: 'cylinder', radius: 2, height: 3, axis: 'y' },
  },
] as const)(
  'maps $shape dimensions without the ATVL half-extent convention',
  async ({ shape, shapeCode, expected }) => {
    const body = required(bodies[0]),
      original = required(body.shapes[0])
    const mapped = [{ ...body, shapes: [{ ...original, shape, shapeCode }] }]
    const output = await convertM3ProjectionToUvm(bytes, projection(), metadata, options(mapped))
    expect(required(physicsShapes(output.container.document)[0]).shape).toEqual({
      ...expected,
      matrix: local,
    })
  },
)

it('stores convex hull points through shared accessors and preserves their exact source mapping', async () => {
  const body = required(bodies[0]),
    original = required(body.shapes[0])
  const vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const
  const mapped = [
    { ...body, shapes: [{ ...original, shape: 'ConvexHull' as const, shapeCode: 4, vertices }] },
  ]
  const output = await convertM3ProjectionToUvm(bytes, projection(), metadata, options(mapped))
  const shape = required(physicsShapes(output.container.document)[0]).shape
  expect(shape['kind']).toBe('convex-hull')
  expect(
    Array.from(
      readUvmAccessor(
        output.container.document,
        output.container.binary,
        shape['positions'],
        budget,
        'positions',
      ).values,
    ),
  ).toEqual(vertices.flat())
})

it('refuses a mesh without common topology instead of retaining a native descriptor snapshot', async () => {
  const body = required(bodies[0]),
    original = required(body.shapes[0])
  const mapped = [
    {
      ...body,
      shapes: [
        {
          ...original,
          shape: 'Mesh' as const,
          shapeCode: 5,
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ] as const,
        },
      ],
    },
  ]
  await expect(
    convertM3ProjectionToUvm(bytes, projection(), metadata, options(mapped)),
  ).rejects.toThrow('refuses unrepresented native rigid shapes')
})

it('uses the frozen collidable flag gate and stores only bounded body parameters in residual', async () => {
  const body = required(bodies[0])
  for (const flags of [0, 1, 2]) {
    const mapped = [{ ...body, flags }]
    const output = await convertM3ProjectionToUvm(bytes, projection(), metadata, options(mapped))
    expect(physicsShapes(output.container.document)).toHaveLength(flags === 2 ? 0 : 1)
    const residual = object(object(object(output.container.document['extras'])['BlizzardM3'])['residual'])
    const stored = list(residual['rigidBodies'])
    expect(stored).toHaveLength(1)
    expect(required(stored[0])['flags']).toBe(flags)
    expect(required(stored[0])['shapes']).toBeUndefined()
  }
})

it('owns descriptors before yielding and writes analytic shape edits from common UVM', async () => {
  const body = required(bodies[0]),
    original = required(body.shapes[0])
  const mutable = [{ ...body, shapes: [{ ...original, matrix4: [...local] }] }]
  const pending = convertM3ProjectionToUvm(bytes, projection(), metadata, options(mutable))
  required(mutable[0]).shapes[0]?.matrix4.fill(0)
  const output = await pending
  expect(required(physicsShapes(output.container.document)[0]).shape['matrix']).toEqual(local)
  const document = openUvmDocument(output.bytes, { budget })
  try {
    document.apply({
      expectedRevision: 0,
      json: [
        {
          op: 'replace',
          path: '/nodes/1/extensions/UV_game_collision/shapes/0/size',
          value: [9, 9, 9],
        },
      ],
    })
    const edited = await decodeNative(
      await exportM3FromUvm(readUvmContainer(document.serialize(1), budget), budget),
    )
    expect(required(required(edited.rigidBodies[0]).shapes[0]).size).toEqual([9, 9, 9])
    document.undo(1)
    const restored = await decodeNative(
      await exportM3FromUvm(readUvmContainer(document.serialize(2), budget), budget),
    )
    expect(required(required(restored.rigidBodies[0]).shapes[0]).size).toEqual([2, 3, 4])
  } finally {
    document.dispose()
  }
})

it('refuses a missing bone and invalid dimensions without changing source data', async () => {
  const body = required(bodies[0]),
    shape = required(body.shapes[0])
  for (const invalid of [
    { ...body, boneIndex: 8 },
    { ...body, shapes: [{ ...shape, size: [0, 3, 4] as const }] },
  ])
    await expect(
      convertM3ProjectionToUvm(bytes, projection(), metadata, options([invalid])),
    ).rejects.toThrow()
})
