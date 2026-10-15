import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { LanguageDocument, LanguageFeatureRequest, LanguagePosition, LanguageProvider } from '@modkit/sdk'
import { extension } from './war3-harness.js'

/**
 * The JASS language services over a workspace of a small native library and a script that uses it,
 * both written for the test.
 */
const { createProvider } = (await import(
  pathToFileURL(join(extension, 'providers', 'jass-language', 'runtime.js')).href
)) as { createProvider(selection: { contract: string; major: number }): { value: LanguageProvider } }
const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }).value

const LIBRARY = `type thing extends handle
// Makes a thing at a place.
native MakeThing takes integer id, real x, real y returns thing
native Wait takes real seconds returns nothing
`
const SCRIPT = `globals
    thing last = null
endglobals
function Spawn takes integer count returns nothing
    local integer made = 0
    loop
        exitwhen made >= count
        set last = MakeThing('hfoo', 1.0, 2.0)
        set made = made + 1
    endloop
    call Wait(1.0, 2.0)
    call Missing()
endfunction
`
const library: LanguageDocument = { uri: 'memory://lib/common.j', languageId: 'jass', version: 1, text: LIBRARY }
const script: LanguageDocument = { uri: 'memory://map/war3map.j', languageId: 'jass', version: 1, text: SCRIPT }

const request = (document = script): LanguageFeatureRequest => ({
  document,
  workspaceDocuments: [script, library],
  workspaceIncomplete: false,
  maxResults: 200,
  maxDocuments: 10,
})
/** The position of the `occurrence`-th `needle` in the script, plus `offset` characters. */
function at(needle: string, occurrence = 0, offset = 1): LanguagePosition {
  let index = -1
  for (let seen = 0; seen <= occurrence; seen += 1) index = SCRIPT.indexOf(needle, index + 1)
  const before = SCRIPT.slice(0, index + offset).split('\n')
  return { line: before.length - 1, character: before.at(-1)!.length }
}

describe('JASS language services', () => {
  it('outlines and highlights a document', async () => {
    const analysis = await provider.analyze({ document: script })
    expect(analysis.diagnostics).toEqual([])
    expect(analysis.symbols.map(symbol => `${symbol.kind} ${symbol.name}`)).toEqual(['variable last', 'function Spawn'])
    const kinds = new Set(analysis.tokens.map(token => token.kind))
    for (const kind of ['keyword', 'function', 'variable', 'number', 'parameter'] as const) expect(kinds).toContain(kind)
  })

  it('shows a native with its comment, and finds it in the library', async () => {
    const hover = await provider.hover!({ ...request(), position: at('MakeThing') })
    expect(hover?.markdown).toContain('native MakeThing takes integer id, real x, real y returns thing')
    expect(hover?.markdown).toContain('Makes a thing at a place.')
    const definition = await provider.definition!({ ...request(), position: at('MakeThing') })
    expect(definition.locations).toEqual([
      { uri: library.uri, range: { start: { line: 2, character: 7 }, end: { line: 2, character: 16 } } },
    ])
  })

  it('finds and renames a local only inside its function', async () => {
    const references = await provider.references!({ ...request(), position: at('made', 1), includeDeclaration: true })
    expect(references.locations).toHaveLength(4)
    const edit = await provider.rename!({ ...request(), position: at('made', 1), newName: 'spawned', maxEdits: 50 })
    expect(edit?.documentChanges).toHaveLength(1)
    expect(edit?.documentChanges[0]?.edits).toHaveLength(4)
    // A keyword is not a name.
    expect(await provider.rename!({ ...request(), position: at('made', 1), newName: 'loop', maxEdits: 50 })).toBeUndefined()
  })

  it('reports undefined names and argument counts once the natives are in the workspace', async () => {
    const withLibrary = await provider.diagnostics!(request())
    expect(withLibrary.diagnostics.map(item => item.code)).toEqual(['jass/arguments', 'jass/undeclared-function'])
    const alone = await provider.diagnostics!({ ...request(), workspaceDocuments: [script] })
    expect(alone.diagnostics).toEqual([])
  })

  it('completes names in scope and helps with a call signature', async () => {
    const completion = await provider.completion!({ ...request(), position: at('exitwhen', 0, 9) })
    const labels = completion.items.map(item => ('label' in item ? item.label : ''))
    expect(labels).toEqual(expect.arrayContaining(['made', 'count', 'MakeThing', 'last', 'thing', 'loop']))
    const help = await provider.signatureHelp!({ ...request(), position: at("'hfoo', 1.0", 0, 9) })
    expect(help?.signatures[0]?.label).toBe('native MakeThing takes integer id, real x, real y returns thing')
    expect(help?.activeParameter).toBe(1)
  })
})
