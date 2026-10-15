import type { ModelBoneBinding, ResourceBudget } from '@modkit/sdk'

export function decodeM3Skeleton(
  bytes: Uint8Array,
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): Promise<{
  readonly fatal: boolean
  readonly decodedBytes: number
  readonly bindings: readonly ModelBoneBinding[]
}>
