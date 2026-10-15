/**
 * Language services for localization catalogs.
 *
 * The rules all come from the ported MK2 library; what this file proves is the part that could not
 * be ported, because MK2's library works on one value at a time and a document is a file of lines.
 * Every case below is a way that mapping can be wrong — and a wrong mapping shifts every squiggle
 * and every suggestion by the width of the key, which reads as a broken checker rather than a
 * broken translation.
 */
import { describe, expect, it } from 'vitest'
import { createSc2StringsLanguageProvider } from '../providers/language/src/language.js'
import { stringKeyUnder } from '../providers/language/src/workspace.js'

const provider = createSc2StringsLanguageProvider()
const NL = '\n'

function request(text: string, extra: Record<string, unknown> = {}) {
  return {
    document: { uri: 'memory://GameStrings.txt', languageId: 'sc2-strings', version: 1, text },
    workspaceDocuments: [],
    workspaceIncomplete: true,
    maxResults: 100,
    maxDocuments: 1,
    ...extra,
  } as never
}

function workspaceDocument(text: string, uri: string) {
  return { uri, languageId: 'sc2-strings', version: 3, text }
}

const DOCUMENT = [
  '// a comment line',
  'Unit/Name/Marine=Marine',
  'Button/Tooltip/Attack=Deals <d ref="Effect,Foo,Amount"/> damage',
  '',
].join(NL)

describe('sc2-strings tokens', () => {
  it('keeps repeated Layout key lookup current when the document text changes', () => {
    const document = { uri: 'memory://Panel.SC2Layout', languageId: 'sc2-layout', version: 1,
      text: '<Desc><Frame type="Label" name="Title"><Text val="@UI/Old"/></Frame></Desc>' }
    const position = { line: 0, character: document.text.indexOf('UI/Old') + 2 }
    expect(stringKeyUnder(document, position)).toBe('UI/Old')
    expect(stringKeyUnder(document, position)).toBe('UI/Old')
    document.text = document.text.replace('UI/Old', 'UI/New')
    document.version++
    expect(stringKeyUnder(document, position)).toBe('UI/New')
  })

  it('types the key segments: catalog, property path, object id', async () => {
    const analysis = await provider.analyze(request(DOCUMENT))
    const line = analysis.tokens
      .filter(token => token.range.start.line === 1 && token.kind !== 'operator')
      .slice(0, 3)
    // `Unit` / `Name` / `Marine` — the catalog, the property, then the object it names. The `/`
    // separators are tokens too, and are filtered out here rather than assumed away.
    expect(line.map(token => token.kind)).toEqual(['type', 'property', 'variable'])
  })

  /*
   * The mapping under test. A value's tokens are produced with offsets inside the value, and the
   * document position is that offset plus the width of `key=`. Off by that width is the failure
   * this pins.
   */
  it('places value tokens after the key, not at the start of the line', async () => {
    const analysis = await provider.analyze(request(DOCUMENT))
    const prefix = 'Button/Tooltip/Attack='.length
    const onLine = analysis.tokens.filter(token => token.range.start.line === 2)
    // Key tokens start at column zero on the same line; the value's begin past the separator.
    const valueTokens = onLine.filter(token => token.range.start.character >= prefix)
    expect(valueTokens.length).toBeGreaterThan(0)
    // The `<d ref .../>` run is a reference, and the contract spells that `variable`.
    expect(valueTokens.some(token => token.kind === 'variable')).toBe(true)
  })

  it('measures the value column from the raw line, not from the key length', async () => {
    // A hand-edited file can carry spaces around the separator; assuming it cannot drifts offsets.
    const text = ['A/B = value', ''].join(NL)
    const analysis = await provider.analyze(request(text))
    const valueTokens = analysis.tokens.filter(
      token => token.range.start.character >= 'A/B ='.length,
    )
    expect(valueTokens.length).toBeGreaterThan(0)
  })
})

describe('sc2-strings diagnostics', () => {
  it('reports nothing on a healthy catalog', async () => {
    const list = await provider.diagnostics!(request(DOCUMENT))
    expect(list.diagnostics).toEqual([])
  })

  it('puts a duplicate-key finding on the key, where a reader looks for it', async () => {
    const text = ['A/B=one', 'A/B=two', ''].join(NL)
    const list = await provider.diagnostics!(request(text))
    const duplicate = list.diagnostics.find(item => item.code === 'duplicate-key')
    expect(duplicate?.range.start).toEqual({ line: 1, character: 0 })
    expect(duplicate?.range.end.character).toBe('A/B'.length)
  })

  /*
   * What MK2 actually calls malformed, which is narrower than the previous adapter claimed: it
   * flagged any `<d …>` that was not self-closing, a rule the library does not have and the game
   * does not enforce. An unclosed `~token` is a real one.
   */
  it('marks malformed markup inside the value, offset past the key', async () => {
    const text = ['A/B=Deals ~Unclosed damage', ''].join(NL)
    const list = await provider.diagnostics!(request(text))
    const malformed = list.diagnostics.find(item => item.code === 'malformed-markup')
    expect(malformed).toBeDefined()
    expect(malformed!.range.start.character).toBeGreaterThanOrEqual('A/B='.length)
    expect(malformed!.message).toMatch(/Unclosed runtime token/u)
  })

  it('does not invent a rule the format does not have', async () => {
    // `<d …>` without a slash is accepted by the game and by MK2; the old adapter rejected it.
    const list = await provider.diagnostics!(request(['A/B=<d ref="X,Y,Z">', ''].join(NL)))
    expect(list.diagnostics).toEqual([])
  })

  it('checks catalog references only when a GameData snapshot is available', async () => {
    const text = ['A/B=<d ref="Effect,Foo,Amount"/>', 'A/C=<d ref="Effect,Missing,Amount"/>'].join(NL)
    const data = workspaceDocument(
      '<Catalog><CEffect id="Foo"><Amount value="25"/></CEffect></Catalog>',
      'memory://EffectData.xml',
    )
    const withoutCatalog = await provider.diagnostics!(request(text))
    expect(withoutCatalog.diagnostics).toEqual([])

    const withCatalog = await provider.diagnostics!(
      request(text, {
        workspaceDocuments: [{ ...data, languageId: 'sc2-data' }],
        workspaceIncomplete: false,
      }),
    )
    expect(withCatalog.diagnostics).toHaveLength(1)
    expect(withCatalog.diagnostics[0]).toMatchObject({ code: 'broken-ref' })
    expect(withCatalog.diagnostics[0]?.range.start.line).toBe(1)
  })
})

describe('sc2-strings completion and hover', () => {
  it('offers markup tags inside a value', async () => {
    const text = ['A/B=<', ''].join(NL)
    const list = await provider.completion!(
      request(text, { position: { line: 0, character: 'A/B=<'.length } }),
    )
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.some(item => item.kind === 'keyword')).toBe(true)
  })

  it('completes the key when the caret is left of the separator', async () => {
    const list = await provider.completion!(
      request(DOCUMENT, { position: { line: 1, character: 4 } }),
    )
    // Whatever it offers here, it must not be markup tags: those are not legal in a key.
    expect(list.items.every(item => item.kind !== 'keyword')).toBe(true)
  })

  it('describes the tag under the caret, and nothing where there is no tag', async () => {
    const text = ['A/B=<d ref="X,Y,Z"/>', ''].join(NL)
    // The tag name is the single character after `<`, so the caret sits on it, not past it.
    const onTag = await provider.hover!(
      request(text, { position: { line: 0, character: 'A/B=<'.length } }),
    )
    expect(onTag?.markdown).toMatch(/\*\*/u)
    const onPlainText = await provider.hover!(
      request(DOCUMENT, { position: { line: 1, character: 20 } }),
    )
    expect(onPlainText).toBeUndefined()
  })

  it('answers with the value when the caret is on the key', async () => {
    const text = ['UI/Ok=OK', ''].join(NL)
    const other = { uri: 'memory://dede/GameStrings.txt', languageId: 'sc2-strings', version: 1,
      text: ['UI/Ok=Gut', ''].join(NL) }
    const hover = await provider.hover!(
      request(text, { position: { line: 0, character: 2 }, workspaceDocuments: [other] }),
    )
    expect(hover?.markdown).toContain('**UI/Ok**')
    expect(hover?.markdown).toContain('OK')
    expect(hover?.markdown).toContain('1 other catalog')
  })

  // Parity plan 4.7: `<img path="@@` offers the aliases the snapshot's Assets.txt declares.
  it('checks the hotkeys of GameHotkeys.txt, and only there (plan 4.10)', async () => {
    const text = ['Button/Hotkey/Attack=Q,NotAKey', ''].join(NL)
    const at = (uri: string) =>
      provider.diagnostics!({ ...request(text), document: { uri, languageId: 'sc2-strings', version: 1, text } } as never)
    const hotkeys = await at('memory://mod/Base.SC2Data/GameHotkeys.txt')
    expect(hotkeys.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid-hotkey', severity: 'error', message: 'Unknown hotkey value "NotAKey"' }),
    ])
    expect((await at('memory://mod/enUS.SC2Data/LocalizedData/GameStrings.txt')).diagnostics).toEqual([])
  })

  it('completes an image path with the aliases of Assets.txt', async () => {
    const text = ['Button/Tooltip/X=<img path="@@"/>', ''].join(NL)
    const assets = workspaceDocument('UI/HeroIcon=Assets\\Textures\\btn-hero.dds\nUI/Gold=Assets\\Textures\\gold.dds\n', 'memory://Base.SC2Data/Assets.txt')
    const list = await provider.completion!(
      request(text, {
        position: { line: 0, character: 'Button/Tooltip/X=<img path="@@'.length },
        workspaceDocuments: [assets],
      }),
    )
    expect(list.items.map(item => item.label)).toEqual(expect.arrayContaining(['UI/HeroIcon', 'UI/Gold']))
    // The picture is the path the alias names; the host draws it when the item is resolved.
    expect(list.items.find(item => item.label === 'UI/Gold')).toMatchObject({
      insertText: '@@UI/Gold',
      asset: { path: 'Assets\\Textures\\gold.dds' },
    })
  })

  // The window's case: VS Code closes the quote but not the tag, the file is CRLF in GameData.
  it('completes aliases inside an unclosed img tag from a CRLF GameData/Assets.txt', async () => {
    const text = ['Test/Alias=<img path="@@"', ''].join(NL)
    const assets = workspaceDocument(
      '// asset aliases = pictures\r\nWhite=Assets\\Textures\\white32.dds\r\nUI/W3C_EquipSelect_Masks=Assets\\Textures\\masks.dds\r\n',
      'file:///c%3A/MKTEMP/sc2-test-mods/WarCoopDataTest.SC2Mod/base.sc2data/GameData/Assets.txt',
    )
    const list = await provider.completion!(
      request(text, {
        position: { line: 0, character: 'Test/Alias=<img path="@@'.length },
        workspaceDocuments: [assets],
      }),
    )
    expect(list.items.map(item => item.label)).toEqual(['UI/W3C_EquipSelect_Masks', 'White'])
  })

  it('offers nothing for a line that holds no entry', async () => {
    const list = await provider.completion!(
      request(DOCUMENT, { position: { line: 0, character: 3 } }),
    )
    expect(list.items).toEqual([])
  })

  it('shows a computed catalog value from an explicit GameData snapshot', async () => {
    const text = ['A/B=<d ref="Effect,Foo,Amount"/>', ''].join(NL)
    const data = workspaceDocument(
      '<Catalog><CEffect id="Foo"><Amount value="25"/></CEffect></Catalog>',
      'memory://EffectData.xml',
    )
    const hover = await provider.hover!(
      request(text, {
        position: { line: 0, character: 'A/B=<d ref="Effect,F'.length },
        workspaceDocuments: [{ ...data, languageId: 'sc2-data' }],
        workspaceIncomplete: false,
      }),
    )
    expect(hover?.markdown).toContain('Value: `25`')
  })
})

describe('sc2-strings symbols', () => {
  it('lists every entry key, selecting the key rather than the whole line', async () => {
    const list = await provider.documentSymbols!(request(DOCUMENT))
    expect(list.symbols.map(symbol => symbol.name)).toEqual([
      'Unit/Name/Marine',
      'Button/Tooltip/Attack',
    ])
    expect(list.symbols[0]?.selectionRange.end.character).toBe('Unit/Name/Marine'.length)
  })
})

describe('sc2-strings colours', () => {
  it('reports literal and FontStyles named colours at their exact value ranges', async () => {
    const text = [
      'A/B=<c val="ff000080">literal</c>',
      'A/C=<c val="#ColorAttackInfo">named</c>',
      '',
    ].join(NL)
    const style = {
      uri: 'memory://UI/FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile><Constant name="ColorAttackInfo" val="00ff00"/></StyleFile>',
    }
    const result = await provider.documentColors(
      request(text, { workspaceDocuments: [style], workspaceIncomplete: false }),
    )
    expect(result.colors).toHaveLength(2)
    expect(result.colors.map(item => item.color)).toEqual([
      { red: 1, green: 0, blue: 0, alpha: 128 / 255 },
      { red: 0, green: 1, blue: 0, alpha: 1 },
    ])
    expect(
      text
        .split(NL)[1]!
        .slice(result.colors[1]!.range.start.character, result.colors[1]!.range.end.character),
    ).toBe('#ColorAttackInfo')
  })

  /*
   * A FontStyles constant is written the way layouts and style sheets write colours: eight digits
   * are AARRGGBB and four decimals are A,R,G,B (Blizzard's `ColorStoryModePanelLabelDim="807de5e9"`
   * is a half-transparent 7de5e9). Read as markup it came out red and nearly opaque (parity plan 4.4).
   */
  it('reads a half-transparent FontStyles colour in the style sheet channel order', async () => {
    const text = ['A/B=<c val="#Dim">dim</c>', 'A/C=<c val="#Faint">faint</c>', ''].join(NL)
    const style = {
      uri: 'memory://UI/FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile><Constant name="Dim" val="807de5e9"/><Constant name="Faint" val="64,255,0,0"/></StyleFile>',
    }
    const result = await provider.documentColors(
      request(text, { workspaceDocuments: [style], workspaceIncomplete: false }),
    )
    expect(result.colors.map(item => item.color)).toEqual([
      { red: 0x7d / 255, green: 0xe5 / 255, blue: 0xe9 / 255, alpha: 0x80 / 255 },
      { red: 1, green: 0, blue: 0, alpha: 64 / 255 },
    ])
  })

  it('preserves six versus eight digit presentation width', async () => {
    const text = 'A/B=<c val="ff000080">literal</c>'
    const range = { start: { line: 0, character: 12 }, end: { line: 0, character: 20 } }
    const result = await provider.colorPresentations(
      request(text, {
        range,
        color: { red: 0, green: 0.5, blue: 1, alpha: 0.25 },
      }),
    )
    expect(result.presentations).toEqual([{ label: '0080ff40' }])
  })
})

/*
 * The catalog end of String ↔ Style ↔ Layout. A caret on `<s val>` or `<c val>` is on a name the
 * style sheet declares; it must reach the same declaration, uses and rename edits the Style provider
 * computes from the sheet — and a caret on the key must still be a key.
 */
describe('sc2-strings style-sheet names', () => {
  const CATALOG = 'Unit/Name/Marine=<s val="Title">A</s> <c val="#ColorTitle">B</c> <s val="Title">C</s>\n'
  const SHEET = {
    uri: 'memory://UI/FontStyles.SC2Style',
    languageId: 'sc2-style',
    version: 4,
    text: '<StyleFile>\n<Constant name="ColorTitle" val="ffcc00"/>\n<Style name="Title" textcolor="#ColorTitle"/>\n</StyleFile>\n',
  }
  const LAYOUT = {
    uri: 'memory://UI/Layout/Hud.SC2Layout',
    languageId: 'sc2-layout',
    version: 6,
    text: '<Desc>\n<Frame type="Label" name="Title">\n<Style val="@Title"/>\n</Frame>\n</Desc>\n',
  }
  const onStyle = { line: 0, character: CATALOG.indexOf('Title') + 2 }
  const onConstant = { line: 0, character: CATALOG.indexOf('#ColorTitle') }
  const complete = (extra: Record<string, unknown>) =>
    request(CATALOG, {
      workspaceDocuments: [SHEET, LAYOUT],
      workspaceIncomplete: false,
      maxDocuments: 8,
      ...extra,
    })
  const at = (text: string, needle: string, nth = 0) => {
    let offset = -1
    for (let index = 0; index <= nth; index += 1) offset = text.indexOf(needle, offset + 1)
    const before = text.slice(0, offset).split(NL)
    const start = { line: before.length - 1, character: before.at(-1)!.length }
    return { start, end: { line: start.line, character: start.character + needle.length } }
  }

  it('goes from <s val> and <c val="#…"> to the declaration in the style sheet', async () => {
    const style = await provider.definition!(complete({ position: onStyle }))
    expect(style.locations).toEqual([{ uri: SHEET.uri, range: at(SHEET.text, 'Title', 1) }])
    const constant = await provider.definition!(complete({ position: onConstant }))
    expect(constant.locations).toEqual([{ uri: SHEET.uri, range: at(SHEET.text, 'ColorTitle') }])
    expect(constant.isIncomplete).toBe(false)
  })

  it('lists catalog and layout uses of a style, but not a frame that shares its name', async () => {
    const uses = await provider.references!(complete({ position: onStyle, includeDeclaration: false }))
    expect(uses.locations).toEqual([
      { uri: 'memory://GameStrings.txt', range: at(CATALOG, 'Title', 0) },
      { uri: 'memory://GameStrings.txt', range: at(CATALOG, 'Title', 2) },
      { uri: LAYOUT.uri, range: at(LAYOUT.text, 'Title', 1) },
    ])
  })

  it('renames a style from the catalog in the sheet, every catalog use and the layout', async () => {
    const prepared = await provider.prepareRename!(complete({ position: onStyle }))
    expect(prepared).toEqual({ range: at(CATALOG, 'Title', 0), placeholder: 'Title' })
    const edit = await provider.rename!(
      complete({ position: onStyle, newName: 'Heading', maxEdits: 10 }),
    )
    expect(
      edit?.documentChanges.map(change => [change.uri, change.documentVersion, change.edits.length]),
    ).toEqual([
      // Declaring sheets first, then the users in snapshot order.
      [SHEET.uri, 4, 1],
      ['memory://GameStrings.txt', 1, 2],
      [LAYOUT.uri, 6, 1],
    ])

    const primaryOnly = await provider.rename!(
      request(CATALOG, {
        position: onStyle,
        workspaceDocuments: [SHEET, LAYOUT],
        workspaceIncomplete: true,
        maxDocuments: 8,
        newName: 'Heading',
        maxEdits: 10,
      }),
    )
    expect(primaryOnly).toBeUndefined()
  })

  it('still treats the key as a string key', async () => {
    const prepared = await provider.prepareRename!(complete({ position: { line: 0, character: 3 } }))
    expect(prepared?.placeholder).toBe('Unit/Name/Marine')
  })
})

describe('sc2-strings bounded workspace navigation', () => {
  const ENGLISH = [
    'Unit/Name/Marine=Marine',
    'Button/Tooltip/Train=Build <d stringref="Unit,Marine,Name"/>',
    '',
  ].join(NL)
  const GERMAN = ['Unit/Name/Marine=Marineinfanterist', ''].join(NL)
  const german = workspaceDocument(GERMAN, 'memory://deDE/GameStrings.txt')
  const onKey = { line: 0, character: 6 }
  const onReference = {
    line: 1,
    character: 'Button/Tooltip/Train=Build <d stringref="Unit,'.length + 2,
  }

  it('resolves a key to every locale definition in the supplied snapshot', async () => {
    const result = await provider.definition!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german],
        workspaceIncomplete: false,
      }),
    )
    expect(result.locations.map(location => location.uri)).toEqual([
      'memory://GameStrings.txt',
      german.uri,
    ])
    expect(result.isIncomplete).toBe(false)
  })

  it('resolves a stringref to its GameData entity, preserving MK2 navigation semantics', async () => {
    const data = workspaceDocument(
      '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit></Catalog>',
      'memory://UnitData.xml',
    )
    const result = await provider.definition!(
      request(ENGLISH, {
        position: onReference,
        workspaceDocuments: [{ ...data, languageId: 'sc2-data' }],
        workspaceIncomplete: false,
      }),
    )
    expect(result.locations).toHaveLength(1)
    expect(result.locations[0]?.uri).toBe(data.uri)
    const id = data.text.split(NL)[0]!.slice(
      result.locations[0]!.range.start.character,
      result.locations[0]!.range.end.character,
    )
    expect(id).toBe('Marine')
  })

  it('uses the Data schema namespace for subclass references', async () => {
    const text = 'Button/Tooltip/Train=<d stringref="Abil,TrainMarine,Name"/>'
    const data = {
      uri: 'memory://AbilData.xml',
      languageId: 'sc2-data',
      version: 1,
      text: '<Catalog><CAbilTrain id="TrainMarine"/></Catalog>',
    }
    const result = await provider.definition!(request(text, {
      position: { line: 0, character: text.indexOf('TrainMarine') + 2 },
      workspaceDocuments: [data],
      workspaceIncomplete: false,
    }))
    expect(result.locations).toHaveLength(1)
    expect(result.locations[0]?.uri).toBe(data.uri)
    expect(data.text.slice(
      result.locations[0]!.range.start.character,
      result.locations[0]!.range.end.character,
    )).toBe('TrainMarine')
  })

  it('finds stringref uses and includes declarations only when requested', async () => {
    const uses = await provider.references!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german],
        workspaceIncomplete: false,
        includeDeclaration: false,
      }),
    )
    expect(uses.locations).toHaveLength(1)
    expect(uses.locations[0]?.range.start.line).toBe(1)

    const all = await provider.references!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german],
        workspaceIncomplete: false,
        includeDeclaration: true,
      }),
    )
    expect(all.locations).toHaveLength(3)
  })

  it('prepares and performs an atomic key rename across locales and stringrefs', async () => {
    const prepared = await provider.prepareRename!(
      request(ENGLISH, { position: onReference }),
    )
    expect(prepared?.placeholder).toBe('Unit/Name/Marine')
    const line = ENGLISH.split(NL)[1]!
    expect(line.slice(prepared!.range.start.character, prepared!.range.end.character)).toBe(
      'Unit,Marine,Name',
    )

    const edit = await provider.rename!(
      request(ENGLISH, {
        position: onReference,
        workspaceDocuments: [german],
        workspaceIncomplete: false,
        newName: 'Unit/Name/MarineElite',
        maxEdits: 10,
      }),
    )
    expect(edit?.isComplete).toBe(true)
    expect(edit?.documentChanges.flatMap(change => change.edits)).toHaveLength(3)
    expect(
      edit?.documentChanges
        .flatMap(change => change.edits)
        .map(change => change.newText),
    ).toEqual(['Unit/Name/MarineElite', 'Unit,MarineElite,Name', 'Unit/Name/MarineElite'])
  })

  /*
   * A layout names a key as `<Text val="@Key">`; a key rename that stopped at the catalogs would
   * leave the frame showing a key that no longer exists.
   */
  it('includes layout Text uses of a key in references and a complete rename', async () => {
    const layout = {
      uri: 'memory://UI/Layout/Hud.SC2Layout',
      languageId: 'sc2-layout',
      version: 9,
      text: '<Desc>\n<Frame type="Label" name="L">\n<Text val="@Unit/Name/Marine"/>\n<Tooltip val="Unit/Name/Marine"/>\n</Frame>\n</Desc>\n',
    }
    const uses = await provider.references!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german, layout],
        workspaceIncomplete: false,
        maxDocuments: 4,
        includeDeclaration: false,
      }),
    )
    expect(uses.locations.map(item => [item.uri, item.range.start.line])).toEqual([
      ['memory://GameStrings.txt', 1],
      [layout.uri, 2],
    ])

    const edit = await provider.rename!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german, layout],
        workspaceIncomplete: false,
        maxDocuments: 4,
        newName: 'Unit/Name/MarineElite',
        maxEdits: 10,
      }),
    )
    const layoutChange = edit?.documentChanges.find(change => change.uri === layout.uri)
    expect(layoutChange?.documentVersion).toBe(9)
    expect(layoutChange?.edits).toEqual([
      {
        range: {
          start: { line: 2, character: '<Text val="@'.length },
          end: { line: 2, character: '<Text val="@Unit/Name/Marine'.length },
        },
        newText: 'Unit/Name/MarineElite',
      },
    ])
  })

  it('refuses a partial or over-budget workspace rename', async () => {
    const incomplete = await provider.rename!(
      request(ENGLISH, {
        position: onKey,
        workspaceIncomplete: true,
        newName: 'Unit/Name/MarineElite',
        maxEdits: 10,
      }),
    )
    expect(incomplete).toBeUndefined()

    const overBudget = await provider.rename!(
      request(ENGLISH, {
        position: onKey,
        workspaceDocuments: [german],
        workspaceIncomplete: false,
        newName: 'Unit/Name/MarineElite',
        maxEdits: 2,
      }),
    )
    expect(overBudget).toBeUndefined()
  })

  it('returns fuzzy workspace symbols and reports a partial snapshot', async () => {
    const result = await provider.workspaceSymbols!(
      request(ENGLISH, {
        query: 'unmr',
        workspaceDocuments: [german],
        workspaceIncomplete: true,
      }),
    )
    expect(result.symbols.map(symbol => symbol.name)).toEqual([
      'Unit/Name/Marine',
      'Unit/Name/Marine',
    ])
    expect(result.isIncomplete).toBe(true)
  })
})
