import type { M3Field, M3StructureData } from '../types.js'
import type { M3StructureDescription } from './structures.js'
import { PRIMITIVE_FIELD_INFO } from './constants.js'

export class M3FieldBase implements M3Field {
  name: string
  size = 0

  constructor(name: string) {
    this.name = name
  }

  fromBuffer(_data: M3StructureData, _buffer: ArrayBuffer, _offset: number): void {
    throw new Error('fromBuffer not implemented')
  }

  toBuffer(_data: M3StructureData, _buffer: ArrayBuffer, _offset: number): void {
    throw new Error('toBuffer not implemented')
  }
}

export class M3FieldPrimitive extends M3FieldBase {
  type: string
  defaultValue: number | bigint
  expectedValue: number | bigint | null
  structInfo: (typeof PRIMITIVE_FIELD_INFO)[keyof typeof PRIMITIVE_FIELD_INFO]
  bitMaskMap?: Record<string, number>

  constructor(
    name: string,
    type: keyof typeof PRIMITIVE_FIELD_INFO,
    defaultValue: number | bigint = 0,
    expectedValue: number | bigint | null = null,
  ) {
    super(name)
    this.type = type
    this.defaultValue = defaultValue
    this.expectedValue = expectedValue
    this.structInfo = PRIMITIVE_FIELD_INFO[type]
    this.size = this.structInfo.size
  }

  fromBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const view = new DataView(buffer, offset, this.size)
    const value = view[this.structInfo.getter](0, true)
    if (this.expectedValue !== null && value !== this.expectedValue) {
      // eslint-disable-next-line no-console
      console.warn(
        `${data.desc.history.name}V${data.desc.version}.${this.name} expected ${this.expectedValue} but got ${value}`,
      )
    }
    data[this.name] = value
  }

  toBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const view = new DataView(buffer, offset, this.size)
    const setter = view[this.structInfo.setter] as (
      offset: number,
      value: number | bigint,
      littleEndian: boolean,
    ) => void
    setter.call(view, 0, data[this.name] as number | bigint, true)
  }
}

export class M3FieldBytes extends M3FieldBase {
  defaultValue: Uint8Array
  expectedValue: Uint8Array | null

  constructor(
    name: string,
    size: number,
    defaultValue: Uint8Array,
    expectedValue: Uint8Array | null = null,
  ) {
    super(name)
    this.size = size
    this.defaultValue = defaultValue
    this.expectedValue = expectedValue
  }

  fromBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const bytes = new Uint8Array(buffer, offset, this.size)
    data[this.name] = new Uint8Array(bytes)
  }

  toBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const bytes = data[this.name] as Uint8Array
    new Uint8Array(buffer, offset, this.size).set(bytes)
  }
}

export class M3FieldStructure extends M3FieldBase {
  desc: M3StructureDescription
  refTo: string

  constructor(name: string, desc: M3StructureDescription, refTo = '') {
    super(name)
    this.desc = desc
    this.size = desc.size
    this.refTo = refTo
  }

  fromBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const nested = this.desc.instance(buffer, offset)
    if (this.refTo) {
      nested.__refTo = this.refTo
    }
    data[this.name] = nested
  }

  toBuffer(data: M3StructureData, buffer: ArrayBuffer, offset: number): void {
    const instance = data[this.name] as M3StructureData
    if (!instance || typeof instance.toBuffer !== 'function') {
      throw new TypeError(
        `M3 structure ${data.desc.history.name} field ${this.name} requires a structured value.`,
      )
    }
    instance.toBuffer(buffer, offset)
  }
}
