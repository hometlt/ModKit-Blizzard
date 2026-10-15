/**
 * The whole corpus, read and written back.
 *
 * This is the module's real acceptance gate, and it is deliberately harsh: `decode` then `encode`
 * must reproduce **every** shipped cutscene byte for byte. Anything softer — "semantically equal",
 * "the same after normalising whitespace" — checks only the facts the comparison already knows to
 * look for, which is the same set the reader already knows to keep. It proves nothing about what
 * was dropped.
 *
 * Getting here took fixing five real defects rather than relaxing the rule once: a stripped byte
 * order mark, a collapsed double space between attributes, an empty element rewritten from
 * `<Tag>\n</Tag>` to `<Tag></Tag>`, re-indented hand-edited files, and a trailing newline invented
 * for the 2071 files that have none and dropped from the 162 that do.
 *
 * The Heroes of the Storm files are here because they are the same format — 42 of 47 tags in
 * common — and they quadruple the evidence for free. They are also why this file is corpus-gated:
 * the numbers below describe an extracted game-data tree, and a developer without one should not
 * see a red suite.
 *
 * Every file is decoded once, into `measured` below, because decoding 2233 documents per assertion
 * turned this suite into eight minutes of repeated work.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { curveChannelsOf, curveSummary, pathTangentsOf } from '../codecs/cutscene/src/curves.js'
import { decodeCutscene } from '../codecs/cutscene/src/decode.js'
import { encodeCutscene } from '../codecs/cutscene/src/encode.js'
import { valueOf, walk, type CutsceneElement } from '../codecs/cutscene/src/model.js'
import { externalReferencesOf } from '../codecs/cutscene/src/refs.js'
import { isKnownTag, tagEntry } from '../codecs/cutscene/src/registry.js'
import { resolveTimeline } from '../codecs/cutscene/src/timeline.js'
import { findingsOf, validateCutscene } from '../codecs/cutscene/src/validate.js'

const corpusRoot =
  process.env.MODKITX_SC2_GAMEDATA_ROOT?.trim() ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'references', 'SC2GameData')

const CUTSCENE_FILE = /\.(sc2cutscene|stormcutscene)$/iu
const UINT64_MAX = 18446744073709551615n

function cutsceneFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) cutsceneFiles(path, found)
    else if (CUTSCENE_FILE.test(entry.name)) found.push(path)
  }
  return found
}

const available = existsSync(corpusRoot)
const files = available ? cutsceneFiles(corpusRoot) : []

interface CorpusMeasurement {
  sc2Files: number
  stormFiles: number
  roundTripFailures: string[]
  guids: number
  wideGuids: number
  noVersion: number
  byteOrderMarks: number
  usAscii: number
  trailingNewline: number
  duplicateGuidFiles: number
  errorFindings: number
  unknownTags: Set<string>
  originMismatches: string[]
  curveKeys: number
  curveTangentTypes: Map<number, number>
  pathTangentTypes: Map<number, number>
  pathMarkersWithTangents: number
  cyclicAnchors: number
  approximateClips: number
  referenceRoles: Map<string, number>
  fabricatedReferences: string[]
  /** Anchors to a non-zero-duration target whose stored time confirms / contradicts `1 = start, 2 = end`. */
  attachPointConfirmed: Map<string, number>
  attachPointContradicted: string[]
  /** Tangent type → interior key sides, and how many carry the geometry the type is named after. */
  tangentGeometry: Map<number, { sides: number; matching: number }>
}

/**
 * R3, measured. No anchor contradicts `1 = start, 2 = end`; the 7 of 4 774 that confirm neither
 * reading are chained anchors whose stored time predates an edit of their target.
 */
const ATTACH_POINT_CONFIRMED = { 'end:1': 114, 'end:2': 183, 'start:1': 3727, 'start:2': 743 }

/**
 * R2, measured on interior key sides. `4` holds on every side; `3`, `5` and `7` on 99.1–99.7 %.
 * `6` leaves the one-third time on 55 %, which is what free control points look like. `0` has no
 * geometry at all and stays unnamed.
 */
const TANGENT_GEOMETRY = {
  0: { sides: 1701, matching: 0 },
  3: { sides: 169_461, matching: 168_847 },
  4: { sides: 13_470, matching: 13_470 },
  5: { sides: 10_409, matching: 10_380 },
  6: { sides: 13_093, matching: 7138 },
  7: { sides: 41_922, matching: 41_543 },
}

const nearly = (left: number, right: number, tolerance: number) =>
  Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right))

/** One pass over the corpus; every assertion below reads from this. */
function measure(paths: readonly string[]): CorpusMeasurement {
  const seenIn = new Map<string, { sc2: boolean; storm: boolean }>()
  const state: CorpusMeasurement = {
    sc2Files: 0,
    stormFiles: 0,
    roundTripFailures: [],
    guids: 0,
    wideGuids: 0,
    noVersion: 0,
    byteOrderMarks: 0,
    usAscii: 0,
    trailingNewline: 0,
    duplicateGuidFiles: 0,
    errorFindings: 0,
    unknownTags: new Set(),
    originMismatches: [],
    curveKeys: 0,
    curveTangentTypes: new Map(),
    pathTangentTypes: new Map(),
    pathMarkersWithTangents: 0,
    cyclicAnchors: 0,
    approximateClips: 0,
    referenceRoles: new Map(),
    fabricatedReferences: [],
    attachPointConfirmed: new Map(),
    attachPointContradicted: [],
    tangentGeometry: new Map(),
  }
  const bump = (bucket: Map<number, number>, key: number) =>
    bucket.set(key, (bucket.get(key) ?? 0) + 1)

  for (const path of paths) {
    const storm = /\.stormcutscene$/iu.test(path)
    if (storm) state.stormFiles += 1
    else state.sc2Files += 1

    const bytes = readFileSync(path)
    let document
    try {
      document = decodeCutscene(bytes)
    } catch (error) {
      state.roundTripFailures.push(`${path}: ${(error as Error).message}`)
      continue
    }

    const written = Buffer.from(encodeCutscene(document))
    if (!written.equals(bytes)) {
      let at = 0
      while (at < Math.min(written.length, bytes.length) && written[at] === bytes[at]) at += 1
      state.roundTripFailures.push(`${path}: differs at byte ${at}`)
    }

    if (document.version === undefined) state.noVersion += 1
    if (document.byteOrderMark) state.byteOrderMarks += 1
    if (document.declaration.includes('us-ascii')) state.usAscii += 1
    if (/\n$/u.test(document.text)) state.trailingNewline += 1

    const stack = [document.root]
    while (stack.length > 0) {
      const element = stack.pop()
      if (element === undefined) continue
      for (const child of element.children) stack.push(child)

      if (!isKnownTag(element.tag)) state.unknownTags.add(element.tag)
      const seen = seenIn.get(element.tag) ?? { sc2: false, storm: false }
      if (storm) seen.storm = true
      else seen.sc2 = true
      seenIn.set(element.tag, seen)

      for (const attribute of element.attributes) {
        if (!/guid$/iu.test(attribute.name) || !/^\d+$/u.test(attribute.value)) continue
        state.guids += 1
        if (BigInt(attribute.value) > UINT64_MAX) state.wideGuids += 1
      }
    }

    const report = validateCutscene(document)
    if (report.duplicateGuids.length > 0) state.duplicateGuidFiles += 1
    state.errorFindings += findingsOf(report).filter(item => item.severity === 'error').length

    const curves = curveSummary(curveChannelsOf(document))
    state.curveKeys += curves.keys
    for (const [type, count] of curves.tangentTypes) {
      state.curveTangentTypes.set(type, (state.curveTangentTypes.get(type) ?? 0) + count)
    }
    const pathTangents = pathTangentsOf(document)
    state.pathMarkersWithTangents += pathTangents.typeIn.length
    for (const type of pathTangents.typeIn) bump(state.pathTangentTypes, type)

    const timeline = resolveTimeline(document)
    state.cyclicAnchors += timeline.cyclicAnchors.length
    state.approximateClips += timeline.approximateClips

    /*
     * R3 evidence. The editor stores the resolved absolute time beside each anchor, so where the
     * target has a duration the two readings of `*LinkAttachToPoint` predict different stored times
     * and the file says which one the editor used.
     */
    const byGuid = new Map<string, CutsceneElement>()
    for (const element of walk(document.root)) {
      const guid = valueOf(element, 'guid')
      if (guid !== undefined && !byGuid.has(guid)) byGuid.set(guid, element)
    }
    const numeric = (element: CutsceneElement, name: string) => {
      const raw = valueOf(element, name)
      return raw === undefined || raw === '' ? undefined : Number(raw)
    }
    for (const element of walk(document.root)) {
      for (const prefix of ['start', 'end'] as const) {
        const target = byGuid.get(valueOf(element, `${prefix}LinkGuid`) ?? '')
        const targetStart = target === undefined ? undefined : numeric(target, 'start')
        const targetDuration = target === undefined ? 0 : (numeric(target, 'duration') ?? 0)
        const ownStart = numeric(element, 'start')
        if (targetStart === undefined || ownStart === undefined || targetDuration === 0) continue
        const stored = prefix === 'start' ? ownStart : ownStart + (numeric(element, 'duration') ?? 0)
        const distance = numeric(element, `${prefix}LinkDistance`) ?? 0
        const point = valueOf(element, `${prefix}LinkAttachToPoint`) ?? '1'
        const atStart = stored === targetStart + distance
        const atEnd = stored === targetStart + targetDuration + distance
        const claimed = point === '2' ? atEnd : atStart
        const other = point === '2' ? atStart : atEnd
        const key = `${prefix}:${point}`
        if (claimed) state.attachPointConfirmed.set(key, (state.attachPointConfirmed.get(key) ?? 0) + 1)
        else if (other) state.attachPointContradicted.push(`${path}: ${key} guid=${valueOf(element, 'guid')}`)
      }
    }

    /*
     * R2 evidence. On interior keys, the control-point geometry each tangent type is named after:
     * linear lies on the line to the neighbour, flat keeps the key's value, smooth is collinear
     * through the key, auto is collinear and flat at an extremum, custom leaves the one-third time.
     */
    for (const channel of curveChannelsOf(document)) {
      for (let index = 1; index < channel.keys - 1; index += 1) {
        const time = channel.time[index]!
        const value = channel.value[index]!
        const previous = { time: channel.time[index - 1]!, value: channel.value[index - 1]! }
        const next = { time: channel.time[index + 1]!, value: channel.value[index + 1]! }
        const slopeIn = (value - channel.controlInValue[index]!) / (time - channel.controlInTime[index]!)
        const slopeOut = (channel.controlOutValue[index]! - value) / (channel.controlOutTime[index]! - time)
        const extremum = (value - previous.value) * (next.value - value) <= 0
        const sides = [
          [channel.typeIn[index]!, channel.controlInTime[index]!, channel.controlInValue[index]!, previous],
          [channel.typeOut[index]!, channel.controlOutTime[index]!, channel.controlOutValue[index]!, next],
        ] as const
        for (const [type, controlTime, controlValue, neighbour] of sides) {
          const third = nearly(controlTime, time + (neighbour.time - time) / 3, 1e-4)
          const flat = nearly(controlValue, value, 1e-5)
          const collinear = nearly(slopeIn, slopeOut, 1e-3)
          const matching =
            type === 3 ? third && nearly(controlValue, value + (neighbour.value - value) / 3, 1e-4)
              : type === 4 ? third && flat
                : type === 5 ? third && collinear
                  : type === 7 ? third && collinear && (!extremum || flat)
                    : type === 6 ? !third
                      : false
          const bucket = state.tangentGeometry.get(type) ?? { sides: 0, matching: 0 }
          bucket.sides += 1
          if (matching) bucket.matching += 1
          state.tangentGeometry.set(type, bucket)
        }
      }
    }

    for (const reference of externalReferencesOf(document)) {
      state.referenceRoles.set(
        reference.role,
        (state.referenceRoles.get(reference.role) ?? 0) + 1,
      )
      // Every published name occurs verbatim in the file it came from. A codec that assembled a
      // path — appending `.m3`, prefixing `Assets\` — would fail this, and should.
      if (!document.text.includes(reference.value)) {
        state.fabricatedReferences.push(`${path}: ${reference.attribute}=${reference.value}`)
      }
    }
  }

  for (const [tag, seen] of seenIn) {
    const declared = tagEntry(tag)?.origin
    const observed = seen.sc2 && seen.storm ? 'both' : seen.sc2 ? 'sc2' : 'storm'
    if (declared !== observed) {
      state.originMismatches.push(`${tag}: table says ${declared}, corpus says ${observed}`)
    }
  }
  return state
}

const measured = available && files.length > 0 ? measure(files) : undefined

describe.skipIf(measured === undefined)('sc2-cutscene corpus', () => {
  const corpus = measured as CorpusMeasurement

  it('holds the corpus the specification was measured on', () => {
    expect(corpus.sc2Files).toBe(336)
    expect(corpus.stormFiles).toBe(1897)
  })

  it('reads every shipped cutscene and writes it back byte for byte', () => {
    expect(corpus.roundTripFailures.slice(0, 10)).toEqual([])
    expect(corpus.roundTripFailures).toHaveLength(0)
  })

  /*
   * The identifier rule, checked where it matters rather than on a fixture. 15 486 identifiers in
   * Blizzard's own files are larger than `uint64_max`, so this is not an edge case to guard
   * against — it is a property of the corpus, and any reader that narrows them corrupts 15 486
   * references at once.
   */
  it('carries the identifiers that no 64-bit integer can hold', () => {
    expect(corpus.guids).toBe(719_417)
    expect(corpus.wideGuids).toBe(15_486)
  })

  it('opens the shipped irregularities instead of treating them as defects', () => {
    expect(corpus.noVersion).toBe(5)
    expect(corpus.byteOrderMarks).toBe(4)
    expect(corpus.usAscii).toBe(10)
    expect(corpus.trailingNewline).toBe(162)
    expect(corpus.duplicateGuidFiles).toBe(5)
    /*
     * Not one error across 2233 official files. That is the point of the validator's design: every
     * irregularity Blizzard actually ships — dangling anchors, repeated identifiers, a missing
     * version — is a warning or information, because a checker that called them errors would be
     * telling a modder their game's own content is broken.
     */
    expect(corpus.errorFindings).toBe(0)
  })

  it('finds no tag outside the measured type table', () => {
    expect([...corpus.unknownTags]).toEqual([])
  })

  /*
   * The registry says which game ships each tag, and this is what makes that claim testable rather
   * than a comment. If Blizzard adds `CCutsceneNodeRTTChannel` to Heroes, or an SC2 patch drops a
   * tag, the table is wrong and this says so.
   */
  it('confirms which of the two games ships each tag', () => {
    expect(corpus.originMismatches).toEqual([])
  })

  /*
   * 209 804 curve keys read through the array representation — the check that it holds the whole
   * corpus, and that the tangent-type vocabulary R2 has to explain is still the same set.
   */
  it('reads every curve channel and reports its tangent types', () => {
    expect(corpus.curveKeys).toBe(209_804)
    expect([...corpus.curveTangentTypes.keys()].sort((left, right) => left - right)).toEqual([
      0, 3, 4, 5, 6, 7,
    ])
    // `1` appears nowhere in either game's content, which the specification flags as unexplained
    // rather than as an absent feature.
    expect(corpus.curveTangentTypes.has(1)).toBe(false)
  })

  /*
   * The value the shape of the format hides. `curveInType` is not only on curve keys: 58 path
   * markers carry it directly, and every occurrence of type `2` in the entire corpus is one of
   * them. A reader that looked only at `CCutsceneElementPropertyCurve` would report six tangent
   * types where the format has seven — and R2 would be asked the wrong question.
   */
  it('finds the tangent type that lives only on path markers', () => {
    expect(corpus.pathMarkersWithTangents).toBe(58)
    expect([...corpus.pathTangentTypes.entries()].sort((left, right) => left[0] - right[0])).toEqual([
      [2, 3],
      [3, 19],
      [4, 2],
      [7, 34],
    ])
    expect(corpus.curveTangentTypes.has(2)).toBe(false)
  })

  it('resolves every timeline exactly, without following an anchor cycle', () => {
    expect(corpus.cyclicAnchors).toBe(0)
    expect(corpus.approximateClips).toBe(0)
  })

  it('confirms that attach point 1 is the target start and 2 is its end', () => {
    expect(corpus.attachPointContradicted.slice(0, 10)).toEqual([])
    expect(Object.fromEntries([...corpus.attachPointConfirmed].sort())).toEqual(ATTACH_POINT_CONFIRMED)
  })

  it('shows the control-point geometry each named tangent type is built with', () => {
    expect(Object.fromEntries([...corpus.tangentGeometry].sort((left, right) => left[0] - right[0]))).toEqual(TANGENT_GEOMETRY)
  })

  it('extracts references only from attributes, never from a guessed path', () => {
    expect(corpus.fabricatedReferences).toEqual([])
    expect(corpus.referenceRoles.get('model')).toBe(2473)
    expect(corpus.referenceRoles.get('model-animation')).toBe(428)
    expect(corpus.referenceRoles.get('sound')).toBe(10_241)
    expect(corpus.referenceRoles.get('cutscene')).toBe(3534)
  })
})
