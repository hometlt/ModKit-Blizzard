/**
 * Bounded WoW WDC5 reader (GAME-WOW). Native database offsets and compression metadata only;
 * no CASC access and no schema guesses. The supplied DBD layout determines row field meanings.
 * Original implementation from the WDC format description; no reference reader code is copied.
 */
import { boundedCount, byteView, checkedProduct, requireRange } from '@modkit/codec-kit/binary'

export interface WdcSection {
  readonly keyName: bigint
  readonly offset: number
  readonly records: number
  readonly stringBytes: number
  readonly recordEnd: number
  readonly idBytes: number
  readonly relationshipBytes: number
  readonly sparseCount: number
  readonly copies: number
  readonly encryptedIds: readonly number[]
}
export interface WdcColumn {
  readonly fieldBits: number
  readonly fieldOffset: number
  readonly bitOffset: number
  readonly bitSize: number
  readonly compression: number
  readonly parameters: readonly [number, number, number]
  readonly pallet: readonly number[]
  readonly common: ReadonlyMap<number, number>
}
export interface WdcFile {
  readonly schemaVersion: number
  readonly schema: string
  readonly records: number
  readonly recordBytes: number
  readonly stringBytes: number
  readonly tableHash: number
  readonly layoutHash: number
  readonly minId: number
  readonly maxId: number
  readonly locale: number
  readonly flags: number
  readonly idField: number
  readonly totalFields: number
  readonly packedOffset: number
  readonly lookupColumns: number
  readonly sections: readonly WdcSection[]
  readonly columns: readonly WdcColumn[]
  readonly metadataEnd: number
}

/** Read and bound every metadata area before any section/row is decoded. */
export function readWdc5(bytes: Uint8Array, maxRecords: number): WdcFile {
  // Magic + schema version + 128-byte schema name + 68 bytes of table metadata = 204.
  requireRange(bytes, 0, 204, 'WDC5 header')
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'WDC5') throw new TypeError('Unsupported WoW database signature; expected WDC5')
  const view = byteView(bytes)
  const u32 = (at: number): number => view.getUint32(at, true)
  const count = (at: number, name: string): number => boundedCount(u32(at), maxRecords, `WDC5 ${name}`)
  const records = count(136, 'records')
  const fields = count(140, 'fields')
  const sectionCount = count(200, 'sections')
  const columnBytes = u32(188)
  if (columnBytes !== checkedProduct(fields, 24, 'WDC5 column metadata')) throw new TypeError('WDC5 column metadata size does not match field count')
  const sections: WdcSection[] = []
  let offset = 204
  requireRange(bytes, offset, checkedProduct(sectionCount, 40, 'WDC5 sections'), 'WDC5 sections')
  for (let index = 0; index < sectionCount; index += 1, offset += 40) {
    const section: WdcSection = {
      keyName: view.getBigUint64(offset, true), offset: u32(offset + 8), records: count(offset + 12, 'section records'),
      stringBytes: u32(offset + 16), recordEnd: u32(offset + 20), idBytes: u32(offset + 24),
      relationshipBytes: u32(offset + 28), sparseCount: count(offset + 32, 'sparse records'),
      copies: count(offset + 36, 'copy rows'), encryptedIds: [],
    }
    if (section.idBytes % 4 !== 0) throw new TypeError('WDC5 ID area is not a uint32 array')
    sections.push(section)
  }
  if (sections.reduce((sum, section) => sum + section.records, 0) !== records) throw new TypeError('WDC5 section record counts do not match header')
  const fieldMeta = offset
  offset += checkedProduct(fields, 4, 'WDC5 field metadata')
  requireRange(bytes, fieldMeta, offset - fieldMeta + columnBytes, 'WDC5 field and column metadata')
  const storageMeta = offset
  offset += columnBytes
  const columns: WdcColumn[] = []
  const additional: number[] = []
  for (let index = 0; index < fields; index += 1) {
    const at = storageMeta + index * 24
    const compression = u32(at + 8)
    if (compression > 5) throw new TypeError(`Unsupported WDC5 compression ${String(compression)}`)
    columns.push({ fieldBits: view.getInt16(fieldMeta + index * 4, true),
      fieldOffset: view.getUint16(fieldMeta + index * 4 + 2, true),
      bitOffset: view.getUint16(at, true), bitSize: view.getUint16(at + 2, true), compression,
      parameters: [u32(at + 12), u32(at + 16), u32(at + 20)], pallet: [], common: new Map() })
    additional.push(u32(at + 4))
  }
  const palletStart = offset
  requireRange(bytes, offset, u32(196), 'WDC5 pallet data')
  // Single-value pallets precede array pallets regardless of column order.
  for (const compression of [3, 4]) columns.forEach((column, index) => {
    if (column.compression !== compression) return
    const size = additional[index]!
    if (size % 4 !== 0) throw new TypeError('WDC5 pallet data is not a uint32 array')
    if (offset + size > palletStart + u32(196)) throw new RangeError('WDC5 pallet exceeds its declared area')
    const length = boundedCount(size / 4, maxRecords, 'WDC5 pallet entries')
    columns[index] = { ...column, pallet: Array.from({ length }, (_, entry) => u32(offset + entry * 4)) }
    offset += size
  })
  if (offset - palletStart !== u32(196)) throw new TypeError('WDC5 unclaimed pallet data')
  const commonStart = offset
  requireRange(bytes, offset, u32(192), 'WDC5 common data')
  columns.forEach((column, index) => {
    if (column.compression !== 2) return
    const size = additional[index]!
    if (size % 8 !== 0) throw new TypeError('WDC5 common data is not an ID/value array')
    if (offset + size > commonStart + u32(192)) throw new RangeError('WDC5 common data exceeds its declared area')
    const length = boundedCount(size / 8, maxRecords, 'WDC5 common entries')
    const common = new Map<number, number>()
    for (let entry = 0; entry < length; entry += 1) {
      const id = u32(offset + entry * 8)
      if (common.has(id)) throw new TypeError('WDC5 duplicate common-data ID')
      common.set(id, u32(offset + entry * 8 + 4))
    }
    columns[index] = { ...column, common }
    offset += size
  })
  if (offset - commonStart !== u32(192)) throw new TypeError('WDC5 unclaimed common data')
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    if (section.keyName === 0n) continue
    requireRange(bytes, offset, 4, 'WDC5 encrypted ID count')
    const length = count(offset, 'encrypted IDs')
    offset += 4
    const size = checkedProduct(length, 4, 'WDC5 encrypted IDs')
    requireRange(bytes, offset, size, 'WDC5 encrypted IDs')
    sections[index] = { ...section, encryptedIds: Array.from({ length }, (_, entry) => u32(offset + entry * 4)) }
    offset += size
  }
  const metadataEnd = offset
  for (const section of sections) {
    if (section.offset < metadataEnd) throw new TypeError('WDC5 section overlaps metadata')
    const sparse = (view.getUint16(172, true) & 1) !== 0
    const recordSize = sparse ? section.recordEnd - section.offset : checkedProduct(section.records, u32(144), 'WDC5 section records')
    if (recordSize < 0) throw new TypeError('WDC5 reversed sparse record range')
    requireRange(bytes, section.offset, recordSize + (sparse ? 0 : section.stringBytes) + section.idBytes +
      checkedProduct(section.copies, 8, 'WDC5 copies') + checkedProduct(section.sparseCount, 10, 'WDC5 sparse map') +
      section.relationshipBytes, 'WDC5 section data')
  }
  const nameBytes = bytes.subarray(8, 136)
  const zero = nameBytes.indexOf(0)
  return { schemaVersion: u32(4), schema: new TextDecoder('utf-8', { fatal: true }).decode(nameBytes.subarray(0, zero < 0 ? 128 : zero)),
    records, recordBytes: u32(144), stringBytes: u32(148), tableHash: u32(152), layoutHash: u32(156),
    minId: u32(160), maxId: u32(164), locale: u32(168), flags: view.getUint16(172, true),
    idField: view.getUint16(174, true), totalFields: count(176, 'total fields'), packedOffset: u32(180),
    lookupColumns: count(184, 'lookup columns'), sections, columns, metadataEnd }
}
