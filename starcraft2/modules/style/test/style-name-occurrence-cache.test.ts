/**
 * Catalog and layout uses of style names are kept per frozen document between requests (a host that
 * retains call values hands the worker the same frozen document until its text changes). Kept uses
 * must equal a fresh scan, and a mutable document is always scanned again.
 */
import { describe, expect, it } from 'vitest'
import {
  catalogOccurrences,
  layoutOccurrences,
  styleNameAt,
  styleNameDefinition,
  styleNamePrepareRename,
  styleNameReferences,
  styleNameRename,
  styleWorkspace,
} from '../providers/language/src/style-names.js'

const sheet = Object.freeze({
  uri: 'file:///Probe.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style',
  languageId: 'sc2-style',
  version: 1,
  text: '<StyleFile>\n    <Constant name="Color" val="ff0000"/>\n    <Style name="Title" textcolor="#Color"/>\n</StyleFile>\n',
})
const catalog = Object.freeze({
  uri: 'file:///Probe.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt',
  languageId: 'sc2-strings',
  version: 1,
  text: 'UI/A=<s val="Title">a</s>\nUI/B=<c val="#Color">b</c><s val="Title">c</s>\n',
})
const layout = Object.freeze({
  uri: 'file:///Probe.SC2Mod/Base.SC2Data/UI/Layout/Hud.SC2Layout',
  languageId: 'sc2-layout',
  version: 1,
  text: '<Desc>\n  <Frame type="Label" name="Name">\n    <Style val="@@Title"/>\n  </Frame>\n</Desc>\n',
})

const request = (documents: readonly { uri: string; languageId: string; version: number; text: string }[]) =>
  ({
    document: documents[0],
    workspaceDocuments: documents,
    maxDocuments: 64,
    maxResults: 64,
    workspaceIncomplete: false,
  }) as unknown as Parameters<typeof styleWorkspace>[0]

const usesOf = (built: ReturnType<typeof styleWorkspace>, uri: string) =>
  built.catalogs.find(item => item.uri === uri)?.occurrences

describe('style name occurrence cache', () => {
  it('serves frozen catalogs and layouts the same uses a fresh scan finds', () => {
    const first = styleWorkspace(request([sheet, catalog, layout]))
    const second = styleWorkspace(request([sheet, catalog, layout]))
    expect(usesOf(second, catalog.uri)).toBe(usesOf(first, catalog.uri))
    expect(usesOf(second, layout.uri)).toBe(usesOf(first, layout.uri))
    expect(usesOf(second, catalog.uri)).toEqual(catalogOccurrences(catalog.text))
    expect(usesOf(second, layout.uri)).toEqual(layoutOccurrences(layout.text))
    expect(usesOf(second, catalog.uri)?.map(item => `${item.kind}:${item.name}`)).toEqual([
      'style:Title',
      'constant:Color',
      'style:Title',
    ])
    const title = usesOf(second, layout.uri)?.[0]
    expect(layout.text.slice(title?.start, title?.end)).toBe('Title')
    expect(Object.isFrozen(usesOf(second, catalog.uri))).toBe(true)
    expect(Object.isFrozen(title)).toBe(true)
  })

  it('scans a mutable document again on every request', () => {
    const editable: { uri: string; languageId: string; version: number; text: string } = {
      ...catalog, uri: 'file:///Probe.SC2Mod/deDE.SC2Data/LocalizedData/GameStrings.txt',
    }
    const before = styleWorkspace(request([sheet, editable]))
    expect(usesOf(before, editable.uri)).toHaveLength(3)
    editable.text = 'UI/A=<s val="Title">a</s>\n'
    editable.version = 2
    const after = styleWorkspace(request([sheet, editable]))
    expect(usesOf(after, editable.uri)?.map(item => item.name)).toEqual(['Title'])
  })

  it('finds the primary style name and rename range without reading unrelated users', () => {
    let unrelatedReads = 0
    const other = {
      ...layout,
      uri: 'file:///Probe.SC2Mod/Base.SC2Data/UI/Layout/Other.SC2Layout',
      get text() { unrelatedReads += 1; return layout.text },
    }
    const atTitle = {
      ...request([catalog, sheet, other]),
      position: { line: 0, character: catalog.text.indexOf('Title') + 2 },
    }
    expect(styleNameAt(atTitle)).toBe(true)
    expect(unrelatedReads).toBe(0)
    expect(styleNamePrepareRename(atTitle)).toEqual({
      placeholder: 'Title',
      range: {
        start: { line: 0, character: catalog.text.indexOf('Title') },
        end: { line: 0, character: catalog.text.indexOf('Title') + 5 },
      },
    })
    expect(unrelatedReads).toBe(0)
  })

  it('gets complete declarations without indexing unrelated uses and preserves incomplete scope', () => {
    let unrelatedReads = 0
    const other = {
      ...catalog,
      uri: 'file:///Probe.SC2Mod/frFR.SC2Data/LocalizedData/GameStrings.txt',
      get text() { unrelatedReads += 1; return catalog.text },
    }
    const atTitle = {
      ...request([catalog, sheet, other, layout]),
      position: { line: 0, character: catalog.text.indexOf('Title') + 2 },
    }
    expect(styleNameDefinition(atTitle)).toEqual({
      locations: [{
        uri: sheet.uri,
        range: { start: { line: 2, character: 17 }, end: { line: 2, character: 22 } },
      }],
      isIncomplete: false,
    })
    expect(unrelatedReads).toBe(0)
    expect(styleNameDefinition({ ...atTitle, workspaceIncomplete: true }).isIncomplete).toBe(true)
    expect(unrelatedReads).toBe(0)
    const references = styleNameReferences({ ...atTitle, includeDeclaration: true })
    expect(references.isIncomplete).toBe(false)
    expect(references.locations).toHaveLength(6)
    expect(new Set(references.locations.map(item => item.uri))).toEqual(
      new Set([sheet.uri, catalog.uri, other.uri, layout.uri]),
    )
    expect(unrelatedReads).toBeGreaterThan(0)
    const renamed = styleNameRename({ ...atTitle, newName: 'NewTitle', maxEdits: 64 })
    expect(renamed?.documentChanges).toHaveLength(4)
    expect(renamed?.documentChanges.flatMap(item => item.edits)).toHaveLength(6)
    expect(styleNameRename({
      ...atTitle, workspaceIncomplete: true, newName: 'NewTitle', maxEdits: 64,
    })).toBeUndefined()
  })

  it('keeps inherited font-group disambiguation while locating a primary sheet reference', () => {
    const dependency = {
      ...sheet,
      text: '<StyleFile><FontGroup name="Glyph"><CodepointRange font="Glyph.ttf"/></FontGroup></StyleFile>',
    }
    const primary = {
      ...sheet,
      uri: 'file:///Probe.SC2Mod/Base.SC2Data/UI/Own.SC2Style',
      text: '<StyleFile><Style name="Own" font="#Glyph"/></StyleFile>',
    }
    const atGlyph = {
      ...request([primary, dependency, catalog, layout]),
      position: { line: 0, character: primary.text.indexOf('Glyph') + 2 },
    }
    expect(styleNameDefinition(atGlyph)).toEqual({
      locations: [{
        uri: dependency.uri,
        range: { start: { line: 0, character: 28 }, end: { line: 0, character: 33 } },
      }],
      isIncomplete: false,
    })
  })

  it('preserves the first document at a duplicate URI before selecting declarations', () => {
    const primary = { ...catalog, text: 'UI/A=<s val="Ghost">a</s>\n' }
    const first = { ...layout, uri: sheet.uri, text: '<Desc/>' }
    const later = { ...sheet, text: '<StyleFile><Style name="Ghost"/></StyleFile>' }
    expect(styleNameDefinition({
      ...request([primary, first, later]),
      position: { line: 0, character: primary.text.indexOf('Ghost') + 2 },
    })).toEqual({ locations: [], isIncomplete: false })
  })
})
