/** Typed WDC5 rows from a selected DBD layout. No installation I/O or fallback schemas. */
import { boundedCount, byteView, requireRange } from '@modkit/codec-kit/binary'
import type { DbdField, DbdLayout } from './schema.js'
import type { WdcColumn, WdcFile } from './reader.js'

export type WdcValue = number | bigint | string | readonly (number | bigint | string)[]
export interface WdcRow {
  readonly id: number
  readonly section: number
  readonly values: Readonly<Record<string, WdcValue>>
  readonly copiedFrom?: number
}
export interface WdcRows {
  readonly rows: ReadonlyMap<number, WdcRow>
  readonly unavailable: readonly { readonly section: number; readonly reason: 'encrypted'; readonly ids: readonly number[] }[]
}

/** Read one native packed WDC integer without crossing its record, including unaligned fields. */
function integer(record: Uint8Array, bit: number, width: number): bigint {
  if (!Number.isSafeInteger(bit) || bit < 0 || !Number.isInteger(width) || width < 1 || width > 64)
    throw new TypeError('WDC5 invalid packed field range')
  if (bit + width > record.length * 8) throw new RangeError('WDC5 packed field exceeds its record')
  let raw = 0n
  for (let used = 0; used < width;) {
    const at = bit + used
    const take = Math.min(8 - at % 8, width - used)
    raw |= BigInt((record[Math.floor(at / 8)]! >>> (at % 8)) & ((1 << take) - 1)) << BigInt(used)
    used += take
  }
  return raw
}
const signed = (value: bigint, bits: number): bigint => BigInt.asIntN(bits, value)
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The caller has already selected a layout with a matching file hash and installation build. */
export function decodeWdcRows(bytes: Uint8Array, file: WdcFile, layout: DbdLayout,
  maxRecords: number, signal?: AbortSignal): WdcRows {
  const fields = layout.fields.filter(field => field.inline)
  const idField = layout.fields.find(field => field.id)
  if (idField === undefined) throw new TypeError('WDC5 layout has no ID field')
  const relations = layout.fields.filter(field => !field.inline && field.relation)
  if (fields.length !== file.columns.length) throw new TypeError('DBD inline field count does not match WDC5 columns')
  if (relations.length > 1) throw new TypeError('WDC5 multiple noninline relationships are unsupported')
  if ((file.flags & ~0x17) !== 0) throw new TypeError('WDC5 unsupported table flags')
  const view = byteView(bytes)
  const u32 = (offset: number): number => view.getUint32(offset, true)
  const rows = new Map<number, WdcRow>()
  const valuesPerRow = layout.fields.reduce((sum, field) => sum + field.count, 0)
  let decodedValues = 0
  const unavailable: { section: number; reason: 'encrypted'; ids: readonly number[] }[] = []
  const copies: { id: number; source: number; section: number }[] = []
  const stringSections: { base: number; start: number; length: number }[] = []
  let stringBase = 0
  for (const section of file.sections) {
    stringSections.push({ base: stringBase, start: section.offset + section.records * file.recordBytes, length: section.stringBytes })
    stringBase += section.stringBytes
  }
  const cstring = (source: Uint8Array, offset: number): readonly [string, number] => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.length) throw new RangeError('WDC5 string offset exceeds its area')
    const zero = source.indexOf(0, offset)
    if (zero < 0) throw new TypeError('WDC5 unterminated string')
    return [utf8.decode(source.subarray(offset, zero)), zero + 1]
  }
  const stringAt = (offset: number): string => {
    // Offset zero denotes the empty string; negative nonzero offsets are malformed.
    if (offset === 0) return ''
    const section = stringSections.find(area => offset >= area.base && offset < area.base + area.length)
    if (section === undefined) throw new RangeError('WDC5 string offset exceeds all section string tables')
    return cstring(bytes.subarray(section.start, section.start + section.length), offset - section.base)[0]
  }
  const numeric = (raw: bigint, field: DbdField, storedWidth: number, forceSigned: boolean): number | bigint => {
    if (field.type === 'float') {
      const value = new DataView(new ArrayBuffer(4))
      value.setUint32(0, Number(BigInt.asUintN(32, raw)), true)
      const number = value.getFloat32(0, true)
      if (!Number.isFinite(number)) throw new TypeError(`WDC5 nonfinite float ${field.name}`)
      return number
    }
    const width = field.bits ?? storedWidth
    const value = forceSigned ? signed(raw, storedWidth) : field.unsigned ? BigInt.asUintN(width, raw) : signed(raw, width)
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
  }
  const storage = (column: WdcColumn, field: DbdField, record: Uint8Array, bit: number, id: number):
    { readonly values: readonly bigint[]; readonly consumed: number; readonly width: number; readonly forceSigned: boolean } => {
    const mode = column.compression
    const width = mode === 0 ? (32 - column.fieldBits > 0 ? 32 - column.fieldBits : column.parameters[1]) : column.parameters[1]
    if (mode === 2) {
      if (field.count !== 1) throw new TypeError('WDC5 common arrays are unsupported')
      return { values: [BigInt(column.common.get(id) ?? column.parameters[0])], consumed: 0, width: 32, forceSigned: false }
    }
    if (mode === 3 || mode === 4) {
      const cardinality = mode === 3 ? 1 : column.parameters[2]
      if (cardinality !== field.count) throw new TypeError('WDC5 pallet cardinality differs from DBD array size')
      const index = Number(integer(record, bit, width)) * cardinality
      if (!Number.isSafeInteger(index) || index + cardinality > column.pallet.length) throw new RangeError('WDC5 pallet index exceeds its area')
      return { values: column.pallet.slice(index, index + cardinality).map(BigInt), consumed: width, width: 32, forceSigned: false }
    }
    if (field.count > 1 && mode !== 0) throw new TypeError('WDC5 immediate arrays are unsupported')
    const values = Array.from({ length: field.count }, (_, index) => integer(record, bit + index * width, width))
    return { values, consumed: field.count * width, width, forceSigned: mode === 5 || mode === 1 && (column.parameters[2] & 1) !== 0 }
  }
  let previousRecords = 0
  for (const [sectionIndex, section] of file.sections.entries()) {
    signal?.throwIfAborted()
    const sparse = (file.flags & 1) !== 0
    const recordBytes = sparse ? section.recordEnd - section.offset : section.records * file.recordBytes
    const recordArea = bytes.subarray(section.offset, section.offset + recordBytes)
    let cursor = section.offset + recordBytes + (sparse ? 0 : section.stringBytes)
    if (section.keyName !== 0n && recordArea.every(value => value === 0) &&
      bytes.subarray(cursor, cursor + section.idBytes + section.copies * 8 + section.sparseCount * 6).every(value => value === 0)) {
      unavailable.push({ section: sectionIndex, reason: 'encrypted', ids: section.encryptedIds })
      previousRecords += section.records
      continue
    }
    let ids = Array.from({ length: section.idBytes / 4 }, (_, index) => u32(cursor + index * 4))
    cursor += section.idBytes
    for (let index = 0; index < section.copies; index += 1, cursor += 8)
      copies.push({ id: u32(cursor), source: u32(cursor + 4), section: sectionIndex })
    const sparseEntries = Array.from({ length: section.sparseCount }, (_, index) => ({
      offset: u32(cursor + index * 6), length: view.getUint16(cursor + index * 6 + 4, true) }))
    cursor += section.sparseCount * 6
    const readSparseIds = (): void => {
      if (section.sparseCount === 0) return
      ids = Array.from({ length: section.sparseCount }, (_, index) => u32(cursor + index * 4))
      cursor += section.sparseCount * 4
    }
    if ((file.flags & 2) !== 0) readSparseIds()
    const references = new Map<number, number>()
    if (section.relationshipBytes > 0) {
      requireRange(bytes, cursor, 12, 'WDC5 relationship header')
      const length = boundedCount(u32(cursor), maxRecords, 'WDC5 relationships')
      if (12 + length * 8 !== section.relationshipBytes) throw new TypeError('WDC5 relationship size mismatch')
      for (let index = 0; index < length; index += 1) {
        const at = cursor + 12 + index * 8
        const key = u32(at + 4)
        if (references.has(key)) throw new TypeError('WDC5 duplicate relationship key')
        references.set(key, u32(at))
      }
      cursor += section.relationshipBytes
    }
    if ((file.flags & 2) === 0) readSparseIds()
    if (!idField.inline && ids.length !== section.records) throw new TypeError('WDC5 noninline IDs do not match records')
    if (sparse && sparseEntries.length !== section.records) throw new TypeError('WDC5 sparse map does not match records')
    for (let rowIndex = 0; rowIndex < section.records; rowIndex += 1) {
      if (rowIndex % 1024 === 0) signal?.throwIfAborted()
      const entry = sparseEntries[rowIndex]
      const start = sparse ? entry!.offset : section.offset + rowIndex * file.recordBytes
      const length = sparse ? entry!.length : file.recordBytes
      if (start < section.offset || start + length > section.offset + recordBytes || length === 0) throw new RangeError('WDC5 record exceeds its section')
      const record = bytes.subarray(start, start + length)
      let id = ids[rowIndex]
      if (idField.inline) {
        const at = fields.findIndex(field => field.id)
        const column = file.columns[at]!
        if (sparse) throw new TypeError('WDC5 sparse inline IDs require a dedicated profile')
        const value = storage(column, idField, record, column.bitOffset, 0)
        id = Number(value.values[0])
      }
      if (id === undefined || !Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new TypeError('WDC5 invalid row ID')
      if (rows.size >= maxRecords) throw new RangeError('WDC5 row budget exceeded')
      decodedValues += valuesPerRow
      if (decodedValues > maxRecords) throw new RangeError('WDC5 decoded value budget exceeded')
      if (rows.has(id)) throw new TypeError(`WDC5 duplicate row ID ${String(id)}`)
      const values: Record<string, WdcValue> = { [idField.name]: id }
      let position = 0
      fields.forEach((field, index) => {
        const column = file.columns[index]!
        const bit = sparse ? position : column.bitOffset
        if (sparse && (field.type === 'string' || field.type === 'locstring')) {
          if (bit % 8 !== 0) throw new TypeError('WDC5 sparse string is not byte aligned')
          const strings: string[] = []
          for (let component = 0; component < field.count; component += 1) {
            const [text, end] = cstring(record, position / 8)
            strings.push(text); position = end * 8
          }
          values[field.name] = field.count === 1 ? strings[0]! : strings
          return
        }
        const result = storage(column, field, record, bit, id!)
        position += result.consumed
        const decoded = result.values.map((raw, component) => {
          if (field.type !== 'string' && field.type !== 'locstring') return numeric(raw, field, result.width, result.forceSigned)
          if (raw === 0n) return ''
          const virtualRecordOffset = (previousRecords + rowIndex - file.records) * file.recordBytes
          return stringAt(virtualRecordOffset + Math.floor((bit + component * result.width) / 8) + Number(signed(raw, 32)))
        })
        values[field.name] = field.count === 1 ? decoded[0]! : decoded
      })
      for (const relation of relations) values[relation.name] = references.get((file.flags & 2) !== 0 ? id : rowIndex) ?? 0
      rows.set(id, { id, section: sectionIndex, values })
    }
    previousRecords += section.records
  }
  let pending = copies
  while (pending.length > 0) {
    const next: typeof copies = []
    for (const copy of pending) {
      const source = rows.get(copy.source)
      if (source === undefined) { next.push(copy); continue }
      if (rows.has(copy.id)) throw new TypeError('WDC5 copy duplicates an existing ID')
      if (rows.size >= maxRecords) throw new RangeError('WDC5 copy row budget exceeded')
      decodedValues += valuesPerRow
      if (decodedValues > maxRecords) throw new RangeError('WDC5 copied value budget exceeded')
      rows.set(copy.id, { ...source, id: copy.id, section: copy.section, copiedFrom: copy.source,
        values: { ...source.values, [idField.name]: copy.id } })
    }
    if (next.length === pending.length) throw new TypeError('WDC5 copy source is missing or cyclic')
    pending = next
  }
  return { rows, unavailable }
}
