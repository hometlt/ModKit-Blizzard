/** M3 material animation binding: bounded base/sidecar sequence remapping, exact-kernel merging,
 * particle program replication, and native-owned loss/pass identity metadata retention. */
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type {
  JsonObject,
  JsonValue,
  ModelAnimationClip,
  ModelMaterialRef,
  ResourceBudget,
} from '@modkit/sdk'
import { countRenderMaterialTracks, hasSiblingStemAssociation, mergeM3MaterialAnimationTracks } from '../../../dist/m3/legacy-binding/binding-kernel.js'
import type { RenderMaterial } from '@modkit/codec-kit/legacy/models'
import type { M3SequenceBinding } from './animation-binding.js'

export interface M3BindingMaterial {
  readonly referenceIndex: number
  readonly name?: string
  readonly shader?: ModelMaterialRef['shader']
}
export interface M3MaterialBindingSource {
  readonly logicalId: string
  readonly materials: readonly M3BindingMaterial[]
}
export interface M3MaterialBindingReceipt {
  readonly logicalId: string
  readonly sourceTracks: number
  readonly mergedTracks: number
  readonly unmappedTracks: number
}
type Budget = Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>

/** Replicate the already-bound program (including existing animation targets) without creating
 * native tracks or changing source-track receipts. Only identity and effective lighting differ. */
export function replicateM3ParticleMaterial(
  material: ModelMaterialRef,
  program: unknown,
  targetIndex: number,
): ModelMaterialRef {
  if (material.shader?.id !== 'modkit.render-material.v1')
    throw new TypeError('M3 particle override requires a render-material program')
  return {
    ...material,
    id: `material-${targetIndex}`,
    unlit: true,
    shader: { ...material.shader, parameters: { ...material.shader.parameters,
      renderModel: program as JsonObject,
    } },
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}
function model(material: M3BindingMaterial): JsonObject | undefined {
  if (material.shader?.id !== 'modkit.render-material.v1') return undefined
  const value = object(material.shader.parameters['renderModel'])
  return value?.['version'] === 1 ? value : undefined
}

/** Native compatibility is evaluated only after the host supplies the primary logical identity. */
export function m3SiblingStemAssociation(
  primaryLogicalId: string,
  candidateLogicalId: string,
): boolean {
  if (!primaryLogicalId || !candidateLogicalId) return false
  // Both inputs name the complete same public namespace. Unlike a directory-scoped MK2 list,
  // a basename here is a root-level logical file, never relative to the primary's directory.
  const parent = (value: string) => {
    const normalized = value.replaceAll('\\', '/').toLowerCase()
    return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')))
  }
  if (parent(primaryLogicalId) !== parent(candidateLogicalId)) return false
  return hasSiblingStemAssociation(primaryLogicalId, candidateLogicalId)
}

/** Remap only the neutral standard/composite animated-value records, never native metadata. */
function remapSequenceTracks(
  value: JsonValue,
  indices: ReadonlyMap<number, number>,
  signal?: AbortSignal,
): JsonValue {
  signal?.throwIfAborted()
  if (Array.isArray(value)) return value.map(item => remapSequenceTracks(item, indices, signal))
  const record = object(value)
  if (record === undefined) return value
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      if (key !== 'sequenceTracks') return [key, remapSequenceTracks(child, indices, signal)]
      if (!Array.isArray(child)) throw new TypeError('M3 material sequenceTracks must be an array')
      return [
        key,
        child.flatMap(candidate => {
          const track = object(candidate)
          const index = track?.['sequenceIndex']
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return []
          const target = indices.get(index)
          return target === undefined ? [] : [{ ...track, sequenceIndex: target }]
        }),
      ]
    }),
  )
}

function renderMaterial(
  material: M3BindingMaterial,
  indices?: ReadonlyMap<number, number>,
  signal?: AbortSignal,
): RenderMaterial {
  const original = model(material)
  if (original === undefined) return { name: material.name ?? '', layers: [] }
  const result = {
    name: material.name ?? '',
    layers: original['layers'] ?? [],
    ...(original['metadata'] === undefined ? {} : { metadata: original['metadata'] }),
    ...(original['standard'] === undefined
      ? {}
      : {
          standard:
            indices === undefined
              ? original['standard']
              : remapSequenceTracks(original['standard'], indices, signal),
        }),
    ...(original['composite'] === undefined
      ? {}
      : {
          composite:
            indices === undefined
              ? original['composite']
              : remapSequenceTracks(original['composite'], indices, signal),
        }),
  }
  // The bounded native buildRenderMaterials producer owns this shape. The exact legacy kernel
  // receives an owned snapshot; it supplies composition only, never parsing or sampling.
  return result as unknown as RenderMaterial
}

function materialTable(
  source: readonly M3BindingMaterial[],
  budget: Budget,
  indices?: ReadonlyMap<number, number>,
  signal?: AbortSignal,
): RenderMaterial[] {
  const found = new Set<number>()
  const result: RenderMaterial[] = []
  for (const material of source) {
    signal?.throwIfAborted()
    if (
      !Number.isSafeInteger(material.referenceIndex) ||
      material.referenceIndex < 0 ||
      found.has(material.referenceIndex)
    )
      throw new TypeError('M3 material binding requires distinct MATM indices')
    if (material.referenceIndex >= budget.maxNodes)
      throw new RangeError('M3 MATM binding exceeds maxNodes')
    found.add(material.referenceIndex)
    while (result.length <= material.referenceIndex) result.push({ name: '', layers: [] })
    result[material.referenceIndex] = renderMaterial(material, indices, signal)
  }
  return result
}

/**
 * Adapt source-local native sequence identities to combined clips, then invoke the exact pinned
 * mergeM3MaterialAnimationTracks kernel. MATM/layer compatibility, neutral defaults and counting
 * remain in that immutable extraction; this wrapper only owns bounded data and index translation.
 */
export function bindM3MaterialTracks<T extends M3BindingMaterial>(
  base: readonly T[],
  sidecars: readonly M3MaterialBindingSource[],
  sequences: readonly M3SequenceBinding[],
  budget: Budget,
  signal?: AbortSignal,
): {
  readonly materials: readonly T[]
  readonly sources: readonly M3MaterialBindingReceipt[]
  readonly baseUnmappedTracks: number
} {
  const own = snapshotJson(
    { base, sidecars, sequences },
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as unknown as {
    readonly base: readonly T[]
    readonly sidecars: readonly M3MaterialBindingSource[]
    readonly sequences: readonly M3SequenceBinding[]
  }
  const sequenceMaps = new Map<string | undefined, Map<number, number>>()
  const combined = new Set<number>()
  for (const entry of own.sequences) {
    signal?.throwIfAborted()
    if (
      (entry.source !== 'base' && entry.source !== 'sidecar') ||
      !Number.isSafeInteger(entry.nativeSequenceIndex) ||
      entry.nativeSequenceIndex < 0
    )
      throw new TypeError('M3 material binding requires a valid native sequence identity')
    if (
      !Number.isSafeInteger(entry.combinedSequenceIndex) ||
      entry.combinedSequenceIndex < 0 ||
      entry.combinedSequenceIndex >= own.sequences.length ||
      combined.has(entry.combinedSequenceIndex)
    )
      throw new TypeError('M3 material binding needs a complete combined sequence map')
    const key = entry.source === 'base' ? undefined : entry.logicalId
    if (entry.source === 'sidecar' && key === undefined)
      throw new TypeError('sidecar sequence identity absent')
    const map = sequenceMaps.get(key) ?? new Map<number, number>()
    if (map.has(entry.nativeSequenceIndex))
      throw new TypeError('duplicate native material sequence')
    map.set(entry.nativeSequenceIndex, entry.combinedSequenceIndex)
    sequenceMaps.set(key, map)
    combined.add(entry.combinedSequenceIndex)
  }
  const empty = new Map<number, number>()
  const originals = materialTable(own.base, budget)
  let materials = materialTable(own.base, budget, sequenceMaps.get(undefined) ?? empty, signal)
  const count = (items: readonly RenderMaterial[]): number =>
    items.reduce((total, item) => total + countRenderMaterialTracks(item), 0)
  const baseUnmappedTracks = count(originals) - count(materials)
  const receipts: M3MaterialBindingReceipt[] = [],
    logicalIds = new Set<string>()
  for (const source of own.sidecars) {
    signal?.throwIfAborted()
    if (!source.logicalId || logicalIds.has(source.logicalId))
      throw new TypeError('duplicate M3 material sidecar identity')
    logicalIds.add(source.logicalId)
    const sourceTracks = count(materialTable(source.materials, budget))
    const remapped = materialTable(
      source.materials,
      budget,
      sequenceMaps.get(source.logicalId) ?? empty,
      signal,
    )
    // Indices are already explicit combined indices. Offset zero retains the exact kernel's
    // compatibility/default behavior while avoiding assumptions about filtered native sequences.
    const merged = mergeM3MaterialAnimationTracks(materials, remapped, 0, own.sequences.length)
    materials = merged.materials
    receipts.push({
      logicalId: source.logicalId,
      sourceTracks,
      mergedTracks: merged.mergedTrackCount,
      unmappedTracks: sourceTracks - merged.mergedTrackCount,
    })
  }
  const projected = own.base.map(material => {
    const original = model(material),
      merged = materials[material.referenceIndex]
    if (original === undefined || merged === undefined || material.shader === undefined)
      return material
    return {
      ...material,
      shader: {
        ...material.shader,
        parameters: {
          ...material.shader.parameters,
          renderModel: {
            ...original,
            ...(merged.standard === undefined ? {} : { standard: merged.standard }),
            ...(merged.composite === undefined ? {} : { composite: merged.composite }),
          },
        },
      },
    }
  })
  return snapshotJson(
    { materials: projected, sources: receipts, baseUnmappedTracks },
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as unknown as {
    readonly materials: readonly T[]
    readonly sources: readonly M3MaterialBindingReceipt[]
    readonly baseUnmappedTracks: number
  }
}

/** Count authored material key instants without evaluating or resampling a track. Bone channel
 * frame ordinals stay unchanged; a material-only clip receives its actual material key count. */
export function bindM3MaterialTimelines(
  clips: readonly ModelAnimationClip[],
  materials: readonly M3BindingMaterial[],
  budget: Budget,
  signal?: AbortSignal,
): { readonly clips: readonly ModelAnimationClip[]; readonly materialAnimatedSequences: number } {
  const own = snapshotJson(
    { clips, materials },
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as unknown as {
    readonly clips: readonly ModelAnimationClip[]
    readonly materials: readonly M3BindingMaterial[]
  }
  const times = new Map<number, Set<number>>()
  const visit = (value: JsonValue): void => {
    signal?.throwIfAborted()
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const record = object(value)
    if (record === undefined) return
    for (const [key, item] of Object.entries(record)) {
      if (key !== 'sequenceTracks') {
        visit(item)
        continue
      }
      if (!Array.isArray(item)) throw new TypeError('M3 material sequenceTracks must be an array')
      for (const entry of item) {
        const binding = object(entry),
          index = binding?.['sequenceIndex']
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
          throw new TypeError('M3 material timeline requires an exact sequence index')
        const keys = object(binding?.['track'])?.['keys']
        if (!Array.isArray(keys)) throw new TypeError('M3 material timeline keys are absent')
        const sequenceTimes = times.get(index) ?? new Set<number>()
        for (const keyframe of keys) {
          const frame = object(keyframe)?.['frame']
          if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0)
            throw new TypeError('M3 material key time is invalid')
          sequenceTimes.add(frame)
        }
        times.set(index, sequenceTimes)
      }
    }
  }
  for (const material of own.materials) {
    const value = model(material)
    if (value?.['standard'] !== undefined) visit(value['standard'])
    if (value?.['composite'] !== undefined) visit(value['composite'])
  }
  return {
    clips: own.clips.map((clip, index) => {
      const count = times.get(clip.sequenceIndex ?? index)?.size ?? 0
      if (clip.channels.length > 0 || count === 0) return clip
      return { ...clip, frames: count, kind: count > 1 ? 'animation' : 'rest-pose' }
    }),
    materialAnimatedSequences: own.clips.filter(
      (clip, index) => (times.get(clip.sequenceIndex ?? index)?.size ?? 0) > 1,
    ).length,
  }
}
