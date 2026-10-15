/**
 * Browser-safe little-endian binary cursors.
 *
 * Uses `DataView` + `TextEncoder`/`TextDecoder` only — no `node:*`, no
 * `Buffer.readUInt32LE`. Shared by every format codec in this package.
 */

const ascii = new TextDecoder('ascii')

/** Sequential little-endian reader over a Uint8Array. */
export class Cursor {
  readonly view: DataView
  readonly bytes: Uint8Array
  offset: number

  constructor(data: Uint8Array, offset = 0) {
    this.bytes = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.offset = offset
  }

  get length(): number {
    return this.bytes.length
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  /** Bytes left to read must be at least `n`, else throw with `what`. */
  require(n: number, what: string): void {
    if (this.remaining < n) {
      throw new Error(
        `Truncated ${what}: need ${n} more byte(s) at offset ${this.offset}, ` +
          `only ${this.remaining} remain (file is ${this.length} bytes)`,
      )
    }
  }

  u8(): number {
    this.require(1, 'u8')
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    this.require(2, 'u16')
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  i16(): number {
    this.require(2, 'i16')
    const v = this.view.getInt16(this.offset, true)
    this.offset += 2
    return v
  }

  u32(): number {
    this.require(4, 'u32')
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  i32(): number {
    this.require(4, 'i32')
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  f32(): number {
    this.require(4, 'f32')
    const v = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return v
  }

  /** Read `n` raw bytes as a copy. */
  bytesOf(n: number): Uint8Array {
    this.require(n, `${n}-byte block`)
    const out = this.bytes.slice(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  /** Read a fixed-length ASCII string (e.g. a 4-byte magic). */
  ascii(n: number): string {
    this.require(n, `${n}-char ascii`)
    const s = ascii.decode(this.bytes.subarray(this.offset, this.offset + n))
    this.offset += n
    return s
  }

  /** All remaining bytes as a copy. */
  rest(): Uint8Array {
    const out = this.bytes.slice(this.offset)
    this.offset = this.bytes.length
    return out
  }
}

/** Growable little-endian writer. */
export class Writer {
  private buf: Uint8Array
  private view: DataView
  private pos = 0

  constructor(initial = 64) {
    this.buf = new Uint8Array(initial)
    this.view = new DataView(this.buf.buffer)
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.pos + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(this.buf.buffer)
  }

  u8(v: number): this {
    this.ensure(1)
    this.view.setUint8(this.pos++, v)
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.pos, v, true)
    this.pos += 2
    return this
  }

  i16(v: number): this {
    this.ensure(2)
    this.view.setInt16(this.pos, v, true)
    this.pos += 2
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.pos, v, true)
    this.pos += 4
    return this
  }

  i32(v: number): this {
    this.ensure(4)
    this.view.setInt32(this.pos, v, true)
    this.pos += 4
    return this
  }

  f32(v: number): this {
    this.ensure(4)
    this.view.setFloat32(this.pos, v, true)
    this.pos += 4
    return this
  }

  /** Write a 4-char ASCII magic (or any short ascii). Throws if longer than the slot. */
  ascii(s: string): this {
    this.ensure(s.length)
    for (let i = 0; i < s.length; i++) this.view.setUint8(this.pos++, s.charCodeAt(i) & 0xff)
    return this
  }

  /** Append raw bytes verbatim (used to re-emit preserved unknown/padding). */
  raw(b: Uint8Array): this {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
    return this
  }

  /** Final byte array (a copy trimmed to the written length). */
  done(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}
