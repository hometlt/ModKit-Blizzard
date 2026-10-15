/**
 * Language services for GameData XML, adapted onto the ported MK2 library.
 *
 * The rules are MK2's — `computeCompletions`, `collectIssues`, `definitionRequestAt`,
 * `referenceTargetAt`. What is under test here is everything that could not come across: offsets
 * into positions, and the workspace, which MK2 read from disk and the contract supplies as a
 * bounded snapshot of documents. The cases below are the ways that substitution goes wrong, and the
 * worst of them is the checker reporting a healthy file as broken because it cannot see the rest.
 */
import { describe, expect, it, vi } from 'vitest'
import * as catalogXml from '../shared/catalog-engine/xml/parser.js'
import * as languageReferences from '../shared/format/language/references.js'
import { createSc2DataLanguageProvider } from '../providers/language/src/language.js'
import { craftedModServer, type CraftedModServerOptions } from './crafted-mod-server.js'
import {
  catalogClasses,
  catalogClassesForNamespace,
  catalogStructureDefaultsForNamespace,
  classifyField,
  getClassFields,
} from '../shared/catalog-engine/sc2-catalog/index.js'
import { fileExtensions } from '../shared/format/language/completion.js'

const provider = createSc2DataLanguageProvider()
const NL = '\n'

const UNITS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  '    <CUnit id="Marine">',
  '        <LifeMax value="45"/>',
  '    </CUnit>',
  '    <CUnit id="Marauder" parent="Marine">',
  '        <LifeMax value="125"/>',
  '    </CUnit>',
  '</Catalog>',
  '',
].join(NL)

const ABILS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  '    <CAbilAttack id="Attack">',
  '        <CmdButtonArray index="Execute" DefaultButtonFace="Attack"/>',
  '    </CAbilAttack>',
  '</Catalog>',
  '',
].join(NL)

function document(text: string, uri = 'memory://UnitData.xml') {
  return { uri, languageId: 'sc2-data', version: 1, text }
}

function origin(uri: string, layerId: string, logicalId: string, precedence: number) {
  return {
    uri,
    layerId,
    logicalId,
    precedence,
    sourceRevision: 'test',
    readOnly: precedence === 0,
  }
}

function request(text: string, extra: Record<string, unknown> = {}) {
  return {
    document: document(text),
    workspaceDocuments: [],
    workspaceIncomplete: true,
    maxResults: 200,
    maxDocuments: 8,
    ...extra,
  } as never
}

/** The provider over a crafted mod server, with the context of a request that reads it. */
function overServer(options: CraftedModServerOptions) {
  const server = craftedModServer(options)
  return {
    provider: createSc2DataLanguageProvider({ modContexts: server.port }),
    context: server.context,
    questions: server.questions,
  }
}

const EDITOR_CATEGORIES_METADATA = {
  starcraft2: {
    editorCategories: {
      categories: {
        ObjectType: ['Unit'],
        Race: ['Terr', 'Prot', 'Zerg'],
      },
      objectUsage: {
        Unit: {
          objects: [
            { source: 'External', category: 'ObjectType' },
            { source: 'External', category: 'Race' },
          ],
          fields: [],
        },
      },
    },
  },
} as const

/** A default template with a token and a concrete unit, with editor categories, on the mod server. */
function metadataServer() {
  return overServer({
    entities: [
      {
        namespace: 'Unit',
        typeId: 'CUnit',
        entityId: 'Template',
        defaultTemplate: true,
        tokens: [{ id: 'Weapon', type: 'CWeaponLink', value: 'GaussRifle' }],
      },
      { namespace: 'Unit', typeId: 'CUnit', entityId: 'Concrete' },
    ],
    metadata: EDITOR_CATEGORIES_METADATA,
  })
}

/** Position of the first occurrence of `needle`, plus `into` characters. */
function at(text: string, needle: string, into = 0) {
  const offset = text.indexOf(needle) + into
  const before = text.slice(0, offset)
  return {
    line: before.split(NL).length - 1,
    character: offset - (before.lastIndexOf(NL) + 1),
  }
}

describe('sc2-data colours (plan 1.9)', () => {
  const ACTORS = [
    '<Catalog>',
    '  <CActorUnit id="Marine">',
    '    <WireframeShieldColor value="128,255,0,0"/>',
    '    <UnitBorderNormalColor value="0,255,0"/>',
    '    <Name value="128,255,0,0"/>',
    '  </CActorUnit>',
    '</Catalog>',
    '',
  ].join(NL)

  it('swatches CColor as A,R,G,B and CColorRGB as R,G,B, by field type', async () => {
    const list = await provider.documentColors!(request(ACTORS))
    expect(list.colors).toEqual([
      {
        range: { start: at(ACTORS, '128,255,0,0'), end: at(ACTORS, '128,255,0,0', 11) },
        color: { red: 1, green: 0, blue: 0, alpha: 128 / 255 },
      },
      {
        range: { start: at(ACTORS, '0,255,0"'), end: at(ACTORS, '0,255,0"', 7) },
        color: { red: 0, green: 1, blue: 0, alpha: 1 },
      },
    ])
  })

  it('writes a picked colour back with the channels the field has', async () => {
    const pick = (needle: string, length: number) =>
      provider.colorPresentations!({
        ...request(ACTORS),
        range: { start: at(ACTORS, needle), end: at(ACTORS, needle, length) },
        color: { red: 0, green: 0, blue: 1, alpha: 0.5 },
      } as never)
    expect((await pick('128,255,0,0', 11)).presentations.map(item => item.label)).toEqual(['128,0,0,255'])
    // An RGB field takes no alpha, whatever the picker says.
    expect((await pick('0,255,0"', 7)).presentations.map(item => item.label)).toEqual(['0,0,255'])
  })
})

describe('sc2-data definition into dependencies and assets (plan 1.10, 1.12)', () => {
  const LAYER = { layerId: 'ctx:0:liberty', sourceId: 'local:casc', sourcePath: 'mods/liberty.sc2mod' }
  const withInputs = (
    context: Readonly<Record<string, unknown>> & { readonly semanticInputs: readonly unknown[] },
    inputs: readonly Record<string, unknown>[],
  ) => ({
    ...context,
    semanticInputs: [
      ...context.semanticInputs,
      { kind: 'dependency-closure', id: 'blizzard/starcraft-2:ctx', revision: 'r', payload: { schemaVersion: 1, layers: [LAYER] } },
      ...inputs,
    ],
  })

  it('goes to a parent declared in a dependency the snapshot holds no document of', async () => {
    const text = '<Catalog><CUnit id="Mine" parent="Marine"/></Catalog>'
    const { provider: served, context: serverContext } = overServer({
      entities: [
        {
          namespace: 'Unit',
          typeId: 'CUnit',
          entityId: 'Marine',
          source: { rootId: LAYER.layerId, path: 'base.sc2data/GameData/UnitData.xml', range: { utf16Offset: 400, utf16Length: 20, line: 12, column: 4 } },
        },
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Mine', parentEntityId: 'Marine' },
      ],
      // The host names a file of a dependency layer in the content source that holds it.
      uriOf: (layerId, file) =>
        layerId === LAYER.layerId ? `content-source://local%3Acasc/${LAYER.sourcePath}/${file}` : undefined,
    })
    const context = withInputs(serverContext(), [])
    const list = await served.definition!({ ...request(text, { workspaceContext: context }), position: at(text, 'parent="Marine"', 9) } as never)
    expect(list.locations).toEqual([{
      uri: 'content-source://local%3Acasc/mods/liberty.sc2mod/base.sc2data/GameData/UnitData.xml',
      range: { start: { line: 12, character: 4 }, end: { line: 12, character: 4 } },
    }])
  })

  it('takes the exact declaration range from the server when the request holds no copy of the file', async () => {
    // Owner decision 10.10: a served definition carries only the live document.
    const text = '<Catalog><CUnit id="Mine" parent="Marine"/></Catalog>'
    const dependency = ['<Catalog>', '    <CUnit id="Base" default="1"/>', '    <CUnit id="Marine" parent="Base"/>', '</Catalog>', ''].join(NL)
    const file = 'base.sc2data/GameData/UnitData.xml'
    const uri = `content-source://local%3Acasc/${LAYER.sourcePath}/${file}`
    const { provider: served, context: serverContext, questions } = overServer({
      entities: [
        {
          namespace: 'Unit',
          typeId: 'CUnit',
          entityId: 'Marine',
          source: { rootId: LAYER.layerId, path: file, range: { utf16Offset: 40, utf16Length: 20, line: 2, column: 4 } },
        },
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Mine', parentEntityId: 'Marine' },
      ],
      uriOf: (layerId, path) => (layerId === LAYER.layerId ? `content-source://local%3Acasc/${LAYER.sourcePath}/${path}` : undefined),
      documents: [{ rootId: LAYER.layerId, path: file, text: dependency }],
    })
    const position = at(text, 'parent="Marine"', 9)
    const list = await served.definition!({ ...request(text, { workspaceContext: withInputs(serverContext(), []) }), position } as never)
    // The same location the snapshot path gives when it holds the file.
    const plain = await createSc2DataLanguageProvider().definition!({
      ...request(text, { workspaceDocuments: [document(text), document(dependency, uri)], workspaceIncomplete: false }),
      position,
    } as never)
    expect(plain.locations).toHaveLength(1)
    expect(list.locations).toEqual(plain.locations)
    expect(list.locations[0]?.range.end.character).toBeGreaterThan(list.locations[0]!.range.start.character)
    expect(questions.some(question => (question as { declarations?: unknown }).declarations !== undefined)).toBe(true)
  })

  it("checks a document against the chain's <const> aliases the server holds, as the snapshot does", async () => {
    const text = '<Catalog><CUnit id="Mine"><Mob value="MyMob"/></CUnit></Catalog>'
    const dependency = ['<Catalog>', '    <const id="MyMob" path="CUnit.Mob" value="Multiplayer"/>', '</Catalog>', ''].join(NL)
    const file = 'base.sc2data/GameData/UnitData.xml'
    const uri = `content-source://local%3Acasc/${LAYER.sourcePath}/${file}`
    const { provider: served, context: serverContext, questions } = overServer({
      entities: [{ namespace: 'Unit', typeId: 'CUnit', entityId: 'Mine' }],
      documents: [{ rootId: LAYER.layerId, path: file, text: dependency }],
    })
    const list = await served.diagnostics!(request(text, { workspaceContext: withInputs(serverContext(), []) }) as never)
    expect(list.diagnostics.map(item => item.message).filter(message => message.includes('MyMob'))).toEqual([])
    expect(questions.some(question => (question as { constAliases?: unknown }).constAliases === true)).toBe(true)
    // The snapshot path reads the same alias from the dependency it holds; without it the value is invalid.
    const plain = await createSc2DataLanguageProvider().diagnostics!(
      request(text, { workspaceDocuments: [document(text), document(dependency, uri)], workspaceIncomplete: false }) as never)
    expect(plain.diagnostics.map(item => item.message).filter(message => message.includes('MyMob'))).toEqual([])
    const lone = await createSc2DataLanguageProvider().diagnostics!(
      request(text, { workspaceDocuments: [document(text), document('<Catalog/>', uri)], workspaceIncomplete: false }) as never)
    expect(lone.diagnostics.map(item => item.message).some(message => message.includes("'MyMob'"))).toBe(true)
  })

  it('serves an entity definition but keeps text keys and asset paths on the snapshot', async () => {
    const { provider } = overServer({ entities: [] })
    const applies = (text: string, needle: string, into: number) => (provider as unknown as {
      modContextFeatureApplies(request: unknown): Promise<boolean>
    }).modContextFeatureApplies({ feature: 'definition', document: document(text), position: at(text, needle, into) })
    expect(await applies('<Catalog><CUnit id="Mine" parent="Marine"/></Catalog>', 'parent="Marine"', 9)).toBe(true)
    expect(await applies('<Catalog><CButton id="Go"><Icon value="Assets\\Textures\\x.dds"/></CButton></Catalog>', 'x.dds', 1)).toBe(false)
    expect(await (provider as unknown as { modContextFeatureApplies(request: unknown): Promise<boolean> })
      .modContextFeatureApplies({ feature: 'hover', document: document('<Catalog/>'), position: { line: 0, character: 1 } })).toBe(true)
  })

  it('goes from an asset path to its file in the strongest layer that has it', async () => {
    const text = '<Catalog><CButton id="Go"><Icon value="Assets\\Textures\\btn-marine.dds"/></CButton></Catalog>'
    const { provider: served, context: serverContext } = overServer({
      entities: [{ namespace: 'Button', typeId: 'CButton', entityId: 'Go' }],
    })
    const context = withInputs(serverContext(), [{
      kind: 'content-path-index', id: 'blizzard/starcraft-2:ctx', revision: 'r',
      payload: { schemaVersion: 1, isComplete: true, paths: ['Base.SC2Assets/Assets/Textures/btn-marine.dds'], layers: [0] },
    }])
    const list = await served.definition!({
      ...request(text, { document: document(text, 'memory://ButtonData.xml'), workspaceContext: context }),
      position: at(text, 'btn-marine', 2),
    } as never)
    expect(list.locations.map(item => item.uri)).toEqual([
      'content-source://local%3Acasc/mods/liberty.sc2mod/Base.SC2Assets/Assets/Textures/btn-marine.dds',
    ])
  })
})

describe('sc2-data GameStrings in hover (plan 1.8)', () => {
  it('shows the text of a text link and the name of a referenced entity from the resolved context', async () => {
    const text = [
      '<Catalog>',
      '  <CUnit id="Marine">',
      '    <Name value="Unit/Name/Marine"/>',
      '    <GlossaryAlias value="Marauder"/>',
      '  </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const string = (key: string, value: string) => ({
      key, value, requestedLocale: 'ruRU', resolvedLocale: 'ruRU', fallback: false,
      source: { rootId: 'ru', path: 'ruRU.SC2Data/LocalizedData/GameStrings.txt', documentIndex: 0 },
    })
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine', fields: { Name: 'Unit/Name/Marine' } },
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Marauder' },
      ],
      strings: [string('Unit/Name/Marine', 'Морпех'), string('Unit/Name/Marauder', '<c val="FF0000">Мародёр</c>')],
    })
    const hoverAt = async (needle: string, into: number) =>
      (await served.hover!({ ...request(text, { workspaceContext: context() }), position: at(text, needle, into) } as never))?.markdown
    expect(await hoverAt('Unit/Name/Marine', 3)).toContain('```\nМорпех\n```')
    expect(await hoverAt('"Marauder"', 3)).toContain('```\n<c val="FF0000">Мародёр</c>\n```')
  })

  it('reads its loaded mod\'s server, which answers the strings too, not a resolved Data context', () => {
    expect(provider.semanticContextRequirements).toEqual([{ kind: 'mod-context', gameId: 'blizzard/starcraft-2' }])
  })
})

describe('sc2-data lenses (plan 1.17, 1.18)', () => {
  it('indexes a document once when different ancestors are declared there', async () => {
    const parents = Array.from({ length: 32 }, (_, index) => `Parent${index}`)
    const text = `<Catalog>${parents.map(id => `<CUnit id="${id}"/><CUnit id="Child${id}" parent="${id}"/>`).join(NL)}</Catalog>`
    const refs = vi.spyOn(languageReferences, 'collectAllRefs')
    try {
      const list = await provider.codeLenses!(request(text, { maxResults: 300 }))
      expect(refs).toHaveBeenCalledTimes(1)
      for (const id of parents) {
        expect(list.lenses.find(lens => lens.title === `↑ ${id}`)?.command).toEqual({
          kind: 'open-location',
          location: { uri: 'memory://UnitData.xml', range: { start: at(text, `${id}"`), end: at(text, `${id}"`, id.length) } },
        })
      }
    } finally {
      refs.mockRestore()
    }
  })

  it('looks up a shared ancestor once per request, including absent declarations', async () => {
    const ids = Array.from({ length: 32 }, (_, index) => `Child${index}`)
    const children = ids.map(id => `<CUnit id="${id}" parent="Base"/>`).join(NL)
    const refs = vi.spyOn(languageReferences, 'collectAllRefs')
    try {
      for (const present of [true, false]) {
        const text = `<Catalog>${present ? '<CUnit id="Base"><LifeMax value="45"/></CUnit>' : ''}${children}</Catalog>`
        // The server declares Base nowhere a snapshot document is: absent here, it is a subject.
        const { provider: served, context } = overServer({
          entities: [
            { namespace: 'Unit', typeId: 'CUnit', entityId: 'Base', fields: { LifeMax: 45 } },
            ...ids.map(id => ({ namespace: 'Unit', typeId: 'CUnit', entityId: id, parentEntityId: 'Base' })),
          ],
        })
        refs.mockClear()
        const list = await served.codeLenses!(request(text, { workspaceContext: context() }))
        expect(refs).toHaveBeenCalledTimes(1)
        expect(list.lenses.filter(lens => lens.title === 'Card')).toHaveLength(ids.length + Number(present))
        const ancestors = list.lenses.filter(lens => lens.title === '↑ Base')
        expect(ancestors).toHaveLength(ids.length)
        expect(ancestors.every(lens => lens.command?.kind === (present ? 'open-location' : 'open-subject'))).toBe(true)
        if (present) expect(ancestors[0]?.command).toEqual({
          kind: 'open-location',
          location: { uri: 'memory://UnitData.xml', range: { start: at(text, 'Base"'), end: at(text, 'Base"', 4) } },
        })
      }
    } finally {
      refs.mockRestore()
    }
  })

  it('puts card and graph above every entity and the inheritance above a child', async () => {
    const text = [
      '<Catalog>',
      '  <CUnit id="Base" default="1"><LifeMax value="10"/></CUnit>',
      '  <CUnit id="Marine" parent="Base"><Speed value="2"/></CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const list = await provider.codeLenses!(request(text))
    const base = at(text, '<CUnit id="Base"')
    const marine = at(text, '<CUnit id="Marine"')
    const baseId = at(text, 'Base" default')
    expect(list.lenses).toEqual([
      // Plan 1.20: how many inherit from it, opening the graph.
      { range: { start: base, end: base }, title: '1 heir', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Base', view: 'graph' } },
      { range: { start: base, end: base }, title: 'Card', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Base', view: 'card' } },
      { range: { start: base, end: base }, title: 'Graph', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Base', view: 'graph' } },
      { range: { start: marine, end: marine }, title: '1 inherited', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'resolved' } },
      // Plan 1.19: each ancestor goes to its declaration.
      {
        range: { start: marine, end: marine },
        title: '↑ Base',
        command: { kind: 'open-location', location: { uri: 'memory://UnitData.xml', range: { start: baseId, end: at(text, 'Base" default', 4) } } },
      },
      { range: { start: marine, end: marine }, title: 'Card', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'card' } },
      { range: { start: marine, end: marine }, title: 'Graph', command: { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'graph' } },
    ])
  })
})

describe('sc2-data rule codes and quick fixes (plan 1.21)', () => {
  const TEXT = [
    '<Catalog>',
    '  <CUnit id="Marine">',
    '    <LifeMx value="45"></LifeMx>',
    '    <CostCategory value="Armyy"/>',
    '    <GlossaryAlias value="Marauderr"/>',
    '    <GlossaryStrongArray value="Reaper"/>',
    '    <WeaponArray Link="GaussRifle" Bogus="1"/>',
    '  </CUnit>',
    '</Catalog>',
    '',
  ].join(NL)
  const others = [document('<Catalog><CUnit id="Marauder"/><CWeaponLegacy id="GaussRifle"/></Catalog>', 'memory://Other/UnitData.xml')]
  // The whole chain is in the snapshot: only then is an absent entity a fixable mistake.
  const complete = { workspaceDocuments: others, workspaceIncomplete: false }
  const actionsAt = async (needle: string) =>
    (
      await provider.codeActions!({
        ...request(TEXT, complete),
        range: { start: at(TEXT, needle), end: at(TEXT, needle) },
        diagnostics: [],
        maxEdits: 100,
      } as never)
    ).actions
  const editsOf = (action: { edit?: { documentChanges: readonly { edits: readonly unknown[] }[] } } | undefined) =>
    action?.edit?.documentChanges[0]?.edits

  it('gives every diagnostic a rule code', async () => {
    const list = await provider.diagnostics!(request(TEXT, complete))
    expect(list.diagnostics.length).toBeGreaterThan(3)
    for (const item of list.diagnostics) expect(item.code).toMatch(/^sc2-data\/[a-z-]+$/u)
    expect(list.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining(['sc2-data/unknown-field', 'sc2-data/invalid-value', 'sc2-data/unresolved-reference', 'sc2-data/unknown-attribute']),
    )
  })

  // Plan 1.23: a snapshot cut short (the LSP walk stopped inside Core) called Marine and Zerg
  // unresolved. Without the whole chain the provider cannot say an entity exists nowhere.
  it('reports an absent entity only when the snapshot holds the whole chain', async () => {
    const text = [
      '<Catalog>',
      '  <CUnit id="Probe" parent="NoSuchParent">',
      '    <WeaponArray Link="NoSuchWeapon"/>',
      '  </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const codes = async (workspaceIncomplete: boolean) =>
      (await provider.diagnostics!(request(text, { workspaceDocuments: others, workspaceIncomplete }))).diagnostics
        .map(item => item.code)
        .filter(code => code === 'sc2-data/unresolved-reference' || code === 'sc2-data/unresolved-parent')
    expect(await codes(false)).toEqual(['sc2-data/unresolved-parent', 'sc2-data/unresolved-reference'])
    expect(await codes(true)).toEqual([])
  })

  it('suggests the nearest field and renames both tags', async () => {
    const actions = await actionsAt('LifeMx')
    expect(actions[0]).toMatchObject({ title: "Change to 'LifeMax'", kind: 'quickfix', isPreferred: true, diagnosticCodes: ['sc2-data/unknown-field'] })
    expect(editsOf(actions[0])).toEqual([
      { range: { start: at(TEXT, 'LifeMx'), end: at(TEXT, 'LifeMx', 6) }, newText: 'LifeMax' },
      { range: { start: at(TEXT, 'LifeMx>'), end: at(TEXT, 'LifeMx>', 6) }, newText: 'LifeMax' },
    ])
  })

  it('suggests the nearest enum member and the nearest entity of the namespace', async () => {
    expect((await actionsAt('Armyy')).map(action => action.title)).toContain("Change to 'Army'")
    expect((await actionsAt('Marauderr')).map(action => action.title)).toEqual(
      expect.arrayContaining(["Change to 'Marauder'", "Create CUnit 'Marauderr'"]),
    )
  })

  it('removes an unknown attribute with the space before it', async () => {
    const remove = (await actionsAt('Bogus')).find(action => action.title === "Remove attribute 'Bogus'")
    expect(editsOf(remove)).toEqual([{ range: { start: at(TEXT, ' Bogus'), end: at(TEXT, 'Bogus="1"', 9) }, newText: '' }])
  })

  it('creates a missing entity before the one that names it, with its indentation', async () => {
    const create = (await actionsAt('Reaper')).find(action => action.title === "Create CUnit 'Reaper'")
    expect(editsOf(create)).toEqual([
      { range: { start: at(TEXT, '<CUnit id="Marine"'), end: at(TEXT, '<CUnit id="Marine"') }, newText: `<CUnit id="Reaper"/>${NL}  ` },
    ])
  })
})

describe('sc2-data symbols and diagnostics', () => {
  it('lists catalog entities with their class as the detail', async () => {
    const list = await provider.documentSymbols!(request(UNITS))
    expect(list.symbols.map(symbol => [symbol.name, symbol.detail])).toEqual([
      ['Marine', 'CUnit'],
      ['Marauder', 'CUnit'],
    ])
    // Plan 1.16: the outline selects the id, not the class tag.
    expect(list.symbols[0]?.selectionRange).toEqual({ start: at(UNITS, 'Marine"'), end: at(UNITS, 'Marine"', 6) })
  })

  it('reports nothing on a valid catalog', async () => {
    const list = await provider.diagnostics!(request(UNITS))
    expect(list.diagnostics).toEqual([])
  })

  it('flags a field the class does not have, on that field', async () => {
    const text = UNITS.replace('<LifeMax value="45"/>', '<NotAField value="45"/>')
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.length).toBeGreaterThan(0)
    const line = text.split(NL)[list.diagnostics[0]!.range.start.line] ?? ''
    expect(line).toContain('NotAField')
  })

  /*
   * The substitution that matters most. MK2 read the whole mod, so an unresolved link was a real
   * finding; a snapshot of one document knows nothing about other catalogs, and reporting every
   * cross-file link as broken would make the checker loudest exactly where it knows least.
   */
  it('does not report links as unresolved when it cannot see the other files', async () => {
    const text = UNITS.replace(
      '<LifeMax value="45"/>',
      '<LifeMax value="45"/><WeaponArray Link="SomethingElsewhere"/>',
    )
    const list = await provider.diagnostics!(request(text))
    expect(list.diagnostics.filter(item => /unresolved|not exist/iu.test(item.message))).toEqual([])
  })

  it('validates editor categories and template parents from full and compact canonical metadata', async () => {
    const text =
      '<Catalog><CUnit id="Child" parent="Concrete" default="1"><EditorCategories value="Race:Unknown"/></CUnit></Catalog>'
    const { provider: served, context } = metadataServer()
    const list = await served.diagnostics!(request(text, { workspaceContext: context() }))
    expect(list.diagnostics.map(item => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Invalid value 'Unknown' for editor category 'Race'"),
        expect.stringContaining("may not inherit from non-default parent 'Concrete'"),
      ]),
    )
  })
})

describe('sc2-data navigation', () => {
  it('resolves a parent attribute to the entity it names', async () => {
    const list = await provider.definition!(
      request(UNITS, { position: at(UNITS, 'parent="Marine"', 'parent="'.length + 1) }),
    )
    expect(list.locations).toHaveLength(1)
    const line = UNITS.split(NL)[list.locations[0]!.range.start.line] ?? ''
    expect(line).toContain('id="Marine"')
  })

  it('finds the entity across the workspace snapshot, not only in this document', async () => {
    const child = ['<Catalog>', '    <CUnit id="Firebat" parent="Marine"/>', '</Catalog>', ''].join(
      NL,
    )
    const list = await provider.definition!(
      request(child, {
        workspaceDocuments: [document(UNITS, 'memory://Other.xml')],
        position: at(child, 'parent="Marine"', 'parent="'.length + 1),
      }),
    )
    expect(list.locations.map(location => location.uri)).toEqual(['memory://Other.xml'])
  })

  it('uses the canonical winning source and namespace for definitions', async () => {
    const child = '<Catalog><CUnit id="Child" parent="Shared"/></Catalog>'
    const dependency = '<Catalog><CUnit id="Shared"><LifeMax value="10"/></CUnit></Catalog>'
    const override = '<Catalog><CUnit id="Shared"><LifeMax value="20"/></CUnit></Catalog>'
    const actor = '<Catalog><CActor id="Shared"/></Catalog>'
    const dependencyUri = 'memory://dependency/UnitData.xml'
    const overrideUri = 'memory://current/UnitData.xml'
    const actorUri = 'memory://dependency/ActorData.xml'
    const childUri = 'memory://current/ChildData.xml'
    const logicalUnit = 'Base.SC2Data/GameData/UnitData.xml'
    const origins = [
      origin(actorUri, 'dependency', 'Base.SC2Data/GameData/ActorData.xml', 0),
      origin(dependencyUri, 'dependency', logicalUnit, 0),
      origin(childUri, 'current', 'Base.SC2Data/GameData/ChildData.xml', 1),
      origin(overrideUri, 'current', logicalUnit, 1),
    ]
    const { provider: served, context } = overServer({
      entities: [
        // The winning declaration is the current layer's.
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Shared', fields: { LifeMax: '20' }, source: { rootId: 'current', path: logicalUnit } },
        { namespace: 'Actor', typeId: 'CActor', entityId: 'Shared', source: { rootId: 'dependency', path: 'Base.SC2Data/GameData/ActorData.xml' } },
      ],
      uriOf: (layerId, file) => origins.find(item => item.layerId === layerId && item.logicalId === file)?.uri,
    })
    const workspaceContext = context({ documentOrigins: origins })
    const list = await served.definition!(
      request(child, {
        document: document(child, childUri),
        workspaceDocuments: [
          document(dependency, dependencyUri),
          document(override, overrideUri),
          document(actor, actorUri),
        ],
        workspaceIncomplete: false,
        workspaceContext,
        position: at(child, 'parent="Shared"', 'parent="'.length + 1),
      }),
    )
    expect(list).toEqual({
      locations: [
        {
          uri: overrideUri,
          range: {
            start: at(override, 'id="Shared"', 'id="'.length),
            end: at(override, 'id="Shared"', 'id="Shared'.length),
          },
        },
      ],
      isIncomplete: false,
    })
  })

  it('marks a canonical definition result incomplete when its source is outside a partial context', async () => {
    const child = '<Catalog><CUnit id="Child" parent="Shared"/></Catalog>'
    // The server, itself incomplete, declares Shared in a layer the host cannot name a file of.
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Shared', source: { rootId: 'missing-dependency', path: 'Base.SC2Data/GameData/UnitData.xml' } },
      ],
      complete: false,
    })
    const list = await served.definition!(
      request(child, {
        workspaceContext: context(),
        position: at(child, 'parent="Shared"', 'parent="'.length + 1),
      }),
    )
    expect(list).toEqual({ locations: [], isIncomplete: true })
  })

  it('keeps a local definition reachable when a partial snapshot omitted the live entity', async () => {
    const malformed = UNITS.replace('    <CUnit id="Marine">', '    <\n    <CUnit id="Marine">')
    const { provider: served, context } = overServer({
      entities: [{ namespace: 'Actor', typeId: 'CActor', entityId: 'OnlyResolvedActor' }],
      complete: false,
    })
    const list = await served.definition!(
      request(malformed, {
        document: document(malformed),
        workspaceContext: context(),
        position: at(malformed, 'parent="Marine"', 'parent="'.length + 1),
      }),
    )
    expect(list).toEqual({
      locations: [
        {
          uri: 'memory://UnitData.xml',
          range: {
            start: at(malformed, 'id="Marine"', 'id="'.length),
            end: at(malformed, 'id="Marine"', 'id="Marine'.length),
          },
        },
      ],
      isIncomplete: true,
    })
  })

  it('does not guess a local definition when the canonical snapshot is authoritative', async () => {
    const { provider: served, context: serverContext } = overServer({
      entities: [{ namespace: 'Actor', typeId: 'CActor', entityId: 'OnlyResolvedActor' }],
    })
    const context = serverContext()
    const list = await served.definition!(
      request(UNITS, {
        workspaceIncomplete: false,
        workspaceContext: context,
        position: at(UNITS, 'parent="Marine"', 'parent="'.length + 1),
      }),
    )
    expect(list).toEqual({ locations: [], isIncomplete: false })
    const partial = await served.definition!(request(UNITS, {
      workspaceIncomplete: true,
      workspaceContext: { ...context, revision: `${context.revision}:edited`, semanticComplete: false },
      position: at(UNITS, 'parent="Marine"', 'parent="'.length + 1),
    }))
    expect(partial.locations).toHaveLength(1)
    expect(partial.locations[0]?.uri).toBe('memory://UnitData.xml')
    expect(partial.isIncomplete).toBe(true)
  })

  it('says it is incomplete rather than guessing for a text or asset target', async () => {
    // A text key lives in a locale catalog and an asset on disk; neither is in this snapshot.
    const text = UNITS.replace('<LifeMax value="45"/>', '<Name value="Unit/Name/Marine"/>')
    const list = await provider.definition!(
      request(text, { position: at(text, 'Unit/Name/Marine', 2) }),
    )
    expect(list.locations).toEqual([])
  })

  it('finds every reference to an entity, in this document and the snapshot', async () => {
    const list = await provider.references!(
      request(UNITS, {
        workspaceDocuments: [document(ABILS, 'memory://AbilData.xml')],
        position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
        includeDeclaration: true,
      }),
    )
    expect(list.locations.length).toBeGreaterThanOrEqual(2)
    expect(list.locations.every(location => location.uri === 'memory://UnitData.xml')).toBe(true)
  })

  it('scans a frozen snapshot document once for references, and a changed one again', async () => {
    // The host's capture of an unchanged document is the same frozen object on every request.
    const units = Object.freeze(document(UNITS, 'memory://UnitData.xml'))
    const edited = UNITS.replaceAll('Marine', 'Reaper')
    const open = '<Catalog><CUnit id="Hero" parent="Marine"/></Catalog>'
    const ask = (other: object) =>
      provider.references!(
        request(open, {
          document: document(open, 'memory://Open/UnitData.xml'),
          workspaceDocuments: [other],
          position: at(open, 'parent="Marine"', 'parent="'.length + 1),
          includeDeclaration: true,
        }),
      )
    const refs = vi.spyOn(languageReferences, 'collectAllRefs')
    try {
      const first = await ask(units)
      expect(first.locations.map(location => location.uri)).toEqual([
        'memory://Open/UnitData.xml',
        'memory://UnitData.xml',
        'memory://UnitData.xml',
      ])
      expect(await ask(units)).toEqual(first)
      expect(refs.mock.calls.filter(([scanned]) => scanned === UNITS)).toHaveLength(1)
      const changed = await ask(Object.freeze(document(edited, 'memory://UnitData.xml')))
      expect(refs.mock.calls.filter(([scanned]) => scanned === edited)).toHaveLength(1)
      expect(changed.locations.map(location => location.uri)).toEqual(['memory://Open/UnitData.xml'])
    } finally {
      refs.mockRestore()
    }
  })
})

describe('sc2-data completion', () => {
  it('does not reparse token-free catalogs while retaining inherited token completion', async () => {
    const parser = vi.spyOn(catalogXml, 'parseCatalogXmlElements')
    try {
      const template = '<Catalog><CUnit id="TokenTemplate"><?token id="Weapon" type="CWeaponLink"?></CUnit></Catalog>'
      const ordinary = '<Catalog><CUnit id="PlainParent"><LifeMax value="45"/></CUnit></Catalog>'
      const text = '<Catalog><CUnit id="Child" parent="TokenTemplate" ></CUnit></Catalog>'
      const answer = await provider.completion!(request(text, {
        position: at(text, 'parent="TokenTemplate" ', 'parent="TokenTemplate" '.length),
        workspaceDocuments: [
          document(ordinary, 'memory://TokenParseBudget/UnitData.xml'),
          document(template, 'memory://TokenParseBudget/TemplateData.xml'),
        ],
      }))
      expect(answer.items.map(item => item.label)).toContain('Weapon')
      expect(parser).toHaveBeenCalledTimes(1)
      expect(parser).toHaveBeenCalledWith(template)
    } finally {
      parser.mockRestore()
    }
  })

  it('offers a template chain\'s tokens without a resolved snapshot (plan 1.1)', async () => {
    const text = [
      '<Catalog>',
      '  <CActorUnit id="Root" default="1"><?token id="unitName" type="CUnitLink"?></CActorUnit>',
      '  <CActorUnit id="Middle" parent="Root" default="1"><?token id="effectImpact" type="CEffectLink"?></CActorUnit>',
      '  <CActorUnit id="Leaf" parent="Middle" ></CActorUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const list = await provider.completion!(
      request(text, {
        document: document(text, 'memory://ActorData.xml'),
        position: at(text, 'parent="Middle" ', 'parent="Middle" '.length),
      }),
    )
    expect(list.items.map(item => item.label)).toEqual(expect.arrayContaining(['unitName', 'effectImpact']))
  })

  it('uses the same editor categories, inherited tokens and templates in full and compact views', async () => {
    const categoriesText =
      '<Catalog><CUnit id="Child"><EditorCategories value="Race:"/></CUnit></Catalog>'
    const categoryPosition = at(categoriesText, 'Race:', 'Race:'.length)
    const tokenText = '<Catalog><CUnit id="Child" parent="Template" ></CUnit></Catalog>'
    const tokenPosition = at(tokenText, 'parent="Template" ', 'parent="Template" '.length)
    const parentText = '<Catalog><CUnit id="Child" parent=""></CUnit></Catalog>'
    const parentPosition = at(parentText, 'parent="', 'parent="'.length)

    const { provider: served, context } = metadataServer()
    const workspaceContext = context()
    const categories = await served.completion!(
      request(categoriesText, { position: categoryPosition, workspaceContext }),
    )
    expect(categories.items.map(item => item.label)).toEqual(['Terr', 'Prot', 'Zerg'])

    const tokens = await served.completion!(
      request(tokenText, { position: tokenPosition, workspaceContext }),
    )
    expect(tokens.items.find(item => item.label === 'Weapon')).toMatchObject({
      kind: 'property',
      insertText: 'Weapon="$0"',
    })

    const parents = await served.completion!(
      request(parentText, { position: parentPosition, workspaceContext }),
    )
    expect(parents.items.find(item => item.label === 'Template')).toMatchObject({
      kind: 'constant',
      detail: 'default template',
      sortText: '0_Template',
    })
  })

  it('never offers an anonymous default entity as a parent', async () => {
    // The catalog owner names a `<CUnit default="1">` without an id `@default:CUnit:<doc>:<element>`.
    const text = '<Catalog><CUnit id="Child" parent=""></CUnit></Catalog>'
    const position = at(text, 'parent="', 'parent="'.length)
    const anonymous = '@default:CUnit:0:1'
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine' },
        { namespace: 'Unit', typeId: 'CUnit', entityId: anonymous, defaultTemplate: true },
      ],
    })
    const parents = await served.completion!(request(text, { position, workspaceContext: context() }))
    const labels = parents.items.map(item => item.label)
    expect(labels).toContain('Marine')
    expect(labels).not.toContain(anonymous)
  })

  it('inserts quotes after =, keeps the caret between them and requests value completion', async () => {
    const enumField = Object.entries(getClassFields('CUnit') ?? {}).find(([, field]) => {
      const info = classifyField(field)
      return info.kind === 'enum' && (info.enumMembers?.length ?? 0) > 0
    })?.[0]
    expect(enumField).toBeDefined()
    if (enumField === undefined) return
    const text = `<Catalog><CUnit id="X"><${enumField} value=/></CUnit></Catalog>`
    const position = at(text, 'value=', 'value='.length)
    const result = await provider.onTypeFormatting!(
      request(text, {
        position,
        ch: '=',
        options: { tabSize: 2, insertSpaces: true },
      }),
    )
    expect(result).toEqual({
      edits: [{ range: { start: position, end: position }, newText: '""' }],
      isComplete: true,
      cursor: { line: position.line, character: position.character + 1 },
      requestCompletion: true,
    })
  })

  it('does not duplicate quotes when = is typed before an existing quoted value', async () => {
    const text = '<Catalog><CUnit id="X"><Race value=""/></CUnit></Catalog>'
    const position = at(text, 'value=', 'value='.length)
    const result = await provider.onTypeFormatting!(
      request(text, {
        position,
        ch: '=',
        options: { tabSize: 2, insertSpaces: true },
      }),
    )
    expect(result).toEqual({ edits: [], isComplete: true })
  })

  it('resolves file-field completion from the host content path index', async () => {
    let hit:
      | { readonly className: string; readonly fieldName: string; readonly extensions: string[] }
      | undefined
    for (const className of [
      'CActorCutscene',
      'CActorDoodad',
      'CActorUnit',
      'CArmyUnit',
      'CButton',
    ]) {
      const fields = getClassFields(className)
      if (fields === undefined) continue
      for (const [fieldName, fieldType] of Object.entries(fields)) {
        const info = classifyField(fieldType)
        if (info.kind !== 'file' && !(info.kind === 'link' && info.isFileLink === true)) continue
        hit = { className, fieldName, extensions: fileExtensions(info.typeName) }
        break
      }
      if (hit !== undefined) break
    }
    expect(hit).toBeDefined()
    if (hit === undefined) return
    const wantedExtension = hit.extensions[0] ?? '.dds'
    const wanted = `Assets/Test/Marine${wantedExtension}`
    const text = `<Catalog><${hit.className} id="X"><${hit.fieldName} value="Assets/|"/></${hit.className}></Catalog>`
    const position = at(text, 'Assets/|'.replace('|', ''), 'Assets/'.length)
    const cleanText = text.replace('|', '')
    const list = await provider.completion!(
      request(cleanText, {
        document: document(cleanText, `memory://${hit.className.slice(1)}Data.xml`),
        position,
        workspaceContext: {
          id: 'test',
          revision: 'test',
          semanticComplete: true,
          documentOrigins: [],
          semanticInputs: [
            {
              kind: 'content-path-index',
              id: 'test',
              revision: 'test',
              payload: {
                schemaVersion: 1,
                isComplete: true,
                paths: [wanted, 'Assets/Test/Ignore.xml'],
              },
            },
          ],
        },
      }),
    )
    expect(list.items.map(item => item.label)).toContain(wanted.replaceAll('/', '\\'))
    expect(list.items.map(item => item.label)).not.toContain('Assets\\Test\\Ignore.xml')
    const item = list.items.find(entry => entry.label === wanted.replaceAll('/', '\\'))
    expect(item?.kind).toBe('file')
    // A picture path names its asset for the host to draw; the provider never decodes it.
    if (/\.(?:dds|tga|png|jpe?g)$/iu.test(wantedExtension)) {
      expect(item?.asset).toEqual({ path: wanted.replaceAll('/', '\\') })
    }
    // A prefix no file has offers nothing, not bare extensions (plan 1.4).
    const missText = cleanText.replace('Assets/', 'Nowhere/')
    const miss = await provider.completion!(
      request(missText, {
        document: document(missText, `memory://${hit.className.slice(1)}Data.xml`),
        position: at(missText, 'Nowhere/', 'Nowhere/'.length),
      }),
    )
    expect(miss.items.filter(entry => entry.label.startsWith('.'))).toEqual([])
  })

  it.each([
    ['Unit', 'memory://UnitData.xml'],
    ['Actor', 'memory://ActorData.xml'],
  ])(
    'offers only %s classes, const and valid root structure defaults in an empty typed file',
    async (namespace, uri) => {
      const text = '<Catalog><</Catalog>'
      const position = at(text, '<Catalog><', '<Catalog><'.length)
      const list = await provider.completion!(
        request(text, {
          document: document(text, uri),
          maxResults: 5000,
          position,
        }),
      )
      const expected = [
        ...catalogClassesForNamespace(namespace),
        'const',
        ...catalogStructureDefaultsForNamespace(namespace),
      ].sort()
      expect(list.items.map(item => item.label).sort()).toEqual(expected)
    },
  )

  it('offers every catalog class and const, but no structures, in a custom file', async () => {
    const text = '<Catalog><</Catalog>'
    const list = await provider.completion!(
      request(text, {
        document: document(text, 'memory://CustomData.xml'),
        maxResults: 5000,
        position: at(text, '<Catalog><', '<Catalog><'.length),
      }),
    )
    expect(list.items.map(item => item.label).sort()).toEqual([...catalogClasses(), 'const'].sort())
    expect(list.items.some(item => item.label.startsWith('S'))).toBe(false)
  })

  it('returns an editor-ready root snippet with its exact range and documentation', async () => {
    const text = '<Catalog><</Catalog>'
    const position = at(text, '<Catalog><', '<Catalog><'.length)
    const list = await provider.completion!(request(text, { position, maxResults: 5000 }))
    expect(list.items.find(item => item.label === 'CUnit')).toMatchObject({
      kind: 'class',
      documentation: expect.any(String),
      insertText: 'CUnit id="$1">\n\t$0\n</CUnit>',
      insertTextFormat: 'snippet',
      replacementRange: { start: position, end: position },
    })
  })

  it('returns editor-ready field and attribute snippets with ranges and documentation', async () => {
    const fieldText = '<Catalog><CUnit id="X"><</CUnit></Catalog>'
    const fieldPosition = at(fieldText, 'id="X"><', 'id="X"><'.length)
    const fields = await provider.completion!(
      request(fieldText, { position: fieldPosition, maxResults: 5000 }),
    )
    expect(fields.items.find(item => item.label === 'LifeMax')).toMatchObject({
      kind: 'field',
      documentation: expect.any(String),
      insertText: 'LifeMax value="$0"/>',
      insertTextFormat: 'snippet',
      replacementRange: { start: fieldPosition, end: fieldPosition },
    })

    const attributeText = '<Catalog><CUnit ></CUnit></Catalog>'
    const attributePosition = at(attributeText, 'CUnit ', 'CUnit '.length)
    const attributes = await provider.completion!(
      request(attributeText, { position: attributePosition }),
    )
    expect(attributes.items.find(item => item.label === 'id')).toMatchObject({
      kind: 'property',
      documentation: expect.any(String),
      insertText: 'id="$0"',
      insertTextFormat: 'snippet',
      replacementRange: { start: attributePosition, end: attributePosition },
    })
  })

  it('uses the structural schema for an AddedOnArray snippet and its attributes', async () => {
    const fieldText = '<Catalog><CUnit id="X"><</CUnit></Catalog>'
    const fieldPosition = at(fieldText, 'id="X"><', 'id="X"><'.length)
    const fields = await provider.completion!(
      request(fieldText, { position: fieldPosition, maxResults: 5000 }),
    )
    expect(fields.items.find(item => item.label === 'AddedOnArray')).toMatchObject({
      insertText: 'AddedOnArray index="$1" value="$0"/>',
      insertTextFormat: 'snippet',
    })

    const attributeText = '<Catalog><CUnit id="X"><AddedOnArray /></CUnit></Catalog>'
    const attributePosition = at(attributeText, 'AddedOnArray ', 'AddedOnArray '.length)
    const attributes = await provider.completion!(
      request(attributeText, { position: attributePosition }),
    )
    expect(attributes.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['class', 'UnitLink', 'BehaviorLink', 'ParentBehaviorLink']),
    )
  })

  it('offers the entity classes valid at the catalog root', async () => {
    const text = UNITS.replace('    <CUnit id="Marine">', '    <')
    const list = await provider.completion!(request(text, { position: at(text, '    <', 5) }))
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.some(item => item.label.startsWith('C'))).toBe(true)
  })

  it('offers ids from the workspace snapshot when completing a link', async () => {
    const text = UNITS.replace('parent="Marine"', 'parent="')
    const list = await provider.completion!(
      request(text, {
        workspaceDocuments: [document(ABILS, 'memory://AbilData.xml')],
        position: at(text, 'parent="', 'parent="'.length),
      }),
    )
    expect(list.items.map(item => item.label)).toContain('Marine')
  })

  it('takes link ids from the canonical resolved Data snapshot', async () => {
    const text = '<Catalog><CUnit id="Child" parent=""></CUnit></Catalog>'
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'ResolvedMarine' },
        { namespace: 'Abil', typeId: 'CAbilAttack', entityId: 'WrongNamespace' },
      ],
    })
    const list = await served.completion!(
      request(text, {
        position: at(text, 'parent="', 'parent="'.length),
        workspaceContext: context(),
      }),
    )
    expect(list.items.map(item => item.label)).toContain('ResolvedMarine')
    expect(list.items.map(item => item.label)).not.toContain('WrongNamespace')
  })

  // Parity plan 1.3: a link's value describes its target — class, package and file, name.
  it('describes each link target by its class, file and name', async () => {
    const text = '<Catalog><CUnit id="Marine"><WeaponArray Link=""/></CUnit></Catalog>'
    const strings = {
      uri: 'memory://enUS.SC2Data/LocalizedData/GameStrings.txt',
      languageId: 'sc2-strings',
      version: 1,
      text: 'Weapon/Name/GaussRifle=Gauss Rifle\n',
    }
    // The server names the name too: its strings are the chain's, whatever files the snapshot has.
    const { provider: served, context } = overServer({
      entities: [
        {
          namespace: 'Weapon',
          typeId: 'CWeaponLegacy',
          entityId: 'GaussRifle',
          source: { rootId: 'liberty', path: 'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/WeaponData.xml' },
        },
      ],
      strings: [{ key: 'Weapon/Name/GaussRifle', value: 'Gauss Rifle' }],
    })
    const list = await served.completion!(
      request(text, {
        position: at(text, 'Link="', 'Link="'.length),
        workspaceDocuments: [document(text), strings],
        workspaceContext: context(),
      }),
    )
    expect(list.items.find(item => item.label === 'GaussRifle')).toMatchObject({
      detail: 'CWeaponLegacy · Liberty.SC2Mod · WeaponData.xml',
      documentation: expect.stringMatching(/^\*\*Gauss Rifle\*\*/u),
    })
  })

  // Parity plan 1.11: a text link goes to its key's line, the enUS file before another locale's.
  it('goes from a text link to its key in the enUS strings', async () => {
    const text = '<Catalog><CUnit id="Zealot"><Name value="Unit/Name/Zealot"/></CUnit></Catalog>'
    const strings = (locale: string, body: string) => ({
      uri: `memory://${locale}.SC2Data/LocalizedData/GameStrings.txt`,
      languageId: 'sc2-strings',
      version: 1,
      text: body,
    })
    const result = await provider.definition!(
      request(text, {
        position: at(text, 'Unit/Name/Zealot', 3),
        workspaceDocuments: [
          document(text),
          strings('deDE', 'Unit/Name/Zealot=Berserker\n'),
          strings('enUS', 'Unit/Name/Marine=Marine\n  Unit/Name/Zealot=Zealot\n'),
        ],
      }),
    )
    expect(result.locations).toEqual([
      {
        uri: 'memory://enUS.SC2Data/LocalizedData/GameStrings.txt',
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 + 'Unit/Name/Zealot'.length } },
      },
    ])
  })

  // Parity plan 1.22: a text link names a key of the snapshot's GameStrings, in some locale.
  it('reports a text key no GameStrings of a complete snapshot has', async () => {
    const text = '<Catalog><CUnit id="Marine"><Name value="Unit/Name/Missing"/></CUnit><CUnit id="Zealot"><Name value="Unit/Name/Zealot"/></CUnit></Catalog>'
    const strings = {
      uri: 'memory://enUS.SC2Data/LocalizedData/GameStrings.txt',
      languageId: 'sc2-strings',
      version: 1,
      text: 'Unit/Name/Zealot=Zealot\n',
    }
    const messages = async (workspaceIncomplete: boolean) =>
      (
        await provider.diagnostics!(
          request(text, { workspaceDocuments: [document(text), strings], workspaceIncomplete }),
        )
      ).diagnostics.map(item => item.message)
    const complete = await messages(false)
    expect(complete).toContain("Unknown text key 'Unit/Name/Missing' (no such localized string)")
    expect(complete.some(message => message.includes('Unit/Name/Zealot'))).toBe(false)
    // A snapshot without every dependency cannot say a key is missing.
    expect((await messages(true)).some(message => message.startsWith('Unknown text key'))).toBe(false)
  })

  /*
   * Parity plan 1.28: what the server said at a revision is kept by that revision and the other
   * documents by their versions, so a keystroke asks nothing again and still sees its own entity.
   */
  it('keeps the answers between requests and still sees the edited document', async () => {
    const { provider: served, context, questions } = overServer({
      entities: Array.from({ length: 1_000 }, (_, index) => ({
        namespace: 'Unit', typeId: 'CUnit', entityId: `Unit${index}`,
      })),
    })
    const others = [document(ABILS, 'memory://AbilData.xml')]
    const complete = (text: string, workspaceContext: Readonly<Record<string, unknown>>, over = served) =>
      over.completion!(
        request(text, {
          position: at(text, 'parent="', 'parent="'.length),
          workspaceContext,
          workspaceDocuments: [document(text), ...others],
          maxResults: 5_000,
        }),
      )
    const first = '<Catalog><CUnit id="Child" parent=""></CUnit></Catalog>'
    await complete(first, context())
    const asked = questions.length
    const edited = '<Catalog><CUnit id="Typed"/><CUnit id="Child" parent=""></CUnit></Catalog>'
    const started = performance.now()
    const list = await complete(edited, context({ revision: 'snapshot:edited', semanticComplete: false }))
    const elapsed = performance.now() - started
    expect(list.items.map(item => item.label)).toEqual(expect.arrayContaining(['Unit999', 'Typed']))
    expect(elapsed).toBeLessThan(100)
    // The keystroke asks only what it adds (the typed entity's name), never the Data spaces again.
    expect(questions.slice(asked).every(question => Object.keys(question as object).every(part => part === 'kind' || part === 'strings'))).toBe(true)
    // Another revision of the server answers anew.
    const owner = overServer({
      entities: [{ namespace: 'Unit', typeId: 'CUnit', entityId: 'ChangedByOwner' }],
    })
    const revised = await complete(edited, owner.context(), owner.provider)
    expect(revised.items.map(item => item.label)).toContain('ChangedByOwner')
    expect(revised.items.map(item => item.label)).not.toContain('Unit999')
  })

  it('offers only the Catalog wrapper at the document root, including the prolog', async () => {
    const list = await provider.completion!(request(UNITS, { position: { line: 0, character: 3 } }))
    expect(list.items.map(item => item.label)).toEqual(['Catalog'])
  })
})

describe('sc2-data rename and workspace symbols', () => {
  it('formats only the requested final newline', async () => {
    const without = UNITS.replace(/\n$/u, '')
    const added = await provider.formatting!(
      request(without, {
        options: { tabSize: 2, insertSpaces: true, finalNewline: true },
      }),
    )
    expect(added.edits).toEqual([
      {
        range: { start: at(without, '', without.length), end: at(without, '', without.length) },
        newText: '\n',
      },
    ])
    const removed = await provider.formatting!(
      request(UNITS, {
        options: { tabSize: 2, insertSpaces: true, finalNewline: false },
      }),
    )
    expect(removed.edits).toHaveLength(1)
    expect(removed.edits[0]?.newText).toBe('')
  })

  it('offers a revision-bound source action for a missing final newline', async () => {
    const text = UNITS.replace(/\n$/u, '')
    const position = at(text, '', text.length)
    const result = await provider.codeActions!(
      request(text, {
        range: { start: position, end: position },
        diagnostics: [],
        maxEdits: 4,
      }),
    )
    expect(result).toEqual({
      actions: [
        expect.objectContaining({
          title: 'Add final newline',
          kind: 'source',
          edit: {
            isComplete: true,
            documentChanges: [
              {
                uri: 'memory://UnitData.xml',
                documentVersion: 1,
                edits: [{ range: { start: position, end: position }, newText: '\n' }],
              },
            ],
          },
        }),
      ],
      isIncomplete: false,
    })
  })

  it('offers the identifier under the caret as the rename range, not the whole attribute', async () => {
    const ready = await provider.prepareRename!(
      request(UNITS, { position: at(UNITS, 'parent="Marine"', 'parent="'.length + 1) }),
    )
    expect(ready?.placeholder).toBe('Marine')
    const line = UNITS.split(NL)[ready!.range.start.line] ?? ''
    expect(line.slice(ready!.range.start.character, ready!.range.end.character)).toBe('Marine')
  })

  /*
   * Refusal is the feature here. A rename that reaches only the files that happen to be open
   * leaves the rest pointing at an id that no longer exists — worse than not renaming, because it
   * looks finished.
   */
  it('refuses to rename against a partial workspace snapshot', async () => {
    const edit = await provider.rename!(
      request(UNITS, {
        workspaceIncomplete: true,
        maxEdits: 100,
        newName: 'Grunt',
        position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
      }),
    )
    expect(edit).toBeUndefined()
  })

  it('refuses rename when the host semantic context is partial even if document enumeration finished', async () => {
    const { provider: served, context } = overServer({
      entities: [{ namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine', fields: { LifeMax: '45' } }],
      complete: false,
    })
    const edit = await served.rename!(
      request(UNITS, {
        workspaceIncomplete: false,
        workspaceContext: context(),
        maxEdits: 100,
        newName: 'Grunt',
        position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
      }),
    )
    expect(edit).toBeUndefined()
  })

  /*
   * Without a mod server the snapshot is the whole catalog. A Data document the catalog parser
   * refuses (a line being typed) declares entities a rename would miss, so the rename is refused,
   * as the server's Data session marks such a chain incomplete.
   */
  it('refuses rename over a snapshot whose Data document does not parse', async () => {
    const broken = UNITS.replace('<CUnit id="Marine"', '<\n  <CUnit id="Marine"')
    const renameIn = (text: string) =>
      provider.rename!(
        request(text, {
          workspaceIncomplete: false,
          maxEdits: 100,
          newName: 'Grunt',
          position: at(text, 'id="Marine"', 'id="'.length + 1),
        }),
      )
    expect(await renameIn(broken)).toBeUndefined()
    expect((await renameIn(UNITS))?.isComplete).toBe(true)
  })

  it('renames only to a name GameData can hold, MK2 rule (plan 1.14)', async () => {
    const renameTo = (newName: string) =>
      provider.rename!(
        request(UNITS, {
          workspaceIncomplete: false,
          maxEdits: 100,
          newName,
          position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
        }),
      )
    for (const bad of ['Bad Name', '1Marine', 'Marine"', ''])
      expect(await renameTo(bad), bad).toBeUndefined()
    expect((await renameTo('Marine@Elite.v2'))?.isComplete).toBe(true)
  })

  it('renames every occurrence across a complete snapshot', async () => {
    const edit = await provider.rename!(
      request(UNITS, {
        workspaceIncomplete: false,
        workspaceDocuments: [document(ABILS, 'memory://AbilData.xml')],
        maxEdits: 100,
        newName: 'Grunt',
        position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
      }),
    )
    expect(edit?.isComplete).toBe(true)
    const changed = edit!.documentChanges.find(item => item.uri === 'memory://UnitData.xml')
    // The declaration plus the `parent="Marine"` that names it.
    expect(changed?.edits.length).toBeGreaterThanOrEqual(2)
    expect(changed?.edits.every(item => item.newText === 'Grunt')).toBe(true)
  })

  it('refuses rather than truncating when the change exceeds the caller’s edit budget', async () => {
    const edit = await provider.rename!(
      request(UNITS, {
        workspaceIncomplete: false,
        maxEdits: 1,
        newName: 'Grunt',
        position: at(UNITS, 'id="Marine"', 'id="'.length + 1),
      }),
    )
    expect(edit).toBeUndefined()
  })

  it('finds entities by substring across the snapshot', async () => {
    const list = await provider.workspaceSymbols!(
      request(UNITS, {
        workspaceDocuments: [document(ABILS, 'memory://AbilData.xml')],
        query: 'mar',
      }),
    )
    expect(list.symbols.map(symbol => symbol.name).sort()).toEqual(['Marauder', 'Marine'])
    // Plan 1.15: the query's letters in order, as VS Code matches symbols.
    const fuzzy = await provider.workspaceSymbols!(request(UNITS, { query: 'mrn' }))
    expect(fuzzy.symbols.map(symbol => symbol.name)).toEqual(['Marine'])
  })

  it('lists each canonical entity once at its winning namespace-aware source', async () => {
    const dependency = '<Catalog><CUnit id="Shared"/></Catalog>'
    const override = '<Catalog><CUnit id="Shared"/></Catalog>'
    const actor = '<Catalog><CActor id="Shared"/></Catalog>'
    const dependencyUri = 'memory://dependency/UnitData.xml'
    const overrideUri = 'memory://current/UnitData.xml'
    const actorUri = 'memory://dependency/ActorData.xml'
    const logicalUnit = 'Base.SC2Data/GameData/UnitData.xml'
    const origins = [
      origin(actorUri, 'dependency', 'Base.SC2Data/GameData/ActorData.xml', 0),
      origin(dependencyUri, 'dependency', logicalUnit, 0),
      origin(overrideUri, 'current', logicalUnit, 1),
    ]
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Shared', source: { rootId: 'current', path: logicalUnit } },
        { namespace: 'Actor', typeId: 'CActor', entityId: 'Shared', source: { rootId: 'dependency', path: 'Base.SC2Data/GameData/ActorData.xml' } },
      ],
      uriOf: (layerId, file) => origins.find(item => item.layerId === layerId && item.logicalId === file)?.uri,
    })
    const workspaceContext = context({ documentOrigins: origins })
    const list = await served.workspaceSymbols!(
      request(override, {
        document: document(override, overrideUri),
        workspaceDocuments: [document(dependency, dependencyUri), document(actor, actorUri)],
        workspaceIncomplete: false,
        workspaceContext,
        query: 'shared',
      }),
    )
    // The server lists Data spaces in order, then each space's entities.
    expect(list.symbols.map(symbol => [symbol.containerName, symbol.location.uri])).toEqual([
      ['Actor', actorUri],
      ['Unit', overrideUri],
    ])
    expect(list.isIncomplete).toBe(false)
  })

  it('marks canonical workspace symbols incomplete with a partial semantic snapshot', async () => {
    const origins = [origin('memory://UnitData.xml', 'current', 'Base.SC2Data/GameData/UnitData.xml', 0)]
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine', source: { rootId: 'current', path: 'Base.SC2Data/GameData/UnitData.xml' } },
      ],
      complete: false,
      uriOf: (layerId, file) => origins.find(item => item.layerId === layerId && item.logicalId === file)?.uri,
    })
    const list = await served.workspaceSymbols!(
      request(UNITS, { workspaceIncomplete: false, workspaceContext: context({ documentOrigins: origins }), query: 'marine' }),
    )
    expect(list.symbols.map(symbol => symbol.name)).toEqual(['Marine'])
    expect(list.isIncomplete).toBe(true)
  })
  it('explains a field with its resolved value, its origin and its type', async () => {
    const hover = await provider.hover!(
      request(UNITS, { position: at(UNITS, '<LifeMax value="125"', 2) }),
    )
    expect(hover?.markdown).toContain('**LifeMax** = `125`')
    expect(hover?.markdown).toContain('Real')

    const entity = await provider.hover!(
      request(UNITS, { position: at(UNITS, 'CUnit id="Marauder"', 1) }),
    )
    expect(entity?.markdown).toContain('Parent chain: `Marine` → `Marauder`')
  })

  it('names the texture under the caret and links the entity to its card, graph and resolved view', async () => {
    const text = [
      '<Catalog>',
      '    <CButton id="Marine">',
      '        <Icon value="Assets\\Textures\\btn-unit-terran-marine.dds"/>',
      '    </CButton>',
      '    <CUnit id="Marauder" parent="Marine"/>',
      '</Catalog>',
    ].join(NL)
    const picture = await provider.hover!(request(text, { position: at(text, 'btn-unit', 2) }))
    expect(picture?.assets).toEqual([{ path: 'Assets\\Textures\\btn-unit-terran-marine.dds' }])

    const parent = await provider.hover!(request(text, { position: at(text, 'parent="Marine"', 10) }))
    expect(parent?.commands?.map(link => link.command)).toEqual([
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'card' },
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'graph' },
      { kind: 'open-subject', subjectId: 'modkit-subject://blizzard%2Fsc2-data/Unit/Marine', view: 'resolved' },
    ])
    expect(parent?.assets).toBeUndefined()
  })

  it('resolves an inherited value across the snapshot, naming the file that set it', async () => {
    const child = [
      '<Catalog>',
      '    <CUnit id="MarineVet" parent="Marine">',
      '        <Speed value="3"/>',
      '    </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const hover = await provider.hover!(
      request(child, {
        document: document(child, 'memory://Other.xml'),
        workspaceDocuments: [document(UNITS)],
        position: at(child, 'CUnit id="MarineVet"', 1),
      }),
    )
    // The parent lives in the other document; without the snapshot the chain would stop at the child.
    expect(hover?.markdown).toContain('Parent chain: `Marine` → `MarineVet`')
  })

  it('shows canonical default-template and inherited-token metadata in full and compact hovers', async () => {
    const text = '<Catalog><CUnit id="Template"/></Catalog>'
    const { provider: served, context } = metadataServer()
    const hover = await served.hover!(
      request(text, { position: at(text, 'CUnit', 2), workspaceContext: context() }),
    )
    expect(hover?.markdown).toContain('Default template')
    expect(hover?.markdown).toContain('Tokens: `Weapon`')
  })

  it('uses the canonical resolved snapshot for values and keeps equal ids in separate namespaces', async () => {
    const text = [
      '<Catalog>',
      '    <CUnit id="Shared" parent="Base">',
      '        <LifeMax value="authored-value"/>',
      '    </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    // The server's values win over the open text; Shared inherits LifeMax from Base.
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Base', fields: { LifeMax: '91' } },
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Shared', parentEntityId: 'Base' },
        { namespace: 'Abil', typeId: 'CAbilAttack', entityId: 'Shared', fields: { LifeMax: '7' } },
      ],
    })
    const workspaceContext = context()
    const field = await served.hover!(
      request(text, {
        position: at(text, '<LifeMax', 2),
        workspaceContext,
      }),
    )
    expect(field?.markdown).toContain('**LifeMax** = `91`')
    expect(field?.markdown).toContain('inherited from `Base`')

    const entity = await served.hover!(
      request(text, {
        position: at(text, 'CUnit id="Shared"', 1),
        workspaceContext,
      }),
    )
    expect(entity?.markdown).toContain('Parent chain: `Base` → `Shared`')
  })

  it('reads ids, inheritance and effective field origins from the server', async () => {
    const text =
      '<Catalog><CUnit id="Shared" parent="Base"><LifeMax value="wrong"/></CUnit></Catalog>'
    const { provider: served, context } = overServer({
      entities: [
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Base', fields: { LifeMax: '91' } },
        { namespace: 'Unit', typeId: 'CUnit', entityId: 'Shared', parentEntityId: 'Base' },
      ],
    })
    const workspaceContext = context()
    const hover = await served.hover!(
      request(text, { position: at(text, '<LifeMax', 2), workspaceContext }),
    )
    expect(hover?.markdown).toContain('**LifeMax** = `91`')
    expect(hover?.markdown).toContain('inherited from `Base`')

    const completionText = '<Catalog><CUnit id="Child" parent=""></CUnit></Catalog>'
    const completion = await served.completion!(
      request(completionText, {
        position: at(completionText, 'parent="', 'parent="'.length),
        workspaceContext,
      }),
    )
    expect(completion.items.map(item => item.label)).toEqual(
      expect.arrayContaining(['Base', 'Shared']),
    )
  })

  it('keeps local hover usable when a partial resolved snapshot omitted the live entity', async () => {
    const { provider: served, context } = overServer({
      entities: [{ namespace: 'Actor', typeId: 'CActor', entityId: 'OnlyResolvedActor' }],
      complete: false,
    })
    const hover = await served.hover!(
      request(UNITS, {
        position: at(UNITS, '<LifeMax value="45"', 2),
        workspaceContext: context(),
      }),
    )
    expect(hover?.markdown).toContain('**LifeMax** = `45`')
  })
})
