/**
 * SC2 cutscene owner: bounded marker traversal, separate from evaluate.ts random access.
 * Consumes elapsed scene time supplied by the existing transport; owns no realtime clock.
 * Bookmark jumps/pause and EndScene are provisional native semantics, not Galaxy execution.
 * Equal-time control markers, missing/ambiguous jump targets and loops stop explicitly.
 */
import { assertCutsceneTime, type CompiledCutscene, type CutsceneMarker } from './evaluate.js'

/**
 * Advance a forward interval, preserving unused elapsed time across jumps. Seek uses sceneAt
 * directly and never calls this function. includeStart is for a fresh play at the initial position,
 * not for the next tick or resuming after a pause. No marker mutates the compiled document.
 */
export function advanceCutscene(
  scene: CompiledCutscene,
  timeMs: number,
  elapsedMs: number,
  options: { readonly includeStart?: boolean; readonly maxTransitions?: number } = {},
) {
  assertCutsceneTime(timeMs)
  assertCutsceneTime(elapsedMs)
  const maxTransitions = options.maxTransitions ?? 256
  if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 1 || maxTransitions > 10_000) {
    throw new RangeError('cutscene maxTransitions must be within [1, 10000]')
  }
  let position = timeMs
  let remaining = elapsedMs
  let includeStart = options.includeStart === true
  const events: CutsceneMarker[] = []
  /** Return the exact consumed interval; callers must re-anchor their clock at this position. */
  const finish = (state: 'playing' | 'paused' | 'ended' | 'blocked', reason: string | null) => Object.freeze({
    positionMs: position, unconsumedMs: remaining, state, reason, fidelity: 'provisional' as const, events: Object.freeze([...events]),
  })
  if (scene.timeline.unresolvedAnchors > 0 || scene.timeline.cyclicAnchors.length > 0 || scene.timeline.approximateClips > 0) {
    return finish('blocked', 'unresolved-timeline')
  }
  while (true) {
    const end = Math.min(scene.timeline.length, position + remaining)
    const next = scene.markers.find(marker => (marker.time > position || (includeStart && marker.time === position)) && marker.time <= end)
    if (next === undefined) {
      const consumed = Math.max(0, end - position)
      position = Math.max(position, end)
      remaining -= consumed
      return finish(position >= scene.timeline.length ? 'ended' : 'playing', null)
    }
    if (events.length >= maxTransitions) return finish('blocked', 'marker-transition-budget')
    remaining -= next.time - position
    position = next.time
    const simultaneous = scene.markers.filter(marker => marker.time === next.time)
    // Native ordering of simultaneous jump/pause/end actions is not yet established.
    if (simultaneous.length > 1 && simultaneous.some(marker => marker.kind === 'end' || marker.pause || marker.jumpTo !== null)) {
      return finish('blocked', 'simultaneous-control-markers')
    }
    if (events.length + simultaneous.length > maxTransitions) return finish('blocked', 'marker-transition-budget')
    events.push(...simultaneous)
    if (next.kind === 'end') return finish('ended', 'end-scene-marker')
    if (next.jumpTo !== null) {
      const targets = scene.markers.filter(marker => marker.kind === 'bookmark' && marker.name === next.jumpTo)
      if (targets.length !== 1) return finish('blocked', targets.length === 0 ? 'missing-bookmark' : 'ambiguous-bookmark')
      if (targets[0]!.time < 0 || !Number.isFinite(targets[0]!.time)) return finish('blocked', 'invalid-bookmark-time')
      position = targets[0]!.time
      includeStart = true
    } else includeStart = false
    if (next.pause) return finish('paused', 'pause-bookmark')
  }
}
