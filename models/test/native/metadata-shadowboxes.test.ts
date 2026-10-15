import { describe, expect, it } from 'vitest'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { buildShadowboxes } from '../../dist/m3/native/builder/metadata.js'

describe('M3 SHBX metadata', () => {
  it('preserves the matrix and derives its world position and oriented-box extents', () => {
    const shadowboxRef = reference(1)
    const source = structure({ shadowboxes: shadowboxRef })
    const shadowbox = structure({
      matrix: matrix([2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0], [5, 6, 7, 1]),
    })

    expect(buildShadowboxes(source, resolver(new Map([[shadowboxRef, [shadowbox]]])))).toEqual([
      {
        index: 0,
        name: 'Shadowbox_0',
        matrix4: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1],
        position: [5, 6, 7],
        halfExtents: [2, 3, 4],
        size: [4, 6, 8],
      },
    ])
  })
})

function reference(index: number): M3Reference {
  return { entries: 1, index, flags: 0 } as M3Reference
}

function structure(values: Record<string, unknown>): M3StructureData {
  return values as unknown as M3StructureData
}

function matrix(
  x: readonly [number, number, number, number],
  y: readonly [number, number, number, number],
  z: readonly [number, number, number, number],
  w: readonly [number, number, number, number],
): M3StructureData {
  const vector = (value: readonly [number, number, number, number]) =>
    structure({ x: value[0], y: value[1], z: value[2], w: value[3] })
  return structure({ x: vector(x), y: vector(y), z: vector(z), w: vector(w) })
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
