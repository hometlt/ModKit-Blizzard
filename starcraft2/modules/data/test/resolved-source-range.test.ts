/**
 * Where a resolved entity is declared, to the character (sdk `DataEntitySource.range`): a card from
 * the mod context opens a field at its layer's declaration, not at the top of the file.
 */
import { describe, expect, it } from 'vitest'
import { analyzeStarcraft2ResolvedData } from '../services/catalog/provider.js'
import { createEngineCatalog } from '../services/catalog/engine-resolution.js'
import { parseCatalogXmlElements } from '../shared/catalog-engine/xml/index.js'

describe('resolved Data sources', () => {
  it('preserves one immutable declaration across inherited fields and leaf provenance', () => {
    const parent = '<Catalog>\n<CUnit id="Base"><Speed value="2"/><LifeMax value="45"/></CUnit>\n</Catalog>'
    const child = '<Catalog>\n<CUnit id="Child" parent="Base"><LifeMax value="60"/></CUnit>\n</Catalog>'
    const engine = createEngineCatalog([
      { rootId: 'base', path: 'Base/UnitData.xml', text: parent, elements: parseCatalogXmlElements(parent) },
      { rootId: 'mod', path: 'Mod/UnitData.xml', text: child, elements: parseCatalogXmlElements(child) },
    ])
    const base = engine.resolve('Unit', 'Base')
    const resolved = engine.resolve('Unit', 'Child')
    const provenance = engine.provenance('Unit', 'Child')
    expect(base).toBeDefined()
    expect(resolved).toBeDefined()
    const declaration = base?.sources[0]
    expect(declaration).toMatchObject({ rootId: 'base', path: 'Base/UnitData.xml', range: { line: 1, column: 0 } })
    expect(base?.fieldSources['Speed']).toBe(declaration)
    expect(base?.fieldSources['LifeMax']).toBe(declaration)
    expect(resolved?.fieldSources['Speed']).toBe(declaration)
    expect(provenance?.leaf('Speed', [])?.source).toBe(declaration)
    expect(resolved?.fieldSources['LifeMax']).toMatchObject({ rootId: 'mod', path: 'Mod/UnitData.xml' })
    expect(resolved?.fieldSources['LifeMax']).not.toBe(declaration)
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Object.isFrozen(declaration?.range)).toBe(true)
    expect(engine.resolve('Unit', 'Base')?.sources[0]).toBe(declaration)
  })

  it('give the span of the declaring opening tag, the parent declaration for inherited fields', async () => {
    const text = [
      '<Catalog>',
      '  <CUnit id="Base" default="1">',
      '    <Speed value="2"/>',
      '  </CUnit>',
      '  <CUnit id="Marine" parent="Base">',
      '    <LifeMax value="45"/>',
      '  </CUnit>',
      '</Catalog>',
      '',
    ].join('\n')
    const snapshot = (await analyzeStarcraft2ResolvedData({
      workspaceId: 'range',
      gameId: 'blizzard/starcraft-2',
      documents: [{ rootId: 'core', path: 'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml', text }],
      queries: [],
      plannedDocumentCount: 1,
      unresolvedRequirementIds: [],
      maxDocuments: 4,
      maxTextBytes: 1_000_000,
      maxEntities: 100,
      maxDepth: 16,
    })) as { definitions: readonly { entityId: string; sources: readonly { range?: unknown }[]; fieldSources?: Record<string, { range?: unknown }> }[] }
    const marine = snapshot.definitions.find(item => item.entityId === 'Marine')!
    const span = (tag: string, line: number) => ({
      utf16Offset: text.indexOf(tag),
      utf16Length: tag.length,
      line,
      column: 2,
    })
    expect(marine.sources.at(-1)?.range).toEqual(span('<CUnit id="Marine" parent="Base">', 4))
    expect(marine.fieldSources?.['LifeMax']?.range).toEqual(span('<CUnit id="Marine" parent="Base">', 4))
    expect(marine.fieldSources?.['Speed']?.range).toEqual(span('<CUnit id="Base" default="1">', 1))
  })
})
