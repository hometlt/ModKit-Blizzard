/**
 * One read of catalog XML (S3 of the one-resolver decision): the Data provider types the elements
 * as written, the raw entry model is a projection of the same read.
 */
import { describe, expect, it } from 'vitest'
import { parseCatalogXml, parseCatalogXmlElements } from '../shared/catalog-engine/xml/index.js'

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="Marine" parent="Base">
    <?token id="Model" value="Marine "?>
    <LifeMax value="45"/>
    <Comment value="First time? "/>
  </CUnit>
  <const id="$Speed" value="2.25"/>
  <SEffectWhichUnit Value="Caster"/>
  <CActorUnit id="Marine"/>
</Catalog>`

describe('catalog XML read', () => {
  it('keeps document order, every tag, and values as written', () => {
    const [catalog] = parseCatalogXmlElements(XML)
    expect(catalog?.children.map(element => element.name)).toEqual(['CUnit', 'const', 'SEffectWhichUnit', 'CActorUnit'])
    const unit = catalog!.children[0]!
    expect(unit.tokens).toEqual([{ id: 'Model', value: 'Marine ' }])
    expect(unit.children.find(element => element.name === 'Comment')?.attributes['value']).toBe('First time? ')
  })

  it('projects the raw entry model with values as written, catalog classes only', () => {
    const parsed = parseCatalogXml(XML)
    expect(parsed.rootTypes).toEqual(['CUnit', 'CConst', 'CActorUnit'])
    expect(parsed.entries.get('CUnit')?.[0]).toMatchObject({
      id: 'Marine',
      parent: 'Base',
      fields: { LifeMax: '45', Comment: 'First time? ' },
      tokens: [{ id: 'Model', value: 'Marine ' }],
    })
  })

  it('refuses a malformed document', () => {
    expect(() => parseCatalogXmlElements('<Catalog><')).toThrow()
    expect(() => parseCatalogXml('<Catalog><CUnit id="a"></Catalog>')).toThrow()
  })
})
