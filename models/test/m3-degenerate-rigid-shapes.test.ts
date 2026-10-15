import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { revisionId } from '@modkit/sdk'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import { readUvmContainer } from '@modkit/uv/model/container'
import { convertM3ProjectionToUvm, exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { budget, native, required, shapes, object, list, sha256 } from './fixtures/physics-proof.js'

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const projection: ModelProjection = {
  info: { scenes: 1, nodes: 2, meshes: 1, primitives: 1, materials: 1, textures: 0, animations: 0, geometryAccess: 'decoded' },
  nodes: [{ id: 'bone/0', childIds: [], meshIds: [], transform: identity },
    { id: 'draw', childIds: [], meshIds: ['mesh'], transform: identity }],
  meshes: [{ id: 'mesh', primitiveIds: ['triangle'] }],
  primitives: [{ id: 'triangle', topology: 'triangles', hierarchyId: 'native/bones',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: new Float32Array([0, 0, 1, 0, 0, 1]),
    boneIndices: new Uint32Array(12),
    boneWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]), materialId: 'plain' }],
  materials: [{ id: 'plain', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, alphaMode: 'opaque' }], animations: [],
  skeleton: [{ partId: 'native', hierarchyId: 'native/bones', boneIndex: 0,
    boneName: 'PhysicsRoot', nodeId: 'bone/0', provenance: 'direct', parentBoneIndex: null,
    localPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, inverseBindMatrix: identity }],
}
async function records(bytes: Uint8Array) {
  interface Section { readonly indexEntry: { readonly offset: number }; readonly content: readonly Record<string, unknown>[] }
  interface Sections { readonly model: Readonly<Record<string, unknown>>; getSectionByReference(reference: unknown): Section | null }
  const { M3SectionList } = await import(new URL('../dist/m3/native/binary/sections.js', import.meta.url).href) as {
    M3SectionList: { load(buffer: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, xml)
  const bodies = sections.getSectionByReference(sections.model['physics_rigidbodies'])
  if (bodies === null) throw new TypeError('synthetic rigid bodies absent')
  return bodies.content.map(value => {
    const section = sections.getSectionByReference(value['physics_shape'])
    if (section === null) throw new TypeError('synthetic rigid shapes absent')
    return section.content.map((_, index) => {
      const offset = section.indexEntry.offset + index * 300
      return { offset, bytes: bytes.slice(offset, offset + 300) }
    })
  })
}
async function fixture(code: 2 | 3, size: readonly number[]) {
  const { encodeM3SemanticModel } = await import(new URL('../src/m3/writer.js', import.meta.url).href) as {
    encodeM3SemanticModel(source: unknown, options: { fileName: string; includeTextures: false },
      limits: { maxInputBytes: bigint; maxDepth: number; maxNodes: number; maxScalarBytes: number; maxDiagnostics: number }): Promise<{ bytes: Uint8Array }>
  }
  const shape = { shape: code === 2 ? 'Capsule' : 'Cylinder', shapeCode: code, matrix4: identity, size, vertices: [] }
  const active = { shape: 'Box', shapeCode: 0, matrix4: identity, size: [1, 2, 3], vertices: [] }
  const output = await encodeM3SemanticModel({
    format: 'm3', meshes: [], materials: [], animations: [], bounds: null,
    effects: { particles: [], ribbons: [] },
    skeleton: { bones: [{ index: 0, name: 'PhysicsRoot', parentIndex: -1, inverseBindMatrix: new Float32Array(identity) }] },
    metadata: { coordinateSystem: 'Y_UP', m3RigidBodies: [
      { index: 0, boneIndex: 0, flags: 1, shapes: [shape] },
      { index: 1, boneIndex: 0, flags: 1, shapes: [active, shape] },
      { index: 2, boneIndex: 0, flags: 1, shapes: [shape] },
    ] },
  }, { fileName: 'Degenerate.m3a', includeTextures: false }, {
    maxInputBytes: BigInt(budget.maxInputBytes), maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes, maxScalarBytes: budget.maxScalarBytes, maxDiagnostics: 100,
  })
  const bytes = Uint8Array.from(output.bytes)
  // Independent literal PHSH v3 offsets. Preserve dirty flags, signed zero and NaN payload bits.
  for (const [bodyIndex, body] of (await records(bytes)).entries()) {
    for (const [shapeIndex, record] of body.entries()) {
      if (bodyIndex === 1 && shapeIndex === 0) continue
      bytes[record.offset + 65] = 0x84
      const view = new DataView(bytes.buffer)
      view.setUint32(record.offset + 4, 0x80000000, true)
      view.setUint32(record.offset + 176, 0x7fa12345, true)
    }
  }
  return bytes
}
async function convert(bytes: Uint8Array) {
  const decoded = await native(bytes)
  return convertM3ProjectionToUvm(bytes, projection, decoded.metadata, {
    assetId: 'degenerate-physics', sourceFormat: 'm3', metersPerSourceUnit: 2,
    subjectRevision: revisionId(`content-hash.sha256:${sha256(bytes)}`), budget,
    rigidBodies: decoded.rigidBodies,
  })
}
it.each([2, 3] as const)('preserves zero dimensions and exact PHSH bytes for axial type %s', async code => {
  for (const size of [[0, 2, 0], [2, 0, 0], [0, 0, 0]]) {
    const bytes = await fixture(code, size)
    const output = await convert(bytes)
    expect(shapes(output.container.document)).toHaveLength(1)
    const envelope = object(object(output.container.document['extras'])['BlizzardM3'])
    const residual = object(envelope['residual'])
    expect(list(residual['degenerateRigidShapes'])).toHaveLength(3)
    expect(JSON.stringify(output.container.document)).toContain('degenerate')
    expect(residual['sourceBytes']).toBeUndefined()
    const restored = await exportM3FromUvm(readUvmContainer(output.bytes, budget), budget)
    const originalRecords = await records(bytes), restoredRecords = await records(restored)
    expect(restoredRecords).toHaveLength(3)
    for (const [bodyIndex, body] of originalRecords.entries()) {
      expect(required(restoredRecords[bodyIndex])).toHaveLength(body.length)
      for (const [shapeIndex, record] of body.entries()) {
        if (bodyIndex === 1 && shapeIndex === 0) continue
        expect(sha256(required(required(restoredRecords[bodyIndex])[shapeIndex]).bytes)).toEqual(sha256(record.bytes))
      }
    }
    expect((await native(restored)).rigidBodies.map(body => body.index)).toEqual([0, 1, 2])
  }
})

it('rejects malformed, conflicting and externally referenced native residuals', async () => {
  const output = await convert(await fixture(2, [2, 0, 0]))
  for (const mutation of ['duplicate', 'bone', 'reference', 'dimensions', 'matrix', 'length'] as const) {
    const decoded = readUvmContainer(output.bytes, budget)
    const container = { ...decoded, document: structuredClone(decoded.document) }
    const residual = object(object(object(container.document['extras'])['BlizzardM3'])['residual'])
    const entries = residual['degenerateRigidShapes'] as Record<string, unknown>[]
    const entry = required(entries[0]), shape = object(entry['shape']) as Record<string, unknown>
    const bytes = object(shape['nativeRecord'])['bytes'] as number[]
    if (mutation === 'duplicate') entries.push(entry)
    if (mutation === 'bone') entry['boneIndex'] = 99
    if (mutation === 'reference') bytes[104] = 1
    if (mutation === 'dimensions') shape['size'] = [3, 0, 0]
    if (mutation === 'matrix') shape['matrix4'] = [...identity.slice(0, 12), 1, 0, 0, 1]
    if (mutation === 'length') bytes.pop()
    await expect(exportM3FromUvm(container, budget)).rejects.toThrow(/degenerate|ambiguous/u)
  }
})

it('continues to reject negative native axial dimensions', async () => {
  await expect(convert(await fixture(2, [-1, 0, 0]))).rejects.toThrow('axial dimensions must be positive')
})
