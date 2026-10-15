/**
 * The SC2Layout language provider, answering from the game's own schema.
 *
 * The provider used to read a sixty-line table written beside the port while the compiled schema —
 * 2150 definitions, already in this repository and already used by the codec's render and validate
 * operations — sat unread. What is pinned here is the difference that made, and the one thing that
 * had to be got right for it to be an improvement rather than a wall of noise: a bounded workspace
 * snapshot must not turn "not in this window" into an error.
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeSc2Layout,
  sc2LayoutCompletion,
  sc2LayoutDefinition,
  sc2LayoutDiagnostics,
  sc2LayoutDocumentSymbols,
  sc2LayoutHover,
  sc2LayoutOnTypeFormatting,
  sc2LayoutReferences,
  sc2LayoutRename,
  sc2LayoutWorkspaceSymbols,
} from '../providers/language/runtime.js'
import {
  layoutFrameAbbreviationCompletions,
  layoutFrameTypes,
  layoutSchemaCompletions,
  layoutSchemaRegistry as indexedLayoutSchemaRegistry,
  layoutStore,
} from '../shared/schema-index.js'
import { layoutSchemaRegistry } from '../shared/schema-registry.js'

const NL = '\n'

const LAYOUT = [
  '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
  '<Desc>',
  '    <Frame type="Label" name="Title">',
  '        <Width val="100"/>',
  '    </Frame>',
  '</Desc>',
  '',
].join(NL)

function request(text: string, options: { incomplete?: boolean } = {}) {
  const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text }
  return {
    document,
    workspaceDocuments: [document],
    workspaceIncomplete: options.incomplete ?? false,
    maxResults: 500,
    maxDocuments: 4,
  } as never
}

function position(text: string, needle: string, delta = 0) {
  const offset = text.indexOf(needle) + delta
  const lines = text.slice(0, offset).split(NL)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

describe('sc2-layout schema-backed language', () => {
  it('shares the authoritative registry with every schema projection', () => {
    expect(indexedLayoutSchemaRegistry()).toBe(layoutSchemaRegistry())
  })

  it('knows the frame types the game declares, not a handful', () => {
    const types = layoutFrameTypes()
    expect(types.length).toBeGreaterThan(200)
    expect(types).toContain('Label')
    expect(types).toContain('Button')
    // A type the previous hand-written table did not have.
    expect(types).toContain('AchievementCategoryFrame')
  })

  // Parity plan 3.19: `:` marks the types only Blizzard's layouts may use and shows the snippet it inserts.
  it('marks Blizzard-only frame types after a colon and documents the snippet', () => {
    const [blizzard] = layoutFrameAbbreviationCompletions('Frame', ':ABChoiceFrame')
    expect(blizzard?.detail).toMatch(/^\[BLZ\] /u)
    expect(blizzard?.documentation).toContain('```sc2layout\n<Frame type="ABChoiceFrame"')
    expect(layoutFrameAbbreviationCompletions('Frame', ':Label').find(item => item.label === 'Label')?.detail).not.toMatch(/BLZ/u)
  })

  it('offers frame types filtered by what has been typed', async () => {
    const typed = LAYOUT.replace('type="Label"', 'type="Achie"')
    const line = typed.split(NL).findIndex(item => item.includes('type="Achie"'))
    const lineText = typed.split(NL)[line] ?? ''
    const result = await sc2LayoutCompletion({
      ...(request(typed) as object),
      // The caret sits after the typed prefix, inside the quotes.
      position: { line, character: lineText.indexOf('type="') + 'type="'.length + 'Achie'.length },
    } as never)
    const labels = result.items.map(item => item.label)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.every(label => label.toLowerCase().startsWith('achie'))).toBe(true)
  })

  it.each([0, 2])('filters an existing frame type by the %i characters before the caret', async prefixLength => {
    const start = position(LAYOUT, 'type="Label"', 'type="'.length)
    const result = await sc2LayoutCompletion({
      ...(request(LAYOUT) as object),
      maxResults: 2_000,
      position: { ...start, character: start.character + prefixLength },
    } as never)
    const labels = result.items.map(item => item.label)
    expect(labels).toContain('Label')
    if (prefixLength === 0) {
      expect(labels).toContain('Button')
      expect(labels.length).toBeGreaterThan(200)
    } else {
      expect(labels.every(label => label.toLowerCase().startsWith('la'))).toBe(true)
    }
    expect(result.items.find(item => item.label === 'Label')?.replacementRange).toEqual({
      start,
      end: { ...start, character: start.character + 'Label'.length },
    })
  })

  it('rebuilds the layout index after an equal-length edit under the same version', async () => {
    const document = {
      uri: 'file:///same-version.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: LAYOUT,
    }
    const symbols = async () => (await sc2LayoutDocumentSymbols({
      document,
      workspaceDocuments: [document],
      workspaceIncomplete: false,
      maxResults: 2_000,
      maxDocuments: 4,
    } as never)).symbols.map(item => item.name)
    expect(await symbols()).toContain('Title')
    // The caller object is mutable; retaining it would hide this change from the cache.
    document.text = document.text.replace('name="Title"', 'name="Other"')
    const changed = await symbols()
    expect(changed).toContain('Other')
    expect(changed).not.toContain('Title')
  })

  it('derives child elements and attributes from the selected frame schema', async () => {
    const childPosition = position(LAYOUT, '        <Width', 4)
    const children = await sc2LayoutCompletion({
      ...(request(LAYOUT) as object),
      position: childPosition,
    } as never)
    expect(children.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filterText: 'Width', kind: 'property' }),
        expect.objectContaining({ filterText: 'Anchor', kind: 'property' }),
      ]),
    )

    const attributeSource = LAYOUT.replace('<Width val="100"/>', '<Width />')
    const attributes = await sc2LayoutCompletion({
      ...(request(attributeSource) as object),
      position: position(attributeSource, '<Width ', '<Width '.length),
    } as never)
    expect(attributes.items).toContainEqual(
      expect.objectContaining({ label: 'val', insertText: 'val="$1"' }),
    )
  })

  it('derives attribute enum values from the schema', async () => {
    const source = LAYOUT.replace(
      '<Width val="100"/>',
      '<Anchor side="" relative="$parent" pos="" offset="0"/>',
    )
    const side = await sc2LayoutCompletion({
      ...(request(source) as object),
      position: position(source, 'side=""', 'side="'.length),
    } as never)
    expect(side.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['Left', 'Right', 'Top', 'Bottom']),
    )
  })

  it('expands compact frame and property abbreviations with an explicit replacement range', async () => {
    const frameSource = LAYOUT.replace('<Width val="100"/>', ':Achie')
    const frames = await sc2LayoutCompletion({
      ...(request(frameSource) as object),
      position: position(frameSource, ':Achie', ':Achie'.length),
    } as never)
    expect(frames.items).toContainEqual(
      expect.objectContaining({
        label: 'AchievementCategoryFrame',
        insertText: expect.stringContaining('<Frame type="AchievementCategoryFrame"'),
        replacementRange: {
          start: position(frameSource, ':Achie'),
          end: position(frameSource, ':Achie', ':Achie'.length),
        },
      }),
    )

    const groupSource = LAYOUT.replace('<Width val="100"/>', '@')
    const groups = await sc2LayoutCompletion({
      ...(request(groupSource) as object),
      position: position(groupSource, '@', 1),
    } as never)
    const group = groups.items.find(item => item.insertText?.startsWith('@') && item.insertText.endsWith('/'))
    expect(group).toBeDefined()

    const propertySource = LAYOUT.replace('<Width val="100"/>', group?.insertText ?? '@Label/')
    const properties = await sc2LayoutCompletion({
      ...(request(propertySource) as object),
      position: position(propertySource, group?.insertText ?? '@Label/', (group?.insertText ?? '@Label/').length),
    } as never)
    expect(properties.items.some(item => item.kind === 'property' && item.insertText?.startsWith('<'))).toBe(true)
  })

  it('expands inherited children and description paths from the bounded workspace', async () => {
    const base = {
      uri: 'file:///Base.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc><Frame type="Frame" name="Root"><Frame type="Label" name="Child"/></Frame></Desc>',
    }
    const childText = '<Desc><Include path="Base"/><Frame type="Frame" name="Derived" template="Base/Root">.Ch</Frame></Desc>'
    const child = {
      uri: 'file:///Child.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: childText,
    }
    const inherited = await sc2LayoutCompletion({
      ...(request(childText) as object),
      document: child,
      workspaceDocuments: [child, base],
      position: position(childText, '.Ch', 3),
    } as never)
    expect(inherited.items).toContainEqual(
      expect.objectContaining({ label: 'Child[Label]', filterText: '.Child[Label]', insertText: expect.stringContaining('name="Child"') }),
    )

    const overrideText = '<Desc><Include path="Base"/>/Base/Root</Desc>'
    const override = { ...child, text: overrideText }
    const paths = await sc2LayoutCompletion({
      ...(request(overrideText) as object),
      document: override,
      workspaceDocuments: [override, base],
      position: position(overrideText, '/Base/Root', '/Base/Root'.length),
    } as never)
    expect(paths.items).toContainEqual(
      expect.objectContaining({
        label: 'Base/Root [expand]',
        insertText: expect.stringContaining('file="Base"'),
      }),
    )
  })

  // Parity plan 3.6–3.8: MK2's `.` over the whole template chain and the frame's hookups, and `/`
  // one segment at a time over every description in the snapshot.
  it('offers inherited children, unprovided hookups and description paths as MK2 did', async () => {
    const base = {
      uri: 'file:///Base.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc><Frame type="Frame" name="Root"><Frame type="Label" name="Child"/></Frame>'
        + '<Frame type="Frame" name="Mid" template="Base/Root"><Frame type="Image" name="MidImage"/></Frame></Desc>',
    }
    const at = async (text: string, marker: string, delta: number) => {
      const document = { ...base, uri: 'file:///Probe.SC2Layout', text }
      return (await sc2LayoutCompletion({
        ...(request(text) as object),
        document,
        workspaceDocuments: [document, base],
        position: position(text, marker, delta),
      } as never)).items
    }
    // Through Mid to Root: MidImage and Child are both inherited; Child is already declared here.
    const chain = await at('<Desc><Frame type="Frame" name="Derived" template="Base/Mid"><Frame type="Label" name="Child"/>.</Frame></Desc>', '/>.', 3)
    expect(chain.map(item => item.label)).toContain('MidImage[Image]')
    expect(chain.map(item => item.label)).not.toContain('Child[Label]')

    // Hookups: a declared one is not offered, an aliased one under its alias, required ones first.
    const hooks = await at('<Desc><Frame type="AbilIcon" name="Icon"><HookupAlias original="CooldownLabel" alias="Timer"/>'
      + '<Frame type="Image" name="IconImage"/>.</Frame></Desc>', '/>.', 3)
    const labels = hooks.map(item => item.label)
    expect(labels).toEqual(expect.arrayContaining(['CooldownImage[Image] /H*', 'Timer[Label] /H*']))
    expect(labels.some(label => label.startsWith('IconImage[') || label.startsWith('CooldownLabel['))).toBe(false)
    expect(hooks.find(item => item.label === 'Timer[Label] /H*')).toMatchObject({
      insertText: '<Frame type="Label" name="Timer">$0</Frame>', sortText: '0Timer[Label] /H*',
    })

    // Paths: every file of the snapshot, not only the included ones, then a segment at a time.
    expect((await at('<Desc>/Ba</Desc>', '/Ba', 3)).map(item => [item.label, item.insertText])).toContainEqual(['Base', '/Base'])
    expect((await at('<Desc>/Base/Root/</Desc>', 'Root/', 5)).map(item => item.insertText)).toEqual(['/Base/Root/Child'])
    expect(await at('<Desc>/Base/Root/Child</Desc>', 'Child', 5)).toContainEqual(expect.objectContaining({
      label: 'Base/Root/Child [expand]',
      insertText: '<Frame type="Label" name="Root/Child" file="Base">$0</Frame>',
    }))
  })

  it('completes style and localized text references from the bounded workspace', async () => {
    const source = LAYOUT.replace(
      '<Width val="100"/>',
      '<Text val="@UI/Pr"/>\n        <Style val=""/>',
    )
    const layout = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const workspaceDocuments = [
      layout,
      {
        uri: 'file:///enUS.SC2Data/LocalizedData/GameStrings.txt',
        languageId: 'sc2-strings',
        version: 1,
        text: 'UI/Probe=Probe label\n',
      },
      {
        uri: 'file:///GameData/FontStyles.SC2Style',
        languageId: 'sc2-style',
        version: 1,
        text: '<StyleFile><Style name="ProbeStyle"/></StyleFile>',
      },
    ]
    const base = { ...request(source), document: layout, workspaceDocuments }
    // A key is a reference only after `@`, and is offered one segment at a time over the segment typed.
    const text = await sc2LayoutCompletion({
      ...base,
      position: position(source, '@UI/Pr', '@UI/Pr'.length),
    } as never)
    expect(text.items).toContainEqual(
      expect.objectContaining({
        label: 'Probe',
        detail: 'Probe label',
        replacementRange: { start: position(source, 'Pr"'), end: position(source, 'Pr"', 2) },
      }),
    )
    const root = await sc2LayoutCompletion({
      ...base,
      position: position(source, '@UI/Pr', 1),
    } as never)
    expect(root.items).toContainEqual(expect.objectContaining({ label: 'UI', insertText: 'UI/' }))
    const plain = source.replace('@UI/Pr', 'Pr')
    const literal = await sc2LayoutCompletion({
      ...base,
      document: { ...layout, text: plain },
      workspaceDocuments: [{ ...layout, text: plain }, ...workspaceDocuments.slice(1)],
      position: position(plain, 'val="Pr', 'val="Pr'.length),
    } as never)
    expect(literal.items.some(item => item.label === 'Probe' || item.label === 'UI/Probe')).toBe(false)
    const style = await sc2LayoutCompletion({
      ...base,
      position: position(source, '<Style val=""', '<Style val="'.length),
    } as never)
    expect(style.items).toContainEqual(expect.objectContaining({ label: 'ProbeStyle' }))
  })

  // Parity plan 3.15: a frame reference resolves from the current frame, a segment at a time.
  it('completes a frame reference a segment at a time from the current frame', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Button" name="Ok"/>',
      '        <Frame type="Label" name="Title">',
      '            <Anchor side="Left" relative="$parent/" pos="Min" offset="0"/>',
      '        </Frame>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const after = await sc2LayoutCompletion({
      ...(request(source) as object),
      position: position(source, '$parent/', '$parent/'.length),
    } as never)
    const labels = after.items.map(item => item.label)
    expect(labels).toEqual(expect.arrayContaining(['Ok', 'Title', '$parent']))
    expect(after.items.find(item => item.label === 'Ok')?.detail).toContain('Panel/Ok')
    const first = await sc2LayoutCompletion({
      ...(request(source) as object),
      position: position(source, '$parent/', 0),
    } as never)
    expect(first.items.map(item => item.label)).toEqual(expect.arrayContaining(['$parent', '$this', '$layer']))
    const typed = await sc2LayoutCompletion({
      ...(request(source) as object),
      position: position(source, '$parent/', 2),
    } as never)
    expect(typed.items.filter(item => item.kind === 'keyword').map(item => item.label)).toEqual(['$parent'])
  })

  // Parity plan 3.15: named handles at the start, and the `$ancestor[…]` selectors.
  it('offers named handles and the ancestor selectors', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Handle val="PanelHandle"/>',
      '        <Frame type="Label" name="Title">',
      '            <Anchor side="Left" relative="$" pos="Min" offset="0"/>',
      '            <Anchor side="Right" relative="$ancestor[" pos="Max" offset="0"/>',
      '            <Anchor side="Top" relative="$ancestor[name=" pos="Min" offset="0"/>',
      '        </Frame>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const at = async (needle: string) =>
      (
        await sc2LayoutCompletion({
          ...(request(source) as object),
          position: position(source, needle, needle.length - 1),
        } as never)
      ).items.map(item => item.label)
    expect(await at('relative="$"')).toContain('$PanelHandle')
    expect(await at('relative="$ancestor["')).toEqual(
      expect.arrayContaining(['$ancestor[type=', '$ancestor[oftype=', '$ancestor[name=']),
    )
    expect(await at('relative="$ancestor[name="')).toContain('$ancestor[name=Panel]')
  })

  // Parity plan 3.23: `name=` beside `file=` goes to that file's description.
  it('goes from name= beside file= to the description it extends', async () => {
    const source = ['<Desc>', '    <Frame type="Frame" name="Hud" file="GameUI"/>', '</Desc>', ''].join(NL)
    const gameUi = {
      uri: 'file:///GameUI.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc>\n    <Frame type="Frame" name="Hud"/>\n</Desc>\n',
    }
    const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const result = await sc2LayoutDefinition({
      ...(request(source) as object),
      workspaceDocuments: [document, gameUi],
      position: position(source, 'name="Hud"', 7),
    } as never)
    expect(result.locations).toEqual([
      { uri: gameUi.uri, range: { start: { line: 1, character: 30 }, end: { line: 1, character: 33 } } },
    ])
  })

  /*
   * Parity plan 3.10, 3.11, 3.17: what a When, an Action, a Controller or a Key names comes from the
   * frame it addresses — `frame=` included — and the open attribute of a When or an Action takes the
   * names of that frame and then the values of what it names.
   */
  it('offers the names and values of the frame an element addresses', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Label" name="Title"/>',
      '        <Animation name="Fade">',
      '            <Event event="Go" action="Play"/>',
      '            <Controller type="Property" property="" frame="Title" end="Stop"/>',
      '            <Controller type="Property" property="" end="Stop"/>',
      '            <Controller type="Event" end="Stop">',
      '                <Key type="Event" time="0" event=""/>',
      '            </Controller>',
      '        </Animation>',
      '        <StateGroup name="Mode">',
      '            <DefaultState val="On"/>',
      '            <State name="On">',
      '                <When type="Property" frame="Title" Visible=""/>',
      '                <Action type="SetProperty" frame="Title" />',
      '            </State>',
      '            <State name="Off">',
      '                <When type="StateGroup" Mode=""/>',
      '                <When type="AnimationState" />',
      '            </State>',
      '        </StateGroup>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const labels = async (needle: string, delta: number) =>
      (await sc2LayoutCompletion({ ...(request(source) as object), position: position(source, needle, delta) } as never)).items.map(
        item => item.label,
      )
    expect(await labels('property="" frame', 10)).toContain('Text')
    const panel = await labels('property="" end', 10)
    expect(panel).toContain('Visible')
    expect(panel).not.toContain('Text')
    expect(await labels('Visible=""', 9)).toEqual(expect.arrayContaining(['True', 'False']))
    expect(await labels('frame="Title" />', 14)).toContain('Text')
    expect(await labels('Mode=""', 6)).toEqual(['Off', 'On'])
    expect(await labels('"AnimationState" />', 17)).toContain('Fade')
    expect(await labels('event=""/>', 7)).toEqual(['Go'])
  })

  // Parity plan 3.26: a frame's animations and state groups nest under it, a group's states under it;
  // workspace symbols match fuzzily, and `#` asks for constants only.
  it('nests animations, state groups and states in document symbols; matches workspace symbols fuzzily', async () => {
    const source = [
      '<Desc>',
      '    <Constant name="PanelWidth" val="100"/>',
      '    <Frame type="Frame" name="Panel">',
      '        <Animation name="Fade"/>',
      '        <StateGroup name="Mode">',
      '            <DefaultState val="On"/>',
      '            <State name="On"/>',
      '            <State name="Off"/>',
      '        </StateGroup>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const document = (await sc2LayoutDocumentSymbols(request(source))).symbols
    const panel = document.find(item => item.name === 'Panel')
    expect(panel?.children?.map(item => [item.name, item.kind])).toEqual([['Fade', 'variable'], ['Mode', 'enum']])
    expect(panel?.children?.[1]?.children?.map(item => item.name)).toEqual(['On', 'Off'])
    const workspace = async (query: string) =>
      (await sc2LayoutWorkspaceSymbols({ ...(request(source) as object), query } as never)).symbols.map(item => item.name)
    expect((await workspace('pnl')).sort()).toEqual(['Panel', 'PanelWidth'])
    expect(await workspace('#pan')).toEqual(['PanelWidth'])
  })

  /*
   * Parity plan 3.24: an animation or a state group is named through the frame an element addresses;
   * the same name in another frame is another animation, and renaming one leaves the other alone.
   */
  it('finds and renames the animations and state groups a frame declares', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Base">',
      '        <Animation name="Fade"/>',
      '        <StateGroup name="Mode">',
      '            <State name="On">',
      '                <When type="AnimationState" Fade="Play"/>',
      '                <Action type="SetState" group="Mode" state="On"/>',
      '            </State>',
      '        </StateGroup>',
      '        <StateGroup name="Other">',
      '            <State name="X">',
      '                <When type="StateGroup" Mode="On"/>',
      '            </State>',
      '        </StateGroup>',
      '    </Frame>',
      '    <Frame type="Frame" name="Elsewhere">',
      '        <Animation name="Fade"/>',
      '        <StateGroup name="S">',
      '            <State name="Y">',
      '                <When type="AnimationState" Fade="Play"/>',
      '            </State>',
      '        </StateGroup>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const lineOf = (needle: string) => source.split(NL).findIndex(line => line.includes(needle))
    const at = (needle: string, delta: number, nth = 0) => {
      let index = -1
      for (let i = 0; i <= nth; i++) index = source.indexOf(needle, index + 1)
      const before = source.slice(0, index + delta).split(NL)
      return { line: before.length - 1, character: before.at(-1)!.length }
    }
    const references = await sc2LayoutReferences({
      ...(request(source) as object),
      position: at('Fade="Play"', 1),
      includeDeclaration: true,
    } as never)
    expect(references.locations.map(item => item.range.start.line)).toEqual([2, lineOf('Fade="Play"')])
    const rename = await sc2LayoutRename({
      ...(request(source) as object),
      position: at('<StateGroup name="Mode"', 'StateGroup name="'.length + 2),
      newName: 'Phase',
      maxEdits: 10,
    } as never)
    const edits = rename?.documentChanges?.[0]?.edits ?? []
    expect(edits.map(edit => [edit.range.start.line, edit.newText])).toEqual([
      [lineOf('Mode="On"'), 'Phase'],
      [lineOf('group="Mode"'), 'Phase'],
      [lineOf('<StateGroup name="Mode"'), 'Phase'],
    ])
  })

  // Parity plan 3.21: an element shows its frame type and attributes; an open When attribute has a type.
  it('hovers an element with its attributes and a restricted frame type, and an open attribute', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="ABChoiceFrame" name="Choice">',
      '        <StateGroup name="Mode">',
      '            <State name="On">',
      '                <When type="Property" Visible="True"/>',
      '            </State>',
      '        </StateGroup>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const hover = async (needle: string, delta: number) =>
      (await sc2LayoutHover({ ...(request(source) as object), position: position(source, needle, delta) } as never))?.markdown ?? ''
    const frame = await hover('<Frame type="ABChoiceFrame"', 2)
    expect(frame).toContain('Frame type `ABChoiceFrame` — Blizzard restricted.')
    expect(frame).toMatch(/- `type` \(required\)/u)
    const open = await hover('Visible="True"', 'Visible="'.length)
    expect(open).toContain('**`True`**')
  })

  // Parity plan 3.20: a closing tag typed on its own line takes the indentation of its opening tag.
  it('re-indents a closing tag to its opening tag when its > is typed', async () => {
    const source = ['<Desc>', '    <Frame type="Frame" name="A">', '        <Width val="1"/>', '            </Frame>', '</Desc>', ''].join(NL)
    const at = (needle: string, ch = '>') =>
      sc2LayoutOnTypeFormatting({ ...(request(source) as object), ch, options: {}, position: position(source, needle, needle.length) } as never)
    expect((await at('            </Frame>')).edits).toEqual([
      { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 12 } }, newText: '    ' },
    ])
    // Already in place, or on its opening tag's line, or a self-closing tag: nothing to do.
    expect((await at('</Desc>')).edits).toEqual([])
    expect((await at('<Width val="1"/>')).edits).toEqual([])
  })

  // Parity plan 3.16: a property bind completes its path from the frame, then the target frame's properties.
  it('completes a property bind segment by segment and then its properties', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Label" name="Source"/>',
      '        <Frame type="Label" name="Copy">',
      '            <Text val="{$parent/So}"/>',
      '            <Style val="{$parent/Source/@}"/>',
      '            <Height val="{$parent/@}"/>',
      '        </Frame>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const items = async (needle: string, delta: number) =>
      (await sc2LayoutCompletion({ ...(request(source) as object), position: position(source, needle, delta) } as never)).items
    const segment = (await items('/So}', 3)).find(item => item.label === 'Source')
    expect(segment?.replacementRange).toEqual({ start: position(source, 'So}'), end: position(source, 'So}', 2) })
    expect((await items('Source/@}', 8)).map(item => item.label)).toContain('Text')
    const panel = (await items('$parent/@}"/>\n', 9)).map(item => item.label)
    expect(panel).toContain('Visible')
    expect(panel).not.toContain('Text')
  })

  // Parity plan 3.23: a frame's internal part, an event a key sends and a property bind go to what they name.
  it('goes from an internal part, an event and a property bind to their declarations', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Button" name="Panel">',
      '        <Frame type="Image" name="Img"/>',
      '        <NormalImage val="Img"/>',
      '        <Frame type="Label" name="Source">',
      '            <Text val="Hi"/>',
      '        </Frame>',
      '        <Frame type="Label" name="Copy">',
      '            <Text val="{$parent/Source/@Text}"/>',
      '        </Frame>',
      '        <Animation name="Fade">',
      '            <Event event="Go" action="Play"/>',
      '            <Controller type="Event" end="Stop">',
      '                <Key type="Event" time="0" event="Go"/>',
      '            </Controller>',
      '        </Animation>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const at = async (needle: string, delta: number) =>
      (await sc2LayoutDefinition({ ...(request(source) as object), position: position(source, needle, delta) } as never))
        .locations[0]?.range
    expect(await at('val="Img"', 6)).toEqual({ start: position(source, 'Img"/>'), end: position(source, 'Img"/>', 3) })
    expect(await at('Source/@', 2)).toEqual({ start: position(source, 'Source">'), end: position(source, 'Source">', 6) })
    expect((await at('@Text', 2))?.start).toEqual(position(source, '<Text val="Hi"/>'))
    expect(await at('time="0" event="Go"', 17)).toEqual({ start: position(source, 'Go" action'), end: position(source, 'Go" action', 2) })
  })

  // Parity plan 3.23: a frame reference goes to the frame of the segment under the caret.
  it('goes from each segment of a frame reference to its frame', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Button" name="Ok"/>',
      '        <Frame type="Label" name="Title">',
      '            <Anchor side="Left" relative="$parent/Ok" pos="Min" offset="0"/>',
      '        </Frame>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const at = async (delta: number) =>
      (await sc2LayoutDefinition({ ...(request(source) as object), position: position(source, '$parent/Ok', delta) } as never))
        .locations[0]?.range
    expect(await at('$parent/'.length + 1)).toEqual({ start: position(source, 'Ok"/>'), end: position(source, 'Ok"/>', 2) })
    expect(await at(2)).toEqual({ start: position(source, 'Panel'), end: position(source, 'Panel', 5) })
  })

  /*
   * A constant resolves across every layout the mod loads (parity plan 3.18): one the file does not
   * include is offered too, each name once, with its final value through the chain as detail.
   */
  it('offers every constant of the snapshot with its value through the chain', async () => {
    const source = LAYOUT.replace('<Width val="100"/>', '<Height val="##"/>')
    const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const colors = {
      uri: 'file:///Colors.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc><Constant name="Base" val="ff0000"/><Constant name="Accent" val="#Base"/><Constant name="Lost" val="#Nowhere"/></Desc>',
    }
    const shadow = { ...colors, uri: 'file:///Other.SC2Layout', text: '<Desc><Constant name="base" val="00ff00"/></Desc>' }
    const constants = await sc2LayoutCompletion({
      ...(request(source) as object),
      workspaceDocuments: [document, colors, shadow],
      position: position(source, 'val="##', 7),
    } as never)
    const detail = (label: string) => constants.items.filter(item => item.label === label).map(item => item.detail)
    expect(detail('##Base')).toEqual(['ff0000'])
    expect(detail('##Accent')).toEqual(['#Base → ff0000'])
    expect(detail('##Lost')).toEqual(['#Nowhere → ?'])
    expect(constants.items.filter(item => item.label.toLowerCase() === '##base')).toHaveLength(1)
    // Parity plan 3.22: the hover of a constant says its file and its value through the chain.
    const used = source.replace('val="##"', 'val="#Accent"')
    const hover = await sc2LayoutHover({
      ...(request(used) as object),
      workspaceDocuments: [{ ...document, text: used }, colors],
      position: position(used, '#Accent', 3),
    } as never)
    expect(hover?.markdown).toContain('Constant `Accent` in `Colors.SC2Layout`: #Base → ff0000.')
  })

  /*
   * VS Code's own word stops at `#`, `$` and `/`: an item for the whole value that replaced only the
   * word wrote `##Name` and `$$parent` (parity plan 3.1).
   */
  it('replaces the whole value with a constant or a frame handle, keeping the hashes typed', async () => {
    const source = LAYOUT.replace('<Desc>', '<Desc>\n    <Include path="Base"/>').replace(
      '<Width val="100"/>',
      '<Height val="##Si"/>\n        <Anchor side="Left" relative="$pa" pos="Min" offset="0"/>',
    )
    const base = {
      uri: 'file:///Base.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc><Constant name="Size" val="12"/></Desc>',
    }
    const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const constants = await sc2LayoutCompletion({
      ...(request(source) as object),
      workspaceDocuments: [document, base],
      position: position(source, '##Si', 4),
    } as never)
    expect(constants.items).toContainEqual(
      expect.objectContaining({
        label: '##Size',
        replacementRange: { start: position(source, '##Si'), end: position(source, '##Si', 4) },
      }),
    )
    const handles = await sc2LayoutCompletion({
      ...(request(source) as object),
      position: position(source, '$pa', 3),
    } as never)
    expect(handles.items).toContainEqual(
      expect.objectContaining({
        label: '$parent',
        replacementRange: { start: position(source, '$pa'), end: position(source, '$pa', 3) },
      }),
    )
  })

  it('completes a child element after a typed < without a second < (parity plan 3.2)', async () => {
    const named = LAYOUT.replace('<Width val="100"/>', '<Wi')
    const width = await sc2LayoutCompletion({
      ...(request(named) as object),
      position: position(named, '<Wi', 3),
    } as never)
    const item = width.items.find(entry => entry.label.startsWith('Width'))
    expect(item?.insertText?.startsWith('Width')).toBe(true)
    expect(item?.replacementRange).toEqual({ start: position(named, '<Wi', 1), end: position(named, '<Wi', 3) })

    const bare = LAYOUT.replace('<Width val="100"/>', '<')
    const any = await sc2LayoutCompletion({
      ...(request(bare) as object),
      position: position(bare, '<\n', 1),
    } as never)
    expect(any.items.length).toBeGreaterThan(0)
    expect(any.items.some(entry => entry.insertText?.startsWith('<'))).toBe(false)
  })

  // Parity plan 3.9: a required enumeration without a default is offered as a snippet choice.
  it('offers a required enumeration as a snippet choice', () => {
    const store = layoutStore([{ uri: 'file:///probe.SC2Layout', text: LAYOUT }])
    const items = layoutSchemaCompletions(store, 'file:///probe.SC2Layout', LAYOUT.indexOf('<Frame'), 'element').items
    const mouse = items.find(item => item.label.startsWith('AcceptsMouse'))
    expect(mouse?.insertText).toBe('<AcceptsMouse val="${1|False,True|}"/>')
  })

  // Parity plan 3.5: MK2's frame shortcuts, an anchor per side and state groups with a default.
  it('offers an anchor per side and state groups inside a frame', async () => {
    const typed = LAYOUT.replace('<Width val="100"/>', '<An')
    const anchors = await sc2LayoutCompletion({ ...(request(typed) as object), position: position(typed, '<An', 3) } as never)
    const labels = anchors.items.map(entry => entry.label)
    expect(labels).toEqual(expect.arrayContaining(['Anchor:Left', 'Anchor:Right', 'Anchor:Top', 'Anchor:Bottom']))
    expect(anchors.items.find(entry => entry.label === 'Anchor:Right')?.insertText)
      .toBe('Anchor side="Right" relative="${1:\\$parent}" pos="${2:Max}" offset="${3:0}"/>')
    const group = anchors.items.find(entry => entry.label === 'StateGroup:2')
    expect(group?.insertText).toBe([
      'StateGroup name="${1:StateGroup2}">',
      '\t<DefaultState val="${4:Default}"/>',
      '\t<State name="${2:1}">', '\t</State>',
      '\t<State name="${3:2}">', '\t</State>',
      '\t<State name="${4:Default}">', '\t</State>',
      '</StateGroup>',
    ].join(NL))
    // Only inside a frame: the document root holds no anchors.
    const root = LAYOUT.replace('    <Frame type="Label" name="Title">', '    <An\n    <Frame type="Label" name="Title">')
    const outside = await sc2LayoutCompletion({ ...(request(root) as object), position: position(root, '<An', 3) } as never)
    expect(outside.items.some(entry => entry.label.startsWith('Anchor:'))).toBe(false)
  })

  /*
   * `name=` without `file=` overrides an inherited child or declares a new one; MK2 offered the
   * inherited children this parent has not declared yet, not every frame path (parity plan 3.4).
   */
  it('offers the inherited children not yet declared for a name without file', async () => {
    const base = {
      uri: 'file:///Base.SC2Layout',
      languageId: 'sc2-layout',
      version: 1,
      text: '<Desc><Frame type="Frame" name="Root"><Frame type="Label" name="Child"/><Frame type="Label" name="Other"/></Frame></Desc>',
    }
    const childText =
      '<Desc><Include path="Base"/><Frame type="Frame" name="Derived" template="Base/Root"><Frame type="Label" name="Child"/><Frame type="Label" name="Ot"/></Frame></Desc>'
    const child = { uri: 'file:///Child.SC2Layout', languageId: 'sc2-layout', version: 1, text: childText }
    const names = await sc2LayoutCompletion({
      ...(request(childText) as object),
      document: child,
      workspaceDocuments: [child, base],
      position: position(childText, 'name="Ot"', 'name="Ot'.length),
    } as never)
    const labels = names.items.map(item => item.label)
    expect(labels).toContain('Other')
    expect(labels).not.toContain('Child')
    expect(labels.some(label => label.startsWith('$') || label.includes('/'))).toBe(false)
  })

  /*
   * The finding the table could not make: `EFrameType` is a schema enumeration, and whether a name
   * is in it is knowable only from the schema.
   */
  it('reports a frame type the schema does not declare', async () => {
    const broken = LAYOUT.replace('type="Label"', 'type="NotARealFrameType"')
    const result = await sc2LayoutDiagnostics(request(broken))
    const schema = result.diagnostics.filter(item => item.code === 'sc2-layout/schema/invalid-value')
    expect(schema).toHaveLength(1)
    expect(schema[0]?.severity).toBe('error')
    expect(schema[0]?.message).toContain('EFrameType')
  })

  // Parity plan 4.1: a Style value shows a sample of the style from the snapshot's sheets.
  it('hovers a Style value with a sample of the style', async () => {
    const source = ['<Desc>', '    <Frame type="Label" name="A">', '        <Style val="Title"/>', '    </Frame>', '</Desc>', ''].join(NL)
    const sheet = {
      uri: 'file:///FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile><Style name="Title" textcolor="00ff00" height="18"/></StyleFile>',
    }
    const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const hover = await sc2LayoutHover({
      ...(request(source) as object),
      workspaceDocuments: [document, sheet],
      position: position(source, 'Title"', 2),
    } as never)
    const image = /\(data:image\/svg\+xml,([^)]+)\)/u.exec(hover?.markdown ?? '')?.[1]
    expect(decodeURIComponent(image ?? '')).toContain('color:#00ff00;font-size:18px')
  })

  // Parity plan 3.22: a bind says what it binds; an event a key sends says which animation handles it.
  it('hovers a property bind and an event with what they reach', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Label" name="Source"/>',
      '        <Frame type="Label" name="Copy">',
      '            <Text val="{$parent/Source/@Text}"/>',
      '        </Frame>',
      '        <Animation name="Fade">',
      '            <Event event="Go" action="Play"/>',
      '            <Controller type="Event" end="Stop">',
      '                <Key type="Event" time="0" event="Go"/>',
      '            </Controller>',
      '        </Animation>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const hover = async (needle: string, delta: number) =>
      (await sc2LayoutHover({ ...(request(source) as object), position: position(source, needle, delta) } as never))?.markdown ?? ''
    expect(await hover('{$parent', 3)).toMatch(/Binds `Text` \(`\w+`\) of `Label` `[^`]*Panel\/Source`/u)
    expect(await hover('time="0" event="Go"', 17)).toContain('Event `Go` → `Play` in animation `Fade`.')
  })

  // Parity plan 3.30: a value's tokens say what it is — constant, reference, number or colour, handle.
  it('colours constants, references, numbers and handles in attribute values', async () => {
    const source = [
      '<Desc>',
      '    <Frame type="Label" name="A">',
      '        <Width val="#Size"/>',
      '        <Text val="@UI/Title"/>',
      '        <Color val="ff8000"/>',
      '        <Anchor side="Left" relative="$parent/Other" pos="Min" offset="12"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const document = { uri: 'file:///probe.SC2Layout', languageId: 'sc2-layout', version: 1, text: source }
    const tokens = (await analyzeSc2Layout({ document } as never)).tokens
    const at = (needle: string, length = needle.length) =>
      tokens.find(item => item.range.start.line === position(source, needle).line && item.range.start.character === position(source, needle).character && item.range.end.character === position(source, needle).character + length)
    expect(at('#Size')).toMatchObject({ kind: 'variable', modifiers: ['readonly'] })
    expect(at('@UI/Title')).toMatchObject({ kind: 'variable' })
    expect(at('ff8000')).toMatchObject({ kind: 'number' })
    expect(at('$parent/Other', '$parent'.length)).toMatchObject({ kind: 'keyword' })
    expect(at('Other"', 'Other'.length)).toMatchObject({ kind: 'string' })
    expect(at('12"', 2)).toMatchObject({ kind: 'number' })
  })

  // Parity plan 3.27: each checker rule has its own code, and its category keeps its own severity.
  it('reports each checker rule under its own code and severity', async () => {
    const result = await sc2LayoutDiagnostics(request(LAYOUT.replace('type="Label"', 'type="Label" bogus="1"')))
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'sc2-layout/schema/unexpected-attribute', severity: 'information' }),
    )
  })

  it('uses only schema diagnostics for schema rules', async () => {
    const broken = LAYOUT.replace(
      '<Width val="100"/>',
      '<Anchor side="NotAnAnchorSide" relative="$parent" pos="Min" offset="0"/>',
    )
    const result = await sc2LayoutDiagnostics(request(broken))
    expect(result.diagnostics.some(item => item.code?.startsWith('sc2-layout/schema/'))).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'sc2-layout/anchor-side')).toBe(false)
  })

  it('accepts a layout the schema is happy with', async () => {
    const result = await sc2LayoutDiagnostics(request(LAYOUT))
    expect(result.diagnostics.filter(item => item.code?.startsWith('sc2-layout/schema/'))).toEqual([])
  })

  /*
   * The rule that keeps this usable. A layout that builds on templates and constants from other
   * files is normal; a request that carries only this file cannot see them, and the checker says so
   * for every one of them. On a real 13 KB layout that was thirty-six findings, none of them defects.
   */
  it('does not report what a bounded snapshot simply cannot see', async () => {
    const dependent = [
      '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
      '<Desc>',
      '    <Frame type="Label" name="Title" template="OtherFile/SomeTemplate">',
      '        <Width val="#SomeConstant"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join(NL)
    const result = await sc2LayoutDiagnostics(request(dependent, { incomplete: true }))
    const messages = result.diagnostics
      .filter(item => item.code?.startsWith('sc2-layout/schema/'))
      .map(item => item.message)
    expect(messages).toEqual([])
  })
})
