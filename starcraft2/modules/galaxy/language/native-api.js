import {
  GALAXY_NATIVE_API_CATALOG_DIGEST,
  GALAXY_NATIVE_API_DECLARATIONS,
  GALAXY_NATIVE_API_FUNCTION_COUNT,
  GALAXY_NATIVE_API_SUMMARIES,
} from './native-api.generated.js'

/** Exact catalog generated from the installed Core.SC2Mod sources pinned by their SHA-256 hashes. */
export const GALAXY_NATIVE_API_PROVENANCE =
  `modkit-galaxy-script-api@1.0.0; ${GALAXY_NATIVE_API_CATALOG_DIGEST}; ` +
  'reference https://github.com/sc2-arcade-watcher/sc2-galaxy-toolkit/blob/44ba5892cb52b5ace5d1d1fa23521aec2a82bacf/packages/plaxtony/src/tools/gmnatives.ts'

/**
 * The name the bundled catalog has in the semantic index. It is never a location: no host serves
 * it, so definition, references and workspace symbols leave it out and lead to the chain's
 * `TriggerLibs/natives.galaxy` instead (plan 2.1).
 */
export const GALAXY_NATIVE_API_URI = 'modkit://blizzard/galaxy/native-api.galaxy'

export const GALAXY_NATIVE_API_SOURCE = GALAXY_NATIVE_API_DECLARATIONS
export {
  GALAXY_NATIVE_API_CATALOG_DIGEST,
  GALAXY_NATIVE_API_FUNCTION_COUNT,
  GALAXY_NATIVE_API_SUMMARIES,
}
