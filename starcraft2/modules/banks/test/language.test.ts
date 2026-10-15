import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BANK_ELEMENTS,
  BANK_VALUE_TYPES,
  bankValueProblem,
  createSc2BankLanguageProvider,
  scanBank,
} from '../providers/language/src/language.js'

const provider = createSc2BankLanguageProvider()

function request(text: string, extra: Record<string, unknown> = {}) {
  return {
    document: { uri: 'memory://bank', languageId: 'sc2-bank', version: 1, text },
    workspaceDocuments: [],
    workspaceIncomplete: true,
    maxResults: 100,
    maxDocuments: 1,
    ...extra,
  } as never
}

const NL = '\n'
const TAB = '\t'

const VALID = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Bank version="1">',
  `${TAB}<Section name="Stats">`,
  `${TAB}${TAB}<Key name="TotalKills">`,
  `${TAB}${TAB}${TAB}<Value int="9999999"/>`,
  `${TAB}${TAB}</Key>`,
  `${TAB}</Section>`,
  `${TAB}<Signature value="AB"/>`,
  '</Bank>',
  '',
].join(NL)

/** Caret position for the offset just past `needle`, or `into` characters into it. */
function at(text: string, needle: string, into?: number) {
  const offset = text.indexOf(needle) + (into ?? needle.length)
  const before = text.slice(0, offset)
  return {
    line: before.split(NL).length - 1,
    character: offset - (before.lastIndexOf(NL) + 1),
  }
}

describe('sc2-bank value schema, ported from MK2 validate.ts', () => {
  it('knows exactly the six types MK2 accepted', () => {
    expect([...BANK_VALUE_TYPES]).toEqual(['int', 'fixed', 'string', 'flag', 'text', 'point'])
  })

  it('accepts the forms MK2 accepted and rejects the ones it rejected', () => {
    expect(bankValueProblem('int', '-42')).toBeUndefined()
    expect(bankValueProblem('int', '4.2')).toMatch(/Invalid int/u)
    expect(bankValueProblem('fixed', '-.5')).toBeUndefined()
    expect(bankValueProblem('fixed', 'abc')).toMatch(/Invalid fixed/u)
    expect(bankValueProblem('flag', 'TRUE')).toBeUndefined()
    expect(bankValueProblem('flag', '2')).toMatch(/Invalid flag/u)
    expect(bankValueProblem('point', '12.5,-3')).toBeUndefined()
    expect(bankValueProblem('point', '12.5')).toMatch(/Invalid point/u)
    // `string` and `text` hold anything the file holds, so nothing can be wrong with them.
    expect(bankValueProblem('string', '<<<')).toBeUndefined()
    expect(bankValueProblem('text', '')).toBeUndefined()
  })
})

describe('sc2-bank diagnostics', () => {
  it('reports nothing on a well-formed bank', async () => {
    const list = await provider.diagnostics!(request(VALID))
    expect(list.diagnostics).toEqual([])
  })

  it('flags a value that does not match its declared type, at the value itself', async () => {
    const text = VALID.replace('9999999', 'abc')
    const list = await provider.diagnostics!(request(text))
    const finding = list.diagnostics.find(item => item.code === 'invalid-int')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toMatch(/Invalid int value "abc"/u)
    // The squiggle must sit on `abc`, not on the line above or the element start.
    const line = text.split(NL)[finding!.range.start.line] ?? ''
    expect(line.slice(finding!.range.start.character, finding!.range.end.character)).toBe('abc')
  })

  it('warns about a type the format does not define, on the attribute name', async () => {
    const text = VALID.replace('int=', 'integer=')
    const list = await provider.diagnostics!(request(text))
    const finding = list.diagnostics.find(item => item.code === 'unknown-value-type')
    expect(finding?.severity).toBe('warning')
    const line = text.split(NL)[finding!.range.start.line] ?? ''
    expect(line.slice(finding!.range.start.character, finding!.range.end.character)).toBe('integer')
  })

  it('reports a duplicate section once, on the second occurrence', async () => {
    const text = VALID.replace('</Bank>', `${TAB}<Section name="Stats"></Section>${NL}</Bank>`)
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.filter(item => item.code === 'duplicate-section')).toHaveLength(1)
  })

  it('warns when the bank carries no signature', async () => {
    const text = VALID.replace(`${TAB}<Signature value="AB"/>${NL}`, '')
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.map(item => item.code)).toContain('missing-signature')
  })
})

describe('sc2-bank completion', () => {
  it('offers the six types where a Value type attribute goes', async () => {
    const list = await provider.completion!(request(VALID, { position: at(VALID, '<Value ') }))
    expect(list.items.map(item => item.label)).toEqual([...BANK_VALUE_TYPES])
    expect(list.items[0]).toMatchObject({ insertText: 'int="$1"', insertTextFormat: 'snippet' })
  })

  it('offers only the attributes an element actually accepts', async () => {
    const list = await provider.completion!(request(VALID, { position: at(VALID, '<Section ') }))
    expect(list.items.map(item => item.label)).toEqual(['name'])
  })

  it('offers only elements the format allows inside the current parent', async () => {
    // Inside a Section a bank may contain a Key and nothing else.
    const text = VALID.replace(`${TAB}${TAB}<Key name="TotalKills">`, `${TAB}${TAB}<`)
    const list = await provider.completion!(request(text, { position: at(text, `${TAB}${TAB}<`) }))
    expect(list.items.map(item => item.label)).toEqual(['Key'])
  })

  it('offers names the file already uses when completing a key name', async () => {
    const text = VALID.replace('name="TotalKills"', 'name="')
    const list = await provider.completion!(request(text, { position: at(text, '<Key name="') }))
    expect(list.items.every(item => item.kind === 'field')).toBe(true)
  })

  it('offers nothing where nothing is meaningful', async () => {
    const list = await provider.completion!(request(VALID, { position: { line: 0, character: 3 } }))
    expect(list.items).toEqual([])
  })
})

describe('sc2-bank structural rules', () => {
  it('rejects an element the format does not define', async () => {
    const text = VALID.replace('<Value int="9999999"/>', '<Entry int="1"/>')
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.map(item => item.code)).toContain('unknown-element')
  })

  it('rejects an element nested in the wrong parent', async () => {
    const text = VALID.replace('<Value int="9999999"/>', '<Section name="Nested"></Section>')
    const list = await provider.diagnostics!(request(text))
    const finding = list.diagnostics.find(item => item.code === 'misplaced-element')
    expect(finding?.message).toMatch(/belongs in .Bank., not in .Key./u)
  })

  it('rejects an attribute the element rejects, and the loss of the required one', async () => {
    const text = VALID.replace('<Key name="TotalKills">', '<Key label="TotalKills">')
    const codes = (await provider.diagnostics!(request(text))).diagnostics.map(item => item.code)
    expect(codes).toContain('unknown-attribute')
    expect(codes).toContain('missing-attribute')
  })

  it('rejects a duplicate key in one section but allows the same name in another', async () => {
    const duplicated = VALID.replace(
      `${TAB}</Section>`,
      `${TAB}${TAB}<Key name="TotalKills"><Value int="2"/></Key>${NL}${TAB}</Section>`,
    )
    const first = await provider.diagnostics!(request(duplicated))
    expect(first.diagnostics.filter(item => item.code === 'duplicate-key')).toHaveLength(1)

    const another = [
      `${TAB}<Section name="Other">`,
      `${TAB}${TAB}<Key name="TotalKills"><Value int="2"/></Key>`,
      `${TAB}</Section>`,
      '</Bank>',
    ].join(NL)
    const reused = VALID.replace('</Bank>', another)
    const second = await provider.diagnostics!(request(reused))
    expect(second.diagnostics.filter(item => item.code === 'duplicate-key')).toEqual([])
  })
})

describe('sc2-bank structure', () => {
  it('publishes typed semantic tokens and exact symbol selection ranges', async () => {
    const analysis = await provider.analyze(request(VALID))
    expect(analysis.tokens.map(token => token.kind)).toEqual(
      expect.arrayContaining(['type', 'property', 'string', 'number']),
    )
    const intValue = analysis.tokens.find(token => {
      if (token.kind !== 'number') return false
      const line = VALID.split(NL)[token.range.start.line] ?? ''
      return line.slice(token.range.start.character, token.range.end.character) === '9999999'
    })
    expect(intValue).toBeDefined()
    const section = analysis.symbols.find(symbol => symbol.name === 'Stats')
    const line = VALID.split(NL)[section!.selectionRange.start.line] ?? ''
    expect(
      line.slice(section!.selectionRange.start.character, section!.selectionRange.end.character),
    ).toBe('Stats')
  })

  it('scans sections, keys and values out of a real bank from a shipped map', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/endofdreamsbank2.SC2Bank', import.meta.url))
    const text = await readFile(fixture, 'utf8')
    const scan = scanBank(text)
    const named = (name: string) =>
      scan.elements
        .filter(element => element.name === name)
        .map(element => element.attributes.find(a => a.name === 'name')?.value)
    expect(named('Section')).toEqual(['Ranks', 'Stats', 'Check'])
    expect(named('Key').length).toBeGreaterThanOrEqual(8)
    // Every element the shipped file uses is one the schema declares.
    for (const element of scan.elements) {
      expect(Object.hasOwn(BANK_ELEMENTS, element.name)).toBe(true)
    }
    // A checker that fires on shipped data is a checker nobody will keep switched on.
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('lists sections and keys as document symbols', async () => {
    const list = await provider.documentSymbols!(request(VALID))
    expect(list.symbols.map(symbol => [symbol.kind, symbol.name])).toEqual([
      ['namespace', 'Stats'],
      ['field', 'TotalKills'],
    ])
  })
})

describe('sc2-bank navigation and rename', () => {
  it('qualifies key names by section across a complete workspace', async () => {
    const second = VALID.replace('TotalKills', 'Wins').replace('Stats', 'Other')
    const duplicate = VALID.replace('9999999', '1')
    const position = at(VALID, 'TotalKills', 3)
    const workspaceDocuments = [
      { uri: 'memory://bank', languageId: 'sc2-bank', version: 1, text: VALID },
      { uri: 'memory://duplicate', languageId: 'sc2-bank', version: 2, text: duplicate },
      { uri: 'memory://other', languageId: 'sc2-bank', version: 3, text: second },
    ]
    const complete = request(VALID, { position, workspaceDocuments, workspaceIncomplete: false })

    const definitions = await provider.definition!(complete)
    expect(definitions.locations.map(location => location.uri)).toEqual([
      'memory://bank',
      'memory://duplicate',
    ])
    expect(definitions.isIncomplete).toBe(false)

    const references = await provider.references!({ ...complete, includeDeclaration: false })
    expect(references.locations).toEqual([])

    const preparation = await provider.prepareRename!(complete)
    expect(preparation?.placeholder).toBe('TotalKills')
    const renamed = await provider.rename!({ ...complete, newName: 'Victories', maxEdits: 10 })
    expect(renamed?.documentChanges.map(change => [change.uri, change.documentVersion])).toEqual([
      ['memory://bank', 1],
      ['memory://duplicate', 2],
    ])
    expect(
      renamed?.documentChanges.flatMap(change => change.edits).map(edit => edit.newText),
    ).toEqual(['Victories', 'Victories'])
  })

  it('limits rename to the primary document when the workspace is incomplete', async () => {
    const position = at(VALID, 'Stats', 2)
    const renamed = await provider.rename!({
      ...request(VALID, {
        position,
        workspaceDocuments: [
          { uri: 'memory://other', languageId: 'sc2-bank', version: 2, text: VALID },
        ],
        workspaceIncomplete: true,
      }),
      newName: 'MatchStats',
      maxEdits: 10,
    })
    expect(renamed?.documentChanges).toHaveLength(1)
    expect(renamed?.documentChanges[0]?.uri).toBe('memory://bank')
  })
})

describe('sc2-bank source-preserving actions', () => {
  it('changes only the requested final newline and preserves CRLF style', async () => {
    const source = VALID.trimEnd().replace(/\n/gu, '\r\n')
    const formatted = await provider.formatting!(
      request(source, {
        options: { tabSize: 2, insertSpaces: true, finalNewline: true },
      }),
    )
    expect(formatted.edits).toEqual([
      {
        range: {
          start: { line: source.split('\r\n').length - 1, character: '</Bank>'.length },
          end: { line: source.split('\r\n').length - 1, character: '</Bank>'.length },
        },
        newText: '\r\n',
      },
    ])
  })

  it('offers the shared final-newline code action without writing source', async () => {
    const source = VALID.trimEnd()
    const result = await provider.codeActions!(
      request(source, {
        range: { start: { line: 0, character: 0 }, end: at(source, '</Bank>') },
        diagnostics: [],
        maxEdits: 4,
      }),
    )
    expect(result.actions).toMatchObject([
      {
        title: 'Add final newline',
        edit: { documentChanges: [{ uri: 'memory://bank', documentVersion: 1 }] },
      },
    ])
    expect(source.endsWith('\n')).toBe(false)
  })
  it('explains the section or key under the caret, not only its tag', async () => {
    const offset = VALID.indexOf('name="TotalKills"') + 'name="Total'.length
    const before = VALID.slice(0, offset).split(NL)
    const hover = await provider.hover!(
      request(VALID, {
        position: { line: before.length - 1, character: before[before.length - 1].length },
      }),
    )
    expect(hover?.markdown).toContain('**Key** `TotalKills`')
  })
})
