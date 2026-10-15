const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function abort(signal) {
  signal?.throwIfAborted()
}

function limits(options = {}) {
  return {
    signal: options.signal,
    maxDepth: options.maxDepth ?? 64,
    maxNodes: options.maxNodes ?? 100_000,
    maxScalarBytes: options.maxScalarBytes ?? 16 * 1024 * 1024,
    nodes: 0,
  }
}

class ByteCursor {
  constructor(bytes, state) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('versioned input must be Uint8Array')
    this.bytes = bytes
    this.state = state
    this.position = 0
  }

  get done() { return this.position >= this.bytes.length }

  byte() {
    abort(this.state.signal)
    if (this.done) throw new RangeError('VersionedDecoder: truncated input')
    return this.bytes[this.position++]
  }

  take(length) {
    abort(this.state.signal)
    if (!Number.isSafeInteger(length) || length < 0 || length > this.state.maxScalarBytes) {
      throw new RangeError(`VersionedDecoder: scalar exceeds ${this.state.maxScalarBytes} bytes`)
    }
    if (this.position + length > this.bytes.length) throw new RangeError('VersionedDecoder: truncated input')
    // A copy: a decoded value crosses worker RPC, which refuses a view of the stream's buffer.
    const result = Uint8Array.prototype.slice.call(this.bytes, this.position, this.position + length)
    this.position += length
    return result
  }

  uint(length) {
    const bytes = this.take(length)
    let result = 0n
    for (let index = length - 1; index >= 0; index -= 1) result = result * 256n + BigInt(bytes[index])
    return result <= MAX_SAFE ? Number(result) : result
  }

  vint() {
    let byte = this.byte()
    const negative = byte & 1
    let result = BigInt((byte >> 1) & 0x3f)
    let bits = 6n
    while ((byte & 0x80) !== 0) {
      byte = this.byte()
      result |= BigInt(byte & 0x7f) << bits
      bits += 7n
      if (bits > 70n) throw new RangeError('VersionedDecoder: vint is too large')
    }
    const value = negative ? -result : result
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value
  }
}

function count(state) {
  state.nodes += 1
  if (state.nodes > state.maxNodes) throw new RangeError(`VersionedDecoder: exceeds ${state.maxNodes} nodes`)
}

function smallInteger(cursor, label) {
  const value = cursor.vint()
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`VersionedDecoder: invalid ${label}`)
  }
  return value
}

function instance(cursor, state, depth) {
  abort(state.signal)
  if (depth > state.maxDepth) throw new RangeError(`VersionedDecoder: exceeds depth ${state.maxDepth}`)
  count(state)
  switch (cursor.byte()) {
    case 0: {
      const length = smallInteger(cursor, 'array length')
      const result = []
      for (let index = 0; index < length; index += 1) result.push(instance(cursor, state, depth + 1))
      return result
    }
    case 1: return cursor.take(Math.ceil(smallInteger(cursor, 'bit blob length') / 8))
    case 2: return cursor.take(smallInteger(cursor, 'blob length'))
    case 3: return { [smallInteger(cursor, 'choice tag')]: instance(cursor, state, depth + 1) }
    case 4: return cursor.byte() === 0 ? null : instance(cursor, state, depth + 1)
    case 5: {
      const result = {}
      const length = smallInteger(cursor, 'struct field count')
      for (let index = 0; index < length; index += 1) {
        result[smallInteger(cursor, 'field tag')] = instance(cursor, state, depth + 1)
      }
      return result
    }
    case 6: return cursor.uint(1)
    case 7: return cursor.uint(4)
    case 8: return cursor.uint(8)
    case 9: return cursor.vint()
    default: throw new TypeError('VersionedDecoder: unknown type tag')
  }
}

export function decodeVersioned(bytes, options) {
  const state = limits(options)
  return instance(new ByteCursor(bytes, state), state, 0)
}

export class VersionedReader {
  constructor(bytes, options) {
    this.state = limits(options)
    this.cursor = new ByteCursor(bytes, this.state)
  }
  get done() { return this.cursor.done }
  read() { return instance(this.cursor, this.state, 0) }
}

export function asStruct(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) return value
  throw new TypeError('VersionedDecoder: expected struct')
}
export function asArray(value) {
  if (Array.isArray(value)) return value
  throw new TypeError('VersionedDecoder: expected array')
}
export function asNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint' && value >= MIN_SAFE && value <= MAX_SAFE) return Number(value)
  throw new TypeError('VersionedDecoder: expected safe number')
}
export function asString(value) {
  if (value instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(value)
  throw new TypeError('VersionedDecoder: expected blob')
}
