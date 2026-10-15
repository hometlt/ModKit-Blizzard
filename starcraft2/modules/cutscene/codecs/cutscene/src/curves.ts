/**
 * Animated property channels, held as arrays rather than as objects.
 *
 * `CCutsceneElementPropertyCurve` is 209 804 of the corpus's elements — 142 276 of them in the 336
 * SC2 files alone, about 28 % of everything those files contain — and a single large scene carries
 * tens of thousands of them. Keeping each key as an object
 * with a dozen fields is what a first pass naturally writes and is also what makes a campaign's
 * cutscene folder cost hundreds of megabytes to hold open. Six typed arrays per channel cost the
 * same bytes as the numbers themselves.
 *
 * The element tree is unaffected: it still holds every key, because the writer has to put back the
 * exact spelling of `0.000000`. This is the *reading* view — what a curve editor, a sampler or a
 * diff walks — and it is built on demand from the tree rather than replacing it.
 *
 * ## What a key stores, and what the tangent types mean (question R2, settled from the corpus)
 *
 * `curveInValue`/`curveOutValue` are not tangent/weight pairs: they are the `time,value` of the
 * incoming and outgoing cubic Bézier control points. For every automatic mode the control point
 * sits one third of the way to the neighbouring key in time, which is exactly the Hermite-to-Bézier
 * construction, so the segment between two keys is the Bézier through key, out-control, next
 * in-control, next key.
 *
 * The type records how the editor built a control point, and the geometry says which is which.
 * Over the interior keys of 2233 files (`cutscene-corpus.test.ts` pins the counts):
 * - `3` linear — the control point lies on the straight line to the neighbouring key;
 * - `4` flat — the control point has the key's own value;
 * - `5` smooth — both control points are collinear through the key with the Catmull-Rom slope;
 * - `7` auto — as smooth, but flat at a local extremum (clamped);
 * - `6` custom — free control points, usually off the one-third time.
 * `0` (1 701 sides) and `2` (3 path markers) show no consistent geometry and stay unnamed. `1` never
 * appears. Sampling does not need the type — the control points are stored — but a segment touching
 * an unnamed type is reported as approximate, because one of them may be a step the Bézier would
 * smooth over.
 *
 * They are also not only on curve keys. 58 `CCutsceneNodePathMarker` nodes carry the same two
 * attributes directly — a path marker is a key on a spatial curve rather than on a property one —
 * and all three occurrences of type `2` in the entire corpus are among them. Counting only
 * `CCutsceneElementPropertyCurve`, which is what the format's shape suggests, loses one of the
 * seven values that R2 has to explain. `pathTangentsOf` collects them.
 */
import { valueOf, walkWithParent, type CutsceneDocument, type CutsceneElement } from './model.js'

export interface CutsceneCurveChannel {
  /** `propertyName` on the owning `CCutsceneNodePropertyValue`, e.g. `positionX` or `fov`. */
  readonly property: string
  /** The track the channel animates — the actor, light or camera the property belongs to. */
  readonly ownerTag: string
  readonly ownerName: string | undefined
  readonly ownerGuid: string | undefined
  readonly keys: number
  readonly time: Float64Array
  readonly value: Float64Array
  /** `curveInValue` / `curveOutValue`: the incoming and outgoing Bézier control points. */
  readonly controlInTime: Float64Array
  readonly controlInValue: Float64Array
  readonly controlOutTime: Float64Array
  readonly controlOutValue: Float64Array
  /** Raw `curveInType` / `curveOutType`; `tangentModeOf` names the measured ones. */
  readonly typeIn: Uint8Array
  readonly typeOut: Uint8Array
  /**
   * `CCutsceneElementPropertyValue` — stepped values on the same channel, which the format uses
   * instead of a curve for properties that do not interpolate. Kept apart rather than flattened
   * into the key arrays, because a step is not a key with a flat tangent.
   */
  readonly steps: readonly { readonly start: number; readonly duration: number; readonly value: string }[]
}

function numberAt(element: CutsceneElement, name: string): number {
  const raw = valueOf(element, name)
  if (raw === undefined || raw === '') return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `-1.000000,0.254902` → the pair. A malformed or absent value contributes zeroes, not NaN. */
function pairAt(element: CutsceneElement, name: string): [number, number] {
  const raw = valueOf(element, name)
  if (raw === undefined) return [0, 0]
  const comma = raw.indexOf(',')
  if (comma < 0) {
    const single = Number(raw)
    return [Number.isFinite(single) ? single : 0, 0]
  }
  const first = Number(raw.slice(0, comma))
  const second = Number(raw.slice(comma + 1))
  return [Number.isFinite(first) ? first : 0, Number.isFinite(second) ? second : 0]
}

const CURVE_KEY = 'CCutsceneElementPropertyCurve'
const PATH_MARKER = 'CCutsceneNodePathMarker'
const CURVE_STEP = 'CCutsceneElementPropertyValue'
const CHANNEL_NODE = 'CCutsceneNodePropertyValue'

function owningPairs(document: CutsceneDocument): Map<CutsceneElement, CutsceneElement | undefined> {
  const owners = new Map<CutsceneElement, CutsceneElement | undefined>()
  for (const { element, parent } of walkWithParent(document.root)) owners.set(element, parent)
  return owners
}

/** Every animated channel in the document, in document order. */
export function curveChannelsOf(document: CutsceneDocument): CutsceneCurveChannel[] {
  const channels: CutsceneCurveChannel[] = []
  for (const [element, parent] of owningPairs(document)) {
    if (element.tag !== CHANNEL_NODE) continue
    const keyElements = element.children.filter(child => child.tag === CURVE_KEY)
    const stepElements = element.children.filter(child => child.tag === CURVE_STEP)
    const keys = keyElements.length

    const time = new Float64Array(keys)
    const value = new Float64Array(keys)
    const controlInTime = new Float64Array(keys)
    const controlInValue = new Float64Array(keys)
    const controlOutTime = new Float64Array(keys)
    const controlOutValue = new Float64Array(keys)
    const typeIn = new Uint8Array(keys)
    const typeOut = new Uint8Array(keys)

    for (let index = 0; index < keys; index += 1) {
      const key = keyElements[index] as CutsceneElement
      time[index] = numberAt(key, 'time')
      value[index] = numberAt(key, 'value')
      ;[controlInTime[index], controlInValue[index]] = pairAt(key, 'curveInValue')
      ;[controlOutTime[index], controlOutValue[index]] = pairAt(key, 'curveOutValue')
      typeIn[index] = numberAt(key, 'curveInType')
      typeOut[index] = numberAt(key, 'curveOutType')
    }

    channels.push(
      Object.freeze({
        property: valueOf(element, 'propertyName') ?? '',
        ownerTag: parent?.tag ?? document.root.tag,
        ownerName: parent === undefined ? undefined : valueOf(parent, 'name'),
        ownerGuid: parent === undefined ? undefined : valueOf(parent, 'guid'),
        keys,
        time,
        value,
        controlInTime,
        controlInValue,
        controlOutTime,
        controlOutValue,
        typeIn,
        typeOut,
        steps: stepElements.map(step =>
          Object.freeze({
            start: numberAt(step, 'start'),
            duration: numberAt(step, 'duration'),
            value: valueOf(step, 'value') ?? '',
          }),
        ),
      }),
    )
  }
  return channels
}

export type CutsceneTangentMode = 'linear' | 'flat' | 'smooth' | 'auto' | 'custom'

const TANGENT_MODES: ReadonlyMap<number, CutsceneTangentMode> = new Map([
  [3, 'linear'],
  [4, 'flat'],
  [5, 'smooth'],
  [6, 'custom'],
  [7, 'auto'],
])

/** The measured meaning of a `curveInType`/`curveOutType`; `undefined` for `0`, `2` and anything new. */
export function tangentModeOf(type: number): CutsceneTangentMode | undefined {
  return TANGENT_MODES.get(type)
}

/**
 * The channel's value at `time`: the Bézier segment through the two surrounding keys and their
 * stored control points, held at the first and last key outside the keyed range.
 *
 * The segment's time is solved for its parameter by bisection, so custom control points off the
 * one-third time still sample correctly. `approximate` is set when either side of the segment uses
 * an unnamed tangent type.
 */
export function sampleChannel(
  channel: CutsceneCurveChannel,
  time: number,
): { readonly value: number; readonly approximate: boolean } | undefined {
  const last = channel.keys - 1
  if (last < 0) return undefined
  if (time <= (channel.time[0] ?? 0)) return { value: channel.value[0] ?? 0, approximate: false }
  if (time >= (channel.time[last] ?? 0)) return { value: channel.value[last] ?? 0, approximate: false }
  let index = 0
  while (index < last - 1 && time > (channel.time[index + 1] ?? 0)) index += 1
  const next = index + 1
  if (time === channel.time[next]) return { value: channel.value[next]!, approximate: false }
  const bezier = (p0: number, p1: number, p2: number, p3: number, u: number) => {
    const v = 1 - u
    return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3
  }
  const x = [channel.time[index] ?? 0, channel.controlOutTime[index] ?? 0, channel.controlInTime[next] ?? 0, channel.time[next] ?? 0] as const
  const y = [channel.value[index] ?? 0, channel.controlOutValue[index] ?? 0, channel.controlInValue[next] ?? 0, channel.value[next] ?? 0] as const
  let low = 0
  let high = 1
  for (let step = 0; step < 48; step += 1) {
    const middle = (low + high) / 2
    if (bezier(x[0], x[1], x[2], x[3], middle) < time) low = middle
    else high = middle
  }
  return {
    value: bezier(y[0], y[1], y[2], y[3], (low + high) / 2),
    approximate: tangentModeOf(channel.typeOut[index] ?? 0) === undefined || tangentModeOf(channel.typeIn[next] ?? 0) === undefined,
  }
}

export interface CutscenePathTangents {
  /** Markers carrying `curveInType`, and their values. */
  readonly typeIn: Uint8Array
  /** Markers carrying `curveOutType`. Not the same markers: 58 carry one, 47 the other. */
  readonly typeOut: Uint8Array
}

/**
 * Tangent types carried by path markers rather than by curve keys.
 *
 * Kept apart from `curveChannelsOf` because a path marker is a node with a position, not a key on a
 * named property channel; folding them together would report 58 property keys that do not exist.
 *
 * The two arrays are collected independently rather than as parallel columns, because the two
 * attributes are not on the same markers — a marker with `curveOutType` and no `curveInType` would
 * otherwise contribute a zero that the file never wrote, and zero is one of the seven values R2 has
 * to account for. An invented one would send that question after a value that is not there.
 */
export function pathTangentsOf(document: CutsceneDocument): CutscenePathTangents {
  const inTypes: number[] = []
  const outTypes: number[] = []
  for (const [element] of owningPairs(document)) {
    if (element.tag !== PATH_MARKER) continue
    if (valueOf(element, 'curveInType') !== undefined) inTypes.push(numberAt(element, 'curveInType'))
    if (valueOf(element, 'curveOutType') !== undefined) {
      outTypes.push(numberAt(element, 'curveOutType'))
    }
  }
  return Object.freeze({ typeIn: Uint8Array.from(inTypes), typeOut: Uint8Array.from(outTypes) })
}

export interface CutsceneCurveSummary {
  readonly channels: number
  readonly keys: number
  readonly steps: number
  /** Distinct `propertyName`s, sorted. The corpus uses 83; the full vocabulary is unknown (R4). */
  readonly properties: readonly string[]
  /** How many keys carry each raw tangent type, so the R2 distribution is visible, not asserted. */
  readonly tangentTypes: ReadonlyMap<number, number>
}

export function curveSummary(channels: readonly CutsceneCurveChannel[]): CutsceneCurveSummary {
  const properties = new Set<string>()
  const tangentTypes = new Map<number, number>()
  let keys = 0
  let steps = 0
  for (const channel of channels) {
    if (channel.property !== '') properties.add(channel.property)
    keys += channel.keys
    steps += channel.steps.length
    for (const type of channel.typeIn) tangentTypes.set(type, (tangentTypes.get(type) ?? 0) + 1)
  }
  return Object.freeze({
    channels: channels.length,
    keys,
    steps,
    properties: [...properties].sort(),
    tangentTypes,
  })
}
