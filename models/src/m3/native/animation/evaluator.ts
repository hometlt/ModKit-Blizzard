import type { M3Reference, M3StructureData, SectionResolver } from '../types.js'

/**
 * M3 animation evaluator (OPUS_TASK_P5_M3_ANIMATION.md, D1).
 *
 * Ports the verified mdx-m3-viewer resolution chain:
 *   sequence i ↔ STG_ i → stc_indices (stored order) → STC → STS membership
 *   → first hit wins → SD sampling; no hit → the reference's initValue
 *   (the bind-pose fallback).
 *
 * Validity is decided purely by STS membership — never by
 * `AnimationReferenceHeader.flags` (the old gate skipped valid tracks and
 * applied stale ones).
 */

/** STC SD reference fields in packed anim_refs order (high u16 selects one). */
export const SD_FIELDS = [
  'sdev',
  'sd2v',
  'sd3v',
  'sd4q',
  'sdcc',
  'sdr3',
  'sdu8',
  'sds6',
  'sdu6',
  'sds3',
  'sdu3',
  'sdfg',
  'sdmb',
] as const
export type SdFieldName = (typeof SD_FIELDS)[number]

export interface ParsedAnimationReference {
  /** 0 = step/constant, 1 = linear (quats slerp). */
  interpolationType: number
  /** Undocumented; stored for diagnostics, never branched on. */
  animFlags: number
  animId: number
  /** Bind-pose value components (see valueToComponents). */
  initValue: number[]
}

/** Flatten a parsed key/init value into numeric components. */
export function valueToComponents(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.x === 'number') {
      return typeof v.w === 'number'
        ? [v.x as number, v.y as number, v.z as number, v.w]
        : typeof v.z === 'number'
          ? [v.x as number, v.y as number, v.z]
          : [v.x as number, v.y as number]
    }
    if (typeof v.r === 'number') {
      return [v.r as number, (v.g as number) ?? 0, (v.b as number) ?? 0, (v.a as number) ?? 255]
    }
  }
  return [0]
}

/**
 * First-class view of an AnimationReference struct
 * ({ header: { interpolation, flags, id }, default, null }) — P5 S1.
 */
export function parseAnimationReference(
  ref: M3StructureData | null | undefined,
): ParsedAnimationReference | null {
  if (!ref) return null
  const header = ref.header as M3StructureData | undefined
  if (!header || typeof header.id !== 'number') return null
  return {
    interpolationType: (header.interpolation as number) ?? 0,
    animFlags: (header.flags as number) ?? 0,
    animId: header.id as number,
    initValue: valueToComponents(ref.default),
  }
}

export interface ResolvedAnimRef {
  stcIndex: number
  sdField: SdFieldName
  sdIndex: number
  sd: M3StructureData
  /** STC concurrent flag: sampling wraps by the SD block's own fend. */
  concurrent: boolean
  priority: number
}

interface StcLookup {
  stcIndex: number
  concurrent: boolean
  priority: number
  stsAnimIds: Set<number>
  /** animId → packed SD location. */
  refs: Map<number, { sdField: SdFieldName; sdIndex: number; sd: M3StructureData }>
}

function numberContent(sections: SectionResolver, ref: M3Reference | undefined): number[] {
  const section = sections.getSectionByReference(ref)
  return ((section?.content ?? []) as unknown[]).filter(
    (value): value is number => typeof value === 'number',
  )
}

export class M3AnimationEvaluator {
  private readonly sequenceStcs: StcLookup[][] = []

  constructor(
    private readonly model: M3StructureData,
    private readonly sections: SectionResolver,
  ) {
    const stgSection = sections.getSectionByReference(
      model.sequence_transformation_groups as M3Reference | undefined,
    )
    const stcSection = sections.getSectionByReference(
      model.sequence_transformation_collections as M3Reference | undefined,
    )
    const stsSection = sections.getSectionByReference(model.sts as M3Reference | undefined)
    const stgs = (stgSection?.content ?? []) as M3StructureData[]
    const stcs = (stcSection?.content ?? []) as M3StructureData[]
    const stss = (stsSection?.content ?? []) as M3StructureData[]

    const stcLookups = new Map<number, StcLookup>()
    const buildStcLookup = (stcIndex: number): StcLookup | null => {
      const cached = stcLookups.get(stcIndex)
      if (cached) return cached
      const stc = stcs[stcIndex]
      if (!stc) return null

      // STS membership is per-STC (sts_index), never cached at STG level (gotcha #1).
      const sts = stss[(stc.sts_index as number) ?? -1]
      const stsAnimIds = new Set(numberContent(sections, sts?.anim_ids as M3Reference | undefined))

      const refs = new Map<number, { sdField: SdFieldName; sdIndex: number; sd: M3StructureData }>()
      const animIds = numberContent(sections, stc.anim_ids as M3Reference | undefined)
      const animRefs = numberContent(sections, stc.anim_refs as M3Reference | undefined)
      for (let i = 0; i < animIds.length; i += 1) {
        const packed = animRefs[i]
        if (packed === undefined) continue
        const sdIndex = packed & 0xffff
        const sdField = SD_FIELDS[(packed >>> 16) & 0xffff]
        if (!sdField) continue
        const sdSection = sections.getSectionByReference(stc[sdField] as M3Reference | undefined)
        const sd = (sdSection?.content as M3StructureData[] | undefined)?.[sdIndex]
        if (!sd) continue
        refs.set(animIds[i]!, { sdField, sdIndex, sd })
      }

      const lookup: StcLookup = {
        stcIndex,
        concurrent: !!((stc.concurrent as number) ?? 0),
        priority: (stc.priority as number) ?? 0,
        stsAnimIds,
        refs,
      }
      stcLookups.set(stcIndex, lookup)
      return lookup
    }

    for (const stg of stgs) {
      const stcIndices = numberContent(sections, stg.stc_indices as M3Reference | undefined)
      const lookups: StcLookup[] = []
      for (const stcIndex of stcIndices) {
        const lookup = buildStcLookup(stcIndex)
        if (lookup) lookups.push(lookup)
      }
      this.sequenceStcs.push(lookups)
    }
  }

  get sequenceCount(): number {
    return this.sequenceStcs.length
  }

  /**
   * The 1.2 chain: walk the sequence's STCs in stored order; STS membership
   * validates; first hit wins; null → caller falls back to initValue.
   */
  resolveAnimRef(sequenceIndex: number, animId: number): ResolvedAnimRef | null {
    const lookups = this.sequenceStcs[sequenceIndex]
    if (!lookups) return null
    for (const lookup of lookups) {
      if (!lookup.stsAnimIds.has(animId)) continue
      const entry = lookup.refs.get(animId)
      if (!entry) continue // defensive: STS claims the id but the STC lacks data
      return {
        stcIndex: lookup.stcIndex,
        sdField: entry.sdField,
        sdIndex: entry.sdIndex,
        sd: entry.sd,
        concurrent: lookup.concurrent,
        priority: lookup.priority,
      }
    }
    return null
  }

  /**
   * SD sampling per 1.4: clamp before the first key, hold after the last,
   * step or lerp/slerp between; concurrent STCs wrap by the SD's own fend.
   * Writes into `out` and returns it (allocation-free steady state).
   */
  sampleSd(
    resolved: ResolvedAnimRef,
    interpolationType: number,
    frameMs: number,
    out: number[],
  ): number[] | null {
    const sd = resolved.sd
    const frames = numberContent(this.sections, sd.frames as M3Reference | undefined)
    const keysSection = this.sections.getSectionByReference(sd.keys as M3Reference | undefined)
    const keys = (keysSection?.content ?? []) as unknown[]
    if (frames.length === 0 || keys.length === 0) return null

    let frame = frameMs
    if (resolved.concurrent) {
      const fend = (sd.fend as number) ?? 0
      if (fend > 0) frame = frameMs % fend // wrap by the SD block's fend, not sequence length
    }

    const count = Math.min(frames.length, keys.length)
    const firstFrame = frames[0]!
    if (frame <= firstFrame) return writeComponents(keys[0], out)
    const lastFrame = frames[count - 1]!
    if (frame >= lastFrame) return writeComponents(keys[count - 1], out)

    let b = 1
    while (b < count - 1 && frame > frames[b]!) b += 1
    const a = b - 1
    if (interpolationType === 0) return writeComponents(keys[a], out)

    const span = frames[b]! - frames[a]!
    const t = span > 0 ? Math.min(Math.max((frame - frames[a]!) / span, 0), 1) : 0
    const va = valueToComponents(keys[a])
    const vb = valueToComponents(keys[b])
    if (resolved.sdField === 'sd4q' && va.length === 4 && vb.length === 4) {
      return slerpInto(va, vb, t, out)
    }
    out.length = va.length
    for (let i = 0; i < va.length; i += 1) out[i] = va[i]! + ((vb[i] ?? va[i]!) - va[i]!) * t
    return out
  }

  /**
   * Resolve + sample an AnimationReference for a sequence at a frame time;
   * falls back to the reference's initValue — the bind pose — when the
   * sequence does not drive it (the headline P5 fix).
   */
  sampleAnimRef(
    sequenceIndex: number,
    animRef: M3StructureData | null | undefined,
    frameMs: number,
    out: number[] = [],
  ): number[] {
    const parsed = parseAnimationReference(animRef)
    if (!parsed) {
      out.length = 0
      return out
    }
    const resolved = this.resolveAnimRef(sequenceIndex, parsed.animId)
    if (resolved) {
      const sampled = this.sampleSd(resolved, parsed.interpolationType, frameMs, out)
      if (sampled) return sampled
    }
    out.length = parsed.initValue.length
    for (let i = 0; i < parsed.initValue.length; i += 1) out[i] = parsed.initValue[i]!
    return out
  }
}

function writeComponents(value: unknown, out: number[]): number[] {
  const components = valueToComponents(value)
  out.length = components.length
  for (let i = 0; i < components.length; i += 1) out[i] = components[i]!
  return out
}

/** Shortest-path slerp with the standard nlerp fallback for near-parallel quats. */
function slerpInto(a: number[], b: number[], t: number, out: number[]): number[] {
  let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!
  let sign = 1
  if (dot < 0) {
    dot = -dot
    sign = -1
  }
  out.length = 4
  if (dot > 0.9995) {
    for (let i = 0; i < 4; i += 1) out[i] = a[i]! + (sign * b[i]! - a[i]!) * t
  } else {
    const theta = Math.acos(Math.min(1, dot))
    const sinTheta = Math.sin(theta)
    const wa = Math.sin((1 - t) * theta) / sinTheta
    const wb = (Math.sin(t * theta) / sinTheta) * sign
    for (let i = 0; i < 4; i += 1) out[i] = wa * a[i]! + wb * b[i]!
  }
  const len = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!)
  if (len > 0) {
    for (let i = 0; i < 4; i += 1) out[i]! /= len
  }
  return out
}
