/**
 * Shared identity constants for the SC2 bank codec.
 *
 * Kept in one module so the codec, detection, and the descriptor never disagree about a stable
 * ID — mirrors `mods-processing/src/sc2-mod/identity.ts`.
 */

/** Stable game codec ID. A display name ("StarCraft II") is never an identity. */
export const SC2_GAME_ID = 'starcraft-2'

/** Stable codec ID of the bank artifact codec (`AssetIdentity.pluginId`/`formatId`). */
export const SC2_BANK_CODEC_ID = 'sc2-bank'

/** Version reported as `AssetIdentity.pluginVersion`; tracks this package's version. */
export const SC2_BANK_CODEC_VERSION = '0.1.0'

/**
 * The extension `packages/bank` itself matches. `path-core.ts`/`path.ts`'s `BANK_FILE_RE` is a
 * private module constant, not re-exported, so it is duplicated here rather than imported
 * (mirrors `sc2-mod/detect.ts`'s note on `mod-workspace`'s private `findModRoot`). Delete this
 * copy if `@modkitx/bank` ever exports its own extension matcher.
 */
export const SC2_BANK_EXTENSION = '.sc2bank'
