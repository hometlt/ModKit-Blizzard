import { describe, expect, it } from 'vitest'
import { analyzeStarcraft2ResolvedData } from '../services/catalog/provider.js'
import { lowerSc2UnitSlice, lowerSc2UnitSlices } from '../services/uvd/unit-slice.js'

const xml = `<Catalog>
  <CUnit id="Marine"><LifeMax value="45"/><LifeStart value="45"/><Speed value="2.25"/>
    <WeaponArray Link="GaussRifle"/><Name value="Unit/Name/Marine"/>
  </CUnit>
</Catalog>`

const analyze = (sourceXml = xml) => analyzeStarcraft2ResolvedData({
  workspaceId: 'workspace:runtime-unit-slice', gameId: 'blizzard/starcraft-2',
  documents: [{ rootId: 'fixture', path: 'Base.SC2Data/GameData/UnitData.xml', text: sourceXml,
    revision: 'sha256:unit-slice' }],
  localizationDocuments: [], locales: [], localizationKeys: [], queries: [],
  maxDocuments: 2, maxTextBytes: 65_536, maxEntities: 16, maxDepth: 32,
  plannedDocumentCount: 1, unresolvedRequirementIds: [],
})

const quanta: Record<string, string> = { '45': '193273528320', '2.25': '9663676416' }
const quantize = (decimal: string): string => {
  const value = quanta[decimal]
  if (value === undefined) throw new Error(`unexpected numeric source ${decimal}`)
  return value
}

describe('SC2 resolved Unit → bounded UVD runtime slice', () => {
  it('publishes several Units from one resolved snapshot with one kind schema and sorted provenance', async () => {
    const snapshot = await analyze(xml.replace('</Catalog>',
      '<CUnit id="Zergling" parent="Marine"/></Catalog>'))
    const result = lowerSc2UnitSlices(snapshot, [
      { namespace: 'Unit', entityId: 'Zergling' },
      { namespace: 'Unit', entityId: 'Marine' },
    ], quantize)
    expect(result.definitions.definitions.map(unit => unit.name)).toEqual([
      'e-4d6172696e65', 'e-5a6572676c696e67',
    ])
    expect(result.definitions.definitions[1]?.fields).toMatchObject({
      healthMax: '193273528320', movementSpeed: '9663676416',
    })
    expect(result.receipts.map(item => item.sourceEntity.entityId)).toEqual(['Marine', 'Zergling'])
    expect(result.receipts.every(item => item.snapshotId === snapshot.snapshotId)).toBe(true)
    expect(result.kindSchema).toEqual(lowerSc2UnitSlice(snapshot,
      { namespace: 'Unit', entityId: 'Marine' }, quantize).kindSchema)
    expect(() => lowerSc2UnitSlices(snapshot, [], quantize)).toThrow(/1..256/)
    expect(() => lowerSc2UnitSlices(snapshot, [
      { namespace: 'Unit', entityId: 'Marine' }, { namespace: 'Unit', entityId: 'Marine' },
    ], quantize)).toThrow(/distinct/)
  })

  it('uses the Data owner snapshot and schema, retaining provenance and declaring omissions', async () => {
    const snapshot = await analyze()
    const result = lowerSc2UnitSlice(snapshot, { namespace: 'Unit', entityId: 'Marine' }, quantize)
    const document = result.definitions as { definitions: { name: string; fields: Record<string, unknown> }[] }
    expect(document.definitions[0]).toMatchObject({
      name: 'e-4d6172696e65',
      fields: { healthMax: '193273528320', healthStart: '193273528320',
        movementSpeed: '9663676416', weaponLinks: ['GaussRifle'] },
    })
    expect(result.receipt.snapshotId).toBe(snapshot.snapshotId)
    expect(result.receipt.fieldSources?.LifeMax?.path).toBe('Base.SC2Data/GameData/UnitData.xml')
    expect(snapshot.definitions.find(entity => entity.entityId === 'Marine')?.fieldLexemes).toMatchObject({
      LifeMax: '45', LifeStart: '45', Speed: '2.25',
    })
    expect(result.receipt.omittedNativeFields).toContain('Name')
    expect(result.receipt.completeCatalogExport).toBe(false)
  })

  it('refuses incomplete snapshots and invalid quantization instead of admitting a partial unit', async () => {
    const snapshot = await analyze()
    const ref = { namespace: 'Unit', entityId: 'Marine' }
    expect(() => lowerSc2UnitSlice({ ...snapshot, complete: false }, ref, quantize)).toThrow(/complete/)
    expect(() => lowerSc2UnitSlice(snapshot, ref, () => '1.5')).toThrow(/noncanonical/)
    expect(() => lowerSc2UnitSlice(snapshot, { namespace: 'Weapon', entityId: 'Marine' }, quantize)).toThrow(/Unit/)
    const withoutOrigins = { ...snapshot, definitions: snapshot.definitions.map(entity =>
      entity.entityId === 'Marine' ? { ...entity, fieldSources: undefined } : entity) }
    expect(() => lowerSc2UnitSlice(withoutOrigins, ref, quantize)).toThrow(/provenance/)
    const withoutLexemes = { ...snapshot, definitions: snapshot.definitions.map(entity =>
      entity.entityId === 'Marine' ? { ...entity, fieldLexemes: undefined } : entity) }
    expect(() => lowerSc2UnitSlice(withoutLexemes, ref, quantize)).toThrow(/exact source decimal/)
  })

  it('passes the original decimal text through the canonical quantizer without Number round-trip', async () => {
    const decimal = '1.0000000000000001'
    const snapshot = await analyze(`<Catalog><CUnit id="Marine"><LifeMax value="${decimal}"/></CUnit></Catalog>`)
    const marine = snapshot.definitions.find(entity => entity.entityId === 'Marine')
    expect(marine?.fields.LifeMax).toBe(1)
    expect(marine?.fieldLexemes?.LifeMax).toBe(decimal)
    const received: string[] = []
    lowerSc2UnitSlice(snapshot, { namespace: 'Unit', entityId: 'Marine' }, source => {
      received.push(source)
      return '4294967296'
    })
    expect(received).toEqual([decimal])
  })

  it('keeps the winning decimal spelling across inherited and overridden fields', async () => {
    const snapshot = await analyze(`<Catalog>
      <CUnit id="Base"><LifeMax value="1.0000000000000001"/><Speed value="2.5"/></CUnit>
      <CUnit id="Marine" parent="Base"><Speed value="2.25"/></CUnit>
    </Catalog>`)
    const marine = snapshot.definitions.find(entity => entity.entityId === 'Marine')
    expect(marine?.fieldLexemes).toMatchObject({ LifeMax: '1.0000000000000001', Speed: '2.25' })
    const received: string[] = []
    lowerSc2UnitSlice(snapshot, { namespace: 'Unit', entityId: 'Marine' }, source => {
      received.push(source)
      return '4294967296'
    })
    expect(received).toEqual(['1.0000000000000001', '2.25'])
  })
})
