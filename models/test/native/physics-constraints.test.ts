import { describe, expect, it } from 'vitest'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { buildPhysicsConstraints } from '../../dist/m3/native/builder/metadata.js'

function structure(values: Record<string, unknown>): M3StructureData {
  return values as unknown as M3StructureData
}

describe('buildPhysicsConstraints', () => {
  it('resolves PHCT rigid-body links, dependents, flags, and break force', () => {
    const constraintsRef: M3Reference = { entries: 1, index: 1, flags: 0 }
    const dependentsRef: M3Reference = { entries: 3, index: 2, flags: 0 }
    const sections = new Map<M3Reference, unknown[]>([
      [
        constraintsRef,
        [
          structure({
            dependents: dependentsRef,
            rigid_body1: 4,
            rigid_body2: 9,
            flags: 0x12,
            break_force: 125.5,
          }),
        ],
      ],
      [dependentsRef, [2, 5, 8]],
    ])
    const resolver: SectionResolver = {
      getSectionByReference: ref =>
        ref && sections.has(ref) ? ({ content: sections.get(ref) } as never) : null,
    }

    expect(
      buildPhysicsConstraints(structure({ physics_constraints: constraintsRef }), resolver),
    ).toEqual([
      {
        index: 0,
        dependentIndices: [2, 5, 8],
        rigidBodyIndex0: 4,
        rigidBodyIndex1: 9,
        flags: 0x12,
        breakForce: 125.5,
      },
    ])
  })
})
