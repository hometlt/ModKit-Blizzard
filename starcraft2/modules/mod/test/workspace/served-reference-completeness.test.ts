/** Served Data references must retain partial-index evidence and the final result ceiling. */
import { describe, expect, it } from 'vitest'
import { servedDataReferences } from '../../shared/workspace/language-answer.js'

const primary = Object.freeze({ layerId: 'mine', path: 'UnitData.xml', languageId: 'sc2-data',
  text: '<Catalog><CUnit id="Marine"/><CUnit id="Medic" parent="Marine"/></Catalog>', linkUri: 'fixture:mine' })

/** The same owner occurrences with a controllable completeness flag. */
function links(isIncomplete: boolean) {
  return { declarations: [{ uri: primary.linkUri, start: primary.text.indexOf('Marine'), end: primary.text.indexOf('Marine') + 6,
    namespace: 'Unit', entityId: 'Marine' }], references: [], isIncomplete, referencesTo: () => [] }
}

describe('served Data reference completeness', () => {
  it('keeps an incomplete index incomplete even when the catalog part has no cross-language hits', () => {
    const result = servedDataReferences({ documents: [primary], primary, offset: primary.text.indexOf('Marine') + 1,
      includeDeclaration: true, maxResults: 64, incomplete: false, links: links(true) })
    expect(result?.locations).toHaveLength(2)
    expect(result?.isIncomplete).toBe(true)
  })

  it('applies the result ceiling after merging index and catalog answers', () => {
    const result = servedDataReferences({ documents: [primary], primary, offset: primary.text.indexOf('Marine') + 1,
      includeDeclaration: true, maxResults: 1, incomplete: false, links: links(false) })
    expect(result?.locations).toHaveLength(1)
    expect(result?.isIncomplete).toBe(true)
  })
})
