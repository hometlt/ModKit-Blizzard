import { describe, expect, it } from 'vitest'
import type { M3Reference, M3Section, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import {
  M3AnimationEvaluator,
  parseAnimationReference,
  valueToComponents,
} from '../../dist/m3/native/animation/evaluator.js'

/**
 * Hand-built STG/STC/STS/SD fixtures (P5 S2): the evaluator is exercised
 * against a synthetic section graph, no binary parsing involved.
 */
class FixtureResolver implements SectionResolver {
  private readonly sections = new Map<M3Reference, M3Section>()
  private nextIndex = 1

  section(content: unknown[]): M3Reference {
    const ref: M3Reference = { entries: content.length, index: this.nextIndex++ }
    this.sections.set(ref, { content } as unknown as M3Section)
    return ref
  }

  getSectionByReference(ref: M3Reference | null | undefined): M3Section | null {
    if (!ref) return null
    return this.sections.get(ref) ?? null
  }
}

function struct(fields: Record<string, unknown>): M3StructureData {
  return fields as unknown as M3StructureData
}

interface SdSpec {
  frames: number[]
  keys: unknown[]
  fend?: number
}

interface StcSpec {
  animIds: number[]
  /** packed (sdFieldIndex << 16) | sdIndex, aligned with animIds */
  animRefs: number[]
  stsIndex: number
  concurrent?: number
  sd3v?: SdSpec[]
  sd4q?: SdSpec[]
  sdr3?: SdSpec[]
}

interface ModelSpec {
  /** per sequence: list of stc indices */
  stgs: number[][]
  stcs: StcSpec[]
  /** per STS: anim id membership */
  stss: number[][]
}

function buildModel(resolver: FixtureResolver, spec: ModelSpec): M3StructureData {
  const sdSection = (blocks: SdSpec[] | undefined): M3Reference | undefined => {
    if (!blocks) return undefined
    return resolver.section(
      blocks.map(block =>
        struct({
          frames: resolver.section(block.frames),
          flags: 0,
          fend: block.fend ?? block.frames[block.frames.length - 1] ?? 0,
          keys: resolver.section(block.keys),
        }),
      ),
    )
  }

  const stcs = spec.stcs.map(stc =>
    struct({
      concurrent: stc.concurrent ?? 0,
      priority: 0,
      sts_index: stc.stsIndex,
      anim_ids: resolver.section(stc.animIds),
      anim_refs: resolver.section(stc.animRefs),
      sd3v: sdSection(stc.sd3v),
      sd4q: sdSection(stc.sd4q),
      sdr3: sdSection(stc.sdr3),
    }),
  )
  const stgs = spec.stgs.map(stcIndices => struct({ stc_indices: resolver.section(stcIndices) }))
  const stss = spec.stss.map(animIds => struct({ anim_ids: resolver.section(animIds) }))

  return struct({
    sequence_transformation_groups: resolver.section(stgs),
    sequence_transformation_collections: resolver.section(stcs),
    sts: resolver.section(stss),
  })
}

function animRef(id: number, interpolation: number, initValue: unknown): M3StructureData {
  return struct({
    header: struct({ interpolation, flags: 0, id }),
    default: initValue,
  })
}

const SD3V = 2 << 16
const SD4Q = 3 << 16

describe('parseAnimationReference', () => {
  it('exposes interpolation, flags, id, and initValue components', () => {
    const parsed = parseAnimationReference(animRef(0x42, 1, { x: 1, y: 2, z: 3 }))
    expect(parsed).toMatchObject({
      interpolationType: 1,
      animFlags: 0,
      animId: 0x42,
      initValue: [1, 2, 3],
    })
  })

  it('returns null for missing references', () => {
    expect(parseAnimationReference(undefined)).toBeNull()
  })
})

describe('valueToComponents', () => {
  it('flattens numbers, vectors, quats, and colors', () => {
    expect(valueToComponents(2.5)).toEqual([2.5])
    expect(valueToComponents({ x: 1, y: 2 })).toEqual([1, 2])
    expect(valueToComponents({ x: 1, y: 2, z: 3 })).toEqual([1, 2, 3])
    expect(valueToComponents({ x: 1, y: 2, z: 3, w: 4 })).toEqual([1, 2, 3, 4])
    expect(valueToComponents({ r: 255, g: 128, b: 0, a: 64 })).toEqual([255, 128, 0, 64])
  })
})

describe('M3AnimationEvaluator', () => {
  function drivenModel(
    resolver: FixtureResolver,
    options: { interpolation?: number; concurrent?: number } = {},
  ) {
    return buildModel(resolver, {
      stgs: [[0], []], // sequence 0 drives animId 100; sequence 1 drives nothing
      stcs: [
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          concurrent: options.concurrent ?? 0,
          sd3v: [
            {
              frames: [0, 1000],
              keys: [
                { x: 0, y: 0, z: 0 },
                { x: 10, y: 20, z: 30 },
              ],
              fend: 1000,
            },
          ],
        },
      ],
      stss: [[100]],
    })
  }

  it('samples a driven reference linearly', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver), resolver)
    const ref = animRef(100, 1, { x: 5, y: 5, z: 5 })
    expect(evaluator.sampleAnimRef(0, ref, 500)).toEqual([5, 10, 15])
  })

  it('falls back to initValue for sequences that do not drive the id (bind pose)', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver), resolver)
    const ref = animRef(100, 1, { x: 5, y: 5, z: 5 })
    expect(evaluator.sampleAnimRef(1, ref, 500)).toEqual([5, 5, 5])
  })

  it('does not gate on header.flags — flags 0 with valid data still samples', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver), resolver)
    const ref = animRef(100, 1, { x: 5, y: 5, z: 5 })
    // animRef() builds header.flags = 0; sequence 0 must still resolve it.
    expect(evaluator.resolveAnimRef(0, 100)).not.toBeNull()
    expect(evaluator.sampleAnimRef(0, ref, 1000)).toEqual([10, 20, 30])
  })

  it('steps instead of interpolating when interpolationType is 0', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver), resolver)
    const ref = animRef(100, 0, { x: 5, y: 5, z: 5 })
    expect(evaluator.sampleAnimRef(0, ref, 999)).toEqual([0, 0, 0])
    expect(evaluator.sampleAnimRef(0, ref, 1000)).toEqual([10, 20, 30])
  })

  it('clamps before the first key and holds after the last', () => {
    const resolver = new FixtureResolver()
    const model = buildModel(resolver, {
      stgs: [[0]],
      stcs: [
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          sd3v: [
            {
              frames: [200, 800],
              keys: [
                { x: 1, y: 1, z: 1 },
                { x: 9, y: 9, z: 9 },
              ],
            },
          ],
        },
      ],
      stss: [[100]],
    })
    const evaluator = new M3AnimationEvaluator(model, resolver)
    const ref = animRef(100, 1, { x: 0, y: 0, z: 0 })
    expect(evaluator.sampleAnimRef(0, ref, 0)).toEqual([1, 1, 1]) // clamp
    expect(evaluator.sampleAnimRef(0, ref, 5000)).toEqual([9, 9, 9]) // hold
  })

  it('wraps concurrent STC sampling by the SD fend', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver, { concurrent: 1 }), resolver)
    const ref = animRef(100, 1, { x: 0, y: 0, z: 0 })
    expect(evaluator.sampleAnimRef(0, ref, 1500)).toEqual(evaluator.sampleAnimRef(0, ref, 500))
  })

  it('first STC in stored order wins when several drive the same id', () => {
    const resolver = new FixtureResolver()
    const model = buildModel(resolver, {
      stgs: [[1, 0]], // stored order: STC 1 first
      stcs: [
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          sd3v: [{ frames: [0], keys: [{ x: 111, y: 0, z: 0 }] }],
        },
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          sd3v: [{ frames: [0], keys: [{ x: 222, y: 0, z: 0 }] }],
        },
      ],
      stss: [[100]],
    })
    const evaluator = new M3AnimationEvaluator(model, resolver)
    const ref = animRef(100, 1, { x: 0, y: 0, z: 0 })
    expect(evaluator.sampleAnimRef(0, ref, 0)).toEqual([222, 0, 0])
    expect(evaluator.resolveAnimRef(0, 100)?.stcIndex).toBe(1)
  })

  it('STS membership validates per STC — ids outside the STS are undriven', () => {
    const resolver = new FixtureResolver()
    const model = buildModel(resolver, {
      stgs: [[0]],
      stcs: [
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          sd3v: [{ frames: [0], keys: [{ x: 1, y: 2, z: 3 }] }],
        },
      ],
      stss: [[999]], // STS does not list animId 100
    })
    const evaluator = new M3AnimationEvaluator(model, resolver)
    const ref = animRef(100, 1, { x: 7, y: 7, z: 7 })
    expect(evaluator.resolveAnimRef(0, 100)).toBeNull()
    expect(evaluator.sampleAnimRef(0, ref, 0)).toEqual([7, 7, 7])
  })

  it('falls back to initValue when the SD block has no keys', () => {
    const resolver = new FixtureResolver()
    const model = buildModel(resolver, {
      stgs: [[0]],
      stcs: [
        {
          animIds: [100],
          animRefs: [SD3V | 0],
          stsIndex: 0,
          sd3v: [{ frames: [], keys: [] }],
        },
      ],
      stss: [[100]],
    })
    const evaluator = new M3AnimationEvaluator(model, resolver)
    const ref = animRef(100, 1, { x: 4, y: 4, z: 4 })
    expect(evaluator.sampleAnimRef(0, ref, 0)).toEqual([4, 4, 4])
  })

  it('slerps quaternion tracks along the shortest path', () => {
    const resolver = new FixtureResolver()
    const model = buildModel(resolver, {
      stgs: [[0]],
      stcs: [
        {
          animIds: [200],
          animRefs: [SD4Q | 0],
          stsIndex: 0,
          sd4q: [
            {
              frames: [0, 1000],
              // identity → negated 90° about Z: slerp must flip the sign, not spin the long way
              keys: [
                { x: 0, y: 0, z: 0, w: 1 },
                { x: 0, y: 0, z: -Math.SQRT1_2, w: -Math.SQRT1_2 },
              ],
            },
          ],
        },
      ],
      stss: [[200]],
    })
    const evaluator = new M3AnimationEvaluator(model, resolver)
    const ref = animRef(200, 1, { x: 0, y: 0, z: 0, w: 1 })
    const halfway = evaluator.sampleAnimRef(0, ref, 500)
    // Shortest path to +90° about Z at t=0.5 is 45°: z = sin(22.5°), w = cos(22.5°).
    expect(halfway[2]).toBeCloseTo(Math.sin(Math.PI / 8), 5)
    expect(halfway[3]).toBeCloseTo(Math.cos(Math.PI / 8), 5)
  })

  it('reuses the caller-provided out array (allocation-free sampling)', () => {
    const resolver = new FixtureResolver()
    const evaluator = new M3AnimationEvaluator(drivenModel(resolver), resolver)
    const ref = animRef(100, 1, { x: 5, y: 5, z: 5 })
    const out: number[] = []
    const returned = evaluator.sampleAnimRef(0, ref, 500, out)
    expect(returned).toBe(out)
    expect(out).toEqual([5, 10, 15])
  })
})
