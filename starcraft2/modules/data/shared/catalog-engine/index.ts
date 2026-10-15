/**
 * `@modkitx/data-processing` — the data domain's registry and operation vocabulary, and
 * nothing about any game.
 *
 * Phase C added adapters around the existing packages "without physical moves", which in
 * practice meant re-exporting the whole `sc2-data` codec from here — seventeen blocks, and a
 * hard install-time dependency on StarCraft II for anyone who wanted the data registry. The
 * codec's symbols live in the codec; a host registers whichever data codecs are installed.
 *
 * Layering:
 *
 * - game-neutral `GameArtifactCodec`/`ArtifactContext` live in `@modkitx/assets` (re-exported
 *   below for convenience);
 * - `operations.ts` — section 9's Data verbs bound to shared host IDs where they exist, plus
 *   three codec-namespaced IDs (two flagged for promotion);
 * - `registry.ts` — the codec registry and detection routing.
 *
 * Deliberately **not** here: dependency resolution. The one mod loader
 * (`ContentSources.openModContext`) resolves a mod's chain; a data codec consumes already-resolved
 * sources and reports what it could not resolve.
 */

export type {
  ArtifactContext,
  GameArtifactCodec,
  GameArtifactKind,
} from '@modkit/codec-kit/legacy/assets'

export {
  DATA_ENTITY_CARDS_OPERATION_ID,
  DATA_OPERATION_IDS,
  DATA_OPERATION_ID_LIST,
  DATA_REFERENCES_OPERATION_ID,
  DATA_RESOLVE_INHERITANCE_OPERATION_ID,
  type DataOperationId,
  type DataOperationKey,
} from './operations.js'

export { DataCodecRegistry, type DataCodecSummary, type DataRouteOptions } from './registry.js'
