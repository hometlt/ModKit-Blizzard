import { bytesToHex, readUintBE, sliceExact } from './binary.js';
/**
 * Parse Blizzard's `install` manifest (signature `IN`). Unlike the MNDX root,
 * this is a flat, fully name-addressed table — no name database needed — so it is
 * the cheapest real-data validation of the storage→encoding→BLTE chain.
 *
 * Layout (all multi-byte integers big-endian):
 *   "IN" | version(u8) | hashSize(u8) | numTags(u16) | numEntries(u32)
 *   numTags × { name(asciiz) | type(u16) | mask[ceil(numEntries/8)] }
 *   numEntries × { name(asciiz) | ckey[hashSize] | size(u32) }
 * Each tag's bitmask is MSB-first: entry i carries the tag when
 *   mask[i >> 3] & (0x80 >> (i & 7)) is set.
 */
export function parseInstallManifest(data) {
    if (data.length < 10 || data[0] !== 0x49 || data[1] !== 0x4e) {
        throw new Error('CASC install file is missing IN magic');
    }
    const version = data[2];
    const hashSize = data[3];
    if (hashSize <= 0)
        throw new Error('CASC install file has invalid hash size');
    const numTags = readUintBE(data, 4, 2);
    const numEntries = readUintBE(data, 6, 4);
    const maskLength = Math.ceil(numEntries / 8);
    let offset = 10;
    const tags = [];
    const masks = [];
    for (let i = 0; i < numTags; i++) {
        const { value: name, next } = readCString(data, offset);
        offset = next;
        const type = readUintBE(data, offset, 2);
        offset += 2;
        masks.push(sliceExact(data, offset, maskLength, 'CASC install tag mask'));
        offset += maskLength;
        tags.push({ name, type });
    }
    const entries = [];
    for (let i = 0; i < numEntries; i++) {
        const { value: name, next } = readCString(data, offset);
        offset = next;
        const contentKey = bytesToHex(sliceExact(data, offset, hashSize, 'CASC install content key'));
        offset += hashSize;
        const size = readUintBE(data, offset, 4);
        offset += 4;
        const entryTags = [];
        for (let t = 0; t < numTags; t++) {
            if (masks[t][i >> 3] & (0x80 >> (i & 7)))
                entryTags.push(tags[t].name);
        }
        entries.push({ name, contentKey, size, tags: entryTags });
    }
    return { version, hashSize, tags, entries };
}
function readCString(data, offset) {
    let end = offset;
    while (end < data.length && data[end] !== 0)
        end++;
    if (end >= data.length)
        throw new Error('CASC install string is not null-terminated');
    return { value: new TextDecoder().decode(data.subarray(offset, end)), next: end + 1 };
}
