import { describe, expect, it } from 'vitest'
import { readWdc5 } from '../src/db2/reader.js'
import { decodeWdcRows } from '../src/db2/rows.js'
import { parseDbd, selectDbdLayout } from '../src/db2/schema.js'
import { packedDatabase, sparseDatabase } from './db2-fixtures.js'

function decode(fixture: ReturnType<typeof packedDatabase>, maxRecords = 1000) {
  const file = readWdc5(fixture.bytes, maxRecords)
  return decodeWdcRows(fixture.bytes, file, selectDbdLayout(parseDbd(fixture.schema), file.layoutHash, '12.1.0.69933'), maxRecords)
}
describe('WoW WDC5 native rows', () => {
  it('decodes packed signed values, common overrides, pallets, arrays, floats, strings, uint IDs and copy rows', () => {
    const result = decode(packedDatabase())
    expect(result.unavailable).toEqual([])
    expect(result.rows.get(0xf0000010)?.values).toEqual({ ID: 0xf0000010, Signed: -3, Common: 99,
      Pallet: 12, Pair: [9, 10], Float: 1.5, Name: 'one' })
    expect(result.rows.get(11)?.values).toMatchObject({ Signed: -16, Common: 17, Pallet: 34, Pair: [7, 8], Float: 2.5, Name: 'two' })
    expect(result.rows.get(42)).toMatchObject({ copiedFrom: 0xf0000010, values: { ID: 42, Common: 99 } })
  })
  it('bounds each sparse record and decodes inline strings and noninline relationships', () => {
    const result = decode(sparseDatabase())
    expect(result.rows.get(15)?.values).toEqual({ ID: 15, Name: 'hi', Value: -2, ParentID: 77 })
    expect(result.rows.get(16)?.values).toEqual({ ID: 16, Name: 'yo', Value: 7, ParentID: 88 })
  })
  it('refuses truncated data, mismatched metadata, invalid pallet references and record budgets', () => {
    const fixture = packedDatabase()
    expect(() => decode({ ...fixture, bytes: fixture.bytes.subarray(0, 200) })).toThrow(/header/u)
    expect(() => decode({ ...fixture, bytes: fixture.bytes.subarray(0, fixture.bytes.length - 1) })).toThrow(/section/u)
    expect(() => decode(fixture, 1)).toThrow(/records/u)
    const bad = fixture.bytes.slice()
    new DataView(bad.buffer).setUint32(188, 24, true)
    expect(() => decode({ ...fixture, bytes: bad })).toThrow(/metadata size/u)
    const invalidPallet = fixture.bytes.slice()
    // Two index bits select pallet entry 2 from an area containing only entries 0 and 1.
    new DataView(invalidPallet.buffer).setUint32(268 + 2 * 24 + 16, 2, true)
    expect(() => decode({ ...fixture, bytes: invalidPallet })).toThrow(/pallet index/u)
  })
  it('reports unavailable zero-filled encrypted sections without fabricating rows', () => {
    const fixture = packedDatabase()
    const file = readWdc5(fixture.bytes, 1000)
    const bytes = new Uint8Array(fixture.bytes.length + 12)
    bytes.set(fixture.bytes.subarray(0, file.metadataEnd))
    const view = new DataView(bytes.buffer)
    view.setBigUint64(204, 7n, true)
    view.setUint32(212, file.metadataEnd + 12, true)
    view.setUint32(file.metadataEnd, 2, true)
    view.setUint32(file.metadataEnd + 4, 0xf0000010, true)
    view.setUint32(file.metadataEnd + 8, 11, true)
    const result = decode({ ...fixture, bytes })
    expect(result.rows.size).toBe(0)
    expect(result.unavailable).toEqual([{ section: 0, reason: 'encrypted', ids: [0xf0000010, 11] }])
  })
})
