import { describe, expect, it, vi } from 'vitest'

import { createProvider } from '../language/provider.js'
import { createGalaxyServedReferences } from '../language/served-references.js'
import { createServedLinkIndex, servedLinkUri } from '../language/served-links.js'
import { Parser } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import {
  galaxyCompletion,
  galaxyDefinition,
  galaxyDiagnostics,
  galaxyHover,
  galaxyServedCompletionApplies,
  galaxyReferences,
  galaxyServedFeatureApplies,
  galaxySignatureHelp,
} from '../language/semantic-provider.js'

/** A chain of two layers: a dependency library and the mod's own scripts. */
const files = [
  { layerId: 'core', path: 'base.sc2data/triggerlibs/lib.galaxy', uri: 'zz-source://core/lib.galaxy',
    text: 'int Shared(int a) { return a; }\nstatic int Hidden() { return 1; }\n' },
  { layerId: 'mod', path: 'Base.SC2Data/Lib.galaxy', uri: 'file:///mod/Base.SC2Data/Lib.galaxy',
    text: 'void Assist() {\n}\nint UsesShared() { return Shared(2); }\n' },
  { layerId: 'mod', path: 'Base.SC2Data/MapScript.galaxy', uri: 'file:///mod/Base.SC2Data/MapScript.galaxy',
    text: 'include "Lib"\nvoid Init() {\n    int local = 1;\n    Assist();\n    Shared(local);\n    UnitCreate(1, "Marine", 0, 1, null, 0.0);\n}\n' },
]
/** A catalog of the chain that declares no Marine: the script's "Marine" literal resolves to nothing. */
const catalog = { layerId: 'core', path: 'base.sc2data/gamedata/unitdata.xml', uri: 'zz-source://core/unitdata.xml',
  text: '<Catalog>\n    <CUnit id="Zergling"/>\n</Catalog>\n' }
const documentOf = (file: (typeof files)[number]) =>
  Object.freeze({ uri: file.uri, languageId: 'galaxy', version: 1, text: file.text })
const positionAt = (text: string, needle: string, delta = 0) => {
  const before = text.slice(0, text.indexOf(needle) + delta).split('\n')
  return { line: before.length - 1, character: before.at(-1)!.length }
}

/** A loaded mod's server over the same files, answering as the SC2 mod server answers. */
function server(texts = files) {
  const index = createGalaxyServedReferences()
  const query = vi.fn(async (_scope: string, question: Record<string, unknown>) => {
    const document = question['document'] as { layerId: string; path: string }
    index.update(texts, `${document.layerId}\u0000${document.path}`)
    const offset = question['offset'] as number
    const uri = question['uri'] as string
    if (question['kind'] === 'galaxy.hover') return { revision: '7', ...index.hover(document.layerId, document.path, offset, uri)! }
    if (question['kind'] === 'galaxy.diagnostics') {
      // The server's link index over the same chain: its scripts and the catalog.
      const links = createServedLinkIndex([...texts.map(file => ({ ...file, languageId: 'galaxy' })),
        { ...catalog, languageId: 'sc2-data' }], false)
      return { revision: '7', ...index.diagnostics(document.layerId, document.path, uri, links,
        servedLinkUri(document.layerId, document.path),
        { maxResults: question['maxResults'] as number, incomplete: question['incomplete'] as boolean })! }
    }
    if (question['kind'] === 'galaxy.completion') {
      return { revision: '7', ...index.completion(document.layerId, document.path, offset, uri, {
        maxResults: question['maxResults'] as number,
        ...(question['functionExpand'] === undefined ? {} : { functionExpand: question['functionExpand'] as string }),
      })! }
    }
    if (question['kind'] === 'galaxy.signature-help') {
      return { revision: '7', ...index.signatureHelp(document.layerId, document.path, offset, uri)! }
    }
    if (question['kind'] === 'galaxy.definition') {
      const answer = index.definition(document.layerId, document.path, offset, uri)!
      return {
        revision: '7',
        ...answer,
        documents: answer.documents.map(item => ({
          ...item,
          uri: texts.find(file => file.layerId === item.layerId && file.path === item.path)!.uri,
        })),
      }
    }
    const answer = index.references(document.layerId, document.path, offset,
      question['includeDeclaration'] as boolean)!
    return {
      revision: '7',
      ...answer,
      // The host names each document with the URI its workspace uses.
      documents: answer.documents.map(item => ({
        ...item,
        uri: texts.find(file => file.layerId === item.layerId && file.path === item.path)!.uri,
      })),
    }
  })
  return { modContexts: { query }, query }
}

const snapshotRequest = (file: (typeof files)[number], needle: string, delta: number, includeDeclaration: boolean) => ({
  document: documentOf(file),
  workspaceDocuments: files.map(documentOf),
  workspaceIncomplete: false,
  maxResults: 128,
  maxDocuments: 8,
  position: positionAt(file.text, needle, delta),
  includeDeclaration,
})
const servedRequest = (file: (typeof files)[number], needle: string, delta: number, includeDeclaration: boolean) => ({
  ...snapshotRequest(file, needle, delta, includeDeclaration),
  workspaceDocuments: [documentOf(file)],
  workspaceContext: {
    id: 'context', revision: 'r', semanticComplete: true, documentOrigins: [], semanticInputs: [],
    modContext: { scope: 'mod-context:1', gameId: 'blizzard/starcraft-2', revision: '7', complete: true,
      document: { layerId: file.layerId, path: file.path } },
  },
})

describe('Galaxy references from the loaded mod server', () => {
  it('shares one parsed filename with mixed links without sharing mutable workspace indexes', () => {
    const file = { layerId: 'shared-parse-proof', path: 'Base.SC2Data/SharedParse.galaxy',
      text: 'void SharedParseProof() { UnitCreate(1, "Marine", 0, 1, null, 0.0); }\n' }
    const parse = vi.spyOn(Parser.prototype, 'parseFile')
    try {
      const index = createGalaxyServedReferences()
      index.update([file], `${file.layerId}\u0000${file.path}`)
      const before = index.references(file.layerId, file.path, file.text.indexOf('SharedParseProof') + 2, true)
      createServedLinkIndex([{ layerId: 'shared-parse-proof', path: 'UnitData.xml',
        languageId: 'sc2-data', text: '<Catalog><CUnit id="Marine"/></Catalog>' },
        { ...file, languageId: 'galaxy' }], false)
      const parses = parse.mock.calls.filter(([, code]) => code === file.text)
      expect(parses).toHaveLength(1)
      expect(parses[0]![0]).toBe(servedLinkUri(file.layerId, file.path))
      const other = createGalaxyServedReferences()
      other.update([{ ...file, text: file.text.replace('SharedParseProof', 'PrivateEditedProof') }], `${file.layerId}\u0000${file.path}`)
      expect(index.references(file.layerId, file.path, file.text.indexOf('SharedParseProof') + 2, true)).toEqual(before)
      expect(before?.documents).toEqual([{ layerId: file.layerId, path: file.path }])
    } finally { parse.mockRestore() }
  })

  it('omits absent hover and signature help so empty answers remain JSON', () => {
    const index = createGalaxyServedReferences()
    index.update(files, `${files[1]!.layerId}\u0000${files[1]!.path}`)
    const file = files[1]!
    const signature = index.signatureHelp(file.layerId, file.path, file.text.indexOf('Assist') + 1, file.uri)
    expect(signature).toStrictEqual({ incomplete: false })
    expect(index.hover(file.layerId, file.path, file.text.length, file.uri)).toStrictEqual({ incomplete: false })
  })

  it('keeps the asked oversized script while retaining the existing bounds for other scripts', () => {
    const large = { layerId: 'bound-proof', path: 'Large.galaxy', text: `/*${' '.repeat(2 * 1024 * 1024)}*/\nvoid KeptProof() {}\n` }
    const small = { layerId: 'bound-proof', path: 'Small.galaxy', text: 'void SmallProof() {}\n' }
    const index = createGalaxyServedReferences()
    index.update([large, small], `${large.layerId}\u0000${large.path}`)
    expect(index.references(large.layerId, large.path, large.text.indexOf('KeptProof') + 2, true))
      .toMatchObject({ incomplete: false, documents: [{ layerId: large.layerId, path: large.path }] })
    index.update([large, small], `${small.layerId}\u0000${small.path}`)
    expect(index.references(large.layerId, large.path, large.text.indexOf('KeptProof') + 2, true)).toBeUndefined()
    expect(index.references(small.layerId, small.path, small.text.indexOf('SmallProof') + 2, true)).toMatchObject({ incomplete: true })
  })

  it.each([
    ['a mod function across files', 2, 'Assist();', 1],
    ['a dependency function from the mod', 2, 'Shared(local)', 1],
    ['a dependency declaration itself', 0, 'Shared(int', 1],
    ['a native', 2, 'UnitCreate', 2],
  ] as const)('answers %s exactly as the snapshot index does', async (_name, fileAt, needle, delta) => {
    const file = files[fileAt]!
    for (const includeDeclaration of [true, false]) {
      const expected = await galaxyReferences(snapshotRequest(file, needle, delta, includeDeclaration))
      const { modContexts, query } = server()
      const served = await galaxyReferences(servedRequest(file, needle, delta, includeDeclaration), modContexts)
      expect(query).toHaveBeenCalledOnce()
      expect(served).toEqual(expected)
    }
    expect((await galaxyReferences(snapshotRequest(file, needle, delta, true))).locations.length).toBeGreaterThan(0)
  })

  it('answers scoped locals from the live document without asking the server', async () => {
    const file = files[2]!
    const { modContexts, query } = server()
    const served = await galaxyReferences(servedRequest(file, 'local);', 0, true), modContexts)
    expect(query).not.toHaveBeenCalled()
    expect(served).toEqual(await galaxyReferences(snapshotRequest(file, 'local);', 0, true)))
  })

  it('re-analyses only changed files and sees an unsaved edit', async () => {
    const index = createGalaxyServedReferences()
    index.update(files, 'core\u0000base.sc2data/triggerlibs/lib.galaxy')
    const before = index.references('core', 'base.sc2data/triggerlibs/lib.galaxy', 5, true)!
    const edited = files.map(file => file.path.endsWith('MapScript.galaxy')
      ? { ...file, text: `${file.text}void Again() { Shared(3); }\n` }
      : file)
    index.update(edited, 'core\u0000base.sc2data/triggerlibs/lib.galaxy')
    const after = index.references('core', 'base.sc2data/triggerlibs/lib.galaxy', 5, true)!
    expect(after.references.length).toBe(before.references.length + 1)
    index.update(files.filter(file => !file.path.endsWith('MapScript.galaxy')), 'core\u0000base.sc2data/triggerlibs/lib.galaxy')
    expect(index.references('mod', 'Base.SC2Data/MapScript.galaxy', 0, true)).toBeUndefined()
  })

  it('leaves catalog links and the dependency-free provider to the snapshot', async () => {
    const script = documentOf({ ...files[2]!, text: 'void Init() { UnitCreate(1, "Marine", 0, 1, null, 0.0); }' })
    const at = (needle: string, delta: number) => ({ document: script, position: positionAt(script.text, needle, delta) })
    expect(await galaxyServedFeatureApplies({ feature: 'references', ...at('UnitCreate', 2) })).toBe(true)
    expect(await galaxyServedFeatureApplies({ feature: 'references', ...at('"Marine"', 3) })).toBe(false)
    expect(await galaxyServedFeatureApplies({ feature: 'definition', ...at('UnitCreate', 2) })).toBe(true)
    // Completion has its own applicability check (the Host asks it, not the feature check).
    expect(await galaxyServedFeatureApplies({ feature: 'completion', ...at('UnitCreate', 2) })).toBe(false)
    expect(await galaxyServedCompletionApplies(at('UnitCreate', 2))).toBe(true)
    expect(await galaxyServedCompletionApplies(at('"Marine"', 3))).toBe(false)
    const include = documentOf({ ...files[2]!, text: ['include "Lib"', 'void Init() {}', ''].join('\n') })
    expect(await galaxyServedFeatureApplies({ feature: 'definition', document: include, position: positionAt(include.text, 'Lib') })).toBe(false)
    expect(await galaxyServedFeatureApplies({ feature: 'hover', document: include, position: positionAt(include.text, 'Init') })).toBe(true)
    const selection = { contract: 'common.language/document-analysis', major: 1 }
    const without = createProvider(selection).value
    expect(without.modContextFeatures).toBeUndefined()
    const withPort = createProvider(selection, { modContexts: server().modContexts }).value
    expect(withPort.modContextFeatures).toEqual(['hover', 'signatureHelp', 'definition', 'references', 'completion', 'diagnostics', 'rename', 'prepareRename', 'projectDiagnostics', 'workspaceSymbols'])
    expect(withPort.modContextCompletionApplies).toBe(galaxyServedCompletionApplies)
    expect(withPort.semanticContextRequirements).toEqual([{ kind: 'mod-context', gameId: 'blizzard/starcraft-2' }])
  })

  it.each([
    ['a native', 2, 'UnitCreate', 2],
    ['a dependency function', 2, 'Shared(local)', 1],
    ['a mod function across files', 2, 'Assist();', 1],
    ['a scoped local', 2, 'local);', 0],
    ['a declaration itself', 0, 'Shared(int', 1],
  ] as const)('hovers and defines %s exactly as the snapshot does', async (_name, fileAt, needle, delta) => {
    const file = files[fileAt]!
    for (const [served, snapshot] of [[galaxyHover, galaxyHover], [galaxyDefinition, galaxyDefinition]] as const) {
      const expected = await snapshot(snapshotRequest(file, needle, delta, true))
      const { modContexts, query } = server()
      expect(await served(servedRequest(file, needle, delta, true), modContexts)).toEqual(expected)
      expect(query).toHaveBeenCalledOnce()
    }
    expect(await galaxyHover(snapshotRequest(file, needle, delta, true))).toBeDefined()
  })

  it.each([
    ['a dependency function', 'Shared(local', 7],
    ['a native', 'UnitCreate(1, "Marine"', 14],
  ] as const)('gives signature help in a call to %s exactly as the snapshot does', async (_name, needle, delta) => {
    const file = files[2]!
    const expected = await galaxySignatureHelp(snapshotRequest(file, needle, delta, true))
    expect(expected?.signatures.length).toBe(1)
    const { modContexts, query } = server()
    expect(await galaxySignatureHelp(servedRequest(file, needle, delta, true), modContexts)).toEqual(expected)
    expect(query).toHaveBeenCalledOnce()
  })

  it.each([
    ['a name prefix', 'Assist();', 2, undefined],
    ['a name prefix with parameters', 'Shared(local', 3, 'ArgumentsDefault'],
    ['a native prefix', 'UnitCreate', 4, 'Parenthesis'],
    ['a scoped local', 'local);', 2, undefined],
    ['an empty word', '    Assist', 4, 'None'],
  ] as const)('completes %s exactly as the snapshot does', async (_name, needle, delta, functionExpand) => {
    const file = files[2]!
    const extra = functionExpand === undefined ? {} : { functionExpand }
    const expected = await galaxyCompletion({ ...snapshotRequest(file, needle, delta, true), ...extra })
    expect(expected.items.length).toBeGreaterThan(0)
    const { modContexts, query } = server()
    expect(await galaxyCompletion({ ...servedRequest(file, needle, delta, true), ...extra }, modContexts)).toEqual(expected)
    expect(query).toHaveBeenCalledOnce()
    // The bound is the request's.
    const capped = await galaxyCompletion({ ...servedRequest(file, needle, delta, true), ...extra, maxResults: 1 }, server().modContexts)
    expect(capped.items.length).toBe(1)
  })

  it('reports diagnostics exactly as the snapshot does, catalog literals included', async () => {
    const file = files[2]!
    const snapshot = { ...snapshotRequest(file, 'Init', 0, true),
      workspaceDocuments: [...files.map(documentOf), { uri: catalog.uri, languageId: 'sc2-data', version: 1, text: catalog.text }] }
    const expected = await galaxyDiagnostics(snapshot)
    expect(expected.diagnostics.map(item => item.code)).toContain('sc2-cross-language/unresolved-catalog-literal')
    const { modContexts, query } = server()
    expect(await galaxyDiagnostics(servedRequest(file, 'Init', 0, true), modContexts)).toEqual(expected)
    expect(query).toHaveBeenCalledOnce()
    const selection = { contract: 'common.language/document-analysis', major: 1 }
    expect(createProvider(selection, { modContexts }).value.modContextFeatures).toContain('diagnostics')
  })
})
