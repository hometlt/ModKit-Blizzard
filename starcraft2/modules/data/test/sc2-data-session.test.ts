/**
 * The Data session of a loaded mod chain (owner decision 07.10: the mod's server holds its data):
 * the same authoring rows as the full analysis for every entity, a hover's entity with its
 * ancestors, the declaration questions, completeness, and edits that replace, add or remove a
 * document.
 */
import { describe, expect, it, vi } from 'vitest'
import { deserialize, serialize } from 'node:v8'
import { isCancellation, OperationCancelledError } from '@modkit/core'
import { dataAuthoringSource, type ResolvedDataAuthoringIndex } from '@modkit/sdk/data'
import { analyzeStarcraft2DataAuthoringIndex, analyzeStarcraft2ResolvedData } from '../services/catalog/provider.js'
import { openStarcraft2DataSession } from '../services/catalog/data-session.js'
import * as catalogAnalysis from '../services/catalog/catalog-analysis.js'
import * as compiledCatalogAnalysis from '@modkit/blizzard-starcraft2/data/catalog-analysis'
import { TypedCatalog } from '../shared/catalog-engine/sc2-catalog/index.js'

const document = (rootId: string, path: string, text: string) => ({ rootId, path, text })
const coreUnits = document('core', 'mods/core.sc2mod/base.sc2data/gamedata/unitdata.xml', `<Catalog>
  <CUnit default="1"><LifeMax value="1"/></CUnit>
  <CUnit id="Marine"><LifeMax value="45"/><Speed value="2.25"/></CUnit>
  <CUnit id="Zealot"><LifeMax value="100"/></CUnit>
</Catalog>`)
const coreWeapons = document('core', 'mods/core.sc2mod/base.sc2data/gamedata/weapondata.xml',
  '<Catalog><CWeaponLegacy id="GuassRifle"><Range value="5"/></CWeaponLegacy></Catalog>')
const modUnits = document('mod', 'mymod.sc2mod/base.sc2data/gamedata/unitdata.xml', `<Catalog>
  <CUnit id="Marine"><LifeMax value="50"/></CUnit>
  <CUnit id="Hero" parent="Marine"><WeaponArray Link="GuassRifle"/></CUnit>
  <CUnit id="Hero2" parent="Hero"/>
</Catalog>`)
const chain = [coreUnits, coreWeapons, modUnits]

function request(documents: readonly ReturnType<typeof document>[]) {
  return {
    workspaceId: 'workspace:session',
    gameId: 'blizzard/starcraft-2',
    documents,
    localizationDocuments: [],
    usageDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 8,
    maxTextBytes: 1_048_576,
    maxEntities: 2_048,
    maxDepth: 64,
    maxOutputBytes: 16 * 1_048_576,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  }
}

/** A row with its sources expanded, so indexes with different source tables compare. */
function expanded(index: ResolvedDataAuthoringIndex, row: ResolvedDataAuthoringIndex['entities'][number]): string {
  const source = (position: number) => JSON.stringify(dataAuthoringSource(index, position))
  return JSON.stringify({
    ...row,
    source: source(row.source),
    fields: row.fields?.map(field => ({
      ...field,
      source: source(field.source),
      origins: field.origins?.map(origin => ({ ...origin, source: source(origin.source) })),
    })),
    tombstones: row.tombstones?.map(tombstone => ({ ...tombstone, source: source(tombstone.source) })),
  })
}

const field = (index: ResolvedDataAuthoringIndex, entityId: string, fieldId: string) =>
  index.entities.find(row => row.entityId === entityId)?.fields?.find(item => item.fieldId === fieldId)

/** Enough independent catalogs to exercise cooperative preparation without wall-time assertions. */
const preparationDocuments = () => Array.from({ length: 48 }, (_, index) => document(`root:${index}`,
  `mods/test${index}.sc2mod/base.sc2data/gamedata/unitdata.xml`,
  `<Catalog><CUnit id="Unit${index}"><LifeMax value="${index + 1}"/></CUnit></Catalog>`))

describe('SC2 Data session', () => {
  it.each(['documents', 'incomplete', 'refresh'] as const)('refuses a snapshot superseded while its projector loads: %s', async change => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session', maxEntities: 2048 })
    const { documents: _documents, ...projection } = request(chain)
    const pending = session.projectSnapshot(projection).catch(error => error)
    const changed = change === 'documents'
      ? chain.map(item => item === modUnits ? { ...item, text: item.text.replace('value="50"', 'value="91"') } : item)
      : chain
    session.update(changed, { incomplete: change === 'incomplete' })
    expect(isCancellation(await pending)).toBe(true)
    if (change === 'incomplete') session.update(changed, { incomplete: false })
    expect(await session.projectSnapshot(projection)).toEqual(await analyzeStarcraft2ResolvedData(request(changed)))
  })

  it('cancels a waiting projection without cancelling another projection of the same model', async () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session', maxEntities: 2048 })
    const { documents: _documents, ...projection } = request(chain)
    const controller = new AbortController()
    const reason = new Error('cancel only this projection')
    const cancelled = session.projectSnapshot({ ...projection, signal: controller.signal }).catch(error => error)
    const continuing = session.projectSnapshot(projection)
    controller.abort(reason)
    expect((await cancelled) === reason).toBe(true)
    expect(await continuing).toEqual(await analyzeStarcraft2ResolvedData(request(chain)))
  })

  it('retries failed engine preparation cooperatively without reusing its closed iterator', async () => {
    const documents = preparationDocuments()
    const options = { workspaceId: 'workspace:engine-retry' }
    const warmed = openStarcraft2DataSession(documents, options)
    const session = openStarcraft2DataSession(documents, { ...options, parses: warmed.parsedDocuments() })
    const original = TypedCatalog.prototype.loadFromFiles
    let fail = true
    let beforeRetry = 0
    let countAtTurn = 0
    let announce = () => undefined as void
    const turn = new Promise<void>(resolve => { announce = resolve })
    const load = vi.spyOn(TypedCatalog.prototype, 'loadFromFiles').mockImplementation(function(this: TypedCatalog, ...args) {
      if (fail) { fail = false; throw new Error('transient engine failure') }
      if (load.mock.calls.length === beforeRetry + 1) setTimeout(() => { countAtTurn = load.mock.calls.length - beforeRetry; announce() }, 0)
      return original.apply(this, args)
    })
    try {
      await expect(session.prepare()).rejects.toThrow('transient engine failure')
      beforeRetry = load.mock.calls.length
      const retry = session.prepare()
      await turn
      expect(countAtTurn).toBeLessThan(documents.length)
      await retry
      expect(load.mock.calls.length - beforeRetry).toBe(documents.length)
      expect(session.ids('Unit')).toHaveLength(documents.length)
    } finally { load.mockRestore() }
  })

  it.each(['foreground', 'foreground-cancel', 'cancel', 'replace'] as const)(
    'admits a neighbouring task during engine preparation: %s', async action => {
      const documents = preparationDocuments()
      const controller = new AbortController()
      const options = { workspaceId: 'workspace:engine-turns', ...(action === 'foreground-cancel' ? { signal: controller.signal } : {}) }
      const warmed = openStarcraft2DataSession(documents, options)
      const session = openStarcraft2DataSession(documents, { ...options, parses: warmed.parsedDocuments() })
      const reason = new Error('cancel this engine preparer')
      let countAtTurn = 0
      let announce = () => undefined as void
      const turn = new Promise<void>(resolve => { announce = resolve })
      const original = TypedCatalog.prototype.loadFromFiles
      const load = vi.spyOn(TypedCatalog.prototype, 'loadFromFiles').mockImplementation(function(this: TypedCatalog, ...args) {
        const result = original.apply(this, args)
        if (load.mock.calls.length === 1) setTimeout(() => {
          countAtTurn = load.mock.calls.length
          if (action === 'cancel' || action === 'foreground-cancel') controller.abort(reason)
          announce()
        }, 0)
        return result
      })
      try {
        const pending = session.prepare(action === 'foreground-cancel' ? new AbortController().signal : controller.signal).catch(error => error)
        const neighbour = action === 'cancel' ? session.prepare() : undefined
        await turn
        expect(countAtTurn).toBeGreaterThan(0)
        expect(countAtTurn).toBeLessThan(documents.length)
        if (action === 'foreground') {
          // Finishing synchronously must continue this catalog, not load its prefix a second time.
          expect(session.ids('Unit')).toHaveLength(documents.length)
          await pending
          expect(load).toHaveBeenCalledTimes(documents.length)
        } else if (action === 'foreground-cancel') {
          expect(() => session.ids('Unit')).toThrow(reason)
          await pending
          expect(load).toHaveBeenCalledTimes(documents.length)
        } else if (action === 'cancel') {
          await neighbour
          expect(await pending).toBe(reason)
          expect(load).toHaveBeenCalledTimes(documents.length)
        } else {
          const next = documents.map(doc => ({ ...doc, text: doc.text.replace('value="1"', 'value="101"') }))
          session.update(next)
          expect(await pending).toBeInstanceOf(OperationCancelledError)
          const alreadyLoaded = load.mock.calls.length
          await session.prepare()
          expect(load.mock.calls.length - alreadyLoaded).toBe(documents.length)
          const expected = openStarcraft2DataSession(documents, options)
          expected.update(next)
          expect(session.authoring([{ namespace: 'Unit', entityId: 'Unit0' }])).toEqual(
            expected.authoring([{ namespace: 'Unit', entityId: 'Unit0' }]),
          )
        }
        expect(session.complete()).toBe(true)
      } finally { load.mockRestore() }
    },
  )

  it('defers own typed values while retaining schema facts and memoizes both value projections', () => {
    let reads = 0
    const schema = { typeId: 'CUnit', fields: [] }
    const native: catalogAnalysis.CatalogElement = { name: 'CUnit', attributes: { id: 'Lazy' }, children: [
      { name: 'LifeMax', attributes: { get value() { reads++; return '45.00' } } },
    ] }
    const patch = catalogAnalysis.parseCatalogEntity(native, schema, 'Unit', { rootId: 'mod', path: 'UnitData.xml', documentIndex: 0 }, '', new Set(), 64)
    expect(reads).toBe(0)
    expect(patch.typeId).toBe('CUnit')
    const empty = catalogAnalysis.parseCatalogDocument(document('mod', 'UnitData.xml', '<Catalog/>'), 0, undefined, 64)
    const stored = catalogAnalysis.storeCatalogDocument({ ...empty, patches: [patch as unknown as catalogAnalysis.CatalogPatch] })
    expect(reads).toBe(0)
    expect(stored.patches[0]?.facts).not.toHaveProperty('fields')
    expect(stored.patches[0]?.facts).not.toHaveProperty('fieldLexemes')
    const decoded = deserialize(serialize(stored)) as catalogAnalysis.StoredCatalogDocument
    // Structured clone reads the native attribute once, never the derived value/lexeme projections.
    expect(reads).toBe(1)
    const restored = catalogAnalysis.restoreCatalogDocument(decoded)
    expect(restored.patches[0]?.fields).toEqual({ LifeMax: 45 })
    expect(restored.patches[0]?.fieldLexemes).toEqual({ LifeMax: '45.00' })
    expect(reads).toBe(1)
    expect(patch.fields).toEqual({ LifeMax: 45 })
    const materializedReads = reads
    expect(materializedReads).toBeGreaterThan(0)
    expect(patch.fieldLexemes).toEqual({ LifeMax: '45.00' })
    expect(patch.fields).toBe(patch.fields)
    expect(reads).toBe(materializedReads)
  })

  it('round trips native parse facts without losing defaults, duplicate diagnostics or typed projections', () => {
    const input = document('mod', 'mods/test.sc2mod/Base.SC2Data/GameData/UnitData.xml', `<Catalog>
      <const id="Scale" value="2"/>
      <CUnit default="1"><LifeMax value="1.00"/></CUnit>
      <CUnit id="Marine"><LifeMax value="45.00"/><FlagArray index="Turnable" value="1"/>
        <Unknown label="x" value="outer"><value value="inner"/><List index="A" value="3"/></Unknown>
      </CUnit>
      <CUnit id="Marine" parent="Base"><LifeMax value="50"/></CUnit>
      <CUnverified id="Extra"><Nested><Leaf value="2"/></Nested></CUnverified>
    </Catalog>`)
    const parsed = catalogAnalysis.parseCatalogDocument(input, 3, undefined, 64)
    const restored = catalogAnalysis.restoreCatalogDocument(deserialize(serialize(catalogAnalysis.storeCatalogDocument(parsed))))
    expect(restored).toEqual(parsed)
    expect(restored.diagnostics.some(item => item.code === 'blizzard.starcraft2/catalog-id-duplicate')).toBe(true)
    expect(restored.patches[0]?.entityId).toBe('@default:CUnit:3:1')
    expect(restored.patches[1]?.fieldLexemes).toMatchObject({ LifeMax: '45.00' })
    expect(() => catalogAnalysis.parseCatalogDocument(input, 3, undefined, 0)).toThrow(/depth/)
    const values = restored.patches[1]?.fields
    expect(restored.patches[1]?.fields).toBe(values)
  })

  it('can inspect already cached parses without building an unrequested model', async () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'passive-parses' })
    expect(session.parsedDocuments(false).size).toBe(0)
    await session.prepare()
    expect(session.parsedDocuments(false).size).toBe(chain.length)
    expect(session.parsedDocuments()).toBe(session.parsedDocuments(false))
  })

  it('lets another task run during preparation without exposing an incomplete model', async () => {
    const documents = preparationDocuments()
    const session = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    const spies = [...new Set([catalogAnalysis, compiledCatalogAnalysis])]
      .map(owner => vi.spyOn(owner, 'parseCatalogDocument'))
    try {
      const turn = new Promise<void>(resolve => setTimeout(resolve, 0))
      const preparing = Promise.resolve(session.prepare())
      await turn
      const parsedBeforeTurn = spies.reduce((count, spy) => count + spy.mock.calls.length, 0)
      expect(parsedBeforeTurn).toBeLessThan(documents.length)
      // A foreground Data query must still return all definitions, even while preparation yields.
      expect(session.ids('Unit')).toHaveLength(documents.length)
      await preparing
      expect(spies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(documents.length)
      expect(session.complete()).toBe(true)
    } finally { for (const spy of spies) spy.mockRestore() }
    const expected = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    const refs = session.ids('Unit').map(entityId => ({ namespace: 'Unit', entityId }))
    expect(session.authoring(refs)).toEqual(expected.authoring(refs))
  })

  it('shares preparatory parses while cancellation of one caller leaves another caller running', async () => {
    const documents = preparationDocuments()
    const session = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    const spies = [...new Set([catalogAnalysis, compiledCatalogAnalysis])]
      .map(owner => vi.spyOn(owner, 'parseCatalogDocument'))
    const controller = new AbortController()
    const reason = new Error('cancel this preparer')
    const turn = new Promise<void>(resolve => setTimeout(() => { controller.abort(reason); resolve() }, 0))
    try {
      const cancelled = session.prepare(controller.signal).catch(error => error)
      const continuing = session.prepare()
      await turn
      await continuing
      expect(await cancelled).toBe(reason)
      expect(session.ids('Unit')).toHaveLength(documents.length)
      expect(spies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(documents.length)
    } finally { for (const spy of spies) spy.mockRestore() }
  })

  it('rejects preparation of superseded inputs and prepares the new model with exact provenance', async () => {
    const documents = preparationDocuments()
    const session = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    const turn = new Promise<void>(resolve => setTimeout(resolve, 0))
    const stale = session.prepare().catch(error => error)
    await turn
    const next = documents.map((item, index) => index === 0
      ? { ...item, text: '<Catalog><CUnit id="Replacement"><LifeMax value="99"/></CUnit></Catalog>' }
      : item)
    session.update(next)
    expect(isCancellation(await stale)).toBe(true)
    await session.prepare()
    expect(session.ids('Unit')).not.toContain('Unit0')
    expect(session.ids('Unit')).toContain('Replacement')
    const refs = session.ids('Unit').map(entityId => ({ namespace: 'Unit', entityId }))
    const expected = openStarcraft2DataSession(next, { workspaceId: 'workspace:cooperative' })
    expected.update(next)
    expect(session.authoring(refs)).toEqual(expected.authoring(refs))
  })

  it('keeps aggregate bounds and invalid-document diagnostics identical after cooperative preparation', async () => {
    const documents = [...preparationDocuments(), document('bad', 'bad/base.sc2data/gamedata/unitdata.xml', '<Catalog>')]
    const session = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    const expected = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative' })
    await session.prepare()
    expect(session.authoring([])).toEqual(expected.authoring([]))
    expect(session.complete()).toBe(expected.complete())
    const bounded = openStarcraft2DataSession(documents, { workspaceId: 'workspace:cooperative', maxEntities: 2 })
    await expect(bounded.prepare()).rejects.toThrow('parsed entities exceeds maxEntities (3 > 2)')
  })

  it('projects the full snapshot with exact provenance, diagnostics, localization and usages without rebuilding the catalog', async () => {
    const documents = [...chain, document('mod', 'mymod.sc2mod/base.sc2data/gamedata/weapondata.xml',
      '<Catalog><CWeaponLegacy id="Orphan" parent="Missing"/></Catalog>')]
    const input = {
      ...request(documents),
      localizationDocuments: [{ rootId: 'mod', path: 'mymod.sc2mod/enus.sc2data/localizeddata/gamestrings.txt',
        locale: 'enUS', text: 'Unit/Name/Marine=Marine\nUnit/Name/Hero=Hero' }],
      usageDocuments: [document('mod', 'mymod.sc2mod/preload.xml', '<Preload><Unit id="Marine"/><Unit id="Ghost"/></Preload>')],
      locales: ['enUS'], localizationKeys: ['Unit/Name/Hero'], plannedDocumentCount: documents.length + 2,
    }
    const expected = await analyzeStarcraft2ResolvedData(input)
    const session = openStarcraft2DataSession(documents, { workspaceId: input.workspaceId, maxEntities: input.maxEntities })
    session.authoring([{ namespace: 'Unit', entityId: 'Hero2' }], { chains: true })
    const spies = [...new Set([catalogAnalysis, compiledCatalogAnalysis])].flatMap(owner => [
      vi.spyOn(owner, 'parseCatalogDocuments'), vi.spyOn(owner, 'parseCatalogDocument'), vi.spyOn(owner, 'resolveThroughEngine'),
    ])
    try {
      const { documents: _documents, ...projection } = input
      expect(await session.projectSnapshot(projection)).toEqual(expected)
      expect(await session.fork().projectSnapshot(projection)).toEqual(expected)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      expect(expected.complete).toBe(false)
      expect(expected.localizedStrings).toContainEqual(expect.objectContaining({ key: 'Unit/Name/Hero', value: 'Hero' }))
      expect(expected.relations).toContainEqual(expect.objectContaining({ to: { namespace: 'Unit', entityId: 'Ghost' }, dead: true }))
    } finally { for (const spy of spies) spy.mockRestore() }
  })

  it('reuses safely parsed documents at larger depth, revalidates at smaller depth and keeps fork/update isolation', async () => {
    const documents = [...chain, document('mod', 'mymod.sc2mod/base.sc2data/gamedata/customdata.xml',
      '<Catalog><CUnit id="Deep"><Outer><Middle><Inner><Leaf value="1"/></Inner></Middle></Outer></CUnit></Catalog>')]
    const session = openStarcraft2DataSession(documents, { workspaceId: 'workspace:session', maxEntities: 2048 })
    session.complete()
    const larger = { ...request(documents), maxDepth: 128 }
    const expected = await analyzeStarcraft2ResolvedData(larger)
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocument')
    const resolve = vi.spyOn(catalogAnalysis, 'resolveThroughEngine')
    try {
      const { documents: _documents, ...projection } = larger
      expect(await session.projectSnapshot(projection)).toEqual(expected)
      expect(parse).not.toHaveBeenCalled()
      expect(resolve).toHaveBeenCalledTimes(1)
      const sibling = session.fork()
      expect(await sibling.projectSnapshot(projection)).toEqual(expected)
      expect(resolve).toHaveBeenCalledTimes(1)
      const smaller = { ...projection, maxDepth: 1 }
      const smallerExpected = await analyzeStarcraft2ResolvedData({ ...smaller, documents })
      parse.mockClear()
      expect(await session.projectSnapshot(smaller)).toEqual(smallerExpected)
      expect(parse).toHaveBeenCalledTimes(documents.length)
      expect(smallerExpected.complete).toBe(false)
      // The document refused at depth 1 must be reparsed when depth 128 permits it.
      expect(await session.projectSnapshot(projection)).toEqual(expected)
      expect(parse).toHaveBeenCalledTimes(documents.length + 1)
      const changed = documents.map(item => item === modUnits ? { ...item, text: item.text.replace('value="50"', 'value="60"') } : item)
      session.update(changed)
      parse.mockClear()
      const updated = await session.projectSnapshot(projection)
      expect(parse).toHaveBeenCalledTimes(1)
      expect(updated).toEqual(await analyzeStarcraft2ResolvedData({ ...larger, documents: changed }))
      expect(await sibling.projectSnapshot(projection)).toEqual(expected)
    } finally { parse.mockRestore(); resolve.mockRestore() }
  })

  it('validates accounting, bytes, entity limits and cancellation before publishing a bounds state', async () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session', maxEntities: 2048 })
    const { documents: _documents, ...projection } = request(chain)
    const expected = await session.projectSnapshot({ ...projection, maxDepth: 128 })
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocuments')
    const resolve = vi.spyOn(catalogAnalysis, 'resolveThroughEngine')
    try {
      await expect(session.projectSnapshot({ ...projection, plannedDocumentCount: 1 })).rejects.toThrow('accounting')
      await expect(session.projectSnapshot({ ...projection, maxTextBytes: 1 })).rejects.toThrow()
      const cancellation = new AbortController(); cancellation.abort()
      await expect(session.projectSnapshot({ ...projection, signal: cancellation.signal })).rejects.toThrow()
      expect(parse).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled()
      await expect(session.projectSnapshot({ ...projection, maxEntities: 1 })).rejects.toThrow('maxEntities')
      const parsed = parse.mock.calls.length
      expect(await session.projectSnapshot({ ...projection, maxDepth: 128 })).toEqual(expected)
      expect(parse.mock.calls.length).toBe(parsed)
    } finally { parse.mockRestore(); resolve.mockRestore() }
  })

  it('owns immutable document inputs and never presents an incomplete loaded chain as complete', async () => {
    const mutable = { ...modUnits }
    const session = openStarcraft2DataSession([coreUnits, coreWeapons, mutable], { workspaceId: 'workspace:session', incomplete: true })
    mutable.text = mutable.text.replace('value="50"', 'value="90"')
    const { documents: _documents, ...projection } = request(chain)
    const snapshot = await session.projectSnapshot(projection)
    expect(snapshot.complete).toBe(false)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'blizzard.starcraft2/data-session-chain-incomplete' }))
    expect(field(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]), 'Marine', 'LifeMax')?.value).toBe(50)
    session.update([coreUnits, coreWeapons, mutable], { incomplete: false })
    expect((await session.projectSnapshot(projection)).complete).toBe(true)
    expect(field(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]), 'Marine', 'LifeMax')?.value).toBe(90)
  })

  it('shares the saved model and unchanged parses while updates stay in their own view', () => {
    const parse = vi.spyOn(catalogAnalysis, 'parseCatalogDocument')
    try {
      const base = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session' })
      const alpha = base.fork()
      expect(base.complete()).toBe(true)
      const parsed = parse.mock.calls.length
      expect(parsed).toBeGreaterThan(0)
      const beta = base.fork()
      const marine = [{ namespace: 'Unit', entityId: 'Marine' }]
      const value = (session: typeof base) => field(session.authoring(marine), 'Marine', 'LifeMax')?.value
      expect([value(alpha), value(beta)]).toEqual([50, 50])
      expect(parse.mock.calls.length).toBe(parsed)
      alpha.update([coreUnits, coreWeapons, { ...modUnits, text: modUnits.text.replace('value="50"', 'value="70"') }])
      expect([value(alpha), value(beta), value(base)]).toEqual([70, 50, 50])
      expect(parse.mock.calls.length).toBe(parsed + 1)
      base.update([coreUnits, coreWeapons, { ...modUnits, text: modUnits.text.replace('value="50"', 'value="55"') }])
      expect([value(base), value(alpha), value(beta)]).toEqual([55, 70, 50])
      expect(parse.mock.calls.length).toBe(parsed + 2)
      const next = base.fork()
      expect(value(next)).toBe(55)
      expect(parse.mock.calls.length).toBe(parsed + 2)
      expect(base.revision).toBe(1)
      expect(next.revision).toBe(0)
    } finally { parse.mockRestore() }
  })
  it('answers every entity as the full authoring index does', async () => {
    const full = await analyzeStarcraft2DataAuthoringIndex(request(chain)) as ResolvedDataAuthoringIndex
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session' })
    const all = session.authoring(full.entities.map(row => ({ namespace: row.namespace, entityId: row.entityId })))
    expect(all.entities.map(row => expanded(all, row))).toEqual(full.entities.map(row => expanded(full, row)))
    expect(all.ownerMetadata).toEqual(full.ownerMetadata)
    expect(all.complete).toBe(full.complete)
    expect(session.complete()).toBe(true)
    expect(session.entityCount()).toBe(full.entityCount)
  })

  it('gives a hover its entity with every ancestor, the strongest declaration winning', () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session' })
    const answer = session.authoring([{ namespace: 'Unit', entityId: 'Hero2' }], { chains: true })
    expect(answer.entities.map(row => row.entityId)).toEqual(['@default:CUnit:0:0', 'Hero', 'Hero2', 'Marine'])
    expect(field(answer, 'Marine', 'LifeMax')).toMatchObject({ value: 50, originEntityId: 'Marine' })
    expect(dataAuthoringSource(answer, field(answer, 'Marine', 'LifeMax')!.source)?.rootId).toBe('mod')
    expect(answer.entities.find(row => row.entityId === 'Hero2')?.parentEntityId).toBe('Hero')
    // Only what was asked: a hover's answer is a few rows, not the catalog.
    expect(answer.entities.some(row => row.entityId === 'Zealot')).toBe(false)
  })

  it('lists a Data space, answers existence for a document\'s references and counts heirs', () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session' })
    expect(session.ids('Unit')).toEqual(['@default:CUnit:0:0', 'Hero', 'Hero2', 'Marine', 'Zealot'])
    expect(session.ids('Weapon')).toEqual(['GuassRifle'])
    expect(session.exists([
      { namespace: 'Weapon', entityId: 'GuassRifle' },
      { namespace: 'Weapon', entityId: 'NoSuchWeapon' },
      { namespace: 'Unit', entityId: '@default:CUnit:0:0' },
    ])).toEqual([{ known: true }, { known: false }, { known: true, defaultTemplate: true }])
    expect(session.heirs([
      { namespace: 'Unit', entityId: 'Marine' },
      { namespace: 'Unit', entityId: 'Hero' },
      { namespace: 'Unit', entityId: 'Zealot' },
    ])).toEqual([1, 1, 0])
  })

  it('is incomplete when an entity names a parent no document declares, as the full analysis is', async () => {
    const orphaned = [...chain, document('mod', 'mymod.sc2mod/base.sc2data/gamedata/weapondata.xml',
      '<Catalog><CWeaponLegacy id="Orphan" parent="NoParent"/></Catalog>')]
    const full = await analyzeStarcraft2DataAuthoringIndex(request(orphaned)) as ResolvedDataAuthoringIndex
    const session = openStarcraft2DataSession(orphaned, { workspaceId: 'workspace:session' })
    expect(full.complete).toBe(false)
    expect(session.complete()).toBe(false)
    expect(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]).complete).toBe(false)
    expect(openStarcraft2DataSession(chain, { workspaceId: 'workspace:session', incomplete: true }).complete()).toBe(false)
  })

  it('takes edits: a changed document, a new one and a removed one', () => {
    const session = openStarcraft2DataSession(chain, { workspaceId: 'workspace:session' })
    expect(field(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]), 'Marine', 'LifeMax')?.value).toBe(50)
    const edited = { ...modUnits, text: modUnits.text.replace('<LifeMax value="50"/>', '<LifeMax value="60"/>') }
    const added = document('mod', 'mymod.sc2mod/base.sc2data/gamedata/upgradedata.xml',
      '<Catalog><CUpgrade id="Stimpack"/></Catalog>')
    session.update([coreUnits, coreWeapons, edited, added])
    expect(session.revision).toBe(1)
    expect(field(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]), 'Marine', 'LifeMax')?.value).toBe(60)
    expect(session.ids('Upgrade')).toEqual(['Stimpack'])
    session.update([coreUnits, coreWeapons])
    expect(session.revision).toBe(2)
    expect(field(session.authoring([{ namespace: 'Unit', entityId: 'Marine' }]), 'Marine', 'LifeMax')?.value).toBe(45)
    expect(session.exists([{ namespace: 'Unit', entityId: 'Hero' }])).toEqual([{ known: false }])
  })
})
