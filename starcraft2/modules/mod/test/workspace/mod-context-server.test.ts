/**
 * A mod context is its chain's server (owner decision 07.10): `data.*` questions answered from the
 * chain's Data session, unsaved editor text over the chain's files, a revision that changes with
 * every edit, and files changed on disk seen after `invalidate`.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import { chainCatalogDocuments, createChainData } from '../../shared/workspace/chain-data.js'
import type { ContentSourceStorage } from '../../shared/workspace/content-source-provider.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'
import * as catalogAnalysis from '../../../data/services/catalog/catalog-analysis.js'
import { TypedCatalog } from '../../../data/shared/catalog-engine/sc2-catalog/index.js'
import * as languageAnswers from '../../shared/workspace/language-answer.js'
import { SC2ModReader } from '../../shared/core/reader.js'
import { connectModServer, modServerAddress, serveModServer } from '@modkit/host/node'
import { createLanguageFileClassifier } from '@modkit/host/language'

function memorySource(id: string, files: Record<string, string | Uint8Array>): ContentSourceStorage {
  const table = new Map(Object.entries(files).map(([file, value]) => [file, typeof value === 'string' ? new TextEncoder().encode(value) : value]))
  return {
    id,
    async list(folder) {
      const prefix = folder === '' ? '' : `${folder.toLowerCase()}/`
      const children = new Map<string, { name: string; directory: boolean }>()
      for (const file of table.keys()) {
        if (!file.toLowerCase().startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const name = rest.split('/')[0] as string
        children.set(name.toLowerCase(), { name, directory: rest.includes('/') })
      }
      if (children.size === 0 && prefix !== '') throw new Error(`${folder} does not exist`)
      return [...children.values()]
    },
    async read(file, maxBytes) {
      const hit = [...table].find(([key]) => key.toLowerCase() === file.toLowerCase())
      if (hit === undefined) throw new Error(`${file} does not exist`)
      if (hit[1].byteLength > maxBytes) throw new Error('too large')
      return hit[1]
    },
  }
}

const casc = memorySource('local:casc', {
  'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit default="1"><LifeMax value="1"/></CUnit></Catalog>',
  'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/UnitData.xml':
    '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit><CUnit id="SCV"><LifeMax value="40"/></CUnit></Catalog>',
  'Mods/Liberty.SC2Mod/Base.SC2Data/GameData/WeaponData.xml': '<Catalog><CWeaponLegacy id="GuassRifle"/></Catalog>',
  'Mods/Liberty.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/Marine=Marine\n',
})

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sc2-mod-context-server-'))
afterAll(() => fs.rm(scratch, { recursive: true, force: true }))

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

function contexts(source = casc, languageFiles?: Parameters<typeof createSc2ModContexts>[0]['languageFiles']) {
  return createSc2ModContexts({
    ...(languageFiles === undefined ? {} : { languageFiles }),
    sources: () => new Map([[source.id, source]]),
    hostFolder: directory => {
      const folder = new Sc2FolderSource(directory, 'host', 'host')
      return { id: 'host', list: p => folder.list(p), read: (p, max) => folder.read(p, max), dispose: () => folder.dispose() }
    },
  })
}

const UNIT_DATA = 'Base.SC2Data/GameData/UnitData.xml'

describe('recoverable Resources retention over active contexts', () => {
  /** Isolated native documents exercise the public context without installed game or host paths. */
  const fixture = () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      [`Mods/Tree${index}.SC2Mod/DocumentInfo`, '<DocInfo/>'],
      [`Mods/Tree${index}.SC2Mod/${UNIT_DATA}`, '<Catalog><CUnit id="TreeUnit"><LifeMax value="50"/></CUnit></Catalog>'],
      [`Mods/Tree${index}.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt`, 'Unit/Name/TreeUnit=Tree Unit\n'],
    ]).flat())
    return contexts(memorySource('fixture:resource-retention', files))
  }
  /** Resource nodes are opaque references; the context owns rebuilding their current facts. */
  const root = (context: Awaited<ReturnType<ReturnType<typeof fixture>['open']>>) =>
    context.query({ kind: 'resources.tree', action: 'root' }) as Promise<{ id: string; hasChildren: boolean }>

  it('releases old Resources parses and reconstructs exact active node facts without losing overlays', async () => {
    const loader = fixture()
    const open = (index: number, sessionId: string) => loader.open({ schemaVersion: 1,
      target: { sourceId: 'fixture:resource-retention', path: `Mods/Tree${index}.SC2Mod` }, baseMods: [], locales: ['enUS'], sessionId })
    const contextsOpened: Awaited<ReturnType<typeof open>>[] = []
    const parse = vi.spyOn(SC2ModReader.prototype as unknown as { parseModFiles(base: string): Promise<unknown> }, 'parseModFiles')
    try {
      const alpha = await open(0, 'alpha'), beta = await open(0, 'beta')
      contextsOpened.push(alpha, beta)
      const layer = alpha.layers.at(-1)!
      await alpha.overlay([{ layerId: layer.id, path: UNIT_DATA,
        text: '<Catalog><CUnit id="TreeUnit"><LifeMax value="70"/></CUnit></Catalog>' }])
      const alphaRoot = await root(alpha), betaRoot = await root(beta)
      const before = await alpha.query({ kind: 'resources.tree', action: 'facts', node: alphaRoot })
      const previousParses = parse.mock.calls.filter(([base]) => base.endsWith('Tree0.SC2Mod')).length
      for (let index = 1; index <= 8; index++) {
        const other = await open(index, `pressure-${index}`)
        contextsOpened.push(other)
        await root(other)
      }
      expect(await alpha.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'TreeUnit' }] }))
        .toMatchObject({ entities: [{ fields: { LifeMax: 70 } }] })
      expect(await beta.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'TreeUnit' }] }))
        .toMatchObject({ entities: [{ fields: { LifeMax: 50 } }] })
      expect(await alpha.query({ kind: 'resources.tree', action: 'facts', node: alphaRoot })).toEqual(before)
      expect(parse.mock.calls.filter(([base]) => base.endsWith('Tree0.SC2Mod')).length).toBeGreaterThan(previousParses)
      expect(await root(alpha)).toEqual(alphaRoot)
      expect(await root(beta)).toEqual(betaRoot)
      expect(alpha.revision).toBe('1')
      const recoveredParses = parse.mock.calls.length
      await root(alpha)
      expect(parse.mock.calls.length).toBe(recoveredParses)
    } finally { for (const context of contextsOpened) await context.dispose(); await loader.dispose(); parse.mockRestore() }
  })

  it('keeps a shared active Resources tree when one same-session context closes', async () => {
    const loader = fixture()
    const request = { schemaVersion: 1 as const, target: { sourceId: 'fixture:resource-retention', path: 'Mods/Tree0.SC2Mod' }, baseMods: [], sessionId: 'shared' }
    const first = await loader.open(request), second = await loader.open(request)
    const read = vi.spyOn(SC2ModReader.prototype, 'read')
    try {
      const before = await root(first)
      const calls = read.mock.calls.length
      await first.dispose()
      expect(await root(second)).toEqual(before)
      expect(read.mock.calls.length).toBe(calls)
    } finally { await first.dispose(); await second.dispose(); await loader.dispose(); read.mockRestore() }
  })

  it('lets a pending evicted tree fail without forgetting its successful replacement', async () => {
    const loader = fixture()
    const open = (index: number) => loader.open({ schemaVersion: 1,
      target: { sourceId: 'fixture:resource-retention', path: `Mods/Tree${index}.SC2Mod` }, baseMods: [], sessionId: `pending-${index}` })
    const opened: Awaited<ReturnType<typeof open>>[] = []
    let rejectOld!: (error: Error) => void
    const gate = new Promise<never>((_resolve, reject) => { rejectOld = reject })
    const read = vi.spyOn(SC2ModReader.prototype, 'read').mockImplementationOnce(() => gate)
    let pending: Promise<unknown> | undefined
    let replacement: Promise<unknown> | undefined
    try {
      const first = await open(0)
      opened.push(first)
      pending = root(first).then(() => undefined, (error: unknown) => error)
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      for (let index = 1; index <= 5; index++) {
        const other = await open(index)
        opened.push(other)
        await root(other)
      }
      replacement = root(first).then(value => value, (error: unknown) => error)
      // A bounded wait proves reconstruction started before allowing the old read to reject.
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(6))
      const recovered = await replacement
      expect(recovered).not.toBeInstanceOf(Error)
      rejectOld(new Error('old Resources generation failed'))
      expect(await pending).toMatchObject({ message: 'old Resources generation failed' })
      const calls = read.mock.calls.length
      expect(await root(first)).toEqual(recovered)
      expect(read.mock.calls.length).toBe(calls)
      expect(await first.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'TreeUnit' }] }))
        .toMatchObject({ entities: [{ fields: { LifeMax: 50 } }] })
    } finally {
      rejectOld(new Error('pending regression cleanup'))
      await pending
      await replacement
      for (const context of opened) await context.dispose()
      await loader.dispose()
      read.mockRestore()
    }
  })

  it('reconstructs each locale of a shared session after retention pressure and an overlay edit', async () => {
    const loader = contexts(memorySource('fixture:localized-retention', {
      'Mods/Localized.SC2Mod/DocumentInfo': '<DocInfo/>',
      [`Mods/Localized.SC2Mod/${UNIT_DATA}`]: '<Catalog><CUnit id="TreeUnit"><LifeMax value="50"/></CUnit></Catalog>',
      'Mods/Localized.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/TreeUnit=English Tree\n',
      'Mods/Localized.SC2Mod/ruRU.SC2Data/LocalizedData/GameStrings.txt': 'Unit/Name/TreeUnit=Russian Tree\n',
    }))
    const opened: Awaited<ReturnType<typeof loader.open>>[] = []
    const open = async (locale: string, sessionId: string) => {
      const context = await loader.open({ schemaVersion: 1, target: { sourceId: 'fixture:localized-retention', path: 'Mods/Localized.SC2Mod' },
        baseMods: [], locales: [locale], sessionId })
      opened.push(context)
      return context
    }
    const node = { id: 'entity/Unit/TreeUnit', hasChildren: false }
    try {
      const english = await open('enUS', 'shared'), russian = await open('ruRU', 'shared')
      expect(english.contextId).not.toBe(russian.contextId)
      expect(await english.query({ kind: 'resources.tree', action: 'facts', node })).toMatchObject({ preview: expect.stringMatching(/^English Tree ·/u) })
      expect(await russian.query({ kind: 'resources.tree', action: 'facts', node })).toMatchObject({ preview: expect.stringMatching(/^Russian Tree ·/u) })
      for (let index = 0; index < 5; index++) await root(await open('enUS', `other-${index}`))
      await english.overlay([{ layerId: english.layers.at(-1)!.id, path: 'ruRU.SC2Data/LocalizedData/GameStrings.txt',
        text: 'Unit/Name/TreeUnit=Edited Russian Tree\n' }])
      expect(await russian.query({ kind: 'resources.tree', action: 'facts', node })).toMatchObject({ preview: expect.stringMatching(/^Edited Russian Tree ·/u) })
      expect(await english.query({ kind: 'resources.tree', action: 'facts', node })).toMatchObject({ preview: expect.stringMatching(/^English Tree ·/u) })
      await english.dispose()
      expect(await russian.query({ kind: 'resources.tree', action: 'facts', node })).toMatchObject({ preview: expect.stringMatching(/^Edited Russian Tree ·/u) })
    } finally { for (const context of opened) await context.dispose(); await loader.dispose() }
  })
})

describe('bounded retained Data inputs', () => {
  const layer = { id: 'layer:0', rootId: 'fixture:chain', sourcePath: 'Mods/Fixture.SC2Mod' }

  it('refuses catalog entry pressure before the extra read and retries a failed refresh intact', async () => {
    let files = [UNIT_DATA]
    let reads = 0
    const reader = {
      files: async () => files,
      read: async () => {
        reads += 1
        return new TextEncoder().encode('<Catalog><CUnit id="BudgetUnit"><LifeMax value="45"/></CUnit></Catalog>')
      },
    }
    const holder = createChainData('fixture:budget', { layers: [layer], reader, incomplete: false })
    const original = await holder.session()
    expect(original.definitions([{ namespace: 'Unit', entityId: 'BudgetUnit' }])[0]?.fields['LifeMax']).toBe(45)
    files = [UNIT_DATA, ...Array.from({ length: 4096 }, (_, index) => `Base.SC2Data/GameData/Extra${index}.xml`)]
    holder.refresh()
    const entryFailure = await holder.session().then(() => undefined, (error: unknown) => error)
    expect(entryFailure).toBeInstanceOf(RangeError)
    expect(entryFailure).toMatchObject({ message: expect.stringContaining('4096 catalog documents') })
    expect(reads).toBe(4097) // Initial document plus exactly the admitted 4096 reads.
    expect(original.revision).toBe(0)
    expect(original.documents).toHaveLength(1)
    files = [UNIT_DATA]
    const recovered = await holder.session()
    expect(recovered).toBe(original)
    expect(recovered.revision).toBe(1)
    expect(recovered.complete()).toBe(true)
    expect(recovered.definitions([{ namespace: 'Unit', entityId: 'BudgetUnit' }])[0]?.fields['LifeMax']).toBe(45)
  })

  it('refuses aggregate catalog bytes even when every file fits its own ceiling', async () => {
    const bytes = new Uint8Array(32 * 1024 * 1024).fill(0x20)
    let reads = 0
    const reader = {
      files: async () => Array.from({ length: 10 }, (_, index) => `Base.SC2Data/GameData/Extra${index}.xml`),
      read: async (_layer: string, _file: string, maximum: number) => {
        expect(bytes.byteLength).toBeLessThanOrEqual(maximum)
        reads += 1
        return bytes
      },
    }
    const byteFailure = await chainCatalogDocuments([layer], reader).then(() => undefined, (error: unknown) => error)
    expect(byteFailure).toBeInstanceOf(RangeError)
    expect(byteFailure).toMatchObject({ message: expect.stringContaining('268435456 catalog bytes') })
    expect(reads).toBe(9)
  })
})
const mineUnits = '<Catalog><CUnit id="Marine"><LifeMax value="50"/></CUnit><CUnit id="Hero" parent="Marine"/></Catalog>'

async function openMine(sessionId?: string) {
  const modRoot = path.join(scratch, 'Mine.SC2Mod')
  await write(
    'Mine.SC2Mod/DocumentInfo',
    '<DocInfo><Dependencies><Value>bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod</Value></Dependencies></DocInfo>',
  )
  await write(`Mine.SC2Mod/${UNIT_DATA}`, mineUnits)
  await write('Mine.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt', 'Unit/Name/Hero=Hero\n')
  const loader = contexts()
  const context = await loader.open({ schemaVersion: 1, target: modRoot, locales: ['enUS'],
    ...(sessionId === undefined ? {} : { sessionId }) })
  const mine = context.layers.at(-1)!
  return { loader, context, mine, modRoot }
}

type Field = { readonly fieldId: string; readonly value: unknown }
type Row = { readonly entityId: string; readonly parentEntityId?: string; readonly fields?: readonly Field[] }
const lifeOf = (rows: readonly Row[], id: string) => rows.find(row => row.entityId === id)?.fields?.find(item => item.fieldId === 'LifeMax')?.value

describe('the mod context as its chain\'s server', () => {
  it('reuses active native dependency parses without a disk cache, excludes drafts and revalidates changed bytes', async () => {
    let changed: string | undefined
    const source = { ...casc, read: async (file: string, maximum: number) =>
      changed !== undefined && file.toLowerCase() === 'mods/liberty.sc2mod/base.sc2data/gamedata/unitdata.xml'
        ? new TextEncoder().encode(changed) : casc.read(file, maximum) }
    const loader = contexts(source)
    const modRoot = path.join(scratch, 'LiveReuse.SC2Mod')
    await write('LiveReuse.SC2Mod/DocumentInfo', '<DocInfo><Dependencies><Value>file:Mods/Liberty.SC2Mod</Value></Dependencies></DocInfo>')
    await write(`LiveReuse.SC2Mod/${UNIT_DATA}`, mineUnits)
    const unused = await loader.open({ schemaVersion: 1, target: { sourceId: casc.id, path: 'Mods/Core.SC2Mod' } })
    const draft = await loader.open({ schemaVersion: 1, target: modRoot, sessionId: 'draft' })
    const parent = await loader.open({ schemaVersion: 1, target: { sourceId: casc.id, path: 'Mods/Liberty.SC2Mod' } })
    let other: Awaited<ReturnType<typeof loader.open>> | undefined
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocument')
    try {
      const request = { kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'SCV' }] }
      expect(await draft.query(request)).toMatchObject({ entities: [{ fields: { LifeMax: 40 } }] })
      const library = draft.layers.find(layer => layer.sourcePath === 'Mods/Liberty.SC2Mod')!
      await draft.overlay([{ layerId: library.id, path: UNIT_DATA, text: '<Catalog><CUnit id="SCV"><LifeMax value="777"/></CUnit></Catalog>' }])
      expect(await draft.query(request)).toMatchObject({ entities: [{ fields: { LifeMax: 777 } }] })
      parse.mockClear()
      expect(await parent.query(request)).toMatchObject({ entities: [{ fields: { LifeMax: 40 } }] })
      expect(parse).not.toHaveBeenCalled()
      changed = '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit><CUnit id="SCV"><LifeMax value="46"/></CUnit></Catalog>'
      await parent.invalidate()
      await write('LiveOther.SC2Mod/DocumentInfo', '<DocInfo><Dependencies><Value>file:Mods/Liberty.SC2Mod</Value></Dependencies></DocInfo>')
      await write(`LiveOther.SC2Mod/${UNIT_DATA}`, '<Catalog/>')
      other = await loader.open({ schemaVersion: 1, target: path.join(scratch, 'LiveOther.SC2Mod') })
      expect(await other.query(request)).toMatchObject({ entities: [{ fields: { LifeMax: 46 } }] })
      expect(parse.mock.calls.filter(([document]) => document.path.toLowerCase().endsWith('liberty.sc2mod/base.sc2data/gamedata/unitdata.xml'))).toHaveLength(1)
      expect(await draft.query(request)).toMatchObject({ entities: [{ fields: { LifeMax: 777 } }] })
    } finally {
      parse.mockRestore(); await other?.dispose(); await parent.dispose(); await draft.dispose(); await unused.dispose(); await loader.dispose()
    }
  })

  it('serves Data asset paths and localized declarations without reading asset bytes', async () => {
    const prefix = 'Mods/Assets.SC2Mod', asset = 'Base.SC2Assets/Assets/Textures/x.dds'
    const text = '<Catalog><CButton id="Go"><Name value="Button/Name/Go"/><Icon value="Assets\\Textures\\x.dds"/></CButton></Catalog>'
    const source = memorySource('fixture:language-assets', {
      'Mods/Base.SC2Mod/DocumentInfo': '<DocInfo/>', [`Mods/Base.SC2Mod/${asset}`]: new Uint8Array([1]),
      [`${prefix}/DocumentInfo`]: '<DocInfo><Dependencies><Value>file:Mods/Base.SC2Mod</Value></Dependencies></DocInfo>',
      [`${prefix}/Base.SC2Data/GameData/ButtonData.xml`]: text,
      [`${prefix}/enUS.SC2Data/LocalizedData/GameStrings.txt`]: 'Button/Name/Go=Go\n',
      [`${prefix}/${asset}`]: new Uint8Array([2]),
    })
    const read = vi.spyOn(source, 'read')
    const loader = contexts(source, createLanguageFileClassifier([{ languageId: 'sc2-data', extension: 'xml' }, { languageId: 'sc2-strings', extension: 'txt' }]))
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [] })
    try {
      const question = { kind: 'language.feature', document: { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/ButtonData.xml' },
        maxResults: 100, maxDocuments: 16, incomplete: false }
      const location = await context.query({ ...question, feature: 'definition', parameters: { position: { line: 0, character: text.indexOf('x.dds') + 1 } } }) as {
        hasValue: boolean; documents: { layerId: string; path: string }[]; value: { locations: unknown[] }
      }
      expect(location.hasValue).toBe(true)
      expect(location.value.locations).toHaveLength(1)
      expect(location.documents).toEqual([{ layerId: context.layers.at(-1)!.id, path: asset }])
      const localized = await context.query({ ...question, feature: 'definition', parameters: { position: { line: 0, character: text.indexOf('Button/Name/Go') + 4 } } }) as typeof location
      expect(localized.documents[0]?.path).toBe('enUS.SC2Data/LocalizedData/GameStrings.txt')
      const completion = await context.query({ ...question, feature: 'completion', parameters: { position: { line: 0, character: text.indexOf('Assets\\Textures\\x.dds') + 'Assets\\Textures\\'.length } } }) as { value: { items: { label: string }[] } }
      expect(completion.value.items.some(item => item.label.includes('x.dds'))).toBe(true)
      expect(read.mock.calls.some(([file]) => file.endsWith('.dds'))).toBe(false)
    } finally { await context.dispose(); await loader.dispose() }
  })

  it('keeps Triggers, map documents, Banks and Cutscene read features equal to their standalone owners', async () => {
    const prefix = 'Mods/OtherLanguages.SC2Mod'
    const inputs = [
      ['Base.SC2Data/GameData/UnitData.xml', 'sc2-data', '<Catalog><CUnit id="Mine"/></Catalog>'],
      ['Base.SC2Data/Lib.sc2triggers', 'sc2-triggers', '<TriggerData><Library Id="Lib"><Element Type="Param" Id="Value"><Value>Mine</Value><ValueType Type="gamelink"/><ValueGameType Type="Unit"/></Element></Library></TriggerData>'],
      ['Base.SC2Data/Objects.objects', 'sc2-map-objects', '<PlacedObjects><ObjectUnit UnitType="Mine" Id="1"/></PlacedObjects>'],
      ['Base.SC2Data/Preload.preload', 'sc2-map-preload', '<Preload><Unit id="Mine"/></Preload>'],
      ['Base.SC2Data/Progress.SC2Bank', 'sc2-bank', '<Bank version="1"><Section name="Progress"><Key name="Value"><Value int="1"/></Key></Section></Bank>'],
      ['Base.SC2Data/BankList.banklist', 'sc2-bank-list', '<BankList><Bank Name="Progress" Player="1"/></BankList>'],
      ['Base.SC2Data/Main.SC2Cutscene', 'sc2-cutscene', '<CutsceneState cutsceneVersion="1.300000"><CCutsceneNodeCamera guid="100" name="Camera"/></CutsceneState>'],
    ] as const
    const source = memorySource('fixture:other-languages', { [`${prefix}/DocumentInfo`]: '<DocInfo/>',
      ...Object.fromEntries(inputs.map(([file, _language, text]) => [`${prefix}/${file}`, text])) })
    const routes = inputs.map(([file, languageId]) => ({ languageId, extension: file.split('.').at(-1)!.toLowerCase() }))
    const loader = contexts(source, createLanguageFileClassifier(routes))
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [] })
    const { servedLanguageFeature } = await import('../../../../shared/language/served-feature.js')
    const { createProvider: triggers } = await import('../../../triggers/providers/language/runtime.js')
    const { createProvider: maps } = await import('../../../map/providers/language/runtime.js')
    const { createProvider: banks } = await import('../../../banks/providers/language/runtime.js')
    const { createProvider: cutscenes } = await import('../../../cutscene/providers/language/runtime.js')
    const selection = { contract: 'common.language/document-analysis', major: 1 }
    const factories = { 'sc2-triggers': triggers, 'sc2-map-objects': maps, 'sc2-map-preload': maps,
      'sc2-bank': banks, 'sc2-bank-list': (choice: typeof selection) => banks({ ...choice, offerId: 'sc2-bank-list-document-analysis-v1' }), 'sc2-cutscene': cutscenes }
    const docs = inputs.map(([file, languageId, text]) => ({ uri: `content-source://${encodeURIComponent(source.id)}/${prefix}/${file}`, languageId, version: 0, text }))
    const port = { query: async (_scope: string, question: unknown, signal?: AbortSignal) => {
      const answer = await context.query(question, signal) as { documents?: { layerId: string; path: string }[] }
      return { ...answer, documents: answer.documents?.map(document => ({ ...document,
        uri: `content-source://${encodeURIComponent(source.id)}/${prefix}/${document.path}`, documentVersion: 0 })) }
    } }
    try {
      for (const [file, languageId] of inputs) {
        if (languageId === 'sc2-data') continue
        const owner = factories[languageId]!(selection).value as unknown as Record<string, unknown>
        const document = docs.find(doc => doc.languageId === languageId)!
        const feature = { document, workspaceDocuments: docs, maxResults: 100, maxDocuments: 16, workspaceIncomplete: false,
          position: { line: 0, character: Math.max(1, document.text.indexOf(['sc2-bank', 'sc2-bank-list'].includes(languageId) ? 'Progress' : languageId === 'sc2-cutscene' ? 'Camera' : 'Mine') + 1) }, query: '', includeDeclaration: true,
          workspaceContext: { id: 'test', revision: context.revision, semanticComplete: true, documentOrigins: [] } }
        for (const name of ['completion', 'hover', 'signatureHelp', 'definition', 'references', 'diagnostics', 'workspaceSymbols', 'documentSymbols']) {
          if (typeof owner[name] !== 'function') continue
          // Banks/Cutscene outlines are explicitly document-local; only Triggers needs companion strings.
          if (name === 'documentSymbols' && languageId !== 'sc2-triggers') continue
          const previous = await (owner[name] as (request: unknown) => Promise<unknown>)(feature)
          const served = await servedLanguageFeature({ ...feature, workspaceContext: { ...feature.workspaceContext,
            modContext: { scope: 'test', revision: context.revision, document: { layerId: context.layers.at(-1)!.id, path: file } } } } as never, port, name as never)
          expect(served, `${languageId}/${name}`).toEqual(previous)
        }
      }
    } finally { await context.dispose(); await loader.dispose() }
  })

  it('verifies closed documents of all six languages, respects bounds and sees unsaved changes', async () => {
    const prefix = 'Mods/Verify.SC2Mod'
    const files = {
      'Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Mine"/></Catalog>',
      'Base.SC2Data/MapScript.galaxy': 'void Init() {}',
      'Base.SC2Data/UI/Layout/Panel.SC2Layout': '<Desc><Frame type="Label" name="Title"/></Desc>',
      'enUS.SC2Data/LocalizedData/GameStrings.txt': 'UI/Title=Title\n',
      'Base.SC2Data/UI/FontStyles.SC2Style': '<StyleFile><Style name="Title"/></StyleFile>',
      'Base.SC2Data/Example.SC2Wizard': '<Wizard/>',
    }
    const source = memorySource('fixture:verify', { [`${prefix}/DocumentInfo`]: '<DocInfo/>',
      ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`${prefix}/${file}`, text])) })
    const loader = contexts(source, createLanguageFileClassifier([
      { languageId: 'sc2-data', extension: 'xml' }, { languageId: 'galaxy', extension: 'galaxy' },
      { languageId: 'sc2-layout', extension: 'sc2layout' }, { languageId: 'sc2-strings', extension: 'txt' },
      { languageId: 'sc2-style', extension: 'sc2style' }, { languageId: 'sc2-wizard', extension: 'sc2wizard' },
    ]))
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [] })
    const question = { kind: 'language.verify', maxResults: 100, maxDocuments: 16, incomplete: false }
    try {
      const report = await context.query(question) as { revision: string; documents: { path: string; diagnostics: unknown[] }[]; isIncomplete: boolean }
      expect(report.documents.map(document => document.path).sort()).toEqual(Object.keys(files).sort())
      expect(report.revision).toBe(context.revision)
      for (const file of Object.keys(files)) {
        const result = await context.query({ kind: 'language.feature', feature: 'workspaceSymbols',
          document: { layerId: context.layers.at(-1)!.id, path: file }, maxResults: 100, maxDocuments: 16,
          incomplete: false, parameters: { query: '' } }) as { hasValue: boolean; value: { symbols: unknown[] }; documents: { path: string }[] }
        expect(result.hasValue, file).toBe(true)
        expect(Array.isArray(result.value.symbols), file).toBe(true)
        expect(JSON.stringify(result)).not.toContain('<Catalog>')
      }
      const lenses = await context.query({ kind: 'language.feature', feature: 'codeLenses', document: {
        layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml' },
        maxResults: 100, maxDocuments: 16, incomplete: false, parameters: {} }) as { value: { lenses: unknown[] } }
      expect(lenses.value.lenses.length).toBeGreaterThan(0)
      const bounded = await context.query({ ...question, maxDocuments: 2 }) as typeof report
      expect(bounded.documents).toHaveLength(2)
      expect(bounded.isIncomplete).toBe(true)
      const layerId = context.layers.at(-1)!.id
      await context.overlay([{ layerId, path: 'Base.SC2Data/MapScript.galaxy', text: 'void Init() {' }])
      const updated = await context.query(question) as typeof report
      expect(updated.revision).not.toBe(report.revision)
      expect(updated.documents.find(document => document.path.endsWith('.galaxy'))!.diagnostics.length).toBeGreaterThan(0)
      const abort = new AbortController(); abort.abort()
      await expect(context.query(question, abort.signal)).rejects.toThrow()
    } finally { await context.dispose(); await loader.dispose() }
  })

  it('plans Data, Galaxy, Layout and Strings renames through their retained owners', async () => {
    const root = 'Rename.SC2Mod'
    const data = '<Catalog><CUnit id="Mine"/><CUnit id="Child" parent="Mine"/></Catalog>'
    const galaxy = 'void Assist() {} void Init() { Assist(); }'
    const layout = '<Desc><Frame type="Label" name="Title"><Text val="@UI/Title"/></Frame><Frame type="Label" name="Other" template="Panel/Title"/></Desc>'
    const strings = 'UI/Title=Title\n'
    await write(`${root}/DocumentInfo`, '<DocInfo/>')
    await write(`${root}/Base.SC2Data/GameData/UnitData.xml`, data)
    await write(`${root}/Base.SC2Data/MapScript.galaxy`, galaxy)
    await write(`${root}/Base.SC2Data/UI/Layout/Panel.SC2Layout`, layout)
    await write(`${root}/enUS.SC2Data/LocalizedData/GameStrings.txt`, strings)
    const loader = contexts(casc, createLanguageFileClassifier([
      { languageId: 'sc2-data', extension: 'xml' }, { languageId: 'galaxy', extension: 'galaxy' },
      { languageId: 'sc2-layout', extension: 'sc2layout' }, { languageId: 'sc2-strings', extension: 'txt' },
    ]))
    const context = await loader.open({ schemaVersion: 1, target: path.join(scratch, root), baseMods: [] })
    try {
      for (const [file, text, needle, newName] of [
        ['Base.SC2Data/GameData/UnitData.xml', data, 'Mine', 'Renamed'],
        ['Base.SC2Data/MapScript.galaxy', galaxy, 'Assist', 'Renamed'],
        ['Base.SC2Data/UI/Layout/Panel.SC2Layout', layout, 'Title', 'Renamed'],
        ['enUS.SC2Data/LocalizedData/GameStrings.txt', strings, 'UI/Title', 'UI/Renamed'],
      ]) {
        const prepared = await context.query({ kind: 'language.prepare-rename', document: { layerId: context.layers.at(-1)!.id, path: file },
          position: { line: 0, character: text!.indexOf(needle!) + 1 },
          maxResults: 100, maxDocuments: 16, incomplete: false }) as { preparation?: { placeholder: string } }
        expect(prepared.preparation?.placeholder, file).toBe(needle)
        const answer = await context.query({ kind: 'language.rename', document: { layerId: context.layers.at(-1)!.id, path: file },
          position: { line: 0, character: text!.indexOf(needle!) + 1 }, newName,
          maxEdits: 100, maxResults: 100, maxDocuments: 16, incomplete: false }) as {
            revision: string; documents: { path: string }[];
            edit: { isComplete: boolean; changes: { document: number; edits: { newText: string }[] }[] } | null
          }
        expect(answer.revision).toBe(context.revision)
        expect(answer.edit, file).not.toBeNull()
        expect(answer.edit?.isComplete).toBe(true)
        expect(answer.edit!.changes.flatMap(change => change.edits), `${file}: ${JSON.stringify(answer)}`).toHaveLength(2)
        expect(answer.edit!.changes.every(change => change.edits.every(edit => edit.newText.includes('Renamed')))).toBe(true)
      }
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })

  it('pages the canonical full Data projection over the public daemon and revokes it after overlays', async () => {
    const { loader, context, modRoot } = await openMine()
    await context.dispose()
    const address = modServerAddress({ extensionRoots: [], storage: scratch }, scratch)
    const daemon = await serveModServer({ address, sources: { openModContext: request => loader.open(request) } })
    const client = await connectModServer(address)
    try {
      const served = await client.openModContext({ schemaVersion: 1, target: modRoot, locales: ['enUS'] })
      await served.prepare!()
      const options = { workspaceId: served.contextId, locales: ['enUS'], localizationKeys: [], queries: [],
        maxDocuments: 32, maxTextBytes: 1024 * 1024, maxEntities: 100_000, maxDepth: 64 }
      const open = () => served.query!({ kind: 'data.workspace', action: 'open', revision: served.revision!, options,
        maxPageBytes: 524288 }) as Promise<{ leaseId: string; revision: string; metadata: { complete: boolean } }>
      const opened = await open()
      expect(opened.metadata.complete).toBe(true)
      const page = (lease: typeof opened) => served.query!({ kind: 'data.workspace', action: 'page', revision: lease.revision,
        leaseId: lease.leaseId, facet: 'definitions', limit: 1000 }) as Promise<{ rows: readonly { entityId: string; fields: Record<string, unknown> }[] }>
      const before = await page(opened)
      expect(before.rows.find(row => row.entityId === 'Marine')?.fields['LifeMax']).toBe(50)
      const mine = served.layers.at(-1)!
      await served.overlay!([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits.replace('value="50"', 'value="70"') }])
      await expect(page(opened)).rejects.toThrow('revision')
      const next = await open()
      expect((await page(next)).rows.find(row => row.entityId === 'Marine')?.fields['LifeMax']).toBe(70)
      expect(await served.query!({ kind: 'data.workspace', action: 'close', leaseId: next.leaseId })).toEqual({ closed: true })
      await served.dispose()
    } finally { await client.close(); await daemon.close(); await loader.dispose() }
  })

  it('evicts recoverable saved bytes by total payload while preserving complete active reads', async () => {
    const prefix = 'Mods/ByteCache.SC2Mod'
    const first = new Uint8Array(40 * 1024 * 1024).fill(0x15)
    const second = new Uint8Array(40 * 1024 * 1024).fill(0x42)
    const source = memorySource('local:byte-cache', {
      [`${prefix}/DocumentInfo`]: '<DocInfo/>',
      [`${prefix}/Assets/first.bin`]: first,
      [`${prefix}/Assets/second.bin`]: second,
    })
    const read = vi.spyOn(source, 'read')
    const loader = contexts(source)
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [] })
    const layer = context.layers.at(-1)!
    const reads = (name: string) => read.mock.calls.filter(([file]) => file === `${prefix}/Assets/${name}.bin`).length
    const bytes = async (name: string, expected: Uint8Array) => {
      const result = await context.read(layer.id, `Assets/${name}.bin`, expected.byteLength)
      expect(result.byteLength).toBe(expected.byteLength)
      expect(Buffer.from(result.buffer, result.byteOffset, result.byteLength).equals(
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
      )).toBe(true)
    }
    try {
      await bytes('first', first)
      await bytes('first', first)
      expect(reads('first')).toBe(1)
      await bytes('second', second)
      await bytes('second', second)
      expect(reads('second')).toBe(1)
      await bytes('first', first)
      expect(reads('first')).toBe(2)
      // Eviction did not mutate a caller's previous complete result or a context's identity.
      expect(first[0]).toBe(0x15)
      expect(context.revision).toBe('0')
    } finally {
      read.mockRestore()
      await context.dispose()
      await loader.dispose()
    }
  })

  it('bounds empty saved reads by entries and keeps invalidation refill cacheable', async () => {
    const prefix = 'Mods/EntryCache.SC2Mod'
    const source = memorySource('local:entry-cache', {
      [`${prefix}/DocumentInfo`]: '<DocInfo/>',
      ...Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`${prefix}/Assets/${index}.bin`, new Uint8Array()])),
    })
    const read = vi.spyOn(source, 'read')
    const loader = contexts(source)
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [] })
    const layer = context.layers.at(-1)!
    const firstReads = () => read.mock.calls.filter(([file]) => file === `${prefix}/Assets/0.bin`).length
    try {
      for (let index = 0; index < 4097; index += 1) {
        expect((await context.read(layer.id, `Assets/${index}.bin`, 1)).byteLength).toBe(0)
      }
      await context.read(layer.id, 'Assets/0.bin', 1)
      expect(firstReads()).toBe(2)
      await context.invalidate!()
      await context.read(layer.id, 'Assets/0.bin', 1)
      await context.read(layer.id, 'Assets/0.bin', 1)
      expect(firstReads()).toBe(3)
    } finally {
      read.mockRestore()
      await context.dispose()
      await loader.dispose()
    }
  }, 30_000)

  it.each(['parse', 'engine'] as const)('answers a lightweight RPC during uncached Data %s preparation', async phase => {
    const files: Record<string, string> = {
      'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog/>',
      'Mods/Cooperative.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Cooperative.SC2Mod/Ping.txt': 'ready',
    }
    for (let document = 0; document < 256; document++) {
      files[`Mods/Cooperative.SC2Mod/Base.SC2Data/GameData/Part${document}.xml`] = '<Catalog>' +
        Array.from({ length: 16 }, (_, item) => `<CUnit id="Unit${document}_${item}"><LifeMax value="45"/></CUnit>`).join('') +
        '</Catalog>'
    }
    const source = memorySource('local:cooperative', files)
    const loader = contexts(source)
    const address = modServerAddress({ extensionRoots: [], storage: `${scratch}/cooperative-rpc-${phase}` }, scratch)
    const daemon = await serveModServer({ address, sources: { openModContext: request => loader.open(request) } })
    const client = await connectModServer(address)
    const remote = await client.openModContext({ schemaVersion: 1, target: { sourceId: source.id, path: 'Mods/Cooperative.SC2Mod' } })
    const events: string[] = []
    let location: unknown
    let probe = () => {}
    const probed = new Promise<void>((resolve, reject) => {
      probe = () => { void remote.locate('Ping.txt').then(value => {
        location = value
        events.push('located')
        resolve()
      }).catch(reject) }
    })
    let scheduled = false
    const schedule = () => {
      if (!scheduled) { scheduled = true; setTimeout(probe, 0) }
    }
    const parseOriginal = catalogAnalysis.parseCatalogDocument
    const engineOriginal = TypedCatalog.prototype.loadFromFiles
    const preparation = phase === 'parse'
      ? vi.spyOn(catalogAnalysis, 'parseCatalogDocument').mockImplementation((...args) => {
        schedule()
        return parseOriginal(...args)
      })
      : vi.spyOn(TypedCatalog.prototype, 'loadFromFiles').mockImplementation(function (this: TypedCatalog, ...args) {
        schedule()
        return engineOriginal.apply(this, args)
      })
    try {
      await Promise.all([remote.prepare!().then(() => { events.push('prepared') }), probed])
      expect(events).toEqual(['located', 'prepared'])
      expect(location).toMatchObject({ path: 'Ping.txt' })
      const answer = await remote.query!({ kind: 'data.ids', namespace: 'Unit' })
      expect(answer).toMatchObject({ ids: expect.arrayContaining(['Unit0_0', 'Unit255_15']) })
      expect((answer as { ids: readonly string[] }).ids).toHaveLength(4096)
    } finally { preparation.mockRestore(); await client.close(); await daemon.close(); await loader.dispose() }
  })

  it('isolates the real SC2 owner over the public daemon transport', async () => {
    const { loader, context, modRoot } = await openMine()
    await context.dispose()
    const address = modServerAddress({ extensionRoots: [], storage: scratch }, scratch)
    const daemon = await serveModServer({ address, sources: { openModContext: request => loader.open(request) } })
    const first = await connectModServer(address)
    const second = await connectModServer(address)
    try {
      const request = { schemaVersion: 1 as const, target: modRoot, locales: ['enUS'] }
      const editor = await first.openModContext(request)
      const card = await first.openModContext(request)
      const other = await second.openModContext(request)
      const primary = editor.layers.at(-1)!
      await editor.overlay!([
        { layerId: primary.id, path: UNIT_DATA, text: mineUnits.replace('</Catalog>', '<CUnit id="FirstOnly"/></Catalog>') },
        { layerId: primary.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Unit/Name/Hero=First editor\n' },
      ])
      expect(editor.sessionId).toBe(card.sessionId)
      expect(other.sessionId).not.toBe(editor.sessionId)
      expect(await card.query!({ kind: 'data.ids', namespace: 'Unit' })).toMatchObject({ ids: expect.arrayContaining(['FirstOnly']) })
      expect(await other.query!({ kind: 'data.ids', namespace: 'Unit' })).not.toMatchObject({ ids: expect.arrayContaining(['FirstOnly']) })
      const node = await card.query!({ kind: 'resources.tree', action: 'root' })
      expect((await card.query!({ kind: 'resources.tree', action: 'search', node, pattern: 'FirstOnly' }) as { items: unknown[] }).items.length).toBeGreaterThan(0)
      const otherNode = await other.query!({ kind: 'resources.tree', action: 'root' })
      expect(await other.query!({ kind: 'resources.tree', action: 'search', node: otherNode, pattern: 'FirstOnly' })).toEqual({ items: [] })
      await other.overlay!([{ layerId: primary.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Unit/Name/Hero=Second editor\n' }])
      await first.close()
      expect(await other.query!({ kind: 'data.strings', keys: ['Unit/Name/Hero'] })).toMatchObject({ strings: [{ value: 'Second editor' }] })
    } finally { await first.close(); await second.close(); await daemon.close(); await loader.dispose() }
  })
  it('isolates session overlays across Data, Strings, Resources, reads and listings', async () => {
    const { loader, context: alpha, mine, modRoot } = await openMine('alpha')
    const beta = await loader.open({ schemaVersion: 1, target: modRoot, locales: ['enUS'], sessionId: 'beta' })
    const anotherAlpha = await loader.open({ schemaVersion: 1, target: modRoot, locales: ['enUS'], sessionId: 'alpha' })
    const units = (context: typeof alpha) => context.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'Hero' }] })
    const strings = (context: typeof alpha) => context.query({ kind: 'data.strings', keys: ['Unit/Name/Hero'] })
    const search = async (context: typeof alpha, pattern: string) => {
      const node = await context.query({ kind: 'resources.tree', action: 'root' })
      return context.query({ kind: 'resources.tree', action: 'search', node, pattern })
    }
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocument')
    try {
      expect(alpha.sessionId).toBe('alpha')
      expect(beta.contextId).not.toBe(alpha.contextId)
      expect(anotherAlpha.contextId).toBe(alpha.contextId)
      await alpha.prepare()
      const savedParses = parse.mock.calls.length
      await beta.prepare()
      expect(parse.mock.calls.length).toBe(savedParses)
      await expect(alpha.overlay([
        { layerId: mine.id, path: UNIT_DATA, text: '<Catalog><CUnit id="Partial"/></Catalog>' },
        { layerId: 'not-a-layer', path: UNIT_DATA, text: '<Catalog/>' },
      ])).rejects.toThrow(/no layer/u)
      expect(alpha.revision).toBe('0')
      expect(new TextDecoder().decode(await alpha.read(mine.id, UNIT_DATA, 1 << 20))).toBe(mineUnits)
      const edited = mineUnits.replace('value="50"', 'value="70"').replace('</Catalog>', '<CUnit id="Unsaved" parent="Marine"/></Catalog>')
      await alpha.overlay([
        { layerId: mine.id, path: UNIT_DATA, text: edited },
        { layerId: mine.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Unit/Name/Hero=Champion\nUnit/Name/SessionOnly=SessionOnly\n' },
        { layerId: mine.id, path: 'SessionOnly.txt', text: 'Alpha only' },
      ])
      expect(await units(anotherAlpha)).toMatchObject({ entities: [{ entityId: 'Hero', fields: { LifeMax: 70 } }] })
      expect(await units(beta)).toMatchObject({ entities: [{ entityId: 'Hero', fields: { LifeMax: 50 } }] })
      expect(parse.mock.calls.length).toBe(savedParses + 1)
      expect(await strings(alpha)).toMatchObject({ strings: [{ value: 'Champion' }] })
      expect(await strings(beta)).toMatchObject({ strings: [{ value: 'Hero' }] })
      expect((await search(alpha, 'Unsaved') as { items: unknown[] }).items.length).toBeGreaterThan(0)
      expect(await search(beta, 'Unsaved')).toEqual({ items: [] })
      // Building alpha's Resources must not put its localized overlay in the saved byte cache.
      expect((await search(alpha, 'SessionOnly') as { items: unknown[] }).items.length).toBeGreaterThan(0)
      expect(await search(beta, 'SessionOnly')).toEqual({ items: [] })
      expect(new TextDecoder().decode(await beta.read(mine.id, UNIT_DATA, 1 << 20))).toBe(mineUnits)
      expect((await alpha.files(mine.id, { limit: 100 })).items).toContain('SessionOnly.txt')
      expect((await beta.files(mine.id, { limit: 100 })).items).not.toContain('SessionOnly.txt')
      expect(await alpha.locate('SessionOnly.txt')).toEqual({ layerId: mine.id, path: 'SessionOnly.txt' })
      expect(await beta.locate('SessionOnly.txt')).toBeUndefined()
      expect(beta.revision).toBe('0')
      await alpha.dispose()
      expect(await strings(anotherAlpha)).toMatchObject({ strings: [{ value: 'Champion' }] })
      await anotherAlpha.dispose()
      const reopened = await loader.open({ schemaVersion: 1, target: modRoot, locales: ['enUS'], sessionId: 'alpha' })
      expect(await strings(reopened)).toMatchObject({ strings: [{ value: 'Hero' }] })
      expect(reopened.revision).toBe('0')
      await reopened.dispose()
    } finally { parse.mockRestore(); await loader.dispose() }
  })

  it('compares native include manifests and still loads virtual include targets from editor buffers', async () => {
    const prefix = 'Mods/NativeIncludes.SC2Mod', manifest = 'Base.SC2Data/GameData.xml'
    const includes = '<Includes><Catalog path="GameData/Native.txt"/></Includes>'
    const source = memorySource('fixture:native-includes', {
      'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
      [`Mods/Core.SC2Mod/${UNIT_DATA}`]: '<Catalog><CUnit id="Marine"/></Catalog>',
      [`${prefix}/DocumentInfo`]: '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
      [`${prefix}/${UNIT_DATA}`]: '<Catalog><CUnit id="Mine"/></Catalog>',
      [`${prefix}/${manifest}`]: includes,
      [`${prefix}/Base.SC2Data/GameData/Native.txt`]: '<Catalog><CUnit id="Native"/></Catalog>',
    })
    const loader = contexts(source)
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: prefix }, baseMods: [], sessionId: 'native-includes' })
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    try {
      await context.prepare()
      await context.overlay([{ layerId: context.layers.at(-1)!.id, path: manifest, text: includes }])
      decode.mockClear()
      await context.prepare()
      // Only the manifest's equality proof decodes; no catalog is decoded again.
      expect(decode).toHaveBeenCalledTimes(1)
      decode.mockRestore()
      await context.overlay([
        { layerId: context.layers.at(-1)!.id, path: manifest, text: '<Includes><Catalog path="GameData/Virtual.txt"/></Includes>' },
        { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/Virtual.txt', text: '<Catalog><CUnit id="Virtual"/></Catalog>' },
      ])
      expect(await context.query({ kind: 'data.ids', namespace: 'Unit' })).toMatchObject({ ids: ['Marine', 'Mine', 'Virtual'] })
    } finally { decode.mockRestore(); await context.dispose(); await loader.dispose() }
  })

  it('keeps equal editor buffers without rereading the Data chain and preserves them after disk changes', async () => {
    const { loader, context: alpha, mine, modRoot } = await openMine('equal-native-buffer')
    const beta = await loader.open({ schemaVersion: 1, target: modRoot, sessionId: 'saved-native-buffer' })
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    try {
      await beta.prepare()
      await alpha.overlay([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits }])
      decode.mockClear()
      await alpha.prepare()
      expect(decode).not.toHaveBeenCalled()
      await alpha.overlay([{ layerId: mine.id, path: UNIT_DATA, text: `\uFEFF${mineUnits}` }])
      await alpha.prepare()
      expect(decode).not.toHaveBeenCalled()
      await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits.replace('value="50"', 'value="55"'))
      await alpha.invalidate()
      const life = async (context: typeof alpha) => {
        const answer = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as { index: { entities: readonly Row[] } }
        return lifeOf(answer.index.entities, 'Marine')
      }
      expect([await life(alpha), await life(beta)]).toEqual([50, 55])
    } finally {
      decode.mockRestore()
      await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits)
      await alpha.dispose(); await beta.dispose(); await loader.dispose()
    }
  })

  it('updates every session after a saved change while retaining each session overlay', async () => {
    const { loader, context: alpha, mine, modRoot } = await openMine('alpha')
    const beta = await loader.open({ schemaVersion: 1, target: modRoot, sessionId: 'beta' })
    const life = async (context: typeof alpha) => {
      const answer = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as {
        index: { entities: readonly Row[] }
      }
      return lifeOf(answer.index.entities, 'Marine')
    }
    try {
      expect(await life(beta)).toBe(50)
      await alpha.overlay([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits.replace('value="50"', 'value="70"') }])
      expect(await life(alpha)).toBe(70)
      await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits.replace('value="50"', 'value="55"'))
      await alpha.invalidate()
      expect([await life(alpha), await life(beta)]).toEqual([70, 55])
      expect(beta.revision).toBe('1')
      await alpha.overlay([{ layerId: mine.id, path: UNIT_DATA }])
      expect(await life(alpha)).toBe(55)
    } finally { await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits); await loader.dispose() }
  })

  it('keeps active session views when more than four saved chains are open', async () => {
    const { loader, context: alpha, mine, modRoot } = await openMine('alpha')
    try {
      await alpha.overlay([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits.replace('value="50"', 'value="70"') }])
      for (let index = 0; index < 8; index += 1) {
        const name = `Pinned${index}.SC2Mod`
        await write(`${name}/DocumentInfo`, '<DocInfo><Dependencies><Value>file:Mods/Liberty.SC2Mod</Value></Dependencies></DocInfo>')
        await write(`${name}/${UNIT_DATA}`, mineUnits)
        await loader.open({ schemaVersion: 1, target: path.join(scratch, name), sessionId: `other-${index}` })
      }
      const again = await loader.open({ schemaVersion: 1, target: modRoot, sessionId: 'alpha' })
      expect(again.revision).toBe('1')
      expect(new TextDecoder().decode(await again.read(mine.id, UNIT_DATA, 1 << 20))).toContain('value="70"')
      await expect(loader.open({ schemaVersion: 1, target: modRoot, sessionId: '' })).rejects.toThrow(/Invalid/u)
    } finally { await loader.dispose() }
  })
  it('retains localized tables across Data edits and refreshes them after localized overlays', async () => {
    const { loader, context, mine } = await openMine()
    const strings = () => context.query({ kind: 'data.strings', keys: ['Unit/Name/Hero'] })
    try {
      const original = await strings()
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      try {
        await context.overlay([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits.replace('value="50"', 'value="65"') }])
        expect(await strings()).toEqual(original)
        expect(decode).not.toHaveBeenCalled()
        await context.overlay([{ layerId: mine.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt',
          text: 'Unit/Name/Hero=Champion\n' }])
        expect(await strings()).toMatchObject({ strings: [{ value: 'Champion' }] })
        expect(decode).toHaveBeenCalled()
        await context.overlay([{ layerId: mine.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' }])
        expect(await strings()).toEqual(original)
      } finally { decode.mockRestore() }
    } finally { await loader.dispose() }
  })

  it('prepares the parsed model before the first query and reuses it until an edit', async () => {
    const { loader, context, mine } = await openMine()
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocument')
    try {
      await context.prepare()
      const prepared = parse.mock.calls.length
      expect(prepared).toBeGreaterThan(0)
      await context.prepare()
      expect(await context.query({ kind: 'data.ids', namespace: 'Unit' })).toMatchObject({ ids: expect.arrayContaining(['Marine', 'Hero']) })
      expect(parse.mock.calls.length).toBe(prepared)
      await context.overlay([{ layerId: mine.id, path: UNIT_DATA, text: mineUnits.replace('value="50"', 'value="65"') }])
      await context.prepare()
      expect(parse.mock.calls.length).toBe(prepared + 1)
      const answer = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as { readonly index: { readonly entities: readonly Row[] } }
      expect(lifeOf(answer.index.entities, 'Marine')).toBe(65)
      expect(parse.mock.calls.length).toBe(prepared + 1)
    } finally {
      parse.mockRestore()
      await loader.dispose()
    }
  })

  it('answers data questions from the chain\'s Data session, a few entities at a time', async () => {
    const { loader, context } = await openMine()
    const entities = await context.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'Hero' }] }) as {
      readonly entities: readonly { readonly entityId: string; readonly fields: Readonly<Record<string, unknown>> }[]
    }
    expect(entities.entities.map(entity => [entity.entityId, entity.fields['LifeMax']])).toEqual([['Hero', 50]])
    const authoring = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Hero' }], chains: true }) as {
      readonly revision: string
      readonly index: { readonly entities: readonly Row[]; readonly complete: boolean }
    }
    expect(authoring.index.entities.map(row => row.entityId)).toEqual(['@default:CUnit:0:0', 'Hero', 'Marine'])
    expect(lifeOf(authoring.index.entities, 'Marine')).toBe(50)
    expect(authoring.index.complete).toBe(true)
    expect(await context.query({ kind: 'data.ids', namespace: 'Unit' })).toMatchObject({
      ids: ['@default:CUnit:0:0', 'Hero', 'Marine', 'SCV'],
    })
    expect(await context.query({ kind: 'data.exists', refs: [
      { namespace: 'Weapon', entityId: 'GuassRifle' }, { namespace: 'Weapon', entityId: 'Missing' },
    ] })).toMatchObject({ exists: [{ known: true }, { known: false }] })
    expect(await context.query({ kind: 'data.heirs', refs: [{ namespace: 'Unit', entityId: 'Marine' }] })).toMatchObject({ heirs: [1] })
    await expect(context.query({ kind: 'data.everything' })).rejects.toThrow(/answer data.entities, .*, not data.everything/u)
    await loader.dispose()
  })

  it('reads unsaved editor text over a file, everywhere, and forgets it when the overlay goes', async () => {
    const { loader, context, mine } = await openMine()
    expect(context.revision).toBe('0')
    const edited = mineUnits.replace('<LifeMax value="50"/>', '<LifeMax value="70"/>')
    const weapon = '<Catalog><CWeaponLegacy id="NewRifle"/></Catalog>'
    const { revision } = await context.overlay([
      { layerId: mine.id, path: UNIT_DATA, text: edited },
      // A new file the editor has not saved yet: listed and read like the others.
      { layerId: mine.id, path: 'Base.SC2Data/GameData/WeaponData.xml', text: weapon },
      { layerId: mine.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Unit/Name/Hero=Champion\n' },
    ])
    expect(revision).toBe('1')
    expect(context.revision).toBe('1')
    expect(new TextDecoder().decode(await context.read(mine.id, UNIT_DATA, 1 << 20))).toBe(edited)
    expect((await context.files(mine.id, { limit: 100 })).items).toContain('Base.SC2Data/GameData/WeaponData.xml')
    const authoring = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as {
      readonly revision: string
      readonly index: { readonly entities: readonly Row[] }
    }
    expect(authoring.revision).toBe('1')
    expect(lifeOf(authoring.index.entities, 'Marine')).toBe(70)
    expect(await context.query({ kind: 'data.ids', namespace: 'Weapon' })).toMatchObject({ ids: ['GuassRifle', 'NewRifle'] })
    expect(await context.query({ kind: 'data.strings', keys: ['Unit/Name/Hero'] })).toMatchObject({
      strings: [{ key: 'Unit/Name/Hero', value: 'Champion' }],
    })
    // Another context over the same chain is served by the same server.
    const again = await loader.open({ schemaVersion: 1, target: path.join(scratch, 'Mine.SC2Mod'), locales: ['enUS'] })
    expect(again.revision).toBe('1')
    // An empty overlay only asks the server's revision: nothing changes, nothing is built again.
    expect(await again.overlay([])).toEqual({ revision: '1' })
    expect(context.revision).toBe('1')

    await context.overlay([
      { layerId: mine.id, path: UNIT_DATA },
      { layerId: mine.id, path: 'Base.SC2Data/GameData/WeaponData.xml' },
      { layerId: mine.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' },
    ])
    expect(context.revision).toBe('2')
    const restored = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as {
      readonly index: { readonly entities: readonly Row[] }
    }
    expect(lifeOf(restored.index.entities, 'Marine')).toBe(50)
    expect(await context.query({ kind: 'data.ids', namespace: 'Weapon' })).toMatchObject({ ids: ['GuassRifle'] })
    expect((await context.files(mine.id, { limit: 100 })).items).not.toContain('Base.SC2Data/GameData/WeaponData.xml')
    await loader.dispose()
  })

  it('shows unsaved editor text in Resources, and the file on disk again when the overlay goes', async () => {
    const { loader, context, mine } = await openMine()
    type Node = { readonly id: string; readonly hasChildren: boolean; readonly label?: string }
    const search = async (pattern: string) => {
      const root = await context.query({ kind: 'resources.tree', action: 'root' }) as Node
      return ((await context.query({ kind: 'resources.tree', action: 'search', node: root, pattern })) as {
        readonly items: readonly Node[]
      }).items
    }
    expect(await search('Unsaved')).toEqual([])
    const edited = mineUnits.replace('</Catalog>', '<CUnit id="Unsaved" parent="Marine"/></Catalog>')
    await context.overlay([{ layerId: mine.id, path: UNIT_DATA, text: edited }])
    const found = await search('Unsaved')
    expect(found.length).toBeGreaterThan(0)
    const facts = JSON.stringify(await context.query({ kind: 'resources.tree', action: 'facts', node: found[0] }))
    expect(facts).toContain('Unsaved')
    await context.overlay([{ layerId: mine.id, path: UNIT_DATA }])
    expect(await search('Unsaved')).toEqual([])
    await loader.dispose()
  })

  it('sees a file changed on disk after invalidate', async () => {
    const { loader, context, modRoot } = await openMine()
    await context.query({ kind: 'data.ids', namespace: 'Unit' })
    await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits.replace('<LifeMax value="50"/>', '<LifeMax value="55"/>'))
    const { revision } = await context.invalidate()
    expect(revision).toBe('1')
    const authoring = await context.query({ kind: 'data.authoring', refs: [{ namespace: 'Unit', entityId: 'Marine' }] }) as {
      readonly index: { readonly entities: readonly Row[] }
    }
    expect(lifeOf(authoring.index.entities, 'Marine')).toBe(55)
    await fs.writeFile(path.join(modRoot, UNIT_DATA), mineUnits)
    await loader.dispose()
  })
})

describe('Galaxy references from the chain server', () => {
  it('uses indexed installed paths before a whole layer listing, including unsaved scripts and refreshed availability', async () => {
    const files = {
      'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Core.SC2Mod/Base.SC2Data/TriggerLibs/Lib.galaxy': 'int Shared(int a) { return a; }\n',
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
      'Mods/Mine.SC2Mod/Base.SC2Data/MapScript.galaxy': 'void Init() { Shared(1); }\n',
    }
    const source = memorySource('fixture:galaxy', files)
    let heldCore = true
    const installed = vi.fn(async (root: string, extensions: readonly string[]) => Object.keys(files)
      .filter(file => file.startsWith(`${root}/`) && extensions.includes(file.split('.').at(-1)!.toLowerCase()) &&
        (heldCore || !root.includes('Core')))
      .map(file => file.slice(root.length + 1)))
    const listFiles = vi.fn<(root: string) => Promise<string[]>>(async () => { throw new Error('whole layer walk') })
    const loader = contexts({ ...source, installedFiles: installed, listFiles })
    const context = await loader.open({ schemaVersion: 1,
      target: { sourceId: source.id, path: 'Mods/Mine.SC2Mod' }, baseMods: [] })
    const layerId = context.layers.at(-1)!.id
    const query = (file: string, offset: number) => context.query({ kind: 'galaxy.references',
      document: { layerId, path: file }, offset, includeDeclaration: true }) as
      Promise<{ documents: { path: string }[]; references: unknown[] }>
    try {
      const script = 'Base.SC2Data/MapScript.galaxy'
      expect((await query(script, 'void Init() { Sh'.length)).references).toHaveLength(2)
      expect(listFiles).not.toHaveBeenCalled()
      expect(installed).toHaveBeenCalledTimes(2)
      listFiles.mockImplementation(async root => Object.keys(files)
        .filter(file => file.startsWith(`${root}/`)).map(file => file.slice(root.length + 1)))
      const unsaved = 'Base.SC2Data/Unsaved.GALAXY'
      await context.overlay([{ layerId, path: unsaved, text: 'void NewFunction() {}\n' }])
      listFiles.mockClear()
      expect((await query(unsaved, 7)).references).toHaveLength(1)
      expect((await query(unsaved, 7)).documents.map(document => document.path)).toContain(unsaved)
      expect(listFiles).not.toHaveBeenCalled()
      heldCore = false
      await context.invalidate()
      const refreshed = await query(script, 'void Init() { Sh'.length)
      expect(refreshed.documents.map(document => document.path)).not.toContain('Base.SC2Data/TriggerLibs/Lib.galaxy')
      expect((await query(unsaved, 7)).references).toHaveLength(1)
      expect(installed).toHaveBeenCalledTimes(4)
      expect(listFiles).not.toHaveBeenCalled()
    } finally { await loader.dispose() }
  })

  const galaxy = memorySource('fixture:galaxy', {
    'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
    'Mods/Core.SC2Mod/Base.SC2Data/TriggerLibs/Lib.galaxy': 'int Shared(int a) { return a; }\n',
    'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
    'Mods/Mine.SC2Mod/Base.SC2Data/MapScript.galaxy': 'void Init() {\n    Shared(1);\n}\n',
  })
  const open = (loader: ReturnType<typeof contexts>, sessionId: string) => loader.open({ schemaVersion: 1,
    target: { sourceId: 'fixture:galaxy', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId })
  const ask = (context: Awaited<ReturnType<typeof open>>, path: string, offset: number) => context.query({
    kind: 'galaxy.references',
    document: { layerId: context.layers.at(-1)!.id, path },
    offset,
    includeDeclaration: true,
  }) as Promise<{ revision: string; incomplete: boolean; documents: { layerId: string; path: string }[]; references: { document: number; start: number; range: unknown }[] }>

  it('keeps a newly requested script even when it exceeded the previous index budget', async () => {
    const large = `${' '.repeat(2 * 1024 * 1024 + 1)}void Big() {}\n`
    const source = memorySource('fixture:galaxy', {
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Mine.SC2Mod/Base.SC2Data/MapScript.galaxy': 'void Init() {}\n',
      'Mods/Mine.SC2Mod/Base.SC2Data/Large.galaxy': large,
    })
    const loader = contexts(source)
    const context = await open(loader, 'budget')
    try {
      await ask(context, 'Base.SC2Data/MapScript.galaxy', 7)
      await context.overlay([{ layerId: context.layers.at(-1)!.id,
        path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Name=Name\n' }])
      const answer = await ask(context, 'Base.SC2Data/Large.galaxy', large.indexOf('Big') + 1)
      expect(answer.references).toHaveLength(1)
      expect(answer.documents.map(document => document.path)).toContain('Base.SC2Data/Large.galaxy')
      expect(answer.revision).toBe(context.revision)
    } finally { await loader.dispose() }
  })

  it('indexes the chain once per revision and answers each session with its own unsaved text', async () => {
    const loader = contexts(galaxy)
    const alpha = await open(loader, 'alpha'), beta = await open(loader, 'beta')
    try {
      const script = 'Base.SC2Data/MapScript.galaxy'
      const first = await ask(alpha, script, 'void Init() {\n    Sh'.length)
      expect(first.incomplete).toBe(false)
      expect(first.revision).toBe(alpha.revision)
      expect(first.documents.map(item => item.path).sort()).toEqual(['Base.SC2Data/MapScript.galaxy', 'Base.SC2Data/TriggerLibs/Lib.galaxy'])
      expect(first.references).toHaveLength(2)
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      try {
        await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id,
          path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'Unit/Name/Marine=Marine\n' }])
        const unchanged = await ask(alpha, script, 'void Init() {\n    Sh'.length)
        expect(unchanged.references).toHaveLength(2)
        expect(unchanged.revision).toBe(alpha.revision)
        expect(decode).not.toHaveBeenCalled()
      } finally { decode.mockRestore() }
      await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: script,
        text: 'void Init() {\n    Shared(1);\n    Shared(2);\n}\n' }])
      expect((await ask(alpha, script, 'void Init() {\n    Sh'.length)).references).toHaveLength(3)
      // Another session keeps the saved text.
      expect((await ask(beta, script, 'void Init() {\n    Sh'.length)).references).toHaveLength(2)
      await expect(alpha.query({ kind: 'galaxy.references', document: { layerId: 'nope', path: script }, offset: 0 }))
        .rejects.toThrow()
      await expect(alpha.query({ kind: 'galaxy.references', document: { layerId: alpha.layers.at(-1)!.id, path: script } }))
        .rejects.toThrow(/needs a document, an offset/u)
      // Hover, definition and signature help come from the same index, under the editor's URI.
      const at = { document: { layerId: alpha.layers.at(-1)!.id, path: script }, offset: 'void Init() {\n    Sh'.length, uri: 'file:///Map.galaxy' }
      const hover = await alpha.query({ kind: 'galaxy.hover', ...at }) as { revision: string; hover?: { markdown: string } }
      expect(hover.revision).toBe(alpha.revision)
      expect(hover.hover?.markdown).toContain('Shared')
      const definition = await alpha.query({ kind: 'galaxy.definition', ...at }) as { semantic: boolean; documents: { path: string }[]; definitions: unknown[] }
      expect(definition.semantic).toBe(true)
      expect(definition.documents.map(item => item.path)).toEqual(['Base.SC2Data/TriggerLibs/Lib.galaxy'])
      expect(definition.definitions).toHaveLength(1)
      await expect(alpha.query({ kind: 'galaxy.hover', document: at.document, offset: at.offset }))
        .rejects.toThrow(/the document URI/u)
      const completion = await alpha.query({ kind: 'galaxy.completion', ...at, maxResults: 64 }) as
        { revision: string; completion: { items: { label: string }[] } }
      expect(completion.revision).toBe(alpha.revision)
      expect(completion.completion.items.map(item => item.label)).toContain('Shared')
      await expect(alpha.query({ kind: 'galaxy.completion', ...at })).rejects.toThrow(/maxResults/u)
    } finally {
      await alpha.dispose(); await beta.dispose(); await loader.dispose()
    }
  })
})

describe('Galaxy diagnostics from the chain server', () => {
  const linked = memorySource('fixture:linked', {
    'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
    'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog>\n    <CUnit id="Zergling"/>\n</Catalog>\n',
    'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
    'Mods/Mine.SC2Mod/Base.SC2Data/MapScript.galaxy': 'void Init() {\n    UnitCreate(1, "Marine", 0, 1, null, 0.0);\n}\n',
  })
  // The host's classifier over its routes, as the SC2 module receives it.
  const classify = createLanguageFileClassifier([
    { languageId: 'galaxy', extension: 'galaxy' },
    { languageId: 'sc2-data', extension: 'xml' },
  ])
  const open = (loader: ReturnType<typeof contexts>) => loader.open({ schemaVersion: 1,
    target: { sourceId: 'fixture:linked', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId: 'alpha' })
  const diagnose = (context: Awaited<ReturnType<typeof open>>) => context.query({
    kind: 'galaxy.diagnostics',
    document: { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/MapScript.galaxy' },
    uri: 'file:///Mine/MapScript.galaxy', offset: 0, maxResults: 100, incomplete: false,
  }) as Promise<{ revision: string; diagnostics: { diagnostics: { code?: string }[]; isIncomplete: boolean } }>

  it("reports a script's catalog literal no layer declares, through the server's link index", async () => {
    const loader = contexts(linked, classify)
    const context = await open(loader)
    try {
      const first = await diagnose(context)
      expect(first.revision).toBe(context.revision)
      expect(first.diagnostics.diagnostics.map(item => item.code)).toEqual(['sc2-cross-language/unresolved-catalog-literal'])
      // Declaring the unit in this session's unsaved catalog resolves it.
      await context.overlay([{ layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml',
        text: '<Catalog>\n    <CUnit id="Marine"/>\n</Catalog>\n' }])
      expect((await diagnose(context)).diagnostics.diagnostics).toEqual([])
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })

  it('serves no cross-language answer without the host classifier', async () => {
    const loader = contexts(linked)
    const context = await open(loader)
    try {
      await expect(diagnose(context)).rejects.toThrow(/no language classifier/u)
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })
})

describe('Data references from the chain server', () => {
  const core = '<Catalog>\n    <CUnit id="Marine"/>\n</Catalog>\n'
  const mine = '<Catalog>\n    <CUnit id="Mine" parent="Marine"/>\n</Catalog>\n'
  const catalogs = memorySource('fixture:catalogs', {
    'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
    'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': core,
    'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
    'Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml': mine,
  })
  const classify = createLanguageFileClassifier([{ languageId: 'sc2-data', extension: 'xml' }])

  it('retains saved reference inputs across reconnects while isolating edits and invalidating saved changes', async () => {
    let saved = mine
    const source = { ...catalogs, async read(file: string, maxBytes: number) {
      return file.toLowerCase() === `mods/mine.sc2mod/${UNIT_DATA.toLowerCase()}`
        ? new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(saved)]) : catalogs.read(file, maxBytes)
    } }
    const loader = contexts(source, classify)
    const opened: Awaited<ReturnType<typeof loader.open>>[] = []
    const open = async (sessionId: string) => {
      const context = await loader.open({ schemaVersion: 1,
        target: { sourceId: source.id, path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId })
      opened.push(context)
      return context
    }
    const references = vi.spyOn(languageAnswers, 'servedDataReferences')
    const ask = async (context: Awaited<ReturnType<typeof open>>) => {
      await context.query({ kind: 'data.references',
        document: { layerId: context.layers.at(-1)!.id, path: UNIT_DATA },
        offset: mine.indexOf('Marine') + 2, includeDeclaration: true, maxResults: 100, incomplete: false })
      return references.mock.calls.at(-1)![0]
    }
    try {
      const privateView = await open('initial-private')
      await privateView.overlay([{ layerId: privateView.layers.at(-1)!.id, path: UNIT_DATA,
        text: mine.replace('id="Mine"', 'id="NeverSaved"') }])
      const privateInputs = await ask(privateView)
      const alpha = await open('saved-alpha')
      await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: UNIT_DATA, text: mine }])
      const original = await ask(alpha)
      expect(original.links).not.toBe(privateInputs.links)
      expect(original.documents.some(document => document.text.includes('NeverSaved'))).toBe(false)
      await alpha.dispose()
      const beta = await open('saved-beta')
      const reconnected = await ask(beta)
      expect(reconnected.links).toBe(original.links)
      expect(reconnected.documents).toBe(original.documents)
      await beta.overlay([{ layerId: beta.layers.at(-1)!.id, path: UNIT_DATA, text: mine.replace('id="Mine"', 'id="Edited"') }])
      const edited = await ask(beta)
      expect(edited.links).not.toBe(original.links)
      const gamma = await open('saved-gamma')
      expect((await ask(gamma)).documents).toBe(original.documents)
      await beta.overlay([{ layerId: beta.layers.at(-1)!.id, path: UNIT_DATA }])
      expect((await ask(beta)).links).toBe(original.links)
      saved = mine.replace('id="Mine"', 'id="Saved"')
      loader.invalidate(source.id)
      const refreshed = await ask(gamma)
      expect(refreshed.links).not.toBe(original.links)
      expect(refreshed.documents.some(document => document.text.includes('id="Saved"'))).toBe(true)
      expect(refreshed.documents.some(document => document.text.includes('id="Edited"'))).toBe(false)
    } finally {
      references.mockRestore()
      for (const context of opened) await context.dispose()
      await loader.dispose()
    }
  })

  it('reconstructs evicted saved reference inputs without invalidating a live view', async () => {
    const files: Record<string, string> = {
      'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
      [`Mods/Core.SC2Mod/${UNIT_DATA}`]: core,
    }
    for (let index = 0; index < 5; index++) {
      files[`Mods/Retained${index}.SC2Mod/DocumentInfo`] = '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>'
      files[`Mods/Retained${index}.SC2Mod/${UNIT_DATA}`] = mine
    }
    const source = memorySource('fixture:saved-reference-retention', files)
    const loader = contexts(source, classify)
    const opened: Awaited<ReturnType<typeof loader.open>>[] = []
    const references = vi.spyOn(languageAnswers, 'servedDataReferences')
    const open = async (index: number, sessionId: string) => {
      const context = await loader.open({ schemaVersion: 1,
        target: { sourceId: source.id, path: `Mods/Retained${index}.SC2Mod` }, baseMods: [], sessionId })
      opened.push(context)
      return context
    }
    const ask = async (context: Awaited<ReturnType<typeof open>>) => {
      const answer = await context.query({ kind: 'data.references',
        document: { layerId: context.layers.at(-1)!.id, path: UNIT_DATA },
        offset: mine.indexOf('Marine') + 2, includeDeclaration: true, maxResults: 100, incomplete: false })
      return { answer, inputs: references.mock.calls.at(-1)![0] }
    }
    try {
      const original = await open(0, 'live-original')
      const before = await ask(original)
      for (let index = 1; index < 5; index++) await ask(await open(index, `pressure-${index}`))
      expect((await ask(original)).inputs.links).toBe(before.inputs.links)
      const after = await ask(await open(0, 'reopened-after-eviction'))
      expect(after.inputs.links).not.toBe(before.inputs.links)
      expect(after.answer).toEqual(before.answer)
    } finally {
      references.mockRestore()
      for (const context of opened) await context.dispose()
      await loader.dispose()
    }
  })

  it("finds an entity's declaration and its uses across the chain's catalogs", async () => {
    const loader = contexts(catalogs, classify)
    const context = await loader.open({ schemaVersion: 1,
      target: { sourceId: 'fixture:catalogs', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId: 'alpha' })
    const references = vi.spyOn(languageAnswers, 'servedDataReferences')
    try {
      const ask = (includeDeclaration: boolean) => context.query({
        kind: 'data.references',
        document: { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml' },
        offset: mine.indexOf('Marine') + 2,
        includeDeclaration, maxResults: 100, incomplete: false,
      }) as Promise<{ revision: string; documents: { layerId: string }[]; locations: { document: number; range: { start: { line: number } } }[]; isIncomplete: boolean }>
      const all = await ask(true)
      expect(all.revision).toBe(context.revision)
      expect(all.locations.map(item => [all.documents[item.document]!.layerId, item.range.start.line]))
        .toEqual([[context.layers.at(-1)!.id, 1], [context.layers[0]!.id, 1]])
      const uses = await ask(false)
      expect(uses.locations.map(item => uses.documents[item.document]!.layerId)).toEqual([context.layers.at(-1)!.id])
      const previousAnswerInputs = references.mock.calls.at(-1)![0]
      const kept = previousAnswerInputs.documents
      await context.overlay([{ layerId: context.layers.at(-1)!.id, path: 'Assets/Unrelated.txt', text: 'unrelated' }])
      expect((await ask(false)).locations).toEqual(uses.locations)
      const next = references.mock.calls.at(-1)![0].documents
      expect(references.mock.calls.at(-1)![0].links).toBe(previousAnswerInputs.links)
      expect(next).toBe(kept)
      expect(next).toHaveLength(kept.length)
      next.forEach((document, index) => expect(document).toBe(kept[index]))
      await context.overlay([{ layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml',
        text: mine.replace('id="Mine"', 'id="Other"') }])
      await ask(false)
      const changed = references.mock.calls.at(-1)![0].documents
      expect(references.mock.calls.at(-1)![0].links).not.toBe(previousAnswerInputs.links)
      for (const document of changed) {
        const previous = kept.find(input => input.layerId === document.layerId && input.path === document.path)!
        if (document.layerId === context.layers.at(-1)!.id) {
          expect(document).not.toBe(previous)
          expect(document.text).toContain('id="Other"')
        } else expect(document).toBe(previous)
      }
      await expect(context.query({ kind: 'data.references', document: { layerId: context.layers.at(-1)!.id, path: 'x' } }))
        .rejects.toThrow(/data.references needs/u)
    } finally {
      references.mockRestore()
      await context.dispose(); await loader.dispose()
    }
  })

  it('finds the uses in the other languages while a tag of the catalog is half typed', async () => {
    // The strict link index cannot read this catalog; the Data owner still reads its target.
    const typing = ['<Catalog>', '    <CUnit id="Mine" parent="Marine">', '        <', '    </CUnit>', '</Catalog>', ''].join('\n')
    const script = ['void Init () {', '    UnitCreate(1, "Mine", 0, 1, Point(0, 0), 0.0);', '}', ''].join('\n')
    const chain = memorySource('fixture:typing', {
      'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml': core,
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
      'Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml': typing,
      'Mods/Mine.SC2Mod/Base.SC2Data/MapScript.galaxy': script,
    })
    const loader = contexts(chain, createLanguageFileClassifier([
      { languageId: 'sc2-data', extension: 'xml' }, { languageId: 'galaxy', extension: 'galaxy' }]))
    const context = await loader.open({ schemaVersion: 1,
      target: { sourceId: 'fixture:typing', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId: 'alpha' })
    try {
      const answer = await context.query({
        kind: 'data.references',
        document: { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml' },
        offset: typing.indexOf('Mine') + 1,
        includeDeclaration: true, maxResults: 100, incomplete: false,
      }) as { documents: { path: string }[]; locations: { document: number; range: { start: { line: number } } }[] }
      expect(answer.locations.map(item => [answer.documents[item.document]!.path, item.range.start.line]))
        .toEqual([['Base.SC2Data/GameData/UnitData.xml', 1], ['Base.SC2Data/MapScript.galaxy', 1]])
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })
})

describe('Style definitions from the chain server', () => {
  it('finds style users in strings and layouts through the retained chain', async () => {
    const text = 'UI/Title=<s val="Title">Hello</s>\n'
    const source = memorySource('fixture:style-users', {
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Mine.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style': '<StyleFile><Style name="Title"/></StyleFile>',
      'Mods/Mine.SC2Mod/Base.SC2Data/UI/Layout/Panel.SC2Layout': '<Desc><Frame type="Label" name="Title"><Style val="Title"/></Frame></Desc>',
      'Mods/Mine.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': text,
    })
    const loader = contexts(source, createLanguageFileClassifier([
      { languageId: 'sc2-style', extension: 'sc2style' }, { languageId: 'sc2-layout', extension: 'sc2layout' },
      { languageId: 'sc2-strings', extension: 'txt' },
    ]))
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: 'Mods/Mine.SC2Mod' }, baseMods: [] })
    try {
      const document = { layerId: context.layers.at(-1)!.id, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt' }
      const question = { kind: 'style.references', document, position: { line: 0, character: text.indexOf('"Title"') + 2 },
        maxResults: 100, incomplete: false, includeDeclaration: true }
      const answer = await context.query(question) as { documents: { path: string }[]; references: unknown[] }
      expect(answer.references).toHaveLength(3)
      expect(answer.documents.map(item => item.path).sort()).toEqual([
        'Base.SC2Data/UI/FontStyles.SC2Style', 'Base.SC2Data/UI/Layout/Panel.SC2Layout', 'enUS.SC2Data/LocalizedData/GameStrings.txt',
      ])
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      try {
        await context.overlay([{ ...document, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout', text: '<Desc/>' }])
        const updated = await context.query(question) as { references: unknown[] }
        expect(updated.references).toHaveLength(2)
        expect(decode).toHaveBeenCalledTimes(1)
        decode.mockClear()
        await context.invalidate()
        expect((await context.query(question) as typeof updated).references).toHaveLength(2)
        expect(decode).toHaveBeenCalledTimes(3)
      } finally { decode.mockRestore() }
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })

  const styles = memorySource('fixture:styles', {
    'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
    'Mods/Core.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style': '<StyleFile>\n    <Style name="Title" height="16"/>\n</StyleFile>\n',
    'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
    'Mods/Mine.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style': '<StyleFile>\n</StyleFile>\n',
  })
  const open = (loader: ReturnType<typeof contexts>, sessionId: string) => loader.open({ schemaVersion: 1,
    target: { sourceId: 'fixture:styles', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId })
  const define = (context: Awaited<ReturnType<typeof open>>) => context.query({ kind: 'style.definition', styleKind: 'style', name: 'Title' }) as
    Promise<{ revision: string; documents: { layerId: string; path: string }[]; definitions: { document: number }[] }>

  it('finds every declaration across the chain with each session\'s unsaved sheet', async () => {
    const loader = contexts(styles)
    const alpha = await open(loader, 'alpha'), beta = await open(loader, 'beta')
    try {
      const first = await define(alpha)
      expect(first.revision).toBe(alpha.revision)
      expect(first.definitions).toHaveLength(1)
      expect(first.documents.map(item => item.path)).toEqual(['Base.SC2Data/UI/FontStyles.SC2Style'])
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      try {
        await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/GameData/UnitData.xml',
          text: '<Catalog><CUnit id="Marine"/></Catalog>' }])
        const unchanged = await define(alpha)
        expect(unchanged.definitions).toEqual(first.definitions)
        expect(unchanged.documents).toEqual(first.documents)
        expect(unchanged.revision).toBe(alpha.revision)
        expect(decode).not.toHaveBeenCalled()
      } finally { decode.mockRestore() }
      await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/FontStyles.SC2Style',
        text: '<StyleFile>\n    <Style name="Title" height="20"/>\n</StyleFile>\n' }])
      expect((await define(alpha)).definitions).toHaveLength(2)
      expect((await define(beta)).definitions).toHaveLength(1)
      await expect(alpha.query({ kind: 'style.definition', styleKind: 'nope', name: 'Title' })).rejects.toThrow(/style kind/u)
    } finally {
      await alpha.dispose(); await beta.dispose(); await loader.dispose()
    }
  })
})

describe('Layout definitions from the chain server', () => {
  it('serves catalog literals and structural references from their canonical retained indexes', async () => {
    const text = '<Desc><Frame type="Label" name="Title"><Text val="@Unit/Name/Mine"/></Frame><Frame type="Label" name="Other" template="Panel/Title"/></Desc>'
    const source = memorySource('fixture:layout-links', {
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Mine.SC2Mod/Base.SC2Data/UI/Layout/Panel.SC2Layout': text,
      'Mods/Mine.SC2Mod/Base.SC2Data/GameData/UnitData.xml': '<Catalog><CUnit id="Mine"/></Catalog>',
    })
    const loader = contexts(source, createLanguageFileClassifier([
      { languageId: 'sc2-data', extension: 'xml' }, { languageId: 'sc2-layout', extension: 'sc2layout' },
    ]))
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: 'Mods/Mine.SC2Mod' }, baseMods: [] })
    try {
      const document = { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' }
      const at = { document, offset: text.indexOf('/Mine') + 3 }
      const definition = await context.query({ ...at, kind: 'layout.definition' }) as { documents: { path: string }[]; definitions: unknown[] }
      expect(definition.documents[0]?.path).toBe('Base.SC2Data/GameData/UnitData.xml')
      expect(definition.definitions).toHaveLength(1)
      const hover = await context.query({ ...at, kind: 'layout.hover' }) as { hover?: { markdown: string; commands: unknown[] } }
      expect(hover.hover?.markdown).toContain('Unit/Mine')
      expect(hover.hover?.commands).toHaveLength(3)
      const refs = await context.query({ ...at, kind: 'layout.references', includeDeclaration: true, maxResults: 100, incomplete: false }) as { references: unknown[] }
      expect(refs.references).toHaveLength(2)
      const frame = await context.query({ document, offset: text.indexOf('name="Title"') + 7,
        kind: 'layout.references', includeDeclaration: true, maxResults: 100, incomplete: false }) as typeof refs
      expect(frame.references).toHaveLength(2)
    } finally { await context.dispose(); await loader.dispose() }
  })

  it('answers @ string hover and completion from held tables and updates them after an overlay', async () => {
    const text = '<Desc><Frame type="Label" name="Title"><Text val="@UI/Title"/></Frame></Desc>'
    const source = memorySource('fixture:layout-strings', {
      'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo/>',
      'Mods/Mine.SC2Mod/Base.SC2Data/UI/Layout/Panel.SC2Layout': text,
      'Mods/Mine.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt': 'UI/Title=Hello\n',
    })
    const loader = contexts(source)
    const context = await loader.open({ schemaVersion: 1, target: { sourceId: source.id, path: 'Mods/Mine.SC2Mod' }, baseMods: [] })
    try {
      const document = { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' }
      const question = { document, offset: text.indexOf('@UI/') + 4 }
      const hover = await context.query({ ...question, kind: 'layout.hover' }) as { hover?: { markdown: string } }
      expect(hover.hover?.markdown).toContain('Hello')
      const completion = await context.query({ ...question, kind: 'layout.completion', maxResults: 50 }) as { items: { label: string }[] }
      expect(completion.items.some(item => item.label === 'Title')).toBe(true)
      await context.overlay([{ layerId: document.layerId, path: 'enUS.SC2Data/LocalizedData/GameStrings.txt', text: 'UI/Title=Changed\n' }])
      const updated = await context.query({ ...question, kind: 'layout.hover' }) as { hover?: { markdown: string } }
      expect(updated.hover?.markdown).toContain('Changed')
    } finally {
      await context.dispose(); await loader.dispose()
    }
  })

  const panel = '<Desc>\n    <Frame type="Button" name="Ok" template="Templates/GlueButton"/>\n</Desc>\n'
  const layouts = memorySource('fixture:layouts', {
    'Mods/Core.SC2Mod/DocumentInfo': '<DocInfo/>',
    'Mods/Core.SC2Mod/Base.SC2Data/UI/Layout/Templates.SC2Layout': '<Desc>\n    <Frame type="Button" name="GlueButton"/>\n</Desc>\n',
    'Mods/Mine.SC2Mod/DocumentInfo': '<DocInfo><Dependencies><Value>file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
    'Mods/Mine.SC2Mod/Base.SC2Data/UI/Layout/Panel.SC2Layout': panel,
  })
  const open = (loader: ReturnType<typeof contexts>, sessionId: string) => loader.open({ schemaVersion: 1,
    target: { sourceId: 'fixture:layouts', path: 'Mods/Mine.SC2Mod' }, baseMods: [], sessionId })
  const define = (context: Awaited<ReturnType<typeof open>>) => context.query({ kind: 'layout.definition',
    document: { layerId: context.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' },
    offset: panel.indexOf('GlueButton') + 2 }) as
    Promise<{ revision: string; incomplete: boolean; documents: { layerId: string; path: string }[]; definitions: { document: number; range: { start: { line: number } } }[] }>

  it('resolves a template across the chain with each session\'s unsaved layout', async () => {
    const loader = contexts(layouts)
    const alpha = await open(loader, 'alpha'), beta = await open(loader, 'beta')
    try {
      const first = await define(alpha)
      expect(first.revision).toBe(alpha.revision)
      expect(first.incomplete).toBe(false)
      expect(first.documents).toEqual([{ layerId: alpha.layers[0]!.id, path: 'Base.SC2Data/UI/Layout/Templates.SC2Layout' }])
      expect(first.definitions.map(item => item.range.start.line)).toEqual([1])
      const hover = await alpha.query({ kind: 'layout.hover',
        document: { layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' },
        offset: panel.indexOf('GlueButton') + 2 }) as { revision: string; hover?: { markdown: string } }
      expect(hover.revision).toBe(alpha.revision)
      expect(hover.hover?.markdown).toContain('`GlueButton` in `Templates.SC2Layout`')
      const completion = await alpha.query({ kind: 'layout.completion',
        document: { layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' },
        offset: panel.indexOf('Templates/') + 'Templates/'.length, maxResults: 50 }) as { revision: string; items: { label: string }[] }
      expect(completion.items.map(item => item.label)).toContain('GlueButton')
      const decode = vi.spyOn(TextDecoder.prototype, 'decode')
      try {
        await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/MapScript.galaxy', text: 'void Init() {}\n' }])
        const again = await alpha.query({ kind: 'layout.completion',
          document: { layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' },
          offset: panel.indexOf('Templates/') + 'Templates/'.length, maxResults: 50 }) as typeof completion
        expect(again.items).toEqual(completion.items)
        expect(again.revision).toBe(alpha.revision)
        expect(decode).not.toHaveBeenCalled()
      } finally { decode.mockRestore() }
      await expect(alpha.query({ kind: 'layout.completion',
        document: { layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout' }, offset: 0 }))
        .rejects.toThrow(/maxResults/u)
      // An unsaved template in this session's own layout is the nearer declaration.
      await alpha.overlay([{ layerId: alpha.layers.at(-1)!.id, path: 'Base.SC2Data/UI/Layout/Panel.SC2Layout',
        text: panel.replace('</Desc>', '    <Frame type="Button" name="Unrelated"/>\n</Desc>') }])
      expect((await define(alpha)).revision).toBe(alpha.revision)
      expect((await define(beta)).documents.map(item => item.path)).toEqual(['Base.SC2Data/UI/Layout/Templates.SC2Layout'])
      await expect(alpha.query({ kind: 'layout.definition', document: { layerId: alpha.layers.at(-1)!.id, path: 'x' } }))
        .rejects.toThrow(/needs a document and an offset/u)
    } finally {
      await alpha.dispose(); await beta.dispose(); await loader.dispose()
    }
  })
})
