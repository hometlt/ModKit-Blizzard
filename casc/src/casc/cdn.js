/**
 * CDN fetch for on-demand CASC installs: when a file isn't downloaded locally, fetch it from
 * Blizzard's CDN. This is the value a host passes as {@link CascStorageOptions.cdnFetch}.
 * Returns undefined on any failure (offline, 404, timeout, a server that ignores the range, etc.).
 *
 * A hard timeout is essential: a partial install can send hundreds of these during one mod load,
 * and a stalled connection on bare `fetch` never resolves — freezing the whole load (and the Mod
 * Card) indefinitely with no error. On timeout we abort and return undefined so the reader falls
 * back to "skip this file" and the load completes with whatever content is available locally.
 *
 * `range` ([offset, length]) reads one file out of a CDN archive. A server that answers the whole
 * archive (200 instead of 206) is refused before its body is read: archives are hundreds of MB.
 */
export async function cdnFetch(url, signal, range, timeoutMs = 8000) {
    try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const res = await fetch(url, {
            signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            ...(range === undefined ? {} : { headers: { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } }),
        });
        if (!res.ok || (range !== undefined && res.status !== 206)) {
            await res.body?.cancel().catch(() => undefined);
            return undefined;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return range !== undefined && bytes.byteLength !== range[1] ? undefined : bytes;
    }
    catch {
        return undefined;
    }
}
