import { compressPortable, decompressBounded } from '@modkit/codec-kit/compression/bounded'
import { bzip2Decompress } from '@modkit/codec-kit/compression'
import { HASH_TYPE, md5, mpqDecrypt, mpqEncrypt, mpqHash } from '@modkit/codec-kit/crypto'

/**
 * A table's entry count as the game reads it. Storm sizes a table as count × 16 in 32-bit
 * arithmetic, so only the low 28 bits of the count survive; StarCraft map protectors set the high
 * bits (a 1024-entry hash table declared as 0x10000400) to break readers that do not wrap.
 */
export function mpqTableEntries(declared) {
  return (declared & 0x0fffffff) >>> 0
}

/**
 * The hash-table slots Storm probes for a name, in order: `hash & (size - 1)`, then each next slot
 * masked the same way, until an empty slot or the start again. For a power-of-two table this is a
 * plain modulo walk; a table of 1000 entries (Blizzard's own Jacobs Ladder map) needs the mask, or a
 * reader looks in slots the game never wrote.
 */
export function* mpqProbeSlots(tableHash, size) {
  if (size === 0) return
  const mask = size - 1
  const start = (tableHash & mask) >>> 0
  let slot = start
  for (let step = 0; step < size; step += 1) {
    yield slot
    slot = ((slot + 1) & mask) >>> 0
    if (slot === start) return
  }
}

const HEADER_BYTES_V0 = 32
const HEADER_BYTES_V1 = 44
/** Header size by format version: 0 (classic), 1 (high offsets), 2 (HET/BET), 3 (sizes and MD5s). */
const HEADER_BYTES = [HEADER_BYTES_V0, HEADER_BYTES_V1, 0x44, 0xd0]
/** Version 3: where the MD5 of each table and of the header itself sit, from the header start. */
const MD5_BLOCK_TABLE = 0x70
const MD5_BET_TABLE = 0xa0
const MD5_HEADER = 0xc0
const EXT_TABLE_HEADER_BYTES = 12
const BET_HEADER_DWORDS = 19
const HASH_ENTRY_BYTES = 16
const BLOCK_ENTRY_BYTES = 16
const EMPTY_BLOCK = 0xffffffff
const DELETED_BLOCK = 0xfffffffe
const FILE_IMPLODE = 0x00000100
const FILE_COMPRESS = 0x00000200
const FILE_ENCRYPTED = 0x00010000
const FILE_PATCH = 0x00100000
const FILE_SINGLE_UNIT = 0x01000000
const FILE_SECTOR_CRC = 0x04000000
const FILE_EXISTS = 0x80000000

export const MPQ_NATIVE_PRESERVING_UNSUPPORTED =
  'blizzard/mpq-native-preserving-feature-unsupported'

const error = (code, message) => Object.freeze({ severity: 'error', code, message })

const signalList = signals =>
  (Array.isArray(signals) ? signals : [signals]).filter(
    signal => signal !== undefined && signal !== null,
  )

const abort = signals => {
  for (const signal of signalList(signals)) {
    if (signal.aborted) throw new DOMException('operation cancelled', 'AbortError')
  }
}

const cancellationCheckpoint = async signals => {
  abort(signals)
  if (signalList(signals).length === 0) return
  await new Promise(resolve => setTimeout(resolve, 0))
  abort(signals)
}

const streamSignal = signals => {
  const present = signalList(signals)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return typeof globalThis.AbortSignal?.any === 'function'
    ? globalThis.AbortSignal.any(present)
    : undefined
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function codedTypeError(code, message) {
  const result = new TypeError(message)
  Object.defineProperty(result, 'code', { value: code, enumerable: true })
  return result
}

function unsupported(message) {
  return codedTypeError(MPQ_NATIVE_PRESERVING_UNSUPPORTED, message)
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(bytes, offset) {
  return viewOf(bytes).getUint16(offset, true)
}

function u32(bytes, offset) {
  return viewOf(bytes).getUint32(offset, true)
}

function magic(bytes, offset = 0) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return ''
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function checkedSlice(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength ||
    length > bytes.byteLength - offset
  ) {
    throw new RangeError(`MPQ ${label} is outside the archive`)
  }
  return bytes.slice(offset, offset + length)
}

function portablePath(path, label = 'MPQ entry') {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.length > 1_024
  ) {
    throw new TypeError(`${label} path «${String(path)}» is not a portable relative path`)
  }
  const normalized = path.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} path «${path}» contains an empty or traversal segment`)
  }
  return normalized
}

function archiveNameOf(value) {
  const path = portablePath(value, 'MPQ Save As')
  if (path.includes('/') || /[<>:"|?*]/u.test(path) || !/^[\x20-\x7e]+$/u.test(path)) {
    throw new TypeError('MPQ Save As name must be one portable ASCII file inside the target')
  }
  return path
}

const mpqPathHash = (input, type) => mpqHash(input.replaceAll('/', '\\'), type)

/**
 * The hash and block tables through the one MPQ table cipher (codec-kit). A table is whole dwords;
 * an odd tail is a broken archive, not bytes to pass through. The cipher is one short synchronous
 * pass, so cancellation is checked around it rather than inside (owner's decision, 02.10).
 */
const tableCipher = cipher => (data, key, signals) => {
  abort(signals)
  if (data.byteLength % 4 !== 0) throw new TypeError('MPQ table is not word aligned')
  return cipher(data, key >>> 0)
}
const decryptTable = tableCipher(mpqDecrypt)
const encryptTable = tableCipher(mpqEncrypt)

/**
 * A HET/BET body through the same cipher: Storm encrypts its whole dwords and leaves a tail of
 * one to three bytes as stored.
 */
const extCipher = cipher => (data, key) => {
  const out = data.slice()
  const aligned = data.byteLength & ~3
  out.set(cipher(data.subarray(0, aligned), key >>> 0), 0)
  return out
}
const decryptExt = extCipher(mpqDecrypt)
const encryptExt = extCipher(mpqEncrypt)

/** Version 3 follows a file's stored bytes (and each HET/BET table) with the MD5 of each raw chunk. */
const rawChunkDigestBytes = (size, rawChunkSize) =>
  rawChunkSize === 0 ? 0 : Math.ceil(size / rawChunkSize) * 16

function rawChunkDigests(stored, rawChunkSize) {
  const out = new Uint8Array(rawChunkDigestBytes(stored.byteLength, rawChunkSize))
  if (rawChunkSize === 0) return out
  for (let at = 0, slot = 0; at < stored.byteLength; at += rawChunkSize, slot += 16)
    out.set(md5(stored.subarray(at, Math.min(stored.byteLength, at + rawChunkSize))), slot)
  return out
}

/** BET packs each file's fields as little-endian bit runs. */
function readBits(bytes, start, count) {
  let value = 0
  for (let bit = count - 1; bit >= 0; bit -= 1) {
    const at = start + bit
    value = value * 2 + ((bytes[at >>> 3] >>> (at & 7)) & 1)
  }
  return value
}

function writeBits(bytes, start, count, value) {
  let rest = value
  for (let bit = 0; bit < count; bit += 1) {
    const at = start + bit
    if (rest % 2 === 1) bytes[at >>> 3] |= 1 << (at & 7)
    else bytes[at >>> 3] &= ~(1 << (at & 7))
    rest = Math.floor(rest / 2)
  }
}

/**
 * One HET or BET table as stored: its 12-byte header (signature, version 1, body size) and the
 * body that follows. Only an uncompressed table can be rewritten in its slot; a compressed one
 * (stored size below 12 + body) is named, not guessed at.
 */
function extTable(bytes, headerOffset, archiveSize, offset, declaredSize, signature, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + EXT_TABLE_HEADER_BYTES > archiveSize) {
    throw new RangeError(`MPQ ${label} table lies outside the declared archive`)
  }
  const at = headerOffset + offset
  if (magic(bytes, at) !== signature || u32(bytes, at + 4) !== 1) {
    throw unsupported(`MPQ ${label} table has an unknown signature or version`)
  }
  const bodySize = u32(bytes, at + 8)
  const size = declaredSize ?? EXT_TABLE_HEADER_BYTES + bodySize
  if (size !== EXT_TABLE_HEADER_BYTES + bodySize) {
    throw unsupported(`compressed MPQ ${label} tables cannot be rewritten in place`)
  }
  if (offset + size > archiveSize) throw new RangeError(`MPQ ${label} table lies outside the declared archive`)
  checkedSlice(bytes, at, size, `${label} table`)
  return { offset, size, bodySize }
}

/**
 * The BET table's file records, which must say what the block table says: each file's position,
 * sizes and flags, at the same index. A writer changing a block rewrites its BET record too.
 */
function betTable(bytes, headerOffset, table, blockTable) {
  const body = decryptExt(
    bytes.subarray(headerOffset + table.offset + EXT_TABLE_HEADER_BYTES, headerOffset + table.offset + table.size),
    mpqHash('(block table)', HASH_TYPE.TABLE),
  )
  if (body.byteLength < BET_HEADER_DWORDS * 4) throw new TypeError('MPQ BET table is truncated')
  const field = index => u32(body, index * 4)
  const layout = {
    entryCount: field(1),
    entryBits: field(3),
    filePos: { start: field(4), count: field(9) },
    fileSize: { start: field(5), count: field(10) },
    cmpSize: { start: field(6), count: field(11) },
    flagIndex: { start: field(7), count: field(12) },
    flagCount: field(18),
  }
  const flagsAt = BET_HEADER_DWORDS * 4
  const tableAt = flagsAt + layout.flagCount * 4
  const tableBits = layout.entryCount * layout.entryBits
  if (
    layout.entryCount !== blockTable.length ||
    !Number.isSafeInteger(tableBits) ||
    tableAt + Math.ceil(tableBits / 8) > body.byteLength ||
    [layout.filePos, layout.fileSize, layout.cmpSize, layout.flagIndex].some(
      item => item.count > 52 || item.start + item.count > layout.entryBits,
    )
  ) {
    throw unsupported('MPQ BET table does not describe the block table')
  }
  const files = body.subarray(tableAt)
  for (const block of blockTable) {
    if ((block.flags & FILE_EXISTS) === 0) continue
    const base = block.index * layout.entryBits
    const flagIndex = readBits(files, base + layout.flagIndex.start, layout.flagIndex.count)
    if (
      readBits(files, base + layout.filePos.start, layout.filePos.count) !== block.offset ||
      readBits(files, base + layout.fileSize.start, layout.fileSize.count) !== block.size ||
      readBits(files, base + layout.cmpSize.start, layout.cmpSize.count) !== block.archivedSize ||
      flagIndex >= layout.flagCount ||
      u32(body, flagsAt + flagIndex * 4) !== block.flags
    ) {
      throw unsupported(`MPQ BET record ${block.index} disagrees with the block table`)
    }
  }
  if (field(13) !== 0) throw unsupported('MPQ BET tables with an extra per-file field are not rewritten')
  return Object.freeze({ ...table, body, tableAt, layout })
}

const bitLength = value => {
  let bits = 0
  for (let rest = value; rest >= 1; rest = Math.floor(rest / 2)) bits += 1
  return bits
}

/**
 * The BET table for these file records (position, sizes and flag index per block), as stored:
 * header, then the body encrypted. A field keeps its width unless a value needs more; the flags
 * and the name-hash part are copied as they were.
 */
function encodeBet(bet, records) {
  const { layout, body, tableAt } = bet
  const names = ['filePos', 'fileSize', 'cmpSize', 'flagIndex']
  const widths = Object.fromEntries(
    names.map(name => [name, Math.max(layout[name].count, bitLength(Math.max(0, ...records.map(record => record[name]))))]),
  )
  const order = [...names].sort((left, right) => layout[left].start - layout[right].start)
  const starts = {}
  let entryBits = 0
  for (const name of order) {
    starts[name] = entryBits
    entryBits += widths[name]
  }
  const tail = body.subarray(tableAt + Math.ceil((layout.entryCount * layout.entryBits) / 8))
  const fileTableBytes = Math.ceil((layout.entryCount * entryBits) / 8)
  const next = new Uint8Array(tableAt + fileTableBytes + tail.byteLength)
  next.set(body.subarray(0, tableAt))
  next.set(tail, tableAt + fileTableBytes)
  const view = viewOf(next)
  view.setUint32(0, next.byteLength, true)
  view.setUint32(12, entryBits, true)
  names.forEach(name => {
    const slot = { filePos: 0, fileSize: 1, cmpSize: 2, flagIndex: 3 }[name]
    view.setUint32(16 + slot * 4, starts[name], true)
    view.setUint32(36 + slot * 4, widths[name], true)
  })
  view.setUint32(32, entryBits, true)
  const files = next.subarray(tableAt)
  records.forEach((record, index) => {
    for (const name of names) writeBits(files, index * entryBits + starts[name], widths[name], record[name])
  })
  const stored = new Uint8Array(EXT_TABLE_HEADER_BYTES + next.byteLength)
  stored.set(new TextEncoder().encode('BET\u001a'))
  viewOf(stored).setUint32(4, 1, true)
  viewOf(stored).setUint32(8, next.byteLength, true)
  stored.set(encryptExt(next, mpqHash('(block table)', HASH_TYPE.TABLE)), EXT_TABLE_HEADER_BYTES)
  return stored
}

/** The BET records of a parsed archive, by block index. */
function betRecords(bet) {
  const { layout } = bet
  const files = bet.body.subarray(bet.tableAt)
  return Array.from({ length: layout.entryCount }, (_, index) => {
    const base = index * layout.entryBits
    return {
      filePos: readBits(files, base + layout.filePos.start, layout.filePos.count),
      fileSize: readBits(files, base + layout.fileSize.start, layout.fileSize.count),
      cmpSize: readBits(files, base + layout.cmpSize.start, layout.cmpSize.count),
      flagIndex: readBits(files, base + layout.flagIndex.start, layout.flagIndex.count),
    }
  })
}

async function parseArchive(bytes, maxBlocks, signals) {
  abort(signals)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES_V0) {
    throw new TypeError('native MPQ source is truncated')
  }
  let headerOffset = 0
  let userDataBytes = 0
  if (magic(bytes) === 'MPQ\u001b') {
    if (bytes.byteLength < 16) throw new TypeError('MPQ user-data header is truncated')
    userDataBytes = u32(bytes, 4)
    headerOffset = u32(bytes, 8)
    if (headerOffset < 16 || headerOffset > bytes.byteLength - HEADER_BYTES_V0) {
      throw new RangeError('MPQ user-data header points outside the source')
    }
  }
  if (magic(bytes, headerOffset) !== 'MPQ\u001a') throw new TypeError('MPQ magic is missing')
  checkedSlice(bytes, headerOffset, HEADER_BYTES_V0, 'base header')
  const version = u16(bytes, headerOffset + 12)
  if (version >= HEADER_BYTES.length) {
    throw unsupported(`MPQ version ${version} preserving replacement is not implemented`)
  }
  const headerSize = u32(bytes, headerOffset + 4)
  const minimumHeader = HEADER_BYTES[version]
  if (headerSize < minimumHeader) throw new TypeError('MPQ header size is invalid')
  checkedSlice(bytes, headerOffset, headerSize, 'complete header')
  const archiveSize = u32(bytes, headerOffset + 8)
  if (archiveSize < headerSize || archiveSize > bytes.byteLength - headerOffset) {
    throw new RangeError('MPQ declared archive size is outside the source')
  }
  let hashHigh = 0
  let blockHigh = 0
  let extendedBlockOffset = 0n
  if (version > 0) {
    extendedBlockOffset = viewOf(bytes).getBigUint64(headerOffset + 32, true)
    hashHigh = u16(bytes, headerOffset + 40)
    blockHigh = u16(bytes, headerOffset + 42)
    if (extendedBlockOffset !== 0n || hashHigh !== 0 || blockHigh !== 0) {
      throw unsupported('MPQ high-offset and extended block tables remain a named remainder')
    }
  }
  // Versions 2 and 3 (StarCraft II maps and mods) add a 64-bit archive size, HET/BET tables and,
  // in 3, the stored size and MD5 of each table and raw-chunk MD5s after every file.
  const header64 = at => {
    const value = viewOf(bytes).getBigUint64(headerOffset + at, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('MPQ 64-bit header field is out of range')
    return Number(value)
  }
  let rawChunkSize = 0
  let hetLocation
  let betLocation
  if (version >= 2) {
    if (header64(0x2c) !== archiveSize) {
      throw unsupported('MPQ archives whose 64-bit size differs from the 32-bit one are not rewritten')
    }
    const betOffset = header64(0x34)
    const hetOffset = header64(0x3c)
    let hetSize
    let betSize
    if (version >= 3) {
      if (header64(0x54) !== 0) {
        throw unsupported('MPQ high-offset and extended block tables remain a named remainder')
      }
      hetSize = header64(0x5c)
      betSize = header64(0x64)
      rawChunkSize = u32(bytes, headerOffset + 0x6c)
    }
    if (hetOffset !== 0) hetLocation = { offset: hetOffset, size: hetSize }
    if (betOffset !== 0) betLocation = { offset: betOffset, size: betSize }
  }
  const sectorShift = u16(bytes, headerOffset + 14)
  if (sectorShift > 20) throw unsupported('MPQ sector shifts above 20 are not supported')
  const hashOffset = u32(bytes, headerOffset + 16)
  const blockOffset = u32(bytes, headerOffset + 20)
  const hashEntries = mpqTableEntries(u32(bytes, headerOffset + 24))
  const blockEntries = mpqTableEntries(u32(bytes, headerOffset + 28))
  if (
    !Number.isSafeInteger(maxBlocks) ||
    maxBlocks <= 0 ||
    hashEntries > maxBlocks * 4 ||
    blockEntries > maxBlocks
  ) {
    throw new RangeError('MPQ tables exceed the preserving-writer block budget')
  }
  const hashBytes = hashEntries * HASH_ENTRY_BYTES
  const blockBytes = blockEntries * BLOCK_ENTRY_BYTES
  if (!Number.isSafeInteger(hashBytes) || !Number.isSafeInteger(blockBytes)) {
    throw new RangeError('MPQ table size overflows')
  }
  if (version >= 3 && (header64(0x44) !== hashBytes || header64(0x4c) !== blockBytes)) {
    throw unsupported('compressed MPQ hash or block tables cannot be rewritten in place')
  }
  if (
    hashOffset < headerSize ||
    blockOffset < headerSize ||
    hashOffset + hashBytes > archiveSize ||
    blockOffset + blockBytes > archiveSize
  ) {
    throw new RangeError('MPQ table lies outside the declared archive')
  }
  const hashCipher = checkedSlice(bytes, headerOffset + hashOffset, hashBytes, 'hash table')
  const blockCipher = checkedSlice(bytes, headerOffset + blockOffset, blockBytes, 'block table')
  const hashPlain = await decryptTable(hashCipher, mpqHash('(hash table)', HASH_TYPE.TABLE), signals)
  abort(signals)
  const blockPlain = await decryptTable(blockCipher, mpqHash('(block table)', HASH_TYPE.TABLE), signals)
  abort(signals)
  const hashTable = []
  for (let index = 0; index < hashEntries; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const offset = index * HASH_ENTRY_BYTES
    hashTable.push(
      Object.freeze({
        index,
        hashA: u32(hashPlain, offset),
        hashB: u32(hashPlain, offset + 4),
        locale: u16(hashPlain, offset + 8),
        platform: u16(hashPlain, offset + 10),
        blockIndex: u32(hashPlain, offset + 12),
      }),
    )
  }
  const blockTable = []
  const ranges = []
  for (let index = 0; index < blockEntries; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const offset = index * BLOCK_ENTRY_BYTES
    const block = Object.freeze({
      index,
      offset: u32(blockPlain, offset),
      archivedSize: u32(blockPlain, offset + 4),
      size: u32(blockPlain, offset + 8),
      flags: u32(blockPlain, offset + 12),
    })
    // An empty file stores nothing; the editor writes it at offset 0.
    if ((block.flags & FILE_EXISTS) !== 0 && (block.archivedSize !== 0 || block.size !== 0)) {
      // A version 3 file's slot ends after the MD5s of its raw chunks.
      const end = block.offset + block.archivedSize + rawChunkDigestBytes(block.archivedSize, rawChunkSize)
      if (block.offset < headerSize || end > archiveSize) {
        throw new RangeError(`MPQ block ${index} lies outside the declared archive`)
      }
      ranges.push({ start: block.offset, end, label: `block ${index}` })
    }
    blockTable.push(block)
  }
  ranges.push({ start: hashOffset, end: hashOffset + hashBytes, label: 'hash table' })
  ranges.push({ start: blockOffset, end: blockOffset + blockBytes, label: 'block table' })
  const het =
    hetLocation === undefined
      ? undefined
      : extTable(bytes, headerOffset, archiveSize, hetLocation.offset, hetLocation.size, 'HET\u001a', 'HET')
  const bet =
    betLocation === undefined
      ? undefined
      : betTable(
          bytes,
          headerOffset,
          extTable(bytes, headerOffset, archiveSize, betLocation.offset, betLocation.size, 'BET\u001a', 'BET'),
          blockTable,
        )
  for (const [table, label] of [[het, 'HET table'], [bet, 'BET table']]) {
    if (table === undefined) continue
    const end = table.offset + table.size + rawChunkDigestBytes(table.size, rawChunkSize)
    if (end > archiveSize) throw new RangeError(`MPQ ${label} lies outside the declared archive`)
    ranges.push({ start: table.offset, end, label })
  }
  await cancellationCheckpoint(signals)
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  await cancellationCheckpoint(signals)
  for (let index = 1; index < ranges.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const previous = ranges[index - 1]
    const current = ranges[index]
    if (
      previous.end > current.start &&
      previous.end !== previous.start &&
      current.end !== current.start
    ) {
      throw unsupported(
        `overlapping ${previous.label} and ${current.label} cannot be preserved safely`,
      )
    }
  }
  abort(signals)
  return Object.freeze({
    bytes,
    header: Object.freeze({
      offset: headerOffset,
      userDataBytes,
      headerSize,
      archiveSize,
      version,
      sectorShift,
      hashOffset,
      blockOffset,
      hashEntries,
      blockEntries,
      extendedBlockOffset,
      hashHigh,
      blockHigh,
      rawChunkSize,
    }),
    het,
    bet,
    hashCipher,
    blockCipher,
    hashPlain,
    blockPlain,
    hashTable: Object.freeze(hashTable),
    blockTable: Object.freeze(blockTable),
  })
}

async function matchingBlockIndices(path, archive, signals) {
  abort(signals)
  if (archive.hashTable.length === 0) return []
  const hashA = mpqPathHash(path, HASH_TYPE.HASH_A)
  const hashB = mpqPathHash(path, HASH_TYPE.HASH_B)
  const found = new Set()
  let probe = 0
  for (const slot of mpqProbeSlots(mpqPathHash(path, HASH_TYPE.TABLE_OFFSET), archive.hashTable.length)) {
    if ((probe++ & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const entry = archive.hashTable[slot]
    if (entry.blockIndex === EMPTY_BLOCK) break
    if (entry.blockIndex === DELETED_BLOCK) continue
    const block = archive.blockTable[entry.blockIndex]
    if (
      entry.hashA === hashA &&
      entry.hashB === hashB &&
      block !== undefined &&
      (block.flags & FILE_EXISTS) !== 0
    ) {
      found.add(block.index)
    }
  }
  abort(signals)
  return [...found]
}

async function liveHashEntriesForBlock(archive, blockIndex, signals) {
  const found = []
  for (let index = 0; index < archive.hashTable.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const entry = archive.hashTable[index]
    if (
      entry.blockIndex !== EMPTY_BLOCK &&
      entry.blockIndex !== DELETED_BLOCK &&
      entry.blockIndex === blockIndex
    ) {
      found.push(entry)
      if (found.length > 1) return found
    }
  }
  abort(signals)
  return found
}

/** zlib through codec-kit's bounded owner: at most `expected` bytes ever come out. */
async function zlibDecoded(payload, expected, label, signals) {
  abort(signals)
  const signal = streamSignal(signals)
  const result = await decompressBounded(payload, 'deflate', {
    maxOutputBytes: expected,
    ...(signal === undefined ? {} : { signal }),
    outputLimitError: maximum => new RangeError(`MPQ ${label} decodes past its ${maximum}-byte size`),
  })
  abort(signals)
  return result
}

async function zlibEncoded(payload, signals) {
  abort(signals)
  const result = await compressPortable(payload, 'deflate', streamSignal(signals))
  abort(signals)
  return result
}

async function decodeCompressed(payload, expected, label, signals) {
  abort(signals)
  if (payload.byteLength === 0) throw new TypeError(`MPQ compressed ${label} is empty`)
  const method = payload[0]
  let decoded
  if (method === 0) decoded = payload.slice(1)
  else if (method === 2) decoded = await zlibDecoded(payload.slice(1), expected, label, signals)
  else if (method === 0x10) {
    // bzip2, as StarCraft II's editor stores some catalogs: read here, never rewritten.
    const signal = streamSignal(signals)
    decoded = bzip2Decompress(payload.subarray(1), { maxOutputBytes: expected, ...(signal === undefined ? {} : { signal }) })
  } else throw unsupported(`MPQ compression mask 0x${method.toString(16)} for ${label}`)
  abort(signals)
  if (decoded.byteLength !== expected) throw new TypeError(`MPQ ${label} size mismatch`)
  return Object.freeze({ bytes: decoded, method })
}

function rawBlockBytes(archive, block) {
  return checkedSlice(
    archive.bytes,
    archive.header.offset + block.offset,
    block.archivedSize,
    `block ${block.index}`,
  )
}

async function sectorLayout(archive, block, label, signals) {
  abort(signals)
  const sectorSize = 512 * 2 ** archive.header.sectorShift
  const sectorCount = Math.ceil(block.size / sectorSize)
  // A sector-CRC file has one more position: its sector checksums run from the last sector's end
  // to it. StarCraft II's editor leaves that block empty.
  const crc = (block.flags & FILE_SECTOR_CRC) !== 0
  const positionCount = sectorCount + (crc ? 2 : 1)
  const tableBytes = positionCount * 4
  const raw = rawBlockBytes(archive, block)
  if (raw.byteLength < tableBytes) throw new TypeError(`MPQ ${label} sector table is truncated`)
  const positions = []
  for (let index = 0; index < positionCount; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    positions.push(u32(raw, index * 4))
  }
  if (positions[0] < tableBytes || positions.at(-1) > raw.byteLength) {
    throw new TypeError(`MPQ ${label} sector table is invalid`)
  }
  for (let index = 1; index < positions.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    if (positions[index] < positions[index - 1]) {
      throw new TypeError(`MPQ ${label} sector offsets are not monotonic`)
    }
  }
  abort(signals)
  const checksumBytes = crc ? positions[sectorCount + 1] - positions[sectorCount] : 0
  return Object.freeze({ raw, sectorSize, sectorCount, positions, crc, checksumBytes })
}

async function readBlock(archive, block, label, signals) {
  abort(signals)
  if ((block.flags & FILE_ENCRYPTED) !== 0) throw unsupported(`encrypted entry «${label}»`)
  if ((block.flags & FILE_IMPLODE) !== 0) throw unsupported(`implode entry «${label}»`)
  if ((block.flags & FILE_PATCH) !== 0) throw unsupported(`patch entry «${label}»`)
  if (block.size === 0) return new Uint8Array(0)
  const raw = rawBlockBytes(archive, block)
  abort(signals)
  if ((block.flags & FILE_SINGLE_UNIT) !== 0) {
    if ((block.flags & FILE_COMPRESS) !== 0 && block.size > block.archivedSize) {
      const decoded = await decodeCompressed(raw, block.size, label, signals)
      abort(signals)
      return decoded.bytes
    }
    if (raw.byteLength < block.size) throw new TypeError(`MPQ ${label} is truncated`)
    return raw.slice(0, block.size)
  }
  if ((block.flags & FILE_COMPRESS) === 0) {
    if (raw.byteLength !== block.size) throw new TypeError(`MPQ ${label} size mismatch`)
    return raw
  }
  const layout = await sectorLayout(archive, block, label, signals)
  abort(signals)
  const output = new Uint8Array(block.size)
  let target = 0
  for (let index = 0; index < layout.sectorCount; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const expected = Math.min(layout.sectorSize, block.size - target)
    const sector = layout.raw.slice(layout.positions[index], layout.positions[index + 1])
    const decoded =
      sector.byteLength < expected
        ? (await decodeCompressed(sector, expected, `${label}#${index}`, signals)).bytes
        : sector
    abort(signals)
    if (decoded.byteLength !== expected) throw new TypeError(`MPQ ${label} sector size mismatch`)
    output.set(decoded, target)
    target += decoded.byteLength
  }
  abort(signals)
  return output
}

async function namesOf(archive, signals) {
  abort(signals)
  const names = new Map()
  const listIndices = await matchingBlockIndices('(listfile)', archive, signals)
  abort(signals)
  if (listIndices.length === 1) {
    try {
      const listfile = await readBlock(
        archive,
        archive.blockTable[listIndices[0]],
        '(listfile)',
        signals,
      )
      abort(signals)
      const lines = new TextDecoder('utf-8', { fatal: true }).decode(listfile).split(/\r?\n/u)
      for (let index = 0; index < lines.length; index += 1) {
        if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
        const raw = lines[index]
        const trimmed = raw.trim()
        if (trimmed === '') continue
        const path = portablePath(trimmed)
        const matches = await matchingBlockIndices(path, archive, signals)
        if (matches.length === 1) names.set(path.toLowerCase(), { path, blockIndex: matches[0] })
      }
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause
      if (cause?.code === MPQ_NATIVE_PRESERVING_UNSUPPORTED) throw cause
      throw unsupported(
        `the MPQ listfile cannot be decoded safely: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  for (const path of ['(listfile)', '(attributes)', '(signature)']) {
    abort(signals)
    const matches = await matchingBlockIndices(path, archive, signals)
    if (matches.length === 1) names.set(path, { path, blockIndex: matches[0] })
  }
  abort(signals)
  return names
}

async function distinctNamesForBlock(names, blockIndex, signals) {
  const result = new Map()
  let index = 0
  for (const named of names.values()) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    index += 1
    if (named.blockIndex !== blockIndex) continue
    const key = named.path.replaceAll('\\', '/').toLowerCase()
    if (!result.has(key)) result.set(key, named.path)
  }
  abort(signals)
  return [...result.values()].sort()
}

async function encodeByOriginalMethod(archive, block, path, replacement, signals) {
  abort(signals)
  if ((block.flags & FILE_ENCRYPTED) !== 0) {
    throw unsupported(`changed encrypted entry «${path}» requires native key handling`)
  }
  if ((block.flags & FILE_IMPLODE) !== 0) {
    throw unsupported(`changed implode entry «${path}» is not supported`)
  }
  if ((block.flags & FILE_PATCH) !== 0) {
    throw unsupported(`changed patch entry «${path}» requires patch-chain reconstruction`)
  }
  const raw = rawBlockBytes(archive, block)
  abort(signals)
  if ((block.flags & FILE_SINGLE_UNIT) !== 0) {
    if ((block.flags & FILE_COMPRESS) === 0 || block.size <= block.archivedSize) {
      return Object.freeze({ bytes: replacement.slice(), method: 'stored' })
    }
    const method = raw[0]
    if (method === 0) {
      const bytes = new Uint8Array(replacement.byteLength + 1)
      bytes[0] = 0
      bytes.set(replacement, 1)
      return Object.freeze({ bytes, method: 'compression-mask-0x00' })
    }
    if (method === 2 || method === 0x10) {
      const compressed = await zlibEncoded(replacement, signals)
      abort(signals)
      const bytes = new Uint8Array(compressed.byteLength + 1)
      bytes[0] = 2
      bytes.set(compressed, 1)
      if (bytes.byteLength >= replacement.byteLength) {
        // Stored is what a single unit holding no fewer bytes than its size reads as.
        if (method === 0x10) return Object.freeze({ bytes: replacement.slice(), method: 'stored-from-bzip2' })
        throw unsupported(
          `changed zlib entry «${path}» no longer compresses with its original method`,
        )
      }
      // No bzip2 encoder: a bzip2 entry is written with zlib, which every MPQ reader decodes.
      return Object.freeze({ bytes, method: method === 2 ? 'zlib' : 'zlib-from-bzip2' })
    }
    throw unsupported(`changed entry «${path}» uses compression mask 0x${method.toString(16)}`)
  }
  if ((block.flags & FILE_COMPRESS) === 0) {
    if ((block.flags & FILE_SECTOR_CRC) !== 0) {
      throw unsupported(`changed uncompressed sector-CRC entry «${path}» is not supported`)
    }
    return Object.freeze({ bytes: replacement.slice(), method: 'stored' })
  }
  const layout = await sectorLayout(archive, block, path, signals)
  abort(signals)
  if (layout.checksumBytes !== 0) {
    throw unsupported(`changed entry «${path}» carries sector checksums, which are not rebuilt`)
  }
  // The file's method is the one its compressed sectors use: zlib, or none (mask 0 or stored); a
  // bzip2 file is written with zlib, as there is no bzip2 encoder. The new content may hold more
  // or fewer sectors; each is stored as is when zlib does not help.
  let zlib = false
  let fromBzip2 = false
  for (let index = 0; index < layout.sectorCount; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const expected = Math.min(layout.sectorSize, block.size - index * layout.sectorSize)
    const original = layout.raw.subarray(layout.positions[index], layout.positions[index + 1])
    if (original.byteLength >= expected) continue
    if (original[0] === 2) zlib = true
    else if (original[0] === 0x10) zlib = fromBzip2 = true
    else if (original[0] !== 0) {
      throw unsupported(`changed entry «${path}» sector ${index} uses mask 0x${original[0].toString(16)}`)
    }
  }
  const sectorCount = Math.ceil(replacement.byteLength / layout.sectorSize)
  const encodedSectors = []
  for (let index = 0; index < sectorCount; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const plain = replacement.subarray(index * layout.sectorSize, (index + 1) * layout.sectorSize)
    if (!zlib) {
      encodedSectors.push(plain)
      continue
    }
    const compressed = await zlibEncoded(plain, signals)
    abort(signals)
    if (compressed.byteLength + 1 >= plain.byteLength) {
      encodedSectors.push(plain)
      continue
    }
    const encoded = new Uint8Array(compressed.byteLength + 1)
    encoded[0] = 2
    encoded.set(compressed, 1)
    encodedSectors.push(encoded)
  }
  // A sector-CRC file keeps its extra position, its (empty) checksum block ending where it starts.
  const positionCount = sectorCount + (layout.crc ? 2 : 1)
  const tableBytes = positionCount * 4
  let total = tableBytes
  for (let index = 0; index < encodedSectors.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    total += encodedSectors[index].byteLength
  }
  const encoded = new Uint8Array(total)
  const encodedView = viewOf(encoded)
  let cursor = tableBytes
  encodedView.setUint32(0, cursor, true)
  for (let index = 0; index < encodedSectors.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const sector = encodedSectors[index]
    encoded.set(sector, cursor)
    cursor += sector.byteLength
    encodedView.setUint32((index + 1) * 4, cursor, true)
  }
  if (layout.crc) encodedView.setUint32(positionCount * 4 - 4, cursor, true)
  abort(signals)
  return Object.freeze({ bytes: encoded, method: fromBzip2 ? 'sector-zlib-from-bzip2' : 'sector-methods-preserved' })
}

async function bytesEqual(left, right, signals) {
  abort(signals)
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if ((index & 0x0fffff) === 0) await cancellationCheckpoint(signals)
    if (left[index] !== right[index]) return false
  }
  abort(signals)
  return true
}

async function digest(bytes, signals) {
  abort(signals)
  if (globalThis.crypto?.subtle === undefined) {
    throw unsupported('SHA-256 is unavailable in this runtime')
  }
  const value = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  abort(signals)
  return `sha256:${[...value].map(item => item.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Read a bounded, revision-independent snapshot of every listfile-named MPQ entry.
 *
 * This is deliberately narrower than a generic archive API. It exists so semantic editors can
 * inspect the exact documents they intend to replace while using the same parser, decompressor,
 * path rules and cancellation checkpoints as the native-preserving writer. Callers that want to
 * rebuild a fresh archive must require `completeNamedSnapshot`, an empty `opaqueInternalPaths`,
 * and an empty `aliasedBlocks`; otherwise native data would be omitted or duplicated.
 */
export async function readNativeMpqSnapshot(options) {
  const {
    sourceBytes,
    signal,
    includeBasenames,
    maxArchiveBytes = 67_108_864,
    maxBlocks = 16_384,
    maxEntries = 4_096,
    maxEntryBytes = 16_777_216,
    maxTotalBytes = 67_108_864,
  } = options ?? {}
  abort(signal)
  if (!(sourceBytes instanceof Uint8Array)) throw new TypeError('native MPQ source has no bytes')
  for (const [name, value] of Object.entries({
    maxArchiveBytes,
    maxBlocks,
    maxEntries,
    maxEntryBytes,
    maxTotalBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (
    maxArchiveBytes > 1_073_741_824 ||
    maxBlocks > 1_000_000 ||
    maxEntries > 1_000_000 ||
    maxEntryBytes > 1_073_741_824 ||
    maxTotalBytes > 1_073_741_824
  ) {
    throw new RangeError('native MPQ snapshot limits exceed the hard safety ceiling')
  }
  if (sourceBytes.byteLength > maxArchiveBytes) {
    throw new RangeError('native MPQ source exceeds maxArchiveBytes')
  }
  let selectedBasenames
  if (includeBasenames !== undefined) {
    if (!Array.isArray(includeBasenames) || includeBasenames.length === 0) {
      throw new TypeError('includeBasenames must be a non-empty string array')
    }
    selectedBasenames = new Set()
    for (const candidate of includeBasenames) {
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.includes('/') ||
        candidate.includes('\\') ||
        candidate.includes('\0')
      ) {
        throw new TypeError(`invalid MPQ snapshot basename «${String(candidate)}»`)
      }
      selectedBasenames.add(candidate.toLowerCase())
    }
  }

  const archive = await parseArchive(sourceBytes, maxBlocks, signal)
  abort(signal)
  const names = await namesOf(archive, signal)
  abort(signal)
  const internal = new Set(['(listfile)', '(attributes)', '(signature)'])
  const activeBlocks = archive.blockTable.filter(block => (block.flags & FILE_EXISTS) !== 0)
  const namedBlocks = new Map()
  const opaqueInternalPaths = []
  for (const named of names.values()) {
    const paths = namedBlocks.get(named.blockIndex) ?? []
    paths.push(named.path)
    namedBlocks.set(named.blockIndex, paths)
    if (internal.has(named.path.toLowerCase()) && named.path.toLowerCase() !== '(listfile)') {
      opaqueInternalPaths.push(named.path)
    }
  }
  const aliasedBlocks = [...namedBlocks]
    .filter(([, paths]) => paths.length > 1)
    .map(([blockIndex, paths]) =>
      Object.freeze({ blockIndex, paths: Object.freeze([...paths].sort()) }),
    )
  const unnamedBlocks = activeBlocks.filter(block => !namedBlocks.has(block.index)).length
  const entries = []
  let totalBytes = 0
  let index = 0
  for (const named of [...names.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    index += 1
    const foldedPath = named.path.toLowerCase()
    if (internal.has(foldedPath)) continue
    const basename = named.path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
    if (selectedBasenames !== undefined && !selectedBasenames.has(basename)) continue
    if (entries.length >= maxEntries) throw new RangeError('native MPQ snapshot exceeds maxEntries')
    const block = archive.blockTable[named.blockIndex]
    if (block === undefined) throw new TypeError(`MPQ named block is missing: ${named.path}`)
    if (block.size > maxEntryBytes) {
      throw new RangeError(`native MPQ entry «${named.path}» exceeds maxEntryBytes`)
    }
    const bytes = await readBlock(archive, block, named.path, signal)
    abort(signal)
    totalBytes += bytes.byteLength
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new RangeError('native MPQ snapshot exceeds maxTotalBytes')
    }
    entries.push(
      Object.freeze({
        path: named.path,
        bytes,
        blockIndex: block.index,
        flags: `0x${block.flags.toString(16).padStart(8, '0')}`,
        method: methodLabel(archive, block),
      }),
    )
  }
  abort(signal)
  return Object.freeze({
    schemaVersion: 1,
    kind: 'mpq-native-named-snapshot-v1',
    sourceArchiveDigest: await digest(sourceBytes, signal),
    archiveVersion: archive.header.version,
    archiveBytes: sourceBytes.byteLength,
    activeBlocks: activeBlocks.length,
    namedBlocks: namedBlocks.size,
    unnamedBlocks,
    completeNamedSnapshot: unnamedBlocks === 0,
    opaqueInternalPaths: Object.freeze([...opaqueInternalPaths].sort()),
    aliasedBlocks: Object.freeze(aliasedBlocks),
    filtered: selectedBasenames !== undefined,
    entries: Object.freeze(entries),
  })
}

function methodLabel(archive, block) {
  if ((block.flags & FILE_ENCRYPTED) !== 0) return 'encrypted-opaque'
  if ((block.flags & FILE_PATCH) !== 0) return 'patch-opaque'
  if ((block.flags & FILE_IMPLODE) !== 0) return 'implode-opaque'
  if ((block.flags & FILE_COMPRESS) === 0) return 'stored'
  if ((block.flags & FILE_SINGLE_UNIT) === 0) return 'sector-compressed-opaque'
  if (block.size <= block.archivedSize) return 'stored-with-compress-flag'
  const raw = rawBlockBytes(archive, block)
  return raw[0] === 2 ? 'zlib' : `compression-mask-0x${(raw[0] ?? 0).toString(16)}`
}

/**
 * Build a fixed-slot native-preserving replacement. The complete source archive remains immutable;
 * callers commit the returned bytes as a separate file through the durable writer coordinator.
 */
export async function encodeNativePreservingMpq(options) {
  const {
    sourceBytes,
    replacements,
    signal,
    maxArchiveBytes = 67_108_864,
    maxBlocks = 16_384,
    maxReplacementBytes = 16_777_216,
  } = options
  abort(signal)
  if (!(sourceBytes instanceof Uint8Array)) throw new TypeError('native MPQ source has no bytes')
  for (const [name, value] of Object.entries({
    maxArchiveBytes,
    maxBlocks,
    maxReplacementBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }
  }
  if (maxArchiveBytes > 1_073_741_824 || maxBlocks > 1_000_000) {
    throw new RangeError('native MPQ preserving-writer limits exceed the hard safety ceiling')
  }
  if (sourceBytes.byteLength > maxArchiveBytes) {
    throw new RangeError('native MPQ source exceeds maxArchiveBytes')
  }
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new TypeError('native MPQ preserving replacement requires at least one changed entry')
  }
  const source = await parseArchive(sourceBytes, maxBlocks, signal)
  abort(signal)
  const names = await namesOf(source, signal)
  abort(signal)
  const normalized = []
  const folded = new Set()
  let replacementBytes = 0
  for (let index = 0; index < replacements.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const candidate = replacements[index]
    const item = record(candidate)
    const path = portablePath(item?.path)
    const key = path.toLowerCase()
    if (folded.has(key)) throw new TypeError(`duplicate changed MPQ path «${path}»`)
    if (key === '(listfile)' || key === '(attributes)' || key === '(signature)') {
      throw unsupported(`${path} is an opaque native record and cannot be changed by this writer`)
    }
    if (!(item?.bytes instanceof Uint8Array)) {
      throw new TypeError(`changed MPQ entry «${path}» has no bytes`)
    }
    replacementBytes += item.bytes.byteLength
    if (item.bytes.byteLength > maxReplacementBytes || replacementBytes > maxArchiveBytes) {
      throw new RangeError('native MPQ replacements exceed the byte budget')
    }
    const named = names.get(key)
    if (named === undefined) {
      if ((await matchingBlockIndices(path, source, signal)).length > 0) {
        throw unsupported(`MPQ entry «${path}» is ambiguous and cannot be changed safely`)
      }
      throw new TypeError(`MPQ listfile does not name changed entry «${path}»`)
    }
    const hashReferences = await liveHashEntriesForBlock(source, named.blockIndex, signal)
    if (hashReferences.length > 1) {
      throw unsupported(
        `MPQ block ${named.blockIndex} is referenced by multiple live hash-table entries`,
      )
    }
    const blockNames = await distinctNamesForBlock(names, named.blockIndex, signal)
    if (blockNames.length !== 1) {
      throw unsupported(
        `MPQ block ${named.blockIndex} is associated with multiple distinct names: ${blockNames.join(', ')}`,
      )
    }
    folded.add(key)
    normalized.push(
      Object.freeze({ path: named.path, bytes: item.bytes.slice(), blockIndex: named.blockIndex }),
    )
  }

  await cancellationCheckpoint(signal)
  let output = sourceBytes.slice()
  abort(signal)
  const nextBlockPlain = source.blockPlain.slice()
  abort(signal)
  const changed = []
  const changedBlocks = new Set()
  const rawChunkSize = source.header.rawChunkSize
  // An entry that outgrows its slot moves to where the tables began, and the tables follow it;
  // its old slot is zeroed. Every other byte keeps its place.
  const relocations = []
  for (let index = 0; index < normalized.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const replacement = normalized[index]
    if (changedBlocks.has(replacement.blockIndex)) {
      throw unsupported(
        `multiple listfile aliases resolve to changed MPQ block ${replacement.blockIndex}`,
      )
    }
    const block = source.blockTable[replacement.blockIndex]
    const originalDecoded = await readBlock(source, block, replacement.path, signal)
    abort(signal)
    if (await bytesEqual(originalDecoded, replacement.bytes, signal)) {
      throw new TypeError(`changed MPQ entry «${replacement.path}» is byte-identical to its source`)
    }
    const encoded = await encodeByOriginalMethod(
      source,
      block,
      replacement.path,
      replacement.bytes,
      signal,
    )
    abort(signal)
    const payloadStart = source.header.offset + block.offset
    const slotBytes = block.archivedSize + rawChunkDigestBytes(block.archivedSize, rawChunkSize)
    // Fewer or as many stored bytes need no more chunk MD5s than the slot held.
    const digests = rawChunkDigests(encoded.bytes, rawChunkSize)
    const relocated = encoded.bytes.byteLength > block.archivedSize
    output.fill(0, payloadStart, payloadStart + slotBytes)
    const offset = block.offset
    if (relocated) relocations.push({ blockIndex: block.index, parts: [encoded.bytes, digests] })
    else {
      output.set(encoded.bytes, payloadStart)
      output.set(digests, payloadStart + encoded.bytes.byteLength)
    }
    abort(signal)
    const entryOffset = block.index * BLOCK_ENTRY_BYTES
    const blockView = viewOf(nextBlockPlain)
    blockView.setUint32(entryOffset + 4, encoded.bytes.byteLength, true)
    blockView.setUint32(entryOffset + 8, replacement.bytes.byteLength, true)
    changedBlocks.add(block.index)
    changed.push(
      {
        path: replacement.path,
        blockIndex: block.index,
        flags: `0x${block.flags.toString(16).padStart(8, '0')}`,
        method: encoded.method,
        sourceBytes: block.size,
        outputBytes: replacement.bytes.byteLength,
        sourceArchivedBytes: block.archivedSize,
        outputArchivedBytes: encoded.bytes.byteLength,
        relocated,
        outputOffset: offset,
        zeroFilledSlackBytes: relocated ? slotBytes : block.archivedSize - encoded.bytes.byteLength,
      },
    )
  }
  const header = source.header
  const at = offset => header.offset + offset
  // The BET records as they now read; a field widens only when a value no longer fits.
  const records = source.bet === undefined ? undefined : betRecords(source.bet)
  const nextBetOf = () => {
    if (records === undefined) return undefined
    for (const item of changed) {
      const record = records[item.blockIndex]
      record.filePos = item.outputOffset
      record.fileSize = item.outputBytes
      record.cmpSize = item.outputArchivedBytes
    }
    return encodeBet(source.bet, records)
  }
  let nextBet = nextBetOf()
  let blockCipher
  let tablesStart
  let outputArchiveSize = header.archiveSize
  if (relocations.length > 0 || (nextBet !== undefined && nextBet.byteLength !== source.bet.size)) {
    // The tables sit together at the archive's end, after every file: relocated entries take their
    // place and the tables follow, each HET/BET with its chunk MD5s.
    const tables = [
      { name: 'hash', offset: header.hashOffset, size: header.hashEntries * HASH_ENTRY_BYTES, trailer: 0 },
      { name: 'block', offset: header.blockOffset, size: header.blockEntries * BLOCK_ENTRY_BYTES, trailer: 0 },
      ...[['het', source.het], ['bet', source.bet]]
        .filter(([, table]) => table !== undefined)
        .map(([name, table]) => ({
          name,
          offset: table.offset,
          size: table.size,
          trailer: rawChunkDigestBytes(table.size, rawChunkSize),
        })),
    ].sort((left, right) => left.offset - right.offset)
    tablesStart = tables[0].offset
    let cursor = tablesStart
    for (const table of tables) {
      if (table.offset !== cursor) {
        throw unsupported('MPQ tables are not contiguous, so relocated entries cannot take their place')
      }
      cursor += table.size + table.trailer
    }
    if (cursor !== header.archiveSize) {
      throw unsupported('MPQ data follows its tables, so relocated entries cannot take their place')
    }
    for (const block of source.blockTable) {
      if ((block.flags & FILE_EXISTS) === 0 || (block.archivedSize === 0 && block.size === 0)) continue
      if (block.offset + block.archivedSize + rawChunkDigestBytes(block.archivedSize, rawChunkSize) > tablesStart) {
        throw unsupported('MPQ file data lies among its tables, so relocated entries cannot take their place')
      }
    }
    const parts = []
    let next = tablesStart
    const blockView = viewOf(nextBlockPlain)
    for (const relocation of relocations) {
      changed.find(entry => entry.blockIndex === relocation.blockIndex).outputOffset = next
      blockView.setUint32(relocation.blockIndex * BLOCK_ENTRY_BYTES, next, true)
      for (const part of relocation.parts) {
        parts.push(part)
        next += part.byteLength
      }
    }
    nextBet = nextBetOf()
    blockCipher = await encryptTable(nextBlockPlain, mpqHash('(block table)', HASH_TYPE.TABLE), signal)
    const placed = {}
    for (const table of tables) {
      const bytes =
        table.name === 'hash'
          ? source.hashCipher
          : table.name === 'block'
            ? blockCipher
            : table.name === 'het'
              ? sourceBytes.subarray(at(table.offset), at(table.offset + table.size))
              : nextBet
      placed[table.name] = next
      parts.push(bytes)
      next += bytes.byteLength
      if (table.trailer !== 0) {
        const trailer = rawChunkDigests(bytes, rawChunkSize)
        parts.push(trailer)
        next += trailer.byteLength
      }
    }
    outputArchiveSize = next
    if (
      outputArchiveSize > 0xffffffff ||
      sourceBytes.byteLength - header.archiveSize + outputArchiveSize > maxArchiveBytes
    ) {
      throw unsupported('relocated MPQ entries would grow the archive past its limit')
    }
    const grown = new Uint8Array(sourceBytes.byteLength - header.archiveSize + outputArchiveSize)
    grown.set(output.subarray(0, at(tablesStart)))
    let write = at(tablesStart)
    for (const part of parts) {
      grown.set(part, write)
      write += part.byteLength
    }
    grown.set(output.subarray(at(header.archiveSize)), write)
    output = grown
    const view = viewOf(output)
    view.setUint32(at(8), outputArchiveSize, true)
    view.setUint32(at(16), placed.hash, true)
    view.setUint32(at(20), placed.block, true)
    if (header.version >= 2) {
      view.setBigUint64(at(0x2c), BigInt(outputArchiveSize), true)
      if (placed.bet !== undefined) view.setBigUint64(at(0x34), BigInt(placed.bet), true)
      if (placed.het !== undefined) view.setBigUint64(at(0x3c), BigInt(placed.het), true)
    }
    if (header.version >= 3 && placed.bet !== undefined) {
      view.setBigUint64(at(0x64), BigInt(nextBet.byteLength), true)
    }
  } else {
    // In place: the block table, and the BET records in their slot.
    blockCipher = await encryptTable(nextBlockPlain, mpqHash('(block table)', HASH_TYPE.TABLE), signal)
    output.set(blockCipher, at(header.blockOffset))
    if (nextBet !== undefined) {
      output.set(nextBet, at(source.bet.offset))
      output.set(rawChunkDigests(nextBet, rawChunkSize), at(source.bet.offset + source.bet.size))
    }
  }
  for (const item of changed) Object.freeze(item)
  abort(signal)
  // Version 3 keeps an MD5 of the block table, of the BET table and of the header; an MD5 the
  // source left empty stays empty.
  const headerMd5 = (offset, bytes) => {
    const slot = output.subarray(at(offset), at(offset) + 16)
    if (slot.some(byte => byte !== 0)) slot.set(md5(bytes))
  }
  if (header.version >= 3) {
    headerMd5(MD5_BLOCK_TABLE, blockCipher)
    if (nextBet !== undefined) headerMd5(MD5_BET_TABLE, nextBet)
    headerMd5(MD5_HEADER, output.subarray(at(0), at(MD5_HEADER)))
  }
  abort(signal)

  const reopened = await parseArchive(output, maxBlocks, signal)
  abort(signal)
  if (!(await bytesEqual(source.hashCipher, reopened.hashCipher, signal))) {
    throw new TypeError('native MPQ verification found hash-table drift')
  }
  if (
    source.blockTable.length !== reopened.blockTable.length ||
    source.header.version !== reopened.header.version ||
    source.header.headerSize !== reopened.header.headerSize ||
    reopened.header.archiveSize !== outputArchiveSize
  ) {
    throw new TypeError('native MPQ verification found archive metadata drift')
  }
  for (let index = 0; index < source.blockTable.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const sourceBlock = source.blockTable[index]
    const outputBlock = reopened.blockTable[sourceBlock.index]
    const relocation = changed.find(item => item.blockIndex === sourceBlock.index && item.relocated)
    if (
      outputBlock.offset !== (relocation?.outputOffset ?? sourceBlock.offset) ||
      outputBlock.flags !== sourceBlock.flags ||
      (!changedBlocks.has(sourceBlock.index) &&
        (outputBlock.archivedSize !== sourceBlock.archivedSize ||
          outputBlock.size !== sourceBlock.size))
    ) {
      throw new TypeError(`native MPQ verification found block-table drift at ${sourceBlock.index}`)
    }
    if (
      !changedBlocks.has(sourceBlock.index) &&
      (sourceBlock.flags & FILE_EXISTS) !== 0 &&
      !(await bytesEqual(
        rawBlockBytes(source, sourceBlock),
        rawBlockBytes(reopened, outputBlock),
        signal,
      ))
    ) {
      throw new TypeError(
        `native MPQ verification found untouched payload drift at ${sourceBlock.index}`,
      )
    }
  }
  for (let index = 0; index < normalized.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const replacement = normalized[index]
    const block = reopened.blockTable[replacement.blockIndex]
    const decoded = await readBlock(reopened, block, replacement.path, signal)
    abort(signal)
    if (!(await bytesEqual(decoded, replacement.bytes, signal))) {
      throw new TypeError(
        `native MPQ verification could not reopen changed entry «${replacement.path}»`,
      )
    }
  }
  if (
    !(await bytesEqual(
      sourceBytes.slice(0, source.header.offset),
      output.slice(0, reopened.header.offset),
      signal,
    )) ||
    !(await bytesEqual(
      sourceBytes.slice(source.header.offset + source.header.archiveSize),
      output.slice(reopened.header.offset + reopened.header.archiveSize),
      signal,
    ))
  ) {
    throw new TypeError('native MPQ verification found opaque prefix/suffix drift')
  }
  const rewrittenRegions = []
  for (let index = 0; index < normalized.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const sourceBlock = source.blockTable[normalized[index].blockIndex]
    rewrittenRegions.push({
      start: source.header.offset + sourceBlock.offset,
      end:
        source.header.offset +
        sourceBlock.offset +
        sourceBlock.archivedSize +
        rawChunkDigestBytes(sourceBlock.archivedSize, source.header.rawChunkSize),
    })
  }
  rewrittenRegions.push({
    start: source.header.offset + source.header.blockOffset,
    end:
      source.header.offset +
      source.header.blockOffset +
      source.header.blockEntries * BLOCK_ENTRY_BYTES,
  })
  if (source.bet !== undefined) {
    rewrittenRegions.push({
      start: source.header.offset + source.bet.offset,
      end:
        source.header.offset +
        source.bet.offset +
        source.bet.size +
        rawChunkDigestBytes(source.bet.size, source.header.rawChunkSize),
    })
  }
  if (source.header.version >= 3) {
    rewrittenRegions.push({
      start: source.header.offset + MD5_BLOCK_TABLE,
      end: source.header.offset + MD5_HEADER + 16,
    })
  }
  if (tablesStart !== undefined) {
    // Moved tables: the header names their new places and the archive's new size.
    rewrittenRegions.push({ start: at(8), end: at(12) }, { start: at(16), end: at(24) })
    if (header.version >= 2) rewrittenRegions.push({ start: at(0x2c), end: at(0x44) })
    if (header.version >= 3) rewrittenRegions.push({ start: at(0x64), end: at(0x6c) })
  }
  await cancellationCheckpoint(signal)
  // Moved tables leave nothing to compare past where they began.
  if (tablesStart !== undefined) {
    const limit = at(tablesStart)
    for (let index = rewrittenRegions.length - 1; index >= 0; index -= 1) {
      if (rewrittenRegions[index].start >= limit) rewrittenRegions.splice(index, 1)
    }
  }
  rewrittenRegions.sort((left, right) => left.start - right.start)
  await cancellationCheckpoint(signal)
  let verifiedUntil = 0
  for (let index = 0; index < rewrittenRegions.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const region = rewrittenRegions[index]
    if (
      region.start > verifiedUntil &&
      !(await bytesEqual(
        sourceBytes.subarray(verifiedUntil, region.start),
        output.subarray(verifiedUntil, region.start),
        signal,
      ))
    ) {
      throw new TypeError('native MPQ verification found drift outside declared rewritten regions')
    }
    verifiedUntil = Math.max(verifiedUntil, region.end)
  }
  // Up to where the tables began when they moved (the reopened archive vouches for them), else to
  // the archive's end; the suffix was compared above.
  const sourceArchiveEnd = at(tablesStart ?? header.archiveSize)
  if (tablesStart !== undefined && source.het !== undefined) {
    const het = reopened.het
    if (
      het === undefined ||
      !(await bytesEqual(
        sourceBytes.subarray(at(source.het.offset), at(source.het.offset + source.het.size)),
        output.subarray(at(het.offset), at(het.offset + het.size)),
        signal,
      ))
    ) {
      throw new TypeError('native MPQ verification found HET drift')
    }
  }
  if (
    verifiedUntil < sourceArchiveEnd &&
    !(await bytesEqual(
      sourceBytes.subarray(verifiedUntil, sourceArchiveEnd),
      output.subarray(verifiedUntil, sourceArchiveEnd),
      signal,
    ))
  ) {
    throw new TypeError('native MPQ verification found trailing drift outside rewritten regions')
  }

  const namedBlocks = new Set()
  let namedIndex = 0
  for (const item of names.values()) {
    if ((namedIndex & 0x0fff) === 0) await cancellationCheckpoint(signal)
    namedBlocks.add(item.blockIndex)
    namedIndex += 1
  }
  const activeBlocks = []
  const unchangedMethods = new Set()
  let unnamedBlocks = 0
  let patchBlocks = 0
  for (let index = 0; index < source.blockTable.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    const block = source.blockTable[index]
    if ((block.flags & FILE_EXISTS) === 0) continue
    activeBlocks.push(block)
    if (!namedBlocks.has(block.index)) unnamedBlocks += 1
    if ((block.flags & FILE_PATCH) !== 0) patchBlocks += 1
    if (!changedBlocks.has(block.index)) unchangedMethods.add(methodLabel(source, block))
  }
  let changedSectorMethods = false
  for (let index = 0; index < changed.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signal)
    if (changed[index].method.startsWith('sector-')) changedSectorMethods = true
  }
  const attributes = names.get('(attributes)')
  const internalSignature = names.get('(signature)')
  const suffixStart = source.header.offset + source.header.archiveSize
  const externalStrongSignature =
    sourceBytes.byteLength - suffixStart >= 260 && magic(sourceBytes, suffixStart) === 'NGIS'
  const signatureKinds = Object.freeze([
    ...(internalSignature === undefined ? [] : ['internal-signature-entry']),
    ...(externalStrongSignature ? ['external-strong-ngis-256'] : []),
  ])
  const signaturePresent = signatureKinds.length > 0
  const sourceArchiveDigest = await digest(sourceBytes, signal)
  abort(signal)
  const outputArchiveDigest = await digest(output, signal)
  abort(signal)
  const receipt = Object.freeze({
    schemaVersion: 1,
    kind: 'mpq-native-export-receipt-v1',
    strategy: 'whole-archive-save-as-fixed-slots',
    sourceArchiveDigest,
    outputArchiveDigest,
    archiveByteIdentity: sourceArchiveDigest === outputArchiveDigest ? 'identical' : 'changed',
    source: Object.freeze({
      version: source.header.version,
      headerBytes: source.header.headerSize,
      archiveBytes: source.header.archiveSize,
      userDataBytes: source.header.userDataBytes,
      prefixBytes: source.header.offset,
      suffixBytes: sourceBytes.byteLength - source.header.offset - source.header.archiveSize,
      hashSlots: source.hashTable.length,
      blockSlots: source.blockTable.length,
    }),
    unchanged: Object.freeze({
      entries: activeBlocks.length - changedBlocks.size,
      guarantee: 'raw-payload-flags-and-method-byte-identical',
      methods: Object.freeze([...unchangedMethods].sort()),
    }),
    changed: Object.freeze(changed),
    tables: Object.freeze({
      hash: 'byte-identical',
      block: 'deterministic-semantic-rebuild-in-original-slot',
      blockOrder: 'preserved',
      blockOffsets: relocations.length > 0 ? 'preserved-except-relocated' : 'preserved',
      placement: tablesStart === undefined ? 'in-place' : 'relocated-entries-then-tables-at-end',
      sectorTables: changedSectorMethods
        ? 'changed-entry-methods-preserved'
        : 'untouched-byte-identical',
      het: source.het === undefined ? 'absent' : 'byte-identical',
      bet:
        source.bet === undefined
          ? 'absent'
          : tablesStart === undefined
            ? 'changed-records-rewritten-in-original-slot'
            : 'rebuilt-after-relocated-entries',
      rawChunkDigests:
        source.header.rawChunkSize === 0 ? 'absent' : 'recomputed-for-changed-entries-and-bet',
    }),
    opaque: Object.freeze({
      prefix: 'byte-identical',
      suffix: 'byte-identical',
      // A version 3 header carries table MD5s; a relocation grows the archive size it declares.
      extendedHeader:
        header.version >= 3 || tablesStart !== undefined ? 'rewritten-size-and-md5-fields' : 'byte-identical',
      interstitialBytes: 'byte-identical',
      changedEntrySlack: 'zero-filled-no-source-payload-retained',
      sourceArchive: 'not-mutated',
      unnamedBlocks,
      unnamedBlocksPolicy: 'byte-identical',
      patchBlocks,
      patchBlocksPolicy: 'byte-identical-when-untouched',
      attributes: Object.freeze({
        present: attributes !== undefined,
        bytes: attributes === undefined ? 'absent' : 'preserved-opaque',
        status: attributes === undefined ? 'not-present' : 'invalidated-by-modification',
      }),
    }),
    signature: Object.freeze({
      present: signaturePresent,
      kind:
        signatureKinds.length === 0
          ? 'none'
          : signatureKinds.length === 1
            ? signatureKinds[0]
            : 'multiple',
      kinds: signatureKinds,
      externalStrongBytes: externalStrongSignature ? 260 : 0,
      bytes: signaturePresent ? 'preserved-opaque' : 'absent',
      status: signaturePresent ? 'invalidated-by-modification' : 'not-present',
    }),
    launchData: 'outside-writer-scope',
  })
  return Object.freeze({ bytes: output, receipt })
}

export const nativePreservingFidelity = Object.freeze({
  roundTrip: 'semantic',
  preservesUnknownData: true,
  notes: Object.freeze([
    'untouched native MPQ blocks retain byte-identical raw payloads, flags and compression methods',
    'changed entries retain their flags and supported stored/zlib method inside the original block slot',
    'hash order, block order and block offsets stay fixed; the encrypted block table is rebuilt deterministically',
    'unknown blocks, patch blocks, user-data prefixes and archive suffixes are copied opaque',
    'opaque attributes and signatures are copied byte-identically but reported invalidated after modification',
    'unused bytes in each changed native block slot are zero-filled in the new archive; the source archive is never erased or mutated',
    'the result is a separate whole-archive Save As replacement, never an in-place native edit claim',
  ]),
})

export async function validateNativePreservingChange(change, context, signal) {
  const signals = [context.signal, signal]
  abort(signals)
  const diagnostics = []
  const intent = record(change.semanticIntent)
  const receipt = record(intent?.nativeExportReceipt)
  const receiptSignature = record(receipt?.signature)
  const receiptSignatureKinds = Array.isArray(receiptSignature?.kinds) ? receiptSignature.kinds : []
  const signatureKindsSeen = new Set()
  let receiptSignatureKindsValid = receiptSignatureKinds.length <= context.budgets.maxNodes
  for (let index = 0; index < receiptSignatureKinds.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const kind = receiptSignatureKinds[index]
    if (
      !['internal-signature-entry', 'external-strong-ngis-256'].includes(kind) ||
      signatureKindsSeen.has(kind)
    ) {
      receiptSignatureKindsValid = false
    }
    signatureKindsSeen.add(kind)
  }
  const receiptSignatureKind =
    receiptSignatureKinds.length === 0
      ? 'none'
      : receiptSignatureKinds.length === 1
        ? receiptSignatureKinds[0]
        : 'multiple'
  const receiptAttributes = record(record(receipt?.opaque)?.attributes)
  const changedReceiptEntries = Array.isArray(receipt?.changed) ? receipt.changed : []
  let receiptChangesAreValid =
    changedReceiptEntries.length > 0 && changedReceiptEntries.length <= context.budgets.maxNodes
  for (let index = 0; index < changedReceiptEntries.length; index += 1) {
    if ((index & 0x0fff) === 0) await cancellationCheckpoint(signals)
    const entry = record(changedReceiptEntries[index])
    if (!(
      typeof entry?.path === 'string' &&
      entry.path.length > 0 &&
      Number.isSafeInteger(entry.blockIndex) &&
      entry.blockIndex >= 0 &&
      /^0x[0-9a-f]{8}$/u.test(String(entry.flags ?? '')) &&
      typeof entry.method === 'string' &&
      entry.method.length > 0 &&
      Number.isSafeInteger(entry.sourceBytes) &&
      entry.sourceBytes >= 0 &&
      Number.isSafeInteger(entry.outputBytes) &&
      entry.outputBytes >= 0 &&
      Number.isSafeInteger(entry.zeroFilledSlackBytes) &&
      entry.zeroFilledSlackBytes >= 0
    )) {
      receiptChangesAreValid = false
    }
  }
  abort(signals)
  if (
    intent?.kind !== 'mpq-native-preserving-export-v1' ||
    intent.sourceMode !== 'native-mpq' ||
    intent.completeSnapshot !== true ||
    intent.replacementMode !== 'whole-archive-save-as' ||
    intent.unknownDataPolicy !== 'preserve-opaque-source-bytes' ||
    receipt?.kind !== 'mpq-native-export-receipt-v1' ||
    receipt.strategy !== 'whole-archive-save-as-fixed-slots' ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(receipt.sourceArchiveDigest ?? '')) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(receipt.outputArchiveDigest ?? '')) ||
    receipt.archiveByteIdentity !== 'changed' ||
    record(receipt.unchanged)?.guarantee !== 'raw-payload-flags-and-method-byte-identical' ||
    record(receipt.tables)?.hash !== 'byte-identical' ||
    record(receipt.tables)?.block !== 'deterministic-semantic-rebuild-in-original-slot' ||
    record(receipt.tables)?.blockOrder !== 'preserved' ||
    !['preserved', 'preserved-except-relocated'].includes(record(receipt.tables)?.blockOffsets) ||
    record(receipt.opaque)?.prefix !== 'byte-identical' ||
    record(receipt.opaque)?.suffix !== 'byte-identical' ||
    !['byte-identical', 'rewritten-size-and-md5-fields'].includes(record(receipt.opaque)?.extendedHeader) ||
    record(receipt.opaque)?.interstitialBytes !== 'byte-identical' ||
    record(receipt.opaque)?.changedEntrySlack !== 'zero-filled-no-source-payload-retained' ||
    record(receipt.opaque)?.sourceArchive !== 'not-mutated' ||
    !(
      (receiptAttributes?.present === true &&
        receiptAttributes.bytes === 'preserved-opaque' &&
        receiptAttributes.status === 'invalidated-by-modification') ||
      (receiptAttributes?.present === false &&
        receiptAttributes.bytes === 'absent' &&
        receiptAttributes.status === 'not-present')
    ) ||
    !(
      (receiptSignature?.present === true &&
        receiptSignatureKindsValid &&
        receiptSignatureKinds.length > 0 &&
        receiptSignature.kind === receiptSignatureKind &&
        receiptSignature.externalStrongBytes ===
          (receiptSignatureKinds.includes('external-strong-ngis-256') ? 260 : 0) &&
        receiptSignature.bytes === 'preserved-opaque' &&
        receiptSignature.status === 'invalidated-by-modification') ||
      (receiptSignature?.present === false &&
        receiptSignatureKindsValid &&
        receiptSignatureKinds.length === 0 &&
        receiptSignature.kind === 'none' &&
        receiptSignature.externalStrongBytes === 0 &&
        receiptSignature.bytes === 'absent' &&
        receiptSignature.status === 'not-present')
    ) ||
    !receiptChangesAreValid
  ) {
    diagnostics.push(
      error(
        'blizzard/mpq-native-export-intent-invalid',
        'native MPQ export requires a complete source snapshot and fixed-slot preservation receipt',
      ),
    )
  }
  if (
    change.targets.length !== 1 ||
    change.targets[0].expectedRevision.namespaceRevision === undefined
  ) {
    diagnostics.push(
      error(
        'blizzard/mpq-native-export-target-not-namespace',
        'native MPQ Save As requires one revision-pinned destination namespace',
      ),
    )
  }
  const target = change.targets[0]
  const edit = change.edits[0]
  try {
    const archiveName = archiveNameOf(intent?.archiveName)
    if (
      change.edits.length !== 1 ||
      edit?.operation !== 'create' ||
      target === undefined ||
      edit.targetId !== target.targetId ||
      edit.source.id !== target.ownerSource.id ||
      edit.newPath !== archiveName ||
      edit.payload.kind !== 'inline'
    ) {
      throw new TypeError('native MPQ Save As accepts one inline destination create')
    }
    if (
      edit.payload.bytes.byteLength > context.budgets.maxScalarBytes ||
      BigInt(edit.payload.bytes.byteLength) > context.budgets.maxInputBytes
    ) {
      throw new RangeError('native MPQ output exceeds the provider resource budget')
    }
    await parseArchive(edit.payload.bytes, context.budgets.maxNodes, signals)
    abort(signals)
    const outputDigest = await digest(edit.payload.bytes, signals)
    abort(signals)
    if (outputDigest !== receipt?.outputArchiveDigest) {
      throw new TypeError('native MPQ output digest does not match its preservation receipt')
    }
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause
    diagnostics.push(
      error(
        'blizzard/mpq-native-export-edit-invalid',
        cause instanceof Error ? cause.message : String(cause),
      ),
    )
  }
  return Object.freeze({ valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) })
}

export async function snapshotNativePreservingMpq(options) {
  const { target, archiveName: requestedArchiveName, signal } = options
  abort(signal)
  if (target?.expectedRevision?.namespaceRevision === undefined) {
    throw new TypeError('native MPQ Save As target is not a revision-pinned namespace')
  }
  const archiveName = archiveNameOf(requestedArchiveName)
  const encoded = await encodeNativePreservingMpq(options)
  abort(signal)
  return Object.freeze({
    targets: Object.freeze([target]),
    edits: Object.freeze([
      Object.freeze({
        operation: 'create',
        targetId: target.targetId,
        source: target.ownerSource,
        newPath: archiveName,
        payload: Object.freeze({ kind: 'inline', bytes: encoded.bytes }),
      }),
    ]),
    semanticIntent: Object.freeze({
      kind: 'mpq-native-preserving-export-v1',
      sourceMode: 'native-mpq',
      completeSnapshot: true,
      replacementMode: 'whole-archive-save-as',
      unknownDataPolicy: 'preserve-opaque-source-bytes',
      archiveName,
      nativeExportReceipt: encoded.receipt,
    }),
    provenance: Object.freeze({ actor: 'user', note: 'bounded native-preserving MPQ Save As' }),
  })
}
