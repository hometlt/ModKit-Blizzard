import type { ResourceBudget } from '@modkit/sdk'
import type { UvmContainer } from '@modkit/uv/model/container'

export declare function exportFreshM3FromUvm(
  container: UvmContainer,
  metersPerNativeUnit: number,
  budget: ResourceBudget,
  signal?: AbortSignal,
  requestedFormat?: 'm3' | 'm3a',
  /** Collects what the target format had nowhere to put, for a caller that can report it. */
  notes?: string[],
  /** Strict by default. Foreign shader approximation must be selected explicitly. */
  materialPolicy?: 'strict' | 'base-color-coverage',
): Promise<Uint8Array>

export declare function projectM3EffectsFromUvm(
  container: UvmContainer,
  nodeBoneIndices: Readonly<Record<number, number>>,
  budget: any,
  signal?: AbortSignal,
): any

export declare function projectM3AttachmentsFromUvm(
  container: UvmContainer,
  nodeBoneIndices: Readonly<Record<number, number>>,
  nodeParents: Readonly<Record<number, number>>,
): unknown
