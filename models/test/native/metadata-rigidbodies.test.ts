import { describe, expect, it } from 'vitest'

import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { buildRigidBodies } from '../../dist/m3/native/builder/metadata.js'

describe('buildRigidBodies', () => {
  it('extracts all PHSH primitives and mesh vertices from physics_rigidbodies', () => {
    const rigidBodies = reference(1)
    const shapes = reference(2)
    const vertices = reference(3)
    const model = structure({ physics_rigidbodies: rigidBodies })
    const sections = resolver(
      new Map([
        [
          rigidBodies,
          [
            structure({
              bone: 7,
              physics_shape: shapes,
              mass: 12,
              friction: 0.3,
              bounce: 0.8,
              flags: 0x9,
            }),
          ],
        ],
        [
          shapes,
          [
            structure({
              shape: 0,
              matrix: matrix(1, 2, 3),
              size0: 4,
              size1: 5,
              size2: 6,
            }),
            structure({
              shape: 4,
              matrix: matrix(0, 0, 0),
              vertices,
            }),
          ],
        ],
        [vertices, [structure({ x: -1, y: 2, z: 3 }), structure({ x: 4, y: 5, z: 6 })]],
      ]),
    )

    const result = buildRigidBodies(model, sections)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      boneIndex: 7,
      shape: 'Box',
      size: [4, 5, 6],
      mass: 12,
      friction: 0.3,
      restitution: 0.8,
      flags: 0x9,
    })
    expect(result[0]?.shapes).toHaveLength(2)
    expect(result[0]?.shapes[0]?.matrix4.slice(12, 15)).toEqual([1, 2, 3])
    expect(result[0]?.shapes[1]).toMatchObject({
      shape: 'ConvexHull',
      vertices: [
        [-1, 2, 3],
        [4, 5, 6],
      ],
    })
  })
})

function reference(index: number): M3Reference {
  return { entries: 1, index, flags: 0 }
}

function structure(values: Record<string, unknown>): M3StructureData {
  return values as unknown as M3StructureData
}

function matrix(x: number, y: number, z: number): M3StructureData {
  return structure({
    x: structure({ x: 1, y: 0, z: 0, w: 0 }),
    y: structure({ x: 0, y: 1, z: 0, w: 0 }),
    z: structure({ x: 0, y: 0, z: 1, w: 0 }),
    w: structure({ x, y, z, w: 1 }),
  })
}

function resolver(contents: Map<M3Reference, unknown[]>): SectionResolver {
  return {
    getSectionByReference: ref => {
      if (!ref) return null
      const content = contents.get(ref)
      return content ? ({ content } as never) : null
    },
  }
}
