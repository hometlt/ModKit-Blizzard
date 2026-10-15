// Exact browser-safe port of the pinned MK2 StarCraft II payload obfuscation helpers.
const SC2_MAGIC = 0x1f9e2a3c

export function obfuscate(data, key) {
  if (!key || key.length === 0) throw new Error('Encryption key is required')
  const keyBytes = new TextEncoder().encode(key)
  const result = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] ^ keyBytes[index % keyBytes.length]
  }
  return result
}

export function deobfuscate(data, key) {
  return obfuscate(data, key)
}

export function obfuscateMulti(data, keys) {
  if (!keys || keys.length === 0) throw new Error('At least one key is required')
  let result = new Uint8Array(data)
  for (const key of keys) result = obfuscate(result, key)
  return result
}

export function deobfuscateMulti(data, keys) {
  if (!keys || keys.length === 0) throw new Error('At least one key is required')
  let result = new Uint8Array(data)
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    result = obfuscate(result, keys[index])
  }
  return result
}

function simpleHash(key) {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(index)
    hash &= hash
  }
  return hash >>> 0
}

function readU32LE(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true)
}

function writeU32LE(data, offset, value) {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value, true)
}

function concatBytes(...chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function addObfuscationHeader(data, key) {
  const header = new Uint8Array(8)
  writeU32LE(header, 0, SC2_MAGIC)
  writeU32LE(header, 4, simpleHash(key))
  return concatBytes(header, obfuscate(data, key))
}

export function removeObfuscationHeader(data, key) {
  if (data.length < 8) throw new Error('Data too short to contain header')
  if (readU32LE(data, 0) !== SC2_MAGIC) throw new Error('Invalid obfuscation header')
  if (readU32LE(data, 4) !== simpleHash(key)) {
    throw new Error('Key mismatch - cannot deobfuscate')
  }
  return deobfuscate(data.slice(8), key)
}

export function hasObfuscationHeader(data) {
  return data.length >= 8 && readU32LE(data, 0) === SC2_MAGIC
}

export function rotateBytes(data, shift) {
  const result = new Uint8Array(data.length)
  const normalized = ((shift % 256) + 256) % 256
  for (let index = 0; index < data.length; index += 1) {
    result[index] = (data[index] + normalized) & 0xff
  }
  return result
}

export function unrotateBytes(data, shift) {
  return rotateBytes(data, 256 - shift)
}

export function obfuscateCombined(data, key, rotation) {
  return rotateBytes(obfuscate(data, key), rotation)
}

export function deobfuscateCombined(data, key, rotation) {
  return deobfuscate(unrotateBytes(data, rotation), key)
}
