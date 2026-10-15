import type { ModelAnimationClip, ResourceBudget } from '@modkit/sdk'
import type {
  M3ResidualAnimationEventTrack,
  M3ResidualAnimationTrack,
  M3UnsupportedAnimationChannelReason,
} from '../animation-projection.js'

export function decodeM3Animations(
  bytes: Uint8Array,
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): Promise<{
  readonly fatal: boolean
  readonly decodedBytes: number
  readonly clips: readonly ModelAnimationClip[]
  readonly supportedChannels: number
  readonly unsupportedChannels: number
  readonly unsupportedChannelReasons: Readonly<
    Partial<Record<M3UnsupportedAnimationChannelReason, number>>
  >
  readonly unsupportedChannelDataKinds: Readonly<Record<string, number>>
  readonly animationEvents: readonly M3ResidualAnimationEventTrack[]
  readonly residualAnimationTracks: readonly M3ResidualAnimationTrack[]
}>
