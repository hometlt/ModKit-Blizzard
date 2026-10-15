import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { ModelAnimationClip, ResourceBudget } from '@modkit/sdk'

export interface M3SequenceBinding {
  readonly source: 'base' | 'sidecar'
  readonly logicalId?: string
  readonly nativeSequenceIndex: number
  readonly clipId: string
  readonly combinedSequenceIndex: number
}
export interface M3SequenceSource {
  readonly logicalId?: string
  readonly clips: readonly Pick<ModelAnimationClip, 'id'>[]
  readonly nativeSequenceIndices: readonly number[]
}

/** Source indices are explicit decoder facts; IDs and emitted glTF array positions are not indices. */
export function bindM3SequenceIndices(
  base: M3SequenceSource,
  sidecars: readonly M3SequenceSource[],
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): readonly M3SequenceBinding[] {
  signal?.throwIfAborted()
  if (sidecars.length >= budget.maxNodes)
    throw new RangeError('M3 sequence sources exceed maxNodes')
  const result: M3SequenceBinding[] = []
  const ids = new Set<string>(),
    logicalIds = new Set<string>()
  for (const [sourceIndex, source] of [base, ...sidecars].entries()) {
    signal?.throwIfAborted()
    if (source.clips.length !== source.nativeSequenceIndices.length)
      throw new TypeError('M3 sequence binding needs one native index per clip')
    const logicalId = source.logicalId
    if (sourceIndex > 0) {
      if (typeof logicalId !== 'string' || !logicalId || logicalIds.has(logicalId))
        throw new TypeError('M3 sequence binding needs distinct sidecar logical identities')
      logicalIds.add(logicalId)
    }
    const nativeIndices = new Set<number>()
    for (const [index, clip] of source.clips.entries()) {
      const nativeSequenceIndex = source.nativeSequenceIndices[index]
      if (
        typeof nativeSequenceIndex !== 'number' ||
        !Number.isSafeInteger(nativeSequenceIndex) ||
        nativeSequenceIndex < 0 ||
        nativeIndices.has(nativeSequenceIndex)
      )
        throw new TypeError('M3 native sequence indices must be distinct nonnegative integers')
      if (typeof clip.id !== 'string' || !clip.id || ids.has(clip.id))
        throw new TypeError('M3 combined sequence identities must be distinct')
      if (result.length >= budget.maxNodes)
        throw new RangeError('M3 sequence bindings exceed maxNodes')
      nativeIndices.add(nativeSequenceIndex)
      ids.add(clip.id)
      result.push({
        source: sourceIndex === 0 ? 'base' : 'sidecar',
        ...(sourceIndex === 0 || logicalId === undefined ? {} : { logicalId }),
        nativeSequenceIndex,
        clipId: clip.id,
        combinedSequenceIndex: result.length,
      })
    }
  }
  return snapshotJson(
    result,
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as unknown as readonly M3SequenceBinding[]
}
