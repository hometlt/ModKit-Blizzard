import { describe, expect, it, vi } from 'vitest'

import { createSc2StringsLanguageProvider } from '../providers/language/src/language.js'
import { createStringsServedKeys } from '../providers/language/src/served-keys.js'
import {
  galaxyDefinition,
  galaxyPrepareRename,
  galaxyReferences,
  galaxyRename,
} from '../../galaxy/language/semantic-provider.js'

/*
 * A chain's catalogs in two locales, a layout and a Galaxy script naming a key: the loaded mod's
 * server answers a key's definition, references and hover exactly as the snapshot of the same files
 * does. The script names the key once by literal; its comment, a plain string and a computed key
 * do not count.
 */
const script = [
  '// StringExternal("UI/Title") in a comment is no use',
  'void Init () {',
  '    text title = StringExternal("UI/Title");',
  '    string plain = "UI/Title";',
  '    title = StringExternal(plain);',
  '}',
  '',
].join('\n')
const files = [
  { layerId: 'core', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', uri: 'content-source://core/enus/gamestrings.txt',
    text: 'UI/Title=Core title\nUnit/Name/Marine=Marine\n' },
  { layerId: 'mod', path: 'deDE.SC2Data/LocalizedData/GameStrings.txt', uri: 'file:///mod/deDE.SC2Data/LocalizedData/GameStrings.txt',
    text: 'UI/Title=Titel\n' },
  { layerId: 'mod', path: 'Base.SC2Data/UI/Layout/Hud.SC2Layout', uri: 'file:///mod/Base.SC2Data/UI/Layout/Hud.SC2Layout',
    text: '<Desc>\n  <Frame type="Label" name="Title">\n    <Text val="@UI/Title"/>\n  </Frame>\n</Desc>\n' },
  { layerId: 'mod', path: 'MapScript.galaxy', uri: 'file:///mod/MapScript.galaxy', text: script },
]
const catalog = {
  uri: 'file:///mod/enUS.SC2Data/LocalizedData/GameStrings.txt',
  languageId: 'sc2-strings',
  version: 1,
  text: 'UI/Title=Parity <d stringref="Unit,Marine,Name"/>\nUI/Other=x\n',
}
const place = { layerId: 'mod', path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' }
const all = [...files, { ...place, uri: catalog.uri, text: catalog.text }]
const languageOf = (path: string) =>
  /\.txt$/iu.test(path) ? 'sc2-strings' : /\.galaxy$/iu.test(path) ? 'galaxy' : 'sc2-layout'
const positionAt = (needle: string, delta: number) => {
  const offset = catalog.text.indexOf(needle) + delta
  const before = catalog.text.slice(0, offset).split('\n')
  return { line: before.length - 1, character: before.at(-1)!.length }
}

function server() {
  const keys = createStringsServedKeys()
  keys.update(all)
  const query = vi.fn(async (_scope: string, question: unknown) => {
    const asked = question as {
      kind: string; action: string; key: string; document: typeof place; definitions: boolean; uses: boolean; maxResults: number
    }
    expect(asked.kind).toBe('strings.keys')
    expect(asked.document).toEqual(place)
    if (asked.action === 'count') return { revision: '3', count: keys.otherCatalogs(asked.key, asked.document) }
    const answer = keys.locations(asked.key, asked.document, asked, asked.maxResults)
    return {
      revision: '3',
      ...answer,
      documents: answer.documents.map(item => ({
        ...item,
        uri: all.find(file => file.layerId === item.layerId && file.path === item.path)!.uri,
      })),
    }
  })
  return { query }
}

const request = (needle: string, delta: number, served: boolean, extra: Record<string, unknown> = {}) => ({
  document: catalog,
  workspaceDocuments: served
    ? []
    : [catalog, ...files.map(file => ({ uri: file.uri, languageId: languageOf(file.path), version: 1, text: file.text }))],
  workspaceIncomplete: false,
  maxResults: 100,
  maxDocuments: 16,
  position: positionAt(needle, delta),
  ...(served
    ? { workspaceContext: { id: 'c', revision: 'r', semanticComplete: true, documentOrigins: [], semanticInputs: [],
        modContext: { scope: 'mod-context:1', gameId: 'blizzard/starcraft-2', revision: '3', complete: true, document: place } } }
    : {}),
  ...extra,
})

type Applies = { modContextFeatureApplies(request: unknown): Promise<boolean> }

describe('GameStrings keys from the loaded mod server', () => {
  it.each([
    ['definition', {}],
    ['references', { includeDeclaration: true }],
    ['references', { includeDeclaration: false }],
    ['hover', {}],
  ] as const)('answers %s like the snapshot', async (feature, extra) => {
    const snapshot = await createSc2StringsLanguageProvider()[feature]!(request('UI/Title', 2, false, extra) as never)
    const port = server()
    const provider = createSc2StringsLanguageProvider({ modContexts: port })
    expect(await (provider as unknown as Applies)
      .modContextFeatureApplies({ feature, document: catalog, position: positionAt('UI/Title', 2) })).toBe(true)
    const served = await provider[feature]!(request('UI/Title', 2, true, extra) as never)
    expect(port.query).toHaveBeenCalledOnce()
    expect(served).toEqual(snapshot)
  })

  it('finds the key in every locale, the layout and the script, the asked catalog first', async () => {
    const references = await createSc2StringsLanguageProvider({ modContexts: server() })
      .references!(request('UI/Title', 2, true, { includeDeclaration: true }) as never)
    expect(references.locations.map(item => item.uri)).toEqual([catalog.uri, files[0]!.uri, files[1]!.uri, files[2]!.uri, files[3]!.uri])
    // the script's one literal use, inside the quotes of StringExternal
    const literal = script.split('\n')[2]!
    expect(references.locations.at(-1)!.range).toEqual({
      start: { line: 2, character: literal.indexOf('UI/Title') },
      end: { line: 2, character: literal.indexOf('UI/Title') + 'UI/Title'.length },
    })
    const hover = await createSc2StringsLanguageProvider({ modContexts: server() }).hover!(request('UI/Title', 2, true) as never)
    expect(hover?.markdown).toContain('Also defined in 2 other catalog(s).')
  })

  it('asks the mod server for data entities and value markup too', async () => {
    // The server holds the whole language model (languageModel 'server', 6dd26394): no feature of a
    // catalog stays on the snapshot, data entities and markup included.
    const provider = createSc2StringsLanguageProvider({ modContexts: server() }) as unknown as Applies
    const stringref = positionAt('Unit,Marine', 6)
    expect(await provider.modContextFeatureApplies({ feature: 'definition', document: catalog, position: stringref })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'references', document: catalog, position: stringref })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'hover', document: catalog, position: positionAt('Parity', 2) })).toBe(true)
    expect(await provider.modContextFeatureApplies({ feature: 'completion', document: catalog, position: positionAt('UI/Title', 2) })).toBe(true)
  })

  it('renames a key in the StringExternal literals of scripts, and refuses a name a literal cannot hold', async () => {
    const provider = createSc2StringsLanguageProvider()
    const edit = await provider.rename!({ ...request('UI/Title', 2, false), newName: 'UI/Heading', maxEdits: 100 } as never)
    const scriptChange = edit?.documentChanges.find(change => change.uri === files[3]!.uri)
    expect(scriptChange?.edits).toEqual([{
      range: {
        start: { line: 2, character: script.split('\n')[2]!.indexOf('UI/Title') },
        end: { line: 2, character: script.split('\n')[2]!.indexOf('UI/Title') + 'UI/Title'.length },
      },
      newText: 'UI/Heading',
    }])
    expect(edit?.documentChanges.map(change => change.uri)).toEqual(
      expect.arrayContaining([catalog.uri, files[0]!.uri, files[1]!.uri, files[2]!.uri, files[3]!.uri]))
    expect(await provider.rename!({ ...request('UI/Title', 2, false), newName: 'UI\\Heading', maxEdits: 100 } as never)).toBeUndefined()
  })

  it('answers from a StringExternal literal in Galaxy as from the catalog: definition, references, rename', async () => {
    const galaxy = { uri: files[3]!.uri, languageId: 'galaxy', version: 1, text: script }
    const line = script.split('\n')[2]!
    const literal = { line: 2, character: line.indexOf('UI/Title') + 3 }
    const fromScript = (extra: Record<string, unknown> = {}) => ({
      ...request('UI/Title', 2, false, extra),
      document: galaxy,
      position: literal,
    })
    const definition = await galaxyDefinition(fromScript() as never, undefined)
    expect(definition.locations.map(item => item.uri)).toEqual([catalog.uri, files[0]!.uri, files[1]!.uri])
    const fromCatalog = await createSc2StringsLanguageProvider().references!(request('UI/Title', 2, false, { includeDeclaration: true }) as never)
    const references = await galaxyReferences(fromScript({ includeDeclaration: true }) as never, undefined)
    expect(new Set(references.locations.map(item => JSON.stringify(item))))
      .toEqual(new Set(fromCatalog.locations.map(item => JSON.stringify(item))))
    expect((await galaxyPrepareRename(fromScript() as never))?.placeholder).toBe('UI/Title')
    const edit = await galaxyRename({ ...fromScript(), newName: 'UI/Heading', maxEdits: 100 } as never)
    expect(edit?.documentChanges.map(change => change.uri).sort())
      .toEqual([catalog.uri, files[0]!.uri, files[1]!.uri, files[2]!.uri, files[3]!.uri].sort())
  })
})
