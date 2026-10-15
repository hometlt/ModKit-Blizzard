/**
 * SC2 cutscene owner: compiled, read-only native state at an explicit timestamp.
 * Reuses the lossless model, resolveTimeline and sampleChannel. No clocks, resource I/O,
 * audio, script execution, renderer handles or native writes. Used by scene-at (codec.json).
 * This is a provisional native projection, not a UV file or a stable SDK world frame.
 * Unverified timing/flags and missing model/dependency semantics remain explicit diagnostics.
 */
import { curveChannelsOf, sampleChannel, type CutsceneCurveChannel } from './curves.js'
import { flagOf, guidOf, valueOf, walkWithParent, type CutsceneDocument, type CutsceneElement } from './model.js'
import { kindOf, roleOf } from './registry.js'
import { resolveTimeline, type CutsceneClip, type CutsceneTimeline } from './timeline.js'

export interface CutsceneEvaluationDiagnostic {
  readonly code: string
  readonly sourceStart: number
  readonly message: string
}

export interface CutsceneNodeState {
  readonly sourceStart: number
  readonly guid: string | null
  readonly kind: string
  readonly parentStart: number | null
  readonly enabled: boolean
  readonly active: boolean
  /** Authored values stay strings; only evaluated curve values are numbers. */
  readonly attributes: Readonly<Record<string, string>>
  readonly properties: Readonly<Record<string, string | number>>
}

export interface CutsceneMarker {
  readonly sourceStart: number
  readonly guid: string | null
  readonly kind: 'bookmark' | 'end'
  readonly time: number
  readonly name: string | null
  readonly jumpTo: string | null
  readonly pause: boolean
}

/** Native gaze request, resolved before invisible guides are removed from presentation.
 * Type/attachment/ignore-eyes stay authored: model aim bones and blend policy are not actor yaw.
 */
export interface CutsceneLookAtRequest {
  readonly sourceStart: number
  readonly ownerStart: number | null
  readonly targetGuid: string | null
  readonly targetStart: number | null
  readonly type: string | null
  readonly attachmentId: string | null
  readonly ignoreEyes: string | null
  readonly start: number
  readonly end: number
  readonly elapsed: number
  readonly state: 'resolved-target' | 'unresolved-owner' | 'unresolved-target' | 'ambiguous-target' | 'inactive-target'
  readonly targetProperties: Readonly<Record<string, string | number>> | null
}

/** Native animation command state, separate from authored clip occupancy and final pose blending.
 * Release continues after the authored end. Blend-in remains a playback-controller request;
 * commandWeight must not be mistaken for the final weight of a bone or sparse pose layer.
 */
export interface CutsceneAnimationLayer {
  readonly sourceStart: number
  readonly guid: string | null
  readonly ownerStart: number | null
  readonly start: number
  readonly end: number
  readonly elapsed: number
  readonly approximate: boolean
  readonly attributes: Readonly<Record<string, string>>
  readonly phase: 'active' | 'release'
  readonly authoredWeight: number
  readonly releaseWeight: number
  readonly commandWeight: number
  /** Null retains an omitted blend-in request without guessing the editor's creation default. */
  readonly blendInTimeMs: number | null
  readonly blendOutTimeMs: number
}

interface CompiledElement {
  readonly element: CutsceneElement
  readonly parent: CutsceneElement | undefined
  readonly enabled: boolean
  readonly attributes: Readonly<Record<string, string>>
  readonly clip: CutsceneClip | undefined
}

/** Copy decoded attributes without coercing GUIDs, expressions or vectors to numbers. */
function attributesOf(element: CutsceneElement): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(element.attributes.map(attribute => [attribute.name, attribute.value])))
}

/** Interval membership is half-open; point markers are handled separately from lifetime clips. */
function contains(clip: CutsceneClip, time: number): boolean {
  return time >= clip.start && time < clip.end
}

/** The qualified native command ABI uses signed 32-bit whole timestamps/durations. */
function nativeInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
}

/** Explicit timestamps are finite and non-negative; never accept a numeric string or NaN. */
export function assertCutsceneTime(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('cutscene timeMs must be a finite non-negative safe-range number')
  }
}

/**
 * Compile once per opened document revision. Offset identity handles missing/duplicate GUIDs;
 * GUID lookup is used only for explicit native references and refuses ambiguous camera targets.
 * maxNodes limits retained elements and output size; diagnostics stop with an explicit count.
 */
export function compileCutscene(document: CutsceneDocument, maxNodes = 100_000, maxDiagnostics = 1_000,
  analysis?: { readonly timeline: CutsceneTimeline; readonly channels: readonly CutsceneCurveChannel[] }) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxDiagnostics) || maxDiagnostics < 1) {
    throw new RangeError('cutscene evaluation budgets must be positive safe integers')
  }
  const pairs = [] as { element: CutsceneElement; parent: CutsceneElement | undefined }[]
  for (const pair of walkWithParent(document.root)) {
    if (pairs.length >= maxNodes) throw new RangeError('cutscene evaluation exceeds maxNodes')
    pairs.push(pair)
  }
  const timeline = analysis?.timeline ?? resolveTimeline(document)
  const channels = analysis?.channels ?? curveChannelsOf(document)
  if (!Number.isFinite(timeline.length) || timeline.clips.some(clip =>
    !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || !Number.isFinite(clip.duration))) {
    throw new RangeError('cutscene resolved timeline exceeds finite numeric range')
  }
  const diagnostics: CutsceneEvaluationDiagnostic[] = []
  let omittedDiagnostics = 0
  /** Retain addressed limitations without allocating an unbounded diagnostics list. */
  const diagnose = (element: CutsceneElement, code: string, message: string) => {
    if (diagnostics.length < maxDiagnostics) diagnostics.push(Object.freeze({ code, sourceStart: element.start, message }))
    else omittedDiagnostics += 1
  }
  diagnose(document.root, 'native-projection', 'Native state only: resources, poses, attachments, rendering and audio are not evaluated.')
  diagnose(document.root, 'time-unit-unconfirmed', 'Authored time is treated as milliseconds provisionally; native timing oracle is still required.')
  if (timeline.unresolvedAnchors > 0) diagnose(document.root, 'unresolved-anchors', `${timeline.unresolvedAnchors} missing anchors; stored/default times are provisional.`)
  if (timeline.cyclicAnchors.length > 0) diagnose(document.root, 'cyclic-anchors', 'Cyclic timing anchors use the timeline resolver fallback.')

  const entries = new Map<CutsceneElement, CompiledElement>()
  const entriesByStart = new Map<number, CompiledElement>()
  const byGuid = new Map<string, CompiledElement[]>()
  const propertyChannels = new Map<CutsceneElement, CutsceneCurveChannel>()
  const children = new Map<CutsceneElement, CompiledElement[]>()
  let clipIndex = 0
  let channelIndex = 0
  for (const { element, parent } of pairs) {
    const flag = flagOf(element, 'enabled')
    const inherited = parent === undefined ? true : entries.get(parent)?.enabled !== false
    const enabled = inherited && flag !== 'off'
    const clip = roleOf(element.tag) === 'element' ? timeline.clips[clipIndex++] : undefined
    const entry: CompiledElement = { element, parent, enabled, attributes: attributesOf(element), clip }
    entries.set(element, entry)
    entriesByStart.set(element.start, entry)
    if (parent !== undefined) {
      const list = children.get(parent) ?? []
      list.push(entry)
      children.set(parent, list)
    }
    const guid = guidOf(element)
    if (guid !== undefined) {
      const list = byGuid.get(guid) ?? []
      list.push(entry)
      byGuid.set(guid, list)
    }
    if (valueOf(element, 'enabled') !== undefined && flag !== 'on' && flag !== 'off') {
      diagnose(element, 'unresolved-enabled', 'Unknown/tri-state enabled flag retains inherited state provisionally.')
    }
    if (valueOf(element, 'lockedToEnd') === '1') diagnose(element, 'locked-to-end', 'Uses the stored resolved interval; dynamic end locking awaits verified scene-duration semantics.')
    if (valueOf(element, 'referenceFile')) diagnose(element, 'external-reference', 'External cutscene is not resolved by the native evaluator.')
    if (roleOf(element.tag) === undefined) diagnose(element, 'unsupported-tag', `No evaluation semantics for ${element.tag}.`)
    if (roleOf(element.tag) === 'node' && !['Director', 'Folder', 'Actor', 'TargetCamera', 'Camera', 'ActiveCamera', 'AnimLayer', 'PropertyValue', 'Bookmark', 'EndScene'].includes(kindOf(element.tag))) {
      diagnose(element, 'native-semantics-required', `${kindOf(element.tag)} is retained as authored data; its effect is not evaluated.`)
    }
    if (['guide', 'filter', 'visible'].some(name => valueOf(element, name) !== undefined)) {
      diagnose(element, 'presentation-flags', 'Visibility/guide/filter are retained, not interpreted as object removal.')
    }
    if (element.tag === 'CCutsceneNodePropertyValue') {
      const channel = channels[channelIndex++]
      if (channel !== undefined) propertyChannels.set(element, channel)
    }
  }
  const nodeEntries = [...entries.values()].filter(entry => roleOf(entry.element.tag) === 'node' && entry.element.tag !== 'CCutsceneNodePropertyValue')
  const clipEntries = [...entries.values()].filter(entry => entry.clip !== undefined)
  const animationEntries = clipEntries.filter(entry => entry.enabled && kindOf(entry.element.tag) === 'Anim')
  const animationSchedules = animationEntries.flatMap(entry => {
    const authoredWeight = Math.fround(Number(entry.attributes['weight'] ?? 1))
    const blendOutTimeMs = Number(entry.attributes['blendOutTime'] ?? 0)
    const blendInTimeMs = entry.attributes['blendTime'] === undefined ? null : Number(entry.attributes['blendTime'])
    const clip = entry.clip!
    const releaseEnd = clip.end + blendOutTimeMs
    if (!Number.isFinite(authoredWeight) || !nativeInt32(blendOutTimeMs) || blendOutTimeMs < 0 ||
      !nativeInt32(clip.start) || !nativeInt32(clip.duration) || clip.duration < 0 ||
      !nativeInt32(clip.end) || !nativeInt32(releaseEnd) || !nativeInt32(clip.duration + blendOutTimeMs) ||
      (blendInTimeMs !== null && (!nativeInt32(blendInTimeMs) || blendInTimeMs < 0))) {
      diagnose(entry.element, 'unsupported-animation-transition', 'Animation command times exceed the qualified signed-int32 whole-time profile or weight is non-finite; authored clip retained without a derived command layer.')
      return []
    }
    return [{ entry, authoredWeight, blendInTimeMs, blendOutTimeMs, releaseEnd }]
  })
  const cameraCuts = clipEntries.filter(entry => entry.element.tag === 'CCutsceneElementActiveCamera' && entry.enabled)
    .sort((a, b) => a.clip!.start - b.clip!.start || a.element.start - b.element.start)
  const lightCuts = clipEntries.filter(entry => entry.element.tag === 'CCutsceneElementActiveLight' && entry.enabled)
    .sort((a, b) => a.clip!.start - b.clip!.start || a.element.start - b.element.start)
  for (const [guid, targets] of byGuid) {
    if (targets.length > 1) diagnose(targets[0]!.element, 'duplicate-guid', `Ambiguous reference ${guid}; source offsets remain distinct.`)
  }
  const usableChannels = new Set<CutsceneElement>()
  const invalidControlSegments = new Map<CutsceneElement, ReadonlySet<number>>()
  for (const [element, channel] of propertyChannels) {
    const keys = element.children.filter(child => child.tag === 'CCutsceneElementPropertyCurve')
    // The current curve owner samples authored time. Do not silently combine it with retimed anchors.
    const invalid = keys.some((key, index) => {
      const time = channel.time[index]!
      const rawTime = valueOf(key, 'time')
      const rawValue = valueOf(key, 'value')
      return rawTime === undefined || rawTime.trim() === '' || !Number.isFinite(Number(rawTime)) ||
        rawValue === undefined || rawValue.trim() === '' || !Number.isFinite(Number(rawValue)) ||
        (index > 0 && time <= channel.time[index - 1]!) ||
        (valueOf(key, 'startLinkGuid') !== undefined && entries.get(key)?.clip?.start !== time)
    })
    const invalidControls = new Set<number>()
    keys.forEach((key, index) => {
      if (index + 1 >= keys.length) return
      const next = keys[index + 1]!
      const out = valueOf(key, 'curveOutValue')?.split(',').map(Number)
      const into = valueOf(next, 'curveInValue')?.split(',').map(Number)
      if (out?.length !== 2 || into?.length !== 2 || !out.every(Number.isFinite) || !into.every(Number.isFinite) ||
        out[0]! < channel.time[index]! || out[0]! > into[0]! || into[0]! > channel.time[index + 1]!) invalidControls.add(index)
    })
    if (invalid) diagnose(element, 'unsupported-curve-time', 'Malformed, unordered, duplicate or retimed keys are not sampled; authored base value is retained.')
    else usableChannels.add(element)
    if (invalidControls.size > 0) {
      invalidControlSegments.set(element, invalidControls)
      diagnose(element, 'unsupported-curve-time', 'Malformed or non-monotone controls are not interpolated; exact keys and held endpoints remain available.')
    }
    if (channel.steps.length > 0) diagnose(element, 'step-intervals-provisional', 'Point values persist until the next point; positive-duration values temporarily override them. Mixed curves/steps and overlap still need native verification.')
  }
  const markers: readonly CutsceneMarker[] = Object.freeze(clipEntries
    .filter(entry => entry.enabled && ['CCutsceneElementBookmark', 'CCutsceneElementEndScene'].includes(entry.element.tag))
    .map(entry => Object.freeze({
      sourceStart: entry.element.start, guid: guidOf(entry.element) ?? null,
      kind: entry.element.tag === 'CCutsceneElementBookmark' ? 'bookmark' as const : 'end' as const,
      time: entry.clip!.start, name: valueOf(entry.element, 'bookmarkName') ?? null,
      jumpTo: valueOf(entry.element, 'jumpToBookmarkWhenHit') || null,
      pause: valueOf(entry.element, 'pauseWhenHit') === '1',
    })).sort((a, b) => a.time - b.time || a.sourceStart - b.sourceStart))

  /** Pure random access; earlier calls and playback markers cannot change this answer. */
  const sceneAt = (timeMs: number) => {
    assertCutsceneTime(timeMs)
    const frameDiagnostics = [...diagnostics]
    let frameOmitted = omittedDiagnostics
    /** Bound per-frame findings by the same caller budget as compilation. */
    const note = (element: CutsceneElement, code: string, message: string) => {
      if (frameDiagnostics.length < maxDiagnostics) frameDiagnostics.push(Object.freeze({ code, sourceStart: element.start, message }))
      else frameOmitted += 1
    }
    const activeByElement = new Map<CutsceneElement, boolean>()
    for (const entry of entries.values()) {
      const lifetimes = (children.get(entry.element) ?? []).filter(child => child.element.tag === 'CCutsceneElementObject')
      const ownActive = lifetimes.length === 0 || lifetimes.some(child => child.enabled && child.clip !== undefined && contains(child.clip, timeMs))
      activeByElement.set(entry.element, entry.enabled && ownActive && (entry.parent === undefined || activeByElement.get(entry.parent) !== false))
    }
    const nodes: CutsceneNodeState[] = nodeEntries.map(entry => {
      const properties: Record<string, string | number> = Object.assign(Object.create(null), entry.attributes)
      for (const child of children.get(entry.element) ?? []) {
        const channel = propertyChannels.get(child.element)
        if (channel === undefined || !child.enabled || !usableChannels.has(child.element)) continue
        // Controls belong to an interval; stale handles elsewhere cannot invalidate an authored key.
        const invalidSegments = invalidControlSegments.get(child.element)
        const rejectedSegment = invalidSegments !== undefined && [...invalidSegments].some(index =>
          timeMs > channel.time[index]! && timeMs < channel.time[index + 1]!)
        const sample = rejectedSegment ? undefined : sampleChannel(channel, timeMs)
        if (sample !== undefined && Number.isFinite(sample.value)) {
          properties[channel.property] = sample.value
          if (sample.approximate) note(child.element, 'unknown-tangent', 'Stored Bezier controls sampled, but tangent type is unverified.')
        }
        if (sample !== undefined && !Number.isFinite(sample.value)) note(child.element, 'non-finite-curve', 'Sample overflow; authored value retained.')
        const values = (children.get(child.element) ?? []).filter(step => step.enabled && step.element.tag === 'CCutsceneElementPropertyValue' && step.clip !== undefined)
        const points = values.filter(step => step.clip!.duration === 0 && step.clip!.start <= timeMs)
          .sort((a, b) => a.clip!.start - b.clip!.start || a.element.start - b.element.start)
        const point = points.at(-1)
        if (point !== undefined) properties[channel.property] = valueOf(point.element, 'value') ?? ''
        if (points.length > 1 && points.at(-2)!.clip!.start === point!.clip!.start)
          note(point!.element, 'simultaneous-property-values', 'Last authored point at the same resolved time wins provisionally.')
        const steps = values.filter(step => step.clip!.duration > 0 && contains(step.clip!, timeMs))
        if (steps.length > 1) note(child.element, 'overlapping-steps', 'Multiple active steps; last authored step wins provisionally.')
        const step = steps.at(-1)
        if (step !== undefined) properties[channel.property] = valueOf(step.element, 'value') ?? ''
      }
      return Object.freeze({ sourceStart: entry.element.start, guid: guidOf(entry.element) ?? null,
        kind: kindOf(entry.element.tag), parentStart: entry.parent?.start ?? null,
        enabled: entry.enabled, active: activeByElement.get(entry.element) === true,
        attributes: entry.attributes, properties: Object.freeze(properties) })
    })
    let selected: CompiledElement | undefined
    for (const cut of cameraCuts) {
      if (cut.clip!.start > timeMs) break
      if (selected?.clip?.start === cut.clip!.start) note(cut.element, 'simultaneous-camera-cuts', 'Last authored camera cut wins provisionally.')
      selected = cut
    }
    const targetGuid = selected === undefined ? undefined : valueOf(selected.element, 'objectGuid')
    const targets = targetGuid === undefined ? [] : byGuid.get(targetGuid) ?? []
    const legacyCameras = document.root.tag === 'ActorState' ? nodeEntries.filter(entry => entry.enabled && entry.attributes['name'] === 'Cam_Export' && activeByElement.get(entry.element)) : []
    const target = targets.length === 1 ? targets[0] : selected === undefined && legacyCameras.length === 1 ? legacyCameras[0] : undefined
    const cameraNode = target === undefined ? undefined : nodes.find(node => node.sourceStart === target.element.start)
    const camera = selected === undefined && target === undefined ? null : Object.freeze({
      objectStart: cameraNode?.sourceStart ?? null,
      cutStart: selected?.element.start ?? target!.element.start, objectGuid: targetGuid ?? null,
      cameraIndex: selected === undefined ? '0' : valueOf(selected.element, 'cameraIndex') ?? '0',
      cameraName: selected === undefined ? 'Cam_Export' : valueOf(selected.element, 'cameraName') ?? null,
      kind: cameraNode?.kind ?? null,
      // M3 cameras need the sampled model pose; this result names the request, not a static substitute.
      state: cameraNode === undefined ? 'unresolved' as const : cameraNode.kind === 'Actor' ? 'model-camera-required' as const :
        cameraNode.kind === 'TargetCamera' || cameraNode.kind === 'Camera' ? 'native-camera' as const : 'unsupported-target' as const,
      properties: cameraNode?.properties ?? null,
    })
    if (camera !== null && camera.state !== 'native-camera') note((selected ?? target)!.element, camera.state, 'Active camera needs an unambiguous camera node or a resolved model camera and pose.')
    // ActiveLight is a persistent switch, like the director camera cut, not a zero-length clip.
    let selectedLight: CompiledElement | undefined
    for (const cut of lightCuts) {
      if (cut.clip!.start > timeMs) break
      if (activeByElement.get(cut.element) === true) selectedLight = cut
    }
    const activeLight = selectedLight === undefined ? null : Object.freeze({
      sourceStart: selectedLight.element.start, attributes: selectedLight.attributes,
    })
    if (selectedLight !== undefined && Number(selectedLight.attributes['blendTime'] ?? 0) !== 0)
      note(selectedLight.element, 'light-blend-required', 'ActiveLight blend is retained; only the selected target is published.')
    // Shot membership is disjunctive: a light may serve several authored camera/index pairs.
    // Publish native values here; coordinate/cone conversion belongs to the presentation adapter.
    const shotMembership = new Map<CutsceneElement, boolean>()
    for (const entry of entries.values()) {
      const shots = (children.get(entry.element) ?? []).filter(child => child.element.tag === 'CCutsceneNodeActiveShot' && child.enabled)
      const own = shots.length === 0 || (camera?.objectGuid !== null && camera?.objectGuid !== undefined && shots.some(shot =>
        shot.attributes['cameraGUID'] === camera.objectGuid && (shot.attributes['cameraIndex'] ?? '0') === camera.cameraIndex))
      shotMembership.set(entry.element, own && (entry.parent === undefined || shotMembership.get(entry.parent) !== false))
    }
    const shotNodes = nodes.filter(node => shotMembership.get(entriesByStart.get(node.sourceStart)!.element))
    const lights = shotNodes.filter(node => node.kind === 'Light' && node.active)
    const renderTextures = clipEntries.filter(entry => entry.element.tag === 'CCutsceneElementRTTChannel' &&
      entry.enabled && activeByElement.get(entry.element) === true && contains(entry.clip!, timeMs))
      .map(entry => {
        const guid = entry.attributes['objectGUID']
        const targets = guid === undefined ? [] : byGuid.get(guid) ?? []
        return Object.freeze({ sourceStart: entry.element.start, attributes: entry.attributes,
          channel: entry.parent === undefined ? undefined : entries.get(entry.parent)?.attributes['RTTChannel'],
          objectStart: targets.length === 1 ? targets[0]!.element.start : null })
      })
    const activeEntries = clipEntries.filter(entry => entry.enabled && activeByElement.get(entry.element) === true && entry.clip !== undefined && contains(entry.clip, timeMs))
    const nodeByStart = new Map(nodes.map(node => [node.sourceStart, node]))
    // Parent order comes from the existing bounded preorder walk; no repeated ancestry search.
    const actorOwners = new Map<CutsceneElement, number | null>()
    for (const entry of entries.values()) actorOwners.set(entry.element,
      roleOf(entry.element.tag) === 'node' && kindOf(entry.element.tag) === 'Actor' ? entry.element.start :
        entry.parent === undefined ? null : actorOwners.get(entry.parent) ?? null)
    const lookAts: CutsceneLookAtRequest[] = activeEntries.filter(entry => entry.element.tag === 'CCutsceneElementLookAt').map(entry => {
      const targetGuid = entry.attributes['lookAtGUID'] ?? null
      const targets = targetGuid === null ? [] : byGuid.get(targetGuid) ?? []
      const targetNode = targets.length === 1 ? nodeByStart.get(targets[0]!.element.start) : undefined
      const ownerStart = actorOwners.get(entry.element) ?? null
      const state = ownerStart === null ? 'unresolved-owner' : targets.length > 1 ? 'ambiguous-target' :
        targetNode === undefined ? 'unresolved-target' : !targetNode.active ? 'inactive-target' : 'resolved-target'
      if (state !== 'resolved-target') note(entry.element, `look-at-${state}`, 'Gaze needs an active, unambiguous target node and an enclosing actor; no fallback target is fabricated.')
      return Object.freeze({ sourceStart: entry.element.start, ownerStart, targetGuid,
        targetStart: targetNode?.sourceStart ?? null, type: entry.attributes['lookAtType'] ?? null,
        attachmentId: entry.attributes['lookAtAttachId'] ?? null, ignoreEyes: entry.attributes['ignoreEyes'] ?? null,
        start: entry.clip!.start, end: entry.clip!.end, elapsed: timeMs - entry.clip!.start, state,
        targetProperties: targetNode?.properties ?? null })
    })
    const activeClips = activeEntries
      .map(entry => Object.freeze({ sourceStart: entry.element.start, guid: guidOf(entry.element) ?? null,
        kind: kindOf(entry.element.tag), ownerStart: entry.parent?.start ?? null,
        start: entry.clip!.start, end: entry.clip!.end, elapsed: timeMs - entry.clip!.start,
        approximate: entry.clip!.approximate, attributes: entry.attributes }))
    const nativeClock = nativeInt32(timeMs)
    if (!nativeClock && animationSchedules.length > 0) note(document.root, 'unsupported-animation-command-clock',
      'Derived native animation commands require signed-int32 whole timestamps; authored state retains the requested time.')
    const animationLayers: CutsceneAnimationLayer[] = !nativeClock ? [] : animationSchedules.flatMap(schedule => {
      const { entry, authoredWeight, blendInTimeMs, blendOutTimeMs, releaseEnd } = schedule
      const clip = entry.clip!
      if (activeByElement.get(entry.element) !== true || timeMs < clip.start || timeMs >= releaseEnd) return []
      // The native command uses float32 division/subtraction/multiplication after the clip duration.
      // No native blend-in, sparse override or quaternion policy is inferred here.
      const releaseWeight = timeMs <= clip.end ? 1 : Math.max(0,
        Math.fround(1 - Math.fround(Math.fround(timeMs - clip.end) / Math.fround(blendOutTimeMs))))
      return [Object.freeze({ sourceStart: entry.element.start, guid: guidOf(entry.element) ?? null,
        ownerStart: entry.parent?.start ?? null, start: clip.start, end: clip.end,
        elapsed: timeMs - clip.start, approximate: clip.approximate, attributes: entry.attributes,
        phase: timeMs < clip.end ? 'active' as const : 'release' as const,
        authoredWeight, releaseWeight, commandWeight: Math.fround(authoredWeight * releaseWeight),
        blendInTimeMs, blendOutTimeMs })]
    })
    return Object.freeze({ timeMs, timeUnit: timeline.timeUnit, length: timeline.length,
      completeness: 'partial' as const, nodes: Object.freeze(nodes), activeClips: Object.freeze(activeClips), animationLayers: Object.freeze(animationLayers), camera,
      activeLight, shotNodes: Object.freeze(shotNodes), lights: Object.freeze(lights), renderTextures: Object.freeze(renderTextures), lookAts: Object.freeze(lookAts),
      diagnostics: Object.freeze(frameDiagnostics), omittedDiagnostics: frameOmitted })
  }
  const animationClips = animationEntries
    .map(entry => Object.freeze({ ownerStart: entry.parent?.start ?? null, attributes: entry.attributes }))
  return Object.freeze({ dialect: document.root.tag === 'ActorState' ? 'actor-state' as const : 'cutscene-state' as const, timeline, channels, markers, animationClips, sceneAt })
}

export type CompiledCutscene = ReturnType<typeof compileCutscene>
