import type {
  JsonValue,
  ModelAnimationChannel,
  ModelAnimationClip,
  ModelAnimationEvent,
  ResourceBudget,
} from '@modkit/sdk'
import { snapshotModelAnimations, animationSnapshotBudget, modelAnimationNameMatches } from '@modkit/codec-kit/model/animation'
import type { RenderScalarAnimationTrack } from '@modkit/codec-kit/legacy/models'
import { buildRenderSequences, M3AnimationReferenceTrackExtractor } from '../../dist/m3/native/animation/tracks.js'
import { getSectionString } from '../../dist/m3/native/utils/texture.js'
import { parseAnimationReference, SD_FIELDS, M3AnimationEvaluator } from '../../dist/m3/native/animation/evaluator.js'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { createM3SectionResolver } from './section-resolver.js'
import { getAllRegionBatches } from '../../dist/m3/native/builder/material-helpers.js'

interface PendingChannel {
  readonly target: string
  readonly kind: string
  readonly track: RenderScalarAnimationTrack
  readonly concurrent?: boolean
  readonly wrapSeconds?: number
}

interface TimelineContainer {
  readonly index: number
  readonly name: string
  readonly channels: number
  readonly unsupportedChannels: number
  readonly frames: number
}

export interface M3ResidualAnimationEvent {
  readonly name: string
  readonly payload: string
  readonly id: number
  readonly bone: number
  readonly flags: number
  readonly dataParam0: number
  readonly dataParam1: number
  readonly matrix: readonly number[]
  readonly version: number
}

export interface M3ResidualAnimationEventTrack {
  readonly sequenceIndex: number
  readonly stcOrder: number
  readonly concurrent: boolean
  readonly priority: number
  readonly animId: number
  readonly flags: number
  readonly fend: number
  readonly frames: readonly number[]
  readonly events: readonly M3ResidualAnimationEvent[]
}

export interface M3ResidualAnimationTrack {
  readonly sequenceIndex: number
  readonly stcOrder: number
  readonly concurrent: boolean
  readonly priority: number
  readonly animId: number
  readonly sdField: string
  readonly flags: number
  readonly fend: number
  readonly frames: readonly number[]
  readonly values: readonly JsonValue[]
}

export type M3UnsupportedAnimationChannelReason =
  | 'invalid-animation-id'
  | 'invalid-animation-reference'
  | 'unknown-animation-data-kind'
  | 'missing-animation-data'
  | 'animation-key-count-mismatch'
  | 'empty-animation-data'
  | 'invalid-animation-frame'
  | 'invalid-animation-value'
  | 'invalid-animation-flags'
  | 'invalid-animation-end-frame'

/**
 * M3 key times are signed milliseconds.
 *
 * Blizzard's own models open a residual track with a key before zero - a -999 lead-in that gives
 * the channel a value for the whole run-up to the sequence - so a negative time is the format
 * working as designed, not corruption. Only a non-integer or out-of-range time is refused.
 */
function residualValue(field: string, value: unknown): JsonValue | undefined {
  if (['sdr3', 'sdu8', 'sds6', 'sdu6', 'sds3', 'sdu3'].includes(field))
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  // Base scalar sections are unwrapped by M3SectionList. SDFG keys therefore arrive as
  // uint32 numbers just like REAL/I16_/U32_ keys, not as FLAG structure records.
  if (field === 'sdfg')
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
      ? value
      : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as M3StructureData
  const vector = (names: readonly string[]): JsonValue | undefined => {
    const result = names.map(name => record[name])
    return result.every(component => typeof component === 'number' && Number.isFinite(component))
      ? result as number[]
      : undefined
  }
  if (field === 'sd2v') return vector(['x', 'y'])
  if (field === 'sd3v') return vector(['x', 'y', 'z'])
  if (field === 'sd4q') return vector(['x', 'y', 'z', 'w'])
  if (field === 'sdcc') return vector(['r', 'g', 'b', 'a'])
  if (field === 'sdmb') {
    const component = (entry: unknown): number[] | undefined => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
      const source = entry as M3StructureData, result = [source['x'], source['y'], source['z']]
      return result.every(item => typeof item === 'number' && Number.isFinite(item)) ? result as number[] : undefined
    }
    const min = component(record['min']), max = component(record['max']), radius = record['radius']
    return min && max && typeof radius === 'number' && Number.isFinite(radius) ? { min, max, radius } : undefined
  }
  return undefined
}

function animationEvent(
  resolver: ReturnType<typeof createM3SectionResolver>,
  value: M3StructureData,
): M3ResidualAnimationEvent | undefined {
  const matrix = ['x', 'y', 'z', 'w'].flatMap(axis => {
    const vector = value['matrix'] as M3StructureData | undefined
    const row = vector?.[axis] as M3StructureData | undefined
    return ['x', 'y', 'z', 'w'].map(component => row?.[component])
  })
  const version = (value as { readonly desc?: { readonly version?: unknown } }).desc?.version
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > 2 ||
    matrix.length !== 16 ||
    matrix.some(component => typeof component !== 'number' || !Number.isFinite(component))
  )
    return undefined
  const dataParam0 = version >= 1 ? value['data_param0'] : 0
  const dataParam1 = version >= 2 ? value['data_param1'] : 0
  const numbers = [value['id'], value['bone'], value['flags'], dataParam0, dataParam1]
  if (numbers.some(component => typeof component !== 'number' || !Number.isSafeInteger(component)))
    return undefined
  return {
    name: getSectionString(resolver, value['name'] as M3Reference) ?? '',
    payload: getSectionString(resolver, value['payload'] as M3Reference) ?? '',
    id: Number(value['id']),
    bone: Number(value['bone']),
    flags: Number(value['flags']),
    dataParam0: Number(dataParam0),
    dataParam1: Number(dataParam1),
    matrix: matrix as number[],
    version,
  }
}

/**
 * One key of an M3 event track as a clip event: its name (`Evt_SeqEnd`, `Evt_Sound…`), the bone it
 * happens at as that bone's scene node, and the rest of the EVNT record as data.
 */
function clipEvent(event: M3ResidualAnimationEvent, timeSeconds: number): ModelAnimationEvent {
  return {
    timeSeconds,
    name: event.name,
    ...(event.bone >= 0 ? { nodeId: `bone/${event.bone}` } : {}),
    payload: {
      id: event.id,
      flags: event.flags,
      ...(event.payload === '' ? {} : { payload: event.payload }),
      ...(event.version >= 1 ? { dataParam0: event.dataParam0 } : {}),
      ...(event.version >= 2 ? { dataParam1: event.dataParam1 } : {}),
    },
  }
}

/** Project the pinned per-sequence tracks; all time-window and reference rules stay in MK2. */
export function projectM3Animations(
  sections: SectionResolver & { readonly model: M3StructureData },
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
  bindingBase?: SectionResolver & { readonly model: M3StructureData },
  animationNames?: readonly string[],
): {
  readonly clips: readonly ModelAnimationClip[]
  readonly nativeSequenceIndices: readonly number[]
  readonly boundaryResampledChannels: number
  readonly declaredSequences: number
  readonly invalidBounds: number
  readonly timelineContainers: readonly TimelineContainer[]
  readonly unsupportedChannels: number
  readonly unsupportedChannelReasons: Readonly<
    Partial<Record<M3UnsupportedAnimationChannelReason, number>>
  >
  readonly unsupportedChannelDataKinds: Readonly<Record<string, number>>
  readonly animationEvents: readonly M3ResidualAnimationEventTrack[]
  readonly residualAnimationTracks: readonly M3ResidualAnimationTrack[]
} {
  const resolver = createM3SectionResolver(sections, budget, signal)
  const declared =
    resolver.getSectionByReference(sections.model['sequences'] as M3Reference | undefined)
      ?.content ?? []
  const sequenceIndices = animationNames === undefined ? undefined : new Set(declared.flatMap((raw, index) => {
    const name = getSectionString(resolver, (raw as M3StructureData)['name'] as M3Reference) ?? `Seq_${index}`
    return animationNames.some(request => modelAnimationNameMatches(name, request)) ? [index] : []
  }))
  const extracted = buildRenderSequences(sections.model, resolver, sequenceIndices)
  const content = (value: unknown): unknown[] =>
    resolver.getSectionByReference(value as M3Reference | undefined)?.content ?? []
  // A companion addresses declarations by animId, not by its BONE table ordinal.
  // Keep the base hierarchy and init values; the existing extractor reads sidecar STS/STC/SD.
  const baseResolver = bindingBase === undefined ? resolver : createM3SectionResolver(bindingBase, budget, signal)
  const bones = (bindingBase === undefined ? content(sections.model['bones']) :
    baseResolver.getSectionByReference(bindingBase.model['bones'] as M3Reference)?.content ?? []) as M3StructureData[]
  if (bindingBase !== undefined) {
    const evaluator = new M3AnimationEvaluator(sections.model, resolver)
    const ids = new Set<number>()
    for (const bone of bones) for (const [field, expected] of [['location','sd3v'],['rotation','sd4q'],['scale','sd3v']] as const) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      const ref = parseAnimationReference(bone[field] as M3StructureData | undefined)
      if (ref === null) continue
      let resolvedAny = false
      for (let index = 0; index < declared.length; index++) {
        if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
        if (sequenceIndices !== undefined && !sequenceIndices.has(index)) continue
        const resolved = evaluator.resolveAnimRef(index, ref.animId)
        if (resolved === null) continue
        resolvedAny = true
        if (resolved.sdField !== expected) throw new TypeError(`M3A animId ${ref.animId} has an incompatible ${field} data type`)
      }
      if (resolvedAny && ids.has(ref.animId)) throw new TypeError(`M3A animId ${ref.animId} has ambiguous base targets`)
      if (resolvedAny) ids.add(ref.animId)
    }
  }
  const referenceExtractor = new M3AnimationReferenceTrackExtractor(sections.model, resolver, sequenceIndices, bindingBase !== undefined)
  // extract() traverses every sequence. Reuse that result across sequence projection rather
  // than decoding the same native reference once again for every sequence (quadratic work).
  const referenceTracks = new Map<M3StructureData, Partial<Record<'default' | 'attached', ReturnType<M3AnimationReferenceTrackExtractor['extract']>>>>()
  /** Memoize only this projection's exact declaration and treatment; batching never borrows TRS policy. */
  const tracksFor = (reference: M3StructureData | undefined, attachedBaseReference = false) => {
    if (reference === undefined) return []
    let cached = referenceTracks.get(reference)
    if (cached === undefined) { cached = {}; referenceTracks.set(reference, cached) }
    const treatment = attachedBaseReference ? 'attached' : 'default'
    return cached[treatment] ??= referenceExtractor.extract(reference, attachedBaseReference ? { attachedBaseReference: true } : {})
  }
  const activeBatching = new Set<number>()
  const targets = new Set<number>()
  for (const bone of bones)
    for (const field of ['location', 'rotation', 'scale']) {
      const parsed = parseAnimationReference(bone[field] as M3StructureData | undefined)
      if (parsed !== null) targets.add(parsed.animId)
    }
  // A batching reference only drives visibility when a real batch maps it to a mesh.
  // Merely finding a BONE.batching header must not hide unrepresented STC data in an M3A.
  for (const rawDivision of bindingBase === undefined ? content(sections.model['divisions']) : []) {
    const division = rawDivision as M3StructureData
    const batches = content(division['batches']) as M3StructureData[]
    const regions = content(division['regions'])
    for (let region = 0; region < regions.length; region++) {
      for (const batch of getAllRegionBatches(sections.model, resolver, division, region)) {
        const boneIndex = batches[batch.batchIndex]?.['bone']
        const bone = typeof boneIndex === 'number' ? bones[boneIndex] : undefined
        if (bone === undefined || (Number(bone['flags']) & 0xc000) === 0) continue
        const parsed = parseAnimationReference(bone['batching'] as M3StructureData | undefined)
        if (parsed !== null) {
          targets.add(parsed.animId)
          activeBatching.add(parsed.animId)
        }
      }
    }
  }
  // Batching references without an active BAT_ consumer are still authored native data.
  // Publish them as inactive node batch visibility so source-free UVM can retain them
  // without pretending they currently hide a draw primitive.
  for (const bone of bones) {
    const parsed = parseAnimationReference(bone['batching'] as M3StructureData | undefined)
    if (parsed !== null && !activeBatching.has(parsed.animId)) targets.add(parsed.animId)
  }
  const stcs = content(sections.model['sequence_transformation_collections']) as M3StructureData[]
  const stgs = content(sections.model['sequence_transformation_groups']) as M3StructureData[]
  const selectedStcs = sequenceIndices === undefined ? undefined : new Set([...sequenceIndices].flatMap(index =>
    content(stgs[index]?.['stc_indices']).filter((value): value is number => typeof value === 'number')))
  const eventTracks = new Map<number, Omit<M3ResidualAnimationEventTrack, 'sequenceIndex' | 'stcOrder'>[]>()
  const residualTracks = new Map<number, Omit<M3ResidualAnimationTrack, 'sequenceIndex' | 'stcOrder'>[]>()
  const unsupportedChannelReasons = new Map<M3UnsupportedAnimationChannelReason, number>()
  const unsupportedChannelDataKinds = new Map<string, number>()
  const refuseChannel = (reason: M3UnsupportedAnimationChannelReason): void => {
    unsupportedChannelReasons.set(reason, (unsupportedChannelReasons.get(reason) ?? 0) + 1)
  }
  const refuseChannelValue = (dataKind: string): M3UnsupportedAnimationChannelReason => {
    unsupportedChannelDataKinds.set(
      dataKind,
      (unsupportedChannelDataKinds.get(dataKind) ?? 0) + 1,
    )
    return 'invalid-animation-value'
  }
  const timelineContainers = stcs.map((stc, index): TimelineContainer => {
    if (selectedStcs !== undefined && !selectedStcs.has(index)) return {
      index, name: getSectionString(resolver, stc['name'] as M3Reference) ?? `STC_${index}`,
      channels: 0, unsupportedChannels: 0, frames: 0,
    }
    const ids = content(stc['anim_ids'])
    const refs = content(stc['anim_refs'])
    const represented = ids.filter(id => typeof id === 'number' && targets.has(id)).length
    const preserved: Omit<M3ResidualAnimationEventTrack, 'sequenceIndex' | 'stcOrder'>[] = []
    const generic: Omit<M3ResidualAnimationTrack, 'sequenceIndex' | 'stcOrder'>[] = []
    for (const [ordinal, rawId] of ids.entries()) {
      const packed = refs[ordinal]
      if (typeof rawId !== 'number') {
        refuseChannel('invalid-animation-id')
        continue
      }
      if (targets.has(rawId)) continue
      if (typeof packed !== 'number') {
        refuseChannel('invalid-animation-reference')
        continue
      }
      const sdField = SD_FIELDS[packed >>> 16]
      if (sdField === undefined) {
        refuseChannel('unknown-animation-data-kind')
        continue
      }
      if (sdField !== 'sdev') {
        const sd = content(stc[sdField])[packed & 0xffff] as M3StructureData | undefined
        if (sd === undefined) {
          refuseChannel('missing-animation-data')
          continue
        }
        const frames = content(sd['frames']), values = content(sd['keys']).map(value => residualValue(sdField, value))
        const flags = sd['flags'], fend = sd['fend']
        const refusal =
          frames.length !== values.length
            ? 'animation-key-count-mismatch'
            : frames.length === 0
              ? 'empty-animation-data'
              : frames.some(frame => typeof frame !== 'number' || !Number.isSafeInteger(frame))
                ? 'invalid-animation-frame'
                : values.some(value => value === undefined)
                  ? refuseChannelValue(sdField)
                  : typeof flags !== 'number' || !Number.isSafeInteger(flags)
                    ? 'invalid-animation-flags'
                    : typeof fend !== 'number' || !Number.isSafeInteger(fend) || fend < 0
                      ? 'invalid-animation-end-frame'
                      : undefined
        if (refusal !== undefined) {
          refuseChannel(refusal)
          continue
        }
        generic.push({
          concurrent: Boolean(stc['concurrent']), priority: Number(stc['priority']) || 0,
          animId: rawId, sdField, flags: Number(flags), fend: Number(fend),
          frames: frames as number[], values: values as JsonValue[],
        })
        continue
      }
      const sd = content(stc['sdev'])[packed & 0xffff] as M3StructureData | undefined
      if (sd === undefined) {
        refuseChannel('missing-animation-data')
        continue
      }
      const frames = content(sd['frames'])
      const events = content(sd['keys']).map(value =>
        animationEvent(resolver, value as M3StructureData),
      )
      const flags = sd['flags'], fend = sd['fend']
      const refusal =
        frames.length !== events.length
          ? 'animation-key-count-mismatch'
          : frames.some(frame => typeof frame !== 'number' || !Number.isSafeInteger(frame))
            ? 'invalid-animation-frame'
            : events.some(event => event === undefined)
              ? 'invalid-animation-value'
              : typeof flags !== 'number' || !Number.isSafeInteger(flags)
                ? 'invalid-animation-flags'
                : typeof fend !== 'number' || !Number.isSafeInteger(fend) || fend < 0
                  ? 'invalid-animation-end-frame'
                  : undefined
      if (refusal !== undefined) {
        refuseChannel(refusal)
        continue
      }
      preserved.push({
        concurrent: Boolean(stc['concurrent']),
        priority: Number(stc['priority']) || 0,
        animId: rawId,
        flags: Number(flags),
        fend: Number(fend),
        frames: frames as number[],
        events: events as M3ResidualAnimationEvent[],
      })
    }
    if (preserved.length > 0) eventTracks.set(index, preserved)
    if (generic.length > 0) residualTracks.set(index, generic)
    const times = new Set<number>()
    for (const field of SD_FIELDS)
      for (const raw of content(stc[field])) {
        const sd = raw as M3StructureData
        for (const time of content(sd['frames'])) if (typeof time === 'number') times.add(time)
      }
    return {
      index,
      name: getSectionString(resolver, stc['name'] as M3Reference) ?? `STC_${index}`,
      channels: represented,
      unsupportedChannels: ids.length - represented - preserved.length - generic.length,
      frames: times.size,
    }
  })
  const clips: ModelAnimationClip[] = []
  const nativeSequenceIndices: number[] = []
  const animationEvents: M3ResidualAnimationEventTrack[] = []
  const residualAnimationTracks: M3ResidualAnimationTrack[] = []
  let invalidBounds = 0
  for (const [index, sequence] of extracted.sequences.entries()) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    if (animationNames !== undefined && !animationNames.some(name => modelAnimationNameMatches(sequence.name, name))) continue
    const record = declared[index] as M3StructureData | undefined
    const start = record?.['anim_ms_start']
    const end = record?.['anim_ms_end']
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    ) {
      invalidBounds++
      continue
    }
    const pending: PendingChannel[] = []
    for (const [boneIndex, bone] of bones.entries()) {
      for (const [kind, field] of [
        ['translation', 'location'],
        ['rotation', 'rotation'],
        ['scale', 'scale'],
      ] as const) {
        const entry = tracksFor(bone[field] as M3StructureData | undefined, bindingBase !== undefined && field !== 'rotation')
          .find(track => track.sequenceIndex === index)
        if (entry === undefined) continue
        pending.push({
          target: `bone/${boneIndex}`,
          kind,
          track: entry.track,
          ...(entry.concurrent === undefined ? {} : { concurrent: entry.concurrent }),
          ...(entry.wrapSeconds === undefined ? {} : { wrapSeconds: entry.wrapSeconds }),
        })
      }
    }
    for (const [boneIndex, bone] of bones.entries()) {
        const parsed = parseAnimationReference(bone['batching'] as M3StructureData | undefined)
        if (parsed === null || activeBatching.has(parsed.animId)) continue
        const entry = tracksFor(bone['batching'] as M3StructureData | undefined)
          .find(track => track.sequenceIndex === index)
        if (entry === undefined) continue
        pending.push({
          target: `bone/${boneIndex}`,
          kind: 'visibility',
          track: entry.track,
          ...(entry.concurrent === undefined ? {} : { concurrent: entry.concurrent }),
          ...(entry.wrapSeconds === undefined ? {} : { wrapSeconds: entry.wrapSeconds }),
        })
      }
    for (const visibility of sequence.meshVisibility ?? []) {
      // Each extracted batch is one draw primitive in the scene projection, in the same order.
      pending.push({
        target: `mesh-0-primitive-${visibility.meshIndex}`,
        kind: 'visibility',
        track: visibility.track,
      })
    }
    const times = [
      ...new Set(pending.flatMap(channel => channel.track.keys.map(key => key.frame))),
    ].sort((a, b) => a - b)
    const frames = new Map(times.map((time, frame) => [time, frame]))
    const channels: ModelAnimationChannel[] = pending.map(channel => {
      const samples = channel.track.keys.map(key => {
        const frame = frames.get(key.frame)
        if (frame === undefined) throw new TypeError('M3 extracted key has no frame ordinal')
        return {
          frame,
          timeSeconds: key.frame,
          // Concurrent tracks retain their own native clock; other keys are sequence-local.
          timeMilliseconds: Math.round(key.frame * 1000 + (channel.concurrent ? 0 : start)),
          value: key.vector,
        }
      })
      const first = samples[0],
        last = samples.at(-1)
      if (first === undefined || last === undefined)
        throw new TypeError('M3 extracted an empty animation track')
      return {
        target: channel.target,
        kind: channel.kind,
        firstFrame: first.frame,
        lastFrame: last.frame,
        samples,
        interpolation:
          channel.track.lineType === 0
            ? 'step'
            : channel.kind === 'rotation'
              ? 'spherical-linear'
              : 'linear',
        ...(channel.concurrent === undefined ? {} : { concurrent: channel.concurrent }),
        ...(channel.wrapSeconds === undefined ? {} : { wrapSeconds: channel.wrapSeconds }),
      }
    })
    const unsupported = content(stgs[index]?.['stc_indices']).reduce<number>(
      (sum, stc) =>
        sum + (typeof stc === 'number' ? (timelineContainers[stc]?.unsupportedChannels ?? 0) : 0),
      0,
    )
    const events: ModelAnimationEvent[] = []
    const priorities = new Set<number>()
    for (const [stcOrder, rawStc] of content(stgs[index]?.['stc_indices']).entries()) {
      if (typeof rawStc === 'number') {
        const stc = stcs[rawStc]
        if (stc !== undefined) priorities.add(Number(stc['priority']) || 0)
        for (const event of eventTracks.get(rawStc) ?? []) {
          animationEvents.push({ sequenceIndex: index, stcOrder, ...event })
          event.frames.forEach((frame, key) => {
            const fired = event.events[key]
            if (fired !== undefined) events.push(clipEvent(fired, Math.max(0, frame - start) / 1000))
          })
        }
        for (const track of residualTracks.get(rawStc) ?? [])
          residualAnimationTracks.push({ sequenceIndex: index, stcOrder, ...track })
      }
    }
    events.sort((left, right) => left.timeSeconds - right.timeSeconds)
    // The game blends into a sequence over its ms_blend; a sequence's STCs carry its priority, and a
    // clip states one only when they agree (mixed STCs are layers, which a clip-wide value cannot say).
    const blend = record?.['ms_blend']
    const [priority] = priorities.size === 1 ? priorities : []
    nativeSequenceIndices.push(index)
    clips.push({
      id: `m3-sequence-${index}`,
      name: sequence.name,
      kind: times.length === 1 ? 'rest-pose' : 'animation',
      provenance: 'direct',
      frames: times.length,
      hierarchyId: 'm3/bone-table',
      nativeTimeBounds: { startMilliseconds: start, endMilliseconds: end },
      durationSeconds: sequence.durationSeconds,
      looping: sequence.looping,
      ...(typeof blend === 'number' && Number.isSafeInteger(blend) && blend >= 0 ? { blendInSeconds: blend / 1000 } : {}),
      ...(priority === undefined ? {} : { priority }),
      ...(events.length === 0 ? {} : { events }),
      ...(sequence.movementSpeed === undefined ? {} : { movementSpeed: sequence.movementSpeed }),
      ...(sequence.boundsSphere === undefined ? {} : { boundsSphere: sequence.boundsSphere }),
      channels,
      ...(unsupported > 0 ? { unsupportedChannels: unsupported } : {}),
    })
  }
  return {
    clips: snapshotModelAnimations(
      clips,
      // The native table budget is not the expanded JSON key count; source byte limits stay intact.
      { maxDepth: budget.maxDepth, maxNodes: Math.max(budget.maxNodes, animationSnapshotBudget(clips).maxNodes), maxBytes: budget.maxScalarBytes },
      signal,
    ),
    nativeSequenceIndices: Object.freeze(nativeSequenceIndices),
    boundaryResampledChannels: referenceExtractor.boundaryResampledChannels,
    declaredSequences: extracted.sequences.length,
    invalidBounds,
    timelineContainers,
    unsupportedChannels: timelineContainers.reduce((sum, stc) => sum + stc.unsupportedChannels, 0),
    unsupportedChannelReasons: Object.freeze(
      Object.fromEntries(
        [...unsupportedChannelReasons].sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
    unsupportedChannelDataKinds: Object.freeze(
      Object.fromEntries(
        [...unsupportedChannelDataKinds].sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
    animationEvents: Object.freeze(animationEvents),
    residualAnimationTracks: Object.freeze(residualAnimationTracks),
  }
}
