/**
 * The sc2-data language provider over a loaded mod's server (owner decision 07.10): every feature
 * asks the server for what it needs (`data.language`) and answers exactly as the provider did over
 * the whole resolved catalog of the same chain (the input path the host no longer sends, core
 * 170450d1). Those answers were recorded once, before that path went, in
 * `sc2-data-language-server.expected.json`. A hover asks one question.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { LanguageFeatureRequest } from '@modkit/sdk'
import { createSc2DataLanguageProvider } from '../providers/language/src/language.js'
import { openStarcraft2DataSession } from '../services/catalog/data-session.js'
import { languageAnswer } from '../../mod/shared/workspace/language-answer.js'
import * as entityOwner from '../shared/format/language/entity.js'

const layers = [
  { id: 'layer:0', sourcePath: 'Mods/Core.SC2Mod', rootId: 'root:core' },
  { id: 'layer:1', sourcePath: 'C:/Mods/Mine.SC2Mod', rootId: 'root:mine' },
] as const

const STOCK_UNITS =
  '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n' +
  '    <CUnit default="1">\n        <LifeMax value="1"/>\n    </CUnit>\n' +
  '    <CUnit id="Marine">\n        <LifeMax value="45"/>\n        <Speed value="2.25"/>\n    </CUnit>\n' +
  '    <CUnit id="Template" default="1">\n        <Speed value="4"/>\n    </CUnit>\n' +
  '</Catalog>\n'
const STOCK_WEAPONS = '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n    <CWeaponLegacy id="GuassRifle"/>\n</Catalog>\n'
const MOD_UNITS =
  '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n' +
  '    <CUnit id="Marine">\n        <LifeMax value="50"/>\n    </CUnit>\n' +
  '    <CUnit id="GoldenMarine" parent="Marine">\n        <LifeMax value="60"/>\n' +
  '        <WeaponArray Link="GuassRifle"/>\n    </CUnit>\n' +
  '    <CUnit id="GoldenHero" parent="GoldenMarine">\n        <Speed value="3"/>\n    </CUnit>\n' +
  '    <CUnit id="Broken" parent="Template">\n        <WeaponArray Link="NoSuchWeapon"/>\n    </CUnit>\n' +
  '</Catalog>\n'
const files = [
  { layer: 0, path: 'base.sc2data/gamedata/unitdata.xml', text: STOCK_UNITS },
  { layer: 0, path: 'base.sc2data/gamedata/weapondata.xml', text: STOCK_WEAPONS },
  { layer: 1, path: 'Base.SC2Data/GameData/UnitData.xml', text: MOD_UNITS },
] as const
const STRINGS = new Map([
  ['Unit/Name/Marine', 'Marine'],
  ['Unit/Name/GoldenMarine', 'Golden Marine'],
])

const uriOf = (layerId: string, path: string) => `memory://${layerId}/${path}`
const session = openStarcraft2DataSession(
  files.map(file => ({ rootId: layers[file.layer].rootId, path: `${layers[file.layer].sourcePath}/${file.path}`, text: file.text })),
  { workspaceId: 'server-test' },
)
const documents = files.map((file, index) => ({
  uri: uriOf(layers[file.layer].id, file.path),
  languageId: 'sc2-data',
  version: 1,
  text: file.text,
  index,
}))
const MOD_URI = documents[2]!.uri
const STOCK_URI = documents[0]!.uri

/** The host's part: complete each document the answer names with the URI the snapshot uses. */
function serverPort(questions: unknown[]) {
  return {
    async query(scope: string, question: unknown) {
      expect(scope).toBe('mod-context:test:1')
      questions.push(question)
      const answer = (await languageAnswer(question, {
        session,
        revision: '1',
        layers,
        strings: async keys => keys.filter(key => STRINGS.has(key)).map(key => ({ key, value: STRINGS.get(key) })),
      })) as { readonly documents: readonly { readonly layerId: string; readonly path: string }[] }
      return { ...answer, documents: answer.documents.map(item => ({ ...item, uri: uriOf(item.layerId, item.path) })) }
    },
  }
}

/** What the provider answered over the whole resolved catalog of this chain, by case. */
const expected = JSON.parse(
  readFileSync(new URL('./sc2-data-language-server.expected.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, unknown>>
/** A recorded answer; `null` stands for none. */
const recorded = (key: string): unknown => {
  expect(Object.hasOwn(expected, key), key).toBe(true)
  return expected[key] ?? undefined
}

const origins = documents.map(document => ({
  uri: document.uri,
  layerId: layers[files[document.index]!.layer].id,
  logicalId: files[document.index]!.path,
  precedence: files[document.index]!.layer,
  sourceRevision: 'r',
  readOnly: files[document.index]!.layer === 0,
}))
const snapshot = documents.map(({ index: _index, ...document }) => document)

function request(uri: string, extra: Record<string, unknown> = {}) {
  const document = snapshot.find(item => item.uri === uri)!
  return {
    document,
    workspaceDocuments: snapshot,
    workspaceIncomplete: false,
    maxResults: 512,
    maxDocuments: 64,
    workspaceContext: {
      id: 'test',
      revision: 'r',
      semanticComplete: true,
      documentOrigins: origins,
      semanticInputs: [{ kind: 'locale-set', id: 'locales', revision: 'r', payload: { locales: ['enUS'] } }],
      modContext: { scope: 'mod-context:test:1', gameId: 'blizzard/starcraft-2', revision: '1', complete: true },
    },
    ...extra,
  } as LanguageFeatureRequest
}

/** The position `delta` code units after the first `needle` of a document's text. */
function at(uri: string, needle: string, delta = 0) {
  const text = snapshot.find(item => item.uri === uri)!.text
  const offset = text.indexOf(needle)
  expect(offset).toBeGreaterThanOrEqual(0)
  const before = text.slice(0, offset + delta).split('\n')
  return { line: before.length - 1, character: before.at(-1)!.length }
}

describe('the sc2-data provider over a loaded mod server', () => {
  it('drops derived search answers after too many needles without changing current results', async () => {
    const questions: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
    const symbols = (query: string) => served.workspaceSymbols!({ ...request(MOD_URI), query })
    const golden = await symbols('marine')
    expect(golden).toEqual(recorded('workspaceSymbols marine'))
    const warm = questions.length
    expect(await symbols('marine')).toEqual(golden)
    expect(questions).toHaveLength(warm)
    for (let index = 0; index < 64; index++) {
      expect((await symbols(`not-declared-${index}`)).symbols).toEqual([])
    }
    const before = questions.length
    expect(await symbols('marine')).toEqual(golden)
    expect(questions.length).toBeGreaterThan(before)
    const reused = questions.length
    expect(await symbols('marine')).toEqual(golden)
    expect(questions).toHaveLength(reused)
  })

  it('does not retain oversized replies but still answers the active request', async () => {
    let calls = 0
    const name = 'x'.repeat(8 * 1_024 * 1_024)
    const served = createSc2DataLanguageProvider({ modContexts: {
      async query(scope, question, signal) {
        calls++
        const answer = await serverPort([]).query(scope, question) as {
          readonly strings?: readonly { readonly key: string; readonly value: string }[]
        }
        signal?.throwIfAborted()
        return { ...answer, strings: answer.strings?.map(entry =>
          entry.key === 'Unit/Name/GoldenMarine' ? { ...entry, value: name } : entry) }
      },
    } })
    const hover = { ...request(MOD_URI), position: at(MOD_URI, 'id="GoldenMarine"', 6) }
    const original = recorded(`hover ${MOD_URI} id="GoldenMarine"`) as { readonly markdown: string }
    const golden = { ...original, markdown: original.markdown.replace('Golden Marine', name) }
    expect(await served.hover!(hover)).toEqual(golden)
    const first = calls
    expect(await served.hover!(hover)).toEqual(golden)
    expect(calls).toBeGreaterThan(first)
  })

  const hovers: readonly [string, string, number][] = [
    [MOD_URI, 'id="GoldenMarine"', 6],
    [MOD_URI, '<LifeMax value="60"', 2],
    [MOD_URI, 'parent="Marine"', 9],
    [MOD_URI, 'Link="GuassRifle"', 8],
    [MOD_URI, '<Speed', 2],
    [MOD_URI, 'Link="NoSuchWeapon"', 8],
    [STOCK_URI, 'id="Marine"', 5],
    [STOCK_URI, '<LifeMax value="45"', 2],
  ]
  it.each(hovers)('hovers %s at %s as over the whole catalog, in one question', async (uri, needle, delta) => {
    const questions: unknown[] = []
    const position = at(uri, needle, delta)
    const served = await createSc2DataLanguageProvider({ modContexts: serverPort(questions) }).hover!({ ...request(uri), position } as never)
    expect(served).toEqual(recorded(`hover ${uri} ${needle}`))
    expect(questions).toHaveLength(1)
  })

  it.each(hovers)('preserves hover and provenance with only the primary document and retained server: %s %s', async (uri, needle, delta) => {
    const questions: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
    const full = request(uri)
    const hover = await served.hover!({
      ...full,
      workspaceDocuments: [full.document],
      workspaceContext: { ...full.workspaceContext, documentOrigins: [] },
      position: at(uri, needle, delta),
    } as never)
    expect(hover).toEqual(recorded(`hover ${uri} ${needle}`))
    expect(questions).toHaveLength(1)
  })

  it('goes to definitions, completes links and parents, and lists lenses and symbols as over the whole catalog', async () => {
    const questions: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
    /** The server's answer, which the whole catalog's recorded one must equal. */
    const as = async <T>(key: string, answer: Promise<T>) => {
      const value = await answer
      expect(value ?? undefined, key).toEqual(recorded(key))
      return value
    }
    for (const [needle, delta] of [['parent="Marine"', 9], ['parent="GoldenMarine"', 10], ['Link="GuassRifle"', 8], ['parent="Template"', 9]] as const) {
      const position = at(MOD_URI, needle, delta)
      const list = await as(`definition ${needle}`, served.definition!({ ...request(MOD_URI), position } as never))
      expect(list.locations.length).toBe(1)
    }
    for (const [needle, delta] of [['parent="Marine"', 8], ['Link="GuassRifle"', 6]] as const) {
      const position = at(MOD_URI, needle, delta)
      const list = await as(`completion ${needle}`, served.completion!({ ...request(MOD_URI), position } as never))
      expect(list.items.length).toBeGreaterThan(0)
    }
    const lenses = await as('codeLenses mod', served.codeLenses!(request(MOD_URI) as never))
    expect(lenses.lenses.some(lens => lens.title === '1 heir')).toBe(true)
    await as('codeLenses stock', served.codeLenses!(request(STOCK_URI) as never))
    const symbols = await as('workspaceSymbols marine', served.workspaceSymbols!({ ...request(MOD_URI), query: 'marine' } as never))
    expect(symbols.symbols.map(symbol => symbol.name)).toEqual(['GoldenMarine', 'Marine'])
    await as('references GoldenMarine', served.references!({ ...request(MOD_URI), position: at(MOD_URI, 'id="GoldenMarine"', 6), includeDeclaration: true } as never))
    const rename = await as('rename GoldenMarine', served.rename!({ ...request(MOD_URI), position: at(MOD_URI, 'id="GoldenMarine"', 6), newName: 'GoldenMarineX', maxEdits: 64 } as never))
    expect(rename).toBeDefined()
  })

  it.each([
    ['parent="Marine"', 8],
    ['Link="GuassRifle"', 6],
  ] as const)(
    'preserves complete semantic completion with only the primary document: %s',
    async (needle, delta) => {
      const questions: unknown[] = []
      const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
      const full = request(MOD_URI)
      const position = at(MOD_URI, needle, delta)
      expect(await served.modContextCompletionApplies!({ document: full.document, position })).toBe(
        true,
      )
      const result = await served.completion!({
        ...full,
        workspaceDocuments: [full.document],
        workspaceContext: { ...full.workspaceContext, documentOrigins: [] },
        position,
      } as never)
      expect(result).toEqual(recorded(`completion ${needle}`))
      expect(questions.length).toBeGreaterThan(0)
    },
  )

  it('keeps asset completion on the bounded listing path', async () => {
    const served = createSc2DataLanguageProvider()
    const text = '<Catalog><CModel id="Model"><Model value="Assets/"/></CModel></Catalog>'
    const offset = text.indexOf('Assets/') + 'Assets/'.length
    expect(
      await served.modContextCompletionApplies!({
        document: { uri: 'memory://ModelData.xml', languageId: 'sc2-data', version: 1, text },
        position: { line: 0, character: offset },
      }),
    ).toBe(false)
  })

  it('does not rebuild a local catalog for repeated complete server completion', async () => {
    const questions: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
    const full = request(MOD_URI)
    const position = at(MOD_URI, 'Link="GuassRifle"', 6)
    await served.completion!({ ...full, position } as never)
    const asked = questions.length
    const scanner = vi.spyOn(entityOwner, 'catalogEntities')
    try {
      for (let repeat = 0; repeat < 5; repeat += 1) {
        expect(
          await served.completion!({
            ...full,
            workspaceDocuments: [full.document],
            workspaceContext: { ...full.workspaceContext, documentOrigins: [] },
            position,
          } as never),
        ).toEqual(recorded('completion Link="GuassRifle"'))
      }
      expect(questions).toHaveLength(asked)
      expect(scanner).not.toHaveBeenCalled()
    } finally {
      scanner.mockRestore()
    }
  })

  it('keeps local declaration recovery when the server context is incomplete', async () => {
    const questions: unknown[] = []
    const server = serverPort(questions)
    const served = createSc2DataLanguageProvider({
      modContexts: {
        async query(scope, question) {
          return { ...(await server.query(scope, question)), complete: false }
        },
      },
    })
    const full = request(MOD_URI)
    const text =
      '<Catalog><CWeaponLegacy id="LocalWeapon"/><CWeaponLegacy id="Child" parent=""/></Catalog>'
    const document = { ...full.document, uri: 'memory://WeaponData.xml', text }
    const result = await served.completion!({
      ...full,
      document,
      workspaceDocuments: [document],
      workspaceContext: { ...full.workspaceContext, semanticComplete: false, documentOrigins: [] },
      position: { line: 0, character: text.indexOf('parent="') + 'parent="'.length },
    } as never)
    expect(result.items.find(item => item.kind !== 'subject-ref' && item.label === 'LocalWeapon')).toMatchObject({
      detail: 'CWeaponLegacy',
    })
    expect(result.isIncomplete).toBe(true)
  })

  it('reports dead links and their fixes as over the whole catalog', async () => {
    const questions: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: serverPort(questions) })
    const diagnostics = await served.diagnostics!(request(MOD_URI) as never)
    expect(diagnostics).toEqual(recorded('diagnostics mod'))
    expect(diagnostics.diagnostics.map(item => item.code)).toContain('sc2-data/unresolved-reference')
    const broken = diagnostics.diagnostics.find(item => item.code === 'sc2-data/unresolved-reference')!
    const actions = await served.codeActions!({ ...request(MOD_URI), range: broken.range, diagnostics: [broken] } as never)
    expect(actions).toEqual(recorded('codeActions broken'))
  })

  it('keeps localized answers separate when the locale order changes at the same mod revision', async () => {
    const askedLocales: unknown[] = []
    const served = createSc2DataLanguageProvider({ modContexts: {
      // The real answer owner returns distinct translations for the same unchanged catalog.
      async query(_scope, question) {
        return languageAnswer(question, {
          session, revision: '1', layers,
          strings: async (keys, locales) => {
            askedLocales.push(locales)
            return keys.map(key => ({ key, value: `${locales?.[0] ?? 'default'}:${key}` }))
          },
        })
      },
    } })
    // Only the requested locale order changes; catalog and workspace revisions stay unchanged.
    const complete = (locales: string[]) => served.completion!({
      ...request(MOD_URI), position: at(MOD_URI, 'parent="Marine"', 8),
      workspaceContext: {
        id: 'test', revision: 'r', semanticComplete: true, documentOrigins: origins,
        semanticInputs: [{ kind: 'locale-set', id: 'locales', revision: 'r', payload: { locales } }],
        modContext: { scope: 'mod-context:test:1', gameId: 'blizzard/starcraft-2', revision: '1', complete: true },
      },
    } as never)
    const english = await complete(['enUS', 'ruRU'])
    const russian = await complete(['ruRU', 'enUS'])
    expect(JSON.stringify(english)).toContain('enUS:Unit/Name/Marine')
    expect(JSON.stringify(russian)).toContain('ruRU:Unit/Name/Marine')
    const asks = askedLocales.length
    expect(await complete(['enUS', 'ruRU'])).toEqual(english)
    expect(askedLocales).toContainEqual(['enUS', 'ruRU'])
    expect(askedLocales).toContainEqual(['ruRU', 'enUS'])
    expect(askedLocales).toHaveLength(asks)
    // The server-backed hover projection has one document and no dependency origins, but keeps
    // the same ordered locale inputs as the full request.
    const hover = (locales: string[]) => {
      const full = request(MOD_URI)
      return served.hover!({
        ...full,
        workspaceDocuments: [full.document],
        position: at(MOD_URI, 'id="GoldenMarine"', 6),
        workspaceContext: {
          ...full.workspaceContext,
          documentOrigins: [],
          semanticInputs: [{ kind: 'locale-set', id: 'locales', revision: 'r', payload: { locales } }],
        },
      } as never)
    }
    const englishHover = await hover(['enUS', 'ruRU'])
    expect(englishHover?.markdown).toContain('enUS:Unit/Name/GoldenMarine')
    expect((await hover(['ruRU', 'enUS']))?.markdown).toContain('ruRU:Unit/Name/GoldenMarine')
    expect(await hover(['enUS', 'ruRU'])).toEqual(englishHover)
  })
})
