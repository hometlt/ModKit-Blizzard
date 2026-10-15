import { readUintBE } from './binary.js'
/** The chunk table of a BLTE header (`data` from the `BLTE` magic on, the whole header at least). */
export function parseChunks(data) {
  if (
    data.length < 8 ||
    data[0] !== 0x42 ||
    data[1] !== 0x4c ||
    data[2] !== 0x54 ||
    data[3] !== 0x45
  ) {
    throw new Error('Missing BLTE header')
  }
  const headerSize = readUintBE(data, 4, 4)
  if (headerSize === 0) {
    return { chunks: [{ compressedSize: data.length - 8 }], dataOffset: 8 }
  }
  if (headerSize > data.length) throw new Error('BLTE header extends beyond buffer')
  if (data[8] !== 0x0f) throw new Error(`Unsupported BLTE chunk flags 0x${data[8].toString(16)}`)
  const count = readUintBE(data, 9, 3)
  const chunks = []
  let offset = 12
  for (let i = 0; i < count; i++) {
    chunks.push({
      compressedSize: readUintBE(data, offset, 4),
      decompressedSize: readUintBE(data, offset + 4, 4),
    })
    offset += 24
  }
  if (offset !== headerSize) throw new Error('BLTE header has trailing bytes')
  return { chunks, dataOffset: headerSize }
}
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

/** A bounds-checked view: a chunk is decoded where it lies, not copied first. */
function viewExact(data, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(`${label} is out of bounds`)
  }
  return data.subarray(offset, offset + length)
}

/** One encoded chunk (mode byte first) → its bytes; `N` comes back as a view of `chunk`. */
export function decodeChunk(chunk, decompressedSize, options) {
  if (chunk.length === 0) throw new Error('Empty BLTE chunk')
  const mode = String.fromCharCode(chunk[0])
  const payload = chunk.subarray(1)
  if (mode === 'N') {
    if (payload.length > options.maxOutputBytes) {
      throw new Error('BLTE uncompressed chunk exceeds output budget')
    }
    if (decompressedSize !== undefined && payload.length !== decompressedSize) {
      throw new Error('BLTE uncompressed chunk size mismatch')
    }
    return payload
  }
  if (mode === 'Z') {
    // The inflate is codec-kit's (`loadInflateSync`), resolved once when the storage opens.
    if (options.inflateZlib === undefined) {
      throw new Error('BLTE zlib chunk needs an inflate (options.inflateZlib)')
    }
    if (decompressedSize > options.maxOutputBytes) {
      throw new Error('BLTE compressed chunk exceeds output budget')
    }
    const out = options.inflateZlib(payload, decompressedSize ?? options.maxOutputBytes)
    if (out.length > options.maxOutputBytes) {
      throw new Error('BLTE compressed chunk exceeds output budget')
    }
    if (decompressedSize !== undefined && out.length !== decompressedSize) {
      throw new Error('BLTE zlib chunk size mismatch')
    }
    return out
  }
  if (mode === 'E') {
    // `E`, key name length, key name (a little-endian 64-bit number, as key lists spell it), IV
    // length, IV, cipher. Salsa20 decryption is not implemented yet; the error names the key.
    const nameLength = payload[0] ?? 0
    const name = Array.from(payload.subarray(1, 1 + nameLength), byte => byte.toString(16).padStart(2, '0'))
      .reverse()
      .join('')
    const known = options.encryptionKeys?.has(name) === true
    throw new Error(`BLTE chunk is encrypted with key ${name} (${known ? 'the key is known; decryption is not supported yet' : 'the key is unknown'})`)
  }
  throw new Error(`Unsupported BLTE mode '${mode}'`)
}

/** Whether `bytes` spans its whole buffer, as a result crossing the host's worker RPC must. */
function ownsBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
}

/**
 * Decode a BLTE stream. Chunks decode where they lie (views, not a copy each). The result always
 * owns its whole buffer — the host's RPC refuses a partial view, and a codec returns these bytes
 * across it — so a one-chunk stream is returned as it is only when its bytes already do (an
 * inflate that filled exactly its buffer); a view into the read container is copied.
 */
export function decodeBlte(data, options = {}) {
  options = {
    ...options,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  }
  const { chunks, dataOffset } = parseChunks(data)
  let readOffset = dataOffset
  const decodedChunks = []
  let totalSize = 0
  for (const chunk of chunks) {
    if (
      chunk.decompressedSize !== undefined &&
      totalSize + chunk.decompressedSize > options.maxOutputBytes
    ) {
      throw new Error('BLTE output exceeds configured budget')
    }
    const encoded = viewExact(data, readOffset, chunk.compressedSize, 'BLTE chunk')
    const decoded = decodeChunk(encoded, chunk.decompressedSize, options)
    decodedChunks.push(decoded)
    totalSize += decoded.length
    if (totalSize > options.maxOutputBytes) {
      throw new Error('BLTE output exceeds configured budget')
    }
    readOffset += chunk.compressedSize
  }
  if (decodedChunks.length === 1) {
    const [only] = decodedChunks
    return ownsBuffer(only) ? only : new Uint8Array(only)
  }
  const out = new Uint8Array(totalSize)
  let writeOffset = 0
  for (const decoded of decodedChunks) {
    out.set(decoded, writeOffset)
    writeOffset += decoded.length
  }
  return out
}
