/**
 * A small x86-64 interpreter for the code that builds Diablo III's type registry.
 *
 * The game declares every SNO structure through C++ static initializers: straight-line code that
 * stores names, offsets and type pointers into descriptor objects when the process starts. The
 * executable on disk holds that code, not the descriptors, so the registry is recovered by running
 * the initializers here against the mapped image. They use a narrow slice of the instruction set
 * (MOV, LEA, ALU, stack, calls, conditional jumps, 16-byte SSE moves); anything outside it stops
 * the one initializer that met it and leaves the rest of the image as it was.
 *
 * Calls that leave the image (imports: allocators, locks, atexit plumbing) return zero.
 */

export interface ImageSection {
  /** Relative virtual address of the section. */
  readonly virtualAddress: number
  readonly virtualSize: number
  /** The section's bytes as stored in the file; the rest of `virtualSize` is zero. */
  readonly bytes: Uint8Array
  readonly executable: boolean
}

export interface ExecutableImage {
  readonly imageBase: bigint
  readonly sections: readonly ImageSection[]
}

export type RunOutcome =
  | { readonly state: 'returned'; readonly steps: number }
  | { readonly state: 'stopped'; readonly steps: number; readonly reason: string }

const MASK64 = (1n << 64n) - 1n
const STACK_BASE = 0x7f_0000_0000n
const STACK_SIZE = 0x10_0000
const TLS_BASE = 0x7e_0000_0000n
const TLS_SIZE = 0x1_0000
/** Where an initializer returns to: outside every mapped region. */
const RETURN = 0x7d_0000_0000n

class Stop extends Error {}

const SIZE_MASK: Readonly<Record<number, bigint>> = { 1: 0xffn, 2: 0xffffn, 4: 0xffff_ffffn, 8: MASK64 }
const SIGN: Readonly<Record<number, bigint>> = { 1: 0x80n, 2: 0x8000n, 4: 0x8000_0000n, 8: 1n << 63n }

function signed(value: bigint, size: number): bigint {
  const mask = SIZE_MASK[size]!
  const v = value & mask
  return v & SIGN[size]! ? v - mask - 1n : v
}

/** One operand the decoder resolved: a register (index, width, high byte) or a memory address. */
type Operand =
  | { readonly kind: 'reg'; readonly index: number; readonly high: boolean }
  | { readonly kind: 'mem'; readonly address: bigint }

export class X64Machine {
  readonly #image: Uint8Array
  readonly #imageView: DataView
  readonly #base: bigint
  readonly #executable: { readonly start: bigint; readonly end: bigint }[]
  readonly #stack = new Uint8Array(STACK_SIZE)
  readonly #tls = new Uint8Array(TLS_SIZE)
  readonly #regs = new BigUint64Array(16)
  readonly #xmm = Array.from({ length: 16 }, () => new Uint8Array(16))
  #rip = 0n
  #cf = false
  #zf = false
  #sf = false
  #of = false

  constructor(image: ExecutableImage) {
    const size = Math.max(...image.sections.map(section => section.virtualAddress + Math.max(section.virtualSize, section.bytes.byteLength)))
    this.#image = new Uint8Array(size)
    for (const section of image.sections) this.#image.set(section.bytes.subarray(0, Math.min(section.bytes.byteLength, size - section.virtualAddress)), section.virtualAddress)
    this.#imageView = new DataView(this.#image.buffer)
    this.#base = image.imageBase
    this.#executable = image.sections
      .filter(section => section.executable)
      .map(section => ({
        start: image.imageBase + BigInt(section.virtualAddress),
        end: image.imageBase + BigInt(section.virtualAddress + section.virtualSize),
      }))
  }

  /** The image as the initializers left it, indexed by RVA. */
  get memory(): Uint8Array {
    return this.#image
  }

  get imageBase(): bigint {
    return this.#base
  }

  // ---- memory

  #locate(address: bigint, length: number): { bytes: Uint8Array; offset: number } {
    const imageOffset = address - this.#base
    if (imageOffset >= 0n && imageOffset + BigInt(length) <= BigInt(this.#image.byteLength))
      return { bytes: this.#image, offset: Number(imageOffset) }
    const stackOffset = address - STACK_BASE
    if (stackOffset >= 0n && stackOffset + BigInt(length) <= BigInt(STACK_SIZE)) return { bytes: this.#stack, offset: Number(stackOffset) }
    const tlsOffset = address - TLS_BASE
    if (tlsOffset >= 0n && tlsOffset + BigInt(length) <= BigInt(TLS_SIZE)) return { bytes: this.#tls, offset: Number(tlsOffset) }
    throw new Stop(`memory access outside the image at 0x${address.toString(16)}`)
  }

  read(address: bigint, size: number): bigint {
    const { bytes, offset } = this.#locate(address, size)
    let value = 0n
    for (let index = size - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]!)
    return value
  }

  #write(address: bigint, size: number, value: bigint): void {
    const { bytes, offset } = this.#locate(address, size)
    let v = value & SIZE_MASK[size]!
    for (let index = 0; index < size; index += 1) {
      bytes[offset + index] = Number(v & 0xffn)
      v >>= 8n
    }
  }

  #readBytes(address: bigint, length: number): Uint8Array {
    const { bytes, offset } = this.#locate(address, length)
    return bytes.slice(offset, offset + length)
  }

  #writeBytes(address: bigint, value: Uint8Array): void {
    const { bytes, offset } = this.#locate(address, value.byteLength)
    bytes.set(value, offset)
  }

  #fetch(size: number): bigint {
    const value = this.read(this.#rip, size)
    this.#rip += BigInt(size)
    return value
  }

  // ---- registers

  #getReg(operand: { index: number; high: boolean }, size: number): bigint {
    if (operand.high) return (this.#regs[operand.index]! >> 8n) & 0xffn
    return this.#regs[operand.index]! & SIZE_MASK[size]!
  }

  #setReg(operand: { index: number; high: boolean }, size: number, value: bigint): void {
    const current = this.#regs[operand.index]!
    if (operand.high) this.#regs[operand.index] = (current & ~0xff00n) | ((value & 0xffn) << 8n)
    else if (size === 8 || size === 4) this.#regs[operand.index] = value & SIZE_MASK[size]! // 32-bit writes zero the top
    else this.#regs[operand.index] = (current & ~SIZE_MASK[size]!) | (value & SIZE_MASK[size]!)
  }

  #get(operand: Operand, size: number): bigint {
    return operand.kind === 'reg' ? this.#getReg(operand, size) : this.read(operand.address, size)
  }

  #set(operand: Operand, size: number, value: bigint): void {
    if (operand.kind === 'reg') this.#setReg(operand, size, value)
    else this.#write(operand.address, size, value)
  }

  #push(value: bigint): void {
    this.#regs[4] = (this.#regs[4]! - 8n) & MASK64
    this.#write(this.#regs[4]!, 8, value)
  }

  #pop(): bigint {
    const value = this.read(this.#regs[4]!, 8)
    this.#regs[4] = (this.#regs[4]! + 8n) & MASK64
    return value
  }

  // ---- flags

  #logic(result: bigint, size: number): bigint {
    const r = result & SIZE_MASK[size]!
    this.#cf = false
    this.#of = false
    this.#zf = r === 0n
    this.#sf = (r & SIGN[size]!) !== 0n
    return r
  }

  #alu(op: number, a: bigint, b: bigint, size: number): bigint | undefined {
    const mask = SIZE_MASK[size]!
    switch (op) {
      case 0: // ADD
      case 2: {
        // ADC
        const carry = op === 2 && this.#cf ? 1n : 0n
        const full = (a & mask) + (b & mask) + carry
        const r = full & mask
        this.#cf = full > mask
        this.#of = ((a ^ r) & (b ^ r) & SIGN[size]!) !== 0n
        this.#zf = r === 0n
        this.#sf = (r & SIGN[size]!) !== 0n
        return r
      }
      case 1:
        return this.#logic(a | b, size)
      case 4:
        return this.#logic(a & b, size)
      case 6:
        return this.#logic(a ^ b, size)
      case 3: // SBB
      case 5: // SUB
      case 7: {
        // CMP
        const borrow = op === 3 && this.#cf ? 1n : 0n
        const full = (a & mask) - (b & mask) - borrow
        const r = full & mask
        this.#cf = (a & mask) < (b & mask) + borrow
        this.#of = ((a ^ b) & (a ^ r) & SIGN[size]!) !== 0n
        this.#zf = r === 0n
        this.#sf = (r & SIGN[size]!) !== 0n
        return op === 7 ? undefined : r
      }
    }
    return undefined
  }

  #condition(code: number): boolean {
    let result: boolean
    switch (code >> 1) {
      case 0: result = this.#of; break
      case 1: result = this.#cf; break
      case 2: result = this.#zf; break
      case 3: result = this.#cf || this.#zf; break
      case 4: result = this.#sf; break
      case 5: throw new Stop('parity flag is not tracked')
      case 6: result = this.#sf !== this.#of; break
      default: result = this.#zf || this.#sf !== this.#of
    }
    return code & 1 ? !result : result
  }

  // ---- decoding

  #modrm(rex: number, segment: bigint, immediateAfter: number): { reg: number; rm: Operand; mod: number } {
    const modrm = Number(this.#fetch(1))
    const mod = modrm >> 6
    const reg = ((modrm >> 3) & 7) | (rex & 4 ? 8 : 0)
    let rm = modrm & 7
    if (mod === 3) return { reg, mod, rm: { kind: 'reg', index: rm | (rex & 1 ? 8 : 0), high: false } }
    let address = 0n
    if (rm === 4) {
      const sib = Number(this.#fetch(1))
      const scale = 1n << BigInt(sib >> 6)
      const index = ((sib >> 3) & 7) | (rex & 2 ? 8 : 0)
      const base = (sib & 7) | (rex & 1 ? 8 : 0)
      if (index !== 4) address += this.#regs[index]! * scale
      if ((sib & 7) === 5 && mod === 0) address += signed(this.#fetch(4), 4)
      else address += this.#regs[base]!
    } else if (rm === 5 && mod === 0) {
      const displacement = signed(this.#fetch(4), 4)
      // RIP-relative: relative to the end of the whole instruction, immediate included
      return { reg, mod, rm: { kind: 'mem', address: (this.#rip + BigInt(immediateAfter) + displacement + segment) & MASK64 } }
    } else {
      rm |= rex & 1 ? 8 : 0
      address += this.#regs[rm]!
    }
    if (mod === 1) address += signed(this.#fetch(1), 1)
    else if (mod === 2) address += signed(this.#fetch(4), 4)
    return { reg, mod, rm: { kind: 'mem', address: (address + segment) & MASK64 } }
  }

  /** Registers in a byte operation: without REX, 4–7 name AH, CH, DH, BH. */
  static #byteReg(index: number, rex: number): { index: number; high: boolean } {
    return rex === 0 && index >= 4 && index < 8 ? { index: index - 4, high: true } : { index, high: false }
  }

  #byteOperand(operand: Operand, rex: number): Operand {
    return operand.kind === 'reg' ? { kind: 'reg', ...X64Machine.#byteReg(operand.index, rex) } : operand
  }

  #step(): void {
    let rex = 0
    let operandSize = 4
    let segment = 0n
    let repeat = 0
    for (;;) {
      const byte = Number(this.read(this.#rip, 1))
      if (byte === 0x66) operandSize = 2
      else if (byte === 0x65) segment = TLS_BASE
      else if (byte === 0x64) segment = TLS_BASE
      else if (byte === 0xf2 || byte === 0xf3) repeat = byte
      else if (byte === 0x2e || byte === 0x3e || byte === 0x26 || byte === 0x36) {
        // null segment overrides and branch hints
      } else break
      this.#rip += 1n
    }
    let opcode = Number(this.#fetch(1))
    if (opcode >= 0x40 && opcode <= 0x4f) {
      rex = opcode
      opcode = Number(this.#fetch(1))
    }
    if (rex & 8) operandSize = 8
    const size = operandSize
    const immediate = (width: number) => signed(this.#fetch(Math.min(width, 4)), Math.min(width, 4)) & SIZE_MASK[width]!

    if (opcode === 0x0f) return this.#twoByte(rex, size, segment, repeat)

    // ALU family 00–3F
    if (opcode < 0x40 && (opcode & 7) < 6) {
      const op = opcode >> 3
      const form = opcode & 7
      if (form === 4 || form === 5) {
        const width = form === 4 ? 1 : size
        const value = immediate(width)
        const accumulator: Operand = { kind: 'reg', index: 0, high: false }
        const result = this.#alu(op, this.#get(accumulator, width), value, width)
        if (result !== undefined) this.#set(accumulator, width, result)
        return
      }
      const width = form & 1 ? size : 1
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const regOperand: Operand = width === 1 ? { kind: 'reg', ...X64Machine.#byteReg(reg, rex) } : { kind: 'reg', index: reg, high: false }
      const rmOperand = width === 1 ? this.#byteOperand(rm, rex) : rm
      const [destination, source] = form < 2 ? [rmOperand, regOperand] : [regOperand, rmOperand]
      const result = this.#alu(op, this.#get(destination, width), this.#get(source, width), width)
      if (result !== undefined) this.#set(destination, width, result)
      return
    }
    if (opcode >= 0x50 && opcode <= 0x57) return this.#push(this.#regs[(opcode & 7) | (rex & 1 ? 8 : 0)]!)
    if (opcode >= 0x58 && opcode <= 0x5f) {
      this.#regs[(opcode & 7) | (rex & 1 ? 8 : 0)] = this.#pop()
      return
    }
    if (opcode === 0x63) {
      const { reg, rm } = this.#modrm(rex, segment, 0)
      this.#setReg({ index: reg, high: false }, size, signed(this.#get(rm, 4), 4))
      return
    }
    if (opcode === 0x68) return this.#push(signed(this.#fetch(4), 4) & MASK64)
    if (opcode === 0x6a) return this.#push(signed(this.#fetch(1), 1) & MASK64)
    if (opcode >= 0x70 && opcode <= 0x7f) {
      const displacement = signed(this.#fetch(1), 1)
      if (this.#condition(opcode & 0xf)) this.#rip = (this.#rip + displacement) & MASK64
      return
    }
    if (opcode === 0x80 || opcode === 0x81 || opcode === 0x83) {
      const width = opcode === 0x80 ? 1 : size
      const immediateSize = opcode === 0x81 ? Math.min(width, 4) : 1
      const { reg, rm } = this.#modrm(rex, segment, immediateSize)
      const operand = width === 1 ? this.#byteOperand(rm, rex) : rm
      const value = signed(this.#fetch(immediateSize), immediateSize) & SIZE_MASK[width]!
      const result = this.#alu(reg & 7, this.#get(operand, width), value, width)
      if (result !== undefined) this.#set(operand, width, result)
      return
    }
    if (opcode === 0x84 || opcode === 0x85) {
      const width = opcode === 0x84 ? 1 : size
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const regOperand: Operand = width === 1 ? { kind: 'reg', ...X64Machine.#byteReg(reg, rex) } : { kind: 'reg', index: reg, high: false }
      this.#logic(this.#get(width === 1 ? this.#byteOperand(rm, rex) : rm, width) & this.#get(regOperand, width), width)
      return
    }
    if (opcode === 0x86 || opcode === 0x87) {
      const width = opcode === 0x86 ? 1 : size
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const regOperand: Operand = width === 1 ? { kind: 'reg', ...X64Machine.#byteReg(reg, rex) } : { kind: 'reg', index: reg, high: false }
      const rmOperand = width === 1 ? this.#byteOperand(rm, rex) : rm
      const a = this.#get(rmOperand, width)
      this.#set(rmOperand, width, this.#get(regOperand, width))
      this.#set(regOperand, width, a)
      return
    }
    if (opcode >= 0x88 && opcode <= 0x8b) {
      const width = opcode & 1 ? size : 1
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const regOperand: Operand = width === 1 ? { kind: 'reg', ...X64Machine.#byteReg(reg, rex) } : { kind: 'reg', index: reg, high: false }
      const rmOperand = width === 1 ? this.#byteOperand(rm, rex) : rm
      if (opcode < 0x8a) this.#set(rmOperand, width, this.#get(regOperand, width))
      else this.#set(regOperand, width, this.#get(rmOperand, width))
      return
    }
    if (opcode === 0x8d) {
      const { reg, rm } = this.#modrm(rex, 0n, 0)
      if (rm.kind !== 'mem') throw new Stop('LEA of a register')
      this.#setReg({ index: reg, high: false }, size, rm.address)
      return
    }
    if (opcode === 0x8f) {
      const { rm } = this.#modrm(rex, segment, 0)
      this.#set(rm, 8, this.#pop())
      return
    }
    if (opcode === 0x90) return
    if (opcode === 0x98) {
      const accumulator = { index: 0, high: false }
      if (size === 8) this.#setReg(accumulator, 8, signed(this.#getReg(accumulator, 4), 4))
      else this.#setReg(accumulator, 4, signed(this.#getReg(accumulator, 2), 2))
      return
    }
    if (opcode === 0x99) {
      const negative = (this.#getReg({ index: 0, high: false }, size) & SIGN[size]!) !== 0n
      this.#setReg({ index: 2, high: false }, size, negative ? SIZE_MASK[size]! : 0n)
      return
    }
    if (opcode === 0xa8 || opcode === 0xa9) {
      const width = opcode === 0xa8 ? 1 : size
      this.#logic(this.#getReg({ index: 0, high: false }, width) & immediate(width), width)
      return
    }
    if (opcode >= 0xb0 && opcode <= 0xb7) {
      this.#setReg(X64Machine.#byteReg((opcode & 7) | (rex & 1 ? 8 : 0), rex), 1, this.#fetch(1))
      return
    }
    if (opcode >= 0xb8 && opcode <= 0xbf) {
      this.#setReg({ index: (opcode & 7) | (rex & 1 ? 8 : 0), high: false }, size, this.#fetch(size))
      return
    }
    if (opcode === 0xc0 || opcode === 0xc1 || (opcode >= 0xd0 && opcode <= 0xd3)) {
      const width = opcode & 1 ? size : 1
      const { reg, rm } = this.#modrm(rex, segment, opcode <= 0xc1 ? 1 : 0)
      const operand = width === 1 ? this.#byteOperand(rm, rex) : rm
      const count =
        opcode <= 0xc1 ? Number(this.#fetch(1)) : opcode <= 0xd1 ? 1 : Number(this.#regs[1]! & 0xffn)
      return this.#shift(reg & 7, operand, width, count & (width === 8 ? 63 : 31))
    }
    if (opcode === 0xc2) {
      const release = this.#fetch(2)
      this.#rip = this.#pop()
      this.#regs[4] = (this.#regs[4]! + release) & MASK64
      return
    }
    if (opcode === 0xc3) {
      this.#rip = this.#pop()
      return
    }
    if (opcode === 0xc6 || opcode === 0xc7) {
      const width = opcode === 0xc6 ? 1 : size
      const immediateSize = Math.min(width, 4)
      const { rm } = this.#modrm(rex, segment, immediateSize)
      this.#set(width === 1 ? this.#byteOperand(rm, rex) : rm, width, signed(this.#fetch(immediateSize), immediateSize) & SIZE_MASK[width]!)
      return
    }
    if (opcode === 0xe8) {
      const displacement = signed(this.#fetch(4), 4)
      this.#call((this.#rip + displacement) & MASK64)
      return
    }
    if (opcode === 0xe9) {
      const displacement = signed(this.#fetch(4), 4)
      this.#jump((this.#rip + displacement) & MASK64)
      return
    }
    if (opcode === 0xeb) {
      const displacement = signed(this.#fetch(1), 1)
      this.#rip = (this.#rip + displacement) & MASK64
      return
    }
    if (opcode === 0xf6 || opcode === 0xf7) {
      const width = opcode === 0xf6 ? 1 : size
      const peek = Number((this.read(this.#rip, 1) >> 3n) & 7n)
      const { reg, rm } = this.#modrm(rex, segment, peek < 2 ? Math.min(width, 4) : 0)
      const operand = width === 1 ? this.#byteOperand(rm, rex) : rm
      switch (reg & 7) {
        case 0:
        case 1:
          this.#logic(this.#get(operand, width) & immediate(width), width)
          return
        case 2:
          this.#set(operand, width, ~this.#get(operand, width))
          return
        case 3: {
          const value = this.#get(operand, width)
          const result = this.#alu(5, 0n, value, width)!
          this.#cf = value !== 0n
          this.#set(operand, width, result)
          return
        }
      }
      throw new Stop(`group 3 /${reg & 7}`)
    }
    if (opcode === 0xfe || opcode === 0xff) {
      const width = opcode === 0xfe ? 1 : size
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const operand = width === 1 ? this.#byteOperand(rm, rex) : rm
      switch (reg & 7) {
        case 0:
        case 1: {
          const carry = this.#cf
          const result = this.#alu(reg & 7 ? 5 : 0, this.#get(operand, width), 1n, width)!
          this.#cf = carry // INC and DEC leave CF alone
          this.#set(operand, width, result)
          return
        }
        case 2:
          return this.#call(this.#get(rm, 8))
        case 4:
          return this.#jump(this.#get(rm, 8))
        case 6:
          return this.#push(this.#get(rm, 8))
      }
      throw new Stop(`group 5 /${reg & 7}`)
    }
    if (opcode === 0xcc) throw new Stop('breakpoint')
    throw new Stop(`opcode 0x${opcode.toString(16)}`)
  }

  #twoByte(rex: number, size: number, segment: bigint, repeat: number): void {
    const opcode = Number(this.#fetch(1))
    if (opcode === 0x10 || opcode === 0x11 || opcode === 0x28 || opcode === 0x29 || opcode === 0x6f || opcode === 0x7f) {
      // MOVUPS/MOVUPD/MOVAPS/MOVDQU/MOVDQA; with F3/F2 on 10/11 a scalar MOVSS/MOVSD
      const width = (opcode === 0x10 || opcode === 0x11) && repeat === 0xf3 ? 4 : (opcode === 0x10 || opcode === 0x11) && repeat === 0xf2 ? 8 : 16
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const store = opcode === 0x11 || opcode === 0x29 || opcode === 0x7f
      const xmm = this.#xmm[reg]!
      if (store) {
        if (rm.kind === 'mem') this.#writeBytes(rm.address, xmm.subarray(0, width))
        else this.#xmm[rm.index]!.set(xmm.subarray(0, width))
      } else if (rm.kind === 'mem') {
        xmm.fill(0)
        xmm.set(this.#readBytes(rm.address, width))
      } else xmm.set(this.#xmm[rm.index]!.subarray(0, width))
      return
    }
    if (opcode === 0x57 || opcode === 0xef) {
      // XORPS / PXOR
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const source = rm.kind === 'mem' ? this.#readBytes(rm.address, 16) : this.#xmm[rm.index]!
      const target = this.#xmm[reg]!
      for (let index = 0; index < 16; index += 1) target[index] = target[index]! ^ source[index]!
      return
    }
    if (opcode === 0x1f) {
      this.#modrm(rex, segment, 0) // multi-byte NOP
      return
    }
    if (opcode >= 0x40 && opcode <= 0x4f) {
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const value = this.#get(rm, size)
      if (this.#condition(opcode & 0xf)) this.#setReg({ index: reg, high: false }, size, value)
      else if (size === 4) this.#setReg({ index: reg, high: false }, 4, this.#getReg({ index: reg, high: false }, 4))
      return
    }
    if (opcode >= 0x80 && opcode <= 0x8f) {
      const displacement = signed(this.#fetch(4), 4)
      if (this.#condition(opcode & 0xf)) this.#rip = (this.#rip + displacement) & MASK64
      return
    }
    if (opcode >= 0x90 && opcode <= 0x9f) {
      const { rm } = this.#modrm(rex, segment, 0)
      this.#set(this.#byteOperand(rm, rex), 1, this.#condition(opcode & 0xf) ? 1n : 0n)
      return
    }
    if (opcode === 0xb6 || opcode === 0xb7 || opcode === 0xbe || opcode === 0xbf) {
      const width = opcode & 1 ? 2 : 1
      const { reg, rm } = this.#modrm(rex, segment, 0)
      const value = this.#get(width === 1 ? this.#byteOperand(rm, rex) : rm, width)
      this.#setReg({ index: reg, high: false }, size, opcode >= 0xbe ? signed(value, width) & SIZE_MASK[size]! : value)
      return
    }
    throw new Stop(`opcode 0x0f 0x${opcode.toString(16)}`)
  }

  #shift(kind: number, operand: Operand, width: number, count: number): void {
    if (count === 0) return
    const bits = BigInt(width * 8)
    const mask = SIZE_MASK[width]!
    const value = this.#get(operand, width)
    const n = BigInt(count) % bits
    let result: bigint
    switch (kind) {
      case 0: // ROL
        result = ((value << n) | (value >> (bits - n))) & mask
        this.#cf = (result & 1n) !== 0n
        break
      case 1: // ROR
        result = ((value >> n) | (value << (bits - n))) & mask
        this.#cf = (result & SIGN[width]!) !== 0n
        break
      case 4: // SHL
        this.#cf = ((value >> (bits - BigInt(count))) & 1n) !== 0n
        result = this.#logic(value << BigInt(count), width)
        break
      case 5: // SHR
        this.#cf = ((value >> BigInt(count - 1)) & 1n) !== 0n
        result = this.#logic(value >> BigInt(count), width)
        break
      case 7: // SAR
        this.#cf = ((signed(value, width) >> BigInt(count - 1)) & 1n) !== 0n
        result = this.#logic(signed(value, width) >> BigInt(count), width)
        break
      default:
        throw new Stop(`shift /${kind}`)
    }
    this.#set(operand, width, result)
  }

  #inImage(address: bigint): boolean {
    return this.#executable.some(section => address >= section.start && address < section.end)
  }

  #call(target: bigint): void {
    if (!this.#inImage(target)) {
      // an import or anything the image does not hold: a function that returns zero
      this.#regs[0] = 0n
      return
    }
    this.#push(this.#rip)
    this.#rip = target
  }

  #jump(target: bigint): void {
    if (!this.#inImage(target) && target !== RETURN) {
      // a tail call out of the image returns zero to our caller
      this.#regs[0] = 0n
      this.#rip = this.#pop()
      return
    }
    this.#rip = target
  }

  /** Runs one function from its entry until it returns, within `maxSteps` instructions. */
  run(entry: bigint, maxSteps = 200_000): RunOutcome {
    this.#regs.fill(0n)
    this.#regs[4] = STACK_BASE + BigInt(STACK_SIZE - 0x1000)
    this.#push(RETURN)
    this.#rip = entry
    let steps = 0
    try {
      while (this.#rip !== RETURN) {
        if (++steps > maxSteps) return { state: 'stopped', steps, reason: 'step budget exhausted' }
        this.#step()
      }
      return { state: 'returned', steps }
    } catch (error) {
      if (error instanceof Stop) return { state: 'stopped', steps, reason: `${error.message} at 0x${this.#rip.toString(16)}` }
      throw error
    }
  }
}
