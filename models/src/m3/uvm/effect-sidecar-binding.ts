import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { JsonObject, JsonValue } from '@modkit/sdk'
import type { M3EffectsBudget } from '../runtime/effects.js'
import type { M3EffectsSource } from './effects.js'
import type { M3SequenceBinding } from './animation-binding.js'
import type { M3EffectSidecarSource } from './effect-sidecar-source.js'

export interface M3CombinedEffectsSource extends M3EffectsSource {
  readonly sequenceIndexSpace: 'combined'
  readonly sidecarBinding: JsonObject
}
const kinds = ['particles', 'ribbons', 'forces', 'warps', 'projectors'] as const
function object(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`invalid M3 effect ${label}`)
  return value as Record<string, JsonValue>
}
function array(value: JsonValue | undefined, label: string): JsonValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`invalid M3 effect ${label}`)
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('invalid M3 effect sequence index')
  return value
}

/** Both projections use exact base native definitions. Only sequence track containers may
 * differ. All indices are converted once, including nested spline and emission-point tracks. */
export function bindM3EffectSidecars(
  base: M3EffectsSource,
  sidecars: readonly M3EffectSidecarSource[],
  sequences: readonly M3SequenceBinding[],
  budget: M3EffectsBudget,
  signal?: AbortSignal,
): M3CombinedEffectsSource {
  const snapshotBudget = {
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
    maxBytes: budget.maxScalarBytes,
  }
  const owned = snapshotJson({ base, sidecars, sequences }, snapshotBudget, signal) as unknown as {
    base: M3EffectsSource
    sidecars: M3EffectSidecarSource[]
    sequences: M3SequenceBinding[]
  }
  const maps = new Map<string, Map<number, number>>([['base', new Map()]])
  for (const item of owned.sidecars) {
    const key = `sidecar/${item.logicalId}`
    if (!item.logicalId || maps.has(key))
      throw new TypeError('duplicate M3 effect sidecar identity')
    maps.set(key, new Map())
  }
  const combined = new Set<number>(),
    clips = new Set<string>()
  for (const entry of owned.sequences) {
    const map = maps.get(entry.source === 'base' ? 'base' : `sidecar/${entry.logicalId}`)
    const native = integer(entry.nativeSequenceIndex),
      index = integer(entry.combinedSequenceIndex)
    if (
      map === undefined ||
      map.has(native) ||
      combined.has(index) ||
      !entry.clipId ||
      clips.has(entry.clipId)
    )
      throw new TypeError('M3 effect binding requires unique admitted sequence identities')
    map.set(native, index)
    combined.add(index)
    clips.add(entry.clipId)
  }
  for (const sidecar of owned.sidecars) {
    const map = maps.get(`sidecar/${sidecar.logicalId}`)
    if (map === undefined || [...map.keys()].some(index => index >= sidecar.nativeSequenceCount))
      throw new TypeError('M3 effect sidecar sequence lies outside native source')
  }
  let work = 0
  const check = (): void => {
    signal?.throwIfAborted()
    if (++work > budget.maxNodes) throw new RangeError('M3 effect merge exceeds node budget')
  }
  const remapTracks = (
    value: JsonValue | undefined,
    map: ReadonlyMap<number, number>,
  ): JsonValue[] => {
    const seen = new Set<number>()
    return array(value, 'sequence tracks').map(raw => {
      check()
      const track = object(raw, 'sequence track'),
        native = integer(track['sequenceIndex'])
      const index = map.get(native)
      if (index === undefined || seen.has(index))
        throw new TypeError('unmapped or duplicate M3 effect sequence track')
      seen.add(index)
      return { ...track, sequenceIndex: index }
    })
  }
  const remap = (value: JsonValue, map: ReadonlyMap<number, number>, key = ''): JsonValue => {
    check()
    if (key === 'sequenceAnimation') {
      const result: Record<string, JsonValue> = {}
      for (const [property, tracks] of Object.entries(object(value, key)))
        result[property] = remapTracks(tracks, map)
      return result
    }
    if (key === 'emitShapePointSequenceAnimations')
      return array(value, key).map(tracks => remapTracks(tracks, map))
    if (Array.isArray(value)) return value.map(item => remap(item, map))
    if (value !== null && typeof value === 'object') {
      const result: Record<string, JsonValue> = {}
      for (const [property, item] of Object.entries(value))
        result[property] = remap(item, map, property)
      return result
    }
    return value
  }
  const mergeTracks = (left: JsonValue | undefined, right: JsonValue | undefined): JsonValue[] => {
    const tracks = [...array(left, 'tracks'), ...array(right, 'tracks')],
      seen = new Set<number>()
    for (const raw of tracks) {
      check()
      const index = integer(object(raw, 'track')['sequenceIndex'])
      if (seen.has(index))
        throw new TypeError('M3 effect tracks collide in combined sequence space')
      seen.add(index)
    }
    return tracks
  }
  const merge = (
    left: JsonValue | undefined,
    right: JsonValue | undefined,
    key = '',
    particle = false,
  ): JsonValue => {
    check()
    if (key === 'sequenceAnimation') {
      const a = left === undefined ? {} : object(left, key),
        b = right === undefined ? {} : object(right, key)
      const result: Record<string, JsonValue> = {}
      for (const property of new Set([...Object.keys(a), ...Object.keys(b)]))
        result[property] = mergeTracks(a[property], b[property])
      return result
    }
    if (key === 'emitShapePointSequenceAnimations') {
      const a = array(left, key),
        b = array(right, key)
      if (a.length > 0 && b.length > 0 && a.length !== b.length)
        throw new TypeError('M3 emission point correspondence changed')
      return Array.from({ length: Math.max(a.length, b.length) }, (_, index) =>
        mergeTracks(a[index], b[index]),
      )
    }
    // The native builder derives this source-wide flag from locally resolved count tracks.
    // Preserve base fallback; the explicit clip-mode tracks below provide source-specific mode.
    if (particle && key === 'squirt' && typeof left === 'boolean' && typeof right === 'boolean')
      return left
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length)
        throw new TypeError('M3 effect static array correspondence changed')
      return left.map((item, index) => merge(item, right[index]))
    }
    if (
      left !== null &&
      right !== null &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const result: Record<string, JsonValue> = {},
        a = object(left, key),
        b = object(right, key)
      for (const property of new Set([...Object.keys(a), ...Object.keys(b)]))
        result[property] = merge(a[property], b[property], property, particle)
      return result
    }
    if (left !== right || left === undefined)
      throw new TypeError(`M3 effect static definition differs at ${key}`)
    return left
  }
  const baseMap = maps.get('base')
  if (baseMap === undefined) throw new TypeError('missing base effect map')
  const effects = object(remap(owned.base.effects, baseMap), 'combined effects')
  for (const sidecar of owned.sidecars) {
    const map = maps.get(`sidecar/${sidecar.logicalId}`)
    if (map === undefined) throw new TypeError('missing sidecar effect map')
    const projected = object(remap(sidecar.projection.effects, map), 'sidecar effects')
    for (const kind of kinds) {
      const a = array(effects[kind], kind),
        b = array(projected[kind], kind)
      if (a.length !== b.length)
        throw new TypeError(`M3 sidecar changed ${kind} native correspondence`)
      effects[kind] = a.map((emitter, index) => merge(emitter, b[index], '', kind === 'particles'))
    }
  }
  const particles = array(effects['particles'], 'particles')
  for (const [sourceKey, source] of [
    ['base', owned.base] as const,
    ...owned.sidecars.map(sidecar => [`sidecar/${sidecar.logicalId}`, sidecar.projection] as const),
  ]) {
    const map = maps.get(sourceKey)
    if (map === undefined) throw new TypeError('missing effect mode sequence map')
    for (const [ordinal, raw] of array(source.effects['particles'], 'particles').entries()) {
      const original = object(raw, 'particle'),
        target = object(particles[ordinal], 'combined particle')
      const sourceAnimation =
        original['sequenceAnimation'] === undefined
          ? {}
          : object(original['sequenceAnimation'], 'animation')
      const countTracks = new Set(
        array(sourceAnimation['emitCount'], 'emitCount').map(item =>
          integer(object(item, 'count track')['sequenceIndex']),
        ),
      )
      const animation =
        target['sequenceAnimation'] === undefined
          ? {}
          : object(target['sequenceAnimation'], 'animation')
      if (sourceAnimation['squirt'] !== undefined)
        throw new TypeError('native M3 projection already declares combined modes')
      const modes = array(animation['squirt'], 'squirt')
      for (const [native, index] of map) {
        check()
        const burst =
          (typeof original['emitCount'] === 'number' && original['emitCount'] > 0) ||
          countTracks.has(native)
        modes.push({
          sequenceIndex: index,
          track: { lineType: 0, globalSeqId: null, keys: [{ frame: 0, vector: [burst ? 1 : 0] }] },
        })
      }
      animation['squirt'] = modes
      target['sequenceAnimation'] = animation
    }
  }
  return snapshotJson(
    {
      effects,
      diagnostics: owned.base.diagnostics,
      ...(owned.base.particleLighting === undefined
        ? {}
        : { particleLighting: owned.base.particleLighting }),
      animationMetadata: owned.base.animationMetadata,
      ...(owned.base.emissionMeshes === undefined
        ? {}
        : { emissionMeshes: owned.base.emissionMeshes }),
      sequenceIndexSpace: 'combined',
      sidecarBinding: {
        mode: 'native-animation-id',
        sequences: owned.sequences,
        sources: owned.sidecars.map(item => ({
          logicalId: item.logicalId,
          proof: item.proof,
          nativeAnimationMetadata: item.projection.animationMetadata,
          diagnostics: item.projection.diagnostics,
        })),
      },
    },
    snapshotBudget,
    signal,
  ) as unknown as M3CombinedEffectsSource
}
