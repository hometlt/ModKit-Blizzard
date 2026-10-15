import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { LanguageDocument, LanguageFeatureRequest, LanguageProvider } from '@modkit/sdk'
import { extension } from './war3-harness.js'

/** Trigger strings and the script that names them, both written for the test. */
const load = async (name: string) =>
  (
    (await import(pathToFileURL(join(extension, 'providers', name, 'runtime.js')).href)) as {
      createProvider(selection: { contract: string; major: number }): { value: LanguageProvider }
    }
  ).createProvider({ contract: 'common.language/document-analysis', major: 1 }).value
const wtsProvider = await load('wts-language')
const jassProvider = await load('jass-language')
const { parseWts } = (await import(
  pathToFileURL(join(extension, 'dist', 'wts', 'format.js')).href
)) as typeof import('../dist/wts/format.js')

const WTS = `﻿STRING 1
{
The Lost Lantern
}

STRING 2
// Quest description
{
Find the |cffffcc00lantern|r.|nReturn it.
}

STRING 2
{
Again
}
`
const SCRIPT = `function Title takes nothing returns string
    return "TRIGSTR_002"
endfunction
`
const strings: LanguageDocument = { uri: 'memory://map/war3map.wts', languageId: 'war3-wts', version: 1, text: WTS }
const script: LanguageDocument = { uri: 'memory://map/war3map.j', languageId: 'jass', version: 1, text: SCRIPT }
const request = (document: LanguageDocument): LanguageFeatureRequest => ({
  document,
  workspaceDocuments: [strings, script],
  workspaceIncomplete: false,
  maxResults: 100,
  maxDocuments: 10,
})

describe('Warcraft III trigger strings', () => {
  it('reads entries, their comments and multi-line text, and reports a repeated id', () => {
    const file = parseWts(WTS)
    expect(file.entries.map(entry => [entry.id, entry.comment, entry.text])).toEqual([
      [1, '', 'The Lost Lantern'],
      [2, 'Quest description', 'Find the |cffffcc00lantern|r.|nReturn it.'],
      [2, '', 'Again'],
    ])
    expect(file.errors.map(error => [error.code, error.message])).toEqual([['wts/duplicate', 'STRING 2 is defined twice']])
    expect(parseWts('STRING 3\n{\nnever closed\n').errors[0]?.message).toBe('STRING 3 has no closing «}» line')
    // A shipped campaign map writes one entry without braces: its text runs to the blank line.
    const bare = parseWts('STRING 4\nOne line.\n\nSTRING 5\n{\nNext\n}\n')
    expect(bare.errors).toEqual([])
    expect(bare.entries.map(entry => [entry.id, entry.text])).toEqual([
      [4, 'One line.'],
      [5, 'Next'],
    ])
  })

  it('outlines strings, shows their colours and finds where the script uses them', async () => {
    const analysis = await wtsProvider.analyze({ document: strings })
    expect(analysis.symbols.map(symbol => `${symbol.name}: ${symbol.detail}`)).toEqual([
      'STRING 1: The Lost Lantern',
      'STRING 2: Find the lantern.Return it.',
      'STRING 2: Again',
    ])
    const colors = await wtsProvider.documentColors!(request(strings))
    expect(colors.colors[0]?.color).toEqual({ alpha: 1, red: 1, green: 0.8, blue: 0 })
    const references = await wtsProvider.references!({
      ...request(strings),
      position: { line: 5, character: 7 },
      includeDeclaration: false,
    })
    expect(references.locations).toEqual([
      { uri: script.uri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 23 } } },
    ])
  })

  it('shows and opens a string from the script that names it', async () => {
    const position = { line: 1, character: 16 }
    const hover = await jassProvider.hover!({ ...request(script), position })
    expect(hover?.markdown).toBe('**TRIGSTR_002** — Find the lantern.Return it.')
    const definition = await jassProvider.definition!({ ...request(script), position })
    expect(definition.locations).toEqual([
      { uri: strings.uri, range: { start: { line: 5, character: 7 }, end: { line: 5, character: 8 } } },
    ])
  })
})
