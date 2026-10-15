/**
 * Native M2/SKEL composition, owned by GAME-WOW (`contributions/codec-wow-m2.json`).
 * The codec supplies a child-first, cycle-checked chain decoded by reader.ts. The oldest parent
 * supplies the bone index space; child animation keys overlay it by animation id + variation,
 * retaining child-only sequences, missing-motion markers, aliases and independent global clocks.
 * No I/O, sampling or coordinate conversion occurs here. Incompatible bone spaces refuse instead
 * of attaching child motion to guessed joints. Unknown skeleton chunks stay with the native reader.
 */
import { SEQUENCE_ALIAS, type M2Attachment, type M2Bone, type M2Keys, type M2Model,
  type M2Sequence, type M2Skeleton, type M2Track } from './reader.js'

interface Layer {
  readonly sequences: readonly M2Sequence[]
  readonly globalLoops: readonly number[]
  readonly indices: ReadonlyMap<string, number>
}
interface TrackLayer<T> { readonly layer: Layer; readonly track: M2Track<T> }

/** Animation identity is not a table position; variations with the same id remain distinct. */
export const sequenceKey = (sequence: M2Sequence): string => `${String(sequence.id)}:${String(sequence.variation)}`

/** One source's positional lookup; duplicate native identities are ambiguous and refused. */
function layerOf(sequences: readonly M2Sequence[], globalLoops: readonly number[]): Layer {
  const indices = new Map<string, number>()
  sequences.forEach((sequence, index) => {
    const key = sequenceKey(sequence)
    if (indices.has(key)) throw new TypeError(`M2 duplicate animation identity ${key}`)
    indices.set(key, index)
  })
  return { sequences, globalLoops, indices }
}

/** Closest child keys win; an explicitly missing child buffer never masquerades as parent motion. */
function mergeTrack<T>(layers: readonly TrackLayer<T>[], sequences: readonly M2Sequence[]): M2Track<T> {
  const missing: number[] = []
  const perSequence = sequences.map((sequence, outputIndex): M2Keys<T> => {
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const { layer, track } = layers[index]!
      const global = track.globalSequence !== null
      const nativeIndex = layer.indices.get(sequenceKey(sequence))
      if (!global && nativeIndex === undefined && layer.sequences.length > 0) continue
      const selected = global ? 0 : nativeIndex ?? outputIndex
      const at = selected < track.perSequence.length ? selected : 0
      if (track.missing.includes(at)) {
        missing.push(outputIndex)
        return { times: [], values: [] }
      }
      const keys = track.perSequence[at]
      if (keys === undefined || keys.values.length === 0) continue
      const period = global ? layer.globalLoops[track.globalSequence!] : undefined
      if (global && period === undefined) throw new TypeError('M2 track refers to a missing global sequence')
      return { ...keys, interpolation: track.interpolation,
        ...(period === undefined ? {} : { globalPeriodMilliseconds: period }) }
    }
    return { times: [], values: [] }
  })
  return { interpolation: layers[0]?.track.interpolation ?? 0, globalSequence: null, perSequence, missing }
}

/** Ordered parent identities with child metadata overlays; positional aliases are remapped once. */
function composedSequences(layers: readonly Layer[]): M2Sequence[] {
  const identities = new Map<string, { sequence: M2Sequence; layer: Layer }>()
  for (const layer of layers)
    for (const sequence of layer.sequences) identities.set(sequenceKey(sequence), { sequence, layer })
  const entries = [...identities.values()]
  const positions = new Map(entries.map(({ sequence }, index) => [sequenceKey(sequence), index]))
  return entries.map(({ sequence, layer }): M2Sequence => {
    const target = (index: number): number => {
      const source = layer.sequences[index]
      if (source === undefined) throw new TypeError('M2 sequence links outside its source table')
      return positions.get(sequenceKey(source))!
    }
    return { ...sequence,
      aliasNext: (sequence.flags & SEQUENCE_ALIAS) === 0 ? sequence.aliasNext : target(sequence.aliasNext),
      variationNext: sequence.variationNext < 0 ? -1 : target(sequence.variationNext),
    }
  })
}

/** Composes the explicit skeleton chain onto M2 geometry and non-skeleton tracks. */
export function composeSkeleton(model: M2Model, childFirst: readonly M2Skeleton[]): M2Model {
  if (childFirst.length === 0) return model
  const parts = [...childFirst].reverse()
  const layers = parts.map(part => layerOf(part.sequences ?? model.sequences, part.globalLoops ?? model.globalLoops))
  // A split M2 keeps material keys in MD20 but may put the global clock table in SKS1.
  const inheritedLoops = [...parts].reverse().find(part => (part.globalLoops?.length ?? 0) > 0)?.globalLoops ?? []
  const modelLayer = layerOf(model.sequences, model.globalLoops.length > 0 ? model.globalLoops : inheritedLoops)
  const sequences = composedSequences(layers.some(layer => layer.sequences.length > 0) ? layers : [modelLayer])
  const owners = parts.flatMap((part, index) => part.bones === undefined ? [] : [{ part, layer: layers[index]! }])
  const base = owners.find(owner => owner.part.bones!.length > 0)
  if (base === undefined) throw new TypeError('M2 skeleton chain supplies no bones')
  const sourceBones = base.part.bones!
  for (const owner of owners) {
    if (owner.part.bones!.length === 0) continue
    if (owner.part.bones!.length !== sourceBones.length) throw new TypeError('M2 child skeleton has an incompatible bone count')
    owner.part.bones!.forEach((bone, index) => {
      const parentBone = sourceBones[index]!
      if (bone.parent !== parentBone.parent || bone.keyBoneId !== parentBone.keyBoneId)
        throw new TypeError(`M2 child skeleton has incompatible joint ${String(index)}`)
    })
  }
  const bones = sourceBones.map((bone, index): M2Bone => {
    const tracks = <T>(select: (value: M2Bone) => M2Track<T>): M2Track<T> => mergeTrack(
      owners.flatMap(owner => {
        const child = owner.part.bones![index]
        return child === undefined ? [] : [{ layer: owner.layer, track: select(child) }]
      }), sequences)
    return { ...bone, translation: tracks(value => value.translation), rotation: tracks(value => value.rotation),
      scale: tracks(value => value.scale) }
  })
  const attachments = new Map<number, { attachment: M2Attachment; layer: Layer }>()
  model.attachments.forEach(attachment => attachments.set(attachment.id, { attachment, layer: modelLayer }))
  parts.forEach((part, index) => part.attachments?.forEach(attachment =>
    attachments.set(attachment.id, { attachment, layer: layers[index]! })))
  const modelTrack = <T>(track: M2Track<T>): M2Track<T> => mergeTrack([{ layer: modelLayer, track }], sequences)
  return { ...model, sequences, bones, keyBones: base.part.keyBones ?? model.keyBones,
    attachments: [...attachments.values()].map(({ attachment, layer }) => ({ ...attachment,
      enabled: mergeTrack([{ layer, track: attachment.enabled }], sequences) })),
    colors: model.colors.map(color => ({ color: modelTrack(color.color), alpha: modelTrack(color.alpha) })),
    textureWeights: model.textureWeights.map(modelTrack),
    textureTransforms: model.textureTransforms.map(transform => ({ translation: modelTrack(transform.translation),
      rotation: modelTrack(transform.rotation), scale: modelTrack(transform.scale) })),
    events: model.events.map(event => ({ ...event, times: modelTrack(event.times) })),
  }
}
