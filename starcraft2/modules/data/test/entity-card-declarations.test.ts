/**
 * Parity plan 5.2: a card's source opens the declaration. A provenance entry names its layer file by
 * label; the service adds the file's address (a content source, or a file on disk) and the span of
 * the entity's opening tag, and a single-document card adds the span in its own file.
 */
import { describe, expect, it } from 'vitest'
import { entityDeclarationSpans } from '../shared/format/declarations.js'
import { provenanceDeclarations } from '../services/projections/data-sources.js'

const UNITS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  '    <CUnit id="Marine">',
  '        <LifeMax value="45"/>',
  '    </CUnit>',
  '    <CUnit id="Marauder" parent="Marine"/>',
  '    <CUnit id="Marine"><Speed value="3"/></CUnit>',
  '</Catalog>',
  '',
].join('\n')

describe('declarations of catalog entities', () => {
  it('spans each entity id at its first opening tag', () => {
    const spans = entityDeclarationSpans(UNITS)
    expect(spans.get('Marine')).toEqual({ utf16Offset: UNITS.indexOf('<CUnit id="Marine">'), utf16Length: 19, line: 2, column: 4 })
    expect(spans.get('Marauder')).toMatchObject({ line: 5, column: 4 })
    expect(spans.has('LifeMax')).toBe(false)
  })

  it('gives a source its layer file address and the declaring span', () => {
    const declare = provenanceDeclarations(
      [
        { rootId: 'layer:1', path: 'Base.SC2Data/GameData/UnitData.xml', text: UNITS },
        { rootId: 'layer:2', path: 'Base.SC2Data/GameData/UnitData.xml', text: UNITS },
        { rootId: 'layer:3', path: 'Base.SC2Data/GameData/UnitData.xml', text: UNITS },
        { rootId: 'layer:3:Maps/Hold.SC2Map', path: 'Base.SC2Data/GameData/UnitData.xml', text: UNITS },
        { rootId: 'layer:4', path: 'Base.SC2Data/GameData/UnitData.xml', text: UNITS },
      ],
      {
        // Two roots on disk share one source; each states its own real path (core e4decaa7).
        loadOrder: [
          { rootId: 'layer:1', sourceId: 'local:casc', sourcePath: 'Mods/Liberty.SC2Mod' },
          { rootId: 'layer:2', sourceId: 'host', sourcePath: 'context-layers/2', location: 'C:/Mods/Probe Mod.SC2Mod' },
          { rootId: 'layer:3', sourceId: 'host', sourcePath: 'context-layers/3', location: 'C:/Mods/Story.SC2Campaign' },
          {
            rootId: 'layer:3:Maps/Hold.SC2Map',
            sourceId: 'host',
            sourcePath: 'context-layers/3/Maps/Hold.SC2Map',
            location: 'C:/Mods/Story.SC2Campaign/Maps/Hold.SC2Map',
          },
          // An older host without `location`: no address rather than a wrong one.
          { rootId: 'layer:4', sourceId: 'host', sourcePath: 'context-layers/4' },
        ],
        sources: [
          { sourceId: 'local:casc', location: 'Mods/Liberty.SC2Mod' },
          { sourceId: 'host', location: 'C:/Mods/Probe Mod.SC2Mod' },
        ],
      },
    )
    const semanticPath = ['Unit', 'Marine', 'LifeMax']
    expect(declare({ label: 'layer:1:Base.SC2Data/GameData/UnitData.xml', semanticPath })).toMatchObject({
      source: {
        uri: 'content-source://local%3Acasc/Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
      },
      range: { line: 2, column: 4 },
    })
    expect(declare({ label: 'layer:2:Base.SC2Data/GameData/UnitData.xml', semanticPath }).source?.uri).toBe(
      'file:///C:/Mods/Probe%20Mod.SC2Mod/Base.SC2Data/GameData/UnitData.xml',
    )
    expect(declare({ label: 'layer:3:Base.SC2Data/GameData/UnitData.xml', semanticPath }).source?.uri).toBe(
      'file:///C:/Mods/Story.SC2Campaign/Base.SC2Data/GameData/UnitData.xml',
    )
    expect(
      declare({ label: 'layer:3:Maps/Hold.SC2Map:Base.SC2Data/GameData/UnitData.xml', semanticPath }).source?.uri,
    ).toBe('file:///C:/Mods/Story.SC2Campaign/Maps/Hold.SC2Map/Base.SC2Data/GameData/UnitData.xml')
    expect(declare({ label: 'layer:4:Base.SC2Data/GameData/UnitData.xml', semanticPath }).source).toBeUndefined()
    // A file this snapshot did not analyse stays a label.
    const unknown = { label: 'layer:9:Other.xml', semanticPath }
    expect(declare(unknown)).toBe(unknown)
  })
})
