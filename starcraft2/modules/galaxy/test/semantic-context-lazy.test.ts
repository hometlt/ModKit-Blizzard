import { expect, it, vi } from 'vitest'
import { galaxyCompletion, galaxyDefinition, galaxyReferences, galaxyDocumentSymbols, galaxyHover } from '../language/semantic-provider.js'
import * as links from '../language/sc2-workspace-links.js'
import { createProvider } from '../language/provider.js'
import { LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT } from '@modkit/sdk/language'

it('keeps the full local outline when the host intentionally omits dependencies', async () => {
  const document = {
    uri: 'file:///outline.galaxy', languageId: 'galaxy', version: 1,
    text: 'int Counter; void Init() { Counter = 1; }',
  }
  const lease = createProvider({ contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT, major: 1 })
  // the outline, formatting and the final-newline action read only the live file (6dd26394)
  expect(lease.value.documentLocalFeatures).toEqual(['documentSymbols', 'formatting', 'codeActions'])
  const result = await lease.value.documentSymbols({
    document, workspaceDocuments: [document], workspaceIncomplete: true,
    maxResults: 64, maxDocuments: 8,
  })
  expect(result.symbols.map(item => item.name)).toEqual(['Counter', 'Init'])
  expect(result.isIncomplete).toBe(false)
})

it('builds catalog links only for a feature that needs them, once per request', async () => {
  const document = {
    uri: 'file:///lazy.galaxy', languageId: 'galaxy', version: 1,
    text: 'void Init() { UnitCreate(1, "Marine", 0, 1, null, 0.0); }',
  }
  const data = {
    uri: 'file:///UnitData.xml', languageId: 'sc2-data', version: 1,
    text: '<Catalog><CUnit id="Marine"/></Catalog>',
  }
  const request = {
    document, workspaceDocuments: [document, data], workspaceIncomplete: false,
    maxResults: 64, maxDocuments: 8,
  }
  const build = vi.spyOn(links, 'createSc2WorkspaceLinkIndex')
  try {
    expect((await galaxyDocumentSymbols(request)).symbols.map(item => item.name)).toContain('Init')
    expect(build).not.toHaveBeenCalled()
    const hover = await galaxyHover({
      ...request, position: { line: 0, character: document.text.indexOf('Marine') + 2 },
    })
    expect(hover?.markdown).toContain('Unit/Marine')
    expect(build).toHaveBeenCalledTimes(1)
  } finally {
    build.mockRestore()
  }
})

it('does not assemble the catalog graph when the caret names a Galaxy function', async () => {
  const document = {
    uri: 'file:///native.galaxy', languageId: 'galaxy', version: 1,
    text: 'void Init() { UnitCreate(1, "Marine", 0, 1, null, 0.0); }',
  }
  const request = {
    document, workspaceDocuments: [document], workspaceIncomplete: false,
    position: { line: 0, character: document.text.indexOf('UnitCreate') + 3 },
    maxResults: 64, maxDocuments: 8,
  }
  const build = vi.spyOn(links, 'createSc2WorkspaceLinkIndex')
  try {
    expect((await galaxyHover(request))?.markdown).toContain('UnitCreate')
    const lease = createProvider({ contract: LANGUAGE_DOCUMENT_ANALYSIS_CONTRACT, major: 1 })
    expect(await lease.value.referenceIndexApplies(request)).toBe(false)
    expect(await lease.value.referenceIndexApplies({
      ...request, position: { line: 0, character: document.text.indexOf('Marine') + 2 },
    })).toBe(true)
    await galaxyDefinition(request)
    await galaxyReferences({ ...request, includeDeclaration: true })
    await galaxyCompletion(request)
    expect(build).not.toHaveBeenCalled()
  } finally {
    build.mockRestore()
  }
})

it.each(['', 'Mar', 'Marine'])('still completes the catalog literal %j', async literal => {
  const document = {
    uri: 'file:///literal.galaxy', languageId: 'galaxy', version: 1,
    text: `void Init() { UnitCreate(1, "${literal}", 0, 1, null, 0.0); }`,
  }
  const data = {
    uri: 'file:///UnitData.xml', languageId: 'sc2-data', version: 1,
    text: '<Catalog><CUnit id="Marine"/></Catalog>',
  }
  const result = await galaxyCompletion({
    document, workspaceDocuments: [document, data], workspaceIncomplete: false,
    position: { line: 0, character: document.text.indexOf('"') + 1 + literal.length },
    maxResults: 64, maxDocuments: 8,
  })
  expect(result.items.map(item => item.label)).toEqual(['Marine'])
})
