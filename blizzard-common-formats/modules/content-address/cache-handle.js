const HEX = '0123456789abcdef'

function ascii(bytes) {
  let value = ''
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined
    value += String.fromCharCode(byte)
  }
  return value
}

function hex(bytes) {
  let value = ''
  for (const byte of bytes) value += HEX[byte >>> 4] + HEX[byte & 0x0f]
  return value
}

/** Map files (s2mh, s2ma, s2mv, s2ml...): what a blob found inside a map header or replay can name. */
const MAP_FILES = /^s2m[a-z]$/u

/**
 * Decode Blizzard's 40-byte cache/content handle without filesystem or network access. By default
 * only map files are recognised, so that scanning arbitrary 40-byte blobs finds no false handles; a
 * caller holding a handle it knows to be one (a depot file named by the protocol: unlk, ldpt, wafl
 * ...) passes the `types` it accepts.
 */
export function decodeBlizzardCacheHandle(bytes, { types = MAP_FILES } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 40) return undefined
  const type = ascii(bytes.subarray(0, 4))
  if (type === undefined || !/^[A-Za-z0-9]{4}$/u.test(type) || !types.test(type)) return undefined
  const region = ascii(bytes.subarray(4, 8))?.replaceAll('\0', '')
  if (region === undefined || !/^[A-Za-z0-9]*$/u.test(region)) return undefined
  const sha256 = hex(bytes.subarray(8))
  return Object.freeze({
    type,
    region,
    sha256,
    file: `${sha256}.${type}`,
  })
}
