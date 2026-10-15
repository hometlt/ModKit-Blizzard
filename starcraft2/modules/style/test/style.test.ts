/**
 * The style-sheet module: its manifests, what it refuses to accept, and what it writes.
 *
 * The format's vocabulary was already in MK3 — `parseFontStyles`, carried over unchanged — and was
 * read only by other languages. What is new here is the checking and the surfaces, so what is worth
 * pinning is the part that could be wrong: the rules that decide whether a real style sheet is
 * clean, and the byte range one edit touches.
 *
 * Two of these tests exist because the first version of the rules failed them. Blizzard's own sheets
 * spell attributes in mixed case and give colours as gradients, and a checker that reports either as
 * a defect is worse than no checker: a reader learns to ignore it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec } from '../codecs/style/src/codec.js'
import { codec as authoredCodec } from '../codecs/style/src/define.js'
import { createSc2StyleLanguageProvider, styleColorProblem } from '../providers/language/src/language.js'

const NL = '\n'
const encoder = new TextEncoder()

const SHEET = [
  '<StyleFile>',
  '    <Constant name="ColorTitle" val="ffcc00"/>',
  '    <Constant name="ColorEcho" val="#ColorTitle"/>',
  '    <FontGroup name="Standard">',
  '        <CodepointRange font="UI\\Fonts\\Base.ttf"/>',
  '    </FontGroup>',
  '    <Style name="Base" font="#Standard" height="16" textcolor="#ColorTitle"/>',
  '    <Style name="Title" template="Base" height="24" styleflags="Shadow | Bold"/>',
  '</StyleFile>',
  '',
].join(NL)

const provider = createSc2StyleLanguageProvider()

function request(text: string, workspace: readonly string[] = []) {
  return {
    document: { uri: 'memory://FontStyles.SC2Style', languageId: 'sc2-style', version: 1, text },
    workspaceDocuments: workspace.map((item, index) => ({
      uri: `memory://dep-${index}.SC2Style`,
      languageId: 'sc2-style',
      version: 1,
      text: item,
    })),
    workspaceIncomplete: true,
    maxResults: 200,
    maxDocuments: 8,
  } as never
}

async function findings(text: string, workspace: readonly string[] = []) {
  const result = await provider.diagnostics!(request(text, workspace))
  return result.diagnostics.map(item => `${item.severity} ${item.code}: ${item.message}`)
}

async function completionAt(text: string, line: number, character: number) {
  const result = await provider.completion!({
    ...(request(text) as object),
    position: { line, character },
  } as never)
  return result.items.map(item => item.label)
}

describe('sc2-style language', () => {
  // Parity plan 4.1: a style's name shows a sample in its colour and size, its template resolved.
  it('hovers a style name with a sample of the style', async () => {
    const sheet = '<StyleFile>\n    <Style name="Base" textcolor="ff0000" height="20"/>\n    <Style name="Title" template="Base"/>\n</StyleFile>\n'
    const hover = await provider.hover!({
      ...(request(sheet) as object),
      position: { line: 2, character: '    <Style name="Ti'.length },
    } as never)
    const image = /\(data:image\/svg\+xml,([^)]+)\)/u.exec(hover?.markdown ?? '')?.[1]
    expect(decodeURIComponent(image ?? '')).toContain('color:#ff0000;font-size:20px')
    // Plan 4.3: the attributes it ends up with, its template's merged in.
    expect(hover?.markdown).toContain('`textcolor="ff0000"`')
    expect(hover?.markdown).toContain('`height="20"`')
  })

  it('hovers a template from another sheet with its attributes merged along its chain (plan 4.3)', async () => {
    const own = '<StyleFile>\n    <Style name="Mine" template="CoreTitle"/>\n</StyleFile>\n'
    const core = {
      uri: 'file:///Mods/Core.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile>\n    <Style name="CoreBase" height="18" textcolor="ffffff"/>\n    <Style name="CoreTitle" template="CoreBase" height="24"/>\n</StyleFile>\n',
    }
    const hover = await provider.hover!({
      ...(request(own) as object),
      workspaceDocuments: [core],
      position: { line: 1, character: '    <Style name="Mine" template="Core'.length },
    } as never)
    expect(hover?.markdown).toContain('`height="24"`')
    expect(hover?.markdown).toContain('`textcolor="ffffff"`')
  })

  // Parity plan 4.2: references complete from every sheet of the snapshot, over the whole value.
  it('completes templates and constants from every style sheet of the snapshot', async () => {
    const own = '<StyleFile>\n    <Style name="Mine" template=""/>\n    <Style name="Tinted" textcolor="#"/>\n</StyleFile>\n'
    const other = {
      uri: 'file:///Mods/Core.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile>\n    <Constant name="ColorGold" val="ffd700"/>\n    <Style name="CoreTitle"/>\n</StyleFile>\n',
    }
    const at = async (line: number, character: number) =>
      (
        await provider.completion!({
          ...(request(own) as object),
          workspaceDocuments: [{ uri: 'file:///probe.SC2Style', languageId: 'sc2-style', version: 1, text: own }, other],
          position: { line, character },
        } as never)
      ).items
    const templates = await at(1, '    <Style name="Mine" template="'.length)
    expect(templates).toContainEqual(expect.objectContaining({ label: 'CoreTitle', detail: 'style in UI/FontStyles.SC2Style' }))
    expect(templates).toContainEqual(expect.objectContaining({ label: 'Mine', detail: 'style in this file' }))
    const colours = await at(2, '    <Style name="Tinted" textcolor="#'.length)
    expect(colours).toContainEqual(
      expect.objectContaining({
        label: '#ColorGold',
        detail: 'ffd700 (UI/FontStyles.SC2Style)',
        replacementRange: { start: { line: 2, character: 36 }, end: { line: 2, character: 37 } },
      }),
    )
  })

  it('accepts a well-formed sheet without inventing findings', async () => {
    expect(await findings(SHEET)).toEqual([])
  })

  /*
   * The case rule. `textColor` and `textcolor` are the same attribute to the game and appear in the
   * same shipped file; a case-sensitive table turns hundreds of valid lines into warnings.
   */
  it('treats attribute names as case-insensitive, the way the game does', async () => {
    const mixed = SHEET.replace('textcolor="#ColorTitle"', 'textColor="#ColorTitle"')
    expect(await findings(mixed)).toEqual([])
  })

  /*
   * Blizzard's core FontStyles declares `<style name="SilencePenaltyTimer" …>` in lower case, and
   * the game loads it. Element names are case-insensitive, like attribute names.
   */
  it('treats element names as case-insensitive, the way the game does', async () => {
    const lower = SHEET.replace('<Style name="Title" template="Base"', '<style name="Title" template="Base"')
    expect(await findings(lower)).toEqual([])
    const symbols = await provider.documentSymbols!(request(lower))
    expect(symbols.symbols.map(item => item.name)).toContain('Title')
  })

  it('bounds completion by the request', async () => {
    const lines = SHEET.split(NL)
    const template = lines.map((line, index) => (index === 7 ? '    <Style name="X" template="' : line)).join(NL)
    const result = await provider.completion!({
      ...(request(template) as object),
      maxResults: 1,
      position: { line: 7, character: '    <Style name="X" template="'.length },
    } as never)
    expect(result.items).toHaveLength(1)
    expect(result.isIncomplete).toBe(true)
  })

  it('accepts every colour form the format has, including a gradient', () => {
    expect(styleColorProblem('ffcc00')).toBeUndefined()
    expect(styleColorProblem('ffcc0080')).toBeUndefined()
    expect(styleColorProblem('255,255,0')).toBeUndefined()
    expect(styleColorProblem('255,255,0,0')).toBeUndefined()
    expect(styleColorProblem('#ColorTitle')).toBeUndefined()
    expect(styleColorProblem('255,255,0,0 - 255,0,0,0')).toBeUndefined()
    expect(styleColorProblem('fffdf4-ffdb8e')).toBeUndefined()
    expect(styleColorProblem('not-a-colour')).toMatch(/Not a colour/u)
  })

  it('reports a reference that resolves nowhere, and stops once a dependency declares it', async () => {
    const orphan = SHEET.replace('template="Base"', 'template="Missing"')
    expect(await findings(orphan)).toEqual([
      expect.stringContaining('unresolved-template') as unknown as string,
    ])
    const dependency = '<StyleFile><Style name="Missing" height="10"/></StyleFile>'
    expect(await findings(orphan, [dependency])).toEqual([])
  })

  /*
   * A duplicate name is legal and almost always a mistake: the sheet is merged by name and the last
   * declaration wins, so the first one is silently discarded.
   */
  it('warns about a name declared twice, because the earlier one is discarded', async () => {
    const twice = SHEET.replace(
      '<Style name="Title" template="Base"',
      '<Style name="Base" height="8"/>' + NL + '    <Style name="Title" template="Base"',
    )
    expect(await findings(twice)).toEqual([
      expect.stringContaining('duplicate-name') as unknown as string,
    ])
  })

  it('rejects an element the format cannot contain, and one in the wrong parent', async () => {
    const wrong = SHEET.replace(
      '<Style name="Base"',
      '<Constant name="Inner" val="1"/>' + NL + '    <Style name="Base"',
    ).replace('<CodepointRange font="UI\\Fonts\\Base.ttf"/>', '<Style name="Nested" height="4"/>')
    const reported = await findings(wrong)
    expect(reported.some(item => item.includes('misplaced-element'))).toBe(true)
  })

  it('offers only the elements and attributes that belong where the caret is', async () => {
    const lines = SHEET.split(NL)
    const inFile = [...lines.slice(0, 6), '    <', ...lines.slice(6)].join(NL)
    expect(await completionAt(inFile, 6, 5)).toEqual(['Constant', 'FontGroup', 'Style'])

    const inGroup = lines
      .map((line, index) => (index === 4 ? '        <' : line))
      .join(NL)
    expect(await completionAt(inGroup, 4, 9)).toEqual(['CodepointRange'])

    const attributes = lines.map((line, index) => (index === 6 ? '    <Style ' : line)).join(NL)
    expect(await completionAt(attributes, 6, 11)).toContain('template')
    expect(await completionAt(attributes, 6, 11)).toContain('textcolor')
  })

  /*
   * The list is what the buffer declares *now*, including the half-typed declaration the caret is
   * in — replacing the `Title` line takes `Title` out of it, which is the behaviour a reader wants
   * and the reason this asserts the exact list rather than a superset.
   */
  it('answers a reference with the names this sheet actually declares', async () => {
    const lines = SHEET.split(NL)
    const template = lines
      .map((line, index) => (index === 7 ? '    <Style name="X" template="' : line))
      .join(NL)
    expect(await completionAt(template, 7, '    <Style name="X" template="'.length)).toEqual([
      'Base',
      'X',
    ])

    const colour = lines
      .map((line, index) => (index === 7 ? '    <Style name="X" textcolor="' : line))
      .join(NL)
    expect(await completionAt(colour, 7, '    <Style name="X" textcolor="'.length)).toEqual([
      '#ColorEcho',
      '#ColorTitle',
    ])
  })

  it('resolves a constant on hover, following the chain to a literal', async () => {
    const lines = SHEET.split(NL)
    const line = lines.findIndex(item => item.includes('textcolor="#ColorTitle"'))
    const hover = await provider.hover!({
      ...(request(SHEET) as object),
      position: { line, character: lines[line]!.indexOf('#ColorTitle') + 3 },
    } as never)
    expect(hover?.markdown).toContain('ColorTitle')
    expect(hover?.markdown).toContain('ffcc00')
  })

  it('names the font file under the caret, directly or through a constant, for the host to draw', async () => {
    const sheet = [
      '<StyleFile>',
      '    <Constant name="FontHeader" val="UI\\Fonts\\Eurostile-Bol.otf"/>',
      '    <Style name="Title" font="#FontHeader"/>',
      '    <Style name="Body" font="UI\\Fonts\\Eurostile-Reg.otf"/>',
      '</StyleFile>',
    ].join(NL)
    const lines = sheet.split(NL)
    const hoverAt = (needle: string, into: number) => {
      const line = lines.findIndex(item => item.includes(needle))
      return provider.hover!({
        ...(request(sheet) as object),
        position: { line, character: lines[line]!.indexOf(needle) + into },
      } as never)
    }
    expect((await hoverAt('#FontHeader', 3))?.assets).toEqual([{ path: 'UI\\Fonts\\Eurostile-Bol.otf' }])
    expect((await hoverAt('Eurostile-Reg', 3))?.assets).toEqual([{ path: 'UI\\Fonts\\Eurostile-Reg.otf' }])
  })
})

/*
 * Navigation and edits. What these pin is the part a text search gets wrong: the same spelling as a
 * Style and as a Constant are different names, a catalog line may use a name several times, a
 * `#` is not part of the name, and an incomplete workspace must never be edited as if it were whole.
 */
describe('sc2-style navigation, rename and source surfaces', () => {
  const PRIMARY = 'memory://mod/FontStyles.SC2Style'
  const DEPENDENCY = 'memory://dep/FontStyles.SC2Style'
  const CATALOG = 'memory://mod/GameStrings.txt'

  const MOD_SHEET = [
    '<StyleFile>',
    '    <Constant name="ColorTitle" val="ffcc00"/>',
    '    <Constant name="FontMain" val="Standard"/>',
    '    <FontGroup name="Standard">',
    '        <CodepointRange font="#FontPath"/>',
    '    </FontGroup>',
    '    <Style name="Base" font="#FontMain" textcolor="#ColorTitle-#ColorTitle" height="16"/>',
    '    <Style name="Title" template="Base" hjustify="Center" glowcolor="807de5e9"/>',
    '</StyleFile>',
    '',
  ].join(NL)
  // A Constant spelled like the Style: renaming the Style must leave it alone.
  const DEPENDENCY_SHEET = [
    '<StyleFile>',
    '    <Constant name="Base" val="190,245,140,70"/>',
    '    <Constant name="FontPath" val="UI\\Fonts\\Base.ttf"/>',
    '    <Style name="Base" height="10"/>',
    '    <Style name="Deep" template="Base" textcolor="#Base"/>',
    '</StyleFile>',
    '',
  ].join(NL)
  const CATALOG_TEXT = [
    '// <s val="Base"> in a comment is not a use',
    'Unit/Name/Marine=<s val="Base">A</s> and <s val="Base">B</s> <c val="#ColorTitle">C</c><c val="ffcc00">D</c>',
    '',
  ].join(NL)

  function snapshot(options: { incomplete?: boolean; primary?: string } = {}) {
    const primary = { uri: PRIMARY, languageId: 'sc2-style', version: 3, text: options.primary ?? MOD_SHEET }
    return {
      document: primary,
      workspaceDocuments: [
        primary,
        { uri: DEPENDENCY, languageId: 'sc2-style', version: 5, text: DEPENDENCY_SHEET },
        { uri: CATALOG, languageId: 'sc2-strings', version: 7, text: CATALOG_TEXT },
      ],
      workspaceIncomplete: options.incomplete ?? false,
      maxResults: 200,
      maxDocuments: 8,
    }
  }

  /** The position of the `delta`th character of the `nth` occurrence of `needle`. */
  function at(text: string, needle: string, delta = 0, nth = 0) {
    let offset = -1
    for (let index = 0; index <= nth; index += 1) offset = text.indexOf(needle, offset + 1)
    if (offset < 0) throw new Error(`fixture has no ${needle}`)
    const before = text.slice(0, offset + delta).split(NL)
    return { line: before.length - 1, character: before.at(-1)!.length }
  }

  function spanOf(text: string, needle: string, nth = 0) {
    const start = at(text, needle, 0, nth)
    return { start, end: { line: start.line, character: start.character + needle.length } }
  }

  const where = (list: { locations: readonly { uri: string; range: unknown }[] }) =>
    list.locations.map(item => ({ uri: item.uri, range: item.range }))

  it('asks the host for sheets and catalogs together, including its own language', () => {
    // A host rejects an opt-in that omits the primary language and sends sheets only.
    expect(provider.workspaceLanguageIds).toEqual(['sc2-style', 'sc2-strings', 'sc2-layout'])
  })

  /*
   * A layout applies styles in three schema-typed places, and Blizzard's layouts prefix the name
   * with `@`s. A complete rename that missed any of them would leave a frame pointing at a style
   * that no longer exists; a `#Name` is a layout constant and must not move.
   */
  it('finds Style uses in layouts but rejects an ambiguous declaration rename', async () => {
    const LAYOUT = 'memory://mod/Base.SC2Layout'
    const layoutText = [
      '<Desc>',
      '    <Frame type="Label" name="L">',
      '        <Style val="@@Base"/>',
      '        <Controller type="Style" style1="Base" style2="Title"/>',
      '        <Action type="SetProperty" frame="$this" Style="@Base"/>',
      '        <Action type="Other" style="Base"/>',
      '        <Style val="#Base"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const withLayout = () => {
      const base = snapshot()
      return {
        ...base,
        workspaceDocuments: [
          ...base.workspaceDocuments,
          { uri: LAYOUT, languageId: 'sc2-layout', version: 9, text: layoutText },
        ],
      }
    }
    const position = at(MOD_SHEET, 'name="Base"', 'name="'.length)
    const used = spanOf(layoutText, 'Base', 0)
    const references = await provider.references!({
      ...withLayout(),
      position,
      includeDeclaration: false,
    } as never)
    expect(where(references).filter(item => item.uri === LAYOUT)).toEqual([
      { uri: LAYOUT, range: used },
      { uri: LAYOUT, range: spanOf(layoutText, 'Base', 1) },
      { uri: LAYOUT, range: spanOf(layoutText, 'Base', 2) },
    ])
    const edit = await provider.rename!({
      ...withLayout(),
      position,
      newName: 'Heading',
      maxEdits: 50,
    } as never)
    expect(edit).toBeUndefined()
  })

  it('goes to every declaration of the typed name, including dependency sheets', async () => {
    const result = await provider.definition!({
      ...snapshot(),
      position: at(MOD_SHEET, 'template="Base"', 'template="'.length + 1),
    } as never)
    expect(where(result)).toEqual([
      { uri: PRIMARY, range: spanOf(MOD_SHEET, 'Base', 0) },
      // The dependency's Style Base — not its Constant Base, nor the `Base` inside a font path.
      { uri: DEPENDENCY, range: spanOf(DEPENDENCY_SHEET, 'Base', 2) },
    ])
    expect(result.isIncomplete).toBe(false)

    const incomplete = await provider.definition!({
      ...snapshot({ incomplete: true }),
      position: at(MOD_SHEET, 'template="Base"', 'template="'.length + 1),
    } as never)
    expect(incomplete.isIncomplete).toBe(true)

    const readOnlyComplete = await provider.definition!({
      ...snapshot({ incomplete: true }),
      workspaceContext: {
        id: 'resolved-mod',
        revision: 'resolved-mod:1',
        semanticComplete: true,
        documentOrigins: [],
      },
      position: at(MOD_SHEET, 'template="Base"', 'template="'.length + 1),
    } as never)
    expect(readOnlyComplete.isIncomplete).toBe(false)
  })

  it('resolves #Name to a Constant, and a bare FontGroup name only where one is declared', async () => {
    const constant = await provider.definition!({
      ...snapshot(),
      position: at(MOD_SHEET, '#FontMain'),
    } as never)
    expect(where(constant)).toEqual([{ uri: PRIMARY, range: spanOf(MOD_SHEET, 'FontMain') }])

    const group = await provider.definition!({
      ...snapshot(),
      position: at(MOD_SHEET, 'val="Standard"', 'val="'.length),
    } as never)
    expect(where(group)).toEqual([{ uri: PRIMARY, range: spanOf(MOD_SHEET, 'Standard', 1) }])

    const path = await provider.definition!({
      ...snapshot(),
      position: at(MOD_SHEET, '#FontPath', 1),
    } as never)
    expect(where(path)).toEqual([{ uri: DEPENDENCY, range: spanOf(DEPENDENCY_SHEET, 'FontPath') }])
  })

  it('lists every use, each catalog span separately, without crossing kinds', async () => {
    const styles = await provider.references!({
      ...snapshot(),
      position: at(MOD_SHEET, 'name="Base"', 'name="'.length),
      includeDeclaration: false,
    } as never)
    expect(where(styles)).toEqual([
      { uri: PRIMARY, range: spanOf(MOD_SHEET, 'Base', 1) },
      { uri: DEPENDENCY, range: spanOf(DEPENDENCY_SHEET, 'Base', 3) },
      { uri: CATALOG, range: spanOf(CATALOG_TEXT, 'Base', 1) },
      { uri: CATALOG, range: spanOf(CATALOG_TEXT, 'Base', 2) },
    ])

    const constants = await provider.references!({
      ...snapshot(),
      position: at(MOD_SHEET, 'name="ColorTitle"', 'name="'.length),
    } as never)
    expect(where(constants)).toEqual([
      { uri: PRIMARY, range: spanOf(MOD_SHEET, 'ColorTitle', 0) },
      { uri: PRIMARY, range: spanOf(MOD_SHEET, 'ColorTitle', 1) },
      { uri: PRIMARY, range: spanOf(MOD_SHEET, 'ColorTitle', 2) },
      { uri: CATALOG, range: spanOf(CATALOG_TEXT, 'ColorTitle') },
    ])
  })

  it('prepares a rename on the bare name, with the caret on its #', async () => {
    const lines = MOD_SHEET
    expect(
      await provider.prepareRename!({ ...snapshot(), position: at(lines, '#ColorTitle') } as never),
    ).toEqual({ range: spanOf(lines, 'ColorTitle', 1), placeholder: 'ColorTitle' })
    expect(
      await provider.prepareRename!({ ...snapshot(), position: at(lines, 'height="16"', 8) } as never),
    ).toBeUndefined()
  })

  it('rejects a rename when the same typed declaration exists in multiple sheets', async () => {
    const edit = await provider.rename!({
      ...snapshot(),
      position: at(MOD_SHEET, 'template="Base"', 'template="'.length),
      newName: 'Heading',
      maxEdits: 50,
    } as never)
    expect(edit).toBeUndefined()
  })

  it('rejects a global rename when the workspace is incomplete', async () => {
    const edit = await provider.rename!({
      ...snapshot({ incomplete: true }),
      position: at(MOD_SHEET, 'name="Standard"', 'name="'.length),
      newName: 'MainGroup',
      maxEdits: 50,
    } as never)
    expect(edit).toBeUndefined()
  })

  it('refuses a rename that would stop resolving or exceed its budget', async () => {
    const base = {
      ...snapshot(),
      position: at(MOD_SHEET, 'name="ColorTitle"', 'name="'.length),
      maxEdits: 50,
    }
    expect(await provider.rename!({ ...base, newName: 'Color-Title' } as never)).toBeUndefined()
    // Six hex digits read as a literal colour in a catalog, so the reference would vanish.
    expect(await provider.rename!({ ...base, newName: 'facade' } as never)).toBeUndefined()
    expect(await provider.rename!({ ...base, newName: 'ColorHead', maxEdits: 2 } as never)).toBeUndefined()
    expect(await provider.rename!({ ...base, newName: 'ColorHead' } as never)).toBeDefined()
  })

  it('shows one swatch per literal colour in AARRGGBB and A,R,G,B order, none on a reference', async () => {
    const mine = await provider.documentColors!(snapshot() as never)
    expect(mine.colors).toEqual([
      {
        range: spanOf(MOD_SHEET, 'ffcc00'),
        color: { red: 1, green: 0xcc / 255, blue: 0, alpha: 1 },
      },
      {
        range: spanOf(MOD_SHEET, '807de5e9'),
        color: { red: 0x7d / 255, green: 0xe5 / 255, blue: 0xe9 / 255, alpha: 0x80 / 255 },
      },
    ])

    const gradient = '<StyleFile><Style name="G" textcolor="ceedff - 190,245,140,70"/></StyleFile>'
    const colors = await provider.documentColors!({
      ...snapshot({ primary: gradient }),
      workspaceDocuments: [],
    } as never)
    expect(colors.colors).toEqual([
      { range: spanOf(gradient, 'ceedff'), color: { red: 0xce / 255, green: 0xed / 255, blue: 1, alpha: 1 } },
      {
        range: spanOf(gradient, '190,245,140,70'),
        color: { red: 245 / 255, green: 140 / 255, blue: 70 / 255, alpha: 190 / 255 },
      },
    ])
  })

  it('presents a picked colour in the notation the span already uses', async () => {
    const pick = { red: 1, green: 0, blue: 0, alpha: 0.5 }
    const hex = await provider.colorPresentations!({
      ...snapshot(),
      range: spanOf(MOD_SHEET, '807de5e9'),
      color: pick,
    } as never)
    expect(hex.presentations.map(item => item.label)).toEqual(['80ff0000', '128,255,0,0'])
    expect(hex.presentations[0]?.textEdit).toEqual({
      range: spanOf(MOD_SHEET, '807de5e9'),
      newText: '80ff0000',
    })
  })

  it('types tokens by what the value names', async () => {
    const analysis = await provider.analyze({ document: snapshot().document } as never)
    const token = (needle: string, nth = 0) =>
      analysis.tokens.find(item => JSON.stringify(item.range) === JSON.stringify(spanOf(MOD_SHEET, needle, nth)))?.kind
    expect(token('StyleFile', 0)).toBe('type')
    expect(token('Style', 1)).toBe('type')
    expect(token('template')).toBe('property')
    expect(token('Base', 1)).toBe('type')
    expect(token('FontMain', 1)).toBe('variable')
    expect(token('Standard', 0)).toBe('variable')
    expect(token('16')).toBe('number')
    expect(token('Center')).toBe('keyword')
    expect(token('807de5e9')).toBe('number')
    expect(token('ColorTitle', 1)).toBe('variable')
  })

  it('finds declarations by query across visible sheets, bounded', async () => {
    const found = await provider.workspaceSymbols!({ ...snapshot(), query: 'base' } as never)
    expect(found.symbols.map(item => `${item.kind} ${item.name} ${item.location.uri}`)).toEqual([
      `class Base ${PRIMARY}`,
      `constant Base ${DEPENDENCY}`,
      `class Base ${DEPENDENCY}`,
    ])
    expect(found.isIncomplete).toBe(false)
    const bounded = await provider.workspaceSymbols!({ ...snapshot(), query: '', maxResults: 2 } as never)
    expect(bounded.symbols).toHaveLength(2)
    expect(bounded.isIncomplete).toBe(true)
  })

  it('only ever changes the final newline, in the document’s own line endings', async () => {
    const crlf = '<StyleFile>\r\n</StyleFile>'
    const base = { ...snapshot({ primary: crlf }), workspaceDocuments: [] }
    const formatted = await provider.formatting!({
      ...base,
      options: { tabSize: 4, insertSpaces: true, finalNewline: true },
    } as never)
    expect(formatted.edits).toEqual([
      { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 12 } }, newText: '\r\n' },
    ])
    const untouched = await provider.formatting!({
      ...base,
      options: { tabSize: 4, insertSpaces: true },
    } as never)
    expect(untouched.edits).toEqual([])
    const actions = await provider.codeActions!({
      ...base,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      diagnostics: [],
      maxEdits: 4,
    } as never)
    expect(actions.actions.map(item => item.edit?.documentChanges[0]?.edits[0]?.newText)).toEqual(['\r\n'])
  })
})

describe('sc2-style codec', () => {
  it('keeps its codec and language manifests schema-valid', async () => {
    for (const name of ['codecs/style/codec.json', 'providers/language/provider.json']) {
      const manifest = JSON.parse(
        readFileSync(resolve(import.meta.dirname, '..', name), 'utf8'),
      )
      const validation = await validateContributionManifest(
        manifest,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(
        validation.specState,
        `${name}: ${JSON.stringify(validation.diagnostics, null, 2)}`,
      ).toBe('validated')
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('generates the codec operation inventory from the executable module', () => {
    expect(authoredCodec.contribution.operations.map(operation => operation.handlerId)).toEqual([
      'inspect', 'validate', 'export-raw', 'edit-field',
    ])
  })

  /*
   * A sheet saved with a UTF-8 byte order mark decodes without it, so offsets measured in the text
   * would land three bytes early and overwrite the wrong bytes on commit.
   */
  it.each([
    ['without a byte order mark', new Uint8Array()],
    ['with a UTF-8 byte order mark', Uint8Array.of(0xef, 0xbb, 0xbf)],
  ])('writes one attribute value and nothing else, %s', async (_label, prefix) => {
    const bytes = new Uint8Array([...prefix, ...encoder.encode(SHEET)])
    const uri = 'memory://FontStyles.SC2Style'
    const source = {
      kind: 'bytes' as const,
      ref: { id: uri, uri },
      revision: 'content-hash.sha256:fixture',
      size: BigInt(bytes.byteLength),
      async read(offset: bigint, length: number) {
        return bytes.slice(Number(offset), Number(offset) + length)
      },
      async *stream() {
        yield bytes
      },
    }
    const binding = {
      sourceKind: 'candidate',
      bindingId: 'content',
      role: 'content',
      ownership: 'owned',
      source: source.ref,
      revision: source.revision,
    }
    const input = {
      originKind: 'single',
      bindings: [binding],
      primaryBindingId: binding.bindingId,
      revisions: {
        topology: 'single',
        revision: source.revision,
        bindings: [{ bindingId: binding.bindingId, revision: source.revision }],
        compositionFingerprint: source.ref.id,
      },
      bindingsFor: () => [],
      async openBinding() {
        return { value: source, async release() {} }
      },
    } as never
    const budget = {
      maxInputBytes: 400_000_000n,
      maxDepth: 64,
      maxNodes: 100_000,
      maxScalarBytes: 104_857_600,
      maxDiagnostics: 1_000,
    } as never
    const context = {
      budgets: budget,
      diagnostics: { report: () => undefined },
      contracts: {
        async resolve() {
          throw new Error('no service dependency in this test')
        },
        async resolveUnknown() {
          throw new Error('no foreign service in this test')
        },
      },
    } as never

    const session = (await createCodec(context).open(input, 'inspect', budget)) as never as {
      operations(): { invoke(id: string, input: unknown): Promise<never> }
      dispose(): Promise<void>
    }
    try {
      const result = (await session.operations().invoke('edit-field', {
        path: ['Style', 'Title', 'height'],
        value: '48',
      })) as {
        state?: string
        output?: {
          plan?: {
            edits?: readonly {
              range?: { offset?: string; length?: string }
              payload?: { bytes?: unknown }
            }[]
          }
        }
      }
      expect(result.state).toBe('ok')
      const edit = result.output?.plan?.edits?.[0]
      const offset = Number(edit?.range?.offset ?? -1)
      const length = Number(edit?.range?.length ?? -1)
      // The replaced span is exactly the old value: not the attribute, not the element, not the mark.
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.slice(offset, offset + length))).toBe('24')
      expect(offset).toBeGreaterThanOrEqual(prefix.length)
      const written = ArrayBuffer.isView(edit?.payload?.bytes)
        ? (edit?.payload?.bytes as Uint8Array)
        : Uint8Array.from(Object.values(edit?.payload?.bytes as Record<string, number>))
      expect(new TextDecoder().decode(written)).toBe('48')

      await expect(
        session.operations().invoke('edit-field', {
          path: ['Style', 'Nowhere', 'height'],
          value: '1',
        }),
      ).rejects.toThrow(/no <Style name="Nowhere">/u)
    } finally {
      await session.dispose()
    }
  })

  it('declares the subject ids a localization catalog draws its edges to', async () => {
    /*
     * The join. A catalog publishes edges to `blizzard/sc2-style` subjects; until the sheet
     * declared them those edges pointed at nothing, and a host following one arrived nowhere.
     * What is checked here is the id, character for character, because that is the contract
     * between the two codecs — a rename on one side that stops matching is silent otherwise.
     */
    const bytes = encoder.encode(SHEET)
    const uri = 'memory://FontStyles.SC2Style'
    const source = {
      kind: 'bytes' as const,
      ref: { id: uri, uri },
      revision: 'content-hash.sha256:fixture',
      size: BigInt(bytes.byteLength),
      async read(offset: bigint, length: number) {
        return bytes.slice(Number(offset), Number(offset) + length)
      },
      async *stream() {
        yield bytes
      },
    }
    const binding = {
      sourceKind: 'candidate',
      bindingId: 'content',
      role: 'content',
      ownership: 'owned',
      source: source.ref,
      revision: source.revision,
    }
    const input = {
      originKind: 'single',
      bindings: [binding],
      primaryBindingId: binding.bindingId,
      revisions: {
        topology: 'single',
        revision: source.revision,
        bindings: [{ bindingId: binding.bindingId, revision: source.revision }],
        compositionFingerprint: source.ref.id,
      },
      bindingsFor: () => [],
      async openBinding() {
        return { value: source, async release() {} }
      },
    } as never
    const budget = {
      maxInputBytes: 400_000_000n,
      maxDepth: 64,
      maxNodes: 100_000,
      maxScalarBytes: 104_857_600,
      maxDiagnostics: 1_000,
    } as never
    const context = {
      budgets: budget,
      diagnostics: { report: () => undefined },
      contracts: {
        async resolve() {
          throw new Error('no service dependency in this test')
        },
        async resolveUnknown() {
          throw new Error('no foreign service in this test')
        },
      },
    } as never

    const session = (await createCodec(context).open(input, 'inspect', budget)) as never as {
      dataSource(contract: string, major: number): Promise<never>
      dispose(): Promise<void>
    }
    try {
      // A data source is handed out as a lease; the source itself is its `value`.
      const lease = (await session.dataSource('common.view/relation-graph-source', 1)) as unknown as {
        value: unknown
        release(): Promise<void>
      }
      const graph = lease.value as {
        summary(): Promise<{ completeness: string; totalNodes: number }>
        nodes(request: { offset: number; limit: number }): Promise<{
          items: readonly { id: string; label: string; type: string }[]
        }>
        edges(request: { offset: number; limit: number }): Promise<{
          items: readonly { from: string; to: string; role: string }[]
        }>
      }
      const page = { offset: 0, limit: 100 }
      const result = {
        nodes: (await graph.nodes(page)).items,
        edges: (await graph.edges(page)).items,
        completeness: (await graph.summary()).completeness,
      }
      await lease.release()
      const ids = result.nodes.map(node => node.id)
      expect(ids).toContain('modkit-subject://blizzard%2Fsc2-style/Style/Title')
      expect(ids).toContain('modkit-subject://blizzard%2Fsc2-style/Constant/ColorTitle')
      expect(ids).toContain('modkit-subject://blizzard%2Fsc2-style/FontGroup/Standard')

      // `template="Base"` is an edge the sheet can see on its own.
      expect(result.edges).toContainEqual({
        from: 'modkit-subject://blizzard%2Fsc2-style/Style/Title',
        to: 'modkit-subject://blizzard%2Fsc2-style/Style/Base',
        role: 'inherits',
      })
      /*
       * Partial, and it must stay so: this sheet knows what it declares, never who applies it.
       * Claiming completeness would turn "not in this session" into "used by nobody".
       */
      expect(result.completeness).toBe('partial')
    } finally {
      await session.dispose()
    }
  })
})
