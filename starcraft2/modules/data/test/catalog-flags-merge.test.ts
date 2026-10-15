import { expect, it } from 'vitest'
import { parseCatalogXml } from '../shared/catalog-engine/xml/index.js'
import { createBuiltinRegistry } from '../shared/catalog-engine/sc2-schema/builtin.js'
import { TypedCatalog } from '../shared/catalog-engine/sc2-catalog/catalog.js'
import { mergeFields } from '../shared/catalog-engine/sc2-catalog/merge.js'

it('merges logical flags as XML indexed slots without losing inherited flags', () => {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([
    parseCatalogXml(
      '<Catalog><CUnit id="Parent"><Attributes index="Light" value="1"/><Attributes index="Biological" value="1"/></CUnit><CUnit id="Child" parent="Parent"><Attributes index="Mechanical" value="1"/></CUnit></Catalog>',
    ),
    parseCatalogXml(
      '<Catalog><CUnit id="Child"><Attributes index="Light" value="0"/></CUnit></Catalog>',
    ),
  ])
  expect(catalog.getResolved('Unit', 'Child')!.Attributes).toEqual([
    { index: 'Light', value: '0' },
    { index: 'Biological', value: '1' },
    { index: 'Mechanical', value: '1' },
  ])
})

it('keeps distinct singleton slots in nested indexed structures as well', () => {
  const merged = mergeFields(
    { Nested: { Items: { index: 'First', value: 'kept' } } },
    { Nested: { Items: { index: 'Second', value: 'added' } } },
    {
      Nested: {
        isArray: false,
        isLink: false,
        fields: {
          Items: { isArray: true, isLink: false, arrayMerge: 'indexed', indexAttr: 'index' },
        },
      },
    },
  )
  expect(merged).toEqual({
    Nested: {
      Items: [
        { index: 'First', value: 'kept' },
        { index: 'Second', value: 'added' },
      ],
    },
  })
})
