import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const { X64Machine } = (await import(pathToFileURL(join(extension, 'dist', 'diablo3-sno', 'x64.js')).href)) as typeof import('../dist/diablo3-sno/x64.js')
const { extractSnoTypeRegistry } = (await import(pathToFileURL(join(extension, 'dist', 'diablo3-sno', 'registry.js')).href)) as typeof import('../dist/diablo3-sno/registry.js')
const { SnoDecoder } = (await import(pathToFileURL(join(extension, 'dist', 'diablo3-sno', 'decode.js')).href)) as typeof import('../dist/diablo3-sno/decode.js')

const BASE = 0x1_4000_0000n
const TEXT = 0x1000
const DATA = 0x2000

/** A two-section image: code at 0x1000 and data at 0x2000 (with room past the stored bytes). */
function image(code: readonly number[], data: Uint8Array = new Uint8Array(0x100)) {
  return {
    imageBase: BASE,
    sections: [
      { virtualAddress: TEXT, virtualSize: 0x1000, bytes: Uint8Array.from(code), executable: true },
      { virtualAddress: DATA, virtualSize: 0x2000, bytes: data, executable: false },
    ],
  }
}

/** Little-endian bytes of a 32-bit displacement from the end of an instruction at `end` to `target`. */
const rel32 = (end: number, target: number) => {
  const value = target - end
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

describe('x86-64 interpreter for the registry initializers', () => {
  it('stores through RIP-relative operands, including after an immediate', () => {
    // lea rax,[rip+→0x2010]; mov [rip+→0x2000],rax; mov dword [rip+→0x2008],7; ret
    const code = [
      0x48, 0x8d, 0x05, ...rel32(TEXT + 7, DATA + 0x10),
      0x48, 0x89, 0x05, ...rel32(TEXT + 14, DATA),
      0xc7, 0x05, ...rel32(TEXT + 24, DATA + 8), 7, 0, 0, 0,
      0xc3,
    ]
    const machine = new X64Machine(image(code))
    expect(machine.run(BASE + BigInt(TEXT)).state).toBe('returned')
    expect(machine.read(BASE + BigInt(DATA), 8)).toBe(BASE + BigInt(DATA + 0x10))
    expect(machine.read(BASE + BigInt(DATA + 8), 4)).toBe(7n)
  })

  it('follows flags through compare, conditional move and branch, and calls into the image', () => {
    // xor ecx,ecx; cmp ecx,0; mov edx,5; cmovz ecx,edx; jnz +7 (skipped); call f; ret
    // f: mov [rip+→0x2000],ecx; ret
    const f = TEXT + 0x40
    const code = [
      0x31, 0xc9,
      0x83, 0xf9, 0x00,
      0xba, 5, 0, 0, 0,
      0x0f, 0x44, 0xca,
      0x75, 0x05,
      0xe8, ...rel32(TEXT + 20, f),
      0xc3,
    ]
    const bytes = new Array<number>(0x60).fill(0xcc)
    bytes.splice(0, code.length, ...code)
    bytes.splice(0x40, 7, 0x89, 0x0d, ...rel32(f + 6, DATA), 0xc3)
    const machine = new X64Machine(image(bytes))
    expect(machine.run(BASE + BigInt(TEXT)).state).toBe('returned')
    expect(machine.read(BASE + BigInt(DATA), 4)).toBe(5n)
  })

  it('copies 16 bytes with MOVUPS and treats a call out of the image as returning zero', () => {
    const data = new Uint8Array(0x100)
    data.set(Array.from({ length: 16 }, (_, index) => index + 1), 0x20)
    // mov rax,-1; call [rip+→0x2040] (an import slot holding a foreign address); movups xmm0,[rip+→0x2020];
    // movups [rip+→0x2030],xmm0; mov [rip+→0x2050],rax; ret
    const code = [
      0x48, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff,
      0xff, 0x15, ...rel32(TEXT + 13, DATA + 0x40),
      0x0f, 0x10, 0x05, ...rel32(TEXT + 20, DATA + 0x20),
      0x0f, 0x11, 0x05, ...rel32(TEXT + 27, DATA + 0x30),
      0x48, 0x89, 0x05, ...rel32(TEXT + 34, DATA + 0x50),
      0xc3,
    ]
    new DataView(data.buffer).setBigUint64(0x40, 0x7ff0_0000_0000n, true)
    const machine = new X64Machine(image(code, data))
    expect(machine.run(BASE + BigInt(TEXT)).state).toBe('returned')
    expect(machine.read(BASE + BigInt(DATA + 0x30), 8)).toBe(0x0807060504030201n)
    expect(machine.read(BASE + BigInt(DATA + 0x50), 8)).toBe(0n)
  })

  it('stops an initializer at an instruction it does not model, leaving the others', () => {
    const machine = new X64Machine(image([0x0f, 0x0b])) // ud2
    const outcome = machine.run(BASE + BigInt(TEXT))
    expect(outcome.state).toBe('stopped')
  })
})

describe('SNO type registry', () => {
  it('recognizes a structure its initializer filled in, sized by its DT_NULL field', () => {
    // data: 0x00 "Pair\0", 0x08 "DT_INT\0", 0x10 "DT_NULL\0"; descriptors at 0x40 (DT_INT) and
    // 0x60 (DT_NULL) name themselves; the initializer table at 0x100 holds one entry
    const data = new Uint8Array(0x200)
    const text = new TextEncoder()
    data.set(text.encode('Pair'), 0x00)
    data.set(text.encode('DT_INT'), 0x08)
    data.set(text.encode('DT_NULL'), 0x10)
    const view = new DataView(data.buffer)
    const va = (rva: number) => BASE + BigInt(rva)
    view.setBigUint64(0x48, va(DATA + 0x08), true)
    view.setBigUint64(0x68, va(DATA + 0x10), true)
    view.setBigUint64(0x100, va(TEXT), true) // table: [init] bounded by zeros
    // the structure at 0x80 (name, fields at 0x400, 3 slots) and its slots are written by code:
    // name and field pointers, then three slots: DT_INT@0, DT_INT@4, DT_NULL@8
    const slots = DATA + 0x400
    const store64 = (at: number, value: bigint, pc: number) => {
      // mov rax, imm64; mov [rip+→at], rax
      const bytes = [0x48, 0xb8]
      for (let index = 0; index < 8; index += 1) bytes.push(Number((value >> BigInt(index * 8)) & 0xffn))
      bytes.push(0x48, 0x89, 0x05, ...rel32(pc + 17, at))
      return bytes
    }
    const store32 = (at: number, value: number, pc: number) => [0xc7, 0x05, ...rel32(pc + 10, at), value & 0xff, (value >> 8) & 0xff, 0, 0]
    const code: number[] = []
    const emit = (bytes: number[]) => code.push(...bytes)
    emit(store64(DATA + 0x88, va(DATA + 0x00), TEXT + code.length))
    emit(store64(DATA + 0x98, va(slots), TEXT + code.length))
    emit(store32(DATA + 0xa0, 3, TEXT + code.length))
    for (const [index, offset, type] of [[0, 0, 0x40], [1, 4, 0x40], [2, 8, 0x60]] as const) {
      emit(store64(slots + index * 0xc0 + 8, va(DATA + type), TEXT + code.length))
      emit(store32(slots + index * 0xc0 + 0x10, offset, TEXT + code.length))
      emit(store64(slots + index * 0xc0 + 0x40, 0xffff_ffff_0000_0000n, TEXT + code.length))
    }
    code.push(0xc3)
    const registry = extractSnoTypeRegistry(image(code, data))
    const pair = Object.values(registry.structures).find(structure => structure.name === 'Pair')
    expect(registry.initializers).toEqual({ run: 1, stopped: 0 })
    expect(pair?.size).toBe(8)
    expect(pair?.fields.map(field => [field.offset, registry.basics[field.type]])).toEqual([
      [0, 'DT_INT'],
      [4, 'DT_INT'],
      [8, 'DT_NULL'],
    ])
  })
})

describe('SNO member names', () => {
  it('names leaves by absolute offset, through nested structures, and array elements by their own table', () => {
    // Root: int @0xc, Cyl { vector, float } @0x10, Elem[2] { int, float } @0x20; the SNO data starts at 0x10
    const registry = {
      basics: { i: 'DT_INT', f: 'DT_FLOAT', v: 'DT_VECTOR3D', a: 'DT_FIXEDARRAY', n: 'DT_NULL' },
      structures: {
        root: { id: 'root', name: 'Root', size: 0x30, fields: [{ offset: 0xc, type: 'i', flags: 0 }, { offset: 0x10, type: 'cyl', flags: 0 }, { offset: 0x20, type: 'a', element: 'elem', count: 2, flags: 0 }, { offset: 0x30, type: 'n', flags: 0 }] },
        cyl: { id: 'cyl', name: 'Cyl', size: 16, fields: [{ offset: 0, type: 'v', flags: 0 }, { offset: 12, type: 'f', flags: 0 }, { offset: 16, type: 'n', flags: 0 }] },
        elem: { id: 'elem', name: 'Elem', size: 8, fields: [{ offset: 0, type: 'i', flags: 0 }, { offset: 4, type: 'f', flags: 0 }, { offset: 8, type: 'n', flags: 0 }] },
      },
      groups: {},
      initializers: { run: 0, stopped: 0 },
    }
    const names = { 'Root/48': { 12: 'dwCount', 16: 'vCenter', 28: 'flRadius', 32: 'arElems' }, 'Elem/8': { 0: 'dwId', 4: 'flWeight' } }
    const bytes = new Uint8Array(0x10 + 0x30)
    const decoded = new SnoDecoder(registry, names).decode(bytes, registry.structures.root, { maxMembers: 100, maxDepth: 8 }).value
    if (decoded.kind !== 'structure') throw new Error('not a structure')
    expect(decoded.members.map(member => [member.label, member.name])).toEqual([
      ['DT_INT@0xc', 'dwCount'],
      ['Cyl@0x10', undefined],
      ['DT_FIXEDARRAY<Elem>@0x20', 'arElems'],
    ])
    const cyl = decoded.members[1]!.value
    expect(cyl.kind === 'structure' ? cyl.members.map(member => member.name) : []).toEqual(['vCenter', 'flRadius'])
    const elems = decoded.members[2]!.value
    const first = elems.kind === 'array' ? elems.items[0] : undefined
    expect(first?.kind === 'structure' ? first.members.map(member => member.name) : []).toEqual(['dwId', 'flWeight'])
  })
})
