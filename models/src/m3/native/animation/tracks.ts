import type {
  RenderNodeTrackSet,
  RenderScalarAnimationKey,
  RenderScalarAnimationTrack,
  RenderSequence,
  SequenceIndexedAnimationTrack,
} from '@modkit/codec-kit/legacy/models'
import type { M3Reference, M3StructureData, SectionResolver } from '../types.js'
import { getSectionString } from '../utils/texture.js'
import { m3MatrixToArray } from '../utils/matrix.js'
import { getAllRegionBatches } from '../builder/material-helpers.js'
import {
  M3AnimationEvaluator,
  parseAnimationReference,
  valueToComponents,
  type ParsedAnimationReference,
  type ResolvedAnimRef,
} from './evaluator.js'

/**
 * P5-S4 — per-sequence track extraction (OPUS_TASK_P5_M3_ANIMATION.md D2–D4, D7).
 *
 * Every bone of every sequence gets a track set; bones the sequence does not
 * drive get a constant single-key track at the reference's initValue, which
 * makes the bind-pose reset structural — backends never keep stale transforms.
 * Key times are sequence-local seconds (`RenderScalarAnimationKey.frame`).
 * Explicit base-owned continuous references may opt into attached M3A flag-based
 * interpolation. This reference-qualified policy leaves raw headers, quaternion,
 * discrete and default own-file sampling unchanged; it adds no key samples.
 */

const BONE_BATCH1 = 0x4000
const BONE_BATCH2 = 0x8000
const SEQ_NOT_LOOPING = 0x1

export interface M3SequenceExtraction {
  sequences: RenderSequence[]
  /** Per-bone IREF inverse bind matrices (column-major 16 floats). */
  inverseBindMatrices: (Float32Array | undefined)[]
}

interface TrackSource {
  parsed: ParsedAnimationReference
  resolved: ResolvedAnimRef | null
  /** Per-reference presentation mode; the parsed native header stays intact. */
  samplingInterpolationType?: number
}

function resolveSource(
  evaluator: M3AnimationEvaluator,
  seqIndex: number,
  ref: M3StructureData | null | undefined,
): TrackSource | null {
  const parsed = parseAnimationReference(ref)
  if (!parsed) return null
  return { parsed, resolved: evaluator.resolveAnimRef(seqIndex, parsed.animId) }
}

function constantTrack(parsed: ParsedAnimationReference): RenderScalarAnimationTrack {
  return {
    lineType: 0,
    globalSeqId: null,
    keys: [{ frame: 0, vector: parsed.initValue }],
  }
}

function sdArrays(
  sections: SectionResolver,
  sd: M3StructureData,
): { frames: number[]; keys: unknown[] } {
  const framesSection = sections.getSectionByReference(sd.frames as M3Reference | undefined)
  const keysSection = sections.getSectionByReference(sd.keys as M3Reference | undefined)
  return {
    frames: ((framesSection?.content ?? []) as unknown[]).filter(
      (v): v is number => typeof v === 'number',
    ),
    keys: (keysSection?.content ?? []) as unknown[],
  }
}

/** Sample the SD at an absolute frame with the 1.4 clamp/hold rules (for D3 boundary keys). */
function sampleAt(
  evaluator: M3AnimationEvaluator,
  source: TrackSource,
  frameMs: number,
): number[] | null {
  if (!source.resolved) return null
  return evaluator.sampleSd(source.resolved, source.samplingInterpolationType ?? source.parsed.interpolationType, frameMs, [])
}

function extractTrack(
  evaluator: M3AnimationEvaluator,
  sections: SectionResolver,
  source: TrackSource,
  msStart: number,
  msEnd: number,
  isQuat: boolean,
  resampleLeadingDiscontinuity = false,
): { track: RenderScalarAnimationTrack; concurrent: boolean; wrapSeconds?: number; boundaryResampled?: boolean } {
  const { parsed, resolved } = source
  if (!resolved) {
    return { track: constantTrack(parsed), concurrent: false }
  }
  const { frames, keys } = sdArrays(sections, resolved.sd)
  const count = Math.min(frames.length, keys.length)
  if (count === 0) {
    return { track: constantTrack(parsed), concurrent: false }
  }

  const outKeys: RenderScalarAnimationKey[] = []
  if (resolved.concurrent) {
    // D4: concurrent overlays keep their own 0..fend timeline; backends wrap.
    for (let i = 0; i < count; i += 1) {
      outKeys.push({ frame: frames[i]! / 1000, vector: valueToComponents(keys[i]) })
    }
  } else {
    // D3: window filter with boundary sampling — SD frames may start before
    // anim_ms_start (leading clamp key); never silently drop the edges.
    let firstIncluded = Number.POSITIVE_INFINITY
    let lastIncluded = Number.NEGATIVE_INFINITY
    for (let i = 0; i < count; i += 1) {
      const frame = frames[i]!
      if (frame < msStart || frame > msEnd) continue
      firstIncluded = Math.min(firstIncluded, frame)
      lastIncluded = Math.max(lastIncluded, frame)
      outKeys.push({ frame: (frame - msStart) / 1000, vector: valueToComponents(keys[i]) })
    }
    if (firstIncluded > msStart) {
      const boundary = sampleAt(evaluator, source, msStart)
      if (boundary) outKeys.unshift({ frame: 0, vector: boundary })
    }
    if (lastIncluded < msEnd) {
      const boundary = sampleAt(evaluator, source, msEnd)
      if (boundary) outKeys.push({ frame: (msEnd - msStart) / 1000, vector: boundary })
    }
  }

  if (outKeys.length === 0) {
    return { track: constantTrack(parsed), concurrent: false }
  }

  // Native evaluation holds the first zero key exactly at zero, then uses the right-hand
  // branch. glTF cannot store two distinct values at one time. At the explicit presentation
  // boundary keep native samples at 0 and 1 ms; only the open sub-millisecond interval differs.
  let boundaryResampled = false
  if (resampleLeadingDiscontinuity && outKeys[0]!.frame === 0 && outKeys[1]?.frame === 0 &&
    frames.every(Number.isSafeInteger) && (resolved.concurrent ? Number(resolved.sd.fend) > 1 : msEnd - msStart > 1) &&
    outKeys.some(key => key.frame >= 0.001)) {
    const origin = resolved.concurrent ? 0 : msStart
    const first = sampleAt(evaluator, source, origin)
    const next = sampleAt(evaluator, source, origin + 1)
    if (first !== null && next !== null && first.every(Number.isFinite) && next.every(Number.isFinite)) {
      const rest = outKeys.filter(key => key.frame > 0.001)
      outKeys.splice(0, outKeys.length, { frame: 0, vector: first }, { frame: 0.001, vector: next }, ...rest)
      boundaryResampled = true
    }
  }

  // D7: quaternion neighborhood correction once at extraction — backends
  // receive sign-consistent tracks and can lerp/slerp naively.
  if (isQuat) {
    for (let i = 1; i < outKeys.length; i += 1) {
      const prev = outKeys[i - 1]!.vector
      const next = outKeys[i]!.vector
      let dot = 0
      for (let c = 0; c < 4; c += 1) dot += (prev[c] ?? 0) * (next[c] ?? 0)
      if (dot < 0) {
        outKeys[i] = { frame: outKeys[i]!.frame, vector: next.map(v => -v) }
      }
    }
  }

  const track: RenderScalarAnimationTrack = {
    lineType: (source.samplingInterpolationType ?? parsed.interpolationType) === 0 ? 0 : 1,
    globalSeqId: null,
    keys: outKeys,
  }
  const fend = (resolved.sd.fend as number) ?? 0
  return resolved.concurrent
    ? { track, concurrent: true, wrapSeconds: fend > 0 ? fend / 1000 : undefined, ...(boundaryResampled ? { boundaryResampled: true } : {}) }
    : { track, concurrent: false, ...(boundaryResampled ? { boundaryResampled: true } : {}) }
}

export interface M3AnimationReferenceTrackOptions {
  /** Convert every extracted key vector (for example, normalize COL_ bytes). */
  transformVector?: (vector: readonly number[]) => readonly number[]
  /** Caller proves this declaration belongs to the base, while SD belongs to an attached file. */
  attachedBaseReference?: true
}

/** Select the attached continuous mode without reinterpreting default/discrete/rotation headers. */
function samplingInterpolationType(
  parsed: ParsedAnimationReference,
  resolved: ResolvedAnimRef,
  options: M3AnimationReferenceTrackOptions,
): number {
  if (options.attachedBaseReference !== true ||
    !(['sdr3', 'sd2v', 'sd3v'] as readonly string[]).includes(resolved.sdField)) return parsed.interpolationType
  if (!Number.isInteger(parsed.animFlags) || parsed.animFlags < 0 || parsed.animFlags > 0xffff)
    throw new TypeError('M3 attached base reference flags must be a uint16')
  // WhiteoutFlakes source policy: row zero is not a step declaration for an attached sequence.
  // Native qualification is pending; the own-file header policy and raw fields stay unchanged.
  return (parsed.animFlags & 0x10) === 0 ? 1 : 0
}

/**
 * Reusable sparse AnimationReference extractor for non-bone properties.
 *
 * Unlike bone extraction, it emits entries only for sequences whose STG/STC/STS
 * chain resolves the reference's animId. Other sequences retain the property's
 * static init value without a duplicated constant track.
 */
export class M3AnimationReferenceTrackExtractor {
  boundaryResampledChannels = 0
  private readonly evaluator: M3AnimationEvaluator
  private readonly sequences: M3StructureData[]

  constructor(
    model: M3StructureData,
    private readonly sections: SectionResolver,
    private readonly sequenceIndices?: ReadonlySet<number>,
    private readonly resampleLeadingDiscontinuities = false,
  ) {
    this.evaluator = new M3AnimationEvaluator(model, sections)
    const sequenceSection = sections.getSectionByReference(
      model.sequences as M3Reference | undefined,
    )
    this.sequences = (sequenceSection?.content ?? []) as M3StructureData[]
  }

  extract(
    ref: M3StructureData | null | undefined,
    options: M3AnimationReferenceTrackOptions = {},
  ): SequenceIndexedAnimationTrack[] {
    const parsed = parseAnimationReference(ref)
    if (!parsed) return []

    const result: SequenceIndexedAnimationTrack[] = []
    for (let sequenceIndex = 0; sequenceIndex < this.sequences.length; sequenceIndex += 1) {
      if (this.sequenceIndices !== undefined && !this.sequenceIndices.has(sequenceIndex)) continue
      const resolved = this.evaluator.resolveAnimRef(sequenceIndex, parsed.animId)
      if (!resolved) continue
      const sequence = this.sequences[sequenceIndex]!
      const extracted = extractTrack(
        this.evaluator,
        this.sections,
        { parsed, resolved, samplingInterpolationType: samplingInterpolationType(parsed, resolved, options) },
        (sequence.anim_ms_start as number) ?? 0,
        (sequence.anim_ms_end as number) ?? 0,
        false,
        this.resampleLeadingDiscontinuities,
      )
      if (extracted.boundaryResampled) this.boundaryResampledChannels += 1
      const track = options.transformVector
        ? transformTrackVectors(extracted.track, options.transformVector)
        : extracted.track
      result.push({
        sequenceIndex,
        track,
        ...(extracted.concurrent ? { concurrent: true } : {}),
        ...(extracted.wrapSeconds !== undefined ? { wrapSeconds: extracted.wrapSeconds } : {}),
      })
    }
    return result
  }
}

function transformTrackVectors(
  track: RenderScalarAnimationTrack,
  transform: (vector: readonly number[]) => readonly number[],
): RenderScalarAnimationTrack {
  return {
    ...track,
    keys: track.keys.map(key => ({
      ...key,
      vector: transform(key.vector),
      ...(key.inTan ? { inTan: transform(key.inTan) } : {}),
      ...(key.outTan ? { outTan: transform(key.outTan) } : {}),
    })),
  }
}

/** batchIndex → RenderModel mesh index, replicating buildRenderMeshes emission order. */
function buildBatchToMeshIndex(
  model: M3StructureData,
  sections: SectionResolver,
): Map<number, number>[] {
  const divisionSection = sections.getSectionByReference(model.divisions as M3Reference | undefined)
  const result: Map<number, number>[] = []
  let meshIndex = 0
  for (const division of (divisionSection?.content ?? []) as M3StructureData[]) {
    const map = new Map<number, number>()
    const regionSection = sections.getSectionByReference(
      division.regions as M3Reference | undefined,
    )
    const regionCount = regionSection?.content.length ?? 0
    for (let regionIndex = 0; regionIndex < regionCount; regionIndex += 1) {
      const batches = getAllRegionBatches(model, sections, division, regionIndex)
      if (batches.length === 0) {
        meshIndex += 1 // batch-less region still emits one mesh
        continue
      }
      for (const batch of batches) {
        // A hidden batch (geometry_visible off) is no mesh: its visibility drives nothing.
        if (!batch.geometryVisible) continue
        map.set(batch.batchIndex, meshIndex)
        meshIndex += 1
      }
    }
    result.push(map)
  }
  return result
}

export function buildRenderSequences(
  model: M3StructureData,
  sections: SectionResolver,
  sequenceIndices?: ReadonlySet<number>,
): M3SequenceExtraction {
  const seqSection = sections.getSectionByReference(model.sequences as M3Reference | undefined)
  const boneSection = sections.getSectionByReference(model.bones as M3Reference | undefined)
  const seqs = (seqSection?.content ?? []) as M3StructureData[]
  const bones = (boneSection?.content ?? []) as M3StructureData[]

  // IREF inverse bind matrices (skinning = world × IREF, D8).
  const irefSection = sections.getSectionByReference(model.bone_rests as M3Reference | undefined)
  const inverseBindMatrices = ((irefSection?.content ?? []) as M3StructureData[]).map(iref => {
    const matrix = iref.matrix as M3StructureData | undefined
    return matrix ? Float32Array.from(m3MatrixToArray(matrix)) : undefined
  })

  if (seqs.length === 0) {
    return { sequences: [], inverseBindMatrices }
  }

  const evaluator = new M3AnimationEvaluator(model, sections)

  // Batching visibility: BAT_.bone points at the toggle bone (batch1/batch2).
  const boneToBatchMeshes = new Map<number, number[]>()
  const divisionSection = sections.getSectionByReference(model.divisions as M3Reference | undefined)
  const divisions = (divisionSection?.content ?? []) as M3StructureData[]
  const batchMaps = buildBatchToMeshIndex(model, sections)
  divisions.forEach((division, divisionIndex) => {
    const batchSection = sections.getSectionByReference(division.batches as M3Reference | undefined)
    const batches = (batchSection?.content ?? []) as M3StructureData[]
    const map = batchMaps[divisionIndex]
    batches.forEach((batch, batchIndex) => {
      const bone = (batch.bone as number) ?? -1
      if (bone < 0) return
      const meshIndex = map?.get(batchIndex)
      if (meshIndex === undefined) return
      let list = boneToBatchMeshes.get(bone)
      if (!list) {
        list = []
        boneToBatchMeshes.set(bone, list)
      }
      list.push(meshIndex)
    })
  })

  const sequences = seqs.map((seq, seqIndex): RenderSequence => {
    const msStart = (seq.anim_ms_start as number) ?? 0
    const msEnd = (seq.anim_ms_end as number) ?? msStart
    const flags = (seq.flags as number) ?? 0
    // Keep native indices and metadata aligned while avoiding unused presentation key expansion.
    if (sequenceIndices !== undefined && !sequenceIndices.has(seqIndex)) return {
      name: getSectionString(sections, seq.name as M3Reference | null) ?? `Seq_${seqIndex}`,
      durationSeconds: Math.max(0, msEnd - msStart) / 1000,
      looping: (flags & SEQ_NOT_LOOPING) === 0, nodeTracks: [],
    }

    const nodeTracks: RenderNodeTrackSet[] = bones.map((bone, boneIndex) => {
      const trackSet: RenderNodeTrackSet = { boneIndex }
      let concurrent = false
      let wrapSeconds: number | undefined
      const assign = (
        key: 'translation' | 'rotation' | 'scale',
        ref: M3StructureData | null | undefined,
        isQuat: boolean,
      ) => {
        const source = resolveSource(evaluator, seqIndex, ref)
        if (!source) return
        const extracted = extractTrack(evaluator, sections, source, msStart, msEnd, isQuat)
        trackSet[key] = extracted.track
        if (extracted.concurrent) {
          concurrent = true
          wrapSeconds = wrapSeconds ?? extracted.wrapSeconds
        }
      }
      assign('translation', bone.location as M3StructureData | undefined, false)
      assign('rotation', bone.rotation as M3StructureData | undefined, true)
      assign('scale', bone.scale as M3StructureData | undefined, false)
      if (concurrent) {
        trackSet.concurrent = true
        if (wrapSeconds !== undefined) trackSet.wrapSeconds = wrapSeconds
      }
      return trackSet
    })

    // Mesh visibility from `batching` flag animation on batch1/batch2 bones (1.6).
    const meshVisibility: { meshIndex: number; track: RenderScalarAnimationTrack }[] = []
    bones.forEach((bone, boneIndex) => {
      const boneFlags = (bone.flags as number) ?? 0
      if (!(boneFlags & (BONE_BATCH1 | BONE_BATCH2))) return
      const meshIndices = boneToBatchMeshes.get(boneIndex)
      if (!meshIndices?.length) return
      const source = resolveSource(
        evaluator,
        seqIndex,
        bone.batching as M3StructureData | undefined,
      )
      if (!source) return
      const extracted = extractTrack(evaluator, sections, source, msStart, msEnd, false)
      for (const meshIndex of meshIndices) {
        meshVisibility.push({ meshIndex, track: extracted.track })
      }
    })

    const boundsSphere = readBoundsSphere(seq.bounding_sphere as M3StructureData | undefined)
    return {
      name: getSectionString(sections, seq.name as M3Reference | null) ?? `Seq_${seqIndex}`,
      durationSeconds: Math.max(0, msEnd - msStart) / 1000,
      looping: (flags & SEQ_NOT_LOOPING) === 0,
      ...(typeof seq.movement_speed === 'number' && seq.movement_speed !== 0
        ? { movementSpeed: seq.movement_speed as number }
        : {}),
      ...(boundsSphere ? { boundsSphere } : {}),
      nodeTracks,
      ...(meshVisibility.length > 0 ? { meshVisibility } : {}),
    }
  })

  return { sequences, inverseBindMatrices }
}

function readBoundsSphere(
  bounds: M3StructureData | undefined,
): { center: [number, number, number]; radius: number } | null {
  const min = bounds?.min as M3StructureData | undefined
  const max = bounds?.max as M3StructureData | undefined
  if (!min || !max || typeof min.x !== 'number' || typeof max.x !== 'number') return null
  return {
    center: [
      ((min.x as number) + (max.x as number)) / 2,
      ((min.y as number) + (max.y as number)) / 2,
      ((min.z as number) + (max.z as number)) / 2,
    ],
    radius: (bounds!.radius as number) ?? 0,
  }
}
