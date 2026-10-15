/**
 * Cache policy — which CASC paths get materialized to disk vs. streamed from CASC on demand.
 *
 * The default deliberately caches only small, hot **data + metadata** (GameData XML, strings,
 * layouts, listings, galaxy, …) and streams **binaries** (models, textures, audio, video)
 * straight from CASC, so the on-disk cache stays small instead of mirroring the whole install.
 * Everything here is pure/DOM-free; the fs-backed store and the settings that build a policy
 * live in the SC2 mod workspace host.
 */
import { toCacheKey } from './cache-key.js';
/**
 * File extensions treated as **binary assets**: large, rarely re-read as text, and the bulk of
 * an install's size. Streamed from CASC under the default (`data`) policy. Lower-case, no dot.
 */
export const BINARY_ASSET_EXTENSIONS = new Set([
    // models / geometry
    'm3',
    'm3a',
    'm3h',
    'fbx',
    'max',
    // textures / images
    'dds',
    'tga',
    'gif',
    'png',
    'jpg',
    'jpeg',
    'bmp',
    'ktx',
    'webp',
    // audio
    'ogg',
    'wav',
    'mp3',
    'flac',
    'fsb',
    // video
    'ogv',
    'webm',
    'mp4',
    'avi',
    'mov',
    // fonts / misc binary
    'ttf',
    'otf',
    'bin',
    'pdb',
]);
function extensionOf(cascPath) {
    const base = cascPath.slice(cascPath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}
/**
 * Build a policy.
 *  - `data` (default): cache everything EXCEPT binary assets — the owner's case (cache data +
 *    asset metadata, stream binaries so the cache doesn't balloon).
 *  - `all`: cache every file (full materialization).
 *  - `none`: cache nothing (pure passthrough).
 */
export function createCachePolicy(kind = 'data', options = {}) {
    if (kind === 'all')
        return { id: 'all', shouldCache: () => true };
    if (kind === 'none')
        return { id: 'none', shouldCache: () => false };
    const binary = new Set(BINARY_ASSET_EXTENSIONS);
    for (const ext of options.extraBinaryExtensions ?? [])
        binary.add(ext.replace(/^\./, '').toLowerCase());
    const prefixes = (options.passthroughPrefixes ?? []).map(p => toCacheKey(p).replace(/\/+$/, ''));
    const id = `data:${[...binary].sort().join(',')}|${prefixes.join(',')}`;
    return {
        id,
        shouldCache(cascPath) {
            const norm = toCacheKey(cascPath);
            for (const prefix of prefixes) {
                if (norm === prefix || norm.startsWith(prefix + '/'))
                    return false;
            }
            return !binary.has(extensionOf(norm));
        },
    };
}
