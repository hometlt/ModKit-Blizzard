import { describe, expect, it, vi } from 'vitest'

import { createSc2StringsLanguageProvider } from '../providers/language/src/language.js'
import { createStringsServedDiagnostics } from '../providers/language/src/served-diagnostics.js'

/*
 * A catalog whose markup names Data the chain declares and Data it does not: the loaded mod's server
 * checks it against the chain's catalogs exactly as the snapshot of the same files does.
 */
const catalog = {
  uri: 'file:///mod/enUS.SC2Data/LocalizedData/GameStrings.txt',
  languageId: 'sc2-strings',
  version: 1,
  text: 'UI/Known=<d ref="Unit,Marine,LifeMax"/>\nUI/Missing=<d ref="Unit,Ghost,LifeMax"/>\nUI/Other=<d stringref="Unit,Marine,Name"/>\n',
}
const place = { layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' }
const files = [
  { layerId: 'core', path: 'base.sc2data/gamedata/unitdata.xml', uri: 'content-source://core/unitdata.xml', languageId: 'sc2-data',
    text: '<Catalog>\n    <CUnit id="Marine">\n        <LifeMax value="45"/>\n    </CUnit>\n</Catalog>\n' },
  { layerId: 'core', path: 'enus.sc2data/localizeddata/gamestrings.txt', uri: 'content-source://core/enus/gamestrings.txt',
    languageId: 'sc2-strings', text: 'Unit/Name/Marine=Marine\n' },
]

function server() {
  const checker = createStringsServedDiagnostics()
  checker.update([...files, { ...place, languageId: 'sc2-strings', text: catalog.text }])
  const query = vi.fn(async (_scope: string, question: unknown) => {
    const asked = question as { kind: string; document: typeof place; uri: string; maxResults: number; incomplete: boolean; position: { line: number; character: number } }
    if (asked.kind === 'strings.hover') return { revision: '3', hover: checker.hover(asked.document.layerId, asked.document.path, asked.uri, asked.position) }
    expect(asked.kind).toBe('strings.diagnostics')
    return { revision: '3', diagnostics: checker.diagnostics(asked.document.layerId, asked.document.path, asked.uri, asked) }
  })
  return { query }
}

const request = (served: boolean) => ({
  document: catalog,
  workspaceDocuments: served ? [] : [catalog, ...files.map(file => ({ uri: file.uri, languageId: file.languageId, version: 1, text: file.text }))],
  workspaceIncomplete: false,
  maxResults: 100,
  maxDocuments: 16,
  ...(served
    ? { workspaceContext: { id: 'c', revision: 'r', semanticComplete: true, documentOrigins: [], semanticInputs: [],
        modContext: { scope: 'mod-context:1', gameId: 'blizzard/starcraft-2', revision: '3', complete: true, document: place } } }
    : {}),
})

describe('GameStrings diagnostics from the loaded mod server', () => {
  it('resolves value markup without carrying the chain to the language request', async () => {
    const port = server()
    const served = createSc2StringsLanguageProvider({ modContexts: port })
    const standalone = createSc2StringsLanguageProvider()
    for (const position of [{ line: 0, character: 22 }, { line: 1, character: 22 }]) {
      const expected = await standalone.hover!({ ...request(false), position } as never)
      expect(expected).toBeDefined()
      expect(await served.hover!({ ...request(true), position } as never)).toEqual(expected)
    }
    expect(port.query).toHaveBeenCalledTimes(2)
    await expect((served as { modContextFeatureApplies?: (request: unknown) => Promise<boolean> })
      .modContextFeatureApplies!({ document: catalog, feature: 'hover', position: { line: 0, character: 22 } })).resolves.toBe(true)
  })

  it('reports what the snapshot reports, a missing entity included', async () => {
    const snapshot = await createSc2StringsLanguageProvider().diagnostics!(request(false) as never)
    expect(snapshot.diagnostics.some(item => item.message.includes('Ghost'))).toBe(true)
    const port = server()
    const served = await createSc2StringsLanguageProvider({ modContexts: port }).diagnostics!(request(true) as never)
    expect(port.query).toHaveBeenCalledOnce()
    expect(served).toEqual(snapshot)
  })

  it('declares diagnostics served only with a port', () => {
    expect((createSc2StringsLanguageProvider({ modContexts: server() }) as { modContextFeatures?: readonly string[] })
      .modContextFeatures).toContain('diagnostics')
    expect((createSc2StringsLanguageProvider() as { modContextFeatures?: readonly string[] }).modContextFeatures).toBeUndefined()
  })
})
