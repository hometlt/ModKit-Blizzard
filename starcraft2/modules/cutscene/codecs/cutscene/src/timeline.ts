/**
 * Where things actually happen, once the anchor graph is resolved.
 *
 * A clip is positioned in one of two ways and the file stores both: `start` is an absolute time,
 * and `startLinkGuid` anchors the clip to another element, offset by `startLinkDistance`, attached
 * to either that element's beginning or its end according to `startLinkAttachToPoint`. Curve keys
 * alone carry 133 870 `start` values and 45 276 `startLinkGuid`s, so the two coexist within one
 * document and even within one element. The consequence for any editor is the important part: the
 * absolute time of an anchored clip is *not* stored, it is derived, and moving one clip moves
 * everything anchored to it.
 *
 * ## What the attach point means (question R3, settled from the corpus)
 *
 * `*LinkAttachToPoint` is `1` for the target's start and `2` for the target's end, and the distance
 * is added. The editor writes the resolved absolute `start` next to the anchor, so the corpus
 * answers the question directly: over every anchor whose target has a non-zero duration, a `2`
 * anchor's stored time equals the target's end plus the distance and never its start, and a `1`
 * anchor's equals the start. `cutscene-corpus.test.ts` pins those counts, so a patch that changed
 * the meaning would fail there rather than render plausible wrong timings.
 *
 * Any other value has no measured meaning. It resolves like `1` and marks the clip approximate,
 * because a guess would be invisible in the rendered timeline.
 */
import { valueOf, walk, walkWithParent, type CutsceneDocument, type CutsceneElement, type CutsceneGuid } from './model.js'

export interface CutsceneAnchor {
  readonly targetGuid: CutsceneGuid
  readonly attachToPoint: number
  readonly distance: number
}

export interface CutsceneClip {
  readonly guid: CutsceneGuid | undefined
  readonly tag: string
  /** The track this clip sits on, and the track's name — what a timeline row is labelled with. */
  readonly trackTag: string
  readonly trackName: string | undefined
  readonly start: number
  readonly end: number
  readonly duration: number
  /** True when `start` came from `lockedToEnd`, an anchor, or a default rather than the file. */
  readonly derived: boolean
  /**
   * True when resolving this clip depended on an attach point outside the measured `1`/`2`, or on
   * an anchor cycle, so the time above is not exact.
   */
  readonly approximate: boolean
  readonly startAnchor: CutsceneAnchor | undefined
  readonly endAnchor: CutsceneAnchor | undefined
}

export interface CutsceneTimeline {
  readonly clips: readonly CutsceneClip[]
  /** Latest resolved end. Milliseconds if R1 confirms the unit; see `timeUnit`. */
  readonly length: number
  /**
   * The unit is `'milliseconds-probable'`, never `'milliseconds'`.
   *
   * The evidence is circumstantial and good: `Zerg01`'s master sound is 199 800 units long, which
   * is 199.8 s for an opening cinematic. It is not a measurement, and question R1 closes it by
   * comparing sound durations against the audio in the archive.
   */
  readonly timeUnit: 'milliseconds-probable'
  /** Anchors naming an element this document does not contain; they resolve to their offset alone. */
  readonly unresolvedAnchors: number
  /** Anchor chains that lead back to themselves; each is broken at the repeat, not followed. */
  readonly cyclicAnchors: readonly CutsceneGuid[]
  /** Clips whose time depends on an unmeasured attach point or an anchor cycle. */
  readonly approximateClips: number
  readonly masterSoundDuration: number | undefined
}

function integer(element: CutsceneElement, name: string): number | undefined {
  const raw = valueOf(element, name)
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function anchorOf(element: CutsceneElement, prefix: 'start' | 'end'): CutsceneAnchor | undefined {
  const target = valueOf(element, `${prefix}LinkGuid`)
  if (target === undefined || target === '' || target === '0') return undefined
  return Object.freeze({
    targetGuid: target,
    attachToPoint: integer(element, `${prefix}LinkAttachToPoint`) ?? 1,
    distance: integer(element, `${prefix}LinkDistance`) ?? 0,
  })
}

const CLIP_TAG = /^(?:CCutsceneElement|AnimBlock$)/u

/** `true` for the target's end, `false` for its start, `undefined` for an unmeasured value. */
function attachesToEnd(attachToPoint: number): boolean | undefined {
  if (attachToPoint === 1) return false
  if (attachToPoint === 2) return true
  return undefined
}

/**
 * Resolve every clip to an absolute start and end.
 *
 * Anchors are followed lazily with a visiting set, so a cycle costs one pass and is reported rather
 * than hanging: the corpus has none, but 327 references already point at nothing, and a format that
 * tolerates that will tolerate a loop too.
 */
export function resolveTimeline(document: CutsceneDocument): CutsceneTimeline {
  const byGuid = new Map<CutsceneGuid, CutsceneElement>()
  const trackOf = new Map<CutsceneElement, CutsceneElement | undefined>()
  for (const { element, parent } of walkWithParent(document.root)) {
    const guid = valueOf(element, 'guid')
    // First writer wins: 33 identifiers in the corpus are used twice, and an anchor naming one is
    // ambiguous in the file itself. Overwriting would make the answer depend on document order.
    if (guid !== undefined && guid !== '' && !byGuid.has(guid)) byGuid.set(guid, element)
    trackOf.set(element, parent)
  }

  const resolved = new Map<CutsceneElement, { start: number; end: number; approximate: boolean }>()
  const visiting = new Set<CutsceneElement>()
  const cyclic = new Set<CutsceneGuid>()
  let unresolvedAnchors = 0

  const resolveElement = (
    element: CutsceneElement,
  ): { start: number; end: number; approximate: boolean } => {
    const cached = resolved.get(element)
    if (cached !== undefined) return cached
    if (visiting.has(element)) {
      const guid = valueOf(element, 'guid')
      if (guid !== undefined) cyclic.add(guid)
      return { start: integer(element, element.tag === 'AnimBlock' ? 'time' : 'start') ?? 0, end: integer(element, element.tag === 'AnimBlock' ? 'time' : 'start') ?? 0, approximate: true }
    }
    visiting.add(element)

    const duration = integer(element, 'duration') ?? 0
    let approximate = false
    let start = integer(element, element.tag === 'AnimBlock' ? 'time' : 'start') ?? 0

    const startAnchor = anchorOf(element, 'start')
    if (startAnchor !== undefined) {
      const target = byGuid.get(startAnchor.targetGuid)
      if (target === undefined) unresolvedAnchors += 1
      else {
        const base = resolveElement(target)
        const toEnd = attachesToEnd(startAnchor.attachToPoint)
        if (toEnd === undefined) approximate = true
        start = (toEnd === true ? base.end : base.start) + startAnchor.distance
        approximate = approximate || base.approximate
      }
    }

    let end = start + duration
    const endAnchor = anchorOf(element, 'end')
    if (endAnchor !== undefined) {
      const target = byGuid.get(endAnchor.targetGuid)
      if (target === undefined) unresolvedAnchors += 1
      else {
        const base = resolveElement(target)
        const toEnd = attachesToEnd(endAnchor.attachToPoint)
        if (toEnd === undefined) approximate = true
        end = (toEnd === true ? base.end : base.start) + endAnchor.distance
        approximate = approximate || base.approximate
      }
    }

    const answer = { start, end: Math.max(start, end), approximate }
    visiting.delete(element)
    resolved.set(element, answer)
    return answer
  }

  const clips: CutsceneClip[] = []
  for (const element of walk(document.root)) {
    if (!CLIP_TAG.test(element.tag)) continue
    const times = resolveElement(element)
    const track = trackOf.get(element)
    clips.push(
      Object.freeze({
        guid: valueOf(element, 'guid'),
        tag: element.tag,
        trackTag: track?.tag ?? document.root.tag,
        trackName: track === undefined ? undefined : valueOf(track, 'name'),
        start: times.start,
        end: times.end,
        duration: times.end - times.start,
        derived: valueOf(element, element.tag === 'AnimBlock' ? 'time' : 'start') === undefined || anchorOf(element, 'start') !== undefined,
        approximate: times.approximate,
        startAnchor: anchorOf(element, 'start'),
        endAnchor: anchorOf(element, 'end'),
      }),
    )
  }

  let masterSoundDuration: number | undefined
  for (const { element, parent } of walkWithParent(document.root)) {
    if (parent?.tag !== 'CCutsceneNodeMasterSound') continue
    const duration = integer(element, 'duration') ?? integer(parent, 'assetDuration')
    if (duration !== undefined) masterSoundDuration = Math.max(masterSoundDuration ?? 0, duration)
  }

  return Object.freeze({
    clips,
    length: clips.reduce((longest, clip) => Math.max(longest, clip.end), 0),
    timeUnit: 'milliseconds-probable' as const,
    unresolvedAnchors,
    cyclicAnchors: [...cyclic],
    approximateClips: clips.filter(clip => clip.approximate).length,
    masterSoundDuration,
  })
}
