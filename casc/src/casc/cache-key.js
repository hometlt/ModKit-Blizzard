/**
 * Canonical cache-key form for CASC paths: lower-cased, forward-slash separators, no leading
 * or trailing slash. This is the portable form `CascInstallReader.list` emits and the form the
 * on-disk `files/` mirror uses — deliberately NOT the codec's backslash `normalizeCascPath`
 * (that one is the CASC-internal separator form used for root lookups).
 */
export function toCacheKey(cascPath) {
    return cascPath
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
}
