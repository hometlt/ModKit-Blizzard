import { CascReader } from './reader.js';
export function openCascInstall(reader, installRoot = '', options = {}) {
    return CascReader.open(reader, { ...options, installRoot }).catch(async (err) => {
        await Promise.resolve(reader.close?.()).catch(() => { });
        throw err;
    });
}
export async function openCascInstallReader(reader, installRoot = '', options = {}) {
    return new CascInstallReader(await openCascInstall(reader, installRoot, options));
}
export class CascInstallReader {
    casc;
    localOnlyReads;
    constructor(casc, localOnlyReads = false) {
        this.casc = casc;
        this.localOnlyReads = localOnlyReads;
    }
    /** Return a reader that never falls back to CDN/on-demand bytes for file reads. */
    asLocalOnly() {
        return this.localOnlyReads ? this : new CascInstallReader(this.casc, true);
    }
    async list(path) {
        // MNDX paths are forward-slash, lower-cased; work in that portable form.
        const prefix = toPortablePath(path)
            .replace(/^\/+|\/+$/g, '')
            .toLowerCase();
        return this.casc.listPaths(prefix).map(toPortablePath);
    }
    async get(path) {
        if (this.localOnlyReads && !this.hasLocal(path)) {
            throw new Error(`CASC path is not available locally: ${path}`);
        }
        return this.casc.readPath(path);
    }
    async getText(path) {
        return new TextDecoder().decode(await this.get(path));
    }
    async exists(path) {
        // Treat directories as existing too (CASC has no folder entries) so that
        // mod-loaders probing for e.g. `mods/void.sc2mod` find them.
        return this.casc.hasPath(path) || this.casc.hasPrefix(path);
    }
    /** True if this file's content is in LOCAL storage (vs. needing a CDN fetch). */
    hasLocal(path) {
        return this.casc.hasPath(path);
    }
    /** Per-build identity (root content key) — changes on a game patch; use as a cache-invalidation token. */
    get buildGeneration() {
        return this.casc.rootContentKey;
    }
    /** Content size of a file in bytes from the encoding table (no read); undefined if unknown. */
    contentSizeOf(path) {
        return this.casc.contentSizeOf(path);
    }
    close() {
        return this.casc.close();
    }
}
function toPortablePath(path) {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
