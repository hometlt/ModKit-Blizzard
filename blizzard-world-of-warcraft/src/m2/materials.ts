/**
 * Native WoW batch → existing modkit.render-material.v1 program (GAME-WOW).
 * The qualified colour slice is one unlit/no-fog texture, opaque/mod pixel combiner, UV0/UV1,
 * and blend 0–2 in the canonical Scene lighting context. GPU/depth admission is separate.
 * RGB, colour alpha and texture weight retain separate authored clocks and editable keys.
 * Only translation-only UV transforms map directly (generic offset has the opposite sign).
 * Other shaders/matrix orders return undefined to the codec's explicit partial projection.
 * No sampler, shader implementation, image decoder or UVM writer is implemented here.
 */
import type { StandardMaterialLayer, StandardMaterialModel, SequenceIndexedAnimationTrack } from '@modkit/codec-kit/legacy/models/material'
import type { M2Keys, M2Model, M2SkinBatch, M2Track } from './reader.js'

type Vector = readonly number[]
interface Property<T> { readonly value: T; readonly sequenceTracks?: readonly SequenceIndexedAnimationTrack[] }

/** Preserve native authored lists using the common material animation clock, without sampling. */
function property<T, O>(model: M2Model, track: M2Track<T> | undefined, fallback: T,
  valueOf: (value: T) => O, vectorOf: (value: T) => Vector,
  dataSequences: readonly number[]): Property<O> {
  const first = track?.perSequence[0]?.values[0] ?? fallback
  if (track === undefined) return { value: valueOf(first) }
  const sequenceTracks: SequenceIndexedAnimationTrack[] = []
  dataSequences.forEach((data, sequenceIndex) => {
    const at = track.globalSequence !== null ? 0 : data < track.perSequence.length ? data : 0
    const keys = track.perSequence[at]
    if (keys === undefined || keys.values.length === 0) return
    const period = keys.globalPeriodMilliseconds ??
      (track.globalSequence === null ? undefined : model.globalLoops[track.globalSequence])
    if (track.globalSequence !== null && period === undefined) throw new TypeError('M2 material names a missing global sequence')
    const nativeMode = keys.interpolation ?? track.interpolation
    if (nativeMode !== 0 && nativeMode !== 1) throw new TypeError('M2 material interpolation is outside the qualified linear profile')
    const held = period === 0
    sequenceTracks.push({ sequenceIndex,
      ...(period === undefined || held ? {} : { concurrent: true, wrapSeconds: period / 1000 }),
      track: { lineType: nativeMode === 0 || held ? 0 : 1, globalSeqId: null,
        keys: (held ? [0] : keys.times).map((time, index) => ({ frame: time / 1000, vector: [...vectorOf(keys.values[index]!)] })) },
    })
  })
  return { value: valueOf(first), ...(sequenceTracks.length === 0 ? {} : { sequenceTracks }) }
}

/** A matrix profile is admitted only if every reachable key has the required identity value. */
function allValues<T>(track: M2Track<T>, accepts: (value: T) => boolean): boolean {
  return track.missing.length === 0 && track.perSequence.every(keys => keys.values.every(accepts))
}
/** Reject unsupported modes before publishing a render program that could appear exact. */
function linear(track: M2Track<unknown> | undefined): boolean {
  return track === undefined || track.missing.length === 0 && track.perSequence.every((keys: M2Keys<unknown>) =>
    keys.values.length === 0 || (keys.interpolation ?? track.interpolation) <= 1)
}

/** Map the existing single-texture combiner; higher shader tables/environment branches stay native. */
export function projectBatchMaterial(model: M2Model, batch: M2SkinBatch, resourceId: string | undefined,
  dataSequences: readonly number[]): StandardMaterialModel | undefined {
  const native = model.materials[batch.materialIndex]
  const textureIndex = model.textureCombos[batch.textureComboIndex]
  const texture = textureIndex === undefined ? undefined : model.textures[textureIndex]
  const coord = model.textureCoordCombos[batch.textureCoordComboIndex]
  if (native === undefined || texture === undefined || resourceId === undefined || batch.textureCount !== 1 ||
    (native.flags & 3) !== 3 || (native.flags & 8) !== 0 || native.blend > 2 ||
    (batch.shaderId & 0x8080) !== 0 || (coord !== 0 && coord !== 1) ||
    coord !== ((batch.shaderId & 0x4000) === 0 ? 0 : 1)) return undefined
  const color = batch.colorIndex < 0 ? undefined : model.colors[batch.colorIndex]
  const weightIndex = model.textureWeightCombos[batch.textureWeightComboIndex]
  const weight = weightIndex === undefined || (batch.flags & 0x40) !== 0 ? undefined : model.textureWeights[weightIndex]
  const transformIndex = model.textureTransformCombos[batch.textureTransformComboIndex]
  const transform = transformIndex === undefined || transformIndex === 0xffff ? undefined : model.textureTransforms[transformIndex]
  if (![color?.color, color?.alpha, weight, transform?.translation].every(track => linear(track)) ||
    [color?.alpha, weight].some(track => track !== undefined && !allValues(track, value => value >= 0 && value <= 1)) ||
    transform !== undefined && (!allValues(transform.scale, value => value.every(component => component === 1)) ||
      !allValues(transform.rotation, value => value[0] === 0 && value[1] === 0 && value[2] === 0 && Math.abs(value[3]) === 1))) return undefined
  const layer = (slot: StandardMaterialLayer['slot'], texturePath: string | null, channels: 0 | 1 | 2, op: 0 | 2 | 6): StandardMaterialLayer => ({
    slot, texturePath, uvSource: coord, channels, op, teamColorMode: 0, invert: false,
    clampResult: false, wrapX: (texture.flags & 1) !== 0, wrapY: (texture.flags & 2) !== 0,
  })
  const rgb = property(model, color?.color, [1, 1, 1] as const,
    value => [value[0], value[1], value[2], 1] as const, value => [value[0], value[1], value[2], 1], dataSequences)
  const alpha = property(model, color?.alpha, 1, value => value, value => [value], dataSequences)
  const weights = property(model, weight, 1, value => value, value => [value], dataSequences)
  const uvOffset = transform === undefined ? undefined : property(model, transform.translation, [0, 0, 0] as const,
    value => [-value[0], -value[1]] as const, value => [-value[0], -value[1]], dataSequences)
  // The native vertex colour supplies RGB and colour alpha. The texture's RGB modulates it.
  // Only the MOD pixel variant takes texture alpha; OPAQUE ignores that alpha channel.
  const mod = (batch.shaderId & 0x70) !== 0
  return { layers: {
    diffuse: { ...layer('diffuse', null, 1, 6), constantColor: rgb, alphaFactor: alpha },
    decal: { ...layer('decal', resourceId, 0, 0), ...(uvOffset === undefined ? {} : { uvOffset }) },
    alpha1: { ...layer('alpha1', mod ? resourceId : null, 2, 0), alphaFactor: weights,
      ...(mod ? {} : { constantColor: { value: [1, 1, 1, 1] } }),
      ...(uvOffset === undefined ? {} : { uvOffset }) },
  }, blendMode: native.blend === 2 ? 1 : 0, priority: batch.priorityPlane * 16 + batch.materialLayer,
    specularity: 1, specMult: 0, emisMult: 0, specMode: 0,
    alphaTestThreshold: native.blend === 1 ? 128 / 255 : 0,
    twoSided: (native.flags & 4) !== 0, unshaded: true, doubleLambert: false,
    clampOutput: false, usesVertexColor: false, usesVertexAlpha: false }
}
