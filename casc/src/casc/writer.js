import { sha256Hex } from '@modkit/codec-kit/crypto/digest';
const BLTE = [0x42, 0x4c, 0x54, 0x45];
export function normalizeCascWritePath(path) {
    const normalized = path
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/+/g, '/');
    if (!normalized || normalized.includes('..'))
        throw new Error(`Invalid CASC patch path: ${path}`);
    return normalized;
}
export function encodeBlteStored(data) {
    const out = new Uint8Array(9 + data.length);
    out.set(BLTE, 0);
    out[8] = 0x4e;
    out.set(data, 9);
    return out;
}
export async function createCascPatchPlan(files, options = {}) {
    const hasher = options.hasher ?? createSha256TruncatedHasher();
    const seen = new Set();
    const out = [];
    for (const file of files) {
        const path = normalizeCascWritePath(file.path);
        const key = path.toLowerCase();
        if (seen.has(key))
            throw new Error(`Duplicate CASC patch path: ${path}`);
        seen.add(key);
        const data = copyBytes(file.data);
        const container = encodeBlteStored(data);
        out.push({
            path,
            contentKey: await hasher.contentKey(data, path),
            encodingKey: await hasher.encodingKey(container, path),
            size: data.length,
            encodedSize: container.length,
            container,
        });
    }
    return {
        format: 'modkitx.casc-patch.v1',
        files: out,
        deletes: [...(options.deletes ?? [])].map(path => ({ path: normalizeCascWritePath(path) })),
    };
}
export function serializeCascPatchManifest(plan) {
    const manifest = {
        format: plan.format,
        files: plan.files.map(file => ({
            path: file.path,
            contentKey: file.contentKey,
            encodingKey: file.encodingKey,
            size: file.size,
            encodedSize: file.encodedSize,
        })),
        deletes: plan.deletes,
    };
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}
export function parseCascPatchManifest(bytes) {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed.format !== 'modkitx.casc-patch.v1')
        throw new Error('Unsupported CASC patch manifest format');
    if (!Array.isArray(parsed.files) || !Array.isArray(parsed.deletes)) {
        throw new Error('Invalid CASC patch manifest');
    }
    return {
        format: parsed.format,
        files: parsed.files.map(file => ({
            path: normalizeCascWritePath(file.path),
            contentKey: assertHexKey(file.contentKey, 'contentKey'),
            encodingKey: assertHexKey(file.encodingKey, 'encodingKey'),
            size: assertNonNegativeInteger(file.size, 'size'),
            encodedSize: assertNonNegativeInteger(file.encodedSize, 'encodedSize'),
        })),
        deletes: parsed.deletes.map(item => ({ path: normalizeCascWritePath(item.path) })),
    };
}
export async function readCascPatchBundle(source, root = '') {
    const prefix = root ? `${normalizeCascWritePath(root)}/` : '';
    const manifest = parseCascPatchManifest(await source.get(`${prefix}casc-patch.json`));
    const files = [];
    for (const file of manifest.files) {
        const bundlePath = `${prefix}data/${file.encodingKey.slice(0, 2)}/${file.encodingKey.slice(2, 4)}/${file.encodingKey}.blte`;
        const container = await source.get(bundlePath);
        if (container.length !== file.encodedSize)
            throw new Error(`CASC patch container size mismatch for ${file.path}`);
        files.push({
            ...file,
            container: copyBytes(container),
        });
    }
    return {
        format: manifest.format,
        files,
        deletes: manifest.deletes,
    };
}
export async function writeCascPatchBundle(sink, plan, root = '') {
    const prefix = root ? `${normalizeCascWritePath(root)}/` : '';
    const written = [];
    const manifestPath = `${prefix}casc-patch.json`;
    await sink.set(manifestPath, serializeCascPatchManifest(plan));
    written.push(manifestPath);
    for (const file of plan.files) {
        const path = `${prefix}data/${file.encodingKey.slice(0, 2)}/${file.encodingKey.slice(2, 4)}/${file.encodingKey}.blte`;
        await sink.set(path, file.container);
        written.push(path);
    }
    return written;
}
export class CascPatchWriter {
    files = new Map();
    deletes = new Set();
    put(path, data) {
        const normalized = normalizeCascWritePath(path);
        this.files.set(normalized.toLowerCase(), { path: normalized, data: copyBytes(data) });
        this.deletes.delete(normalized.toLowerCase());
    }
    delete(path) {
        const normalized = normalizeCascWritePath(path);
        this.files.delete(normalized.toLowerCase());
        this.deletes.add(normalized);
    }
    toPlan(options = {}) {
        return createCascPatchPlan([...this.files.values()], { ...options, deletes: [...this.deletes] });
    }
}
export class CascPatchOverlay {
    fallback;
    files = new Map();
    tombstones = new Set();
    constructor(fallback) {
        this.fallback = fallback;
    }
    static fromPlan(plan, fallback) {
        const overlay = new CascPatchOverlay(fallback);
        for (const file of plan.files)
            overlay.set(file.path, decodeStoredBlte(file.container));
        for (const deleted of plan.deletes)
            overlay.delete(deleted.path);
        return overlay;
    }
    set(path, data) {
        const normalized = normalizeCascWritePath(path);
        this.files.set(normalized.toLowerCase(), copyBytes(data));
        this.tombstones.delete(normalized.toLowerCase());
    }
    delete(path) {
        const normalized = normalizeCascWritePath(path).toLowerCase();
        this.files.delete(normalized);
        this.tombstones.add(normalized);
    }
    async list(path) {
        const prefix = normalizeListPrefix(path);
        const values = new Set();
        for (const key of this.files.keys()) {
            if (!prefix || key.startsWith(`${prefix}/`))
                values.add(prefix ? key.slice(prefix.length + 1) : key);
        }
        if (this.fallback) {
            for (const value of await this.fallback.list(path)) {
                const full = prefix ? `${prefix}/${value}` : value;
                if (!this.tombstones.has(full.toLowerCase()))
                    values.add(value);
            }
        }
        return [...values].sort((a, b) => a.localeCompare(b));
    }
    async get(path) {
        const normalized = normalizeCascWritePath(path).toLowerCase();
        const data = this.files.get(normalized);
        if (data)
            return copyBytes(data);
        if (this.tombstones.has(normalized))
            throw new Error(`CASC patch path deleted: ${path}`);
        if (this.fallback)
            return this.fallback.get(path);
        throw new Error(`CASC patch path not found: ${path}`);
    }
    async exists(path) {
        const normalized = normalizeCascWritePath(path).toLowerCase();
        if (this.files.has(normalized))
            return true;
        if (this.tombstones.has(normalized))
            return false;
        return this.fallback ? this.fallback.exists(path) : false;
    }
}
export function createSha256TruncatedHasher() {
    return {
        contentKey: data => digest128(data),
        encodingKey: container => digest128(container),
    };
}
function decodeStoredBlte(container) {
    if (container.length < 9 ||
        !BLTE.every((byte, index) => container[index] === byte) ||
        container[8] !== 0x4e) {
        throw new Error('Only single stored BLTE containers are supported by the experimental overlay');
    }
    return container.slice(9);
}
function normalizeListPrefix(path) {
    return path
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/+/g, '/')
        .toLowerCase();
}
function assertHexKey(value, field) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value))
        throw new Error(`Invalid CASC patch ${field}`);
    return value.toLowerCase();
}
function assertNonNegativeInteger(value, field) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        throw new Error(`Invalid CASC patch ${field}`);
    return value;
}
function copyBytes(data) {
    const out = new Uint8Array(data.length);
    out.set(data);
    return out;
}
/** The first 128 bits of SHA-256, as hex: the stand-in keys of a patch written without a game. */
async function digest128(data) {
    return (await sha256Hex(data)).slice(0, 32);
}
