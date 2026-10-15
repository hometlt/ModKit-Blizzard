/**
 * Full-extraction size estimate (plan C2): sum the encoding content-sizes for every file under
 * a prefix — no extraction, no byte reads. Feeds the settings panel's "estimated full extraction
 * size" number. Pure/DOM-free; the caller opens the reader.
 */
import { toCacheKey } from './cache-key.js';
/** Estimate the on-disk size of materializing `prefix` in full — no extraction. */
export async function estimateFullSize(reader, prefix = 'mods') {
    const paths = await reader.list(toCacheKey(prefix));
    let totalBytes = 0;
    let fileCount = 0;
    let unknownSizeCount = 0;
    for (const raw of paths) {
        const p = toCacheKey(raw);
        if (!p)
            continue;
        fileCount++;
        const size = reader.contentSizeOf(p);
        if (typeof size === 'number' && Number.isFinite(size) && size >= 0)
            totalBytes += size;
        else
            unknownSizeCount++;
    }
    return { fileCount, totalBytes, unknownSizeCount };
}
