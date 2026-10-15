import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createProvider } from '../language/provider.js'
import {
  analyzeGalaxySemanticDocument,
  galaxyCompletion,
  galaxyDefinition,
  galaxyDiagnostics,
  galaxyDocumentSymbols,
  galaxyFormatting,
  galaxyHover,
  galaxyPrepareRename,
  galaxyReferences,
  galaxyRename,
  galaxySignatureHelp,
  galaxyWorkspaceSymbols,
} from '../language/semantic-provider.js'
import {
  GALAXY_NATIVE_API_CATALOG_DIGEST,
  GALAXY_NATIVE_API_FUNCTION_COUNT,
  GALAXY_NATIVE_API_PROVENANCE,
  GALAXY_NATIVE_API_SOURCE,
  GALAXY_NATIVE_API_SUMMARIES,
} from '../language/native-api.js'

const header = Object.freeze({
  uri: 'file:///workspace/header.galaxy',
  languageId: 'galaxy',
  version: 3,
  text: 'int Add(int a, int b) { return a + b; }',
})
const main = Object.freeze({
  uri: 'file:///workspace/main.galaxy',
  languageId: 'galaxy',
  version: 7,
  text: 'void Init() { int value = Add(1, 2); TextToString(null); ACos(0.5); }',
})

const positionAt = (document: typeof main, needle: string, delta = 0) => {
  const offset = document.text.indexOf(needle) + delta
  return { line: 0, character: offset }
}

const requestAt = (needle: string, delta = 0, overrides = {}) => ({
  document: main,
  workspaceDocuments: [main, header],
  workspaceIncomplete: false,
  maxResults: 128,
  maxDocuments: 8,
  position: positionAt(main, needle, delta),
  ...overrides,
})

describe('Galaxy protocol-neutral semantic provider', () => {
  it('uses the parser, binder and checker for symbols and semantic diagnostics', async () => {
    const bad = Object.freeze({
      ...main,
      text: 'void Init() { int value = "wrong"; }',
    })
    const analysis = await analyzeGalaxySemanticDocument(bad)
    expect(analysis.symbols).toEqual([expect.objectContaining({ name: 'Init', kind: 'function' })])
    expect(analysis.diagnostics.map(item => item.message)).toContain(
      "Type 'string' is not assignable to 'int'.",
    )

    const diagnostics = await galaxyDiagnostics({
      document: bad,
      workspaceDocuments: [bad],
      workspaceIncomplete: false,
      maxResults: 16,
      maxDocuments: 1,
    })
    expect(diagnostics.isIncomplete).toBe(false)
    expect(diagnostics.diagnostics[0]?.code).toBe('galaxy/semantic')
  })

  it('hovers a constant with its declaration and a struct field with its owner, as MK2 did', async () => {
    const lib = Object.freeze({
      uri: 'file:///workspace/lib.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'const int c_limit = 3; // cap\nstruct Pair { int left; int right; };',
    })
    const user = Object.freeze({
      uri: 'file:///workspace/user.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'void Use() { Pair p; int n = c_limit; p.left = n; }',
    })
    const at = (needle: string, delta: number) => ({
      document: user,
      workspaceDocuments: [user, lib],
      workspaceIncomplete: false,
      maxResults: 32,
      maxDocuments: 4,
      position: { line: 0, character: user.text.indexOf(needle) + delta },
    })
    const constant = await galaxyHover(at('c_limit', 2))
    expect(constant?.markdown).toContain('const int c_limit = 3')
    expect(constant?.markdown).not.toContain('cap')
    const field = await galaxyHover(at('left =', 1))
    expect(field?.markdown).toContain('property of `Pair`')
  })

  it('provides completion, native hover knowledge and signature help', async () => {
    const completion = await galaxyCompletion(requestAt('Add(1', 4))
    expect(completion.items.map(item => item.label)).toEqual(expect.arrayContaining(['Add', 'for']))
    expect(completion.items.find(item => item.label === 'Add')?.insertTextFormat).toBe('snippet')

    const nativeCompletion = await galaxyCompletion(requestAt('ACos', 2))
    expect(nativeCompletion.items.map(item => item.label)).toContain('ACos')
    expect(nativeCompletion.items.find(item => item.label === 'ACos')?.documentation).toBe(
      'Arccosine',
    )

    const hover = await galaxyHover(requestAt('ACos', 2))
    expect(hover?.markdown).toContain('ACos')
    expect(hover?.markdown).toContain('Arccosine')
    expect(hover?.provenance).toContain('44ba5892')

    const signature = await galaxySignatureHelp(requestAt('Add(1', 5))
    expect(signature?.signatures[0]?.label).toContain('Add')
    expect(signature?.signatures[0]?.parameters).toHaveLength(2)
  })

  it('includes declaration comments in completion without a resolve round trip', async () => {
    const documentedHeader = Object.freeze({
      ...header,
      text: '// Adds two integers.\nint Add(int a, int b) { return a + b; }',
    })
    const completion = await galaxyCompletion({
      ...requestAt('Add(1', 4),
      workspaceDocuments: [main, documentedHeader],
    })
    expect(completion.items.find(item => item.label === 'Add')?.documentation).toBe(
      'Adds two integers.',
    )
  })

  it('honors host function expansion settings in protocol-neutral completion', async () => {
    const none = await galaxyCompletion(requestAt('Add(1', 4, { functionExpand: 'None' }))
    expect(none.items.find(item => item.label === 'Add')).toEqual(
      expect.objectContaining({ insertText: 'Add', insertTextFormat: 'plain-text' }),
    )

    const parenthesis = await galaxyCompletion(
      requestAt('Add(1', 4, { functionExpand: 'Parenthesis' }),
    )
    expect(parenthesis.items.find(item => item.label === 'Add')?.insertText).toBe('Add($0)')

    const defaults = await galaxyCompletion(
      requestAt('Add(1', 4, { functionExpand: 'ArgumentsNull' }),
    )
    expect(defaults.items.find(item => item.label === 'Add')?.insertText).toBe(
      'Add(${1:0}, ${2:0})$0',
    )
  })

  it('keeps static declarations private to their source file', async () => {
    const privateHeader = Object.freeze({
      ...header,
      text: 'static int hidden; static int Hidden() { return hidden; } int shared;',
    })
    const privateMain = Object.freeze({
      ...main,
      text: 'static int localOnly; void Init() { int value = 0; }',
    })
    const completion = await galaxyCompletion({
      ...requestAt('Init', 4),
      document: privateMain,
      workspaceDocuments: [privateMain, privateHeader],
      position: { line: 0, character: privateMain.text.length },
    })

    expect(completion.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['localOnly', 'shared']),
    )
    expect(completion.items.map(item => item.label)).not.toEqual(
      expect.arrayContaining(['hidden', 'Hidden']),
    )

    const hiddenUse = Object.freeze({ ...privateMain, text: 'void Init() { hidden = 1; }' })
    const hiddenDefinition = await galaxyDefinition({
      ...requestAt('Init'),
      document: hiddenUse,
      workspaceDocuments: [hiddenUse, privateHeader],
      position: { line: 0, character: hiddenUse.text.indexOf('hidden') + 2 },
    })
    expect(hiddenDefinition.locations).toEqual([])
  })

  it('completes proven catalog literals from mixed workspace declarations', async () => {
    const galaxy = Object.freeze({
      ...main,
      text: 'void Init() { UnitCreate(1, "Mar", 0, 0); }',
    })
    const catalog = Object.freeze({
      uri: 'file:///workspace/GameData/UnitData.xml',
      languageId: 'sc2-data',
      version: 2,
      text: '<Catalog><CUnit id="Marine"/><CUnit id="Marauder"/><CUnit id="Zergling"/></Catalog>',
    })
    const completion = await galaxyCompletion({
      ...requestAt('Init'),
      document: galaxy,
      workspaceDocuments: [galaxy, catalog],
      position: { line: 0, character: galaxy.text.indexOf('Mar') + 3 },
    })

    expect(completion.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['Marauder', 'Marine']),
    )
    expect(completion.items).toHaveLength(2)
    expect(completion.items.find(item => item.label === 'Marauder')).toEqual(
      expect.objectContaining({ kind: 'enum', insertText: 'Marauder' }),
    )
  })

  it('completes includes and bool/bool trigger handlers without legacy metadata', async () => {
    const includeSource = Object.freeze({ ...main, text: 'include "TriggerLibs/Nat' })
    const nativeLibrary = Object.freeze({
      uri: 'file:///workspace/TriggerLibs/NativeLib.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'native int NativeValue();',
    })
    const include = await galaxyCompletion({
      ...requestAt('Init'),
      document: includeSource,
      workspaceDocuments: [includeSource, nativeLibrary],
      position: { line: 0, character: includeSource.text.length },
    })
    expect(include.items).toEqual([
      expect.objectContaining({ label: 'NativeLib', kind: 'module' }),
    ])

    const handlerSource = Object.freeze({
      ...main,
      text: [
        'bool Match(bool testConds, bool runActions) { return true; }',
        'bool Wrong(int testConds, bool runActions) { return true; }',
        'void Init() { TriggerCreate("Ma',
      ].join('\n'),
    })
    const handler = await galaxyCompletion({
      ...requestAt('Init'),
      document: handlerSource,
      workspaceDocuments: [handlerSource],
      position: { line: 2, character: 'void Init() { TriggerCreate("Ma'.length },
    })
    expect(handler.items).toEqual([
      expect.objectContaining({ label: 'Match', kind: 'function', insertText: 'Match' }),
    ])
  })

  it('completes struct members for local and workspace variables', async () => {
    const types = Object.freeze({
      ...header,
      text: 'struct Pair { int left; string right; }; Pair shared;',
    })
    const localSource = Object.freeze({
      ...main,
      text: 'void Init() { Pair local; local.r }',
    })
    const local = await galaxyCompletion({
      ...requestAt('Init'),
      document: localSource,
      workspaceDocuments: [localSource, types],
      position: { line: 0, character: localSource.text.indexOf('local.r') + 'local.r'.length },
    })
    expect(local.items).toEqual([
      expect.objectContaining({ label: 'right', kind: 'property', detail: 'string' }),
    ])

    const workspaceSource = Object.freeze({ ...main, text: 'void Init() { shared. }' })
    const workspace = await galaxyCompletion({
      ...requestAt('Init'),
      document: workspaceSource,
      workspaceDocuments: [workspaceSource, types],
      position: { line: 0, character: workspaceSource.text.indexOf('shared.') + 'shared.'.length },
    })
    expect(workspace.items.map(item => item.label)).toEqual(['left', 'right'])
  })

  it('formats a complete document with editor indentation and newline settings', async () => {
    const document = Object.freeze({
      ...main,
      text: 'void Init(){\nint value=1;\nif(value>0){\nreturn;\n}\n}',
    })
    const result = await galaxyFormatting({
      document,
      workspaceDocuments: [document],
      workspaceIncomplete: false,
      maxResults: 4,
      maxDocuments: 1,
      options: { tabSize: 2, insertSpaces: true, finalNewline: true },
    })
    expect(result).toEqual({
      edits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 5, character: 1 },
          },
          newText: 'void Init(){\n  int value=1;\n  if(value>0){\n    return;\n  }\n}\n',
        },
      ],
      isComplete: true,
    })
  })

  it('pins and parses the complete generated Core.SC2Mod Galaxy API catalog', async () => {
    const catalogBytes = await readFile(new URL('../data/galaxy-script-api.v1.json', import.meta.url))
    const catalog = JSON.parse(catalogBytes.toString('utf8')) as {
      readonly functions: readonly {
        readonly name: string
        readonly sources: readonly string[]
        readonly libraries?: unknown
      }[]
    }
    const catalogDigest = `sha256:${createHash('sha256').update(catalogBytes).digest('hex')}`
    expect(catalog.functions).toHaveLength(3_341)
    expect(catalog.functions.every(entry => !('libraries' in entry))).toBe(true)
    expect(catalog.functions.find(entry => entry.name === 'AIAddAirDanger')?.sources).toEqual([
      'ai-native-header',
    ])
    expect(GALAXY_NATIVE_API_FUNCTION_COUNT).toBe(3_341)
    expect(GALAXY_NATIVE_API_SOURCE.split('\n')).toHaveLength(3_341)
    expect(Object.keys(GALAXY_NATIVE_API_SUMMARIES)).toHaveLength(3_341)
    expect(GALAXY_NATIVE_API_SUMMARIES.ACos).toBe('Arccosine')
    expect(GALAXY_NATIVE_API_CATALOG_DIGEST).toBe(catalogDigest)
    expect(GALAXY_NATIVE_API_PROVENANCE).toContain(catalogDigest)
    const analysis = await analyzeGalaxySemanticDocument({
      uri: 'modkit://blizzard/galaxy/native-api.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: GALAXY_NATIVE_API_SOURCE,
    })
    expect(analysis.diagnostics).toEqual([])
    expect(analysis.symbols).toHaveLength(3_341)
  })

  it('resolves unique cross-file definitions, references and version-bound rename edits', async () => {
    const definition = await galaxyDefinition(requestAt('Add(1', 1))
    expect(definition).toEqual({
      locations: [
        {
          uri: header.uri,
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 7 },
          },
        },
      ],
      isIncomplete: false,
    })

    const references = await galaxyReferences({
      ...requestAt('Add(1', 1),
      includeDeclaration: true,
    })
    expect(references.locations.map(item => item.uri)).toEqual([header.uri, main.uri])

    const preparation = await galaxyPrepareRename(requestAt('Add(1', 1))
    expect(preparation?.placeholder).toBe('Add')
    const edit = await galaxyRename({
      ...requestAt('Add(1', 1),
      newName: 'Sum',
      maxEdits: 8,
    })
    expect(edit?.isComplete).toBe(true)
    expect(edit?.documentChanges).toEqual([
      expect.objectContaining({ uri: header.uri, documentVersion: 3 }),
      expect.objectContaining({ uri: main.uri, documentVersion: 7 }),
    ])
  })

  it('provides bounded document/workspace symbols and reports truncation', async () => {
    const documentSymbols = await galaxyDocumentSymbols({
      document: main,
      workspaceDocuments: [main, header],
      workspaceIncomplete: false,
      maxResults: 8,
      maxDocuments: 8,
    })
    expect(documentSymbols).toEqual({
      symbols: [expect.objectContaining({ name: 'Init' })],
      isIncomplete: false,
    })

    const workspaceSymbols = await galaxyWorkspaceSymbols({
      document: main,
      workspaceDocuments: [main, header],
      workspaceIncomplete: false,
      maxResults: 1,
      maxDocuments: 8,
      query: '',
    })
    expect(workspaceSymbols.symbols).toHaveLength(1)
    expect(workspaceSymbols.isIncomplete).toBe(true)
  })

  it('opens an include, keeps redeclared natives resolvable and reports an undeclared call', async () => {
    const included = Object.freeze({
      uri: 'file:///workspace/TriggerLibs/Helpers.galaxy',
      languageId: 'galaxy',
      version: 1,
      // A mod's own natives.galaxy redeclares what the bundled native API already declares.
      text: 'native fixed ACos (fixed x);\nint Twice(int a) { return a + a; }\n',
    })
    const caller = Object.freeze({
      uri: 'file:///workspace/caller.galaxy',
      languageId: 'galaxy',
      version: 2,
      text: 'include \"TriggerLibs/Helpers\"\nvoid Run() { ACos(0.5); Missing(1); }\n',
    })
    const request = (needle: string, delta = 0) => ({
      document: caller,
      workspaceDocuments: [caller, included],
      workspaceIncomplete: false,
      maxResults: 128,
      maxDocuments: 8,
      position: (() => {
        const offset = caller.text.indexOf(needle) + delta
        const before = caller.text.slice(0, offset).split('\n')
        return { line: before.length - 1, character: before[before.length - 1].length }
      })(),
    })

    const include = await galaxyDefinition(request('TriggerLibs/Helpers', 2))
    expect(include.locations.map(item => item.uri)).toEqual([included.uri])

    for (const alias of ['triggerlibs/helpers.galaxy', '/TRIGGERLIBS/HELPERS']) {
      const aliased = { ...caller, text: `include "${alias}"\nvoid Run() {}` }
      const target = await galaxyDefinition({
        ...request(alias, 2),
        document: aliased,
        workspaceDocuments: [aliased, included],
        position: { line: 0, character: 10 },
      })
      expect(target.locations.map(item => item.uri)).toEqual([included.uri])
    }

    const native = await galaxyDefinition(request('ACos(0.5)', 1))
    expect(native.locations.map(item => item.uri)).toEqual([included.uri])
    expect(await galaxyHover(request('ACos(0.5)', 1))).toMatchObject({
      markdown: expect.stringContaining('ACos'),
    })

    const diagnostics = await galaxyDiagnostics({
      document: caller,
      workspaceDocuments: [caller, included],
      workspaceIncomplete: false,
      maxResults: 128,
      maxDocuments: 8,
    })
    expect(diagnostics.diagnostics.map(item => item.message)).toEqual([
      "Function 'Missing' is not declared.",
    ])
  })

  it('offers the Galaxy snippets VS Code had, so the LSP and MCP have them too (plan 2.12)', async () => {
    const script = Object.freeze({
      uri: 'file:///workspace/MapScript.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'void Run() {\n  forp\n}\n',
    })
    const completion = await galaxyCompletion({
      document: script,
      workspaceDocuments: [script],
      workspaceIncomplete: false,
      maxResults: 512,
      maxDocuments: 8,
      position: { line: 1, character: 6 },
    })
    const snippet = completion.items.find(item => item.kind === 'snippet' && item.label === 'forp')
    expect(snippet).toMatchObject({ detail: 'for players', insertTextFormat: 'snippet' })
    expect(snippet?.insertText?.split('\n')).toEqual([
      'for (${1:i} = 1; ${1:i} <= PlayerGroupCount(${2:PlayerGroupActive()}); ${1:i} += 1) {',
      '\t${3:tmp_player} = PlayerGroupPlayer(${2:PlayerGroupActive()}, ${1:i});',
      '}',
    ])
    // A prefix narrows them as it does symbols: "forp" leaves "for" and "foru" out.
    expect(completion.items.filter(item => item.kind === 'snippet').map(item => item.label)).toEqual(['forp'])
  })

  it('leads a native to the chain natives.galaxy, never to the bundled catalog (plan 2.1)', async () => {
    const script = Object.freeze({
      uri: 'file:///workspace/MapScript.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'void Run() { ACos(0.5); }\n',
    })
    const natives = Object.freeze({
      uri: 'content-source://local%3Acasc/mods/core.sc2mod/base.sc2data/triggerlibs/natives.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'native fixed ACos (fixed x);\n',
    })
    const at = (workspaceDocuments: readonly (typeof script)[]) => ({
      document: script,
      workspaceDocuments,
      workspaceIncomplete: false,
      maxResults: 128,
      maxDocuments: 8,
      position: { line: 0, character: script.text.indexOf('ACos') + 1 },
    })
    // No installation in the snapshot: hover still knows the native, and nothing is a place to go.
    expect(await galaxyDefinition(at([script]))).toEqual({ locations: [], isIncomplete: false })
    expect(await galaxyHover(at([script]))).toMatchObject({ markdown: expect.stringContaining('ACos') })
    expect((await galaxyReferences({ ...at([script]), includeDeclaration: true })).locations.map(item => item.uri))
      .toEqual([script.uri])
    const symbols = await galaxyWorkspaceSymbols({ ...at([script]), query: 'acos' })
    expect(symbols.symbols.map(item => item.location.uri)).not.toContain('modkit://blizzard/galaxy/native-api.galaxy')
    // Core's natives.galaxy in the snapshot: the native leads there.
    const definition = await galaxyDefinition(at([script, natives]))
    expect(definition.locations).toEqual([
      expect.objectContaining({ uri: natives.uri, range: expect.objectContaining({ start: { line: 0, character: 13 } }) }),
    ])
    expect((await galaxyReferences({ ...at([script, natives]), includeDeclaration: true })).locations.map(item => item.uri).sort())
      .toEqual([natives.uri, script.uri].sort())
  })

  it('refuses ambiguous or partial rename and observes cancellation', async () => {
    const duplicate = Object.freeze({
      uri: 'file:///workspace/duplicate.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: 'int Add(int a, int b) { return a - b; }',
    })
    expect(
      await galaxyDefinition({
        ...requestAt('Add(1', 1),
        workspaceDocuments: [main, header, duplicate],
      }),
    ).toEqual({ locations: [], isIncomplete: false })
    expect(
      await galaxyPrepareRename({
        ...requestAt('Add(1', 1),
        workspaceIncomplete: true,
      }),
    ).toBeUndefined()

    const abort = new AbortController()
    abort.abort('cancel semantic request')
    await expect(galaxyCompletion({ ...requestAt('Add(1', 1), signal: abort.signal })).rejects.toBe(
      'cancel semantic request',
    )
  })

  it('refuses rename when the declaration or any edit target is read-only', async () => {
    const request = {
      ...requestAt('Add(1', 1),
      editableDocumentUris: [main.uri],
    }
    expect(await galaxyPrepareRename(request)).toBeUndefined()
    expect(
      await galaxyRename({
        ...request,
        newName: 'Sum',
        maxEdits: 8,
      }),
    ).toBeUndefined()
  })

  it('renames writable references without treating dependency comments, strings or shadows as uses', async () => {
    const dependency = {
      uri: 'file:///dependency/readonly.galaxy', languageId: 'galaxy', version: 1,
      text: '// Add is a helper\nvoid Debug(int Add) { string message = "Add"; int x = Add; }',
    }
    const request = {
      ...requestAt('Add(1', 1),
      workspaceDocuments: [main, header, dependency],
      editableDocumentUris: [main.uri, header.uri],
    }
    const references = await galaxyReferences({ ...request, includeDeclaration: true })
    expect(references.locations.map(item => item.uri)).toEqual([header.uri, main.uri])
    const rename = await galaxyRename({ ...request, newName: 'Sum', maxEdits: 8 })
    expect(rename?.documentChanges.map(change => change.uri)).toEqual([header.uri, main.uri])
  })

  it('publishes the complete optional semantic surface from the provider lease', async () => {
    const lease = createProvider({
      contract: 'common.language/document-analysis',
      major: 1,
    })
    expect(Object.keys(lease.value).sort()).toEqual(
      [
        'analyze',
        'codeActions',
        'completion',
        'contract',
        'definition',
        'diagnostics',
        'documentSymbols',
        'documentLocalFeatures',
        'formatting',
        'hover',
        'languageIds',
        'prepareRename',
        'referenceOccurrences',
        'referenceIndexApplies',
        'references',
        'rename',
        'semanticInputs',
        'signatureHelp',
        'workspaceSymbols',
        'workspaceLanguageIds',
      ].sort(),
    )
    const analysis = await lease.value.analyze({
      document: {
        uri: 'file:///workspace/provider.galaxy',
        languageId: 'galaxy',
        version: 9,
        text: 'void Init() { int value = "wrong"; }',
      },
    })
    expect(analysis.diagnostics.map(item => item.message)).toContain(
      "Type 'string' is not assignable to 'int'.",
    )
    await expect(lease.value.codeActions({
      document: {
        uri: 'file:///workspace/provider.galaxy',
        languageId: 'galaxy',
        version: 9,
        text: 'void Init() {}',
      },
      workspaceDocuments: [],
      workspaceIncomplete: false,
      maxResults: 4,
      maxDocuments: 4,
      maxEdits: 4,
      range: {
        start: { line: 0, character: 14 },
        end: { line: 0, character: 14 },
      },
      diagnostics: [],
    })).resolves.toMatchObject({
      actions: [{ title: 'Add final newline', edit: { documentChanges: [{ documentVersion: 9 }] } }],
      isIncomplete: false,
    })
    await lease.release()
  })

  // Plan 2.14: a snapshot past the semantic bounds is answered, not refused.
  it('answers past the size bounds: oversized documents are left out, an oversized open file gets nothing', async () => {
    const lease = createProvider({ contract: 'common.language/document-analysis', major: 1 })
    const huge = Object.freeze({
      uri: 'file:///workspace/huge.galaxy',
      languageId: 'galaxy',
      version: 1,
      text: `int Big = 0;\n${'// filler\n'.repeat(2_100_000)}`,
    })

    // A dependency past the bound: the rest still answers, as an incomplete workspace.
    const request = { ...requestAt('Add(1', 1), workspaceDocuments: [main, header, huge] }
    await expect(lease.value.definition(request)).resolves.toMatchObject({
      locations: [{ uri: header.uri }],
      isIncomplete: true,
    })
    // Rename cannot see the left-out document, so it refuses.
    await expect(lease.value.rename({ ...request, newName: 'Sum', maxEdits: 8 })).resolves.toBeUndefined()

    // The open document past the bound: empty answers and one diagnostic saying why.
    const own = { ...requestAt('Init'), document: huge, workspaceDocuments: [huge], position: { line: 0, character: 5 } }
    await expect(lease.value.definition(own)).resolves.toEqual({ locations: [], isIncomplete: true })
    await expect(lease.value.hover(own)).resolves.toBeUndefined()
    const diagnostics = await lease.value.diagnostics(own)
    expect(diagnostics.diagnostics).toHaveLength(1)
    expect(diagnostics.diagnostics[0]?.message).toMatch(/larger than 2 MiB/u)
    await lease.release()
  })
})
