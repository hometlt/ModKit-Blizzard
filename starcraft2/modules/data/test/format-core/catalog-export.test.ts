/**
 * `sc2-data`'s `export.convert` surface: catalog JSON and per-namespace GameData XML, moved here
 * from `@modkitx/export` in Phase D item 3.
 */

import { describe, expect, it } from 'vitest'
import { isKnownAssetOperationId } from '@modkit/codec-kit/legacy/assets'
import { parseCatalogXml } from '../../shared/catalog-engine/xml/index.js'
import { createSc2DataCodec } from '../../shared/format/codec.js'
import { sc2DataHandlerId } from '../../shared/format/describe.js'
import { entityToXml } from '../../shared/format/entity-xml.js'
import { catalogNamespaceFileName, catalogNamespaceXml, exportCatalogJson, exportCatalogOutputs, parseSc2DataExportInput } from '../../shared/format/export.js'
import { DATA_OPERATION_IDS } from '../../shared/catalog-engine/operations'
import { CHAINED_LEAF_XML, SELF_CONTAINED_XML, fixtureSource } from './fixtures.js'

const codec = createSc2DataCodec()
const openSelfContained = () => codec.open(fixtureSource(SELF_CONTAINED_XML), {})

/** A catalog with a real `id=""` default entity, which is what `omitDefaults` diffs against. */
const DEFAULT_ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit default="1" id="">
    <LifeMax value="40"/>
    <Radius value="0.5"/>
  </CUnit>
  <CUnit id="Marine">
    <LifeMax value="45"/>
    <Radius value="0.5"/>
  </CUnit>
  <CAbilEffectTarget id="Zap"/>
</Catalog>
`

describe('catalog export (pure transforms)', () => {
  it('exports resolved fields by default and raw fields on request', async () => {
    const { catalog } = await openSelfContained()

    const full = exportCatalogJson(catalog)
    // `Marine` inherits `Radius` from the in-file default entity.
    expect(full['Unit']?.['Marine']).toMatchObject({ LifeMax: '45', Radius: '0.5' })

    const raw = exportCatalogJson(catalog, { mode: 'raw' })
    expect(raw['Unit']?.['Marine']).not.toHaveProperty('Radius')
  })

  it('omits fields equal to the default entity when asked, and records a non-base class', async () => {
    const document = await codec.open(fixtureSource(DEFAULT_ENTITY_XML), {})
    const trimmed = exportCatalogJson(document.catalog, { omitDefaults: true })
    // Radius matches the id="" default entity's value; LifeMax does not.
    expect(trimmed['Unit']?.['Marine']).not.toHaveProperty('Radius')
    expect(trimmed['Unit']?.['Marine']).toHaveProperty('LifeMax', '45')
    // A subclass entity records its class; a plain `CUnit` does not.
    expect(trimmed['Abil']?.['Zap']).toHaveProperty('class', 'CAbilEffectTarget')
    expect(trimmed['Unit']?.['Marine']).not.toHaveProperty('class')
  })

  it('restricts output to the requested namespaces', async () => {
    const { catalog } = await openSelfContained()
    expect(Object.keys(exportCatalogJson(catalog, { namespaces: ['Weapon'] }))).toEqual(['Weapon'])
  })

  it('serializes one namespace as a parseable <Catalog> document', async () => {
    const { catalog } = await openSelfContained()
    expect(catalogNamespaceFileName('Unit')).toBe('unitdata.xml')

    const xml = catalogNamespaceXml(catalog, 'Unit')
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<Catalog>')).toBe(true)
    expect(xml).toContain('<CUnit id="BaseUnit"')
    expect(xml).toContain('parent="BaseUnit"')
    // Round-trips back through the real catalog parser.
    expect(parseCatalogXml(xml).rootTypes).toContain('CUnit')
  })

  it('entityToXml escapes attribute values', () => {
    const xml = entityToXml('CUnit', 'A&B', undefined, { Name: 'x<"y' }, false, {
      indent: '  ',
      writeDefaultAttr: true,
    })
    expect(xml).toContain('id="A&amp;B"')
    expect(xml).toContain('value="x&lt;&quot;y"')
  })
})

describe('sc2-data export.convert', () => {
  it('is declared with a stable shared operation ID', () => {
    expect(DATA_OPERATION_IDS.export).toBe('export.convert')
    expect(isKnownAssetOperationId(DATA_OPERATION_IDS.export)).toBe(true)
  })

  it('rejects malformed input', () => {
    expect(() => parseSc2DataExportInput('nope')).toThrow()
    expect(() => parseSc2DataExportInput({ format: 'yaml' })).toThrow()
    expect(() => parseSc2DataExportInput({ mode: 'partial' })).toThrow()
    expect(() => parseSc2DataExportInput({ namespaces: [1] })).toThrow()
    expect(parseSc2DataExportInput(undefined)).toEqual({})
    expect(parseSc2DataExportInput({ format: 'xml', indent: '  ' })).toEqual({
      format: 'xml',
      indent: '  ',
    })
  })

  it('emits one JSON AssetOutput by default and one XML AssetOutput per namespace', async () => {
    const { catalog } = await openSelfContained()

    const json = exportCatalogOutputs(catalog)
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({
      path: 'catalog.json',
      mediaType: 'application/json',
      role: 'sc2-data',
    })
    expect(JSON.parse(new TextDecoder().decode(json[0]!.data))).toHaveProperty('Unit')

    const xml = exportCatalogOutputs(catalog, { format: 'xml' })
    expect(xml.map(output => output.path).sort()).toEqual([
      'GameData/unitdata.xml',
      'GameData/weapondata.xml',
    ])
    expect(xml.every(output => output.mediaType === 'application/xml')).toBe(true)
  })

  it('is exposed on the codec and dispatches through the stable handler ID', async () => {
    const document = await openSelfContained()
    expect(codec.exportCatalog(document, { format: 'xml' })).toHaveLength(2)

    const descriptor = await codec.describe(document, {})
    const session = codec.createSession(document, {}, descriptor, {
      grantedPermissions: ['read-source'],
    })
    const outputs = (await session.invoke(sc2DataHandlerId(DATA_OPERATION_IDS.export), {
      format: 'xml',
    })) as unknown[]
    expect(outputs).toHaveLength(2)
    await session.dispose()
  })

  it('stays available but carries the chain diagnostics when inheritance is incomplete', async () => {
    const partial = await codec.open(fixtureSource(CHAINED_LEAF_XML), {})
    const operation = (await codec.describe(partial, {})).operations.find(
      op => op.id === DATA_OPERATION_IDS.export,
    )
    expect(operation?.state).toBe('available')
    expect(operation?.diagnosticIds?.length).toBeGreaterThan(0)
    // Export still produces real, if partially resolved, output.
    expect(exportCatalogOutputs(partial.catalog)).toHaveLength(1)
  })
})
