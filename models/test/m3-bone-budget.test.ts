import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'

import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { encodeM3RenderModel } from '../dist/m3/native/encoder.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'

installM3PlatformAdapters({ DOMParser })

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxScalarBytes: 16_777_216,
  maxDiagnostics: 100,
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * `count` triangles, the nth rigidly on the nth bone.
 *
 * A region's per-vertex bone lookup is one byte and StarCraft II binds far fewer matrices than
 * that, so this is the shape that forces the writer's hand: one mesh naming more bones than any
 * single draw can bind.
 */
function fannedModel(count: number) {
  const positions = new Float32Array(count * 9)
  const uvs = new Float32Array(count * 6)
  const indices = new Uint32Array(count * 3)
  const boneIndices = new Uint32Array(count * 12)
  const boneWeights = new Float32Array(count * 12)
  for (let triangle = 0; triangle < count; triangle += 1)
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle * 3 + corner
      positions[vertex * 3] = triangle + corner
      positions[vertex * 3 + 1] = corner
      indices[vertex] = vertex
      boneIndices[vertex * 4] = triangle
      boneWeights[vertex * 4] = 1
    }
  return {
    materials: [],
    animations: [],
    effects: { particles: [], ribbons: [], forces: [], warps: [], projectors: [] },
    skeleton: {
      bones: Array.from({ length: count }, (_unused, index) => ({
        name: `bone-${String(index)}`,
        parentIndex: -1,
        flags: 0,
        inverseBindMatrix: identity(),
      })),
    },
    meshes: [
      {
        name: 'fan',
        materialIndex: 0,
        positions,
        uvs,
        indices,
        boneIndices,
        boneWeights,
      },
    ],
  }
}

async function encode(model: unknown) {
  return encodeM3RenderModel(model, { includeTextures: false }, {
    structuresXml: await readFile(
      join(import.meta.dirname, '..', 'src', 'm3', 'native', 'structures.xml'),
      'utf8',
    ),
  }) as Promise<{ bytes: Uint8Array; issues: { code: string; message: string }[] }>
}

/** The distinct bones each written region actually binds. */
async function regionBones(bytes: Uint8Array): Promise<number[]> {
  const decoded = (await decodeM3Geometry(bytes, budget)) as {
    primitives: { boneIndices?: ArrayLike<number> }[]
  }
  return decoded.primitives.map(primitive => new Set(primitive.boneIndices ?? []).size)
}

describe('writing a mesh that names more bones than a region can bind', () => {
  it('divides it into regions that each stay inside the budget', async () => {
    const written = await encode(fannedModel(100))
    const bones = await regionBones(written.bytes)
    expect(bones.length).toBeGreaterThan(1)
    for (const count of bones) expect(count).toBeLessThanOrEqual(64)
    // Every bone the mesh used is still bound by some region: the split moves geometry between
    // regions, it does not drop influences.
    expect(bones.reduce((total, count) => total + count, 0)).toBe(100)
    // And the writer says it split rather than doing it silently.
    expect(written.issues.map(issue => issue.code)).toContain('m3-region-bone-budget')
  })

  it('leaves a mesh that already fits as one region', async () => {
    const written = await encode(fannedModel(40))
    const bones = await regionBones(written.bytes)
    expect(bones).toEqual([40])
    expect(written.issues.map(issue => issue.code)).not.toContain('m3-region-bone-budget')
  })
})
