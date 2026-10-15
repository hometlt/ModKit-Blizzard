const HEX_CKEY = /^[0-9a-f]{32}$/i;
export function isStarcraft1TextRoot(bytes) {
    if (bytes.length === 0)
        return false;
    const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
    return (sample.includes('|') &&
        sample.split(/\r?\n/, 16).some(line => {
            const trimmed = stripBom(line).trim();
            if (!trimmed || trimmed.startsWith('#'))
                return false;
            return trimmed.split('|').some(part => HEX_CKEY.test(part.trim()));
        }));
}
export class Starcraft1NameDb {
    byPath;
    constructor(files) {
        this.byPath = new Map();
        for (const file of files)
            this.byPath.set(normalizeKey(file.path), file);
    }
    get size() {
        return this.byPath.size;
    }
    files() {
        return this.byPath.values();
    }
    getByPath(path) {
        return this.byPath.get(normalizeKey(path));
    }
    hasPrefix(path) {
        const key = normalizeKey(path).replace(/\/+$/, '');
        if (!key)
            return this.byPath.size > 0;
        if (this.byPath.has(key))
            return true;
        const prefix = `${key}/`;
        for (const candidate of this.byPath.keys())
            if (candidate.startsWith(prefix))
                return true;
        return false;
    }
    listPaths(prefix = '') {
        const key = normalizeKey(prefix).replace(/\/+$/, '');
        if (!key)
            return [...this.byPath.values()].map(file => file.path).sort();
        const withSlash = `${key}/`;
        const out = [];
        for (const [pathKey, file] of this.byPath) {
            if (pathKey.startsWith(withSlash))
                out.push(file.path.slice(withSlash.length));
        }
        return out.sort();
    }
    static parse(rootBytes) {
        const text = new TextDecoder().decode(rootBytes);
        const files = [];
        const errors = [];
        let row = 0;
        for (const rawLine of text.split(/\r?\n/)) {
            row += 1;
            const line = stripBom(rawLine).trim();
            if (!line || line.startsWith('#'))
                continue;
            const parts = line
                .split('|')
                .map(part => part.trim())
                .filter(Boolean);
            if (parts.length < 2 || parts.length > 3) {
                errors.push(`row ${row}: expected 2 or 3 pipe-delimited columns`);
                continue;
            }
            const path = normalizeStoredPath(parts[0]);
            const contentKey = parts.slice(1).find(part => HEX_CKEY.test(part));
            if (!contentKey) {
                errors.push(`row ${row}: missing 32-hex content key`);
                continue;
            }
            if (!path || isUnsafePath(path)) {
                errors.push(`row ${row}: unsafe path '${parts[0] ?? ''}'`);
                continue;
            }
            files.push({ path, contentKey: contentKey.toLowerCase(), row });
        }
        if (errors.length > 0)
            throw new Error(`StarCraft 1 CASC root: ${errors.join('; ')}`);
        return new Starcraft1NameDb(files);
    }
}
function stripBom(value) {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
function normalizeStoredPath(path) {
    return path.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
}
function normalizeKey(path) {
    return normalizeStoredPath(path).toLowerCase();
}
function isUnsafePath(path) {
    if (/^[a-z]:/i.test(path) || path.startsWith('//'))
        return true;
    return path.split('/').some(part => part === '..' || part === '');
}
