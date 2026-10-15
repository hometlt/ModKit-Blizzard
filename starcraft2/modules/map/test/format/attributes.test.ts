import { describe, expect, it } from 'vitest'
import { readAttributes, writeAttributes, writeAttributesEditorLayout } from '../../shared/format/formats/attributes.js'

const document = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Attributes>',
  '    <Attribute>',
  '        <Id Value="5"/>',
  '        <Type Value="Global"/>',
  '        <Name Value="Attribute005/Name"/>',
  '        <Availability Value="All"/>',
  '        <Visibility Value="All"/>',
  '        <Access Value="Host"/>',
  '        <PublicLocked/>',
  '        <Value>',
  '            <Id Value="1"/>',
  '            <Name Value="Attribute005/Value001/Name"/>',
  '            <Icon Value="Assets\\Icons\\gold.dds"/>',
  '        </Value>',
  '        <Default>',
  '            <Slot Id="Global"/>',
  '            <Value Id="1"/>',
  '        </Default>',
  '    </Attribute>',
  '    <DefaultVariants Value="0"/>',
  '    <Variant>',
  '        <Id Value="1"/>',
  '        <MaxTeamSize Value="12"/>',
  '        <AttributeHidden Namespace="999" Id="3006"/>',
  '    </Variant>',
  '</Attributes>',
].join('\r\n')

describe('Attributes document', () => {
  it('reads own attributes as typed definitions and writes the same bytes', () => {
    const model = readAttributes(document)
    expect(model.attributes).toMatchObject([{
      id: '5', type: 'Global', name: 'Attribute005/Name', access: 'Host', publicLocked: true,
      values: [{ id: '1', name: 'Attribute005/Value001/Name', icon: 'Assets\\Icons\\gold.dds' }],
    }])
    expect(model.defaultVariants).toBe(0)
    expect(model.variants).toHaveLength(1)
    expect(writeAttributes(model)).toBe(document)
    model.attributes[0]!.access = 'Self'
    expect(writeAttributes(model)).toBe(document.replace('<Access Value="Host"/>', '<Access Value="Self"/>'))
  })

  it('keeps what it cannot name whole and in place through a typed edit', () => {
    // Attributes on the root, an attribute and a value, an extra attribute on a field, a leading-zero count.
    const unusual = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Attributes Version="2">',
      '    <Attribute>',
      '        <Id Value="5" Extra="1"/>',
      '        <Id Value="5"/>',
      '        <Type Value="Global"/>',
      '        <Future/>',
      '        <Value Tag="a">',
      '            <Id Value="1"/>',
      '        </Value>',
      '        <Value>',
      '            <Id Value="2"/>',
      '            <Name Value="Attribute005/Value002/Name" Case="upper"/>',
      '        </Value>',
      '    </Attribute>',
      '    <Attribute Kind="x">',
      '        <Id Value="6"/>',
      '    </Attribute>',
      '    <DefaultVariants Value="01"/>',
      '    <Variant>',
      '        <Id Value="1"/>',
      '    </Variant>',
      '</Attributes>',
    ].join('\r\n')
    const model = readAttributes(unusual)
    expect(model.root?.attributes).toEqual({ Version: '2' })
    expect(model.defaultVariants).toBeUndefined()
    expect(model.attributes.map(definition => definition.id)).toEqual(['5'])
    expect(model.attributes[0]!.values.map(item => item.id)).toEqual(['2'])
    model.attributes[0]!.type = 'Player'
    expect(writeAttributesEditorLayout(model)).toBe(unusual.replace('<Type Value="Global"/>', '<Type Value="Player"/>'))
    const copy = JSON.parse(JSON.stringify(model)) as ReturnType<typeof readAttributes>
    expect(writeAttributesEditorLayout(copy)).toBe(unusual.replace('<Type Value="Global"/>', '<Type Value="Player"/>'))
  })

  it('refuses a document that is not <Attributes>', () => {
    expect(() => readAttributes('<AIData/>')).toThrow(/expected <Attributes>/u)
  })
})
