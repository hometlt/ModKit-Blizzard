import { describe, expect, it } from 'vitest'
import { referenceTargetKey } from '@modkit/sdk'
import {
  galaxyDefinition,
  galaxyDiagnostics,
  galaxyPrepareRename,
  galaxyReferences,
  galaxyRename,
} from '../modules/galaxy/language/semantic-provider.js'
import { createProvider as createGalaxyProvider } from '../modules/galaxy/language/provider.js'
import { sc2DataDefinition, sc2DataReferences } from '../modules/data/providers/language/runtime.js'
import { sc2LayoutDefinition } from '../modules/layout/providers/language/runtime.js'
import { styleReferenceOccurrenceBatches } from '../modules/style/providers/language/src/style-names.js'
import {
  createProvider as createTriggersProvider,
  sc2TriggersCompletion,
  sc2TriggersDefinition,
  sc2TriggersDocumentSymbols,
  sc2TriggersFormatting,
  sc2TriggersPrepareRename,
  sc2TriggersRename,
  sc2TriggersSignatureHelp,
  sc2TriggersWorkspaceSymbols,
} from '../modules/triggers/providers/language/runtime.js'

const data = Object.freeze({
  uri: 'file:///Base.SC2Data/GameData/FixtureData.xml',
  languageId: 'sc2-data',
  version: 4,
  text: '<Catalog><CUnit id="Marine"/><CButton id="Cancel"/></Catalog>',
})
const galaxy = Object.freeze({
  uri: 'file:///MapScript.galaxy',
  languageId: 'galaxy',
  version: 2,
  text: 'void Init() { point p; UnitCreate(1, "Marine", 0, 1, p, 0.0); }',
})
const triggers = Object.freeze({
  uri: 'file:///Triggers',
  languageId: 'sc2-triggers',
  version: 3,
  text: [
    '<TriggerData><Library Id="Test"><Element Type="Param" Id="P">',
    '<Value>Marine</Value><ValueType Type="gamelink"/>',
    '<ValueGameType Type="Unit"/></Element></Library></TriggerData>',
  ].join(''),
})
const layout = Object.freeze({
  uri: 'file:///Base.SC2Data/UI/Layout/Test.SC2Layout',
  languageId: 'sc2-layout',
  version: 5,
  text: '<Desc><Frame type="Button" name="Close"><Shortcut val="@Button/Hotkey/Cancel"/></Frame></Desc>',
})
const strings = Object.freeze({
  uri: 'file:///enUS.SC2Data/LocalizedData/GameStrings.txt',
  languageId: 'sc2-strings',
  version: 6,
  text: 'Unit/Name/Marine=Marine\nButton/Hotkey/Cancel=Escape',
})
const documents = Object.freeze([galaxy, triggers, layout, strings, data])

function position(document: (typeof documents)[number], needle: string, delta = 1) {
  const offset = document.text.indexOf(needle) + delta
  const lines = document.text.slice(0, offset).split('\n')
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

const feature = (document: (typeof documents)[number], needle: string) => ({
  document,
  workspaceDocuments: documents,
  workspaceIncomplete: false,
  maxResults: 64,
  maxDocuments: 8,
  position: position(document, needle),
})

describe('SC2 bounded mixed-language catalog links', () => {
  it('jumps from literal Galaxy, TriggerData and Layout publisher references to SC2 Data', async () => {
    await expect(galaxyDefinition(feature(galaxy, 'Marine'))).resolves.toMatchObject({
      locations: [{ uri: data.uri }],
      isIncomplete: false,
    })
    await expect(sc2TriggersDefinition(feature(triggers, 'Marine'))).resolves.toMatchObject({
      locations: [{ uri: data.uri }],
      isIncomplete: false,
    })
    await expect(sc2LayoutDefinition(feature(layout, 'Cancel'))).resolves.toMatchObject({
      locations: [{ uri: data.uri }],
      isIncomplete: false,
    })
    await expect(sc2DataDefinition(feature(data, 'Marine'))).resolves.toMatchObject({
      locations: [{ uri: data.uri }],
    })
  })

  it('reports all proven usages of a data declaration across languages', async () => {
    const fromGalaxy = await galaxyReferences({
      ...feature(galaxy, 'Marine'),
      includeDeclaration: true,
    })
    expect(fromGalaxy.locations.map(item => item.uri)).toEqual([
      data.uri,
      galaxy.uri,
      triggers.uri,
      strings.uri,
    ])

    const fromData = await sc2DataReferences({
      ...feature(data, 'Marine'),
      includeDeclaration: true,
    })
    expect(fromData.locations.map(item => item.uri)).toEqual([
      data.uri,
      galaxy.uri,
      triggers.uri,
      strings.uri,
    ])
  })

  it('keeps proven cross-language references while the Data document has an unfinished tag', async () => {
    const editing = {
      ...data,
      text: '<Catalog><CUnit id="Marine"><\n</CUnit></Catalog>',
    }
    const result = await sc2DataReferences({
      ...feature(data, 'Marine'),
      document: editing,
      workspaceDocuments: documents.map(document => document === data ? editing : document),
      position: position(editing as typeof data, 'Marine'),
      includeDeclaration: true,
    })
    expect(result.locations.map(item => item.uri)).toEqual([
      data.uri, galaxy.uri, triggers.uri, strings.uri,
    ])
    expect(result.isIncomplete).toBe(true)
  })

  it('finds targeted usages after an unrelated dependency exhausts the bulk link index', async () => {
    const dependency = {
      ...data, uri: 'file:///dependency/UnitData.xml',
      text: `<Catalog>${Array.from({ length: 50_001 }, (_, i) => `<CUnit id="Dependency${i}"/>`).join('')}</Catalog>`,
    }
    const result = await sc2DataReferences({
      ...feature(data, 'Marine'),
      workspaceDocuments: [dependency, ...documents],
      includeDeclaration: true,
    })
    expect(result.locations.map(item => item.uri)).toEqual([
      data.uri, galaxy.uri, triggers.uri, strings.uri,
    ])
    // The bulk graph is partial even when a targeted read finds these usages.
    expect(result.isIncomplete).toBe(true)
  })

  it('renames a proven Galaxy catalog literal across Data, Triggers and Strings', async () => {
    const preparation = await galaxyPrepareRename(feature(galaxy, 'Marine'))
    expect(preparation?.placeholder).toBe('Marine')
    const edit = await galaxyRename({
      ...feature(galaxy, 'Marine'),
      newName: 'Marauder',
      maxEdits: 8,
    })
    expect(edit?.isComplete).toBe(true)
    expect(edit?.documentChanges.map(change => [change.uri, change.documentVersion])).toEqual([
      [data.uri, 4],
      [strings.uri, 6],
      [galaxy.uri, 2],
      [triggers.uri, 3],
    ])
    expect(edit?.documentChanges.flatMap(change => change.edits).map(item => item.newText)).toEqual([
      'Marauder',
      'Marauder',
      'Marauder',
      'Marauder',
    ])
  })

  it('publishes TriggerData completion, symbols, formatting and safe semantic rename', async () => {
    const request = feature(triggers, 'Marine')
    await expect(sc2TriggersCompletion(request)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ label: 'Marine' })]),
      isIncomplete: false,
    })
    await expect(sc2TriggersPrepareRename(request)).resolves.toMatchObject({
      placeholder: 'Marine',
    })
    await expect(sc2TriggersRename({
      ...request,
      newName: 'Marauder',
      maxEdits: 8,
    })).resolves.toMatchObject({ isComplete: true })
    await expect(sc2TriggersRename({
      ...request,
      workspaceIncomplete: true,
      newName: 'Marauder',
      maxEdits: 8,
    })).resolves.toBeUndefined()
    await expect(sc2TriggersDocumentSymbols(request)).resolves.toMatchObject({
      symbols: [expect.objectContaining({ name: 'Test', kind: 'module' })],
      isIncomplete: false,
    })
    await expect(sc2TriggersWorkspaceSymbols({ ...request, query: 'p' })).resolves.toMatchObject({
      symbols: expect.arrayContaining([expect.objectContaining({ name: 'P' })]),
      isIncomplete: false,
    })
    await expect(sc2TriggersFormatting({
      ...request,
      options: { tabSize: 2, insertSpaces: true, finalNewline: true },
    })).resolves.toMatchObject({
      edits: [expect.objectContaining({ newText: '\n' })],
      isComplete: true,
    })
  })

  it('resolves TriggerData FunctionCall signatures through the structured workspace model', async () => {
    const signatureDocument = Object.freeze({
      uri: 'file:///Signature.Triggers',
      languageId: 'sc2-triggers',
      version: 1,
      text: [
        '<TriggerData><Library Id="Test">',
        '<Element Type="ParamDef" Id="Amount"><Identifier>amount</Identifier><ParameterType><Type Value="int"/></ParameterType></Element>',
        '<Element Type="ParamDef" Id="Target"><Identifier>target</Identifier><ParameterType><Type Value="unit"/></ParameterType></Element>',
        '<Element Type="FunctionDef" Id="Do"><Identifier>DoThing</Identifier><Parameter Type="ParamDef" Library="Test" Id="Amount"/><Parameter Type="ParamDef" Library="Test" Id="Target"/></Element>',
        '<Element Type="FunctionCall" Id="Call"><FunctionDef Type="FunctionDef" Library="Test" Id="Do"/><Parameter Type="Param" Id="One"/><Parameter Type="Param" Id="Two"/></Element>',
        '</Library></TriggerData>',
      ].join(''),
    })
    const offset = signatureDocument.text.indexOf('Id="Two"') + 4
    const request = {
      document: signatureDocument,
      workspaceDocuments: [signatureDocument],
      workspaceIncomplete: false,
      maxResults: 64,
      maxDocuments: 8,
      position: { line: 0, character: offset },
    }
    await expect(sc2TriggersSignatureHelp(request)).resolves.toMatchObject({
      activeParameter: 1,
      signatures: [{
        label: 'void DoThing(int amount, unit target)',
        parameters: [{ label: 'int amount' }, { label: 'unit target' }],
      }],
    })
  })

  it('keeps dynamic and ambiguous strings partial instead of guessing a catalog target', async () => {
    const dynamic = Object.freeze({
      ...galaxy,
      uri: 'file:///Dynamic.galaxy',
      text: 'void Init(string unitType) { point p; UnitCreate(1, unitType, 0, 1, p, 0.0); }',
    })
    const dynamicRequest = {
      ...feature(dynamic, 'unitType, 0'),
      workspaceDocuments: [dynamic, data],
      maxDocuments: 4,
    }
    await expect(galaxyDefinition(dynamicRequest)).resolves.toMatchObject({
      locations: [{ uri: dynamic.uri }],
      isIncomplete: false,
    })
    const diagnostics = await galaxyDiagnostics(dynamicRequest)
    expect(diagnostics.diagnostics.map(item => item.code)).toContain(
      'sc2-cross-language/dynamic-galaxy-gamelink',
    )
    expect(diagnostics.isIncomplete).toBe(true)

    const duplicate = Object.freeze({
      ...data,
      uri: 'file:///Dependency.SC2Data/GameData/UnitData.xml',
      text: '<Catalog><CUnit id="Marine"/></Catalog>',
    })
    const ambiguous = {
      ...feature(galaxy, 'Marine'),
      workspaceDocuments: [galaxy, data, duplicate],
      maxDocuments: 4,
    }
    await expect(galaxyDefinition(ambiguous)).resolves.toEqual({
      locations: [],
      isIncomplete: false,
    })
    const ambiguousDiagnostics = await galaxyDiagnostics(ambiguous)
    expect(ambiguousDiagnostics.diagnostics.map(item => item.code)).toContain(
      'sc2-cross-language/ambiguous-catalog-literal',
    )
  })

  it('registers mixed snapshots explicitly on existing providers instead of a second LSP', async () => {
    const galaxyLease = createGalaxyProvider({
      contract: 'common.language/document-analysis',
      major: 1,
    })
    const triggerLease = createTriggersProvider({
      contract: 'common.language/document-analysis',
      major: 1,
    })
    expect(galaxyLease.value.workspaceLanguageIds).toEqual([
      'galaxy',
      'sc2-data',
      'sc2-layout',
      'sc2-map-objects',
      'sc2-map-preload',
      'sc2-strings',
      'sc2-triggers',
    ])
    expect(triggerLease.value.workspaceLanguageIds).toEqual(galaxyLease.value.workspaceLanguageIds)
    expect(triggerLease.value).toEqual(expect.objectContaining({
      codeActions: expect.any(Function),
      completion: expect.any(Function),
      formatting: expect.any(Function),
      prepareRename: expect.any(Function),
      rename: expect.any(Function),
      documentSymbols: expect.any(Function),
      workspaceSymbols: expect.any(Function),
    }))
    await expect(triggerLease.value.codeActions({
      ...feature(triggers, 'Marine'),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: triggers.text.length } },
      diagnostics: [],
      maxEdits: 4,
    })).resolves.toMatchObject({
      actions: [{ title: 'Add final newline', edit: { documentChanges: [{ documentVersion: 3 }] } }],
      isIncomplete: false,
    })
    await expect(triggerLease.value.analyze({ document: triggers })).resolves.toMatchObject({
      documentUri: triggers.uri,
      symbols: expect.arrayContaining([
        expect.objectContaining({ name: 'Test', kind: 'module' }),
        expect.objectContaining({ name: 'P', kind: 'variable' }),
      ]),
    })
    await galaxyLease.release()
    await triggerLease.release()
  })

  it('projects owner-parsed Data and Style links into the shared typed occurrence contract', async () => {
    const context = {
      id: 'sc2-workspace:fixture',
      revision: 'sc2-workspace:fixture-r1',
      semanticComplete: true,
      documentOrigins: documents.map((document, precedence) => ({
        uri: document.uri,
        layerId: `fixture:${precedence}`,
        logicalId: document.uri.slice(document.uri.lastIndexOf('/') + 1),
        precedence,
        sourceRevision: `fixture:${document.version}`,
        readOnly: false,
      })),
      semanticInputs: [],
    }
    const galaxyLease = createGalaxyProvider({
      contract: 'common.language/document-analysis',
      major: 1,
    })
    try {
      const provider = galaxyLease.value as typeof galaxyLease.value & {
        referenceOccurrences(request: unknown): Promise<readonly any[]>
      }
      const batches = await provider.referenceOccurrences({
        ...feature(galaxy, 'Marine'),
        workspaceContext: context,
      })
      const occurrences = batches.flatMap(batch => batch.occurrences)
      expect(occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'declaration',
            target: expect.objectContaining({ owner: 'blizzard/sc2-data', id: 'Marine' }),
            source: expect.objectContaining({ uri: data.uri }),
          }),
          expect.objectContaining({
            role: 'reference',
            target: expect.objectContaining({ owner: 'blizzard/sc2-data', id: 'Marine' }),
            source: expect.objectContaining({ uri: galaxy.uri }),
          }),
        ]),
      )
      expect(batches.every(batch => batch.contextRevision === context.revision)).toBe(true)
      // A declaration (which knows its class) and a mention (which does not) name one target.
      const marine = occurrences.filter(item => item.target.id === 'Marine')
      expect(marine.map(item => item.role)).toEqual(expect.arrayContaining(['declaration', 'reference']))
      expect(new Set(marine.map(item => referenceTargetKey(item.target))).size).toBe(1)
    } finally {
      await galaxyLease.release()
    }

    const style = {
      uri: 'file:///Base.SC2Data/UI/FontStyles.SC2Style',
      languageId: 'sc2-style',
      version: 1,
      text: '<StyleFile><Style name="Base"/><Style name="Title" template="Base"/></StyleFile>',
    }
    const styleContext = {
      ...context,
      documentOrigins: [
        {
          uri: style.uri,
          layerId: 'fixture:style',
          logicalId: 'UI/FontStyles.SC2Style',
          precedence: 1,
          sourceRevision: 'fixture:style:1',
          readOnly: false,
        },
      ],
    }
    const styleBatches = styleReferenceOccurrenceBatches({
      document: style,
      workspaceDocuments: [style],
      workspaceIncomplete: false,
      workspaceContext: styleContext,
    } as never)
    expect(styleBatches.flatMap(batch => batch.occurrences)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'declaration' }),
        expect.objectContaining({ role: 'reference' }),
      ]),
    )
  })

  it('outlines TriggerData as the editor tree: Root order, nested categories, authored names', async () => {
    const text = [
      '<TriggerData><Library Id="Map">',
      '<Root><Item Type="Category" Id="C1"/><Item Type="Variable" Id="V1"/></Root>',
      '<Element Type="Category" Id="C1"><Identifier>Melee</Identifier><Item Type="Trigger" Id="T1"/><Item Type="Category" Id="C2"/></Element>',
      '<Element Type="Category" Id="C2"><Identifier>Nested</Identifier></Element>',
      '<Element Type="Trigger" Id="T1"><Identifier>Start</Identifier></Element>',
      '<Element Type="Variable" Id="V1"><Identifier>score</Identifier><Type Value="int"/></Element>',
      '<Element Type="Param" Id="P1"/>',
      '</Library></TriggerData>',
    ].join(String.fromCharCode(10))
    const document = { uri: 'file:///Outline.Triggers', languageId: 'sc2-triggers', version: 1, text }
    const { symbols } = await sc2TriggersDocumentSymbols({ document })
    const shape = (items: readonly any[]): unknown[] => items.map(item =>
      item.children ? [item.name, item.kind, shape(item.children)] : [item.name, item.kind])
    expect(shape(symbols)).toEqual([
      ['Map', 'module', [
        ['Melee', 'namespace', [['Start', 'function'], ['Nested', 'namespace']]],
        ['score', 'variable'],
      ]],
    ])
    expect(symbols[0].children[0].children[0].selectionRange.start.line).toBe(4)
  })

  it('names outline entries from the same map TriggerStrings, preferring enUS', async () => {
    const map = 'file:///Maps/Demo.SC2Map/'
    // A map keeps its elements directly under <TriggerData>.
    const document = { uri: `${map}Triggers`, languageId: 'sc2-triggers', version: 1, text:
      '<TriggerData><Root><Item Type="Trigger" Id="0000000A"/></Root>' +
      '<Element Type="Trigger" Id="0000000A"/></TriggerData>' }
    const strings = (uri: string, name: string) => ({ uri, languageId: 'sc2-strings', version: 1, text: `Trigger/Name/0000000A=${name}` })
    const request = {
      document,
      workspaceDocuments: [
        strings(`${map}deDE.SC2Data/LocalizedData/TriggerStrings.txt`, 'Anfang'),
        strings(`${map}enUS.SC2Data/LocalizedData/TriggerStrings.txt`, 'Opening'),
        strings('file:///Maps/Other.SC2Map/enUS.SC2Data/LocalizedData/TriggerStrings.txt', 'Elsewhere'),
      ],
    }
    const { symbols } = await sc2TriggersDocumentSymbols(request as any)
    expect(symbols[0].children.map((item: any) => item.name)).toEqual(['Opening'])
  })
})
