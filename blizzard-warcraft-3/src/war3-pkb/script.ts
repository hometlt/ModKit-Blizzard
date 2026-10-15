/**
 * Compiled PopcornFX scripts (`CCompilerBlobCache` records of a `.pkb` bake), decoded into their
 * constants and instructions.
 *
 * Owner: GAME-WARCRAFT3. Read-only. Measured over the 54,716 scripts of Warcraft III Reforged's
 * bakes (W3ModelViewer `mdxres/research/popcornfx-vm.md`, MIT, reference only). A blob's field 2 is
 * bytes: a header `u32[9]` = `{0, 0, constBytes, codeBytes, 0, constCount, …}`, then `constBytes` of
 * constants — 32 bytes each, one value broadcast over 8 SIMD lanes, of which the first four are the
 * value — then `codeBytes` of byte code. Field 1 is the kind (absent spawn, 3 evolve on the spawn
 * frame, 4 evolve); field 3 the externals (stream fields, `scene.dt`, samplers, events, game
 * attributes), field 4 the functions called by index.
 *
 * Operands are four bytes `u16 index, u8 space, u8 kind`. Twelve opcodes, no jumps (branches are
 * selects); every script parses to exactly its byte count. Nothing here executes a script: the
 * runtime (`runtime.ts`) does.
 */
import type { PkbBake } from './bake.js'

/** Where an operand lives: the constant table, three register spaces, a typed zero, or nothing. */
export const PK_SPACE = Object.freeze({ const: 0x00, reg1: 0x01, reg2: 0x02, reg3: 0x03, zero: 0x10, none: 0xff })

/** Operand kinds: bool, int and float of 1–4 lanes, quaternion, pointer. */
export const PK_KIND = Object.freeze({
  ptr: 0x00,
  bool: 0x02,
  bool4: 0x05,
  int: 0x1a,
  int4: 0x1d,
  float: 0x20,
  float4: 0x23,
  quaternion: 0x25,
})

/** The lanes an operand kind carries. */
export function pkLanes(kind: number): number {
  if (kind >= PK_KIND.bool && kind <= PK_KIND.bool4) return kind - PK_KIND.bool + 1
  if (kind >= PK_KIND.int && kind <= PK_KIND.int4) return kind - PK_KIND.int + 1
  if (kind >= PK_KIND.float && kind <= PK_KIND.float4) return kind - PK_KIND.float + 1
  return kind === 0x24 || kind === PK_KIND.quaternion ? 4 : 1
}

export const isPkInt = (kind: number): boolean => kind >= PK_KIND.int && kind <= PK_KIND.int4
export const isPkBool = (kind: number): boolean => kind >= PK_KIND.bool && kind <= PK_KIND.bool4

export interface PkOperand {
  readonly index: number
  readonly space: number
  readonly kind: number
}

/** The twelve opcodes. */
export const PK_OP = Object.freeze({
  load: 0x43,
  store: 0x44,
  castBits: 0x4a,
  cast: 0x4b,
  vector: 0x4c,
  swizzle: 0x4d,
  binary: 0x4e,
  unary: 0x4f,
  binary2: 0x50,
  ternary: 0x51,
  select: 0x52,
  call: 0x53,
})

export interface PkInstruction {
  readonly op: number
  /** binary/unary/binary2/ternary: the sub-operation; call: its unknown first byte. */
  readonly sub: number
  readonly dst: PkOperand
  readonly a?: PkOperand
  readonly b?: PkOperand
  readonly c?: PkOperand
  /** load/store: the external slot; call: the function index. */
  readonly slot: number
  /** call: the external slot of the object, 0xFFFF for a free function. */
  readonly self: number
  /** call: argument operands and their flags. */
  readonly args?: readonly PkOperand[]
  readonly argFlags?: readonly number[]
  /** swizzle: the packed lane codes. */
  readonly swizzle: number
  /** vector: the components. */
  readonly components?: readonly PkOperand[]
}

export interface PkScript {
  readonly record: number
  /** null spawn, 3 evolve on the spawn frame, 4 evolve. */
  readonly kind: number | null
  /** Each constant's four lanes as raw 32-bit words (floats or ints by the operand's kind). */
  readonly constants: readonly Uint32Array[]
  readonly code: readonly PkInstruction[]
  readonly externals: readonly { readonly name: string; readonly type: string }[]
  readonly functions: readonly string[]
  /** Registers used per space (1, 2, 3). */
  readonly registers: readonly [number, number, number]
}

/** Maximum script length decoded: the game's largest is a few kilobytes. */
const MAX_SCRIPT_BYTES = 1 << 20

/** Decodes the script of blob record `record`; refuses one whose sections or instructions overrun. */
export function decodePkScript(bake: PkbBake, record: number): PkScript {
  const words = bake.arrayBytes(record, 2)
  if (words.byteLength < 36) throw new RangeError(`blob #${String(record)} is too short`)
  if (words.byteLength > MAX_SCRIPT_BYTES) throw new RangeError(`blob #${String(record)} exceeds ${String(MAX_SCRIPT_BYTES)} bytes`)
  const view = new DataView(words.buffer, words.byteOffset, words.byteLength)
  const constBytes = view.getInt32(8, true)
  const codeBytes = view.getInt32(12, true)
  if (constBytes < 0 || codeBytes < 0 || 36 + constBytes + codeBytes > words.byteLength)
    throw new RangeError(`blob #${String(record)} sections overrun`)
  const constants = Array.from({ length: Math.floor(constBytes / 32) }, (_, index) =>
    Uint32Array.from([0, 1, 2, 3].map(lane => view.getUint32(36 + index * 32 + lane * 4, true))),
  )
  const registers: [number, number, number] = [0, 0, 0]
  const codeStart = 36 + constBytes
  const operand = (at: number): PkOperand => {
    const result = { index: view.getUint16(codeStart + at, true), space: words[codeStart + at + 2]!, kind: words[codeStart + at + 3]! }
    if (result.space >= 1 && result.space <= 3) registers[result.space - 1] = Math.max(registers[result.space - 1]!, result.index + 1)
    return result
  }
  const byte = (at: number) => words[codeStart + at]!
  const u16 = (at: number) => view.getUint16(codeStart + at, true)
  const code: PkInstruction[] = []
  for (let at = 0; at < codeBytes; ) {
    const op = byte(at)
    let length: number
    let instruction: PkInstruction
    const base = { op, sub: 0, slot: 0, self: 0xffff, swizzle: 0 }
    switch (op) {
      case PK_OP.load:
      case PK_OP.store:
        length = 7
        instruction = { ...base, dst: operand(at + 1), slot: u16(at + 5) }
        break
      case PK_OP.castBits:
      case PK_OP.cast:
        length = 9
        instruction = { ...base, dst: operand(at + 1), a: operand(at + 5) }
        break
      case PK_OP.vector: {
        const count = byte(at + 1) + 1
        length = 2 + 4 * (count + 1)
        instruction = {
          ...base,
          dst: operand(at + 2),
          components: Array.from({ length: count }, (_, index) => operand(at + 6 + 4 * index)),
        }
        break
      }
      case PK_OP.swizzle:
        length = 12
        instruction = { ...base, swizzle: byte(at + 1) | (byte(at + 2) << 8) | (byte(at + 3) << 16), dst: operand(at + 4), a: operand(at + 8) }
        break
      case PK_OP.binary:
      case PK_OP.binary2:
        length = 14
        instruction = { ...base, sub: byte(at + 1), dst: operand(at + 2), a: operand(at + 6), b: operand(at + 10) }
        break
      case PK_OP.unary:
        length = 10
        instruction = { ...base, sub: byte(at + 1), dst: operand(at + 2), a: operand(at + 6) }
        break
      case PK_OP.ternary:
        length = 18
        instruction = { ...base, sub: byte(at + 1), dst: operand(at + 2), a: operand(at + 6), b: operand(at + 10), c: operand(at + 14) }
        break
      case PK_OP.select:
        length = 17
        instruction = { ...base, dst: operand(at + 1), a: operand(at + 5), b: operand(at + 9), c: operand(at + 13) }
        break
      case PK_OP.call: {
        const count = byte(at + 6)
        length = 11 + 5 * count
        if (at + length > codeBytes) throw new RangeError(`blob #${String(record)}: call at ${String(at)} overruns the code`)
        instruction = {
          ...base,
          sub: byte(at + 1),
          self: u16(at + 2),
          slot: u16(at + 4),
          dst: operand(at + 7),
          argFlags: Array.from({ length: count }, (_, index) => byte(at + 11 + 5 * index)),
          args: Array.from({ length: count }, (_, index) => operand(at + 12 + 5 * index)),
        }
        break
      }
      default:
        throw new RangeError(`blob #${String(record)}: unknown opcode 0x${op.toString(16)} at ${String(at)}`)
    }
    if (at + length > codeBytes) throw new RangeError(`blob #${String(record)}: instruction at ${String(at)} overruns the code`)
    code.push(instruction)
    at += length
  }
  return {
    record,
    kind: bake.has(record, 1) ? bake.i32(record, 1) : null,
    constants,
    code,
    externals: bake.refs(record, 3).map(external => ({
      name: external < 0 ? '' : bake.text(external, 0),
      type: external < 0 ? '' : bake.text(external, 1),
    })),
    functions: bake.refs(record, 4).map(fn => (fn < 0 ? '' : bake.text(fn, 0))),
    registers,
  }
}

/**
 * A swizzle's lane code: lanes 0 and 1 take 3 bits at bits 8 and 11, lane 2 two bits at 14 with a
 * constant flag at bit 20, lane 3 three bits at 21. Codes 0–3 pick a source lane, 4 is 0.0, 5 is 1.0
 * (lane 2 with its flag set is 0.0 or 1.0 by its 2-bit code).
 */
export function pkLaneCode(packed: number, lane: number): number {
  if (lane === 0) return (packed >> 8) & 7
  if (lane === 1) return (packed >> 11) & 7
  if (lane === 2) return ((packed >> 20) & 1) !== 0 ? 4 + ((packed >> 14) & 3) : (packed >> 14) & 3
  return (packed >> 21) & 7
}
