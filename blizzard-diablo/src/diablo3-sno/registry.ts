/**
 * Diablo III's SNO type registry, recovered from the game executable.
 *
 * The client describes every serialized structure with descriptor objects its static initializers
 * fill in at start-up. After those initializers run (`X64Machine`), a structure descriptor is
 * recognized by its shape rather than by an address of one build: its name at +0x08, an array of
 * 0xC0-byte field slots at +0x18 and their count at +0x20, the last slot typed DT_NULL at the
 * structure's size. A field slot holds its (stripped, empty) name at +0x00, the descriptor of its
 * type at +0x08, its offset at +0x10, flags at +0x30, the element type of an array at +0x38, at
 * +0x40 the offset of the SerializeData a variable field reads through (low dword) and a fixed
 * array's length (high dword), and at +0x50 the SNO group a DT_SNO field names.
 */
import { X64Machine, type ExecutableImage } from './x64.js'

export interface SnoField {
  readonly offset: number
  /** Id of the field's type: a structure of `types`, or a basic type of `basics`. */
  readonly type: string
  readonly flags: number
  /** Element type of an array, a tag map or a string. */
  readonly element?: string
  /** Length of a fixed array or character array. */
  readonly count?: number
  /** For a variable array, tag map or string: where its SerializeData sits, relative to the field. */
  readonly dataOffset?: number
  /** For DT_SNO, or an array of them: the SNO group they name. */
  readonly group?: number
}

export interface SnoStructure {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly fields: readonly SnoField[]
}

export interface SnoTypeRegistry {
  /** Structures by id (the descriptor's RVA in hex). Names repeat, ids do not. */
  readonly structures: Readonly<Record<string, SnoStructure>>
  /** Basic types (DT_INT, DT_SNO, SerializeData, …) by id, with their names. */
  readonly basics: Readonly<Record<string, string>>
  /** File extension of each SNO group, by group number (`.acr` for 1, `.mon` for 25, …). */
  readonly groups: Readonly<Record<number, string>>
  readonly initializers: { readonly run: number; readonly stopped: number }
}

const FIELD_BYTES = 0xc0
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_:<>]{0,127}$/

/** The CRT's table of dynamic initializers: the longest zero-bounded run of code pointers in data. */
function initializerTable(image: ExecutableImage): readonly bigint[] {
  const code = image.sections.filter(section => section.executable)
  const inCode = (value: bigint) =>
    code.some(section => {
      const start = image.imageBase + BigInt(section.virtualAddress)
      return value >= start && value < start + BigInt(section.virtualSize)
    })
  let best: bigint[] = []
  for (const section of image.sections) {
    if (section.executable) continue
    const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength)
    let run: bigint[] = []
    for (let offset = 0; offset + 8 <= section.bytes.byteLength; offset += 8) {
      const value = view.getBigUint64(offset, true)
      if (inCode(value)) run.push(value)
      else {
        if (value === 0n && run.length > best.length) best = run
        run = []
      }
    }
  }
  return best
}

export function extractSnoTypeRegistry(image: ExecutableImage): SnoTypeRegistry {
  const machine = new X64Machine(image)
  let stopped = 0
  const table = initializerTable(image)
  for (const entry of table) if (machine.run(entry).state !== 'returned') stopped += 1

  const memory = machine.memory
  const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength)
  const base = machine.imageBase
  const rva = (pointer: bigint): number | undefined => {
    const offset = pointer - base
    return offset > 0n && offset < BigInt(memory.byteLength) ? Number(offset) : undefined
  }
  const q = (at: number) => (at + 8 <= memory.byteLength ? view.getBigUint64(at, true) : 0n)
  const d = (at: number) => (at + 4 <= memory.byteLength ? view.getUint32(at, true) : 0)
  const decoder = new TextDecoder('latin1')
  const nameAt = (pointer: bigint): string | undefined => {
    const at = rva(pointer)
    if (at === undefined) return undefined
    let end = at
    while (end < memory.byteLength && end - at < 129 && memory[end] !== 0) end += 1
    const name = decoder.decode(memory.subarray(at, end))
    return IDENTIFIER.test(name) ? name : undefined
  }
  /** A descriptor's own name, if `pointer` names an object that starts like one. */
  const descriptorName = (pointer: bigint): string | undefined => {
    const at = rva(pointer)
    return at === undefined ? undefined : nameAt(q(at + 8))
  }

  const structures: Record<string, SnoStructure> = {}
  const basics: Record<string, string> = {}
  const idOf = (at: number) => at.toString(16)
  for (const section of image.sections) {
    if (section.executable) continue
    const end = section.virtualAddress + section.virtualSize
    for (let at = section.virtualAddress; at + 0x28 <= end; at += 8) {
      const name = nameAt(q(at + 8))
      if (name === undefined) continue
      const slots = rva(q(at + 0x18))
      const count = d(at + 0x20)
      if (slots === undefined || count === 0 || count > 4096 || slots + count * FIELD_BYTES > memory.byteLength) continue
      const fields: SnoField[] = []
      let valid = true
      for (let index = 0; index < count && valid; index += 1) {
        const slot = slots + index * FIELD_BYTES
        const type = rva(q(slot + 8))
        const typeName = type === undefined ? undefined : descriptorName(q(slot + 8))
        if (type === undefined || typeName === undefined) {
          valid = false
          break
        }
        const extent = q(slot + 0x40)
        const low = Number(BigInt.asIntN(32, extent & 0xffff_ffffn))
        const high = Number(BigInt.asIntN(32, extent >> 32n))
        const element = rva(q(slot + 0x38))
        const group = Number(BigInt.asIntN(32, q(slot + 0x50) & 0xffff_ffffn))
        const variable = typeName === 'DT_VARIABLEARRAY' || typeName === 'DT_TAGMAP' || typeName === 'DT_CSTRING'
        fields.push({
          offset: d(slot + 0x10),
          type: idOf(type),
          flags: Number(q(slot + 0x30) & 0xffff_ffffn),
          ...(element === undefined || descriptorName(q(slot + 0x38)) === 'DT_NULL' ? {} : { element: idOf(element) }),
          ...(high >= 0 ? { count: high } : {}),
          ...(variable ? { dataOffset: low } : {}),
          ...((typeName === 'DT_SNO' || descriptorName(q(slot + 0x38)) === 'DT_SNO') && group >= 0 ? { group } : {}),
        })
      }
      const last = fields.at(-1)
      if (!valid || last === undefined || descriptorName(q(slots + (count - 1) * FIELD_BYTES + 8)) !== 'DT_NULL') continue
      structures[idOf(at)] = { id: idOf(at), name, size: last.offset, fields }
    }
  }
  // the group extension table: the longest run of pointers to ".xyz" (or empty, for unused numbers)
  const extensionAt = (pointer: bigint): string | undefined => {
    const at = rva(pointer)
    if (at === undefined) return undefined
    let end = at
    while (end < memory.byteLength && end - at < 5 && memory[end] !== 0) end += 1
    if (memory[end] !== 0) return undefined
    const text = decoder.decode(memory.subarray(at, end))
    return text === '' || /^\.[a-z0-9]{2,3}$/.test(text) ? text : undefined
  }
  let groups: string[] = []
  for (const section of image.sections) {
    if (section.executable) continue
    let run: string[] = []
    for (let at = section.virtualAddress; at + 8 <= section.virtualAddress + section.virtualSize; at += 8) {
      const extension = extensionAt(q(at))
      if (extension !== undefined && (run.length > 0 || extension === '')) run.push(extension)
      else {
        if (run.length > groups.length) groups = run
        run = extension === '' ? [''] : []
      }
    }
    if (run.length > groups.length) groups = run
  }
  const groupExtensions: Record<number, string> = {}
  groups.forEach((extension, group) => {
    if (extension !== '') groupExtensions[group] = extension
  })
  // every type a field names that is not a structure is a basic type
  for (const structure of Object.values(structures))
    for (const field of structure.fields)
      for (const id of [field.type, field.element])
        if (id !== undefined && structures[id] === undefined && basics[id] === undefined)
          basics[id] = descriptorName(base + BigInt(parseInt(id, 16))) ?? id
  return { structures, basics, groups: groupExtensions, initializers: { run: table.length, stopped } }
}
