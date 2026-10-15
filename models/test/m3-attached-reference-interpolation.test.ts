import { describe, expect, it } from 'vitest'
import { M3AnimationReferenceTrackExtractor } from '../src/m3/native/animation/tracks.js'
import { projectM3Animations } from '../src/m3/animation-projection.js'
import type { M3Reference, M3Section, M3StructureData, SectionResolver } from '../src/m3/native/types.js'

// Synthetic section graphs qualify the attached policy, not native engine playback or binary parsing.
const budget = { maxDepth: 128, maxNodes: 100_000, maxScalarBytes: 8 * 1024 * 1024 }
type Slot = 'sd2v' | 'sd3v' | 'sdr3' | 'sd4q' | 'sdfg'
const slots = { sd2v: 1, sd3v: 2, sd4q: 3, sdr3: 5, sdfg: 11 } as const

/** Supply bounded section identities without depending on installed game files. */
class Sections implements SectionResolver {
  model = record({})
  private readonly sections = new Map<M3Reference, M3Section>()

  /** Register authored values by reference identity. */
  add(content: unknown[]): M3Reference {
    const ref = { entries: content.length, index: this.sections.size }
    this.sections.set(ref, { content } as M3Section)
    return ref
  }

  /** Resolve only the exact registered reference. */
  getSectionByReference(ref: M3Reference | null | undefined): M3Section | null {
    return ref == null ? null : this.sections.get(ref) ?? null
  }
}

/** Represent a parsed native record; the fixtures intentionally bypass binary decoding. */
function record(value: Record<string, unknown>): M3StructureData {
  return value as unknown as M3StructureData
}

/** Keep source header/flags independent from the sidecar's declarations. */
function reference(interpolation: number, flags: unknown, id = 100): M3StructureData {
  return record({ header: record({ interpolation, flags, id }), default: 0 })
}

/** Build one driven property, two named sequences and an optional sequence window. */
function fixture(slot: Slot, options: {
  frames?: number[]; keys?: unknown[]; start?: number; end?: number; concurrent?: boolean
} = {}) {
  const sections = new Sections()
  const frames = options.frames ?? [0, 1000]
  const vector = slot === 'sd2v' ? { x: 10, y: 20 } : slot === 'sd3v' ? { x: 10, y: 20, z: 30 }
    : slot === 'sd4q' ? { x: 0, y: 0, z: -Math.SQRT1_2, w: -Math.SQRT1_2 } : 10
  const zero = slot === 'sd2v' ? { x: 0, y: 0 } : slot === 'sd3v' ? { x: 0, y: 0, z: 0 }
    : slot === 'sd4q' ? { x: 0, y: 0, z: 0, w: 1 } : 0
  const keys = options.keys ?? [zero, vector]
  const sd = record({ frames: sections.add(frames), keys: sections.add(keys), fend: 1000, flags: 0 })
  const stc = record({ anim_ids: sections.add([100]), anim_refs: sections.add([slots[slot] << 16]),
    sts_index: 0, concurrent: options.concurrent ? 1 : 0, priority: 0, [slot]: sections.add([sd]) })
  const sequences = ['Stand', 'Walk'].map(name => record({
    name: sections.add([...name].map(char => char.charCodeAt(0))),
    anim_ms_start: options.start ?? 0, anim_ms_end: options.end ?? 1000, flags: 0,
  }))
  const sideReference = reference(1, 0x10)
  sections.model = record({
    sequences: sections.add(sequences), sequence_transformation_groups: sections.add([
      record({ stc_indices: sections.add([0]) }), record({ stc_indices: sections.add([0]) }),
    ]), sequence_transformation_collections: sections.add([stc]),
    sts: sections.add([record({ anim_ids: sections.add([100]) })]),
    bones: sections.add([record({ location: sideReference, flags: 0 })]),
  })
  return { sections, frames, keys }
}

/** Give the projector exact base-owned declarations over the same synthetic section owner. */
function binding(sections: Sections, bone: M3StructureData) {
  return { model: record({ bones: sections.add([bone]) }),
    getSectionByReference: sections.getSectionByReference.bind(sections) }
}

describe('reference-qualified attached continuous interpolation', () => {
  for (const slot of ['sd2v', 'sd3v', 'sdr3'] as const) {
    for (const interpolation of [0, 1]) for (const flags of [0, 4, 16, 20]) {
      it(`${slot} header${interpolation}/flags${flags}: attached mode and boundary samples agree`, () => {
        const { sections } = fixture(slot, { start: 250, end: 750 })
        const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections)
        const ref = reference(interpolation, flags)
        const rawHeader = { ...ref.header as M3StructureData }
        const attached = extractor.extract(ref, { attachedBaseReference: true })[0]!.track
        const step = (flags & 16) !== 0
        expect(attached.lineType).toBe(step ? 0 : 1)
        expect(attached.keys.map(key => key.frame)).toEqual([0, 0.5])
        expect(attached.keys.map(key => key.vector[0])).toEqual(step ? [0, 0] : [2.5, 7.5])
        const own = extractor.extract(ref)[0]!.track
        expect(own.lineType).toBe(interpolation)
        expect(own.keys.map(key => key.vector[0])).toEqual(interpolation === 0 ? [0, 0] : [2.5, 7.5])
        expect(ref.header).toEqual(rawHeader)
      })
    }
  }

  it.each([false, true])('keeps default and attached treatments independent, attached-first=%s', first => {
    const { sections } = fixture('sdr3', { start: 500, end: 500 })
    const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections)
    const ref = reference(0, 0)
    for (const attached of [first, !first, first]) {
      const track = extractor.extract(ref, attached ? { attachedBaseReference: true } : {})[0]!.track
      expect(track.keys[0]!.vector).toEqual([attached ? 5 : 0])
    }
  })

  it('retains endpoints, signed lead-ins and existing duplicate-onset repair without changing raw keys', () => {
    const lead = fixture('sdr3', { frames: [-999, 1000], keys: [-999, 1000] })
    const leadTrack = new M3AnimationReferenceTrackExtractor(lead.sections.model, lead.sections)
      .extract(reference(0, 0), { attachedBaseReference: true })[0]!.track
    expect(leadTrack.keys).toEqual([{ frame: 0, vector: [0] }, { frame: 1, vector: [1000] }])
    expect(lead.frames).toEqual([-999, 1000])
    const duplicate = fixture('sdr3', { frames: [0, 0, 1000], keys: [1, 10, 20] })
    const extractor = new M3AnimationReferenceTrackExtractor(duplicate.sections.model, duplicate.sections, undefined, true)
    const track = extractor.extract(reference(0, 0), { attachedBaseReference: true })[0]!.track
    expect(track.keys).toEqual([{ frame: 0, vector: [1] }, { frame: 0.001, vector: [10.01] }, { frame: 1, vector: [20] }])
    expect(extractor.boundaryResampledChannels).toBe(2) // one repair per declared sequence
    const raw = new M3AnimationReferenceTrackExtractor(duplicate.sections.model, duplicate.sections)
      .extract(reference(0, 0), { attachedBaseReference: true })[0]!.track
    expect(raw.keys.map(key => key.frame)).toEqual([0, 0, 1])
    expect(duplicate.frames).toEqual([0, 0, 1000])
    expect(duplicate.keys).toEqual([1, 10, 20])
  })

  it.each(['sd4q', 'sdfg'] as const)('does not reinterpret excluded %s even with an opt-in marker', slot => {
    const { sections } = fixture(slot, { start: 250, end: 750 })
    const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections)
    for (const interpolation of [0, 1]) {
      const ref = reference(interpolation, 16)
      expect(extractor.extract(ref, { attachedBaseReference: true })).toEqual(extractor.extract(ref))
    }
  })

  it('uses the explicit step flag during the existing duplicate-onset repair', () => {
    const { sections } = fixture('sdr3', { frames: [0, 0, 1000], keys: [1, 10, 20] })
    const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections, undefined, true)
    const track = extractor.extract(reference(1, 16), { attachedBaseReference: true })[0]!.track
    expect(track.lineType).toBe(0)
    expect(track.keys).toEqual([{ frame: 0, vector: [1] }, { frame: 0.001, vector: [10] }, { frame: 1, vector: [20] }])
  })

  it.each([-1, 65536, 1.5, NaN, '16'])('refuses malformed attached flags %s before coercion', flags => {
    const { sections } = fixture('sdr3')
    const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections)
    expect(() => extractor.extract(reference(0, flags), { attachedBaseReference: true })).toThrow(/uint16/)
    expect(() => extractor.extract(reference(0, flags))).not.toThrow()
  })

  it('preserves concurrent clock metadata, unresolved membership and requested sequence subset', () => {
    const { sections } = fixture('sdr3', { concurrent: true })
    const extractor = new M3AnimationReferenceTrackExtractor(sections.model, sections, new Set([1]))
    expect(extractor.extract(reference(0, 0), { attachedBaseReference: true })).toEqual([
      { sequenceIndex: 1, concurrent: true, wrapSeconds: 1,
        track: { lineType: 1, globalSeqId: null, keys: [{ frame: 0, vector: [0] }, { frame: 1, vector: [10] }] } },
    ])
    expect(extractor.extract(reference(0, 0, 999), { attachedBaseReference: true })).toEqual([])
  })
})

describe('attached base-owned translation and scale projection', () => {
  it.each(['location', 'scale'] as const)('uses the base %s declaration, leaving sidecar/default policy intact', field => {
    const { sections } = fixture('sd3v', { start: 250, end: 750 })
    const ref = reference(0, 0)
    const base = binding(sections, record({ [field]: ref, flags: 0 }))
    const result = projectM3Animations(sections, budget, undefined, base)
    expect(result.clips[0]!.channels[0]).toMatchObject({ kind: field === 'scale' ? 'scale' : 'translation', interpolation: 'linear' })
    expect(result.clips[0]!.channels[0]!.samples!.map(sample => sample.value)).toEqual([[2.5, 5, 7.5], [7.5, 15, 22.5]])
    expect(projectM3Animations(sections, budget).clips[0]!.channels[0]!.interpolation).toBe('linear')
    expect(ref.header).toMatchObject({ interpolation: 0, flags: 0 })
    expect(() => projectM3Animations(sections, budget, AbortSignal.abort(), base)).toThrow(/cancelled/)
    expect(() => projectM3Animations(sections, { ...budget, maxNodes: 1 }, undefined, base)).toThrow(/maxNodes/)
    expect(projectM3Animations(sections, budget, undefined, base, ['Walk']).nativeSequenceIndices).toEqual([1])
  })

  it('keeps quaternion and discrete projection modes unchanged and rejects incompatible TRS binding', () => {
    const quat = fixture('sd4q')
    const base = binding(quat.sections, record({ rotation: reference(0, 0), flags: 0 }))
    expect(projectM3Animations(quat.sections, budget, undefined, base).clips[0]!.channels[0]!.interpolation).toBe('step')
    const scalar = fixture('sdr3')
    expect(() => projectM3Animations(scalar.sections, budget, undefined,
      binding(scalar.sections, record({ location: reference(0, 0), flags: 0 })))).toThrow(/incompatible location/)
    const discrete = projectM3Animations(scalar.sections, budget, undefined,
      binding(scalar.sections, record({ batching: reference(0, 0), flags: 0 })))
    expect(discrete.clips[0]!.channels[0]!.interpolation).toBe('step')
  })
})
