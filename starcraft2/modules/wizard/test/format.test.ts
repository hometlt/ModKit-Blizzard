/**
 * The `.BlizWiz` model: what it reads, what it writes back, what it computes and what it refuses.
 *
 * Two of these tests carry most of the weight. The round trip is the completeness proof — the
 * writer touches only the model, so a byte-identical result says the model kept everything the file
 * had. The specification-surface test is the other half: it walks the documented grammar and fails
 * if an element or attribute Blizzard documents is missing from the fixtures or from the typed
 * model. Together they are the check MK2's wizard parser would have failed on its first real file.
 *
 * The fixtures are spec-derived and say so; `fixtures/sc2-wizard/manifest.json` records what that
 * costs and what would replace it. The manifest is asserted here rather than described in a report,
 * so the gap stays visible to whoever runs the suite next.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyzeWizardDocument,
  evaluateArithmetic,
  evaluateWizardMacro,
  evaluateWizardText,
  listWizardEditPaths,
  locateWizardEditTarget,
  outlineWizardDocument,
  parseWizardDocument,
  writeWizardDocument,
  type WizardCatalogProvider,
  type WizardNode,
} from '../codecs/wizard/src/core/index.js'
import { createStarcraft2WizardSchema } from '../codecs/wizard/src/schema.js'
import { editIsolationFailures } from './edit-isolation.js'

const fixtures = resolve(import.meta.dirname, 'fixtures')
const read = (name: string) => readFileSync(resolve(fixtures, name), 'utf8')
const manifest = JSON.parse(read('manifest.json')) as {
  editorSaved: { file: string; sha256: string; source: string }[]
  specDerived: { file: string; sha256: string; covers: string; source: string }[]
}
const FIXTURE_FILES = ['prototype-wizard.BlizWiz', 'spec-coverage.BlizWiz'] as const

function everyNode(nodes: readonly WizardNode[]): WizardNode[] {
  return nodes.flatMap(node => [node, ...everyNode(node.children)])
}

/** Elements the specification defines, anywhere in the document. */
const SPEC_ELEMENTS = [
  'wizardfile', 'wizard', 'name', 'description', 'category', 'hidden', 'objecttypes',
  'instructions', 'condition', 'input', 'validate', 'macro', 'entry', 'item', 'sorted',
  'simpletext', 'color', 'default', 'minimum', 'maximum', 'increment', 'loadvalue', 'reloadfrom',
  'nosave', 'nopreview', 'layout', 'tooltip', 'text', 'id', 'useloaded', 'allowmodify', 'parentid',
  'count', 'field', 'token', 'value', 'stringid', 'index', 'loadinput', 'cache',
]

/** Attributes the specification defines, anywhere in the document. */
const SPEC_ATTRIBUTES = [
  'id', 'type', 'create', 'load', 'view', 'page', 'input', 'value', 'match', 'operator', 'nocase',
  'empty', 'visible', 'logic', 'text', 'count', 'column', 'minheight', 'minwidth', 'catalog',
  'replaceSrc', 'replaceDst', 'truncate',
]

describe('SC2 data wizard corpus', () => {
  it('pins each fixture and records that no editor-saved wizard exists yet', () => {
    for (const entry of manifest.specDerived) {
      expect(createHash('sha256').update(readFileSync(resolve(fixtures, entry.file))).digest('hex')).toBe(
        entry.sha256,
      )
      expect(entry.source).toMatch(/wizardhelp\/fileformat\.rtf$/u)
    }
    expect(manifest.specDerived.map(entry => entry.file).sort()).toEqual([...FIXTURE_FILES].sort())
    /*
     * The oracle produced by the program itself: SC2Editor's own export of the acceptance wizards.
     * It is pinned byte for byte, and `.gitattributes` keeps its CRLF out of line-ending conversion.
     */
    expect(manifest.editorSaved.map(entry => entry.file)).toEqual(['editor-saved-export.BlizWiz'])
    for (const entry of manifest.editorSaved) {
      expect(createHash('sha256').update(readFileSync(resolve(fixtures, entry.file))).digest('hex')).toBe(
        entry.sha256,
      )
      expect(entry.source).toMatch(/^SC2Editor /u)
    }
  })
})

describe('SC2 data wizard edit targets', () => {
  const text = read('prototype-wizard.BlizWiz')
  const document = parseWizardDocument(text)
  const at = (path: string[]) => {
    const target = locateWizardEditTarget(document, path)
    return text.slice(target.start, target.end)
  }

  it('finds exactly the value each supported path names', () => {
    expect(at(['wizard', 'PrototypeWizard', 'input', 'SimpleInteger', 'default'])).toBe('5')
    expect(at(['wizard', 'PrototypeWizard', 'input', 'ExtraMenu', 'item', '1', 'text'])).toBe('Olives')
    expect(at(['wizard', 'PrototypeWizard', 'macro', 'TestMath1'])).toBe('^SimpleInteger^ * 2 + 1')
    expect(at(['wizard', 'PrototypeWizard', 'condition', 'HasOlives', 'value'])).toBe('oliv')
    expect(at(['wizard', 'PrototypeWizard', 'entry', '0', 'field', 'LifeMax', 'value'])).toBe('^SimpleInteger^ * 10')
  })

  it('changes only the value, with escaping the parser reads back', () => {
    const splice = (path: string[], value: string, encode: (value: string) => string) => {
      const target = locateWizardEditTarget(document, path)
      return text.slice(0, target.start) + encode(value) + text.slice(target.end)
    }
    const attribute = splice(['wizard', 'PrototypeWizard', 'input', 'SimpleInteger', 'default'], 'a"b&c', value =>
      value.replaceAll('&', '&amp;').replaceAll('"', '&quot;'))
    const edited = parseWizardDocument(attribute).file.wizards[0]!
    expect(edited.inputs.find(item => item.id === 'SimpleInteger')?.default).toBe('a"b&c')
    expect(writeWizardDocument(parseWizardDocument(attribute))).toBe(attribute)
    const macro = splice(['wizard', 'PrototypeWizard', 'macro', 'TestMath1'], '<x> & y', value =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
    expect(parseWizardDocument(macro).file.wizards[0]!.macros.find(item => item.id === 'TestMath1')?.text).toBe('<x> & y')
  })

  it.each([...FIXTURE_FILES, 'editor-saved-export.BlizWiz'])('isolates every edit in %s', name => {
    const result = editIsolationFailures(read(name))
    expect(result.targets).toBeGreaterThan(10)
    expect(result.failures).toEqual([])
  })

  it('lists only paths it can write', () => {
    const document = parseWizardDocument(
      '<wizardfile><wizard id="W"><name>W</name><input id="I" type="int32"><default/></input><macro id="M">1</macro><macro id="M">2</macro><macro id="N">3</macro></wizard></wizardfile>',
    )
    expect(listWizardEditPaths(document)).toEqual([['wizard', 'W', 'macro', 'N']])
  })

  it('refuses edits it cannot make without guessing', () => {
    const locate = (source: string, path: string[]) => () => locateWizardEditTarget(parseWizardDocument(source), path)
    const wizard = (body: string) => `<wizardfile><wizard id="W"><name>W</name>${body}</wizard></wizardfile>`
    expect(locate(wizard(''), ['wizard', 'X', 'macro', 'M'])).toThrow(/no wizard X/u)
    expect(locate(wizard('<macro id="M">1</macro><macro id="M">2</macro>'), ['wizard', 'W', 'macro', 'M'])).toThrow(/ambiguous/u)
    expect(locate(wizard('<input id="I" type="int32"><default/></input>'), ['wizard', 'W', 'input', 'I', 'default'])).toThrow(/no value attribute/u)
    expect(locate(wizard('<entry catalog="Unit" type="CUnit"><id>x</id><field id="F"><value/></field></entry>'), ['wizard', 'W', 'entry', '0', 'field', 'F', 'value'])).toThrow(/no text to write/u)
    expect(locate(wizard('<macro id="M">a<b/></macro>'), ['wizard', 'W', 'macro', 'M'])).toThrow(/contains elements/u)
    expect(locate(wizard('<macro id="M">1</macro>'), ['wizard', 'W', 'input', 'M', 'name'])).toThrow(/no input M/u)
    expect(locate(wizard('<input id="I" type="int32"/>'), ['wizard', 'W', 'input', 'I', 'name'])).toThrow(/unsupported edit path/u)
  })
})

describe('SC2 data wizard saved by SC2Editor', () => {
  const text = read('editor-saved-export.BlizWiz')
  const document = parseWizardDocument(text)

  it('round-trips the editor’s own bytes', () => {
    expect(text.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n<wizardfile>\r\n    <wizard')).toBe(true)
    expect(writeWizardDocument(document)).toBe(text)
    expect(document.file.wizards).toHaveLength(10)
  })

  it('keeps what the editor keeps and loses nothing the editor wrote', () => {
    const wizard = (id: string) => document.file.wizards.find(item => item.id === id)!
    // The editor dropped the unknown object type Ability and kept Abil.
    expect(wizard('MKTest_ObjectTypes_Ability').objecttypes).toMatchObject({ create: [], load: [], view: [] })
    expect(wizard('MKTest_ObjectTypes_Abil').objecttypes).toMatchObject({ load: ['Abil'] })
    // It dropped <count> inside <input> and kept the legacy forms.
    expect(wizard('MKTest_InputCount').inputs[0]?.unknown).toEqual([])
    expect(wizard('MKTest_LoadedEntryLegacy').validates[0]?.type).toBe('')
    expect(wizard('MKTest_LoadedEntryLegacy').entries[0]).toMatchObject({ catalog: 'Effect', type: '', useloaded: true })
  })

  it('reports only what the editor also tolerates', () => {
    const findings = analyzeWizardDocument(document, {
      schema: createStarcraft2WizardSchema(),
      compatibilityMode: 'editor-compatible',
    }).diagnostics
    expect(findings.map(item => [item.wizardId, item.severity, item.code])).toEqual([
      ['MKTest_EmbeddedSeparator', 'warning', 'sc2-wizard-unknown-input'],
      ['MKTest_LoadedEntryLegacy', 'warning', 'sc2-wizard-legacy-missing-validate-type'],
      ['MKTest_LoadedEntryLegacy', 'warning', 'sc2-wizard-legacy-missing-entry-type'],
      ['MKTest_LoadedEntryLegacy', 'warning', 'sc2-wizard-legacy-missing-entry-id'],
    ])
  })
})

describe('SC2 data wizard parser and writer', () => {
  it.each(FIXTURE_FILES)('round-trips %s byte for byte', name => {
    const text = read(name)
    expect(writeWizardDocument(parseWizardDocument(text))).toBe(text)
  })

  it('covers every element and attribute the specification documents', () => {
    const nodes = FIXTURE_FILES.flatMap(name => everyNode(parseWizardDocument(read(name)).roots))
    const tags = new Set(nodes.map(node => node.tag))
    const attributes = new Set(nodes.flatMap(node => node.attributes.map(item => item.name)))
    expect(SPEC_ELEMENTS.filter(tag => !tags.has(tag))).toEqual([])
    expect(SPEC_ATTRIBUTES.filter(name => !attributes.has(name))).toEqual([])
  })

  it('reads the typed model the specification describes', () => {
    const document = parseWizardDocument(read('prototype-wizard.BlizWiz'))
    const wizard = document.file.wizards[0]!
    expect(wizard.id).toBe('PrototypeWizard')
    expect(wizard.name).toBe('Prototype Wizard')
    expect(wizard.category).toBe('Test/Prototypes')
    expect(wizard.objecttypes?.create).toEqual(['Unit', 'Actor', 'Model'])
    expect(wizard.objecttypes?.view).toEqual(['Unit'])
    // The specification says the editor strips the indentation authors write inside the element.
    expect(wizard.instructions[0]?.text.split('\n')[1]).toBe('- Creates a unit, actor, and model entry')
    expect(wizard.conditions.map(item => item.id)).toEqual(['HasOlives', 'BestPizza'])
    expect(wizard.conditions[1]?.children).toHaveLength(3)
    expect(wizard.inputs.map(item => item.id)).toContain('MathPreview')
    expect(wizard.inputs.find(item => item.id === 'ExtraMenu')?.items.map(item => item.value)).toEqual([
      'none',
      'oliv',
      'mush',
    ])
    expect(wizard.validates.map(item => item.type)).toEqual(['error', 'confirm', 'warning'])
    expect(wizard.macros.find(item => item.id === 'Truncate')?.truncate).toBe(4)
    const actor = wizard.entries.find(entry => entry.catalog === 'Actor')
    expect(actor?.type).toBe('CActorUnit')
    expect(actor?.fields[0]?.id).toBe('WireframeVariations_Number')
    expect(actor?.fields[0]?.count).toBe('5')
    expect(wizard.entries[0]?.tokens[0]?.id).toBe('race')
  })

  it('ends an element’s text at its own closing tag, not its parent’s', () => {
    const document = parseWizardDocument(
      '<wizardfile><wizard id="W"><name>W</name><macro id="M">a + 1</macro></wizard></wizardfile>',
    )
    // `</macro></wizard>` leaves no gap between the two closing tags, which is where a backwards
    // search for `</` lands on the wrong one.
    expect(document.file.wizards[0]?.macros[0]?.text).toBe('a + 1')
    expect(document.file.wizards[0]?.name).toBe('W')
  })

  it('keeps an element it has never seen, and says so without calling it broken', () => {
    const text = [
      '<wizardfile>',
      '  <wizard id="W" futureAttribute="1">',
      '    <name>W</name>',
      '    <futureElement mode="new"/>',
      '  </wizard>',
      '</wizardfile>',
    ].join('\n')
    const document = parseWizardDocument(text)
    expect(writeWizardDocument(document)).toBe(text)
    expect(document.file.wizards[0]?.unknown.map(node => node.tag)).toEqual(['futureElement'])
    const findings = analyzeWizardDocument(document).diagnostics
    expect(findings.every(item => item.severity === 'info')).toBe(true)
    expect(findings.map(item => item.code).sort()).toEqual([
      'sc2-wizard-unknown-attribute',
      'sc2-wizard-unknown-element',
    ])
  })

  it('refuses a file shaped like the format MK2 modelled', () => {
    const mk2 = '<DataWizard id="SimpleUnit"><DataType value="CUnit"/><Step id="A" name="A"/></DataWizard>'
    const document = parseWizardDocument(mk2)
    expect(document.file.wizards).toEqual([])
    expect(analyzeWizardDocument(document).diagnostics.map(item => item.code)).toEqual([
      'sc2-wizard-root-missing',
    ])
  })

  it('keeps the documented root strict and accepts a case variant only in compatibility mode', () => {
    const text = '<WizardFile><wizard id="W"><name>W</name></wizard></WizardFile>'
    const strict = parseWizardDocument(text)
    expect(strict.file.wizards).toHaveLength(0)
    expect(analyzeWizardDocument(strict).diagnostics.map(item => item.code)).toEqual([
      'sc2-wizard-root-missing',
    ])

    const compatible = parseWizardDocument(text, { caseInsensitiveRoot: true })
    expect(compatible.file.rootKind).toBe('wizardfile')
    expect(compatible.file.wizards.map(item => item.id)).toEqual(['W'])
    expect(writeWizardDocument(compatible)).toBe(text)
    expect(
      analyzeWizardDocument(compatible, { compatibilityMode: 'editor-compatible' }).diagnostics.map(
        item => item.code,
      ),
    ).toEqual(['sc2-wizard-noncanonical-root'])
  })

  it('keeps standalone wizard roots behind an explicit compatibility option', () => {
    const text = '<wizard id="Standalone"><name>Standalone</name></wizard>'
    const strict = parseWizardDocument(text)
    expect(strict.file.wizards).toHaveLength(0)

    const compatible = parseWizardDocument(text, { allowStandaloneWizard: true })
    expect(compatible.file.rootKind).toBe('standalone-wizard')
    expect(compatible.file.wizards.map(item => item.id)).toEqual(['Standalone'])
    expect(writeWizardDocument(compatible)).toBe(text)
    expect(
      analyzeWizardDocument(compatible, { compatibilityMode: 'editor-compatible' }).diagnostics.map(
        item => item.code,
      ),
    ).toEqual(['sc2-wizard-compatibility-root'])
  })

  it('reports an omitted validation type as legacy only in compatibility mode', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><validate><text>check</text></validate></wizard></wizardfile>'
    const document = parseWizardDocument(text)
    expect(analyzeWizardDocument(document).diagnostics.map(item => item.code)).toEqual([
      'sc2-wizard-missing-attribute',
    ])
    expect(
      analyzeWizardDocument(document, { compatibilityMode: 'editor-compatible' }).diagnostics.map(
        item => item.code,
      ),
    ).toEqual(['sc2-wizard-legacy-missing-validate-type'])
  })

  it('reports a loaded entry without a type as legacy only in compatibility mode', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><entry catalog="Effect"><useloaded/><field id="ValidatorArray"><value>x</value></field></entry></wizard></wizardfile>'
    const document = parseWizardDocument(text)
    expect(analyzeWizardDocument(document).diagnostics.map(item => item.code)).toEqual([
      'sc2-wizard-missing-attribute',
      'sc2-wizard-missing-entry-id',
    ])
    expect(
      analyzeWizardDocument(document, { compatibilityMode: 'editor-compatible' }).diagnostics.map(
        item => item.code,
      ),
    ).toEqual(['sc2-wizard-legacy-missing-entry-type', 'sc2-wizard-legacy-missing-entry-id'])
    const untyped = parseWizardDocument(text.replace('<useloaded/>', '<id>x</id>'))
    expect(
      analyzeWizardDocument(untyped, { compatibilityMode: 'editor-compatible' }).diagnostics.map(
        item => item.code,
      ),
    ).toEqual(['sc2-wizard-missing-attribute'])
  })
})

describe('SC2 data wizard string evaluation', () => {
  const document = parseWizardDocument(read('prototype-wizard.BlizWiz'))
  const wizard = document.file.wizards[0]!
  const inputs = new Map([
    ['SimpleInteger', '5'],
    ['SimpleString', 'Test'],
    ['BaseValue', 'Some Long Name'],
  ])

  it('evaluates the specification’s own macro examples', () => {
    const value = (id: string) => evaluateWizardMacro(id, { wizard, inputs }).text
    expect(value('TestMath1')).toBe('11')
    // Integer division, because no operand carries a period: ((5 - 1) * 2) / 8 is 1, not 1.0.
    expect(value('TestMath3')).toBe('1')
    expect(value('EntryId')).toBe('PrototypeWizardUnit_Test')
    expect(value('RemoveSpaces')).toBe('SomeLongName')
    expect(value('SpaceToUnderscore')).toBe('Some_Long_Name')
    expect(value('Truncate')).toBe('Some')
    expect(value('RemoveSpacesThenTruncate')).toBe('Some')
  })

  it('treats ^^ as one literal caret', () => {
    expect(evaluateWizardText('a ^^ b', { wizard, inputs }).text).toBe('a ^ b')
    expect(evaluateWizardText('^^^SimpleInteger^^^', { wizard, inputs }).text).toBe('^5^')
  })

  it('substitutes index tokens and the loaded entry id', () => {
    const context = { wizard, inputs, entryIndex: 2, valueIndex: 3, itemIndex: 1, loadId: 'Marine' }
    expect(evaluateWizardText('^SimpleInteger^ + ^VALUEINDEX^', context).text).toBe('8')
    expect(evaluateWizardText('e^ENTRYINDEX^i^ITEMINDEX^', context).text).toBe('e2i1')
    expect(evaluateWizardText('^LOADID^', context).text).toBe('Marine')
  })

  it('keeps integer and real arithmetic apart, exactly as the character rule says', () => {
    expect(evaluateArithmetic('7 / 2')).toBe(3)
    expect(evaluateArithmetic('7 / 2.0')).toBe(3.5)
    expect(evaluateArithmetic('((5 - 1) * 2) / 8')).toBe(1)
    // Not an arithmetic expression, and left alone rather than coerced.
    expect(evaluateArithmetic('Unit_5')).toBeUndefined()
    expect(evaluateArithmetic('5 +')).toBeUndefined()
  })

  it('refuses a catalog reference instead of guessing, and resolves one when data is there', () => {
    const context = { wizard, inputs, loadId: 'Marine' }
    const refused = evaluateWizardMacro('KillPlusLost', context)
    expect(refused.resolved).toBe(false)
    expect(refused.unresolved.map(item => item.kind)).toEqual(['reference', 'reference'])
    expect(refused.text).toContain('ref=Unit,Marine,ScoreKill')

    const catalog: WizardCatalogProvider = {
      fieldValue: (type, entryId, path) =>
        type === 'Unit' && entryId === 'Marine'
          ? { ScoreKill: '50', ScoreLost: '50' }[path]
          : undefined,
      fieldCount: () => undefined,
    }
    const resolved = evaluateWizardMacro('KillPlusLost', { ...context, catalog })
    expect(resolved.resolved).toBe(true)
    expect(resolved.text).toBe('100')
  })

  it('reads the trailing-# form as an array count', () => {
    const catalog: WizardCatalogProvider = {
      fieldValue: () => undefined,
      fieldCount: (_type, _entryId, path) => (path === 'WeaponArray' ? 2 : undefined),
    }
    const coverage = parseWizardDocument(read('spec-coverage.BlizWiz'))
    const host = coverage.file.wizards.find(item => item.id === 'CoverageWizard')!
    expect(evaluateWizardMacro('WeaponCount', { wizard: host, catalog, loadId: 'Marine' }).text).toBe('2')
  })

  it('follows a token into an embedded wizard', () => {
    const coverage = parseWizardDocument(read('spec-coverage.BlizWiz'))
    const wizards = new Map(coverage.file.wizards.map(item => [item.id, item]))
    const host = wizards.get('CoverageWizard')!
    const value = evaluateWizardText('^Sub:Suffix^', {
      wizard: host,
      wizards,
      inputs: new Map([['Sub:Suffix', 'Beta']]),
    })
    expect(value.text).toBe('Beta')
    // With no value entered, the embedded wizard's own default answers.
    expect(evaluateWizardText('^Sub:Suffix^', { wizard: host, wizards }).text).toBe('Alpha')
  })

  it('stops at a macro that refers to itself', () => {
    const document = parseWizardDocument(
      '<wizardfile><wizard id="W"><name>W</name><macro id="A">^B^</macro><macro id="B">^A^</macro></wizard></wizardfile>',
    )
    const wizard = document.file.wizards[0]!
    expect(evaluateWizardMacro('A', { wizard }).unresolved.map(item => item.kind)).toContain(
      'macro-cycle',
    )
  })

  it('stops at an input default that refers to itself instead of overflowing the stack', () => {
    const document = parseWizardDocument(
      '<wizardfile><wizard id="W"><name>W</name><input id="A" type="int32"><default value="^A^"/></input></wizard></wizardfile>',
    )
    const result = evaluateWizardText('^A^', { wizard: document.file.wizards[0]! })
    expect(result.unresolved.map(item => item.kind)).toContain('default-cycle')
  })

  it('does not mistake the same macro name in an embedded wizard for a cycle', () => {
    const document = parseWizardDocument(
      '<wizardfile>' +
        '<wizard id="W"><name>W</name><input id="Sub" type="Wizard:C"/><macro id="M">^C:M^</macro></wizard>' +
        '<wizard id="C"><name>C</name><macro id="M">7</macro></wizard>' +
        '</wizardfile>',
    )
    const wizards = new Map(document.file.wizards.map(item => [item.id, item]))
    expect(evaluateWizardMacro('M', { wizard: wizards.get('W')!, wizards })).toMatchObject({ text: '7', resolved: true })
  })
})

describe('SC2 data wizard checker', () => {
  const schema = createStarcraft2WizardSchema()

  it.each(FIXTURE_FILES)('finds nothing wrong with %s', name => {
    expect(analyzeWizardDocument(parseWizardDocument(read(name)), { schema }).diagnostics).toEqual([])
  })

  it('points at a mistyped catalog field, with its position', () => {
    const text = [
      '<wizardfile>',
      '  <wizard id="W">',
      '    <name>W</name>',
      '    <entry catalog="Unit" type="CUnit">',
      '      <id>x</id>',
      '      <field id="LifeMxa"><value>1</value></field>',
      '    </entry>',
      '  </wizard>',
      '</wizardfile>',
    ].join('\n')
    const findings = analyzeWizardDocument(parseWizardDocument(text), { schema }).diagnostics
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      code: 'sc2-wizard-unknown-field',
      severity: 'error',
      message: 'CUnit has no field LifeMxa',
      wizardId: 'W',
    })
    expect(findings[0]?.start.line).toBe(5)
    expect(text.slice(findings[0]!.start.offset, findings[0]!.end.offset)).toBe('LifeMxa')
  })

  it('accepts the editor Name field on types whose catalog XML lacks it', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><entry catalog="Sound" type="CSound"><id>x</id><field id="Name"><value>x</value></field><field id="Nmae"><value>x</value></field></entry></wizard></wizardfile>'
    expect(
      analyzeWizardDocument(parseWizardDocument(text), { schema }).diagnostics.map(item => item.message),
    ).toEqual(['CSound has no field Nmae'])
  })

  it('warns rather than errs on a token into an embedded wizard from another file', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><input id="Impact" type="Wizard:Elsewhere"/><macro id="M">^Elsewhere:Id^ ^Nobody:Id^</macro></wizard></wizardfile>'
    const findings = analyzeWizardDocument(parseWizardDocument(text)).diagnostics
    expect(findings.map(item => [item.code, item.severity])).toEqual([
      ['sc2-wizard-embedded-wizard-missing', 'warning'],
      ['sc2-wizard-embedded-token-unresolved', 'warning'],
      ['sc2-wizard-unknown-token', 'error'],
    ])
  })

  it('reports the catalog and the entry type disagreeing', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><entry catalog="Unit" type="CActorUnit"><id>x</id></entry></wizard></wizardfile>'
    expect(
      analyzeWizardDocument(parseWizardDocument(text), { schema }).diagnostics.map(item => item.code),
    ).toEqual(['sc2-wizard-catalog-type-mismatch'])
  })

  it('reports names that do not resolve inside the file', () => {
    const text = [
      '<wizardfile>',
      '  <wizard id="W">',
      '    <name>W</name>',
      '    <input id="A" type="int32"><condition input="Missing" value="1"/></input>',
      '    <macro id="M">^Nope^</macro>',
      '    <validate type="error"><condition id="Undeclared"/><text>no</text></validate>',
      '  </wizard>',
      '</wizardfile>',
    ].join('\n')
    const codes = analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => item.code)
    expect(codes.sort()).toEqual([
      'sc2-wizard-unknown-condition',
      'sc2-wizard-unknown-input',
      'sc2-wizard-unknown-token',
    ])
  })

  it('reports macros and defaults that can only evaluate through themselves', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name>' +
      '<input id="A" type="int32"><default value="^B^ + 1"/></input>' +
      '<input id="Ok" type="int32"><default value="^C^"/></input>' +
      '<macro id="B">^A^</macro><macro id="C">2</macro><macro id="D">^D^</macro>' +
      '</wizard></wizardfile>'
    const findings = analyzeWizardDocument(parseWizardDocument(text)).diagnostics
    expect(findings.map(item => [item.code, item.message.split(' cannot')[0]])).toEqual([
      ['sc2-wizard-evaluation-cycle', 'macro B'],
      ['sc2-wizard-evaluation-cycle', 'macro D'],
      ['sc2-wizard-evaluation-cycle', 'the default of input A'],
    ])
  })

  it('applies the documented input, layout, macro and view rules', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><hidden/><objecttypes view="Unit"/>' +
      '<instructions page="0">x</instructions>' +
      '<input id="A" type="int32"><color value="255,0,0,0"/><reloadfrom>B</reloadfrom><layout page="2" column="x" minwidth="-1"/></input>' +
      '<input id="B" type="WizardText"><color value="255,0,0,0"/><loadvalue>1</loadvalue><reloadfrom>A</reloadfrom></input>' +
      '<macro id="M" truncate="-4">x</macro>' +
      '</wizard></wizardfile>'
    expect(analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => [item.code, item.message])).toEqual([
      ['sc2-wizard-color-ignored', '<color> is only supported by WizardText; this input is int32'],
      ['sc2-wizard-reloadfrom-without-loadvalue', 'reloadfrom reloads the value from <loadvalue>, and this input has none'],
      ['sc2-wizard-invalid-value', 'column="x" must be an integer of at least 1'],
      ['sc2-wizard-invalid-value', 'minwidth="-1" must be an integer of at least 0'],
      ['sc2-wizard-invalid-value', 'page="0" must be an integer of at least 1'],
      ['sc2-wizard-invalid-value', 'truncate="-4" must be an integer of at least 0'],
      ['sc2-wizard-view-hidden', 'a hidden wizard is never shown in Wizard View, so its view object types have no effect'],
    ])
  })

  it('warns on an object type the editor drops when saving', () => {
    // Runtime-confirmed: SC2Editor exported load="Ability" as <objecttypes/> and kept Abil.
    const text =
      '<wizardfile><wizard id="W"><name>W</name><objecttypes create="Abil" load="Ability"/></wizard></wizardfile>'
    expect(analyzeWizardDocument(parseWizardDocument(text), { schema }).diagnostics.map(item => [item.code, item.severity, item.message])).toEqual([
      ['sc2-wizard-unknown-object-type', 'warning', 'Ability is not a StarCraft II object type; the editor drops it when it saves the wizard'],
    ])
  })

  it('warns, as SC2Editor does, on a condition naming an unknown input', () => {
    // Runtime-confirmed: the editor lists "Unknown input 'Sub;Flag'" as a Warning (acceptance T3).
    const text =
      '<wizardfile><wizard id="W"><name>W</name><input id="A" type="WizardText"><condition input="Sub;Flag" value="1"/></input></wizard></wizardfile>'
    expect(analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => [item.code, item.severity])).toEqual([
      ['sc2-wizard-unknown-input', 'warning'],
    ])
  })

  it('reports a named condition declared twice', () => {
    const text =
      '<wizardfile><wizard id="W"><name>W</name><condition id="C" input="I"/><condition id="C" input="I"/><input id="I" type="int32"/></wizard></wizardfile>'
    expect(analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => [item.code, item.message])).toEqual([
      ['sc2-wizard-duplicate-id', 'condition C is declared twice in this wizard'],
    ])
  })

  it('catches a wizard that embeds itself', () => {
    const text =
      '<wizardfile>' +
      '<wizard id="A"><name>A</name><input id="i" type="Wizard:B"/></wizard>' +
      '<wizard id="B"><name>B</name><input id="j" type="Wizard:A"/></wizard>' +
      '</wizardfile>'
    const codes = analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => item.code)
    expect(codes).toEqual(['sc2-wizard-embedded-cycle', 'sc2-wizard-embedded-cycle'])
  })

  it('requires what the specification requires', () => {
    const text =
      '<wizardfile><wizard><input type="int32"/><entry catalog="Unit" type="CUnit"/></wizard></wizardfile>'
    const codes = analyzeWizardDocument(parseWizardDocument(text)).diagnostics.map(item => item.code)
    expect(codes).toContain('sc2-wizard-missing-attribute')
    expect(codes).toContain('sc2-wizard-missing-name')
    expect(codes).toContain('sc2-wizard-missing-entry-id')
  })
})

describe('SC2 data wizard outline', () => {
  it('says what the wizard will create and which fields it touches', () => {
    const document = parseWizardDocument(read('prototype-wizard.BlizWiz'))
    const outline = outlineWizardDocument(document)[0]!
    expect(outline.pages).toBe(2)
    expect(outline.entries.map(entry => `${entry.catalog}/${entry.type}`)).toEqual([
      'Unit/CUnit',
      'Actor/CActorUnit',
    ])
    expect(outline.touchedFields).toEqual([
      'Actor.CActorUnit.WireframeVariations_Number',
      'Unit.CUnit.LifeMax',
      'Unit.CUnit.Name',
    ])
    // A nosave input and a read-only WizardText ask the user for something and write nothing.
    expect(outline.inputs.filter(input => !input.saves).map(input => input.id)).toEqual([
      'BaseValue',
      'MathPreview',
    ])
  })

  it('answers from the defaults the dialog opens with, and from entered values once they exist', () => {
    const document = parseWizardDocument(read('prototype-wizard.BlizWiz'))
    const opened = outlineWizardDocument(document)[0]!
    expect(opened.entries[0]?.id).toMatchObject({
      expression: '^EntryId^',
      value: 'PrototypeWizardUnit_Prototype',
    })

    const withInputs = outlineWizardDocument(document, {
      inputs: new Map([
        ['SimpleString', 'Test'],
        ['SimpleInteger', '5'],
      ]),
    })[0]!
    expect(withInputs.entries[0]?.id?.value).toBe('PrototypeWizardUnit_Test')
    expect(withInputs.entries[0]?.fields.find(field => field.id === 'LifeMax')?.value?.value).toBe('50')
  })

  it('reports an expression it could not finish rather than a value it invented', () => {
    const document = parseWizardDocument(
      '<wizardfile><wizard id="W"><name>W</name>' +
        '<entry catalog="Unit" type="CUnit"><id>x</id>' +
        '<field id="ScoreKill"><value>ref=Unit,Marine,ScoreKill + 1</value></field>' +
        '</entry></wizard></wizardfile>',
    )
    const field = outlineWizardDocument(document)[0]?.entries[0]?.fields[0]
    expect(field?.value?.expression).toBe('ref=Unit,Marine,ScoreKill + 1')
    expect(field?.value?.value).toBeUndefined()
    expect(field?.value?.unresolved).toEqual(['ref=Unit,Marine,ScoreKill'])
  })
})
