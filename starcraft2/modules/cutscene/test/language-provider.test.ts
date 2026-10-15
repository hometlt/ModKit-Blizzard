import { describe, expect, it } from 'vitest'

import { createCutsceneLanguageProvider } from '../providers/language/src/language.js'

const SCENE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<CutsceneState cutsceneVersion="1.300000">',
  '  <CCutsceneNodeActor guid="100" name="Marine" modelLink="Marine" teamColorDiffuse="1.000000,0.000000,0.000000,1.000000">',
  '    <CCutsceneElementObject guid="101" start="0" duration="1000" startLinkGuid="100"/>',
  '    <CCutsceneNodeAnimLayer guid="102" name="Animation Layer">',
  '      <CCutsceneElementAnim guid="103" start="0" duration="1000" anim="MarineStand"/>',
  '    </CCutsceneNodeAnimLayer>',
  '    <CCutsceneNodePropertyValue guid="104" propertyName="positionX">',
  '      <CCutsceneElementPropertyCurve guid="105" time="0" value="0.000000" curveInType="3" curveOutType="3"/>',
  '    </CCutsceneNodePropertyValue>',
  '  </CCutsceneNodeActor>',
  '  <CCutsceneNodeFolder guid="200" name="Includes" referenceFile="Other.SC2Cutscene" referenceGuid="300"/>',
  '</CutsceneState>',
].join('\n') + '\n'

const OTHER_SCENE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<CutsceneState cutsceneVersion="1.300000">',
  '  <CCutsceneNodeCamera guid="300" name="Other Camera"/>',
  '</CutsceneState>',
].join('\n') + '\n'

const main = {
  uri: 'file:///Cutscenes/Main.SC2Cutscene',
  languageId: 'sc2-cutscene',
  version: 7,
  text: SCENE,
} as const

const other = {
  uri: 'file:///Cutscenes/Other.SC2Cutscene',
  languageId: 'sc2-cutscene',
  version: 3,
  text: OTHER_SCENE,
} as const

function positionOf(text: string, needle: string, offsetInNeedle = 0) {
  const offset = text.indexOf(needle) + offsetInNeedle
  if (offsetInNeedle < 0 || text.indexOf(needle) < 0) throw new Error(`Missing fixture text: ${needle}`)
  const before = text.slice(0, offset)
  return { line: before.split('\n').length - 1, character: offset - (before.lastIndexOf('\n') + 1) }
}

function request(position: { line: number; character: number }, document = main) {
  return {
    document,
    position,
    workspaceDocuments: [main, other],
    workspaceIncomplete: false,
    maxResults: 100,
    maxDocuments: 8,
  }
}

describe('SC2 cutscene language provider', () => {
  it('advertises the shared language contract and produces all analysis products', async () => {
    const provider = createCutsceneLanguageProvider()
    expect(provider.contract).toBe('common.language/document-analysis')
    expect(provider.languageIds).toEqual(['sc2-cutscene', 'storm-cutscene'])

    const analysis = await provider.analyze({ document: main })
    expect(analysis.documentUri).toBe(main.uri)
    expect(analysis.tokens.some(token => token.kind === 'keyword')).toBe(true)
    expect(analysis.symbols[0]?.name).toBe('CutsceneState')
    expect(analysis.symbols[0]?.children?.some(symbol => symbol.name === 'Marine')).toBe(true)
    expect(analysis.diagnostics.some(item => item.code?.endsWith('/external-cutscene'))).toBe(true)
  })

  it('keeps the Storm language identity on the same analysis implementation', async () => {
    const provider = createCutsceneLanguageProvider()
    const analysis = await provider.analyze({ document: { ...main, languageId: 'storm-cutscene' } })
    expect(analysis.documentUri).toBe(main.uri)
    expect(analysis.symbols[0]?.name).toBe('CutsceneState')
    expect(analysis.tokens.some(token => token.kind === 'keyword')).toBe(true)
  })

  it('reports malformed XML and unknown tags without losing the editor-friendly boundary', async () => {
    const provider = createCutsceneLanguageProvider()
    const malformed = { ...main, text: '<CutsceneState><CCutsceneNodeActor' }
    const malformedDiagnostics = await provider.diagnostics!({
      document: malformed,
      workspaceDocuments: [malformed],
      workspaceIncomplete: false,
      maxResults: 20,
      maxDocuments: 2,
    })
    expect(malformedDiagnostics.diagnostics[0]?.severity).toBe('error')
    expect(malformedDiagnostics.diagnostics[0]?.code).toContain('/parse')

    const unknown = { ...main, text: SCENE.replace('</CutsceneState>', '  <CCutsceneNodeFuture guid="999"/>\n</CutsceneState>') }
    const unknownDiagnostics = await provider.diagnostics!({
      document: unknown,
      workspaceDocuments: [unknown],
      workspaceIncomplete: false,
      maxResults: 20,
      maxDocuments: 2,
    })
    expect(unknownDiagnostics.diagnostics.some(item => item.severity === 'information' && item.code?.endsWith('/unknown-tag'))).toBe(true)
  })

  it('completes tags, attributes, GUIDs and known workspace values', async () => {
    const provider = createCutsceneLanguageProvider()
    const tagText = `${SCENE}<`
    const tagDocument = { ...main, text: tagText }
    const tagCompletion = await provider.completion!({ ...request(positionOf(tagText, '<', tagText.lastIndexOf('<') + 1), tagDocument) })
    expect(tagCompletion.items.map(item => item.label)).toContain('CutsceneState')

    const attributePosition = positionOf(SCENE, '<CCutsceneNodeActor ', '<CCutsceneNodeActor '.length)
    const attributeCompletion = await provider.completion!(request(attributePosition))
    expect(attributeCompletion.items.map(item => item.label)).toContain('propertyName')
    expect(attributeCompletion.items.map(item => item.label)).toContain('actorAlias')

    const guidText = SCENE.replace('startLinkGuid="100"', 'startLinkGuid=""')
    const guidDocument = { ...main, text: guidText }
    const guidPosition = positionOf(guidText, 'startLinkGuid=""', 'startLinkGuid="'.length)
    const guidCompletion = await provider.completion!(request(guidPosition, guidDocument))
    expect(guidCompletion.items.map(item => item.label)).toContain('100')

    const propertyPosition = positionOf(SCENE, 'propertyName="positionX"', 'propertyName="'.length)
    const propertyCompletion = await provider.completion!(request(propertyPosition))
    expect(propertyCompletion.items.map(item => item.label)).toContain('positionX')
  })

  it('supports hover, local definition/references and safe complete-workspace rename', async () => {
    const provider = createCutsceneLanguageProvider()
    const referencePosition = positionOf(SCENE, 'startLinkGuid="100"', 'startLinkGuid="'.length)
    const hover = await provider.hover!(request(referencePosition))
    expect(hover?.markdown).toContain('startLinkGuid')

    const definition = await provider.definition!(request(referencePosition))
    expect(definition.locations).toHaveLength(1)
    expect(definition.locations[0]?.range.start.line).toBe(positionOf(SCENE, 'guid="100"').line)

    const references = await provider.references!({
      ...request(referencePosition),
      includeDeclaration: true,
    })
    expect(references.locations).toHaveLength(2)

    const prepared = await provider.prepareRename!(request(referencePosition))
    expect(prepared?.placeholder).toBe('100')

    const renamed = await provider.rename!({
      ...request(referencePosition),
      newName: '900',
      maxEdits: 20,
    })
    expect(renamed?.documentChanges[0]?.documentVersion).toBe(main.version)
    expect(renamed?.documentChanges[0]?.edits).toHaveLength(2)
    // GUIDs are document-scoped, so an incomplete workspace still gets the primary-document edit.
    const partial = await provider.rename!({
      ...request(referencePosition),
      newName: '901',
      maxEdits: 20,
      workspaceIncomplete: true,
    })
    expect(partial?.documentChanges.map(change => change.uri)).toEqual([main.uri])
  })

  it('resolves external cutscene files, colours and final-newline actions', async () => {
    const provider = createCutsceneLanguageProvider()
    const filePosition = positionOf(SCENE, 'referenceFile="Other.SC2Cutscene"', 'referenceFile="'.length)
    const definition = await provider.definition!(request(filePosition))
    expect(definition.locations[0]?.uri).toBe(other.uri)

    const externalGuidPosition = positionOf(SCENE, 'referenceGuid="300"', 'referenceGuid="'.length)
    const externalGuidDefinition = await provider.definition!(request(externalGuidPosition))
    expect(externalGuidDefinition.locations[0]?.uri).toBe(other.uri)
    const externalGuidReferences = await provider.references!({
      ...request(externalGuidPosition),
      includeDeclaration: true,
    })
    expect(externalGuidReferences.locations).toHaveLength(2)

    const colors = await provider.documentColors!(request({ line: 2, character: 80 }))
    expect(colors.colors).toHaveLength(1)
    expect(colors.colors[0]?.color).toMatchObject({ red: 1, green: 0, blue: 0, alpha: 1 })
    const presentations = await provider.colorPresentations!({
      ...request({ line: 2, character: 80 }),
      color: colors.colors[0]!.color,
      range: colors.colors[0]!.range,
    })
    expect(presentations.presentations[0]?.label).toBe('1.000000,0.000000,0.000000,1.000000')

    const noNewline = { ...main, text: SCENE.replace(/\n$/u, '') }
    const formatting = await provider.formatting!({
      ...request({ line: 14, character: 15 }, noNewline),
      options: { tabSize: 2, insertSpaces: true, finalNewline: true },
    })
    expect(formatting.edits).toHaveLength(1)
    expect(formatting.edits[0]?.newText).toBe('\n')

    const actions = await provider.codeActions!({
      ...request({ line: 14, character: 15 }, noNewline),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      diagnostics: [],
      maxEdits: 20,
    })
    expect(actions.actions.some(action => action.title.toLocaleLowerCase().includes('newline'))).toBe(true)
  })

  it('places each diagnostic on the element the validator names', async () => {
    const provider = createCutsceneLanguageProvider()
    const text = [
      '<CutsceneState cutsceneVersion="1.300000">',
      '  <CCutsceneNodeActor guid="10">',
      '    <CCutsceneElementObject guid="11" startLinkGuid="10"/>',
      '    <CCutsceneElementObject guid="12" startLinkGuid="777"/>',
      '    <CCutsceneElementObject guid="12"/>',
      '    <CCutsceneElementRTTChannel guid="13" objectGUID="778"/>',
      '  </CCutsceneNodeActor>',
      '</CutsceneState>',
    ].join('\n')
    const document = { ...main, text: String.fromCharCode(0xfeff) + text }
    const { diagnostics } = await provider.diagnostics!({ ...request({ line: 0, character: 0 }, document), workspaceDocuments: [document] })
    const at = (code: string) => diagnostics.find(item => item.code?.endsWith(`/${code}`))?.range.start
    expect(at('unresolved-reference')).toEqual(positionOf(document.text, 'objectGUID="778"', 'objectGUID="'.length))
    expect(diagnostics.filter(item => item.code?.endsWith('/unresolved-reference')).map(item => item.range.start.line)).toEqual([5, 3])
    expect(at('duplicate-guid')).toEqual(positionOf(document.text, '<CCutsceneElementObject guid="12"/>', '<CCutsceneElementObject guid="'.length))
  })

  it('scopes GUIDs to their document and renames includes with their target', async () => {
    const provider = createCutsceneLanguageProvider()
    const header = '<CutsceneState cutsceneVersion="1.300000">\n'
    const owner = { uri: 'file:///m/A.SC2Cutscene', languageId: 'sc2-cutscene', version: 1, text: `${header}  <CCutsceneNodeCamera guid="300"/>\n</CutsceneState>\n` }
    const includer = { uri: 'file:///m/B.SC2Cutscene', languageId: 'sc2-cutscene', version: 2, text: `${header}  <CCutsceneNodeFolder guid="1" referenceFile="A.SC2Cutscene" referenceGuid="300"/>\n</CutsceneState>\n` }
    const unrelated = { uri: 'file:///m/C.SC2Cutscene', languageId: 'sc2-cutscene', version: 3, text: `${header}  <CCutsceneNodeActor guid="5">\n    <CCutsceneElementObject guid="6" startLinkGuid="300"/>\n  </CCutsceneNodeActor>\n</CutsceneState>\n` }
    const at = positionOf(owner.text, 'guid="300"', 'guid="'.length)
    const base = { document: owner, position: at, workspaceDocuments: [owner, includer, unrelated], workspaceIncomplete: false, maxResults: 100, maxDocuments: 8 }

    const references = await provider.references!({ ...base, includeDeclaration: true })
    expect(references.locations.map(item => item.uri).sort()).toEqual([owner.uri, includer.uri])

    const complete = await provider.rename!({ ...base, newName: '301', maxEdits: 20 })
    expect(complete?.documentChanges.map(change => [change.uri, change.documentVersion, change.edits.length])).toEqual([
      [owner.uri, 1, 1],
      [includer.uri, 2, 1],
    ])

    // Incomplete workspace: a visible include would break, so refuse; without one, edit the primary only.
    expect(await provider.prepareRename!({ ...base, workspaceIncomplete: true })).toBeUndefined()
    expect(await provider.rename!({ ...base, workspaceIncomplete: true, newName: '301', maxEdits: 20 })).toBeUndefined()
    const partial = await provider.rename!({ ...base, workspaceDocuments: [owner, unrelated], workspaceIncomplete: true, newName: '301', maxEdits: 20 })
    expect(partial?.documentChanges.map(change => change.uri)).toEqual([owner.uri])
  })

  it('removes a final newline and keeps the arity of a colour', async () => {
    const provider = createCutsceneLanguageProvider()
    const formatting = await provider.formatting!({
      ...request({ line: 0, character: 0 }),
      options: { tabSize: 2, insertSpaces: true, finalNewline: false },
    })
    expect(formatting.edits).toHaveLength(1)
    expect(formatting.edits[0]?.range.end).not.toEqual(formatting.edits[0]?.range.start)

    const rgb = { ...main, text: SCENE.replace('1.000000,0.000000,0.000000,1.000000', '1,0,0') }
    const colors = await provider.documentColors!(request({ line: 0, character: 0 }, rgb))
    const presentations = await provider.colorPresentations!({
      ...request({ line: 0, character: 0 }, rgb),
      color: colors.colors[0]!.color,
      range: colors.colors[0]!.range,
    })
    expect(presentations.presentations[0]?.label).toBe('1.000000,0.000000,0.000000')
  })
})
