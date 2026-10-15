function abort(signal) { signal?.throwIfAborted() }

export class BitPackedBuffer {
  constructor(data, options = {}) {
    if (!(data instanceof Uint8Array)) throw new TypeError('bitpacked input must be Uint8Array')
    this.data = data
    this.signal = options.signal
    this.used = 0
    this.next = 0
    this.nextBits = 0
  }
  done() { return this.nextBits === 0 && this.used >= this.data.length }
  usedBits() { return this.used * 8 - this.nextBits }
  byteAlign() { this.nextBits = 0 }
  readBits(bits) {
    abort(this.signal)
    if (!Number.isSafeInteger(bits) || bits < 0) throw new RangeError('BitPackedBuffer: bit width must be a non-negative safe integer')
    if (bits > 53) {
      let wide = 0n
      let remaining = bits
      while (remaining > 0) {
        const width = Math.min(remaining, 32)
        wide = (wide << BigInt(width)) | BigInt(this.readBits(width))
        remaining -= width
      }
      return wide
    }
    let result = 0
    let resultBits = 0
    while (resultBits !== bits) {
      if (this.nextBits === 0) {
        if (this.used >= this.data.length) throw new RangeError('BitPackedBuffer: truncated input')
        this.next = this.data[this.used++]
        this.nextBits = 8
      }
      const copiedBits = Math.min(bits - resultBits, this.nextBits)
      const copied = this.next & (2 ** copiedBits - 1)
      result += copied * 2 ** (bits - resultBits - copiedBits)
      this.next = Math.floor(this.next / 2 ** copiedBits)
      this.nextBits -= copiedBits
      resultBits += copiedBits
    }
    return result
  }
  readBytes(length, aligned = true) {
    abort(this.signal)
    if (aligned) this.byteAlign()
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('BitPackedBuffer: invalid byte length')
    if (aligned) {
      if (this.used + length > this.data.length) throw new RangeError('BitPackedBuffer: truncated input')
      // A copy: a decoded value crosses worker RPC, which refuses a view of the stream's buffer.
      const result = Uint8Array.prototype.slice.call(this.data, this.used, this.used + length)
      this.used += length
      return result
    }
    const result = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) result[index] = this.readBits(8)
    return result
  }
}

export class BitPackedDecoder {
  constructor(data, typeinfos, options = {}) {
    this.buffer = new BitPackedBuffer(data, options)
    this.typeinfos = typeinfos
    this.signal = options.signal
    this.maxNodes = options.maxNodes ?? 100_000
    this.maxScalarBytes = options.maxScalarBytes ?? 16 * 1024 * 1024
    this.maxDepth = options.maxDepth ?? 64
    this.nodes = 0
  }
  done() { return this.buffer.done() }
  byteAlign() { this.buffer.byteAlign() }
  usedBits() { return this.buffer.usedBits() }
  instance(typeid, depth = 0) {
    abort(this.signal)
    this.nodes += 1
    if (this.nodes > this.maxNodes) throw new RangeError(`BitPackedDecoder: exceeds ${this.maxNodes} nodes`)
    if (depth > this.maxDepth) throw new RangeError(`BitPackedDecoder: exceeds depth ${this.maxDepth}`)
    const type = this.typeinfos[typeid]
    if (!type) throw new RangeError(`BitPackedDecoder: unknown type ${typeid}`)
    const [method, args] = type
    const integer = bounds => {
      const value = this.buffer.readBits(bounds[1])
      return typeof value === 'bigint' ? BigInt(bounds[0]) + value : bounds[0] + value
    }
    switch (method) {
      case '_int': return integer(args[0])
      case '_bool': return integer([0, 1]) !== 0
      case '_null': return null
      case '_blob': {
        const length = integer(args[0])
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new RangeError('BitPackedDecoder: invalid blob length')
        if (length > this.maxScalarBytes) throw new RangeError(`BitPackedDecoder: scalar exceeds ${this.maxScalarBytes} bytes`)
        return this.buffer.readBytes(length)
      }
      case '_fourcc': return new TextDecoder('latin1').decode(this.buffer.readBytes(4, false))
      case '_array': {
        const length = integer(args[0])
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > this.maxNodes - this.nodes) throw new RangeError('BitPackedDecoder: invalid array length')
        const result = []
        for (let index = 0; index < length; index += 1) result.push(this.instance(args[1], depth + 1))
        return result
      }
      case '_bitarray': {
        const length = integer(args[0])
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new RangeError('BitPackedDecoder: invalid bit-array length')
        return [length, this.buffer.readBits(length)]
      }
      case '_optional': return integer([0, 1]) === 0 ? null : this.instance(args[0], depth + 1)
      case '_choice': {
        const tag = integer(args[0])
        const field = args[1][tag]
        if (!field) throw new RangeError(`BitPackedDecoder: unknown choice ${tag}`)
        return { [field[0]]: this.instance(field[1], depth + 1) }
      }
      case '_struct': {
        let result = {}
        for (const [name, childType] of args[0]) {
          const value = this.instance(childType, depth + 1)
          if (name === '__parent' && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) result = { ...result, ...value }
          else if (name === '__parent' && args[0].length === 1) return value
          else result[name] = value
        }
        return result
      }
      case '_real32': {
        const bytes = this.buffer.readBytes(4, false)
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, false)
      }
      case '_real64': {
        const bytes = this.buffer.readBytes(8, false)
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false)
      }
      default: throw new TypeError(`BitPackedDecoder: unsupported method ${method}`)
    }
  }
}

function firstNumber(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const key = Object.keys(value)[0]
    if (key !== undefined) return Number(value[key])
  }
  return Number(value)
}

export function decodeEventStream(data, protocol, kind, options = {}) {
  const eventTypes = kind === 'message' ? protocol.messageEventTypes : protocol.gameEventTypes
  const eventidTypeid = kind === 'message' ? protocol.messageEventidTypeid : protocol.gameEventidTypeid
  const decoder = new BitPackedDecoder(data, protocol.typeinfos, options)
  const maxEvents = options.maxEvents ?? options.maxNodes ?? 100_000
  const events = []
  let gameloop = 0
  while (!decoder.done()) {
    abort(options.signal)
    if (events.length >= maxEvents) throw new RangeError(`s2protocol: exceeds ${maxEvents} events`)
    gameloop += firstNumber(decoder.instance(protocol.svaruint32Typeid))
    // Protocol tables before build 24247 do not describe the replay user-id
    // type, although game and message streams still store the original 5-bit
    // player id between the game-loop delta and event id.
    const userid = protocol.replayUseridTypeid == null
      ? { m_userId: decoder.buffer.readBits(5) }
      : decoder.instance(protocol.replayUseridTypeid)
    const eventid = Number(decoder.instance(eventidTypeid))
    const entry = eventTypes[eventid]
    if (!entry) throw new RangeError(`s2protocol: unknown ${kind} event ${eventid} at bit ${decoder.usedBits()}`)
    const body = decoder.instance(entry[0])
    const event = body && typeof body === 'object' && !Array.isArray(body) && !(body instanceof Uint8Array) ? { ...body } : { value: body }
    event._event = entry[1]
    event._eventid = eventid
    event._gameloop = gameloop
    if (userid !== undefined) event._userid = userid
    events.push(event)
    decoder.byteAlign()
  }
  return events
}
