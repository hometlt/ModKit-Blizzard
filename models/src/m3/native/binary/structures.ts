import type { FieldRecord, M3StructureData as IM3StructureData, M3Reference } from '../types.js'
import { M3FieldPrimitive, M3FieldStructure, M3FieldBytes } from './fields.js'
import { getStructures } from './registry.js'
import { PRIMITIVE_STRUCTURE_NAMES } from './constants.js'

export class M3StructureHistory {
  name: string
  primitive: boolean
  versionToSize: Map<number, number>
  fieldRecords: FieldRecord[]
  versionToDescription = new Map<string, M3StructureDescription>()

  constructor(name: string, versionToSize: Map<number, number>, fieldRecords: FieldRecord[]) {
    this.name = name
    this.primitive = PRIMITIVE_STRUCTURE_NAMES.has(name)
    this.versionToSize = versionToSize
    this.fieldRecords = fieldRecords

    for (const version of versionToSize.keys()) {
      this.getVersion(version)
    }
  }

  getVersion(
    version: number,
    mdVersion = 34,
    structureHistories: Record<string, M3StructureHistory> = getStructures(),
  ): M3StructureDescription {
    const descId = `MD${mdVersion}_${version}`
    const cached = this.versionToDescription.get(descId)
    if (cached) return cached

    const fields: Record<string, import('../types.js').M3Field> = {}
    for (const { field, sinceVersion, tillVersion } of this.fieldRecords) {
      if (version < sinceVersion || version > tillVersion) continue
      if (
        field instanceof M3FieldStructure &&
        mdVersion === 33 &&
        field.desc.history.name === 'Reference'
      ) {
        const smallRefDesc = structureHistories['SmallReference'].getVersion(
          field.desc.version,
          mdVersion,
          structureHistories,
        )
        fields[field.name] = new M3FieldStructure(field.name, smallRefDesc, field.refTo)
      } else {
        fields[field.name] = field
      }
    }

    let size = 0
    for (const key in fields) size += fields[key].size
    const requestedSize = this.versionToSize.get(version)
    if (requestedSize !== undefined && requestedSize !== size && mdVersion === 34) {
      // eslint-disable-next-line no-console
      console.warn(
        `Size mismatch for ${this.name}V${version}: expected ${requestedSize}, actual ${size}`,
      )
    }

    const desc = new M3StructureDescription(this, version, fields, size)
    this.versionToDescription.set(descId, desc)
    return desc
  }
}

export class M3StructureDescription {
  history: M3StructureHistory
  version: number
  fields: Record<string, import('../types.js').M3Field>
  size: number

  constructor(
    history: M3StructureHistory,
    version: number,
    fields: Record<string, import('../types.js').M3Field>,
    size: number,
  ) {
    this.history = history
    this.version = version
    this.fields = fields
    this.size = size
  }

  instance(buffer?: ArrayBuffer, offset = 0): M3StructureData {
    return new M3StructureData(this, buffer, offset)
  }

  instances(buffer: ArrayBuffer, count: number): (M3StructureData | number | string)[] {
    if (this.history.primitive) {
      const values: (number | string)[] = []
      const field = this.fields['value'] as M3FieldPrimitive
      const view = new DataView(buffer)
      for (let i = 0; i < count; i += 1) {
        values.push(view[field.structInfo.getter](i * field.size, true) as number)
      }
      return values
    }

    const values: M3StructureData[] = []
    for (let i = 0; i < count; i += 1) {
      values.push(this.instance(buffer, i * this.size))
    }
    return values
  }

  static getVertexDescription(
    vertexFlags: number,
    structureHistories: Record<string, M3StructureHistory> = getStructures(),
  ): M3StructureDescription {
    const fields: Record<string, import('../types.js').M3Field> = {}
    let size = 0
    const addField = (field: import('../types.js').M3Field) => {
      fields[field.name] = field
      size += field.size
    }

    const structs = structureHistories

    addField(new M3FieldStructure('pos', structs['VEC3'].getVersion(0)))
    const lookupPairs = (vertexFlags & 0x20 ? 2 : 0) + (vertexFlags & 0x40 ? 2 : 0)
    for (let i = 0; i < lookupPairs; i += 1) addField(new M3FieldPrimitive(`weight${i}`, 'uint8'))
    for (let i = 0; i < lookupPairs; i += 1) addField(new M3FieldPrimitive(`lookup${i}`, 'uint8'))
    if (vertexFlags & 0x80) addField(new M3FieldStructure('normalf', structs['VEC3'].getVersion(0)))
    if (vertexFlags & 0x0800000) {
      addField(new M3FieldStructure('normal', structs['Vector3As3uint8'].getVersion(0)))
      addField(new M3FieldPrimitive('sign', 'uint8'))
    }
    if (vertexFlags & 0x100) addField(new M3FieldPrimitive('test100', 'uint32', 0))
    if (vertexFlags & 0x200) addField(new M3FieldStructure('col', structs['COL'].getVersion(0)))
    if (vertexFlags & 0x400) addField(new M3FieldPrimitive('test400', 'uint32', 0))
    if (vertexFlags & 0x800) addField(new M3FieldPrimitive('test800', 'uint32', 0xffffffff))
    if (vertexFlags & 0x1000) addField(new M3FieldPrimitive('test1000', 'uint32', 0xffffffff))
    let uvCoords = 0
    if (vertexFlags & 0x00020000) uvCoords += 1
    if (vertexFlags & 0x00040000) uvCoords += 1
    if (vertexFlags & 0x00080000) uvCoords += 1
    if (vertexFlags & 0x00100000) uvCoords += 1
    if (vertexFlags & 0x40000000) uvCoords += 1
    if (vertexFlags & 0x2000) addField(new M3FieldStructure('fuv0', structs['VEC2'].getVersion(0)))
    if (vertexFlags & 0x4000) addField(new M3FieldStructure('fuv1', structs['VEC2'].getVersion(0)))
    if (vertexFlags & 0x8000) addField(new M3FieldStructure('fuv2', structs['VEC2'].getVersion(0)))
    if (vertexFlags & 0x10000) addField(new M3FieldStructure('fuv3', structs['VEC2'].getVersion(0)))
    for (let i = 0; i < uvCoords; i += 1) {
      addField(new M3FieldStructure(`uv${i}`, structs['Vector2As2int16'].getVersion(0)))
    }
    if (vertexFlags & 0x200000)
      addField(new M3FieldStructure('normalf', structs['VEC3'].getVersion(0)))
    if (vertexFlags & 0x400000)
      addField(new M3FieldStructure('tanf', structs['VEC3'].getVersion(0)))
    if (vertexFlags & 0x1000000) {
      addField(new M3FieldStructure('tan', structs['Vector3As3uint8'].getVersion(0)))
      addField(new M3FieldPrimitive('unused', 'uint8'))
    }
    if (vertexFlags & 0x2000000) addField(new M3FieldPrimitive('test2000000', 'uint32', 10000))
    if (vertexFlags & 0x4000000) {
      addField(new M3FieldPrimitive('test4000000', 'uint32', 10000))
      addField(new M3FieldPrimitive('test4000001', 'uint32', 10000))
      addField(new M3FieldPrimitive('test4000002', 'uint32', 10000))
    }
    if (vertexFlags & 0x8000000) {
      addField(new M3FieldPrimitive('test8000000', 'uint32', 10000))
      addField(new M3FieldPrimitive('test8000001', 'uint32', 10000))
      addField(new M3FieldPrimitive('test8000002', 'uint32', 10000))
    }
    if (vertexFlags & 0x10000000) addField(new M3FieldPrimitive('test10000000', 'uint32', 10000))
    if (vertexFlags & 0x20000000) addField(new M3FieldPrimitive('test20000000', 'uint32', 10000))

    return new M3StructureDescription(
      new M3StructureHistory(
        `VertexFormat${vertexFlags.toString(16).padStart(8, '0')}`,
        new Map(),
        [],
      ),
      0,
      fields,
      size,
    )
  }
}

export class M3StructureData implements IM3StructureData {
  desc: M3StructureDescription;
  [key: string]:
    | number
    | string
    | boolean
    | bigint
    | M3Reference
    | M3StructureData
    | Uint8Array
    | undefined
    | M3StructureDescription
    | ((buffer: ArrayBuffer, offset?: number) => void)
    | ((fieldName: string, bitName: string) => boolean)

  constructor(desc: M3StructureDescription, buffer?: ArrayBuffer, offset = 0) {
    this.desc = desc
    if (buffer) {
      this.fromBuffer(buffer, offset)
    } else {
      for (const field of Object.values(desc.fields)) {
        if (field instanceof M3FieldStructure) {
          this[field.name] = field.desc.instance()
        } else {
          this[field.name] = (field as M3FieldPrimitive).defaultValue
        }
      }
    }
  }

  fromBuffer(buffer: ArrayBuffer, offset = 0): void {
    let fieldOffset = offset
    for (const field of Object.values(this.desc.fields)) {
      field.fromBuffer(this, buffer, fieldOffset)
      fieldOffset += field.size
    }
  }

  toBuffer(buffer: ArrayBuffer, offset = 0): void {
    let fieldOffset = offset
    for (const field of Object.values(this.desc.fields)) {
      field.toBuffer(this, buffer, fieldOffset)
      fieldOffset += field.size
    }
  }

  bitGet(fieldName: string, bitName: string): boolean {
    const field = this.desc.fields[fieldName]
    if (!field || !(field as M3FieldPrimitive).bitMaskMap) return false
    const mask = (field as M3FieldPrimitive).bitMaskMap![bitName]
    if (!mask) return false
    return ((this[fieldName] as number) & mask) !== 0
  }
}
