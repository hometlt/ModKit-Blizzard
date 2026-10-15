/** Authored native WDC5 binary fixtures; no game files or external schemas. */
export function packedDatabase(): { bytes: Uint8Array; schema: string } {
  const fields = 6
  const columns = 204 + 40 + fields * 4
  const pallet = columns + fields * 24
  const common = pallet + 24
  const data = common + 8
  const strings = new TextEncoder().encode('\0one\0two\0')
  const ids = data + 18 + strings.length
  const bytes = new Uint8Array(ids + 8 + 8)
  const view = new DataView(bytes.buffer)
  const u32 = (at: number, value: number) => view.setUint32(at, value, true)
  const u16 = (at: number, value: number) => view.setUint16(at, value, true)
  bytes.set(new TextEncoder().encode('WDC5'))
  u32(4, 1); u32(136, 2); u32(140, fields); u32(144, 9); u32(148, strings.length)
  u32(156, 0x123456ab); u16(172, 4); u16(174, 0xffff); u32(176, 7)
  u32(188, fields * 24); u32(192, 8); u32(196, 24); u32(200, 1)
  u32(212, data); u32(216, 2); u32(220, strings.length); u32(228, 8); u32(240, 1)
  const spec = [
    [0, 5, 5, 0, 5, 0], [5, 0, 2, 8, 17, 0], [5, 1, 3, 8, 1, 0],
    [6, 1, 4, 16, 1, 2], [8, 32, 0, 0, 0, 0], [40, 32, 0, 0, 0, 0],
  ]
  spec.forEach(([bit, size, mode, extra, p1, cardinality], index) => {
    const fieldAt = 244 + index * 4
    view.setInt16(fieldAt, index === 0 ? 27 : 0, true)
    u16(fieldAt + 2, Math.floor(bit! / 8))
    const at = columns + index * 24
    u16(at, bit!); u16(at + 2, size!); u32(at + 4, extra!); u32(at + 8, mode!)
    u32(at + 12, mode === 2 ? 17 : bit!); u32(at + 16, p1!); u32(at + 20, cardinality!)
  })
  ;[12, 34, 7, 8, 9, 10].forEach((value, index) => u32(pallet + index * 4, value))
  u32(common, 0xf0000010); u32(common + 4, 99)
  bytes[data] = 29 | (1 << 6) // -3, single pallet[0], array pallet[1]
  bytes[data + 9] = 16 | (1 << 5) // -16, single pallet[1], array pallet[0]
  view.setFloat32(data + 1, 1.5, true); view.setFloat32(data + 10, 2.5, true)
  u32(data + 5, 14); u32(data + 14, 9)
  bytes.set(strings, data + 18)
  u32(ids, 0xf0000010); u32(ids + 4, 11); u32(ids + 8, 42); u32(ids + 12, 0xf0000010)
  return { bytes, schema: `COLUMNS
int ID
int Signed
int Common
int Pallet
int Pair
float Float
string Name

LAYOUT 123456AB
BUILD 12.1.0.69933
$noninline,id$ID<u32>
Signed<32>
Common<u32>
Pallet<u32>
Pair<u32>[2]
Float
Name
` }
}

export function sparseDatabase(): { bytes: Uint8Array; schema: string } {
  const data = 204 + 40 + 2 * 4 + 2 * 24
  const records = new Uint8Array([104, 105, 0, 0xfe, 0xff, 121, 111, 0, 7, 0])
  const map = data + records.length
  const relation = map + 12
  const ids = relation + 28
  const bytes = new Uint8Array(ids + 8)
  const view = new DataView(bytes.buffer)
  const u32 = (at: number, value: number) => view.setUint32(at, value, true)
  bytes.set(new TextEncoder().encode('WDC5'))
  u32(4, 1); u32(136, 2); u32(140, 2); u32(144, 6); u32(156, 0x123456ab)
  view.setUint16(172, 1, true); view.setUint16(174, 0xffff, true)
  u32(176, 4); u32(184, 1); u32(188, 48); u32(200, 1)
  u32(212, data); u32(216, 2); u32(224, map); u32(232, 28); u32(236, 2)
  view.setInt16(248, 16, true)
  view.setUint16(254, 32, true); view.setUint16(276, 32, true); view.setUint16(278, 16, true)
  bytes.set(records, data)
  u32(map, data); view.setUint16(map + 4, 5, true)
  u32(map + 6, data + 5); view.setUint16(map + 10, 5, true)
  u32(relation, 2); u32(relation + 12, 77); u32(relation + 16, 0)
  u32(relation + 20, 88); u32(relation + 24, 1)
  u32(ids, 15); u32(ids + 4, 16)
  return { bytes, schema: `COLUMNS
int ID
string Name
int Value
int<Parent::ID> ParentID

LAYOUT 123456AB
BUILD 12.1.0.69933
$noninline,id$ID<u32>
Name
Value<16>
$noninline,relation$ParentID<u32>
` }
}
