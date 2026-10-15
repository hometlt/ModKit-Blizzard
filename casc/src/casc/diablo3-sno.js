// Diablo III SNO layout information is based on WhiteoutLib's format specifications.
// See ../THIRD-PARTY-NOTICES.md for the retained BSD-3-Clause and AI-derived-work notices.
import { getDiablo3AssetInfoForPath } from './diablo3-root.js';
export const DIABLO3_SNO_MAGIC = 0xdeadbeef;
export const DIABLO3_SNO_PREAMBLE_SIZE = 32;
const KNOWN_VERSIONS = {
    1: 282,
    6: 118,
    8: 24,
    9: 260,
    11: 51,
    19: 50,
    27: 180,
    28: 37,
    40: 67,
    41: 41,
    44: 47,
    57: 25,
};
function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function requireLength(bytes, length, label) {
    if (bytes.length < length)
        throw new Error(`Diablo III ${label}: truncated file`);
}
function fixedString(bytes, offset, length) {
    const end = Math.min(bytes.length, offset + length);
    let zero = offset;
    while (zero < end && bytes[zero] !== 0)
        zero += 1;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(offset, zero));
}
/** True for a complete Diablo III SNO preamble. The path distinguishes D3 from D4 SNO files. */
export function isDiablo3Sno(bytes, path = '') {
    if (bytes.length < DIABLO3_SNO_PREAMBLE_SIZE)
        return false;
    const dv = view(bytes);
    if (dv.getUint32(0, true) !== DIABLO3_SNO_MAGIC)
        return false;
    const group = getDiablo3AssetInfoForPath(path);
    if (!group)
        return false;
    const expectedVersion = KNOWN_VERSIONS[group.assetIndex];
    return expectedVersion === undefined || dv.getUint32(4, true) === expectedVersion;
}
/** Parse the common 32-byte preamble shared by Diablo III structured assets. */
export function parseDiablo3SnoHeader(bytes, path = '') {
    requireLength(bytes, DIABLO3_SNO_PREAMBLE_SIZE, 'SNO');
    const dv = view(bytes);
    const magic = dv.getUint32(0, true);
    if (magic !== DIABLO3_SNO_MAGIC) {
        throw new Error(`Diablo III SNO: bad magic 0x${magic.toString(16).padStart(8, '0')}`);
    }
    const version = dv.getUint32(4, true);
    const group = getDiablo3AssetInfoForPath(path);
    const expectedVersion = group ? KNOWN_VERSIONS[group.assetIndex] : undefined;
    return {
        magic: DIABLO3_SNO_MAGIC,
        version,
        snoId: dv.getInt32(16, true),
        flags: dv.getUint32(28, true),
        reserved08: dv.getUint32(8, true),
        reserved0c: dv.getUint32(12, true),
        reserved14: dv.getUint32(20, true),
        reserved18: dv.getUint32(24, true),
        ...(group ? { group } : {}),
        ...(expectedVersion === undefined
            ? {}
            : { expectedVersion, versionMatches: version === expectedVersion }),
    };
}
/** Parse the fixed descriptor and table summary from a Diablo III v47 texture SNO. */
export function parseDiablo3TextureHeader(bytes) {
    const sno = parseDiablo3SnoHeader(bytes, 'asset.tex');
    if (sno.version !== 47)
        throw new Error(`Diablo III TEX: unsupported version ${sno.version}`);
    requireLength(bytes, 0x270, 'TEX');
    const dv = view(bytes);
    let mipCount = 0;
    for (let index = 0; index < 60; index += 1) {
        if (dv.getUint32(0x38 + index * 8 + 4, true) === 0)
            break;
        mipCount += 1;
    }
    const width = dv.getUint32(0x24, true);
    const height = dv.getUint32(0x28, true);
    const depth = dv.getUint32(0x2c, true);
    if (width === 0 || height === 0 || depth === 0) {
        throw new Error(`Diablo III TEX: invalid dimensions ${width}x${height}x${depth}`);
    }
    return {
        pixelFormat: dv.getUint32(0x20, true),
        width,
        height,
        depth,
        flags: dv.getUint32(0x30, true),
        extraMipCount: dv.getUint32(0x34, true),
        mipCount,
        frameCount: dv.getUint32(0x218, true),
        frameTableOffset: dv.getUint32(0x21c, true),
        frameTableSize: dv.getUint32(0x220, true),
    };
}
/** Parse the v50 Font SNO wrapper and expose its embedded sfnt payload. */
export function parseDiablo3Font(bytes, path = 'asset.fnt') {
    const header = parseDiablo3SnoHeader(bytes, path);
    if (header.version !== 50)
        throw new Error(`Diablo III FNT: unsupported version ${header.version}`);
    requireLength(bytes, 0xd8, 'FNT');
    const dv = view(bytes);
    const embeddedOffset = dv.getUint32(0xb8, true) + 16;
    const embeddedSize = dv.getUint32(0xbc, true);
    if (embeddedOffset < 0xd8 || embeddedSize === 0 || embeddedOffset + embeddedSize > bytes.length) {
        throw new Error(`Diablo III FNT: invalid embedded font range ${embeddedOffset} + ${embeddedSize}`);
    }
    const tag = fixedString(bytes, embeddedOffset, 4);
    let embeddedKind;
    if (tag === 'OTTO')
        embeddedKind = 'opentype-cff';
    else if (tag === 'ttcf')
        embeddedKind = 'truetype-collection';
    else if (bytes[embeddedOffset] === 0 &&
        bytes[embeddedOffset + 1] === 1 &&
        bytes[embeddedOffset + 2] === 0 &&
        bytes[embeddedOffset + 3] === 0) {
        embeddedKind = 'truetype';
    }
    else {
        throw new Error(`Diablo III FNT: unsupported embedded sfnt signature`);
    }
    return {
        header,
        sourceName: fixedString(bytes, 0x20, 0x40),
        embeddedName: fixedString(bytes, 0x60, 0x58),
        embeddedOffset,
        embeddedSize,
        embeddedKind,
        embeddedBytes: bytes.subarray(embeddedOffset, embeddedOffset + embeddedSize),
    };
}
