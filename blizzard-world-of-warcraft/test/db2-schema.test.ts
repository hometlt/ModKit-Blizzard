import { describe, expect, it } from 'vitest'
import { parseDbd, selectDbdLayout } from '../src/db2/schema.js'

// Authored test data; no external definition dataset is distributed by this fixture.
const schema = `COLUMNS
int ID
int<Model::ID> ModelID
int TextureFileDataID
string Name
float Scale

LAYOUT 123456AB
BUILD 12.1.0.69933-12.1.0.70000
$noninline,id$ID<u32>
ModelID<u16>
TextureFileDataID<u32>[3]
Name
Scale
`

describe('WoW DBD schemas', () => {
  it('selects the native layout and build together and retains types, arrays and references', () => {
    const definition = parseDbd(schema)
    const layout = selectDbdLayout(definition, 0x123456ab, '12.1.0.69933')
    expect(layout.fields[0]).toMatchObject({ name: 'ID', id: true, inline: false, unsigned: true, bits: 32 })
    expect(layout.fields[1]).toMatchObject({ reference: { table: 'Model', field: 'ID' }, bits: 16 })
    expect(layout.fields[2]?.count).toBe(3)
    expect(() => selectDbdLayout(definition, 0x123456ab, '12.1.0.69932')).toThrow(/no layout/u)
    expect(() => selectDbdLayout(definition, 0x123456ac, '12.1.0.69933')).toThrow(/no layout/u)
  })
  it('refuses conflicting layouts, unknown fields and unsupported annotations', () => {
    const conflict = `${schema}\nLAYOUT 123456AB\nBUILD 12.1.0.69933\n$noninline,id$ID<u32>\nScale\n`
    expect(() => selectDbdLayout(parseDbd(conflict), 0x123456ab, '12.1.0.69933')).toThrow(/ambiguous/u)
    expect(() => parseDbd(`${schema.trim()}\nUnknown\n`)).toThrow(/undefined column/u)
    expect(() => parseDbd(schema.replace('$noninline,id$', '$unknown,id$'))).toThrow(/annotation/u)
    expect(() => parseDbd(schema, 2)).toThrow(/budget/u)
  })
})
