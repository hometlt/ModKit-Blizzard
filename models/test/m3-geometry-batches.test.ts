import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it, vi } from 'vitest'
import { createModelSceneSource } from '@modkit/codec-kit'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { decodeM3Materials } from '../src/m3/material.node.js'
import { projectM3MaterialBatches } from '../dist/m3/material-batches.js'
import { materialBatchFixture } from './fixtures/material-batches.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { M3StructureDescription } from '../dist/m3/native/binary/structures.js'

const fixtures = new URL('./fixtures/m3/', import.meta.url)
const schema = new URL('../src/m3/native/structures.xml', import.meta.url)
const budget = { maxDepth: 64, maxNodes: 1_000_000, maxScalarBytes: 256 * 1024 * 1024 }
installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })
const values = (buffer: ArrayLike<number> | undefined) => buffer === undefined ? undefined : Array.from(buffer)

describe('M3 authored vertex attributes', () => {
  it.each([
    { materialIndices: [1, 0, 1], emptyFirstDivision: false },
    { materialIndices: [1, 0, 1], emptyFirstDivision: true },
    { materialIndices: [], emptyFirstDivision: false },
  ])('preserves every binary material batch and its order: %j', async options => {
    const bytes = await materialBatchFixture(options)
    const material = await decodeM3Materials(bytes, budget)
    expect(material.rejectedMaterialReferences).toBe(0)
    expect(material.ambiguousPrimitiveBindings).toBe(0)
    const regions = await decodeM3Geometry(bytes, budget)
    const geometry = projectM3MaterialBatches(regions, material.primitiveBindings, budget)
    expect(geometry.primitives.map(primitive => primitive.materialId)).toEqual(
      options.materialIndices.length === 0 ? [undefined] : options.materialIndices.map(index => `material-${index}`),
    )
    expect(geometry.meshes[0]!.primitiveIds).toEqual(geometry.primitives.map(primitive => primitive.id))
    const source = createModelSceneSource({ ...geometry,
      info: { scenes: 1, nodes: 1, meshes: 1, primitives: geometry.primitives.length, materials: 2, textures: 0, animations: 0, geometryAccess: 'decoded' },
    })
    const first = await source.primitive!(geometry.primitives[0]!.id, { maxBytes: budget.maxScalarBytes })
    const saved = first.positions[0]
    first.positions[0] = 999
    expect((await source.primitive!(geometry.primitives[0]!.id, { maxBytes: budget.maxScalarBytes })).positions[0]).toBe(saved)
    if (geometry.primitives.length > 1) {
      expect((await source.primitive!(geometry.primitives[1]!.id, { maxBytes: budget.maxScalarBytes })).positions[0]).toBe(saved)
      expect(() => projectM3MaterialBatches(regions, material.primitiveBindings, { ...budget, maxNodes: 2 })).toThrow('maxNodes')
    }
    expect(() => projectM3MaterialBatches(regions, material.primitiveBindings, { ...budget, maxScalarBytes: geometry.decodedBytes - 1 })).toThrow('maxScalarBytes')
    expect(() => projectM3MaterialBatches(regions, material.primitiveBindings, budget, AbortSignal.abort())).toThrow('cancelled')
  })

  it('retains the fifth UV set, handedness, colors and region-relative bone lookup through the common source', async () => {
    const input = new Uint8Array(await readFile(new URL('model.m3', fixtures)))
    const sections = await M3SectionList.load(input.slice().buffer, await readFile(schema, 'utf8'))
    const flags = 0x60 | 0x200 | 0x800000 | 0x1000000 | 0x1e0000 | 0x40000000
    const description = M3StructureDescription.getVertexDescription(flags, sections.structureHistories)
    const vertex = description.instance()
    Object.assign(vertex.pos, { x: 1, y: 2, z: 3 })
    Object.assign(vertex.normal, { x: 127, y: 127, z: 255 })
    Object.assign(vertex.tan, { x: 255, y: 127, z: 127 })
    Object.assign(vertex.col, { r: 255, g: 128, b: 0, a: 255 })
    Object.assign(vertex, { sign: 0, weight0: 255, lookup0: 1, weight1: 0, lookup1: 0, weight2: 0, lookup2: 0, weight3: 0, lookup3: 0 })
    for (let set = 0; set < 5; set++) Object.assign(vertex[`uv${set}`], { x: 256 * (set + 1), y: 128 })
    const buffer = new ArrayBuffer(description.size)
    vertex.toBuffer(buffer)
    const vertexRef = { rawBytes: buffer }
    const faceRef = { content: [0, 0, 0] }
    const regionRef = { content: [{ first_vertex_index: 0, vertex_count: 1, first_face_index: 0, face_count: 3, first_bone_lookup_index: 1, uv_multiply: 16, uv_offset: 0, desc: { version: 3 } }] }
    const divisionRef = { content: [{ faces: faceRef, regions: regionRef }] }
    const fake = {
      model: { vertex_flags: flags, vertices: vertexRef, divisions: divisionRef, bone_lookup: { content: [99, 3, 7] } },
      structureHistories: sections.structureHistories,
      getSectionByReference: value => value ?? null,
    }
    const load = vi.spyOn(M3SectionList, 'load').mockResolvedValue(fake)
    try {
      const geometry = await decodeM3Geometry(input, budget)
      const source = createModelSceneSource({
        info: { scenes: 1, nodes: 1, meshes: 1, primitives: 1, materials: 0, textures: 0, animations: 0, geometryAccess: 'decoded' },
        ...geometry,
      })
      const primitive = await source.primitive!(geometry.primitives[0]!.id, { maxBytes: geometry.decodedBytes })
      expect(primitive.textureCoordinateSets?.map(channel => channel.set)).toEqual([0, 1, 2, 3, 4])
      expect(values(primitive.textureCoordinateSets?.[4]?.coordinates)).toEqual([0.625, 0.0625])
      expect(primitive.tangents?.[3]).toBe(-1)
      expect(values(primitive.boneIndices)).toEqual([7, 3, 3, 3])
      expect(values(primitive.boneWeights)).toEqual([1, 0, 0, 0])
      expect(values(primitive.colors)).toEqual(values(new Float32Array([1, 128 / 255, 0, 1])))
      await expect(decodeM3Geometry(input, { ...budget, maxScalarBytes: geometry.decodedBytes - 1 })).rejects.toThrow('maxScalarBytes')
    } finally { load.mockRestore() }
  })

  it('hides a cloth simulation cage and draws the garment it drives', async () => {
    // WhiteoutFlakes' shipped pair: Hidden|ClothSimulated (0x1|0x4) is the cage the game never
    // draws, Hidden|Placeholder|ClothInfluenced (0x1|0x2|0x8) the garment it draws.
    const input = new Uint8Array(await readFile(new URL('model.m3', fixtures)))
    const sections = await M3SectionList.load(input.slice().buffer, await readFile(schema, 'utf8'))
    const flags = 0x60 | 0x200 | 0x40000000
    const description = M3StructureDescription.getVertexDescription(flags, sections.structureHistories)
    const vertex = description.instance()
    Object.assign(vertex.pos, { x: 1, y: 2, z: 3 })
    Object.assign(vertex, { sign: 0, weight0: 255, lookup0: 0, weight1: 0, lookup1: 0, weight2: 0, lookup2: 0, weight3: 0, lookup3: 0 })
    const buffer = new ArrayBuffer(description.size)
    vertex.toBuffer(buffer)
    const region = (regionFlags: number, firstFace: number) => ({
      first_vertex_index: 0, vertex_count: 1, first_face_index: firstFace, face_count: 3,
      first_bone_lookup_index: 0, uv_multiply: 16, uv_offset: 0, flags: regionFlags, desc: { version: 3 },
    })
    const fake = {
      model: {
        vertex_flags: flags,
        vertices: { rawBytes: buffer },
        divisions: { content: [{ faces: { content: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, regions: { content: [region(0, 0), region(0x1 | 0x4, 3), region(0x1 | 0x2 | 0x8, 6)] } }] },
        bone_lookup: { content: [0] },
      },
      structureHistories: sections.structureHistories,
      getSectionByReference: value => value ?? null,
    }
    const load = vi.spyOn(M3SectionList, 'load').mockResolvedValue(fake)
    try {
      const geometry = await decodeM3Geometry(input, budget)
      expect(geometry.primitives.map(primitive => primitive.hidden)).toEqual([undefined, true, undefined])
    } finally { load.mockRestore() }
  })
})
