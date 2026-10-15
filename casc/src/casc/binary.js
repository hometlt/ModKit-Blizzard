const HEX = /^[0-9a-f]+$/i
export function normalizePath(path) {
  // Preserve a single leading slash so absolute POSIX install roots (e.g.
  // `/home/user/StarCraft II`) stay absolute — stripping it makes FsReader
  // resolve against cwd and fail with ENOENT. Relative virtual paths and
  // Windows `C:/…` roots have no leading slash, so they're unaffected.
  const p = path.replace(/\\/g, '/')
  return (p.startsWith('/') ? '/' : '') + p.replace(/^\/+|\/+$/g, '')
}
export function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'))
}
export function decodeUtf8(data) {
  return new TextDecoder('utf-8').decode(data)
}
export function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || !HEX.test(clean)) throw new Error(`Invalid hex key '${hex}'`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
export function bytesToHex(bytes) {
  let out = ''
  for (const b of bytes) out += HEX_BYTE[b]
  return out
}
export function compareBytesUnsigned(a, b) {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i]
    const bv = b[i]
    if (av !== bv) return av - bv
  }
  return a.length - b.length
}
export function readUintBE(data, offset, size) {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + data[offset + i]
  return value
}
export function readUintLE(data, offset, size) {
  let value = 0
  let factor = 1
  for (let i = 0; i < size; i++) {
    value += data[offset + i] * factor
    factor *= 256
  }
  return value
}
export function sliceExact(data, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(`${label} is out of bounds`)
  }
  return data.slice(offset, offset + length)
}
