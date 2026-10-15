import { bytesToHex, readUintBE, readUintLE, sliceExact } from './binary.js';
const TVFS_MAGIC = [0x54, 0x56, 0x46, 0x53];
const FOLDER_NODE = 0x80000000;
const FOLDER_SIZE_MASK = 0x7fffffff;
/**
 * True for the TACT virtual-file-system manifest used by Warcraft III CASC builds.
 * Format behavior follows CascLib's MIT-licensed TVFS root handler.
 */
export function isTvfsRoot(data) {
    return TVFS_MAGIC.every((value, index) => data[index] === value);
}
export class TvfsNameDb {
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
    static async parse(data, options = {}) {
        const files = [];
        await parseDirectoryFile(data, '', files, options, new Set());
        return new TvfsNameDb(files);
    }
}
async function parseDirectoryFile(data, prefix, files, options, visitedDirectories) {
    const header = parseHeader(data);
    const tableStart = header.pathOffset;
    const tableEnd = checkedEnd(tableStart, header.pathSize, data.length, 'path table');
    let start = tableStart;
    let end = tableEnd;
    // Most manifests wrap the complete root in an anonymous folder node.
    if (start + 5 <= end && data[start] === 0xff) {
        const value = readUintBE(data, start + 1, 4);
        if ((value & FOLDER_NODE) !== 0) {
            end = start + 1 + (value & FOLDER_SIZE_MASK);
            start += 5;
            if (end > tableEnd)
                throw new Error('CASC TVFS root directory extends beyond path table');
        }
    }
    await parsePathRange(data, header, start, end, prefix, files, options, visitedDirectories);
}
async function parsePathRange(data, header, start, end, prefix, files, options, visitedDirectories) {
    let offset = start;
    // A node without a value is a shared name fragment: the nodes after it continue from it, up to
    // the next node with a value, after which the path returns to the range's prefix (CascLib's
    // PathBuffer save/restore). Warcraft III Reforged splits names so ("human0" + "1/" + ...).
    let current = prefix;
    while (offset < end) {
        const node = parsePathNode(data, offset, end);
        offset = node.next;
        const path = appendFragment(current, node);
        if (node.value === undefined) {
            current = path;
            continue;
        }
        current = prefix;
        if ((node.value & FOLDER_NODE) !== 0) {
            const folderSize = node.value & FOLDER_SIZE_MASK;
            if (folderSize < 4)
                throw new Error('CASC TVFS folder node has invalid size');
            const folderEnd = offset + folderSize - 4;
            if (folderEnd > end)
                throw new Error('CASC TVFS folder extends beyond its parent');
            await parsePathRange(data, header, offset, folderEnd, path, files, options, visitedDirectories);
            offset = folderEnd;
            continue;
        }
        const spans = parseSpans(data, header, node.value);
        const first = spans[0];
        if (!first)
            continue;
        const normalizedPath = normalizeStoredPath(path);
        const file = {
            path: normalizedPath,
            // Keep the common root contract populated; CascReader uses encodingKey for TVFS reads.
            contentKey: first.encodingKey,
            encodingKey: first.encodingKey,
            encodingKeys: spans.map(span => span.encodingKey),
            contentSize: spans.reduce((sum, span) => sum + span.contentSize, 0),
            spanCount: spans.length,
        };
        files.push(file);
        if (spans.length === 1 &&
            options.readEncodingKey &&
            hasEncodingKey(options.directoryEncodingKeys, first.encodingKey) &&
            !visitedDirectories.has(first.encodingKey)) {
            visitedDirectories.add(first.encodingKey);
            const nested = await options.readEncodingKey(first.encodingKey);
            if (!isTvfsRoot(nested))
                throw new Error(`CASC TVFS directory '${normalizedPath}' is not TVFS`);
            await parseDirectoryFile(nested, `${normalizedPath}:`, files, options, visitedDirectories);
        }
    }
}
function parseHeader(data) {
    if (!isTvfsRoot(data) || data.length < 38)
        throw new Error('CASC TVFS root has invalid magic/size');
    const version = data[4] ?? 0;
    const headerSize = data[5] ?? 0;
    const eKeySize = data[6] ?? 0;
    const patchKeySize = data[7] ?? 0;
    if (version !== 1 || headerSize < 38 || headerSize > data.length) {
        throw new Error(`CASC TVFS root has unsupported header version/size: ${version}/${headerSize}`);
    }
    if (eKeySize <= 0 || patchKeySize <= 0)
        throw new Error('CASC TVFS root has invalid key sizes');
    // Flags are little-endian; table offsets and sizes are big-endian.
    readUintLE(data, 8, 4);
    const pathOffset = readUintBE(data, 12, 4);
    const pathSize = readUintBE(data, 16, 4);
    const vfsOffset = readUintBE(data, 20, 4);
    const vfsSize = readUintBE(data, 24, 4);
    const cftOffset = readUintBE(data, 28, 4);
    const cftSize = readUintBE(data, 32, 4);
    checkedEnd(pathOffset, pathSize, data.length, 'path table');
    checkedEnd(vfsOffset, vfsSize, data.length, 'VFS table');
    checkedEnd(cftOffset, cftSize, data.length, 'container table');
    return {
        eKeySize,
        pathOffset,
        pathSize,
        vfsOffset,
        vfsSize,
        cftOffset,
        cftSize,
        cftOffsetSize: offsetFieldSize(cftSize),
    };
}
function parsePathNode(data, start, end) {
    let offset = start;
    let separatorBefore = false;
    let separatorAfter = false;
    if (offset < end && data[offset] === 0) {
        separatorBefore = true;
        offset += 1;
    }
    let fragment = '';
    if (offset < end && data[offset] !== 0xff) {
        const length = data[offset++] ?? 0;
        fragment = new TextDecoder().decode(sliceExact(data, offset, length, 'CASC TVFS path fragment'));
        offset += length;
        if (offset > end)
            throw new Error('CASC TVFS path fragment extends beyond path table');
    }
    if (offset < end && data[offset] === 0) {
        separatorAfter = true;
        offset += 1;
    }
    let value;
    if (offset < end && data[offset] === 0xff) {
        if (offset + 5 > end)
            throw new Error('CASC TVFS path node value is truncated');
        value = readUintBE(data, offset + 1, 4);
        offset += 5;
    }
    else if (offset < end) {
        separatorAfter = true;
    }
    if (offset <= start)
        throw new Error('CASC TVFS path parser made no progress');
    return {
        next: offset,
        fragment,
        separatorBefore,
        separatorAfter,
        ...(value === undefined ? {} : { value }),
    };
}
function parseSpans(data, header, relativeVfsOffset) {
    let offset = header.vfsOffset + relativeVfsOffset;
    const vfsEnd = header.vfsOffset + header.vfsSize;
    if (offset < header.vfsOffset || offset >= vfsEnd)
        throw new Error('CASC TVFS VFS offset is invalid');
    const count = data[offset++] ?? 0;
    if (count < 1 || count > 224)
        return [];
    const itemSize = 8 + header.cftOffsetSize;
    if (offset + itemSize * count > vfsEnd)
        throw new Error('CASC TVFS span table is truncated');
    const spans = [];
    for (let index = 0; index < count; index++) {
        const contentSize = readUintBE(data, offset + 4, 4);
        const relativeCftOffset = readUintBE(data, offset + 8, header.cftOffsetSize);
        const cftOffset = header.cftOffset + relativeCftOffset;
        const cftEnd = header.cftOffset + header.cftSize;
        if (cftOffset < header.cftOffset || cftOffset + header.eKeySize + 4 > cftEnd) {
            throw new Error('CASC TVFS container entry is truncated');
        }
        const encodingKey = bytesToHex(sliceExact(data, cftOffset, header.eKeySize, 'CASC TVFS encoding key'));
        spans.push({ encodingKey, contentSize });
        offset += itemSize;
    }
    return spans;
}
function appendFragment(prefix, node) {
    let result = prefix;
    if (node.separatorBefore && result && !result.endsWith('/'))
        result += '/';
    result += node.fragment;
    if (node.separatorAfter && result && !result.endsWith('/'))
        result += '/';
    return result;
}
function normalizeStoredPath(path) {
    return path
        .replace(/\\+/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^\/+|\/+$/g, '');
}
// The key treats a nested manifest's ':' as a separator: the reader's path normalisation turns ':'
// into '\\', so a stored `war3.w3mod:units/x.mdx` is asked for as `war3.w3mod\units\x.mdx`.
function normalizeKey(path) {
    return normalizeStoredPath(path.replace(/:/g, '/')).toLowerCase();
}
function offsetFieldSize(tableSize) {
    if (tableSize > 0xffffff)
        return 4;
    if (tableSize > 0xffff)
        return 3;
    if (tableSize > 0xff)
        return 2;
    return 1;
}
function checkedEnd(offset, size, length, label) {
    const end = offset + size;
    if (offset < 0 || size < 0 || end < offset || end > length) {
        throw new Error(`CASC TVFS ${label} extends beyond buffer`);
    }
    return end;
}
function hasEncodingKey(keys, key) {
    if (!keys)
        return false;
    const normalized = key.toLowerCase();
    for (const candidate of keys) {
        const other = candidate.toLowerCase();
        if (normalized.startsWith(other) || other.startsWith(normalized))
            return true;
    }
    return false;
}
