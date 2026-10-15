import { describe, expect, it, vi } from 'vitest'

import { createSc2StringsLanguageProvider } from '../providers/language/src/language.js'
import { createStyleServedDefinitions } from '../../style/providers/language/src/served-definitions.js'

/** Two sheets of a chain (dependency and mod), the second redeclaring a style, and a catalog. */
const sheets = [
  { layerId: 'mod', path: 'Base.SC2Data/UI/FontStyles.SC2Style', uri: 'file:///mod/Base.SC2Data/UI/FontStyles.SC2Style',
    text: '<StyleFile>\n    <Style name="Title" template="Standard" height="20"/>\n</StyleFile>\n' },
  { layerId: 'core', path: 'base.sc2data/ui/fontstyles.sc2style', uri: 'content-source://core/fontstyles.sc2style',
    text: '<StyleFile>\n    <Constant name="Gold" val="ffd700"/>\n    <Style name="Standard" height="16"/>\n    <Style name="Title" template="Standard" textcolor="#Gold"/>\n</StyleFile>\n' },
]
const catalog = {
  uri: 'file:///mod/enUS.SC2Data/LocalizedData/GameStrings.txt',
  languageId: 'sc2-strings',
  version: 1,
  text: 'UI/Title=<s val="Title">Parity</s> <c val="#Gold">gold</c> <s val="Standard">x</s>\n',
}
const sheetDocument = (sheet: (typeof sheets)[number]) =>
  Object.freeze({ uri: sheet.uri, languageId: 'sc2-style', version: 1, text: sheet.text })
const positionAt = (needle: string, delta: number) => ({ line: 0, character: catalog.text.indexOf(needle) + delta })

function server() {
  const set = createStyleServedDefinitions()
  set.update(sheets)
  set.updateUsers([...sheets.map(sheet => ({ ...sheet, languageId: 'sc2-style' })),
    { layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', languageId: 'sc2-strings', text: catalog.text }])
  const query = vi.fn(async (_scope: string, question: unknown) => {
    const refs = question as { kind: string; document: { layerId: string; path: string }; position: { line: number; character: number };
      maxResults: number; includeDeclaration: boolean; incomplete: boolean }
    if (refs.kind === 'style.references') {
      const answer = set.references(refs.document.layerId, refs.document.path, refs.position, refs)
      return { ...answer, revision: '3', documents: answer.documents.map(item => ({ ...item,
        uri: item.path.endsWith('GameStrings.txt') ? catalog.uri : sheets.find(sheet => sheet.path === item.path)!.uri })) }
    }
    const asked = question as { kind: string; styleKind: 'style' | 'constant' | 'font-group'; name: string }
    expect(asked.kind).toBe('style.definition')
    const answer = set.definitions(asked.styleKind, asked.name)
    return {
      revision: '3',
      definitions: answer.definitions,
      documents: answer.documents.map(item => ({ ...item, uri: sheets.find(sheet => sheet.path === item.path)!.uri })),
    }
  })
  return { query }
}

const request = (needle: string, delta: number, served: boolean) => ({
  document: catalog,
  workspaceDocuments: served ? [catalog] : [catalog, ...sheets.map(sheetDocument)],
  workspaceIncomplete: false,
  maxResults: 100,
  maxDocuments: 16,
  position: positionAt(needle, delta),
  ...(served
    ? { workspaceContext: { id: 'c', revision: 'r', semanticComplete: true, documentOrigins: [], semanticInputs: [],
        modContext: { scope: 'mod-context:1', gameId: 'blizzard/starcraft-2', revision: '3', complete: true,
          document: { layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' } } } }
    : {}),
})

describe('Strings to Style definitions from the loaded mod server', () => {
  it.each([
    ['a redeclared style', '"Title"', 2],
    ['a constant', '#Gold', 2],
    ['a dependency style', '"Standard"', 3],
  ] as const)('answers %s exactly as the snapshot sheets do', async (_name, needle, delta) => {
    const snapshot = await createSc2StringsLanguageProvider().definition!(request(needle, delta, false) as never)
    const port = server()
    const provider = createSc2StringsLanguageProvider({ modContexts: port })
    const served = await provider.definition!(request(needle, delta, true) as never)
    expect(port.query).toHaveBeenCalledOnce()
    expect(served).toEqual(snapshot)
    expect(snapshot?.locations.length).toBeGreaterThan(0)
  })

  it('declares the served features only with a port, including style references', async () => {
    const without = createSc2StringsLanguageProvider() as Record<string, unknown>
    expect(without['modContextFeatures']).toBeUndefined()
    const port = server()
    const provider = createSc2StringsLanguageProvider({ modContexts: port }) as Record<string, unknown> & {
      modContextFeatureApplies(request: unknown): Promise<boolean>
    }
    expect(provider['modContextFeatures']).toEqual(['definition', 'references', 'hover', 'diagnostics', 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols', 'completion', 'documentColors'])
    expect(await provider.modContextFeatureApplies({ feature: 'definition', document: catalog, position: positionAt('"Title"', 2) })).toBe(true)
    // Both keys and style-name usages are served.
    expect(await provider.modContextFeatureApplies({ feature: 'definition', document: catalog, position: positionAt('UI/Title', 2) })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'references', document: catalog, position: positionAt('"Title"', 2) })).toBe(true)
  })
  it('returns the same style declarations and users without carrying chain documents', async () => {
    const port = server()
    const expected = await createSc2StringsLanguageProvider().references!({ ...request('"Title"', 2, false), includeDeclaration: true } as never)
    const actual = await createSc2StringsLanguageProvider({ modContexts: port }).references!({ ...request('"Title"', 2, true), includeDeclaration: true } as never)
    expect(actual).toEqual(expected)
    expect(actual.locations.some(location => location.uri === catalog.uri)).toBe(true)
  })
})
