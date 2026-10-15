/**
 * Decodes a Diablo III SNO file with the type registry recovered from the game (`registry.ts`).
 *
 * A file is a 16-byte preamble (0xDEADBEEF, the group's format version) followed by the root
 * structure of its group; the root's first 12 bytes are the SNO header (its own SNO id first).
 * Variable data — arrays, tag maps, strings, formulas — sits after the structures and is reached
 * through a SerializeData (offset and size, counted from the SNO data at 0x10) that the registry
 * places beside each variable field. Field names are not in the executable; a member is labelled
 * by its type and offset.
 */
import type { SnoStructure, SnoTypeRegistry } from './registry.js'

/** The SNO data every offset in a file counts from. */
export const SNO_DATA = 0x10

export type SnoValue =
  | { readonly kind: 'number'; readonly type: string; readonly value: number }
  | { readonly kind: 'bigint'; readonly type: string; readonly value: string }
  | { readonly kind: 'sno'; readonly group: number | null; readonly id: number }
  | { readonly kind: 'gbid'; readonly value: number }
  | { readonly kind: 'vector'; readonly type: string; readonly value: readonly number[] }
  | { readonly kind: 'text'; readonly type: string; readonly value: string }
  | { readonly kind: 'structure'; readonly type: string; readonly members: readonly SnoMember[] }
  | { readonly kind: 'array'; readonly type: string; readonly element: string; readonly length: number; readonly items: readonly SnoValue[] }
  | { readonly kind: 'opaque'; readonly type: string; readonly bytes: number; readonly note?: string }

export interface SnoMember {
  readonly offset: number
  /** The member's type and offset (`DT_SNO@0x14`): what the registry says of it. */
  readonly label: string
  /** A readable name, when the names table has one for this member (`snoAppearance`). */
  readonly name?: string
  readonly value: SnoValue
}

/** Readable member names by structure (`name/size`) and absolute offset within it (`field-names.ts`). */
export type SnoFieldNames = Readonly<Record<string, Readonly<Record<number, string>>>>

/** Names in force while decoding: a structure's own table, offset by where its members sit in it. */
interface Naming {
  readonly names: Readonly<Record<number, string>>
  readonly base: number
}

const BASIC_SIZES: Readonly<Record<string, number>> = {
  DT_BYTE: 1,
  DT_WORD: 2,
  DT_INT: 4,
  DT_FLOAT: 4,
  DT_ENUM: 4,
  DT_FLAG: 4,
  DT_GBID: 4,
  DT_SNO: 4,
  DT_SNO_GROUP: 4,
  DT_TIME: 4,
  DT_ANGLE: 4,
  DT_ACCEL: 4,
  DT_ANGULARVELOCITY: 4,
  DT_IMPULSE: 4,
  DT_MASS: 4,
  DT_VELOCITY: 4,
  DT_PERCENT: 4,
  DT_HIGHPRECISIONPERCENT: 4,
  DT_DATAID: 4,
  DT_ATTRIBUTEPARAM: 4,
  DT_TRANSLATEABLE: 4,
  DT_RGBACOLOR: 4,
  DT_INT64: 8,
  DT_IVECTOR2D: 8,
  DT_VECTOR2D: 8,
  DT_SNONAME_HANDLE: 4,
  DT_CSTRING: 8,
  DT_VARIABLEARRAY: 8,
  DT_TAGMAP: 8,
  DT_FORMULA: 8,
  SerializeData: 8,
  DT_VECTOR3D: 12,
  DT_RGBACOLORVALUE: 16,
  DT_NULL: 0,
}
const FLOATS = new Set([
  'DT_FLOAT',
  'DT_ANGLE',
  'DT_ACCEL',
  'DT_ANGULARVELOCITY',
  'DT_IMPULSE',
  'DT_MASS',
  'DT_VELOCITY',
  'DT_PERCENT',
  'DT_HIGHPRECISIONPERCENT',
])

export interface SnoDecodeLimits {
  /** Members decoded in all, across nesting; a file past it is cut and says so. */
  readonly maxMembers: number
  readonly maxDepth: number
}

export class SnoDecoder {
  readonly #registry: SnoTypeRegistry
  readonly #names: SnoFieldNames

  constructor(registry: SnoTypeRegistry, names: SnoFieldNames = {}) {
    this.#registry = registry
    this.#names = names
  }

  nameOf(id: string): string {
    return this.#registry.structures[id]?.name ?? this.#registry.basics[id] ?? id
  }

  sizeOf(id: string, count?: number, element?: string): number | undefined {
    const structure = this.#registry.structures[id]
    if (structure !== undefined) return structure.size
    const name = this.#registry.basics[id]
    if (name === 'DT_CHARARRAY') return count
    if (name === 'DT_FIXEDARRAY') {
      const size = element === undefined ? undefined : this.sizeOf(element)
      return size === undefined || count === undefined ? undefined : size * count
    }
    if (name === 'DT_OPTIONAL') {
      const size = element === undefined ? undefined : this.sizeOf(element)
      return size === undefined ? undefined : 4 + size + ((4 - (size % 4)) % 4)
    }
    return name === undefined ? undefined : BASIC_SIZES[name]
  }

  /**
   * The root structure of a group: named like the group (case aside — the storage files `Monster`
   * under `monster/`), starting after the 12-byte SNO header; of several such, the largest (a
   * group's name also names smaller helper structures).
   */
  rootOf(group: string): SnoStructure | undefined {
    let best: SnoStructure | undefined
    for (const structure of Object.values(this.#registry.structures)) {
      if (structure.name.toLowerCase() !== group.toLowerCase()) continue
      const first = Math.min(...structure.fields.map(field => field.offset))
      if (first < 0xc) continue
      if (best === undefined || structure.size > best.size) best = structure
    }
    return best
  }

  decode(bytes: Uint8Array, root: SnoStructure, limits: SnoDecodeLimits): { readonly value: SnoValue; readonly truncated: boolean } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let members = 0
    let truncated = false
    const inside = (at: number, length: number) => at >= 0 && length >= 0 && at + length <= bytes.byteLength

    const structure = (at: number, type: SnoStructure, depth: number, inherited?: Naming): SnoValue => {
      // a structure with its own names starts over; a nested one without reads its parent's, further in
      const own = this.#names[`${type.name}/${type.size}`]
      const naming = own === undefined ? inherited : { names: own, base: 0 }
      const out: SnoMember[] = []
      const fields = [...type.fields].sort((a, b) => a.offset - b.offset)
      for (const field of fields) {
        const typeName = this.nameOf(field.type)
        if (typeName === 'DT_NULL' || typeName === 'SerializeData') continue
        if (++members > limits.maxMembers) {
          truncated = true
          break
        }
        // names belong to members that hold a value; a nested structure passes them on to its own
        const nested = this.#registry.structures[field.type] !== undefined
        const name = nested ? undefined : naming?.names[naming.base + field.offset]
        out.push({
          offset: field.offset,
          label: `${typeName}${field.element === undefined ? '' : `<${this.nameOf(field.element)}>`}@0x${field.offset.toString(16)}`,
          ...(name === undefined ? {} : { name }),
          value: member(at, field, depth, naming === undefined ? undefined : { names: naming.names, base: naming.base + field.offset }),
        })
      }
      // an SNOName is its group then the id: the id names the group its sibling holds
      const group = out.find(member => member.value.kind === 'number' && member.value.type === 'DT_SNO_GROUP')?.value
      if (group?.kind === 'number')
        for (const [index, member] of out.entries())
          if (member.label.startsWith('DT_SNONAME_HANDLE') && member.value.kind === 'sno')
            out[index] = { ...member, value: { ...member.value, group: group.value } }
      return { kind: 'structure', type: type.name, members: out }
    }

    const scalar = (at: number, id: string, depth: number, naming?: Naming): SnoValue => {
      const nested = this.#registry.structures[id]
      if (nested !== undefined)
        return depth >= limits.maxDepth ? { kind: 'opaque', type: nested.name, bytes: nested.size, note: 'depth limit' } : structure(at, nested, depth + 1, naming)
      const name = this.nameOf(id)
      const size = BASIC_SIZES[name]
      if (size === undefined || !inside(at, size)) return { kind: 'opaque', type: name, bytes: size ?? 0 }
      if (FLOATS.has(name)) return { kind: 'number', type: name, value: view.getFloat32(at, true) }
      switch (name) {
        case 'DT_BYTE':
          return { kind: 'number', type: name, value: view.getUint8(at) }
        case 'DT_WORD':
          return { kind: 'number', type: name, value: view.getUint16(at, true) }
        case 'DT_INT64':
          return { kind: 'bigint', type: name, value: view.getBigInt64(at, true).toString() }
        case 'DT_GBID':
          return { kind: 'gbid', value: view.getInt32(at, true) }
        case 'DT_SNO':
          return { kind: 'sno', group: null, id: view.getInt32(at, true) }
        case 'DT_SNONAME_HANDLE':
          return { kind: 'sno', group: null, id: view.getInt32(at, true) }
        case 'DT_VECTOR2D':
        case 'DT_VECTOR3D':
        case 'DT_RGBACOLORVALUE':
          return { kind: 'vector', type: name, value: Array.from({ length: size / 4 }, (_, index) => view.getFloat32(at + index * 4, true)) }
        case 'DT_IVECTOR2D':
          return { kind: 'vector', type: name, value: [view.getInt32(at, true), view.getInt32(at + 4, true)] }
        case 'DT_RGBACOLOR':
          return { kind: 'number', type: name, value: view.getUint32(at, true) }
        default:
          return { kind: 'number', type: name, value: view.getInt32(at, true) }
      }
    }

    const member = (base: number, field: SnoStructure['fields'][number], depth: number, naming?: Naming): SnoValue => {
      const at = base + field.offset
      const typeName = this.nameOf(field.type)
      if (typeName === 'DT_SNO') {
        return inside(at, 4) ? { kind: 'sno', group: field.group ?? null, id: view.getInt32(at, true) } : { kind: 'opaque', type: typeName, bytes: 4 }
      }
      if (typeName === 'DT_CHARARRAY') {
        const length = field.count ?? 0
        if (!inside(at, length)) return { kind: 'opaque', type: typeName, bytes: length }
        const raw = bytes.subarray(at, at + length)
        const end = raw.indexOf(0)
        return { kind: 'text', type: typeName, value: new TextDecoder('latin1').decode(end < 0 ? raw : raw.subarray(0, end)) }
      }
      if (typeName === 'DT_FIXEDARRAY' || typeName === 'DT_OPTIONAL') {
        const element = field.element
        const elementSize = element === undefined ? undefined : this.sizeOf(element)
        if (element === undefined || elementSize === undefined) return { kind: 'opaque', type: typeName, bytes: 0 }
        if (typeName === 'DT_OPTIONAL') {
          const present = inside(at, 4) && view.getInt32(at, true) !== 0
          return { kind: 'array', type: typeName, element: this.nameOf(element), length: present ? 1 : 0, items: present ? [scalar(at + 4, element, depth)] : [] }
        }
        const length = field.count ?? 0
        // an array of SNO ids carries its group on the array field
        const item = (index: number): SnoValue => {
          const value = scalar(at + index * elementSize, element, depth)
          return value.kind === 'sno' && field.group !== undefined ? { ...value, group: field.group } : value
        }
        return { kind: 'array', type: typeName, element: this.nameOf(element), length, items: Array.from({ length }, (_, index) => item(index)) }
      }
      if (typeName === 'DT_VARIABLEARRAY' || typeName === 'DT_TAGMAP' || typeName === 'DT_CSTRING' || typeName === 'DT_FORMULA') {
        const descriptor = at + (field.dataOffset ?? 8)
        if (!inside(descriptor, 8)) return { kind: 'opaque', type: typeName, bytes: 0, note: 'no SerializeData' }
        const dataAt = SNO_DATA + view.getInt32(descriptor, true)
        const dataSize = view.getInt32(descriptor + 4, true)
        if (dataSize === 0) return { kind: 'array', type: typeName, element: field.element === undefined ? '' : this.nameOf(field.element), length: 0, items: [] }
        // variable data follows the root; one that points into it (server-only arrays keep their
        // size in client files but not their data) is not in this file
        if (dataAt < SNO_DATA + root.size) return { kind: 'opaque', type: typeName, bytes: dataSize, note: 'not stored in this file' }
        if (!inside(dataAt, dataSize)) return { kind: 'opaque', type: typeName, bytes: dataSize, note: 'data outside the file' }
        if (typeName === 'DT_CSTRING') {
          const raw = bytes.subarray(dataAt, dataAt + dataSize)
          const end = raw.indexOf(0)
          return { kind: 'text', type: typeName, value: new TextDecoder('utf-8').decode(end < 0 ? raw : raw.subarray(0, end)) }
        }
        const element = field.element
        const elementSize = element === undefined ? undefined : this.sizeOf(element)
        if (typeName !== 'DT_VARIABLEARRAY' || element === undefined || elementSize === undefined || elementSize === 0)
          return { kind: 'opaque', type: typeName, bytes: dataSize }
        const length = Math.floor(dataSize / elementSize)
        if (depth >= limits.maxDepth) return { kind: 'opaque', type: typeName, bytes: dataSize, note: 'depth limit' }
        const item = (index: number): SnoValue => {
          const value = scalar(dataAt + index * elementSize, element, depth + 1)
          return value.kind === 'sno' && field.group !== undefined ? { ...value, group: field.group } : value
        }
        return { kind: 'array', type: typeName, element: this.nameOf(element), length, items: Array.from({ length }, (_, index) => item(index)) }
      }
      return scalar(at, field.type, depth, naming)
    }

    return { value: structure(SNO_DATA, root, 0), truncated }
  }
}
