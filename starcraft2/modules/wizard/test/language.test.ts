import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createSc2WizardLanguageProvider,
  isSc2WizardDocument,
  SC2_WIZARD_LANGUAGE_ID,
} from '../providers/language/src/language.js'

const provider = createSc2WizardLanguageProvider()

const WIZARD = [
  '<wizardfile>',
  '  <wizard id="Main">',
  '    <name>Main wizard</name>',
  '    <input id="Child" type="Wizard:Child"/>',
  '    <input id="Value" type="WizardText">',
  '      <default value="^Macro^"/>',
  '    </input>',
  '    <macro id="Macro">42</macro>',
  '    <condition input="Value"/>',
  '    <validate type="warning"><text>Check ^Value^</text></validate>',
  '  </wizard>',
  '  <wizard id="Child">',
  '    <name>Child wizard</name>',
  '    <input id="Nested" type="WizardText"/>',
  '  </wizard>',
  '</wizardfile>',
  '',
].join('\n')

function request(text: string, extra: Record<string, unknown> = {}) {
  return {
    document: { uri: 'memory://wizard.BlizWiz', languageId: SC2_WIZARD_LANGUAGE_ID, version: 1, text },
    workspaceDocuments: [],
    workspaceIncomplete: false,
    maxResults: 100,
    maxDocuments: 10,
    ...extra,
  } as never
}

function at(text: string, needle: string, inside = needle.length) {
  const offset = text.indexOf(needle) + inside
  const before = text.slice(0, offset)
  return {
    line: before.split('\n').length - 1,
    character: offset - (before.lastIndexOf('\n') + 1),
  }
}

describe('sc2-wizard MK3 language provider', () => {
  it('advertises the canonical language identity and detects compatibility roots', () => {
    expect(provider.contract).toBe('common.language/document-analysis')
    expect(provider.languageIds).toEqual(['sc2-wizard'])
    expect(isSc2WizardDocument('<Wizard id="Legacy"><name>x</name></Wizard>')).toBe(true)
  })

  it('reuses the codec analyzer for diagnostics and returns tokens', async () => {
    const analysis = await provider.analyze({ document: request(WIZARD).document })
    expect(analysis.documentUri).toBe('memory://wizard.BlizWiz')
    expect(analysis.tokens.length).toBeGreaterThan(10)
    expect(analysis.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('publishes wizard, input, macro and entry symbols', async () => {
    const result = await provider.documentSymbols!(request(WIZARD))
    expect(result.symbols.map(item => item.name)).toEqual(['Main', 'Child'])
    expect(result.symbols[0]?.children?.map(item => item.name)).toEqual(['Child', 'Value', 'Macro'])
  })

  it('projects analyzer-owned wizard identities into typed occurrences', async () => {
    const base = request(WIZARD)
    const workspaceContext = {
      id: 'sc2-workspace:wizard',
      revision: 'sc2-workspace:wizard-r1',
      semanticComplete: true,
      documentOrigins: [{
        uri: base.document.uri,
        layerId: 'fixture:0',
        logicalId: 'wizard.BlizWiz',
        precedence: 0,
        sourceRevision: 'fixture:1',
        readOnly: false,
      }],
      semanticInputs: [],
    }
    const batches = await provider.referenceOccurrences!(request(WIZARD, { workspaceContext }))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      contextId: workspaceContext.id,
      contextRevision: workspaceContext.revision,
      semanticComplete: true,
    })
    expect(batches[0]?.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ owner: 'blizzard/sc2-wizard', kind: 'wizard-macro', id: 'Main/Macro' }),
        role: 'declaration',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ owner: 'blizzard/sc2-wizard', kind: 'wizard-macro', id: 'Main/Macro' }),
        role: 'reference',
      }),
    ]))
  })

  it('types literal catalog and StringId targets for the workspace graph', async () => {
    const linked = WIZARD
      .replace('<macro id="Macro">42</macro>', '<macro id="Macro">ref=Unit,Marine,ScoreKill REF=Unit,Ghost,LifeMax ref=Unit,Broken</macro>')
      .replace('  </wizard>', '    <entry catalog="Unit" type="CUnit"><field id="Name"><stringid>Unit/Name/Marine&amp;Alt</stringid></field></entry>\n  </wizard>')
    const base = request(linked)
    const workspaceContext = {
      id: 'sc2-workspace:wizard-links',
      revision: 'sc2-workspace:wizard-links-r1',
      semanticComplete: true,
      documentOrigins: [{
        uri: base.document.uri,
        layerId: 'fixture:0',
        logicalId: 'wizard.BlizWiz',
        precedence: 0,
        sourceRevision: 'fixture:1',
        readOnly: false,
      }],
      semanticInputs: [],
    }
    const [batch] = await provider.referenceOccurrences!(request(linked, { workspaceContext }))
    expect(batch?.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ owner: 'blizzard/sc2-data', kind: 'catalog-entity', namespace: 'Unit', id: 'Marine' }),
        semanticPath: ['Unit', 'Marine', 'ScoreKill'],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ owner: 'blizzard/sc2-strings', kind: 'string-key', id: 'Unit/Name/Marine&Alt' }),
        semanticPath: ['Unit/Name/Marine&Alt'],
      }),
    ]))
    expect(batch?.occurrences).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ id: 'Ghost' }) }),
      expect.objectContaining({ target: expect.objectContaining({ id: 'Broken' }) }),
    ]))
    const stringOccurrence = batch?.occurrences.find(
      occurrence => occurrence.target.owner === 'blizzard/sc2-strings',
    )
    expect(
      linked.slice(
        stringOccurrence?.source.span.utf16Offset,
        (stringOccurrence?.source.span.utf16Offset ?? 0) +
          (stringOccurrence?.source.span.utf16Length ?? 0),
      ),
    ).toBe('Unit/Name/Marine&amp;Alt')
  })

  it('completes control types, validation values and wizard tokens', async () => {
    const typeText = WIZARD.replace('type="WizardText"', 'type="')
    const typeResult = await provider.completion!(request(typeText, { position: at(typeText, 'type="') }))
    expect(typeResult.items.map(item => item.label)).toContain('WizardCheckbox')

    const validateText = WIZARD.replace('type="warning"', 'type="')
    const validateResult = await provider.completion!(request(validateText, { position: at(validateText, '<validate type="') }))
    expect(validateResult.items.map(item => item.label)).toEqual(['error', 'confirm', 'warning'])

    const tokenText = WIZARD.replace('^Macro^', '^')
    const tokenResult = await provider.completion!(request(tokenText, { position: at(tokenText, 'value="^') }))
    expect(tokenResult.items.map(item => item.label)).toContain('Macro')
  })

  it('completes SC2 catalogs, entry types and schema field paths', async () => {
    const catalogText = '<wizardfile><wizard id="x"><name>x</name><entry catalog="" type=""/></wizard></wizardfile>'
    const catalogs = await provider.completion!(request(catalogText, { position: at(catalogText, 'catalog="') }))
    expect(catalogs.items.map(item => item.label)).toContain('Unit')

    const typeText = catalogText.replace('catalog=""', 'catalog="Unit"').replace('type=""', 'type="')
    const types = await provider.completion!(request(typeText, { position: at(typeText, 'type="') }))
    expect(types.items.map(item => item.label)).toContain('CUnit')

    const fieldText = '<wizardfile><wizard id="x"><name>x</name><entry catalog="Unit" type="CUnit"><field id=""/></entry></wizard></wizardfile>'
    const fields = await provider.completion!(request(fieldText, { position: at(fieldText, 'field id="') }))
    expect(fields.items.map(item => item.label)).toContain('Acceleration')
  })

  it('resolves embedded wizard definitions and renames local references', async () => {
    const position = at(WIZARD, 'Wizard:Child', 'Wizard:'.length + 2)
    const definitions = await provider.definition!(request(WIZARD, { position }))
    expect(definitions.locations).toHaveLength(1)
    expect(definitions.locations[0]?.range.start.character).toBeGreaterThan(0)

    const rename = await provider.rename!(request(WIZARD, {
      position: at(WIZARD, '^Value^', 2),
      newName: 'Amount',
      maxEdits: 20,
    }))
    expect(rename?.documentChanges[0]?.edits.length).toBe(3)
    expect(rename?.documentChanges[0]?.edits.every(edit => edit.newText === 'Amount')).toBe(true)

    const macroRefs = await provider.references!(request(WIZARD, {
      position: at(WIZARD, '^Macro^', 2),
      includeDeclaration: true,
    }))
    expect(macroRefs.locations).toHaveLength(2)
  })

  it('resolves qualified token references through a bounded workspace snapshot', async () => {
    const primary = '<wizardfile><wizard id="Main"><name>Main</name><input id="Value" type="WizardText"><default value="^Shared:Nested^"/></input></wizard></wizardfile>'
    const dependency = '<wizardfile><wizard id="Shared"><name>Shared</name><input id="Nested" type="WizardText"/></wizard></wizardfile>'
    const workspace = [{ uri: 'memory://shared.BlizWiz', languageId: SC2_WIZARD_LANGUAGE_ID, version: 1, text: dependency }]
    const options = { workspaceDocuments: workspace, workspaceIncomplete: false }
    const definitions = await provider.definition!(request(primary, { ...options, position: at(primary, 'Shared:Nested', 4) }))
    expect(definitions.locations).toHaveLength(1)
    expect(definitions.locations[0]?.uri).toBe('memory://shared.BlizWiz')
    const rename = await provider.rename!(request(primary, { ...options, position: at(primary, 'Shared:Nested', 4), newName: 'SharedValue', maxEdits: 10 }))
    expect(rename?.documentChanges).toHaveLength(2)
  })

  describe('rename keeps the document valid', () => {
    /** Apply edits to a single-line document, where character offsets are source offsets. */
    async function renamed(text: string, needle: string, inside: number, newName: string) {
      const result = await provider.rename!(request(text, { position: at(text, needle, inside), newName, maxEdits: 50 }))
      const edits = [...(result?.documentChanges[0]?.edits ?? [])].sort((a, b) => b.range.start.character - a.range.start.character)
      return edits.reduce((out, edit) => out.slice(0, edit.range.start.character) + edit.newText + out.slice(edit.range.end.character), text)
    }
    const nested = '<wizardfile><wizard id="W"><name>W</name><input id="Child" type="Wizard:C"/><condition input="Child:Nested"/><macro id="M">^Child:Nested^</macro></wizard><wizard id="C"><name>C</name><input id="Nested" type="WizardText"/></wizard></wizardfile>'

    it('places edits by source offset when entities precede a token', async () => {
      const text = '<wizardfile><wizard id="W"><name>W</name><input id="Value" type="WizardText"/><macro id="M">a &amp; ^Value^</macro><default value="&lt;^Value^"/></wizard></wizardfile>'
      expect(await renamed(text, 'id="Value"', 5, 'Amount')).toBe(text.replaceAll('Value', 'Amount'))
    })

    it('renames the owner segment of a qualified name through its Wizard: input', async () => {
      expect(await renamed(nested, 'id="Child"', 5, 'Sub')).toBe(nested.replaceAll('Child', 'Sub'))
    })

    it('renames the owner segment of a qualified name through the wizard id', async () => {
      const text = nested.replaceAll('Child:Nested', 'C:Nested')
      expect(await renamed(text, 'id="C"', 5, 'D')).toBe(text.replace('Wizard:C', 'Wizard:D').replace('id="C"', 'id="D"').replaceAll('C:Nested', 'D:Nested'))
    })

    it('renames the nested segment in tokens and condition inputs', async () => {
      expect(await renamed(nested, 'id="Nested"', 5, 'Inner')).toBe(nested.replaceAll('Nested', 'Inner'))
    })

    it('refuses to rename an owner segment that names both a wizard and a Wizard: input', async () => {
      const text = '<wizardfile><wizard id="W"><name>W</name><input id="C" type="Wizard:D"/><macro id="M">^C:Nested^</macro></wizard><wizard id="C"><name>C</name><input id="Nested" type="WizardText"/></wizard><wizard id="D"><name>D</name><input id="Nested" type="WizardText"/></wizard></wizardfile>'
      for (const [needle, inside] of [['input id="C"', 'input id="'.length], ['wizard id="C"', 'wizard id="'.length], ['^C:Nested^', 1], ['^C:Nested^', 4]] as const) {
        expect(await provider.rename!(request(text, { position: at(text, needle, inside), newName: 'X', maxEdits: 50 }))).toBeUndefined()
      }
      const references = await provider.references!(request(text, { position: at(text, 'input id="C"', 'input id="'.length), includeDeclaration: false }))
      expect(references.locations).toHaveLength(1)
    })

    it('refuses a new name that would read as a qualified reference', async () => {
      expect(await provider.rename!(request(nested, { position: at(nested, 'id="Nested"', 5), newName: 'A:B', maxEdits: 50 }))).toBeUndefined()
    })
  })

  describe('workspace snapshot', () => {
    const primary = '<wizardfile><wizard id="Main"><name>Main</name><input id="Sub" type="Wizard:Shared"/><macro id="M">^Shared:Nested^</macro></wizard></wizardfile>'
    const shared = '<wizardfile><wizard id="Shared"><name>Shared</name><input id="Nested" type="WizardText"/></wizard></wizardfile>'
    const doc = (uri: string, text: string) => ({ uri, languageId: SC2_WIZARD_LANGUAGE_ID, version: 1, text })
    const codes = async (text: string, workspace: ReturnType<typeof doc>[]) =>
      (await provider.diagnostics!(request(text, { workspaceDocuments: workspace }))).diagnostics.map(item => item.code)

    it('resolves embedded wizards declared in another supplied document', async () => {
      expect(await codes(primary, [])).toEqual(['sc2-wizard-embedded-wizard-missing', 'sc2-wizard-embedded-token-unresolved'])
      expect(await codes(primary, [doc('memory://shared.BlizWiz', shared)])).toEqual([])
    })

    it('reports a wizard id that another document declares too, and refuses to rename it', async () => {
      const copy = doc('memory://copy.BlizWiz', shared)
      const both = [doc('memory://shared.BlizWiz', shared), copy]
      const diagnostics = (await provider.diagnostics!(request(shared, { document: copy, workspaceDocuments: both }))).diagnostics
      expect(diagnostics.map(item => [item.code, item.severity, item.message.includes('memory://shared.BlizWiz')])).toEqual([
        ['sc2-wizard-duplicate-wizard-elsewhere', 'warning', true],
      ])
      expect(await provider.rename!(request(primary, { workspaceDocuments: both, position: at(primary, 'Wizard:Shared', 8), newName: 'Other', maxEdits: 10 }))).toBeUndefined()
    })

    it('marks navigation incomplete when the host says the snapshot is', async () => {
      const result = await provider.definition!(request(primary, { workspaceIncomplete: true, position: at(primary, 'id="Sub"', 5) }))
      expect(result).toMatchObject({ locations: [{ uri: 'memory://wizard.BlizWiz' }], isIncomplete: true })
    })
  })

  it('supports final-newline formatting and manifest registration', async () => {
    const noNewline = WIZARD.trimEnd()
    const formatted = await provider.formatting!(request(noNewline, { options: { tabSize: 2, insertSpaces: true, finalNewline: true } }))
    expect(formatted.edits).toHaveLength(1)
    const manifest = JSON.parse(await readFile(new URL('../providers/language/provider.json', import.meta.url), 'utf8'))
    expect(manifest.id).toBe('blizzard/sc2-wizard-language')
    expect(manifest.spec.provides[0].facet.extensions).toEqual(['blizwiz'])
    expect(manifest.spec.provides[0].facet.completionTriggerCharacters).toEqual(
      expect.arrayContaining(['<', ' ', '"', "'", '^', ':']),
    )
  })
})
