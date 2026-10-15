/**
 * `@modkitx/layouts-processing` — browser-safe semantic layout registry facade.
 *
 * The initial SC2 codec adapts the safe single-source parse/diagnostic-HTML surfaces from
 * `@modkitx/layout-lang`; dependency-workspace resolution and visual rendering remain explicit
 * unavailable operations until their schema/VFS integration is browser-safe.
 */

export type { ArtifactContext, GameArtifactCodec, GameArtifactKind } from '@modkit/codec-kit/legacy/assets'

export {
  LAYOUT_LANGUAGE_FEATURES_OPERATION_ID,
  LAYOUT_OPERATION_IDS,
  LAYOUT_OPERATION_ID_LIST,
  LAYOUT_PARSE_OPERATION_ID,
  LAYOUT_RESOLVE_OPERATION_ID,
  LAYOUT_VISUAL_RENDER_OPERATION_ID,
  type LayoutOperationId,
  type LayoutOperationKey,
} from './operations.js'

export {
  LayoutCodecRegistry,
  type LayoutCodecSummary,
  type LayoutRouteOptions,
} from '@modkit/codec-kit/legacy/semantic/layouts'
