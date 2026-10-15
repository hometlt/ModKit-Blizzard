/**
 * The style-string relation, from both ends.
 *
 * The two halves were built at different times and only one of them worked: a localization catalog
 * drew edges to `modkit-subject://blizzard%2Fsc2-style/Style/<name>`, and nothing declared those
 * ids, so every edge pointed at a subject that did not exist. These tests pin the join — that the
 * sheet publishes exactly the ids the catalog names, and that asking the sheet "who uses this?"
 * reaches the catalogs in the workspace snapshot.
 */
import { describe, expect, it } from 'vitest'
import { subjectIdFor } from '@modkit/codec-kit'

import { createSc2StyleLanguageProvider, SC2_STYLE_LANGUAGE_ID } from '../modules/style/providers/language/src/language.js'
import { styleRefsInCatalog, styleRefsOf } from '../shared/language/style-refs.js'

const SHEET = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<StyleFile>',
  '  <Constant name="ColorAttackInfo" val="ffcc00"/>',
  '  <Constant name="ColorUnused" val="00ff00"/>',
  '  <Style name="StandardTooltip" font="Standard" textcolor="#ColorAttackInfo"/>',
  '  <Style name="TooltipStyle" template="StandardTooltip"/>',
  '</StyleFile>',
  '',
].join('\n')

const CATALOG = [
  'Unit/Name/Marine=<s val="TooltipStyle">Marine</s>',
  'Unit/Tip/Marine=Costs <c val="ColorAttackInfo">50</c> minerals',
  '// a comment line names nothing',
  '',
].join('\n')

const document = (uri: string, text: string, languageId: string) => ({
  uri,
  languageId,
  version: 1,
  text,
})

const request = (position: { line: number; character: number }) => ({
  document: document('file:///FontStyles.SC2Style', SHEET, SC2_STYLE_LANGUAGE_ID),
  position,
  workspaceDocuments: [
    document('file:///FontStyles.SC2Style', SHEET, SC2_STYLE_LANGUAGE_ID),
    document('file:///enUS/GameStrings.txt', CATALOG, 'sc2-strings'),
  ],
  workspaceIncomplete: false,
  maxResults: 50,
  maxDocuments: 8,
})

/** The line and character of the first occurrence of `needle`, as the provider's request wants it. */
function positionOf(text: string, needle: string) {
  const offset = text.indexOf(needle)
  const before = text.slice(0, offset)
  const line = before.split('\n').length - 1
  return { line, character: offset - (before.lastIndexOf('\n') + 1) }
}

describe('what a string references', () => {
  it('reports styles and named colours, and not literal colours', () => {
    expect(styleRefsOf('<s val="TooltipStyle">x</s>')).toEqual([
      { kind: 'style', name: 'TooltipStyle' },
    ])
    expect(styleRefsOf('<c val="ColorAttackInfo">50</c>')).toEqual([
      { kind: 'color', name: 'ColorAttackInfo' },
    ])
    // `ffcc00` is six hex digits and also a perfectly good identifier; it is not a reference.
    expect(styleRefsOf('<c val="ffcc00">50</c>')).toEqual([])
    expect(styleRefsOf('<c val="255,204,0">50</c>')).toEqual([])
  })

  it('collects a whole catalog and skips comments', () => {
    expect(styleRefsInCatalog(CATALOG)).toEqual(['TooltipStyle', 'ColorAttackInfo'])
  })
})

describe('references, asked from the style sheet', () => {
  it('finds the catalog lines that apply a style, not only the sheet', async () => {
    const provider = createSc2StyleLanguageProvider()
    const result = await provider.references!(request(positionOf(SHEET, 'TooltipStyle')))
    const uris = result.locations.map(location => location.uri)
    expect(uris).toContain('file:///enUS/GameStrings.txt')
    expect(result.isIncomplete).toBe(false)
  })

  it('follows a constant into the catalog that colours with it', async () => {
    const provider = createSc2StyleLanguageProvider()
    const result = await provider.references!(request(positionOf(SHEET, 'ColorAttackInfo')))
    expect(result.locations.map(location => location.uri)).toContain(
      'file:///enUS/GameStrings.txt',
    )
  })

  it('reports the in-sheet use of a style by the style that inherits it', async () => {
    const provider = createSc2StyleLanguageProvider()
    const result = await provider.references!(request(positionOf(SHEET, 'StandardTooltip')))
    // Both the declaration and the `template="StandardTooltip"` that names it.
    expect(result.locations.length).toBeGreaterThanOrEqual(2)
  })

  it('says nothing for a name nothing uses, and for a cursor that is not on a name', async () => {
    const provider = createSc2StyleLanguageProvider()
    const unused = await provider.references!({
      ...request(positionOf(SHEET, 'ColorUnused')),
      includeDeclaration: false,
    })
    expect(unused.locations).toEqual([])

    // A constant's literal value names no declaration; `font="Standard"` would, so it is not used.
    const notAName = await provider.references!(request(positionOf(SHEET, 'ffcc00')))
    expect(notAName.locations).toEqual([])
  })

  it('declares the catalogs it needs, so a host sends them', () => {
    const provider = createSc2StyleLanguageProvider()
    expect(provider.workspaceLanguageIds).toContain('sc2-strings')
  })
})

describe('the subject ids the two sides must share', () => {
  it('addresses a style the same way from either end', () => {
    // If this ever diverges, every edge the catalog draws lands on a subject that does not exist.
    expect(subjectIdFor('blizzard/sc2-style', ['Style', 'TooltipStyle'])).toBe(
      'modkit-subject://blizzard%2Fsc2-style/Style/TooltipStyle',
    )
  })
})
