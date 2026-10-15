// Diablo III root layout and asset-group mapping are based on CascLib.
// See ../THIRD-PARTY-NOTICES.md for the retained MIT license notice.
import { bytesToHex } from './binary.js';
const DIABLO3_ROOT_SIGNATURE = 0x8007d0c4;
const DIABLO3_SUBDIR_SIGNATURE = 0xeaf1fe87;
const DIABLO3_PACKAGES_SIGNATURE = 0xaabb0002;
const DIABLO3_GROUP_COUNT = 70;
const CONTENT_KEY_SIZE = 16;
const CORE_TOC_HEADER_SIZE = DIABLO3_GROUP_COUNT * 3 * 4 + 4;
const MAX_RECORDS = 10_000_000;
const ASSET_INFO = [
    undefined,
    ['Actor', 'acr'],
    ['Adventure', 'adv'],
    undefined,
    undefined,
    ['AmbientSound', 'ams'],
    ['Anim', 'ani'],
    ['Anim2D', 'an2'],
    ['AnimSet', 'ans'],
    ['Appearance', 'app'],
    undefined,
    ['Cloth', 'clt'],
    ['Conversation', 'cnv'],
    undefined,
    ['EffectGroup', 'efg'],
    ['Encounter', 'enc'],
    undefined,
    ['Explosion', 'xpl'],
    undefined,
    ['Font', 'fnt'],
    ['GameBalance', 'gam'],
    ['Globals', 'glo'],
    ['LevelArea', 'lvl'],
    ['Light', 'lit'],
    ['MarkerSet', 'mrk'],
    ['Monster', 'mon'],
    ['Observer', 'obs'],
    ['Particle', 'prt'],
    ['Physics', 'phy'],
    ['Power', 'pow'],
    undefined,
    ['Quest', 'qst'],
    ['Rope', 'rop'],
    ['Scene', 'scn'],
    ['SceneGroup', 'scg'],
    undefined,
    ['ShaderMap', 'shm'],
    ['Shaders', 'shd'],
    ['Shakes', 'shk'],
    ['SkillKit', 'skl'],
    ['Sound', 'snd'],
    ['SoundBank', 'sbk'],
    ['StringList', 'stl'],
    ['Surface', 'srf'],
    ['Textures', 'tex'],
    ['Trail', 'trl'],
    ['UI', 'ui'],
    ['Weather', 'wth'],
    ['Worlds', 'wrl'],
    ['Recipe', 'rcp'],
    undefined,
    ['Condition', 'cnd'],
    undefined,
    undefined,
    undefined,
    undefined,
    ['Act', 'act'],
    ['Material', 'mat'],
    ['QuestRange', 'qsr'],
    ['Lore', 'lor'],
    ['Reverb', 'rev'],
    ['PhysMesh', 'phm'],
    ['Music', 'mus'],
    ['Tutorial', 'tut'],
    ['BossEncounter', 'bos'],
    undefined,
    ['Accolade', 'aco'],
];
/** Return the virtual directory and extension assigned to a Diablo III CoreTOC group. */
export function getDiablo3AssetInfo(assetIndex) {
    const info = ASSET_INFO[assetIndex];
    return info ? { assetIndex, directory: info[0], extension: info[1] } : undefined;
}
/** Resolve a Diablo III SNO group from the extension assigned by its CASC root. */
export function getDiablo3AssetInfoForPath(path) {
    const portable = path.replace(/\\/g, '/');
    const basename = portable.slice(portable.lastIndexOf('/') + 1);
    const dot = basename.lastIndexOf('.');
    if (dot < 0)
        return undefined;
    const extension = basename.slice(dot + 1).toLowerCase();
    for (let assetIndex = 0; assetIndex < ASSET_INFO.length; assetIndex += 1) {
        const info = ASSET_INFO[assetIndex];
        if (info?.[1] === extension)
            return { assetIndex, directory: info[0], extension: info[1] };
    }
    return undefined;
}
class Cursor {
    bytes;
    view;
    offset = 0;
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    remaining() {
        return this.bytes.length - this.offset;
    }
    u32(label) {
        this.ensure(4, label);
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }
    contentKey(label) {
        this.ensure(CONTENT_KEY_SIZE, label);
        const key = bytesToHex(this.bytes.subarray(this.offset, this.offset + CONTENT_KEY_SIZE));
        this.offset += CONTENT_KEY_SIZE;
        return key;
    }
    cstring(label) {
        const end = this.bytes.indexOf(0, this.offset);
        if (end < this.offset)
            throw new Error(`Diablo III root: unterminated ${label}`);
        const value = new TextDecoder('latin1').decode(this.bytes.subarray(this.offset, end));
        this.offset = end + 1;
        return value;
    }
    ensure(length, label) {
        if (length < 0 || this.offset + length > this.bytes.length) {
            throw new Error(`Diablo III root: truncated ${label}`);
        }
    }
}
function checkedCount(value, recordSize, remaining, label) {
    if (value > MAX_RECORDS || value * recordSize > remaining) {
        throw new Error(`Diablo III root: invalid ${label} count ${value}`);
    }
    return value;
}
function parseDirectory(bytes) {
    const cursor = new Cursor(bytes);
    const signature = cursor.u32('directory signature');
    if (signature !== DIABLO3_ROOT_SIGNATURE && signature !== DIABLO3_SUBDIR_SIGNATURE) {
        throw new Error(`Diablo III root: unsupported directory signature 0x${signature.toString(16)}`);
    }
    const assets = [];
    if (signature === DIABLO3_SUBDIR_SIGNATURE) {
        const plainCount = checkedCount(cursor.u32('asset'), 20, cursor.remaining(), 'asset');
        for (let i = 0; i < plainCount; i += 1) {
            assets.push({
                contentKey: cursor.contentKey(`asset ${i} key`),
                fileIndex: cursor.u32(`asset ${i} index`),
            });
        }
        const indexedCount = checkedCount(cursor.u32('indexed asset'), 24, cursor.remaining(), 'indexed asset');
        for (let i = 0; i < indexedCount; i += 1) {
            assets.push({
                contentKey: cursor.contentKey(`indexed asset ${i} key`),
                fileIndex: cursor.u32(`indexed asset ${i} index`),
                subIndex: cursor.u32(`indexed asset ${i} sub-index`),
            });
        }
    }
    const namedCount = checkedCount(cursor.u32('named entry'), CONTENT_KEY_SIZE + 1, cursor.remaining(), 'named entry');
    const named = [];
    for (let i = 0; i < namedCount; i += 1) {
        named.push({
            contentKey: cursor.contentKey(`named entry ${i} key`),
            name: cursor.cstring(`named entry ${i} name`),
        });
    }
    return { assets, named };
}
function u32(bytes, offset, label) {
    if (offset < 0 || offset + 4 > bytes.length)
        throw new Error(`Diablo III CoreTOC: truncated ${label}`);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
function cstringAt(bytes, offset, label) {
    if (offset < 0 || offset >= bytes.length)
        throw new Error(`Diablo III CoreTOC: invalid ${label} offset`);
    const end = bytes.indexOf(0, offset);
    if (end < offset)
        throw new Error(`Diablo III CoreTOC: unterminated ${label}`);
    return new TextDecoder('latin1').decode(bytes.subarray(offset, end));
}
/** Parse the Diablo III CASC CoreTOC variant used to turn directory file indices into asset names. */
export function parseDiablo3CoreToc(bytes) {
    if (bytes.length < CORE_TOC_HEADER_SIZE)
        throw new Error('Diablo III CoreTOC: truncated header');
    const out = new Map();
    const countsOffset = 0;
    const offsetsOffset = DIABLO3_GROUP_COUNT * 4;
    const dataOffset = CORE_TOC_HEADER_SIZE;
    for (let group = 0; group < DIABLO3_GROUP_COUNT; group += 1) {
        const count = u32(bytes, countsOffset + group * 4, `group ${group} count`);
        const relativeOffset = u32(bytes, offsetsOffset + group * 4, `group ${group} offset`);
        if (count > MAX_RECORDS)
            throw new Error(`Diablo III CoreTOC: invalid group ${group} count ${count}`);
        const entriesOffset = dataOffset + relativeOffset;
        const namesOffset = entriesOffset + count * 12;
        if (entriesOffset < dataOffset || namesOffset > bytes.length) {
            throw new Error(`Diablo III CoreTOC: group ${group} entries are out of range`);
        }
        for (let i = 0; i < count; i += 1) {
            const offset = entriesOffset + i * 12;
            const assetIndex = u32(bytes, offset, `group ${group} entry ${i} asset`);
            const fileIndex = u32(bytes, offset + 4, `group ${group} entry ${i} file index`);
            const nameOffset = u32(bytes, offset + 8, `group ${group} entry ${i} name offset`);
            out.set(fileIndex, {
                assetIndex,
                fileIndex,
                name: cstringAt(bytes, namesOffset + nameOffset, `group ${group} entry ${i} name`),
            });
        }
    }
    return out;
}
/** Parse Packages.dat into a case-insensitive extension-recovery map keyed by path without extension. */
export function parseDiablo3Packages(bytes) {
    const cursor = new Cursor(bytes);
    const signature = cursor.u32('Packages.dat signature');
    if (signature !== DIABLO3_PACKAGES_SIGNATURE) {
        throw new Error(`Diablo III Packages.dat: bad signature 0x${signature.toString(16)}`);
    }
    const count = checkedCount(cursor.u32('package name'), 1, cursor.remaining(), 'package name');
    const out = new Map();
    for (let i = 0; i < count; i += 1) {
        const path = portablePath(cursor.cstring(`package name ${i}`));
        const dot = path.lastIndexOf('.');
        out.set(normalizeKey(dot > path.lastIndexOf('/') ? path.slice(0, dot) : path), path);
    }
    return out;
}
function normalizeKey(path) {
    return portablePath(path).toLowerCase();
}
function portablePath(path) {
    return path.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '');
}
function joinPath(parent, child) {
    const a = portablePath(parent);
    const b = portablePath(child);
    return a ? (b ? `${a}/${b}` : a) : b;
}
function fallbackAssetPath(entry, subIndex) {
    const info = getDiablo3AssetInfo(entry.assetIndex);
    const directory = info?.directory ?? `Asset${String(entry.assetIndex).padStart(2, '0')}`;
    const extension = info?.extension ?? `a${String(entry.assetIndex).padStart(2, '0')}`;
    const stem = subIndex === undefined
        ? joinPath(directory, entry.name)
        : joinPath(joinPath(directory, entry.name), String(subIndex).padStart(4, '0'));
    return `${stem}.${extension}`;
}
function assetPath(entry, subIndex, packages) {
    const fallback = fallbackAssetPath(entry, subIndex);
    const dot = fallback.lastIndexOf('.');
    return packages.get(normalizeKey(fallback.slice(0, dot))) ?? fallback;
}
export function isDiablo3Root(bytes) {
    return bytes.length >= 4 && u32(bytes, 0, 'signature') === DIABLO3_ROOT_SIGNATURE;
}
export class Diablo3NameDb {
    byPath;
    byAssetId;
    constructor(files) {
        this.byPath = new Map(files.map(file => [normalizeKey(file.path), file]));
        this.byAssetId = new Map();
        for (const file of files) {
            if (file.kind === 'asset' &&
                file.assetIndex !== undefined &&
                file.fileIndex !== undefined &&
                file.subIndex === undefined) {
                this.byAssetId.set(`${file.assetIndex}:${file.fileIndex}`, file);
            }
        }
    }
    get size() {
        return this.byPath.size;
    }
    files() {
        return this.byPath.values();
    }
    getByPath(path) {
        const direct = this.byPath.get(normalizeKey(path));
        if (direct)
            return direct;
        const group = getDiablo3AssetInfoForPath(path);
        if (!group)
            return undefined;
        const portable = portablePath(path);
        const name = portable.slice(portable.lastIndexOf('/') + 1);
        const id = Number.parseInt(name.slice(0, name.lastIndexOf('.')), 10);
        return Number.isSafeInteger(id) ? this.byAssetId.get(`${group.assetIndex}:${id}`) : undefined;
    }
    hasPrefix(path) {
        const key = normalizeKey(path);
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
        const key = normalizeKey(prefix);
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
    static async parse(rootBytes, readContentKey) {
        const root = parseDirectory(rootBytes);
        const files = [];
        const directories = [];
        for (const named of root.named) {
            const path = portablePath(named.name);
            files.push({ path, contentKey: named.contentKey, kind: 'named' });
            try {
                const directory = parseDirectory(await readContentKey(named.contentKey));
                directories.push({ path, directory });
                for (const child of directory.named) {
                    files.push({
                        path: joinPath(path, child.name),
                        contentKey: child.contentKey,
                        kind: 'named',
                    });
                }
            }
            catch {
                // Root named entries can be ordinary files. Only valid subdirectory payloads participate
                // in the asset-index phase; the named entry itself remains readable either way.
            }
        }
        const namedByPath = new Map(files.map(file => [normalizeKey(file.path), file]));
        const coreTocFile = namedByPath.get('base/coretoc.dat');
        if (!coreTocFile)
            return new Diablo3NameDb(files);
        const coreToc = parseDiablo3CoreToc(await readContentKey(coreTocFile.contentKey));
        let packages = new Map();
        const packagesFile = namedByPath.get('base/data_d3/pc/misc/packages.dat');
        if (packagesFile) {
            try {
                packages = parseDiablo3Packages(await readContentKey(packagesFile.contentKey));
            }
            catch {
                // Extension recovery is optional; deterministic group extensions remain available.
            }
        }
        for (const { directory } of directories) {
            for (const asset of directory.assets) {
                const toc = coreToc.get(asset.fileIndex);
                if (!toc)
                    continue;
                files.push({
                    path: assetPath(toc, asset.subIndex, packages),
                    contentKey: asset.contentKey,
                    kind: 'asset',
                    assetIndex: toc.assetIndex,
                    fileIndex: toc.fileIndex,
                    ...(asset.subIndex === undefined ? {} : { subIndex: asset.subIndex }),
                });
            }
        }
        return new Diablo3NameDb(files);
    }
}
