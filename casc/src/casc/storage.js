/**
 * CASC storage owner: selects current local indexes, searches their sorted encoding-key prefixes,
 * reads bare or encoded-header BLTE frames and bounded decoded prefixes, and delegates missing
 * data to the configured CDN. Existing byte bounds, cancellation, decode pooling and collision
 * fallback remain authoritative. Byte-column membership avoids allocating a view per key.
 * Does not build root path tables, interpret game assets or write installation data.
 */
import {
  bytesToHex,
  hexToBytes,
  joinPath,
  readUintBE,
  readUintLE,
  sliceExact,
} from './binary.js'
import { loadInflateSync } from '@modkit/codec-kit/compression/inflate'
import { decodeBlte, decodeChunk, parseChunks } from './blte.js'
import { BLTE_IN_PLACE_BYTES, createBlteDecodePool, defaultBlteDecodeThreads } from './blte-pool.js'
import { CASC_LIMITS, cascError, throwIfCancelled } from './limits.js'
/** Local bucket hash over a key prefix, optionally addressed inside an encoding column. */
function bucketForKey(key, keyLength, keyOffset = 0) {
  let acc = 0
  for (let i = 0; i < keyLength; i++) acc ^= key[keyOffset + i] ?? 0
  return (acc & 0x0f) ^ ((acc >> 4) & 0x0f)
}
function readHashBlock(data, offset) {
  const length = readUintLE(data, offset, 4)
  const start = offset + 8
  return { block: sliceExact(data, start, length, 'CASC hash block'), nextOffset: start + length }
}
function align16(value) {
  return (value + 15) & ~15
}
function parseIndexFile(data) {
  const { block: header, nextOffset } = readHashBlock(data, 0)
  if (header.length < 16) throw new Error('CASC index header is too small')
  const bucketIndex = header[2]
  const fileSizeLength = header[4]
  const dataOffsetLength = header[5]
  const encodingKeyLength = header[6]
  const dataFileSizeBits = header[7]
  const entriesOffset = align16(nextOffset)
  const { block: entriesBlock } = readHashBlock(data, entriesOffset)
  const entryLength = encodingKeyLength + dataOffsetLength + fileSizeLength
  if (entryLength === 0 || entriesBlock.length % entryLength !== 0) {
    throw new Error('CASC index entries block has invalid length')
  }
  // The records stay in their block and only their sorted order is built: a repaired SC2 install
  // carries ~228k of them, and one object per record — with a copy of its key and a hex string —
  // cost ~100 MB of the archive worker's heap, which it shares with every other window extension.
  const count = entriesBlock.length / entryLength
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  order.sort((left, right) =>
    compareRecordKeys(entriesBlock, left * entryLength, right * entryLength, encodingKeyLength),
  )
  // Buckets may be empty or sparse and Blizzard's index variants differ across products, so the
  // declared bucket index is not re-derived from the keys here.
  return {
    bucketIndex,
    keyLength: encodingKeyLength,
    entryLength,
    dataOffsetLength,
    fileSizeLength,
    dataFileSizeBits,
    records: entriesBlock,
    order,
    count,
  }
}
function compareRecordKeys(records, left, right, keyLength) {
  for (let i = 0; i < keyLength; i++) {
    const difference = records[left + i] - records[right + i]
    if (difference !== 0) return difference
  }
  return 0
}
/** Compare an index record with a key column directly, without allocating prefix views. */
function compareRecordKey(bucket, record, keyBytes, keyOffset = 0) {
  const at = record * bucket.entryLength
  for (let i = 0; i < bucket.keyLength; i++) {
    const difference = bucket.records[at + i] - keyBytes[keyOffset + i]
    if (difference !== 0) return difference
  }
  return 0
}
/** Binary-search the existing bucket order against a key at the supplied byte offset. */
function lowerBoundEntries(bucket, keyBytes, keyOffset = 0) {
  let lo = 0
  let hi = bucket.count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareRecordKey(bucket, bucket.order[mid], keyBytes, keyOffset) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}
/** Materialize one index record — only ever called for the handful of keys a read matches. */
function indexEntry(bucket, record) {
  const at = record * bucket.entryLength
  const dataOffset = readUintBE(bucket.records, at + bucket.keyLength, bucket.dataOffsetLength)
  return {
    encodingKey: bytesToHex(bucket.records.subarray(at, at + bucket.keyLength)),
    fileSize: readUintLE(
      bucket.records,
      at + bucket.keyLength + bucket.dataOffsetLength,
      bucket.fileSizeLength,
    ),
    dataFile: Math.floor(dataOffset / 2 ** bucket.dataFileSizeBits),
    dataOffset: dataOffset % 2 ** bucket.dataFileSizeBits,
  }
}
function latestIndexByBucket(names) {
  const byBucket = new Map()
  for (const name of names) {
    const base = name.split('/').pop() ?? name
    const match = /^([0-9a-f]{2})([0-9a-f]{8})\.idx$/i.exec(base)
    if (!match) continue
    const bucket = match[1].toLowerCase()
    const version = Number.parseInt(match[2], 16)
    const current = byBucket.get(bucket)
    if (!current || version > current.version) byBucket.set(bucket, { version, name })
  }
  return [...byBucket.values()].sort((a, b) => a.name.localeCompare(b.name)).map(v => v.name)
}
// A stored frame is either a bare BLTE stream, or a 30-byte BLTE_ENCODED_HEADER
// (whose EKey field may be zeroed) followed by the BLTE stream.
const BLTE_ENCODED_HEADER_SIZE = 30
/** How much of a container one window of {@link CascStorage.readDecodedPrefix} reads. */
const PREFIX_WINDOW_BYTES = 16 * 1024 * 1024

function concatBytes(parts, length) {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
const BLTE_SIGNATURE = [0x42, 0x4c, 0x54, 0x45] // 'BLTE'
function hasBlteSignature(data, offset) {
  return BLTE_SIGNATURE.every((b, i) => data[offset + i] === b)
}
function dataFileName(index) {
  return `data.${String(index).padStart(3, '0')}`
}
export class CascStorage {
  cdnCache = new Map()
  source
  dataRoot
  config
  buckets
  options
  decodePool
  constructor(source, dataRoot, config, buckets, options) {
    this.source = source
    this.dataRoot = dataRoot
    this.config = config
    this.buckets = buckets
    this.options = options
  }
  static async open(source, dataRoot, config, options = {}) {
    options = {
      maxIndexFiles: options.maxIndexFiles ?? CASC_LIMITS.maxIndexFiles,
      maxIndexBytes: options.maxIndexBytes ?? CASC_LIMITS.maxIndexBytes,
      maxContainerReadBytes:
        options.maxContainerReadBytes ?? CASC_LIMITS.maxContainerReadBytes,
      maxDecodedBytes: options.maxDecodedBytes ?? CASC_LIMITS.maxDecodedBytes,
      ...options,
    }
    // Native zlib where the realm has it: every stored file is BLTE, most chunks are zlib.
    options.inflateZlib ??= await loadInflateSync('zlib')
    // Large streams decode on a pool of threads where decoding would stall Node's main thread.
    options.decodeThreads ??= await defaultBlteDecodeThreads()
    throwIfCancelled(options.signal)
    const dataPath = joinPath(dataRoot, 'data')
    const names = await source.list(dataPath)
    const indexNames = latestIndexByBucket(names)
    if (indexNames.length === 0)
      throw cascError('x3.casc/index-missing', 'CASC has no local indexes', { dataPath })
    if (indexNames.length > options.maxIndexFiles) {
      throw cascError('x3.casc/index-file-budget-exceeded', 'CASC has too many local indexes', {
        indexFiles: indexNames.length,
        maxIndexFiles: options.maxIndexFiles,
      })
    }
    const buckets = []
    let indexBytes = 0
    // The local indexes as a fingerprint: each name carries its version (the agent writes a new one
    // whenever the stored files change), the length guards a rewrite in place.
    const indexParts = []
    for (const name of indexNames) {
      throwIfCancelled(options.signal)
      const path = name.includes('/') ? name : joinPath(dataPath, name)
      const bytes = await source.get(path)
      indexBytes += bytes.byteLength
      if (indexBytes > options.maxIndexBytes) {
        throw cascError(
          'x3.casc/index-byte-budget-exceeded',
          'CASC indexes exceed their byte budget',
          {
            indexBytes,
            maxIndexBytes: options.maxIndexBytes,
          },
        )
      }
      buckets.push(parseIndexFile(bytes))
      indexParts.push(`${name.split('/').at(-1)}:${bytes.byteLength}`)
    }
    const storage = new CascStorage(source, dataRoot, config, buckets, options)
    /** What the local files are, for caches of facts derived from them (`CascReader.localRows`). */
    storage.indexFingerprint = indexParts.sort().join(';')
    return storage
  }
  async close() {
    await (await this.decodePool)?.close()
    await this.source.close?.()
  }
  decodeInPlace(blte) {
    return decodeBlte(blte, {
      maxOutputBytes: this.options.maxDecodedBytes,
      ...(this.options.encryptionKeys === undefined ? {} : { encryptionKeys: this.options.encryptionKeys }),
      ...(this.options.inflateZlib === undefined ? {} : { inflateZlib: this.options.inflateZlib }),
    })
  }
  async decode(blte) {
    if (blte.byteLength < BLTE_IN_PLACE_BYTES || !(this.options.decodeThreads > 0)) {
      return this.decodeInPlace(blte)
    }
    this.decodePool ??= createBlteDecodePool(this.options.decodeThreads).catch(() => undefined)
    const pool = await this.decodePool
    if (pool === undefined) return this.decodeInPlace(blte)
    try {
      return await pool.decode(blte, this.options.maxDecodedBytes)
    } catch {
      // A thread that failed to start or died (a bundle without blte-thread.js) must not fail the
      // read: decoding again in place gives the bytes, or the stream's own error.
      return this.decodeInPlace(blte)
    }
  }
  findCandidates(encodingKey) {
    const keyBytes = hexToBytes(encodingKey)
    const candidates = []
    for (const bucket of this.buckets) {
      if (bucketForKey(keyBytes, bucket.keyLength) !== bucket.bucketIndex) continue
      const prefixBytes = keyBytes.subarray(0, bucket.keyLength)
      for (
        let i = lowerBoundEntries(bucket, prefixBytes);
        i < bucket.count && compareRecordKey(bucket, bucket.order[i], prefixBytes) === 0;
        i++
      ) {
        candidates.push(indexEntry(bucket, bucket.order[i]))
      }
    }
    return candidates
  }
  find(encodingKey) {
    return this.findCandidates(encodingKey)[0]
  }
  hasEncodingKey(encodingKey) {
    return this.findCandidates(encodingKey).length > 0
  }
  /** Local membership of one bounded key in a byte column; never borrow bytes from the next key. */
  hasEncodingKeyBytes(keyBytes, keyOffset = 0, availableBytes = keyBytes.length - keyOffset) {
    let keyLength = -1
    let wanted = -1
    for (const bucket of this.buckets) {
      if (bucket.keyLength > availableBytes) continue
      if (bucket.keyLength !== keyLength) {
        keyLength = bucket.keyLength
        wanted = bucketForKey(keyBytes, keyLength, keyOffset)
      }
      if (wanted !== bucket.bucketIndex) continue
      const at = lowerBoundEntries(bucket, keyBytes, keyOffset)
      if (at < bucket.count && compareRecordKey(bucket, bucket.order[at], keyBytes, keyOffset) === 0) return true
    }
    return false
  }
  async readEncodingKey(encodingKey, signal) {
    throwIfCancelled(signal)
    const normalizedKey = encodingKey.toLowerCase()
    const entries = this.findCandidates(normalizedKey)
    if (entries.length === 0) {
      const fromCdn = await this.readFromCdn(normalizedKey, signal)
      if (fromCdn !== undefined) return fromCdn
      throw cascError('x3.casc/encoding-key-not-local', 'CASC encoding key is not local', {
        encodingKey,
      })
    }
    // CascLib trusts the index entry and does not re-verify the container's EKey
    // (it is frequently zeroed for files stored inside data segments). It only locates
    // the BLTE stream: present directly, or after a 30-byte BLTE_ENCODED_HEADER.
    let lastError
    for (const entry of entries) {
      throwIfCancelled(signal)
      const dataPath = joinPath(this.dataRoot, 'data', dataFileName(entry.dataFile))
      const container = await this.readContainer(dataPath, entry.dataOffset, entry.fileSize)
      const blteStart = hasBlteSignature(container, 0)
        ? 0
        : hasBlteSignature(container, BLTE_ENCODED_HEADER_SIZE)
          ? BLTE_ENCODED_HEADER_SIZE
          : -1
      if (blteStart < 0) continue
      try {
        return await this.decode(container.subarray(blteStart))
      } catch (err) {
        lastError = err
      }
    }
    throw cascError('x3.casc/blte-frame-unreadable', 'CASC has no readable BLTE frame', {
      encodingKey,
      cause: lastError instanceof Error ? lastError.message : undefined,
    })
  }
  /**
   * The first bytes of a local file's decoded stream, chunk by chunk, leaving the rest unread:
   * `lengthOf(head)` names the bytes wanted once the head is long enough (`undefined`: more head).
   * The ENCODING file is read so — World of Warcraft's is 187 MB, and a reader keeps only its
   * content-key pages, which come first. A file that is not local or not chunked is read whole.
   */
  async readDecodedPrefix(encodingKey, lengthOf, signal) {
    throwIfCancelled(signal)
    const entry = this.findCandidates(encodingKey.toLowerCase())[0]
    if (entry === undefined) return this.readEncodingKey(encodingKey, signal)
    const dataPath = joinPath(this.dataRoot, 'data', dataFileName(entry.dataFile))
    // Chunks are read through one window of the container, not a request each.
    let windowStart = 0
    let window = new Uint8Array(0)
    const read = async (offset, length) => {
      if (offset + length > entry.fileSize) {
        throw cascError('x3.casc/blte-frame-unreadable', 'CASC BLTE stream ends past its container', { encodingKey })
      }
      if (offset < windowStart || offset + length > windowStart + window.length) {
        const size = Math.min(Math.max(length, PREFIX_WINDOW_BYTES), entry.fileSize - offset)
        window = await this.readContainer(dataPath, entry.dataOffset + offset, size)
        windowStart = offset
      }
      return window.subarray(offset - windowStart, offset - windowStart + length)
    }
    const probe = await read(0, Math.min(entry.fileSize, BLTE_ENCODED_HEADER_SIZE + 12))
    const start = hasBlteSignature(probe, 0) ? 0 : hasBlteSignature(probe, BLTE_ENCODED_HEADER_SIZE) ? BLTE_ENCODED_HEADER_SIZE : -1
    const headerSize = start < 0 ? 0 : readUintBE(probe, start + 4, 4)
    if (headerSize === 0) return this.readEncodingKey(encodingKey, signal)
    const { chunks } = parseChunks(await read(start, headerSize))
    const total = chunks.reduce((sum, chunk) => sum + chunk.decompressedSize, 0)
    const options = {
      maxOutputBytes: this.options.maxDecodedBytes,
      ...(this.options.inflateZlib === undefined ? {} : { inflateZlib: this.options.inflateZlib }),
    }
    const head = []
    let have = 0
    let out
    let offset = start + headerSize
    for (const chunk of chunks) {
      throwIfCancelled(signal)
      const decoded = decodeChunk(await read(offset, chunk.compressedSize), chunk.decompressedSize, options)
      offset += chunk.compressedSize
      if (out === undefined) {
        head.push(decoded.slice())
        const bytes = concatBytes(head, have + decoded.length)
        const wanted = lengthOf(bytes)
        if (wanted !== undefined) {
          const length = Math.min(wanted, total)
          if (length > this.options.maxDecodedBytes) {
            throw cascError('x3.casc/decoded-budget-exceeded', 'CASC decoded prefix exceeds its budget', {
              encodingKey, length, maxDecodedBytes: this.options.maxDecodedBytes,
            })
          }
          out = new Uint8Array(length)
          out.set(bytes.subarray(0, length))
        }
      } else {
        out.set(decoded.subarray(0, out.length - have), have)
      }
      have += decoded.length
      if (out !== undefined && have >= out.length) return out
    }
    if (out === undefined) throw cascError('x3.casc/blte-frame-unreadable', 'CASC stream is shorter than its header names', { encodingKey })
    return out
  }
  async readFromCdn(encodingKey, signal) {
    const cdn = this.options.cdn
    if (cdn === undefined) return undefined
    throwIfCancelled(signal)
    let pending = signal === undefined ? this.cdnCache.get(encodingKey) : undefined
    if (pending === undefined) {
      pending = this.fetchFromCdn(encodingKey, signal)
      if (signal === undefined) this.cdnCache.set(encodingKey, pending)
    }
    return pending
  }
  // A file the install does not hold: from the downloads cache, else from the CDN — one range of the
  // archive that `cdn.locate` names (where the game keeps nearly every file), else the loose object.
  async fetchFromCdn(encodingKey, signal) {
    const cdn = this.options.cdn
    const cached = await cdn.cache?.load(encodingKey).catch(() => undefined)
    if (cached !== undefined) {
      const decoded = await this.decodeCdnContainer(encodingKey, cached).catch(() => undefined)
      if (decoded !== undefined) return decoded
    }
    const place = await cdn.locate?.(encodingKey, signal)
    throwIfCancelled(signal)
    if (place !== undefined && place.size > this.options.maxContainerReadBytes) {
      throw cascError(
        'x3.casc/container-read-budget-exceeded',
        'CASC CDN container exceeds its byte budget',
        { encodingKey, bytes: place.size },
      )
    }
    const name = place?.archive ?? encodingKey
    const relative = `${cdn.path}/data/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`
    for (const host of cdn.hosts) {
      throwIfCancelled(signal)
      const container = await cdn
        .fetch(`https://${host}/${relative}`, signal, place === undefined ? undefined : [place.offset, place.size])
        .catch(() => undefined)
      throwIfCancelled(signal)
      if (container === undefined || container.byteLength === 0) continue
      if (container.byteLength > this.options.maxContainerReadBytes) {
        throw cascError(
          'x3.casc/container-read-budget-exceeded',
          'CASC CDN container exceeds its byte budget',
          { encodingKey, bytes: container.byteLength },
        )
      }
      // A bad host's bytes or a stream this reader cannot decode: the next host is tried.
      const decoded = await this.decodeCdnContainer(encodingKey, container).catch(() => undefined)
      if (decoded === undefined) continue
      await cdn.cache?.store(encodingKey, container).catch(() => undefined)
      return decoded
    }
    return undefined
  }
  // The bytes of one CDN container (a loose object or an archive range): its BLTE stream decoded.
  // Throws when the bytes are not a BLTE stream, so a bad host or a stale cache entry is passed over.
  async decodeCdnContainer(encodingKey, container) {
    if (container.byteLength > this.options.maxContainerReadBytes) {
      throw cascError(
        'x3.casc/container-read-budget-exceeded',
        'CASC CDN container exceeds its byte budget',
        { encodingKey, bytes: container.byteLength },
      )
    }
    const blteStart = hasBlteSignature(container, 0)
      ? 0
      : hasBlteSignature(container, BLTE_ENCODED_HEADER_SIZE)
        ? BLTE_ENCODED_HEADER_SIZE
        : -1
    if (blteStart < 0) {
      throw cascError('x3.casc/cdn-container-invalid', 'CASC CDN container is not a BLTE stream', { encodingKey })
    }
    return this.decode(container.subarray(blteStart))
  }
  // Read one container span. CASC `data.NNN` files are up to 1 GB, so prefer a
  // ranged read when the source supports it; otherwise fall back to whole-file.
  async readContainer(dataPath, offset, length) {
    if (length > this.options.maxContainerReadBytes) {
      throw cascError(
        'x3.casc/container-read-budget-exceeded',
        'CASC container range exceeds its budget',
        {
          dataPath,
          offset,
          length,
          maxContainerReadBytes: this.options.maxContainerReadBytes,
        },
      )
    }
    if (this.source.getRange) return this.source.getRange(dataPath, offset, length)
    return sliceExact(await this.source.get(dataPath), offset, length, 'CASC storage container')
  }
}
