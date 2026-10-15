import { describe, expect, it } from 'vitest'
import { parseSc2MapDocuments, serializeSc2MapDocuments } from '../shared/coordinator.js'
import { createCodec as createMapCodec } from '../codecs/package/src/codec.js'
import { createCodec as createLooseMapCodec } from '../codecs/package-directory/runtime.js'
import { createNamespaceInput } from '../../../test/support/namespace-input.js'
import { parseWizardDocument } from '../../wizard/codecs/wizard/src/core/parse.js'

const text = (value: string) => new TextEncoder().encode(value)

describe('SC2 map document coordinator', () => {
  it.each([
    ['packed', createMapCodec],
    ['folder', createLooseMapCodec],
  ])('publishes the added documents through the public embedded-map operation (%s)', async (_, create) => {
    const wizard = `<!--${' '.repeat(300)}--><wizardfile><wizard id="Unit"><name>Create unit</name><objecttypes><type>Unit</type></objecttypes></wizard></wizardfile>`
    const input = createNamespaceInput({
      CustomAI: text('<AIData><RepeatShow Value="1800"/></AIData>'),
      Attributes: text('<Attributes><Value Id="A"/></Attributes>'),
      'PreloadAssetDB.txt': text('[Models]\nid=Nod\nasset=A\n'),
      CellAttribute_Pnp: new Uint8Array([0, 200, 3, 0, 0]),
      MapInfo: new Uint8Array(),
      Objects: text('<PlacedObjects/>'),
      Regions: text('<Regions/>'),
      'EditorWizards/Unit.BlizWiz': text(wizard),
      'EditorWizards/Legacy.xml': text('<DataWizard id="Legacy"><DataType value="CUnit"/></DataWizard>'),
    }, { revision: 'content-hash.sha256:map-document-coordinator' })
    const session = await (await create()).open(input as never, 'full', {
      maxInputBytes: 1_048_576n,
      maxDepth: 16,
      maxNodes: 1_000,
      maxScalarBytes: 1_048_576,
      maxDiagnostics: 100,
    } as never)
    try {
      const result = await session.operations().invoke('embedded-map', {})
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('embedded-map did not return JSON')
      expect(result.output.value).toMatchObject({
        customAi: { repeatShow: 1800, definitions: [] },
        attributes: { attributes: [], variants: [], unknown: [{ name: 'Value', attributes: { Id: 'A' } }] },
        preloadAssetDb: { sections: [{ name: 'Models' }] },
        cellAttributes: { pnp: { missingContext: 'map-dimensions' } },
        dataWizards: [{ path: 'EditorWizards/Unit.BlizWiz', value: parseWizardDocument(wizard).file }],
      })
      expect((result.output.value as { dataWizards: unknown[] }).dataWizards).toHaveLength(1)
      const world = await session.operations().invoke('world-map', {})
      expect(world.state).toBe('ok')
      if (world.state !== 'ok' || world.output.kind !== 'json') {
        throw new Error('world-map did not return JSON')
      }
      expect(world.output.value).toMatchObject({
        cellAttributes: {
          pnp: {
            path: 'CellAttribute_Pnp',
            byteLength: 5,
            missingContext: 'map-dimensions',
          },
        },
      })
    } finally {
      await session.dispose()
    }
  })

  it('routes confirmed native basenames without changing archive paths', () => {
    const customAi = '<?xml version="1.0"?><AIData><RepeatShow Value="1800"/></AIData>'
    const attributes = '<?xml version="1.0"?><Attributes><Value Id="A"/></Attributes>'
    const preload = '<Preload><Unit id="Marine"/></Preload>'
    const categories = '<EditorCategories><Category id="A"/></EditorCategories>'
    const files = new Map([
      ['Base/CustomAI', text(customAi)],
      ['Attributes', text(attributes)],
      ['Preload.xml', text(preload)],
      ['GameData/EditorCategories.xml', text(categories)],
      ['PreloadAssetDB.txt', text('; keep this comment\r\n[Models]\r\nid=Marine\r\npath=Assets/Units/M.x\r\nasset=A,B\r\n')],
    ])

    const data = parseSc2MapDocuments(files)
    expect(data.customAi?.repeatShow).toBe(1800)
    expect(data.attributes?.unknown?.[0]?.name).toBe('Value')
    expect(data.preload).toBeDefined()
    expect(data.editorCategories).toBeDefined()
    expect(data.preloadAssetDb?.sections[0]?.entries[0]?.id).toBe('Marine')

    const output = serializeSc2MapDocuments(data)
    expect([...output.keys()].sort()).toEqual([...files.keys()].sort())
    expect(new TextDecoder().decode(output.get('Base/CustomAI'))).toBe(customAi)
    expect(new TextDecoder().decode(output.get('Attributes'))).toBe(attributes)
    expect(output.get('PreloadAssetDB.txt')).toEqual(files.get('PreloadAssetDB.txt'))

    data.preloadAssetDb!.sections[0]!.entries[0]!.fields.asset!.push('C')
    expect(new TextDecoder().decode(serializeSc2MapDocuments(data).get('PreloadAssetDB.txt'))).toContain('asset=A,B,C')
  })

  it('keeps CellAttribute raw and reports missing geometry instead of guessing a square', () => {
    const bytes = new Uint8Array([0, 200, 3, 0, 0, 255, 0, 255])
    const data = parseSc2MapDocuments(new Map([['CellAttribute_Pnp', bytes]]))
    expect(data.cellAttributes?.pnp).toMatchObject({
      path: 'CellAttribute_Pnp', suffix: 'Pnp', byteLength: 8, missingContext: 'map-dimensions',
    })
    expect(data.cellAttributes?.pnp.value).toBeUndefined()
    expect(serializeSc2MapDocuments(data).get('CellAttribute_Pnp')).toEqual(bytes)
  })

  it('uses MapInfo dimensions for CellAttribute and preserves distinct suffixes', () => {
    const mapInfo = new Uint8Array(24)
    const view = new DataView(mapInfo.buffer)
    mapInfo.set(new TextEncoder().encode('IpaM'))
    view.setUint32(4, 0x17, true)
    view.setUint32(16, 2, true)
    view.setUint32(20, 2, true)
    const cell = new Uint8Array([0, 200, 3, 0, 0, 255, 0, 255])
    const errors: string[] = []
    const data = parseSc2MapDocuments(new Map([
      ['MapInfo', mapInfo], ['CellAttribute_Pnp', cell], ['CellAttribute_Pgr', cell],
    ]), { onError: path => errors.push(path) })

    expect(errors).toEqual([])
    expect(Array.from(data.cellAttributes!.pnp.value!.cells)).toEqual([0, 255, 0, 255])
    expect(data.cellAttributes?.pgr.value?.sizeX).toBe(2)
    expect(serializeSc2MapDocuments(data).get('CellAttribute_Pnp')).toEqual(cell)
  })

  it('routes PaintedCreepLayer through the shared lossless painted-layer container', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const data = parseSc2MapDocuments(new Map([['PaintedCreepLayer', bytes]]))
    expect(data.paintedCreep?.raw).toEqual(bytes)
    expect(serializeSc2MapDocuments(data).get('PaintedCreepLayer')).toEqual(bytes)
  })

  it('preserves legacy modeled bytes until the model changes', () => {
    const xml = '<PlacedObjects Version="12">\r\n  <ObjectUnit Id="1" Variation="0" Position="0,0,0" Scale="1,1,1" UnitType="Marine" Player="1"/>\r\n</PlacedObjects>'
    const bytes = text(xml)
    const data = parseSc2MapDocuments(new Map([['Objects', bytes]]))
    expect(serializeSc2MapDocuments(data).get('Objects')).toEqual(bytes)
    data.objects!.units[0]!.unitType = 'Marauder'
    const changed = serializeSc2MapDocuments(data).get('Objects')!
    expect(changed).not.toEqual(bytes)
    expect(new TextDecoder().decode(changed)).toContain('UnitType="Marauder"')
  })

  it('rejects a mismatched XML root while retaining the source bytes', () => {
    const errors: string[] = []
    const bytes = text('<NotAttributes/>')
    const data = parseSc2MapDocuments(new Map([['Attributes', bytes]]), {
      onError: (path, error) => errors.push(`${path}: ${String(error)}`),
    })
    expect(data.attributes).toBeUndefined()
    expect(data.rawFiles.get('Attributes')).toEqual(bytes)
    expect(errors[0]).toContain('expected <Attributes> root')
  })
})
