import { describe, expect, it } from 'vitest'
import { insertCatalogEntityXml } from '../services/editing/catalog-field-patch.js'
import { resolvedEntityDeclarationXml } from '../services/editing/resolved-entity-xml.js'

describe('SC2 resolved entity XML materialization', () => {
  const schema = {
    typeId: 'CWeaponLegacy',
    fields: [
      { fieldId: 'Damage', cardinality: 'scalar' },
      {
        fieldId: 'EffectArray',
        cardinality: 'indexed',
        indexKey: 'index',
        fields: [
          { fieldId: 'Link', cardinality: 'scalar' },
          { fieldId: 'Count', cardinality: 'scalar' },
        ],
      },
      { fieldId: 'PeriodArray', cardinality: 'append' },
      {
        fieldId: 'Cost',
        cardinality: 'scalar',
        fields: [
          {
            fieldId: 'Cooldown',
            cardinality: 'scalar',
            fields: [{ fieldId: 'TimeUse', cardinality: 'scalar' }],
          },
        ],
      },
    ],
  }
  const entity = {
    typeId: 'CWeaponLegacy',
    entityId: 'GaussRifle',
    fields: {
      Damage: 6,
      EffectArray: [
        { index: '0', value: { Link: 'GaussDamage', Count: 2 } },
        { index: 'Removed', value: { Link: 'OldDamage' }, removed: true },
      ],
      PeriodArray: [0.2, 0.4],
      Cost: { Cooldown: { TimeUse: 1.5 } },
    },
  }

  it('flattens the effective fields under a new independent id', () => {
    expect(resolvedEntityDeclarationXml(entity, schema, { entityId: 'MarineGauss' })).toBe(
      [
        '<CWeaponLegacy id="MarineGauss">',
        '  <Damage value="6"/>',
        '  <EffectArray index="0" Link="GaussDamage" Count="2"/>',
        '  <PeriodArray value="0.2"/>',
        '  <PeriodArray value="0.4"/>',
        '  <Cost>',
        '    <Cooldown TimeUse="1.5"/>',
        '  </Cost>',
        '</CWeaponLegacy>',
      ].join('\n'),
    )
  })

  it('inserts only the generated declaration and keeps surrounding bytes', () => {
    const source = '<Catalog>\n  <!-- keep -->\n</Catalog>\n'
    const declaration = resolvedEntityDeclarationXml(entity, schema, { entityId: 'MarineGauss' })
    const inserted = insertCatalogEntityXml(
      source,
      entity.typeId,
      'MarineGauss',
      declaration,
    )
    expect(inserted.changed).toBe(true)
    expect(inserted.text).toContain('  <!-- keep -->')
    expect(inserted.text).toContain('  <CWeaponLegacy id="MarineGauss">')
    expect(insertCatalogEntityXml(inserted.text, entity.typeId, 'MarineGauss', declaration)).toEqual(
      expect.objectContaining({ changed: false, reason: 'entity already exists' }),
    )
  })

  it('refuses incomplete schema metadata instead of dropping resolved fields', () => {
    expect(() =>
      resolvedEntityDeclarationXml(
        { ...entity, fields: { ...entity.fields, UnknownField: 'value' } },
        schema,
        { entityId: 'MarineGauss' },
      ),
    ).toThrow(/lack schema metadata/u)
  })
})
