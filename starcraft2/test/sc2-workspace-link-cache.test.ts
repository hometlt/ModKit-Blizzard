/**
 * The mixed-language link index keeps each frozen document's links between requests (a host that
 * retains call values hands the worker the same frozen document until its text changes). The kept
 * links must never leak one request's edits into another, and a mutable document is never kept.
 */
import { describe, expect, it } from 'vitest'
import { createSc2WorkspaceLinkIndex } from '../modules/galaxy/language/sc2-workspace-links.js'

const data = Object.freeze({
  uri: 'file:///Base.SC2Data/GameData/UnitData.xml',
  languageId: 'sc2-data',
  version: 1,
  text: '<Catalog><CUnit id="Marine"/><CUnit id="Medic" parent="Marine"/></Catalog>',
})
const galaxy = Object.freeze({
  uri: 'file:///MapScript.galaxy',
  languageId: 'galaxy',
  version: 1,
  text: 'void Init() { point p; UnitCreate(1, "Marine", 0, 1, p, 0.0); }',
})

const request = (documents: readonly { uri: string }[]) => ({
  document: documents[0],
  workspaceDocuments: documents,
  maxDocuments: 64,
  maxResults: 64,
  workspaceIncomplete: false,
})

describe('SC2 workspace link cache', () => {
  it('does not diagnose a missing declaration outside a bounded index, but keeps proven ambiguity', () => {
    const caller = Object.freeze({ ...galaxy, text: 'void Init() { UnitCreate(1, "Late", 0, 1, Point(0,0), 0.0); UnitCreate(1, "Duplicate", 0, 1, Point(0,0), 0.0); }' })
    const duplicates = Object.freeze({ ...data, text: '<Catalog><CUnit id="Duplicate"/><CUnit id="Duplicate"/></Catalog>' })
    const filler = Object.freeze({ ...data, uri: 'file:///Filler.xml', text: `<Catalog>${Array.from({ length: 50_001 }, (_, index) => `<CUnit id="Filler${index}"/>`).join('')}</Catalog>` })
    const late = Object.freeze({ ...data, uri: 'file:///Late.xml', text: '<Catalog><CUnit id="Late"/></Catalog>' })
    const index = createSc2WorkspaceLinkIndex(request([caller, duplicates, filler, late]))
    expect(index.isIncomplete).toBe(true)
    expect(index.diagnosticsFor(caller.uri).map(item => item.code)).toEqual(['sc2-cross-language/ambiguous-catalog-literal'])
    expect(index.renameAt(caller.uri, caller.text.indexOf('Late') + 1, 'Renamed', 64)).toBeUndefined()
  })

  it('still diagnoses a proven missing declaration when the index is complete', () => {
    const caller = Object.freeze({ ...galaxy, text: 'void Init() { UnitCreate(1, "Missing", 0, 1, Point(0,0), 0.0); }' })
    const index = createSc2WorkspaceLinkIndex(request([caller, data]))
    expect(index.isIncomplete).toBe(false)
    expect(index.diagnosticsFor(caller.uri).map(item => item.code)).toEqual(['sc2-cross-language/unresolved-catalog-literal'])
  })

  it('serves the same links to later requests without sharing one request’s items', () => {
    const first = createSc2WorkspaceLinkIndex(request([galaxy, data]))
    const marine = first.references.find(item => item.uri === galaxy.uri && item.entityId === 'Marine')
    expect(marine).toBeDefined()
    const expectedStart = galaxy.text.indexOf('"Marine"') + 1
    expect(marine?.start).toBe(expectedStart)
    // An index is free to decorate its own items; the next request must not see it.
    ;(marine as { start: number }).start = -1
    const second = createSc2WorkspaceLinkIndex(request([galaxy, data]))
    const again = second.references.find(item => item.uri === galaxy.uri && item.entityId === 'Marine')
    expect(again?.start).toBe(expectedStart)
    expect(again).not.toBe(marine)
    expect(second.declarations.map(item => item.entityId).sort()).toEqual(['Marine', 'Medic'])
    expect(second.targetAt(galaxy.uri, expectedStart)).toEqual({ namespace: 'Unit', entityId: 'Marine' })
  })

  it('reads a mutable document again on every request', () => {
    const editable = {
      uri: 'file:///Base.SC2Data/GameData/Editable.xml',
      languageId: 'sc2-data',
      version: 1,
      text: '<Catalog><CUnit id="Zealot"/></Catalog>',
    }
    const before = createSc2WorkspaceLinkIndex(request([editable]))
    expect(before.declarations.map(item => item.entityId)).toEqual(['Zealot'])
    editable.text = '<Catalog><CUnit id="Stalker"/></Catalog>'
    editable.version = 2
    const after = createSc2WorkspaceLinkIndex(request([editable]))
    expect(after.declarations.map(item => item.entityId)).toEqual(['Stalker'])
  })

  it('keeps Data usages per document and points them into the requesting snapshot', () => {
    const first = createSc2WorkspaceLinkIndex(request([data]))
    const second = createSc2WorkspaceLinkIndex(request([data]))
    const medicParent = data.text.indexOf('parent="Marine"') + 'parent="'.length
    for (const index of [first, second]) {
      expect(index.targetAt(data.uri, medicParent)).toEqual({ namespace: 'Unit', entityId: 'Marine' })
    }
  })
})
