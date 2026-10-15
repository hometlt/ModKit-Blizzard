import { describe, expect, it } from 'vitest'
import { servedLanguageFeature } from '../../../../shared/language/served-feature.js'

describe('served feature identity projection', () => {
  it('restores only explicit identities, preserves literal marker strings, and accepts frozen replies', async () => {
    const literal = 'modkit-result-document://7'
    const change = Object.freeze({ uri: 'modkit-served-links://layer/UnitData.xml', documentVersion: 0,
      edits: Object.freeze([Object.freeze({ newText: literal })]) })
    const value = Object.freeze({ documentChanges: Object.freeze([change]), isComplete: true })
    const answer = Object.freeze({ revision: '4', hasValue: true, value,
      documents: Object.freeze([{ uri: 'file:///mod/UnitData.xml', documentVersion: 17 }]),
      identities: Object.freeze([{ path: ['documentChanges', 0, 'uri'], document: 0 }]) })
    const request = { document: { uri: 'file:///mod/UnitData.xml', languageId: 'sc2-data', version: 17, text: '' },
      workspaceDocuments: [], maxDocuments: 16, maxResults: 100, workspaceIncomplete: false,
      workspaceContext: { id: 'test', revision: '4', semanticComplete: true, documentOrigins: [],
        modContext: { scope: 'mod', revision: '4', document: { layerId: 'layer', path: 'UnitData.xml' } } } }
    const port = { query: async () => answer }
    const result = await servedLanguageFeature(request as never, port, 'rename')
    expect(result?.documentChanges[0]?.uri).toBe('file:///mod/UnitData.xml')
    expect(result?.documentChanges[0]?.documentVersion).toBe(17)
    expect(result?.documentChanges[0]?.edits[0]?.newText).toBe(literal)
    expect(change.uri).toBe('modkit-served-links://layer/UnitData.xml')
    await expect(servedLanguageFeature(request as never, { query: async () => ({ ...answer, revision: '5' }) }, 'rename'))
      .rejects.toThrow(/another revision/u)
    await expect(servedLanguageFeature(request as never, { query: async () => ({ ...answer, documents: [] }) }, 'rename'))
      .rejects.toThrow(/Host URI/u)
  })
})
