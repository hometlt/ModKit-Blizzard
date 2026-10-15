import { expect, it } from 'vitest'
import type { LanguageWorkspaceSemanticInput } from '@modkit/sdk/language'
import { createSc2DataLanguageProvider } from '../providers/language/src/language.js'

const provider = createSc2DataLanguageProvider()
const path = 'Base.SC2Assets/Assets/Textures/btn-marine.dds'
const text = '<Catalog><CButton id="Go"><Icon value="Assets\\Textures\\btn-marine.dds"/></CButton></Catalog>'
const closure = (id: string, sourcePath: string): LanguageWorkspaceSemanticInput => ({
  kind: 'dependency-closure', id, revision: '1', payload: { schemaVersion: 1,
    layers: [{ layerId: `${id}:0`, sourceId: 'local:casc', sourcePath }] },
})
const index = (id: string, paths: string[], layers?: number[]): LanguageWorkspaceSemanticInput => ({
  kind: 'content-path-index', id, revision: '1',
  payload: { schemaVersion: 1, isComplete: true, paths, ...(layers === undefined ? {} : { layers }) },
})
it('offers the native game-relative asset path from a Base.SC2Assets listing', async () => {
  const result = await provider.completion!({
    document: { uri: 'memory://ButtonData.xml', languageId: 'sc2-data', version: 1, text },
    workspaceDocuments: [], maxResults: 100, maxDocuments: 10,
    position: { line: 0, character: text.indexOf('btn-marine') }, workspaceIncomplete: false,
    workspaceContext: { id: 'context', revision: '1', semanticComplete: true, documentOrigins: [],
      semanticInputs: [index('sc2:context', [path], [0])] },
  })
  expect(result.items.some(item => 'label' in item && item.label === 'Assets\\Textures\\btn-marine.dds')).toBe(true)
})
function definition(semanticInputs: LanguageWorkspaceSemanticInput[]) {
  return provider.definition!({
    document: { uri: 'memory://ButtonData.xml', languageId: 'sc2-data', version: 1, text },
    workspaceDocuments: [], maxResults: 100, maxDocuments: 10,
    position: { line: 0, character: text.indexOf('btn-marine') + 2 },
    workspaceContext: { id: 'context', revision: '1', semanticComplete: true, documentOrigins: [], semanticInputs },
  })
}

it('finds an asset in a later index part after a local index without owners', async () => {
  const result = await definition([
    index('local', ['Assets/Other.dds']),
    closure('sc2:context', 'Mods/Liberty.SC2Mod'),
    index('sc2:context', ['Base.SC2Assets/Assets/Other.dds'], [0]),
    index('sc2:context/paths/16384', [path], [0]),
  ])
  expect(result.locations[0]?.uri).toBe(`content-source://local%3Acasc/Mods/Liberty.SC2Mod/${path}`)
})

it('uses the matching dependency closure for a later index part', async () => {
  const result = await definition([
    closure('sc2:first', 'Mods/Core.SC2Mod'), index('sc2:first', ['Assets/Other.dds'], [0]),
    closure('sc2:second', 'Mods/Liberty.SC2Mod'),
    index('sc2:second/paths/16384', [path], [0]),
  ])
  expect(result.locations[0]?.uri).toBe(`content-source://local%3Acasc/Mods/Liberty.SC2Mod/${path}`)
})
