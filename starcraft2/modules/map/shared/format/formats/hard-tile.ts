/**
 * Parser and writer for the `t3HardTile` (magic `HRDT`) file embedded in
 * `.SC2Map` archives.
 *
 * Purpose: **partially understood** native hard-tile placements. This reader
 * exposes the version-102 structure seen in RoadExampleMap and two campaign
 * maps, but does not infer road splines, materials or editable geometry.
 *
 * Observed binary layout (field meanings beyond positions/normals/scale are
 * not established; the complete original bytes are retained):
 *
 * ```c
 * struct Header {
 *   char  magic[4];   // "HRDT"
 *   uint32 version;   // 102
 *   uint32 unk[4];
 *   uint32 blockCount; // at offset 24
 * };
 * // blockCount variable-length blocks follow:
 * struct SubBlock {
 *   float x, y, z;
 *   float normal[3];
 *   uint32 unknownWords[6];
 *   float scale;
 *   uint32 tailWord;
 *   uint8 flags[2];
 * };
 * struct Block {
 *   uint32    subCount;
 *   SubBlock  subs[subCount];
 *   uint8     flags[3];
 *   char      name[];     // bounded NUL-terminated string in observed v102 files
 *   uint32    tailWord;
 * };
 * ```
 *
 * The codec reads the 28-byte prefix and bounded 58-byte placement records.
 * Unsupported versions, unfinished blocks and trailing bytes remain opaque;
 * writing always returns the original bytes unchanged. The group-string
 * encoding is only established for the observed NUL-terminated samples.
 *
 * Explicit repair of duplicate group words patches only offsets recorded by this reader;
 * the default writer remains raw-preserving. Explicit complete-v102 group replacement
 * is separately supported; spline inference and UVW projection remain unsupported here.
 * Browser-safe: DataView/TextDecoder only, zero external dependencies.
 */

import { Cursor, Writer } from '../binary.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HardTileSubBlock {
  x: number; y: number; z: number
  normal: number[]       // 3 floats; observed magnitudes are approximately 1
  unknownWords: number[] // 6 uninterpreted uint32 words
  scale: number          // float32
  tailWord: number       // uninterpreted uint32
  flags: number[]        // 2 uninterpreted uint8 values
  raw: Uint8Array      // original 58-byte record
}

export interface HardTileBlock {
  subs: HardTileSubBlock[]
  flags: number[]       // 3 uninterpreted uint8 values
  name: string          // bounded NUL-terminated name in observed v102 files
  tailWord: number      // group word: duplicate values prevented independent selection in R64
  /** Offset of this word in raw; only set by the native reader. */
  tailWordOffset?: number
}

export interface HardTileResult {
  version: number
  unk: number[]   // 4 uint32 header unknowns
  declaredBlocks: number
  decodedBytes: number
  /** Successfully parsed blocks. */
  blocks: HardTileBlock[]
  /** Unsupported version, unfinished block or trailing bytes, kept opaque. */
  rawRemainder?: Uint8Array
  /** Full original bytes — always written back unchanged. */
  raw: Uint8Array
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC = 'HRDT'
const VERSION = 102
const RECORD_BYTES = 58
const MAX_NAME_BYTES = 256
class HardTileBudgetError extends RangeError {}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `t3HardTile` binary file. */
export function readHardTile(bytes: Uint8Array, limits?: { maxGroups: number; maxRecords: number; maxNodes?: number }): HardTileResult {
  const base: HardTileResult = { version: 0, unk: [], declaredBlocks: 0, decodedBytes: 0, blocks: [], raw: bytes }

  if (bytes.length < 28) return base

  const r = new Cursor(bytes)

  // Validate magic
  const magic = r.ascii(4)
  if (magic !== MAGIC) return base

  base.version = r.u32()
  if (base.version !== VERSION) {
    base.rawRemainder = bytes.slice(r.offset)
    base.decodedBytes = r.offset
    return base
  }
  base.unk = [r.u32(), r.u32(), r.u32(), r.u32()]
  const blockCount = r.u32()
  base.declaredBlocks = blockCount
  base.decodedBytes = r.offset
  if (limits !== undefined && (blockCount > limits.maxGroups || blockCount + 1 > (limits.maxNodes ?? Infinity)))
    throw new HardTileBudgetError('Hard-tile declared groups exceed the node budget')
  let recordCount = 0

  for (let i = 0; i < blockCount; i++) {
    const blockStart = r.offset
    try {
      const subCount = r.u32()
      if (limits !== undefined && (recordCount + subCount > limits.maxRecords ||
          blockCount + recordCount + subCount + 1 > (limits.maxNodes ?? Infinity)))
        throw new HardTileBudgetError('Hard-tile declared records exceed the node budget')
      // A group needs its record bytes plus three flags, a NUL and a final word.
      if (subCount > Math.floor((r.remaining - 8) / RECORD_BYTES)) throw new RangeError('Truncated hard-tile group')
      const subs: HardTileSubBlock[] = []
      for (let j = 0; j < subCount; j++) {
        const recordStart = r.offset
        const x = r.f32(); const y = r.f32(); const z = r.f32()
        const normal = [r.f32(), r.f32(), r.f32()]
        const unknownWords: number[] = []
        for (let k = 0; k < 6; k++) unknownWords.push(r.u32())
        const scale = r.f32()
        const tailWord = r.u32()
        const flags = [r.u8(), r.u8()]
        subs.push({ x, y, z, normal, unknownWords, scale, tailWord, flags, raw: bytes.slice(recordStart, r.offset) })
      }
      const flags = [r.u8(), r.u8(), r.u8()]
      const nameStart = r.offset
      const nameLimit = Math.min(nameStart + MAX_NAME_BYTES, bytes.length - 4)
      let nameEnd = nameStart
      while (nameEnd < nameLimit && bytes[nameEnd] !== 0) nameEnd++
      if (nameEnd === nameLimit) throw new RangeError('Unterminated hard-tile group name')
      const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(nameStart, nameEnd))
      r.offset = nameEnd + 1
      const tailWordOffset = r.offset
      const tailWord = r.u32()
      base.blocks.push({ subs, flags, name, tailWord, tailWordOffset })
      recordCount += subCount
      base.decodedBytes = r.offset
    } catch (error) {
      if (error instanceof HardTileBudgetError) throw error
      // An unfinished block is opaque from its first byte, not from the failed field.
      base.rawRemainder = bytes.slice(blockStart)
      return base
    }
  }
  if (r.remaining > 0) {
    base.rawRemainder = bytes.slice(r.offset)
  }

  return base
}

/** Serialize a `HardTileResult` back — always returns the original bytes verbatim. */
export function writeHardTile(data: HardTileResult): Uint8Array {
  // Structural edits opt in through writeHardTile102/replaceHardTileGroups.
  // The default serializer deliberately retains the original document.
  return data.raw
}


/** Repair only repeated group words in a complete v102 document; keep all other bytes literal.
 * R64 proved that a duplicated group word prevented independent selection in Editor.
 * Allocation is local to this document, deterministic and independent of game/material names.
 * Existing unique values are all reserved before choosing new nonzero, four-aligned values;
 * their wider native meaning and cross-document identity remain unspecified.
 */
export function repairHardTileGroupKeys(bytes: Uint8Array): {
  bytes: Uint8Array
  changes: { blockIndex: number; byteOffset: number; previous: number; next: number }[]
} {
  if (bytes.byteLength > 128 * 1024 * 1024) throw new RangeError('Hard-tile repair exceeds the byte budget')
  const map = readHardTile(bytes, { maxGroups: 16384, maxRecords: 1000000 })
  if (map.version !== VERSION || map.rawRemainder !== undefined || map.decodedBytes !== bytes.byteLength ||
      map.declaredBlocks !== map.blocks.length || map.blocks.length > 16384)
    throw new TypeError('Hard-tile repair requires a complete bounded version102 document')
  const reserved = new Set(map.blocks.map(block => block.tailWord))
  const seen = new Set<number>()
  const changes: { blockIndex: number; byteOffset: number; previous: number; next: number }[] = []
  let candidate = 4
  for (const [blockIndex, block] of map.blocks.entries()) {
    if (!seen.has(block.tailWord)) { seen.add(block.tailWord); continue }
    while (reserved.has(candidate)) candidate += 4
    const byteOffset = block.tailWordOffset
    if (byteOffset === undefined || byteOffset < 28 || byteOffset + 4 > bytes.byteLength)
      throw new RangeError('Hard-tile group word has no verified native offset')
    changes.push({ blockIndex, byteOffset, previous: block.tailWord, next: candidate })
    reserved.add(candidate)
    candidate += 4
  }
  const output = Uint8Array.from(bytes)
  const view = new DataView(output.buffer)
  for (const change of changes) view.setUint32(change.byteOffset, change.next, true)
  return { bytes: output, changes }
}

/** Explicit observed-v102 structural authoring; never infers spline or material semantics.
 * Isolated candidate at the existing owner. Raw-preserving writeHardTile stays unchanged.
 * Validate the whole plan before allocating; unknown record words and flags are explicit.
 */
export function writeHardTile102(
  data: { version: number; unk: readonly number[]; blocks: readonly HardTileWriteBlock[] },
  limits: { maxBytes: number; maxGroups: number; maxRecords: number },
): Uint8Array {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid HRDT writer budget')
  if (limits.maxBytes > 128 * 1024 * 1024 || limits.maxGroups > 16384 || limits.maxRecords > 1000000)
    throw new RangeError('HRDT writer budget exceeds bounded profile')
  if (data.version !== VERSION || data.unk.length !== 4 || data.blocks.length > limits.maxGroups)
    throw new TypeError('HRDT structural writer requires bounded version102 data')
  const uint = (value: number, max: number) => {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new TypeError('Invalid HRDT unsigned field')
  }
  const words = (values: readonly number[], count: number, max: number) => {
    if (!Array.isArray(values) || values.length !== count) throw new TypeError('Invalid HRDT field length')
    for (const value of values) uint(value, max)
  }
  const float = (value: number) => {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new TypeError('Invalid HRDT float32')
  }
  words(data.unk, 4, 0xffffffff)
  let size = 28, records = 0
  const names: Uint8Array[] = []
  for (const block of data.blocks) {
    if (typeof block.name !== 'string' || block.name.includes('\0')) throw new TypeError('Invalid HRDT tile ID')
    const name = new TextEncoder().encode(block.name)
    if (name.length >= MAX_NAME_BYTES || new TextDecoder('utf-8', { fatal: true }).decode(name) !== block.name)
      throw new TypeError('Invalid HRDT UTF8 tile ID')
    names.push(name)
    records += block.subs.length
    size += 4 + block.subs.length * RECORD_BYTES + 3 + name.length + 1 + 4
    if (records > limits.maxRecords || !Number.isSafeInteger(size) || size > limits.maxBytes)
      throw new RangeError('HRDT writer input exceeds budget')
    words(block.flags, 3, 255); uint(block.tailWord, 0xffffffff)
    for (const record of block.subs) {
      float(record.x); float(record.y); float(record.z)
      if (record.normal.length !== 3) throw new TypeError('Invalid HRDT normal length')
      record.normal.forEach(float); float(record.scale)
      words(record.unknownWords, 6, 0xffffffff); words(record.flags, 2, 255); uint(record.tailWord, 0xffffffff)
    }
  }
  if (size > limits.maxBytes) throw new RangeError('HRDT writer header exceeds budget')
  const writer = new Writer(size)
  writer.ascii(MAGIC).u32(VERSION)
  data.unk.forEach(word => writer.u32(word)); writer.u32(data.blocks.length)
  data.blocks.forEach((block, index) => {
    writer.u32(block.subs.length)
    for (const record of block.subs) {
      writer.f32(record.x).f32(record.y).f32(record.z)
      record.normal.forEach(value => writer.f32(value))
      record.unknownWords.forEach(word => writer.u32(word))
      writer.f32(record.scale).u32(record.tailWord)
      record.flags.forEach(flag => writer.u8(flag))
    }
    block.flags.forEach(flag => writer.u8(flag))
    writer.raw(names[index]!).u8(0).u32(block.tailWord)
  })
  return writer.done()
}

/** Explicit structural input, with every opaque field supplied; raw bytes are not editable fields. */
export type HardTileWriteBlock = Pick<HardTileBlock, 'name' | 'flags' | 'tailWord'> & {
  subs: Omit<HardTileSubBlock, 'raw'>[]
}

/** Replace the requested groups while preserving the document header. Partial layouts are refused.
 * Unique group words are a precondition; the separate repair operation is never invoked implicitly.
 * This is native structural authoring, not qualification of spline or UVW semantics.
 */
export function replaceHardTileGroups(
  bytes: Uint8Array,
  groups: readonly HardTileWriteBlock[],
  limits: { maxBytes: number; maxGroups: number; maxRecords: number },
): Uint8Array {
  if (bytes.byteLength > limits.maxBytes) throw new RangeError('Hard-tile source exceeds byte budget')
  const current = readHardTile(bytes, limits)
  if (current.version !== VERSION || current.rawRemainder !== undefined ||
      current.decodedBytes !== bytes.byteLength || current.blocks.length !== current.declaredBlocks)
    throw new TypeError('Hard-tile replacement requires a complete version102 document')
  if (!Array.isArray(groups) || groups.length > limits.maxGroups)
    throw new RangeError('Hard-tile replacement exceeds group budget')
  if (new Set(groups.map(group => group.tailWord)).size !== groups.length)
    throw new TypeError('Hard-tile replacement requires unique explicit group words')
  return writeHardTile102({ version: VERSION, unk: current.unk, blocks: groups }, limits)
}
