/**
 * The reader behind a `casc-cache` mod source: a directory of extracted CASC files, optionally
 * backed by a live CASC install for on-demand fill. Registered ahead of the `casc` source so a
 * materialized file wins over a cold CASC read.
 *
 * Two scenarios, one mechanism (owner's design):
 *  - **Talv / full**: the directory already holds every needed file; no CASC install → the
 *    reader is a plain directory reader.
 *  - **on-demand fill**: a miss pulls the file from CASC and (when the {@link CachePolicy}
 *    allows — data/metadata yes, big binaries no) writes it into the directory for next time.
 *
 * This is orthogonal to the parsed-data caches (fast warm-start): those persist parse results;
 * this persists file bytes. Either can be used without the other.
 *
 * It previously lived in the retired IO facade while that package spelled out the `casc-cache` source type. The
 * mapping between an absolute path under the extract dir and a CASC key is this codec's, so the
 * reader is too; what stayed neutral is the per-build directory layout, which is
 * `@modkitx/vfs`'s.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toCacheKey } from './cache-key.js';
/**
 * A directory reader with optional CASC pull-through. Registered under the `casc-cache:`
 * protocol; the VFS strips the protocol and hands absolute paths (`<extractDir>/mods/...`).
 */
export class CachedCascReader {
    extractDir;
    casc;
    policy;
    constructor(options) {
        this.extractDir = options.extractDir;
        this.casc = options.casc;
        this.policy = options.policy;
    }
    async list(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
        const out = [];
        for (const e of entries) {
            if (e.isFile()) {
                const parent = e.parentPath ?? e.path;
                out.push(path.relative(dir, path.join(parent, e.name)).replace(/\\/g, '/'));
            }
        }
        return out;
    }
    async get(filePath) {
        const onDisk = await fs.readFile(filePath).catch(() => undefined);
        if (onDisk)
            return new Uint8Array(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength);
        // Miss → pull from CASC and (per policy) persist.
        if (!this.casc)
            throw new Error(`casc-cache: file not extracted and no CASC backing: ${filePath}`);
        const rel = this.cascRel(filePath);
        const data = await this.casc.get(rel);
        if (!this.policy || this.policy.shouldCache(rel)) {
            await this.write(filePath, data).catch(() => undefined);
        }
        return data;
    }
    async getText(filePath) {
        return new TextDecoder().decode(await this.get(filePath));
    }
    async exists(filePath) {
        if (await fs.access(filePath).then(() => true, () => false))
            return true;
        if (!this.casc)
            return false;
        return this.casc.exists(this.cascRel(filePath));
    }
    async set(filePath, data) {
        await this.write(filePath, data);
    }
    async delete(filePath) {
        await fs.unlink(filePath).catch(() => undefined);
    }
    close() { }
    /** CASC-install-relative path (portable form) for an absolute path under the extract dir. */
    cascRel(filePath) {
        return toCacheKey(path.relative(this.extractDir, filePath));
    }
    async write(filePath, data) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, filePath);
    }
}
