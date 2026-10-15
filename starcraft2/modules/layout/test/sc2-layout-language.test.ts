import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspaceReferenceIndex } from '@modkit/host'
import {
  createProvider,
  sc2LayoutCompletion,
  sc2LayoutColorPresentations,
  sc2LayoutDefinition,
  sc2LayoutDiagnostics,
  sc2LayoutDocumentSymbols,
  sc2LayoutDocumentColors,
  sc2LayoutFormatting,
  sc2LayoutHover,
  sc2LayoutPrepareRename,
  sc2LayoutReferences,
  sc2LayoutRename,
  sc2LayoutWorkspaceSymbols,
  layoutReferenceOccurrenceBatches,
} from '../providers/language/runtime.js'
import { previewSc2Layout } from '../shared/preview.js'
import { createProvider as createWriterProvider } from '../../../shared/editing/providers/authored-text/runtime.js'

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures', 'layout', name), 'utf8')

const document = (name: string, text = fixture(name), version = 1) => ({
  uri: `file:///fixture/${name}`,
  languageId: 'sc2-layout',
  version,
  text,
})

type LayoutDocument = ReturnType<typeof document>
type TextEdit = Readonly<{
  range: Readonly<{
    start: Readonly<{ line: number; character: number }>
    end: Readonly<{ line: number; character: number }>
  }>
  newText: string
}>

const baseDocuments = [document('StandardTemplates.SC2Layout'), document('TechTreePanel.SC2Layout')]

function position(text: string, needle: string, delta = 0) {
  const offset = text.indexOf(needle) + delta
  const prefix = text.slice(0, offset)
  const lines = prefix.split('\n')
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

const feature = (
  current: LayoutDocument,
  documents: readonly LayoutDocument[] = baseDocuments,
) => ({
  document: current,
  workspaceDocuments: documents,
  workspaceIncomplete: false,
  maxResults: 1000,
  maxDocuments: 16,
})

function offsetAt(text: string, pos: { line: number; character: number }) {
  const lines = text.split('\n')
  let offset = 0
  for (let line = 0; line < pos.line; line += 1) offset += lines[line].length + 1
  return offset + pos.character
}

function applyDocumentEdits(text: string, edits: readonly TextEdit[]) {
  let output = text
  const sorted = [...edits].sort(
    (left, right) => offsetAt(text, right.range.start) - offsetAt(text, left.range.start),
  )
  for (const edit of sorted) {
    output = `${output.slice(0, offsetAt(text, edit.range.start))}${edit.newText}${output.slice(offsetAt(text, edit.range.end))}`
  }
  return output
}

/*
 * The layout end of String ↔ Style ↔ Layout: a Style-typed value names a FontStyles style, so a
 * caret on it reaches the sheet and renames through the same model the Style and Strings providers
 * use. A `#Name` there is a layout constant and keeps the layout's own navigation.
 */
describe('SC2Layout Style-typed values', () => {
  const layoutText = [
    '<Desc>',
    '  <Constant name="Accent" val="Title"/>',
    '  <Frame type="Label" name="Title">',
    '    <Style val="@@Title"/>',
    '    <Controller type="Style" style1="Title" style2="Other"/>',
    '  </Frame>',
    '</Desc>',
    '',
  ].join('\n')
  const layout = document('Hud.SC2Layout', layoutText, 3)
  const sheet = {
    uri: 'file:///fixture/FontStyles.SC2Style',
    languageId: 'sc2-style',
    version: 7,
    text: '<StyleFile>\n<Style name="Title" height="16"/>\n<Style name="Other"/>\n</StyleFile>\n',
  }
  const catalog = {
    uri: 'file:///fixture/GameStrings.txt',
    languageId: 'sc2-strings',
    version: 2,
    text: 'UI/Title=<s val="Title">T</s>\n',
  }
  const request = (needle: string, delta: number, extra: Record<string, unknown> = {}) => ({
    ...feature(layout, [layout, sheet, catalog]),
    position: position(layoutText, needle, delta),
    ...extra,
  })

  it('asks the host for the style sheets a Style value resolves against', () => {
    const lease = createProvider({ contract: 'common.language/document-analysis', major: 1 })
    expect(lease.value.workspaceLanguageIds).toContain('sc2-style')
  })

  it('goes from <Style val="@@Title"> and style1 to the sheet declaration', async () => {
    for (const [needle, delta] of [['@@Title', 3], ['style1="Title"', 9]] as const) {
      const result = await sc2LayoutDefinition(request(needle, delta) as never)
      expect(result.locations).toEqual([
        {
          uri: sheet.uri,
          range: { start: { line: 1, character: 13 }, end: { line: 1, character: 18 } },
        },
      ])
    }
  })

  it('hovers <Style val="@@Title"> and style1 with a sample of the declared style', async () => {
    for (const [needle, delta] of [['@@Title', 3], ['style1="Title"', 9]] as const) {
      const hover = await sc2LayoutHover(request(needle, delta) as never)
      expect(hover?.markdown).not.toContain('is in no style sheet')
      expect(hover?.markdown).toContain('Title](data:image/')
    }
  })

  it('renames the style in the sheet, the catalog and both layout uses, not the frame name', async () => {
    expect(await sc2LayoutPrepareRename(request('@@Title', 3) as never)).toMatchObject({
      placeholder: 'Title',
    })
    const edit = await sc2LayoutRename(
      request('@@Title', 3, { newName: 'Heading', maxEdits: 20 }) as never,
    )
    expect(edit?.documentChanges.map(change => [change.uri, change.documentVersion, change.edits.length])).toEqual([
      [sheet.uri, 7, 1],
      [layout.uri, 3, 2],
      [catalog.uri, 2, 1],
    ])
    const renamed = applyDocumentEdits(
      layoutText,
      edit!.documentChanges.find(change => change.uri === layout.uri)!.edits,
    )
    expect(renamed).toContain('<Style val="@@Heading"/>')
    expect(renamed).toContain('style1="Heading"')
    expect(renamed).toContain('<Frame type="Label" name="Title">')
    expect(renamed).toContain('<Constant name="Accent" val="Title"/>')
  })

  // Parity plan 3.12: a Style value offers the sheets' styles, never their constants.
  it('offers FontStyles styles, not constants, for a Style value', async () => {
    const withConstant = { ...sheet, text: sheet.text.replace('<StyleFile>\n', '<StyleFile>\n<Constant name="Shade" val="ff000000"/>\n') }
    const completion = await sc2LayoutCompletion({
      ...feature(layout, [layout, withConstant, catalog] as never),
      position: position(layoutText, '@@Title', 2),
    } as never)
    const offered = completion.items.filter(item => item.detail === 'FontStyles style').map(item => item.label)
    expect(offered).toEqual(['Other', 'Title'])
    expect(completion.items.map(item => item.label)).not.toContain('Shade')
  })

  it('keeps layout navigation for everything that is not a Style-typed value', async () => {
    const references = await sc2LayoutReferences(
      request('name="Accent"', 7, { includeDeclaration: true }) as never,
    )
    // The layout constant declaration, found by the layout provider, not the style model.
    expect(references.locations).toEqual([
      {
        uri: layout.uri,
        range: { start: { line: 1, character: 18 }, end: { line: 1, character: 24 } },
      },
    ])
  })
})

describe('SC2Layout typed workspace targets', () => {
  it('publishes the canonical resolved template identity', async () => {
    const templates = document('StandardTemplates.SC2Layout')
    const current = document('TechTreePanel.SC2Layout')
    const documents = [templates, current]
    const workspaceContext = {
      id: 'sc2-workspace:layout', revision: 'r1', semanticComplete: true, semanticInputs: [],
      documentOrigins: documents.map((item, precedence) => ({ uri: item.uri, layerId: `fixture:${precedence}`, logicalId: item.uri, precedence, sourceRevision: 'r1', readOnly: false })),
    }
    const batches = await layoutReferenceOccurrenceBatches({ ...feature(current, documents), workspaceContext } as never)
    const index = createWorkspaceReferenceIndex()
    for (const batch of batches) index.replace(batch)
    expect(index.snapshot().occurrences).toBeGreaterThan(0)
    expect(batches.flatMap((batch: any) => batch.occurrences)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ owner: 'blizzard/sc2-layout', kind: 'layout-template', id: expect.stringContaining('TechItemTemplate') }),
        role: 'reference',
      }),
    ]))
  })
})

/*
 * The layout end of the key relation: `<Text val="@Key">` names a GameStrings entry, so a caret on
 * it reaches the catalog definitions in every locale and renames the key with the catalogs.
 */
describe('SC2Layout GameStrings keys', () => {
  const layoutText = [
    '<Desc>',
    '  <Frame type="Label" name="Score">',
    '    <Text val="@UI/ScoreTitle"/>',
    '    <Tooltip val="UI/ScoreTitle"/>',
    '  </Frame>',
    '</Desc>',
    '',
  ].join('\n')
  const layout = document('Score.SC2Layout', layoutText, 5)
  const english = {
    uri: 'file:///fixture/enUS/GameStrings.txt',
    languageId: 'sc2-strings',
    version: 1,
    text: 'UI/ScoreTitle=Score\nUI/Other=<d stringref="UI,ScoreTitle,Name"/>\n',
  }
  const german = {
    uri: 'file:///fixture/deDE/GameStrings.txt',
    languageId: 'sc2-strings',
    version: 2,
    text: 'UI/ScoreTitle=Punkte\n',
  }
  const request = (extra: Record<string, unknown> = {}) => ({
    ...feature(layout, [layout, english, german]),
    position: position(layoutText, '@UI/ScoreTitle', 4),
    ...extra,
  })

  // Parity plan 3.22: the hover of a key says the string it names.
  it('shows the value of an @Key in its hover', async () => {
    const hover = await sc2LayoutHover(request() as never)
    expect(hover?.markdown).toContain('String `UI/ScoreTitle` = `Score`')
  })

  it('goes from @Key to the definition in every locale catalog', async () => {
    const result = await sc2LayoutDefinition(request() as never)
    expect(result.locations.map(item => item.uri)).toEqual([english.uri, german.uri])
  })

  it("goes from @Key to the same definitions through the mod server's catalogs", async () => {
    const { createStringsServedKeys } = await import('../../strings/providers/language/src/served-keys.js')
    const files = [
      { layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', uri: english.uri, text: english.text },
      { layerId: 'mod', path: 'deDE.SC2Data/LocalizedData/GameStrings.txt', uri: german.uri, text: german.text },
      { layerId: 'mod', path: 'Base.SC2Data/UI/Layout/Score.SC2Layout', uri: layout.uri, text: layoutText },
    ]
    const keys = createStringsServedKeys()
    keys.update(files)
    const modContexts = {
      async query(_scope: string, question: { kind: string; key: string; document: { layerId: string; path: string };
        definitions: boolean; uses: boolean; maxResults: number }) {
        expect(question.kind).toBe('strings.keys')
        const answer = keys.locations(question.key, question.document, question, question.maxResults)
        return { revision: '2', ...answer, documents: answer.documents.map(item => ({ ...item, uri: files.find(file => file.path === item.path)!.uri })) }
      },
    }
    const served = await sc2LayoutDefinition({ ...request(), workspaceDocuments: [], workspaceContext: { semanticComplete: true,
      modContext: { scope: 'chain', revision: '2', document: { layerId: 'mod', path: 'Base.SC2Data/UI/Layout/Score.SC2Layout' } } } } as never, modContexts)
    expect(served).toEqual(await sc2LayoutDefinition(request() as never))
  })

  it('renames the key in the catalogs and the layout, leaving literal text alone', async () => {
    expect(await sc2LayoutPrepareRename(request() as never)).toMatchObject({
      placeholder: 'UI/ScoreTitle',
    })
    const edit = await sc2LayoutRename(
      request({ newName: 'UI/ScoreHeading', maxEdits: 10 }) as never,
    )
    expect(edit?.documentChanges.map(change => [change.uri, change.edits.length])).toEqual([
      [english.uri, 1],
      [german.uri, 1],
      [layout.uri, 1],
    ])
    const renamed = applyDocumentEdits(
      layoutText,
      edit!.documentChanges.find(change => change.uri === layout.uri)!.edits,
    )
    expect(renamed).toContain('<Text val="@UI/ScoreHeading"/>')
    expect(renamed).toContain('<Tooltip val="UI/ScoreTitle"/>')
  })
})

describe('SC2Layout pictures and entity links', () => {
  const layoutText = [
    '<Desc>',
    '  <Frame type="Image" name="Border">',
    '    <Texture val="@@UI/PortraitBorder"/>',
    '  </Frame>',
    '  <Frame type="Image" name="Icon">',
    '    <Texture val="Assets\\Textures\\btn-unit-terran-marine.dds"/>',
    '  </Frame>',
    '  <Frame type="Label" name="Name">',
    '    <Text val="@Unit/Name/Marine"/>',
    '  </Frame>',
    '</Desc>',
    '',
  ].join('\n')
  const layout = document('Pictures.SC2Layout', layoutText)
  const assets = {
    uri: 'file:///fixture/Base.SC2Data/GameData/Assets.txt',
    languageId: 'sc2-strings',
    version: 1,
    text: 'UI/PortraitBorder=Assets\\Textures\\ui_portrait_border.dds\n',
  }
  const at = (needle: string, delta: number) => ({
    ...feature(layout, [layout, assets]),
    position: position(layoutText, needle, delta),
  })

  it('names the picture of a texture path and of an Assets key for the host to draw', async () => {
    expect((await sc2LayoutHover(at('@@UI/PortraitBorder', 6) as never))?.assets).toEqual([
      { path: 'Assets\\Textures\\ui_portrait_border.dds' },
    ])
    expect((await sc2LayoutHover(at('btn-unit', 2) as never))?.assets).toEqual([
      { path: 'Assets\\Textures\\btn-unit-terran-marine.dds' },
    ])
    const keys = await sc2LayoutCompletion(at('@@UI/PortraitBorder', '@@UI/'.length) as never)
    expect(keys.items.find(item => item.label === 'PortraitBorder')).toMatchObject({
      asset: { path: 'Assets\\Textures\\ui_portrait_border.dds' },
    })
  })

  // Parity plan 3.25: the id segment of `@Ns/Field/Id` renames the entity everywhere.
  it('renames the catalog entity from its id in @Ns/Field/Id, the key from the rest', async () => {
    const units = {
      uri: 'file:///fixture/Base.SC2Data/GameData/UnitData.xml',
      languageId: 'sc2-data',
      version: 4,
      text: '<Catalog>\n    <CUnit id="Marine"/>\n</Catalog>\n',
    }
    const strings = {
      uri: 'file:///fixture/enUS.SC2Data/LocalizedData/GameStrings.txt',
      languageId: 'sc2-strings',
      version: 2,
      text: 'Unit/Name/Marine=Marine\n',
    }
    const on = (delta: number, extra: Record<string, unknown> = {}) => ({
      ...feature(layout, [layout, assets, units, strings] as never),
      position: position(layoutText, '@Unit/Name/Marine', delta),
      ...extra,
    })
    expect(await sc2LayoutPrepareRename(on('@Unit/Name/'.length + 2) as never)).toMatchObject({ placeholder: 'Marine' })
    const edit = await sc2LayoutRename(on('@Unit/Name/'.length + 2, { newName: 'Trooper', maxEdits: 20 }) as never)
    const byUri = new Map(edit?.documentChanges.map(change => [change.uri, change.edits.map(item => item.newText)]))
    expect(byUri.get(units.uri)).toEqual(['Trooper'])
    expect(byUri.get(layout.uri)).toEqual(['Trooper'])
    expect([...byUri.keys()]).toContain(strings.uri)
    // The field segment is the string key's, as before.
    expect(await sc2LayoutPrepareRename(on(3) as never)).toMatchObject({ placeholder: 'Unit/Name/Marine' })
  })

  it('links an entity reference to its card, relation graph and resolved view', async () => {
    const units = {
      uri: 'file:///fixture/Base.SC2Data/GameData/UnitData.xml',
      languageId: 'sc2-data',
      version: 1,
      text: '<Catalog>\n    <CUnit id="Marine"/>\n</Catalog>\n',
    }
    const hover = await sc2LayoutHover({
      ...feature(layout, [layout, assets, units] as never),
      position: position(layoutText, 'Name/Marine', 7),
    } as never)
    expect(hover?.commands?.map(link => link.command)).toEqual([
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'card' },
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'graph' },
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'resolved' },
    ])
  })
})

describe('SC2Layout protocol-neutral language provider', () => {
  it('publishes every Product-GA feature through the common language contract', async () => {
    const lease = createProvider({ contract: 'common.language/document-analysis', major: 1 })
    expect(lease.value).toMatchObject({
      contract: 'common.language/document-analysis',
      languageIds: ['sc2-layout'],
      completion: expect.any(Function),
      hover: expect.any(Function),
      definition: expect.any(Function),
      references: expect.any(Function),
      prepareRename: expect.any(Function),
      rename: expect.any(Function),
      formatting: expect.any(Function),
      documentColors: expect.any(Function),
      colorPresentations: expect.any(Function),
      codeActions: expect.any(Function),
      documentSymbols: expect.any(Function),
      workspaceSymbols: expect.any(Function),
      diagnostics: expect.any(Function),
    })
    await lease.release()
  })

  it('finds schema-backed colors and offers decimal and hex presentations', async () => {
    const source = document(
      'Colors.SC2Layout',
      '<Desc>\n  <Constant name="Accent" val="255,16,32,48"/>\n  <Constant name="Hex" val="80402010"/>\n  <Include path="123456"/>\n</Desc>\n',
    )
    const request = feature(source, [source])
    const result = await sc2LayoutDocumentColors(request)
    expect(result).toMatchObject({ isIncomplete: false })
    expect(result.colors).toHaveLength(2)
    expect(result.colors[0]).toMatchObject({
      color: {
        red: 16 / 255,
        green: 32 / 255,
        blue: 48 / 255,
        alpha: 1,
      },
    })
    expect(result.colors[1]).toMatchObject({
      color: {
        red: 64 / 255,
        green: 32 / 255,
        blue: 16 / 255,
        alpha: 128 / 255,
      },
    })
    expect(source.text.slice(
      offsetAt(source.text, result.colors[0].range.start),
      offsetAt(source.text, result.colors[0].range.end),
    )).toBe('255,16,32,48')

    await expect(
      sc2LayoutColorPresentations({
        ...request,
        color: { red: 1, green: 0.5, blue: 0, alpha: 0.25 },
        range: result.colors[0].range,
      }),
    ).resolves.toEqual({
      presentations: [{ label: '64,255,128,0' }, { label: '40ff8000' }],
      isIncomplete: false,
    })
  })

  it('formats only the requested final newline', async () => {
    const source = document('StandardTemplates.SC2Layout', '<Desc></Desc>')
    const added = await sc2LayoutFormatting({
      ...feature(source, [source]),
      options: { tabSize: 2, insertSpaces: true, finalNewline: true },
    })
    expect(applyDocumentEdits(source.text, added.edits)).toBe('<Desc></Desc>\n')
    const withNewline = document('StandardTemplates.SC2Layout', '<Desc></Desc>\n')
    const removed = await sc2LayoutFormatting({
      ...feature(withNewline, [withNewline]),
      options: { tabSize: 2, insertSpaces: true, finalNewline: false },
    })
    expect(applyDocumentEdits(withNewline.text, removed.edits)).toBe('<Desc></Desc>')
  })

  it('offers a revision-bound source action for a missing final newline', async () => {
    const source = document('StandardTemplates.SC2Layout', '<Desc></Desc>', 7)
    const lease = createProvider({ contract: 'common.language/document-analysis', major: 1 })
    const end = { line: 0, character: source.text.length }
    const result = await lease.value.codeActions({
      ...feature(source, [source]),
      range: { start: end, end },
      diagnostics: [],
      maxEdits: 4,
    })
    expect(result).toEqual({
      actions: [expect.objectContaining({
        title: 'Add final newline',
        edit: expect.objectContaining({
          documentChanges: [expect.objectContaining({
            uri: source.uri,
            documentVersion: 7,
          })],
        }),
      })],
      isIncomplete: false,
    })
    await lease.release()
  })

  it('uses schema hints and resolves template definitions and references across includes', async () => {
    const tech = baseDocuments[1]
    const templateOffset = tech.text.indexOf('StandardTemplates/TechItemTemplate')
    const request = {
      ...feature(tech),
      position: position(tech.text, 'StandardTemplates/TechItemTemplate', 5),
    }
    const completion = await sc2LayoutCompletion(request)
    // A segment at a time (parity plan 3.14): the file first, then its descs after the `/`.
    expect(completion.items.map(item => item.label)).toContain('StandardTemplates')
    const inFile = await sc2LayoutCompletion({
      ...feature(tech),
      position: position(tech.text, 'StandardTemplates/TechItemTemplate', 'StandardTemplates/Tech'.length),
    })
    expect(inFile.items.map(item => item.label)).toContain('TechItemTemplate')
    expect(inFile.items.find(item => item.label === 'TechItemTemplate')?.replacementRange).toEqual({
      start: position(tech.text, 'TechItemTemplate'),
      end: position(tech.text, 'TechItemTemplate', 'TechItemTemplate'.length),
    })
    const hover = await sc2LayoutHover(request)
    expect(hover).toMatchObject({ provenance: expect.stringContaining('80ff763e') })
    expect(hover?.markdown).toContain('Frame.template')
    expect(hover?.markdown).toContain('Schema type: `DescTemplateName`')
    // Parity plan 3.22: what the template names — its type, full name and file.
    expect(hover?.markdown).toMatch(/Frame `\w+` `[^`]*TechItemTemplate` in `StandardTemplates\.SC2Layout`/u)

    const enumerated = await sc2LayoutHover({
      ...feature(tech),
      position: position(tech.text, 'side="Left"', 'side="'.length),
    })
    // On the value, the value it holds (parity plan 3.21); on the name, what it accepts, as MK2 listed.
    expect(enumerated?.markdown).toContain('**`Left`**')
    expect(enumerated?.markdown).not.toContain('- `Bottom`')
    const accepted = await sc2LayoutHover({ ...feature(tech), position: position(tech.text, 'side="Left"', 1) })
    expect(accepted?.markdown).toContain('- `Bottom`')
    expect(templateOffset).toBeGreaterThan(0)

    const definition = await sc2LayoutDefinition(request)
    expect(definition).toMatchObject({
      isIncomplete: false,
      locations: [{ uri: baseDocuments[0].uri }],
    })

    const standard = baseDocuments[0]
    const declarationRequest = {
      ...feature(standard),
      position: position(standard.text, 'TechItemTemplate', 4),
      includeDeclaration: true,
    }
    const references = await sc2LayoutReferences(declarationRequest)
    expect(references.locations).toHaveLength(7)
    expect(references.locations.map(item => item.uri)).toContain(tech.uri)
  })

  it("answers a definition from the layout's own declaration without indexing catalog links", async () => {
    const standard = baseDocuments[0]
    let reads = 0
    // A chain's catalogs: the mixed link index reads every one of them; a layout declaration needs none.
    const catalog = {
      uri: 'file:///fixture/UnitData.xml',
      languageId: 'sc2-data',
      version: 1,
      get text() {
        reads += 1
        return '<Catalog><CUnit id="Marine"/></Catalog>'
      },
    }
    const documents = [...baseDocuments, catalog] as unknown as readonly LayoutDocument[]
    // On a frame's own name the layout's declaration answers.
    const definition = await sc2LayoutDefinition({
      ...feature(standard, documents),
      position: position(standard.text, 'TechItemTemplate', 4),
    })
    expect(definition.locations.map(item => item.uri)).toEqual([standard.uri])
    expect(reads).toBe(0)
    // Where the layout itself declares nothing, the catalog links are still consulted.
    const tech = baseDocuments[1]
    await sc2LayoutDefinition({
      ...feature(tech, documents),
      position: position(tech.text, 'side="Left"', 'side="'.length),
    })
    expect(reads).toBeGreaterThan(0)
  })

  it("answers a definition from the mod server's layouts as the snapshot does", async () => {
    const { createLayoutServedDefinitions } = await import('../providers/language/served-definitions.js')
    const [standard, tech] = baseDocuments
    const standardPath = 'Base.SC2Data/UI/Layout/StandardTemplates.SC2Layout'
    const techPath = 'Base.SC2Data/UI/Layout/TechTreePanel.SC2Layout'
    const index = createLayoutServedDefinitions()
    await index.update([
      { layerId: 'core', path: standardPath, text: standard.text },
      { layerId: 'mine', path: techPath, text: tech.text },
    ], { layerId: 'mine', path: techPath })
    const at = position(tech.text, 'StandardTemplates/TechItemTemplate', 5)
    const snapshot = await sc2LayoutDefinition({ ...feature(tech), position: at })
    const served = index.definition('mine', techPath, tech.text.indexOf('StandardTemplates/TechItemTemplate') + 5)
    expect(served?.documents).toEqual([{ layerId: 'core', path: standardPath }])
    expect(served?.definitions.map(item => item.range)).toEqual(snapshot.locations.map(item => item.range))
    expect(index.definition('other', techPath, 0)).toBeUndefined()

    // The provider asks the server and names the documents by the URIs the host gives them.
    const uris = new Map([[standardPath, standard.uri], [techPath, tech.uri]])
    const questions: unknown[] = []
    const modContexts = {
      async query(_scope: string, question: { document: { layerId: string; path: string }; offset: number }) {
        questions.push(question)
        const answer = index.definition(question.document.layerId, question.document.path, question.offset)!
        return { revision: '7', ...answer, documents: answer.documents.map(item => ({ ...item, uri: uris.get(item.path) })) }
      },
    }
    const workspaceContext = { semanticComplete: true, modContext: { scope: 'chain', revision: '7', document: { layerId: 'mine', path: techPath } } }
    const answer = await sc2LayoutDefinition({ ...feature(tech, []), position: at, workspaceContext } as never, modContexts)
    expect(questions).toHaveLength(1)
    expect(answer).toEqual(snapshot)
    await expect(sc2LayoutDefinition({ ...feature(tech, []), position: at,
      workspaceContext: { ...workspaceContext, modContext: { ...workspaceContext.modContext, revision: '6' } } } as never, modContexts))
      .rejects.toThrow(/another revision/u)

    const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }, { modContexts }).value
    expect(provider.modContextFeatures).toEqual(['definition', 'hover', 'completion', 'diagnostics', 'references', 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols'])
    expect(await provider.modContextFeatureApplies({ feature: 'definition', document: tech, position: at })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'hover', document: tech, position: at })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'completion', document: tech, position: at })).toBe(false)
    const keyed = document('Score.SC2Layout', [
      '<Desc>',
      '  <Frame type="Label" name="Score">',
      '    <Text val="@UI/ScoreTitle"/>',
      '  </Frame>',
      '</Desc>',
      '',
    ].join('\n'))
    // A string key's definition comes from the server's catalogs (`strings.keys`); its hover
    expect(await provider.modContextFeatureApplies({ feature: 'definition', document: keyed,
      position: position(keyed.text, '@UI/ScoreTitle', 4) })).toBe(true)
    // The hover reads the string tables held by that same server.
    expect(await provider.modContextFeatureApplies({ feature: 'hover', document: keyed,
      position: position(keyed.text, '@UI/ScoreTitle', 4) })).toBe(true)
    expect(createProvider({ contract: 'common.language/document-analysis', major: 1 }).value.modContextFeatures).toBeUndefined()
  })

  it("answers a hover from the mod server's layouts and sheets as the snapshot does", async () => {
    const { createLayoutServedDefinitions } = await import('../providers/language/served-definitions.js')
    const [standard, tech] = baseDocuments
    const styled = document('Styled.SC2Layout', [
      '<Desc>',
      '  <Frame type="Label" name="Title" template="StandardTemplates/TechItemTemplate">',
      '    <Style val="@@Title"/>',
      '    <Width val="##ItemSize"/>',
      '  </Frame>',
      '</Desc>',
      '',
    ].join('\n'))
    const sheet = { uri: 'file:///fixture/FontStyles.SC2Style', languageId: 'sc2-style', version: 1,
      text: '<StyleFile>\n<Style name="Title" height="16" textcolor="ff00ff00"/>\n</StyleFile>\n' }
    const index = createLayoutServedDefinitions()
    await index.update([
      { layerId: 'core', path: 'Base.SC2Data/UI/Layout/StandardTemplates.SC2Layout', text: standard.text },
      { layerId: 'core', path: 'Base.SC2Data/UI/FontStyles.SC2Style', text: sheet.text },
      { layerId: 'mine', path: 'Base.SC2Data/UI/Layout/Styled.SC2Layout', text: styled.text },
    ], { layerId: 'mine', path: 'Base.SC2Data/UI/Layout/Styled.SC2Layout' })
    const modContexts = {
      async query(_scope: string, question: { document: { layerId: string; path: string }; offset: number }) {
        return { revision: '3', ...index.hover(question.document.layerId, question.document.path, question.offset) }
      },
    }
    const workspaceContext = { semanticComplete: true,
      modContext: { scope: 'chain', revision: '3', document: { layerId: 'mine', path: 'Base.SC2Data/UI/Layout/Styled.SC2Layout' } } }
    const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }, { modContexts }).value
    for (const [needle, delta] of [['TechItemTemplate', 3], ['@@Title', 3], ['##ItemSize', 3], ['type="Label"', 7], ['<Frame', 2]] as const) {
      const at = position(styled.text, needle, delta)
      const snapshot = await sc2LayoutHover({ ...feature(styled, [standard, styled, sheet] as never), position: at })
      expect(await provider.modContextFeatureApplies({ feature: 'hover', document: styled, position: at })).toBe(true)
      const served = await sc2LayoutHover({ ...feature(styled, []), position: at, workspaceContext } as never, modContexts)
      expect(served, needle).toEqual(snapshot)
      expect(snapshot?.markdown, needle).toBeTruthy()
    }
    expect(tech.uri).toBeTruthy()
  })

  it("reports a layout's diagnostics from the mod server as the snapshot does", async () => {
    const { createLayoutServedDefinitions } = await import('../providers/language/served-definitions.js')
    const { createServedLinkIndex, servedLinkUri } = await import('../../galaxy/language/served-links.js')
    const broken = document('Broken.SC2Layout')
    const catalog = { uri: 'file:///fixture/UnitData.xml', languageId: 'sc2-data', version: 1, text: '<Catalog><CUnit id="Marine"/></Catalog>' }
    const [standard] = baseDocuments
    const chain = [
      { layerId: 'core', path: 'Base.SC2Data/UI/Layout/StandardTemplates.SC2Layout', languageId: 'sc2-layout', text: standard.text },
      { layerId: 'core', path: 'Base.SC2Data/GameData/UnitData.xml', languageId: 'sc2-data', text: catalog.text },
      { layerId: 'mine', path: 'Base.SC2Data/UI/Layout/Broken.SC2Layout', languageId: 'sc2-layout', text: broken.text },
    ]
    const index = createLayoutServedDefinitions()
    await index.update(chain.filter(item => item.languageId === 'sc2-layout'), { layerId: 'mine', path: chain[2]!.path })
    const links = createServedLinkIndex(chain, false)
    const modContexts = {
      async query(_scope: string, question: { document: { layerId: string; path: string }; maxResults: number; incomplete: boolean }) {
        return { revision: '4', ...index.diagnostics(question.document.layerId, question.document.path, links,
          servedLinkUri(question.document.layerId, question.document.path), question)! }
      },
    }
    const snapshot = await sc2LayoutDiagnostics(feature(broken, [standard, broken, catalog] as never))
    expect(snapshot.diagnostics.length).toBeGreaterThan(0)
    const served = await sc2LayoutDiagnostics({ ...feature(broken, []), workspaceContext: { semanticComplete: true,
      modContext: { scope: 'chain', revision: '4', document: { layerId: 'mine', path: chain[2]!.path } } } } as never, modContexts)
    expect(served).toEqual(snapshot)
  })

  it("offers completions from the mod server's layouts and sheets as the snapshot does", async () => {
    const { createLayoutServedDefinitions } = await import('../providers/language/served-definitions.js')
    const [standard] = baseDocuments
    const text = [
      '<Desc>',
      '  <Frame type="Label" name="Title" template="StandardTemplates/Tech">',
      '    <Style val="Ti"/>',
      '    <Width val="##It"/>',
      '    <Text val="@UI/"/>',
      '  </Frame>',
      '  <Fr',
      '</Desc>',
      '',
    ].join('\n')
    const editing = document('Editing.SC2Layout', text)
    const sheet = { uri: 'file:///fixture/FontStyles.SC2Style', languageId: 'sc2-style', version: 1,
      text: '<StyleFile>\n<Style name="Title" height="16"/>\n<Style name="Tiny"/>\n</StyleFile>\n' }
    const index = createLayoutServedDefinitions()
    const editingPath = 'Base.SC2Data/UI/Layout/Editing.SC2Layout'
    await index.update([
      { layerId: 'core', path: 'Base.SC2Data/UI/Layout/StandardTemplates.SC2Layout', text: standard.text },
      { layerId: 'core', path: 'Base.SC2Data/UI/FontStyles.SC2Style', text: sheet.text },
      { layerId: 'mine', path: editingPath, text },
    ], { layerId: 'mine', path: editingPath })
    const modContexts = {
      async query(_scope: string, question: { document: { layerId: string; path: string }; offset: number; maxResults: number }) {
        return { revision: '5', ...index.completion(question.document.layerId, question.document.path, question.offset, question.maxResults) }
      },
    }
    const workspaceContext = { semanticComplete: true,
      modContext: { scope: 'chain', revision: '5', document: { layerId: 'mine', path: editingPath } } }
    const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }, { modContexts }).value
    for (const [needle, delta] of [
      ['StandardTemplates/Tech', 'StandardTemplates/Tech'.length], ['StandardTemplates/Tech', 4], ['"Ti"', 3],
      ['##It', 4], ['"Label"', 3], ['name="Title"', 2], ['<Fr', 3],
    ] as const) {
      const at = position(text, needle, delta)
      expect(await provider.modContextCompletionApplies({ document: editing, position: at }), needle).toBe(true)
      const snapshot = await sc2LayoutCompletion({ ...feature(editing, [standard, editing, sheet] as never), position: at })
      const served = await sc2LayoutCompletion({ ...feature(editing, []), position: at, workspaceContext } as never, modContexts)
      expect(served, needle).toEqual(snapshot)
      expect(snapshot.items.length, needle).toBeGreaterThan(0)
    }
    // String tables are now held by the server too.
    expect(await provider.modContextCompletionApplies({ document: editing, position: position(text, '@UI/', 4) })).toBe(true)
    // The bound is the request's.
    const capped = await sc2LayoutCompletion({ ...feature(editing, []), maxResults: 1, position: position(text, '<Fr', 3),
      workspaceContext } as never, modContexts)
    expect(capped).toMatchObject({ isIncomplete: true, items: [expect.anything()] })
  })

  it('resolves a file-qualified template and a racial constant without an Include', async () => {
    // The game loads every layout of the mod, so `File/Frame` and `##Name` reach files this one
    // never includes; only the include-reachable scope used to be searched.
    const standalone = document(
      'Standalone.SC2Layout',
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Desc>',
        '  <Frame type="Image" name="Lone" template="StandardTemplates/TechItemTemplate">',
        '    <Width val="##ItemSize"/>',
        '  </Frame>',
        '</Desc>',
        '',
      ].join('\n'),
    )
    const documents = [baseDocuments[0], standalone]
    const definition = await sc2LayoutDefinition({
      ...feature(standalone, documents),
      position: position(standalone.text, 'StandardTemplates/TechItemTemplate', 5),
    })
    expect(definition.locations.map(item => item.uri)).toEqual([baseDocuments[0].uri])

    const constant = await sc2LayoutDefinition({
      ...feature(standalone, documents),
      position: position(standalone.text, '##ItemSize', 4),
    })
    expect(constant.locations.map(item => item.uri)).toEqual([baseDocuments[0].uri])

    const diagnostics = await sc2LayoutDiagnostics(feature(standalone, documents))
    expect(diagnostics.diagnostics.map(item => item.message)).toEqual([])
  })

  it('offers frame handles and only kinds the contract defines', async () => {
    const tech = baseDocuments[1]
    const completion = await sc2LayoutCompletion({
      ...feature(tech),
      position: position(tech.text, 'relative="$parent"', 'relative="'.length),
    })
    expect(completion.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['$parent', '$this', '$sibling']),
    )
    // One item outside this vocabulary makes the host reject the whole list.
    const kinds = new Set([
      'class', 'constant', 'enum', 'field', 'function', 'interface', 'keyword', 'module',
      'namespace', 'parameter', 'property', 'snippet', 'struct', 'text', 'type', 'variable',
    ])
    expect(completion.items.filter(item => !kinds.has(item.kind))).toEqual([])
  })

  it('outlines a document from its own text alone, as it does with the whole workspace', async () => {
    // documentLocalFeatures: the host sends only the live document (owner decision 10.10).
    for (const current of baseDocuments) {
      const whole = await sc2LayoutDocumentSymbols(feature(current))
      const alone = await sc2LayoutDocumentSymbols(feature(current, [current]))
      expect(alone).toEqual(whole)
      expect(whole.symbols.length).toBeGreaterThan(0)
    }
    expect(createProvider({ contract: 'common.language/document-analysis', major: 1 }).value.documentLocalFeatures)
      .toEqual(['documentSymbols', 'formatting', 'onTypeFormatting', 'codeActions', 'documentColors', 'colorPresentations'])
  })

  it('returns nested document symbols, bounded workspace symbols, and honest diagnostics', async () => {
    const symbols = await sc2LayoutDocumentSymbols(feature(baseDocuments[1]))
    expect(symbols.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'CategoryFrame_Nod', kind: 'struct' }),
      ]),
    )
    const category = symbols.symbols.find(item => item.name === 'CategoryFrame_Nod')
    expect(category?.children?.map(item => item.name)).toEqual(
      expect.arrayContaining(['NodConstructionYard', 'NodCrane', 'LineH1']),
    )

    const workspaceSymbols = await sc2LayoutWorkspaceSymbols({
      ...feature(baseDocuments[1]),
      query: 'Nod',
    })
    expect(workspaceSymbols.symbols.length).toBeGreaterThanOrEqual(6)
    expect(workspaceSymbols.isIncomplete).toBe(false)

    const broken = document('Broken.SC2Layout')
    const diagnostics = await sc2LayoutDiagnostics(feature(broken, [broken]))
    expect(diagnostics.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sc2-layout/schema/'),
        'sc2-layout/unresolved-include',
        'sc2-layout/unresolved-template',
      ]),
    )
  })

  it('makes a conservative complete workspace rename that the normal writer validates and reopens', async () => {
    const standard = baseDocuments[0]
    const prepareRequest = {
      ...feature(standard),
      position: position(standard.text, 'TechItemTemplate', 4),
    }
    expect(await sc2LayoutPrepareRename(prepareRequest)).toMatchObject({
      placeholder: 'TechItemTemplate',
    })
    const edit = await sc2LayoutRename({
      ...prepareRequest,
      newName: 'TechItemRenamed',
      maxEdits: 32,
    })
    expect(edit?.isComplete).toBe(true)
    expect(edit?.documentChanges).toHaveLength(2)
    const renamed = new Map(
      edit?.documentChanges.map(change => {
        const original = baseDocuments.find(item => item.uri === change.uri)
        return [
          change.uri,
          document(
            change.uri.split('/').at(-1),
            applyDocumentEdits(original.text, change.edits),
            2,
          ),
        ]
      }),
    )
    const renamedStandard = renamed.get(standard.uri)
    const renamedTech = renamed.get(baseDocuments[1].uri)
    expect(renamedStandard.text).toContain('name="TechItemRenamed"')
    expect(renamedTech.text.match(/StandardTemplates\/TechItemRenamed/gu)).toHaveLength(6)

    const writerContext = {
      budgets: {
        maxInputBytes: 1_000_000n,
        maxDepth: 64,
        maxNodes: 100_000,
        maxScalarBytes: 1_000_000,
        maxDiagnostics: 1000,
      },
    }
    const writerLease = createWriterProvider(
      { contract: 'common.edit/writer', major: 1, offerId: 'sc2-layout-source' },
      writerContext,
    )
    const target = { targetId: 'layout', ownerSource: { id: renamedTech.uri } }
    const change = {
      targets: [target],
      edits: [
        {
          operation: 'replace',
          targetId: 'layout',
          source: { id: renamedTech.uri },
          payload: { kind: 'text', text: renamedTech.text },
        },
      ],
      semanticIntent: {
        kind: 'sc2-authored-text-save-v1',
        formatId: 'sc2-layout',
        sourceComplete: true,
        unknownDataPolicy: 'preserve-from-complete-snapshot',
      },
    }
    const validation = await writerLease.value.validate(change)
    expect(validation.valid).toBe(true)
    await expect(writerLease.value.plan(change)).resolves.toMatchObject({
      fidelity: { roundTrip: 'byte-identical', preservesUnknownData: true },
    })

    const reopened = await previewSc2Layout({
      document: renamedTech,
      workspaceDocuments: [renamedStandard, renamedTech],
      rootPath: 'CategoryFrame_Nod',
    })
    expect(reopened.completeness).toBe('partial')
    expect(reopened.diagnostics).toContainEqual(
      expect.objectContaining({ code: expect.stringContaining('sc2-layout/schema/') }),
    )
    expect(reopened.fidelity.resolvedFrames).toBeGreaterThan(12)
    await writerLease.release()
  })

  it('refuses rename for partial workspaces, invalid names, cancellation, and result overflow', async () => {
    const standard = baseDocuments[0]
    const request = {
      ...feature(standard),
      position: position(standard.text, 'TechItemTemplate', 4),
      workspaceIncomplete: true,
      newName: 'Nope',
      maxEdits: 32,
    }
    await expect(sc2LayoutRename(request)).resolves.toBeUndefined()
    await expect(
      sc2LayoutRename({ ...request, workspaceIncomplete: false, newName: 'bad name' }),
    ).resolves.toBeUndefined()
    await expect(
      sc2LayoutRename({ ...request, workspaceIncomplete: false, maxEdits: 1 }),
    ).resolves.toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    await expect(
      sc2LayoutDefinition({ ...request, workspaceIncomplete: false, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/*
 * Parity plan 3.31: the workspace and schema index are kept per revision of the snapshot's layouts,
 * so a request after an edit must see the edit, and an aborted request must not poison the next.
 */
describe('SC2Layout workspace kept per revision', () => {
  const text = (name: string) =>
    ['<Desc>', `  <Frame type="Frame" name="${name}">`, '  </Frame>', '</Desc>', ''].join('\n')
  const names = async (version: number, name: string, signal?: AbortSignal) => {
    const current = document('Revision.SC2Layout', text(name), version)
    const symbols = await sc2LayoutDocumentSymbols({
      ...feature(current, [current, ...baseDocuments]),
      ...(signal === undefined ? {} : { signal }),
    } as never)
    return symbols.symbols.map(item => item.name)
  }

  it('answers each revision from its own text', async () => {
    expect(await names(1, 'First')).toContain('First')
    expect(await names(1, 'First')).toContain('First')
    const edited = await names(2, 'Second')
    expect(edited).toContain('Second')
    expect(edited).not.toContain('First')
    const controller = new AbortController()
    controller.abort()
    await expect(names(3, 'Third', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await names(3, 'Third')).toContain('Third')
  })
})

// Parity plan 3.14: `file=` and an Include name the other layout files of the snapshot.
describe('SC2Layout file and include values', () => {
  const at = (uri: string, text: string) => ({ uri, languageId: 'sc2-layout', version: 1, text })
  const hudText = [
    '<Desc>',
    '  <Include path=""/>',
    '  <Frame type="Frame" name="Panel" file=""/>',
    '</Desc>',
    '',
  ].join('\n')
  const hud = at('file:///mod/Base.SC2Data/UI/Layout/Hud.SC2Layout', hudText)
  const templates = at(
    'file:///mod/Base.SC2Data/UI/Layout/Templates.SC2Layout',
    '<Desc>\n  <Frame type="Frame" name="Base"/>\n</Desc>\n',
  )
  const request = (needle: string) => ({
    ...feature(hud as never, [hud, templates] as never),
    position: position(hudText, needle, needle.length - 1),
  })

  it('offers the other files for file= and their data paths for an Include', async () => {
    const files = await sc2LayoutCompletion(request('file=""') as never)
    const offered = files.items.filter(item => item.kind === 'struct').map(item => item.label)
    expect(offered).toContain('Templates')
    expect(offered).not.toContain('Hud')
    const includes = await sc2LayoutCompletion(request('path=""') as never)
    const paths = includes.items.filter(item => item.kind === 'module').map(item => item.label)
    expect(paths).toEqual(['UI/Layout/Templates.SC2Layout'])
  })
})

/*
 * A frame reference names a frame by a path from its own frame (`$parent/Title`, `frame="Title"`).
 * Core alone has hundreds of frames called Title, so references and rename follow the path through
 * the schema store, not the last segment's text.
 */
describe('SC2Layout frame references by path', () => {
  const core = document(
    'Core.SC2Layout',
    [
      '<Desc>',
      '    <Frame type="Frame" name="CorePanel">',
      '        <Frame type="Label" name="Title"/>',
      '        <Frame type="Frame" name="Body">',
      '            <Anchor side="Top" relative="$parent/Title" pos="Max" offset="4"/>',
      '        </Frame>',
      '    </Frame>',
      '    <Frame type="Frame" name="TitledTemplate">',
      '        <Frame type="Label" name="Title"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join('\n'),
  )
  const mod = document(
    'Mod.SC2Layout',
    [
      '<Desc>',
      '    <Frame type="Frame" name="ModPanel">',
      '        <Frame type="Label" name="Title"/>',
      '        <Frame type="Frame" name="Body">',
      '            <Anchor side="Top" relative="$parent/Title" pos="Max" offset="4"/>',
      '            <Frame type="Frame" name="Inner">',
      '                <Anchor side="Top" relative="$parent/$parent/Title" pos="Max" offset="0"/>',
      '            </Frame>',
      '        </Frame>',
      '        <StateGroup name="Mode">',
      '            <State name="On">',
      '                <Action type="SetProperty" frame="Title" Visible="true"/>',
      '            </State>',
      '        </StateGroup>',
      '    </Frame>',
      '    <Frame type="Frame" name="Holder">',
      '        <Frame type="Frame" name="Group">',
      '            <Frame type="Label" name="Caption"/>',
      '        </Frame>',
      '        <Frame type="Frame" name="Below">',
      '            <Anchor side="Top" relative="$parent/Group/Caption" pos="Max" offset="0"/>',
      '        </Frame>',
      '    </Frame>',
      '    <Frame type="Frame" name="Card" template="Core/TitledTemplate">',
      '        <Anchor side="Left" relative="$this/Title" pos="Min" offset="0"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join('\n'),
  )
  const documents = [core, mod]
  const nth = (text: string, needle: string, index: number) => {
    let offset = -1
    for (let i = 0; i <= index; i++) offset = text.indexOf(needle, offset + 1)
    return offset
  }
  const at = (current: LayoutDocument, needle: string, delta: number, index = 0) => {
    const before = current.text.slice(0, nth(current.text, needle, index) + delta).split('\n')
    return { line: before.length - 1, character: before.at(-1)?.length ?? 0 }
  }
  const renamed = async (current: LayoutDocument, needle: string, delta: number, newName: string, index = 0, among = documents) => {
    const edit = await sc2LayoutRename({
      ...feature(current, among),
      position: at(current, needle, delta, index),
      newName,
      maxEdits: 32,
    })
    if (edit === undefined) return undefined
    return new Map(
      edit.documentChanges.map(change => [
        change.uri.split('/').at(-1),
        applyDocumentEdits(among.find(item => item.uri === change.uri)!.text, change.edits),
      ]),
    )
  }

  it("renames a frame and the paths that reach it, not another file's frame of the same name", async () => {
    const result = await renamed(mod, 'name="Title"', 'name="'.length + 1, 'Heading')
    expect([...(result?.keys() ?? [])]).toEqual(['Mod.SC2Layout'])
    const text = result!.get('Mod.SC2Layout')!
    expect(text).toContain('<Frame type="Label" name="Heading"/>')
    expect(text).toContain('relative="$parent/Heading" pos="Max" offset="4"')
    expect(text).toContain('relative="$parent/$parent/Heading"')
    expect(text).toContain('frame="Heading"')
    // The template's own Title is another frame: the instance path to it stays.
    expect(text).toContain('relative="$this/Title"')
  })

  it('renames from a reference the frame its path reaches', async () => {
    const result = await renamed(core, 'relative="$parent/Title"', 'relative="$parent/'.length + 1, 'Caption')
    expect([...(result?.keys() ?? [])]).toEqual(['Core.SC2Layout'])
    const text = result!.get('Core.SC2Layout')!
    expect(text).toContain('<Frame type="Frame" name="CorePanel">\n        <Frame type="Label" name="Caption"/>')
    expect(text).toContain('relative="$parent/Caption"')
    expect(text.match(/name="Title"/gu)).toHaveLength(1)
  })

  it('renames a middle segment of a path', async () => {
    const result = await renamed(mod, 'name="Group"', 'name="'.length + 1, 'Grouping')
    const text = result!.get('Mod.SC2Layout')!
    expect(text).toContain('name="Grouping"')
    expect(text).toContain('relative="$parent/Grouping/Caption"')
  })

  it('reaches a template child through the instance that inherits it', async () => {
    const result = await renamed(core, 'name="Title"', 'name="'.length + 1, 'Header', 1)
    expect(result?.get('Core.SC2Layout')).toContain('<Frame type="Frame" name="TitledTemplate">\n        <Frame type="Label" name="Header"/>')
    const text = result!.get('Mod.SC2Layout')!
    expect(text).toContain('relative="$this/Header"')
    expect(text).toContain('relative="$parent/Title" pos="Max" offset="4"')
  })

  it('finds the references of one frame only', async () => {
    const references = await sc2LayoutReferences({
      ...feature(core),
      position: at(core, 'name="Title"', 'name="'.length + 1),
      includeDeclaration: true,
    })
    expect(references.locations.map(item => [item.uri.split('/').at(-1), item.range.start.line])).toEqual([
      ['Core.SC2Layout', 2],
      ['Core.SC2Layout', 4],
    ])
    expect(references.isIncomplete).toBe(false)
  })

  it('refuses rename and marks references incomplete when a path with the name reaches no frame', async () => {
    const broken = document(
      'Broken.SC2Layout',
      [
        '<Desc>',
        '    <Frame type="Frame" name="Lonely">',
        '        <Anchor side="Top" relative="$parent/Title" pos="Min" offset="0"/>',
        '    </Frame>',
        '</Desc>',
        '',
      ].join('\n'),
    )
    const among = [...documents, broken]
    expect(await renamed(mod, 'name="Title"', 'name="'.length + 1, 'Heading', 0, among)).toBeUndefined()
    const references = await sc2LayoutReferences({
      ...feature(mod, among),
      position: at(mod, 'name="Title"', 'name="'.length + 1),
      includeDeclaration: true,
    })
    expect(references.isIncomplete).toBe(true)
    expect(references.locations.length).toBeGreaterThan(1)
  })
})

/*
 * A template's frame takes its `$parent` from the frame the template is used under, so a path inside
 * a template reaches nothing from the template itself: its instances decide which frame it names.
 */
describe('SC2Layout frame paths inside templates', () => {
  const templates = document(
    'Templates.SC2Layout',
    [
      '<Desc>',
      '    <Frame type="Frame" name="ItemTemplate">',
      '        <Frame type="Image" name="Icon">',
      '            <Anchor side="Top" relative="$parent/$parent/Backdrop" pos="Min" offset="0"/>',
      '        </Frame>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join('\n'),
  )
  const panels = document(
    'Panels.SC2Layout',
    [
      '<Desc>',
      '    <Frame type="Frame" name="Panel">',
      '        <Frame type="Image" name="Backdrop"/>',
      '        <Frame type="Frame" name="Item" template="Templates/ItemTemplate"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join('\n'),
  )
  const other = document(
    'Other.SC2Layout',
    [
      '<Desc>',
      '    <Frame type="Frame" name="OtherPanel">',
      '        <Frame type="Image" name="Backdrop"/>',
      '        <Frame type="Frame" name="Item" template="Templates/ItemTemplate"/>',
      '    </Frame>',
      '</Desc>',
      '',
    ].join('\n'),
  )
  const rename = (among: readonly LayoutDocument[]) =>
    sc2LayoutRename({
      ...feature(panels, among),
      position: position(panels.text, 'name="Backdrop"', 'name="'.length + 1),
      newName: 'Shade',
      maxEdits: 16,
    })

  it('renames the path in a template when every instance reaches the frame', async () => {
    const among = [templates, panels]
    const edit = await rename(among)
    const texts = new Map(
      edit!.documentChanges.map(change => [
        change.uri.split('/').at(-1),
        applyDocumentEdits(among.find(item => item.uri === change.uri)!.text, change.edits),
      ]),
    )
    expect(texts.get('Panels.SC2Layout')).toContain('<Frame type="Image" name="Shade"/>')
    expect(texts.get('Templates.SC2Layout')).toContain('relative="$parent/$parent/Shade"')
  })

  it('refuses when instances of the template reach different frames of that name', async () => {
    expect(await rename([templates, panels, other])).toBeUndefined()
    const references = await sc2LayoutReferences({
      ...feature(panels, [templates, panels, other]),
      position: position(panels.text, 'name="Backdrop"', 'name="'.length + 1),
      includeDeclaration: true,
    })
    expect(references.isIncomplete).toBe(true)
  })
})
