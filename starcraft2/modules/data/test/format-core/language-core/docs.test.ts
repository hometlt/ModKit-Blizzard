import { describe, it, expect } from 'vitest'
import {
  parseXsdDocs,
  setFieldDocs,
  fieldDescription,
  fieldTypeLabel,
} from '../../../shared/format/language/docs.js'

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="LifeMax">
    <xs:annotation><xs:documentation>The maximum life of the unit.</xs:documentation></xs:annotation>
    <xs:complexType><xs:element name="Inner"/></xs:complexType>
  </xs:element>
  <xs:element name="Race">
    <xs:annotation><xs:documentation>The &lt;Race&gt; the unit belongs to.</xs:documentation></xs:annotation>
  </xs:element>
  <xs:element name="NoDoc"/>
</xs:schema>`

describe('parseXsdDocs', () => {
  it('maps element names to their own documentation (entities decoded)', () => {
    const docs = parseXsdDocs(XSD)
    expect(docs.get('LifeMax')).toBe('The maximum life of the unit.')
    expect(docs.get('Race')).toBe('The <Race> the unit belongs to.')
    expect(docs.has('NoDoc')).toBe(false)
  })
})

describe('fieldDescription', () => {
  it('returns prose once docs are installed, undefined when cleared', () => {
    setFieldDocs(parseXsdDocs(XSD))
    expect(fieldDescription('CUnit', 'LifeMax')).toBe('The maximum life of the unit.')
    setFieldDocs(undefined)
    expect(fieldDescription('CUnit', 'LifeMax')).toBeUndefined()
  })
})

describe('fieldTypeLabel', () => {
  it('describes common field kinds', () => {
    expect(fieldTypeLabel({ kind: 'link', linkNamespace: 'Weapon' })).toBe('link → Weapon')
    expect(fieldTypeLabel({ kind: 'enum', typeName: 'EAbilAlignment' })).toBe('enum EAbilAlignment')
    expect(fieldTypeLabel({ kind: 'file', typeName: 'CImageFile' })).toBe('CImageFile')
  })
})
