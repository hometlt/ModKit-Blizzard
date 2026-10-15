/** Full canonical snapshot delivery: exact paged answers, work reuse, byte/revision/lease guards. */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createChainData, type ChainReader } from '../../shared/workspace/chain-data.js'
import { createContextDataWorkspaceProjection } from '../../shared/workspace/data-workspace-projection.js'
import { analyzeStarcraft2ResolvedData } from '../../../data/services/catalog/provider.js'
import * as catalogAnalysis from '../../../data/services/catalog/catalog-analysis.js'
import * as compiledCatalogAnalysis from '@modkit/blizzard-starcraft2/data/catalog-analysis'

const unit = 'Base.SC2Data/GameData/UnitData.xml'
const strings = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
const options = { workspaceId: 'fixture:projection', locales: ['enUS'], localizationKeys: ['Unit/Name/Hero'], queries: [],
  maxDocuments: 32, maxTextBytes: 1024 * 1024, maxEntities: 100_000, maxDepth: 64 }
const fields = ['schemas', 'definitions', 'entities', 'relations', 'localizedStrings', 'diagnostics'] as const
interface Opened { revision: string; leaseId: string; metadata: Record<string, unknown>; counts: Record<string, number>;
  documents: readonly { rootId: string; path: string; documentIndex: number }[] }
interface Page { revision: string; leaseId: string; rows: unknown[]; count: number; nextCursor?: number }

/** The actual chain/session owner over an existing reader, with mutable source revision for races. */
async function fixture(text = '<Catalog><CUnit default="1"><LifeMax value="1"/></CUnit><CUnit id="Marine"><LifeMax value="50"/></CUnit><CUnit id="Hero" parent="Marine"/></Catalog>') {
  const files = new Map([[unit, text], [strings, 'Unit/Name/Hero=Hero'], ['Preload.xml', '<Preload><Unit id="Hero"/><Unit id="Ghost"/></Preload>']])
  const layers = [{ id: 'layer:0', sourcePath: 'Mods/Fixture.SC2Mod', rootId: 'native:fixture' }]
  const reader: ChainReader = { files: async () => [...files.keys()], read: async (_layer, path, maxBytes) => {
    const text = files.get(path)
    if (text === undefined) throw new Error('missing input')
    const bytes = new TextEncoder().encode(text)
    if (bytes.byteLength > maxBytes) throw new Error('input too large')
    return bytes
  } }
  const data = createChainData(options.workspaceId, { layers, reader, incomplete: false })
  const session = await data.session()
  session.complete()
  let revision = '0'
  const projection = createContextDataWorkspaceProjection({ data, layers, reader, revision: () => revision })
  return { files, layers, reader, data, session, projection, setRevision: (next: string) => { revision = next },
    open: (extra: Record<string, unknown> = {}, signal?: AbortSignal) => projection.query({ action: 'open', revision, options, ...extra }, signal) as Promise<Opened> }
}

describe('context Data workspace projection', () => {
  it('delivers every full facet exactly, within actual JSON bytes, without another parser or resolver', async () => {
    const f = await fixture()
    const native = (path: string) => ({ rootId: f.layers[0]!.rootId, path: `${f.layers[0]!.sourcePath}/${path}`, text: f.files.get(path)! })
    const expected = await analyzeStarcraft2ResolvedData({ ...options, gameId: 'blizzard/starcraft-2', documents: f.session.documents,
      localizationDocuments: [{ ...native(strings), locale: 'enUS' }], usageDocuments: [native('Preload.xml')],
      plannedDocumentCount: 3, unresolvedRequirementIds: [] })
    const spies = [...new Set([catalogAnalysis, compiledCatalogAnalysis])].flatMap(owner => [
      vi.spyOn(owner, 'parseCatalogDocuments'), vi.spyOn(owner, 'parseCatalogDocument'), vi.spyOn(owner, 'resolveThroughEngine'),
    ])
    try {
      const opened = await f.open({ maxPageBytes: 524288, resources: [{ layerId: 'layer:0', path: strings, kind: 'localization', locale: 'enUS' },
        { layerId: 'layer:0', path: 'Preload.xml', kind: 'usage' }], catalogGuards: [{ layerId: 'layer:0', path: unit,
          sha256: createHash('sha256').update(f.files.get(unit)!).digest('hex') }] })
      expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThanOrEqual(524288)
      expect(JSON.stringify(opened)).not.toContain('<Catalog>')
      const result = { ...opened.metadata }
      let pages = 0
      for (const facet of fields) {
        const rows: unknown[] = []
        let cursor: number | undefined
        do {
          const page = await f.projection.query({ action: 'page', revision: opened.revision, leaseId: opened.leaseId,
            facet, limit: 1000, ...(cursor === undefined ? {} : { cursor }) }) as Page
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(524288)
          expect(page.count).toBe(opened.counts[facet])
          rows.push(...page.rows); cursor = page.nextCursor; pages += 1
        } while (cursor !== undefined)
        expect(rows.length).toBe(opened.counts[facet]); result[facet] = rows
      }
      expect(pages).toBeGreaterThan(fields.length)
      expect(result).toEqual(expected)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
      await expect(f.open()).rejects.toThrow('active lease')
      expect(await f.projection.query({ action: 'close', leaseId: opened.leaseId })).toEqual({ closed: true })
      expect(await f.projection.query({ action: 'close', leaseId: opened.leaseId })).toEqual({ closed: false })
      const next = await f.open()
      expect(next.leaseId).not.toBe(opened.leaseId)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally { f.projection.dispose(); for (const spy of spies) spy.mockRestore() }
  })

  it('rejects malformed inputs before facet I/O, actual content mismatches, and smaller model budgets', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.reader, 'read')
    try {
      await expect(f.open({ options: { ...options, maxDepth: 0 }, resources: [{ layerId: 'layer:0', path: strings, kind: 'localization', locale: 'enUS' }] })).rejects.toThrow('maxDepth')
      await expect(f.open({ resources: [{ layerId: 'layer:0', path: '../escape', kind: 'usage' }] })).rejects.toThrow('confined')
      await expect(f.open({ maxPageBytes: 8 * 1024 * 1024 + 1 })).rejects.toThrow('byte limit')
      await expect(f.open({ catalogGuards: [] })).rejects.toThrow('exactly')
      expect(read).not.toHaveBeenCalled()
      await expect(f.open({ catalogGuards: [{ layerId: 'layer:0', path: unit, sha256: '0'.repeat(64) }] })).rejects.toThrow('content guard')
      const old = f.files.get(unit)!
      f.files.set(unit, old.replace('value="50"', 'value="60"'))
      await expect(f.open({ catalogGuards: [{ layerId: 'layer:0', path: unit,
        sha256: createHash('sha256').update(f.files.get(unit)!).digest('hex') }] })).rejects.toThrow('content guard')
      f.files.set(unit, old)
      await expect(f.open({ options: { ...options, maxEntities: 1 } })).rejects.toThrow('maxEntities')
      expect((await f.open()).metadata['complete']).toBe(true)
    } finally { read.mockRestore(); f.projection.dispose() }
  })

  it('pins an async open, rejects races and stale pages, retries cancellation, and releases on disposal', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const pending = f.open({}, abort.signal)
    const concurrent = f.open()
    const cancelled = expect(pending).rejects.toThrow()
    abort.abort()
    await expect(concurrent).rejects.toThrow('active lease')
    await cancelled
    const opened = await f.open()
    await expect(f.projection.query({ action: 'page', revision: 'bad', leaseId: opened.leaseId, facet: 'definitions', limit: 1 })).rejects.toThrow('revision')
    // An unrelated bad request did not revoke the still-current projection.
    expect((await f.projection.query({ action: 'page', revision: '0', leaseId: opened.leaseId, facet: 'definitions', limit: 1 }) as Page).rows).toHaveLength(1)
    f.setRevision('1')
    await expect(f.projection.query({ action: 'page', revision: '0', leaseId: opened.leaseId, facet: 'definitions', limit: 1 })).rejects.toThrow('revision')
    const read = vi.spyOn(f.reader, 'read')
    read.mockImplementationOnce(async () => { f.setRevision('2'); return new TextEncoder().encode('Unit/Name/Hero=New') })
    try {
      await expect(f.open({ resources: [{ layerId: 'layer:0', path: strings, kind: 'localization', locale: 'enUS' }] })).rejects.toThrow('revision')
      const next = await f.open()
      f.projection.dispose()
      await expect(f.projection.query({ action: 'page', revision: '2', leaseId: next.leaseId, facet: 'definitions', limit: 1 })).rejects.toThrow('disposed')
      await expect(f.open()).rejects.toThrow('disposed')
    } finally { read.mockRestore(); f.projection.dispose() }
  })

  it('refuses an oversized individual row without substituting an empty complete page', async () => {
    const f = await fixture(`<Catalog><CUnit id="Big"><EditorComment value="${'x'.repeat(90000)}"/></CUnit></Catalog>`)
    try {
      const opened = await f.open({ maxPageBytes: 65536 })
      await expect(f.projection.query({ action: 'page', revision: '0', leaseId: opened.leaseId, facet: 'definitions', limit: 1 })).rejects.toThrow('row exceeds')
      const diagnostics = await f.projection.query({ action: 'page', revision: '0', leaseId: opened.leaseId, facet: 'diagnostics', limit: 1000 }) as Page
      expect(diagnostics.count).toBe(opened.counts['diagnostics'])
    } finally { f.projection.dispose() }
  })
})
