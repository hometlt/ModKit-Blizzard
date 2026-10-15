/*
 * The cross-language link index is incomplete for references and rename whenever any script passes
 * a gamelink it cannot read (Core's libraries do so everywhere). Only a gap that can hide a
 * declaration — the link bound, a catalog that does not parse — makes a document's diagnostics
 * incomplete, and only then is a literal without a declaration left unreported.
 */
import { describe, expect, it } from 'vitest'
import { createSc2WorkspaceLinkIndex } from '../language/sc2-workspace-links.js'

const catalog = (text: string) => ({ uri: 'file:///mod/UnitData.xml', languageId: 'sc2-data', version: 1, text })
const script = {
  uri: 'file:///mod/MapScript.galaxy',
  languageId: 'galaxy',
  version: 1,
  text: [
    'void Init(string name) {',
    '    UnitCreate(1, "Marine", 0, 1, Point(0, 0), 0.0);',
    '    UnitCreate(1, "Missing", 0, 1, Point(0, 0), 0.0);',
    '    UnitCreate(1, name, 0, 1, Point(0, 0), 0.0);',
    '}',
    '',
  ].join('\n'),
}
const indexOver = (data: ReturnType<typeof catalog>) =>
  createSc2WorkspaceLinkIndex({
    document: script,
    workspaceDocuments: [data, script],
    workspaceIncomplete: false,
    maxResults: 1000,
    maxDocuments: 16,
  })
const unresolved = (index: ReturnType<typeof indexOver>) =>
  index
    .diagnosticsFor(script.uri)
    .filter((item: { code?: string }) => item.code === 'sc2-cross-language/unresolved-catalog-literal')
    .map((item: { message: string }) => item.message)

describe('SC2 link index completeness for diagnostics', () => {
  it('reports a literal without a declaration despite a dynamic gamelink elsewhere', () => {
    const index = indexOver(catalog('<Catalog>\n  <CUnit id="Marine"/>\n</Catalog>\n'))
    expect(index.isIncomplete).toBe(true)
    expect(index.diagnosticsIncomplete).toBe(false)
    expect(unresolved(index)).toEqual(['Unit/Missing has no declaration in the bounded mixed workspace.'])
  })

  it('leaves it unreported when a catalog that may declare it does not parse', () => {
    const index = indexOver(catalog('<Catalog>\n  <CUnit id="Marine"/>\n  <\n</Catalog>\n'))
    expect(index.diagnosticsIncomplete).toBe(true)
    expect(unresolved(index)).toEqual([])
  })
})
