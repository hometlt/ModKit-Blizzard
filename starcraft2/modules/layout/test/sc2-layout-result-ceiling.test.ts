/**
 * The host asks whole-document projections (symbols, colours) with its document ceiling of 65 536
 * results and interactive features with far fewer. The layout provider answers both from one
 * bounded parse, refuses only a ceiling beyond the host's, and says so when the parse kept only its
 * first findings.
 */
import { describe, expect, it } from 'vitest'
import {
  sc2LayoutDiagnostics,
  sc2LayoutDocumentColors,
  sc2LayoutDocumentSymbols,
} from '../providers/language/runtime.js'

const layout = (text: string) => ({
  uri: 'file:///fixture/Ceiling.SC2Layout',
  languageId: 'sc2-layout',
  version: 1,
  text,
})

const request = (document: ReturnType<typeof layout>, maxResults: number) => ({
  document,
  workspaceDocuments: [document],
  workspaceIncomplete: false,
  maxResults,
  maxDocuments: 16,
})

const panel = layout(
  [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<Desc>',
    '    <Frame type="Frame" name="Panel">',
    '        <Frame type="Label" name="Title">',
    '            <Style val="@@StandardTemplate"/>',
    '        </Frame>',
    '    </Frame>',
    '</Desc>',
    '',
  ].join('\n'),
)

describe('SC2Layout result ceilings', () => {
  it('answers whole-document projections at the host document ceiling', async () => {
    const symbols = await sc2LayoutDocumentSymbols(request(panel, 65_536))
    expect(symbols.symbols.map(item => item.name)).toEqual(['Panel'])
    expect(symbols.symbols[0]?.children?.map(item => item.name)).toEqual(['Title'])
    await expect(sc2LayoutDocumentColors(request(panel, 65_536))).resolves.toMatchObject({ colors: [] })
    // The same answer for an interactive ceiling, from the same parse.
    expect((await sc2LayoutDocumentSymbols(request(panel, 512))).symbols).toEqual(symbols.symbols)
  })

  it('refuses a ceiling beyond the host document ceiling', async () => {
    await expect(sc2LayoutDocumentSymbols(request(panel, 65_537))).rejects.toThrow(/maxResults/u)
  })

  it('reports a parse that kept only its first findings as incomplete', async () => {
    const broken = layout(`<Desc>\n${'</Nope>\n'.repeat(1_001)}</Desc>\n`)
    const answer = await sc2LayoutDiagnostics(request(broken, 5_000))
    expect(answer.diagnostics.filter(item => /Unexpected closing tag/u.test(item.message))).toHaveLength(1_000)
    expect(answer.isIncomplete).toBe(true)
  })
})
