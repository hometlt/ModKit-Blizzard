/** Tiny little-endian buffer builder for hand-crafting test fixtures. */
export class Build {
  private parts: number[] = []

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff)
    return this
  }
  u8(v: number): this {
    this.parts.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  i16(v: number): this {
    return this.u16(v & 0xffff)
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }
  /** `n` bytes, each = `fill` (default 0). */
  pad(n: number, fill = 0): this {
    for (let i = 0; i < n; i++) this.parts.push(fill & 0xff)
    return this
  }
  bytes(...b: number[]): this {
    for (const x of b) this.parts.push(x & 0xff)
    return this
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}
