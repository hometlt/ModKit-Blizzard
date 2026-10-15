/** Canonical provider binding: native source fidelity, retained work, previews and protocol refusals. */
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, ModContextQueryPort, ModWorkspaceLock } from '@modkit/sdk'
import { revisionId } from '@modkit/sdk'
import type { DataCatalogDocument, ResolvedDataWorkspaceAnalysisRequest } from '@modkit/sdk/data'
import { createChainData, type ChainReader } from '../../mod/shared/workspace/chain-data.js'
import { createContextDataWorkspaceProjection } from '../../mod/shared/workspace/data-workspace-projection.js'
import { queryStarcraft2ContextWorkspaceProjection } from '../services/catalog/context-workspace-projection.js'
import { createProvider } from '../services/catalog/provider.js'
import * as catalogAnalysis from '../services/catalog/catalog-analysis.js'
import * as compiledCatalogAnalysis from '@modkit/blizzard-starcraft2/data/catalog-analysis'

const unit = 'Base.SC2Data/GameData/UnitData.xml'
const control = 'Base.SC2Data/GameData.xml'
const strings = 'enUS.SC2Data/LocalizedData/GameStrings.txt'
const defaults = '<CUnit default="1"><LifeMax value="1"/></CUnit>'
const xml = (life: number) => `<Catalog>${defaults}<CUnit id="Marine"><LifeMax value="${life}"/></CUnit></Catalog>`

/** Real chain/session/projector behind a JSON-only port; Host aliases intentionally differ. */
async function fixture() {
  const files = new Map([[unit, xml(50)], [control, '<Includes/>'], [strings, 'Unit/Name/Marine=Marine'],
    ['Preload.xml', '<Preload><Unit id="Marine"/><Unit id="Ghost"/></Preload>']])
  const layer = { id: 'host:active', rootId: 'native:active', sourcePath: 'Mods/Fixture.SC2Mod' }
  const reader: ChainReader = { files: async () => [...files.keys()], read: async (_layer, path, maxBytes) => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`missing ${path}`)
    // A real BOM must compare by decoded semantic text while physical guards retain raw bytes.
    const bytes = new TextEncoder().encode(`\uFEFF${text}`)
    if (bytes.byteLength > maxBytes) throw new Error('input too large')
    return bytes
  } }
  const data = createChainData('fixture:bridge', { layers: [layer], reader, incomplete: false })
  const session = await data.session(); session.complete()
  const projection = createContextDataWorkspaceProjection({ data, layers: [layer], reader, revision: () => '0' })
  const root = { rootId: layer.id, sourceId: 'fixture:source', sourcePath: 'context-layers/0', location: layer.sourcePath,
    displayName: 'Fixture', kind: 'primary', dependencies: [] }
  const workspace: ModWorkspaceLock = { schemaVersion: 1, workspaceId: 'fixture:bridge', gameId: 'blizzard/starcraft-2',
    activeRootId: root.rootId, sources: [{ sourceId: root.sourceId, kind: 'mod-context', location: layer.sourcePath }],
    loadOrder: [root], dependencyOrder: [], logicalRoots: [root], diagnostics: [], complete: true }
  const document = (path: string, text = files.get(path)!): DataCatalogDocument => ({ rootId: root.rootId,
    path: `${root.sourcePath}/${path}`, text, revision: revisionId(`provider-token:${encodeURIComponent(path)}`) })
  const request: ResolvedDataWorkspaceAnalysisRequest = { workspaceId: workspace.workspaceId, gameId: workspace.gameId,
    documents: [document(control), document(unit)], localizationDocuments: [{ ...document(strings), locale: 'enUS' }],
    usageDocuments: [document('Preload.xml')], locales: ['enUS'], localizationKeys: ['Unit/Name/Marine'],
    queries: [{ namespace: 'Unit', entityId: 'Marine' }],
    maxDocuments: 32, maxTextBytes: 1024 * 1024, maxEntities: 100_000, maxDepth: 64,
    plannedDocumentCount: 4, unresolvedRequirementIds: [] }
  const calls: JsonValue[] = []
  const port: ModContextQueryPort = { async query(scope, question, signal) {
    expect(scope).toBe(workspace.workspaceId); calls.push(question)
    // Mirror the public JSON boundary, so mutation/reference identity cannot mask wire defects.
    return JSON.parse(JSON.stringify(await projection.query(JSON.parse(JSON.stringify(question)), signal))) as JsonValue
  } }
  return { files, data, session, reader, projection, workspace, request, document, port, calls }
}

describe('canonical context workspace bridge', () => {
  it('reuses parsed/resolved Data, preserves canonical IDs, and binds only declared source positions', async () => {
    const f = await fixture()
    const { documents: _hostDocuments, ...options } = f.request
    const expected = await f.session.projectSnapshot({ ...options, plannedDocumentCount: 3 })
    const spies = [...new Set([catalogAnalysis, compiledCatalogAnalysis])].flatMap(owner => [
      vi.spyOn(owner, 'parseCatalogDocuments'), vi.spyOn(owner, 'parseCatalogDocument'), vi.spyOn(owner, 'resolveThroughEngine'),
    ])
    try {
      const actual = await queryStarcraft2ContextWorkspaceProjection(f.port, f.workspace, f.request)
      expect(actual?.entities.map(value => ({ namespace: value.namespace, id: value.entityId, fields: value.fields })))
        .toEqual(expected.entities.map(value => ({ namespace: value.namespace, id: value.entityId, fields: value.fields })))
      expect(actual?.definitions.map(value => value.entityId)).toEqual(expected.definitions.map(value => value.entityId))
      expect(expected.definitions.some(value => value.defaultTemplate)).toBe(true)
      expect(actual?.schemas).toEqual(expected.schemas)
      expect(actual?.definitions.map(value => ({ fields: value.fields, tokens: value.tokens,
        inheritanceChain: value.inheritanceChain, fieldLexemes: value.fieldLexemes, complete: value.complete })))
        .toEqual(expected.definitions.map(value => ({ fields: value.fields, tokens: value.tokens,
          inheritanceChain: value.inheritanceChain, fieldLexemes: value.fieldLexemes, complete: value.complete })))
      const marine = actual!.entities.find(value => value.entityId === 'Marine')!
      expect(marine.sources[0]).toMatchObject({ rootId: 'host:active', path: f.document(unit).path,
        documentIndex: 1, revision: `provider-token:${encodeURIComponent(unit)}` })
      expect(marine.fieldSources?.['LifeMax']).toMatchObject({ rootId: 'host:active', documentIndex: 1 })
      expect(actual?.localizedStrings[0]?.source.path).toBe(f.document(strings).path)
      const opened = f.calls.find(value => (value as { action?: unknown }).action === 'open')!
      expect(JSON.stringify(opened)).not.toContain('<Catalog>')
      expect(f.calls.at(-2)).toMatchObject({ action: 'close' })
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally { f.projection.dispose(); for (const spy of spies) spy.mockRestore() }
  })

  it('leaves source-shaped game values intact rather than recursively rewriting their keys', async () => {
    const f = await fixture()
    const gameValue = { rootId: 'native:active', path: 'Mods/Fixture.SC2Mod/Texture.dds', documentIndex: 999 }
    const port: ModContextQueryPort = { async query(scope, question, signal) {
      const answer = await f.port.query(scope, question, signal)
      const q = question as { action?: unknown; facet?: unknown }
      if (q.action !== 'page' || q.facet !== 'entities') return answer
      const page = answer as unknown as { rows: { fields: Record<string, JsonValue> }[] }
      return { ...(answer as object), rows: page.rows.map(row => ({ ...row, fields: { ...row.fields, TestGameValue: gameValue } })) } as JsonValue
    } }
    try {
      const snapshot = await queryStarcraft2ContextWorkspaceProjection(port, f.workspace, f.request)
      expect(snapshot?.entities[0]?.fields['TestGameValue']).toEqual(gameValue)
      expect(snapshot?.entities[0]?.sources[0]?.rootId).toBe('host:active')
    } finally { f.projection.dispose() }
  })

  it('releases a published lease even when cancellation hides the open response, then retries', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const port: ModContextQueryPort = { async query(scope, question, signal) {
      const answer = await f.port.query(scope, question, signal)
      if ((question as { action?: unknown }).action === 'open') { abort.abort(); signal?.throwIfAborted() }
      return answer
    } }
    try {
      await expect(queryStarcraft2ContextWorkspaceProjection(port, f.workspace, { ...f.request, signal: abort.signal })).rejects.toThrow()
      expect(await queryStarcraft2ContextWorkspaceProjection(f.port, f.workspace, f.request)).toBeDefined()
    } finally { f.projection.dispose() }
  })

  it('runs typed provider edit previews on a canonical fork without changing saved or sibling Data', async () => {
    const f = await fixture()
    const lease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 }, { modContexts: f.port })
    const provider = lease.value as any
    try {
      await provider.plan({ workspace: f.workspace, locales: ['enUS'], maxRequirements: 512,
        listings: [{ rootId: 'host:active', prefix: '', paths: [...f.files.keys()], complete: true }] })
      const snapshot = await provider.analyze(f.request)
      const edit = await provider.planEdit({ snapshotId: snapshot.snapshotId, selectedRootId: 'host:active',
        writableRootIds: ['host:active'], subject: { namespace: 'Unit', entityId: 'Marine' }, fieldPath: ['LifeMax'],
        intent: { kind: 'set-field', value: '70' } })
      expect(edit.expectedEffectiveValue).toBe(70)
      expect(edit.replacementText).toContain('value="70"')
      expect(f.session.definitions([{ namespace: 'Unit', entityId: 'Marine' }])[0]?.fields['LifeMax']).toBe(50)
      expect(f.files.get(unit)).toBe(xml(50))
      expect(f.calls.filter(value => (value as { action?: unknown }).action === 'open')).toHaveLength(2)
      expect(f.calls.at(-3)).toMatchObject({ action: 'page' })
      const repeat = await provider.analyze(f.request)
      expect(repeat.entities.find((value: { entityId: string }) => value.entityId === 'Marine').fields.LifeMax).toBe(50)
    } finally { await lease.release(); f.projection.dispose() }
  })

  it('rejects changed loader controls, incomplete binding, foreign identities, and malformed pages, releasing the lease', async () => {
    const f = await fixture()
    try {
      expect(await queryStarcraft2ContextWorkspaceProjection(f.port, f.workspace, { ...f.request,
        documents: [f.request.documents[1]!], plannedDocumentCount: 3 })).toBeUndefined()
      f.files.set(control, '<Includes><Catalog path="GameData/Other.xml"/></Includes>')
      await expect(queryStarcraft2ContextWorkspaceProjection(f.port, f.workspace, f.request)).rejects.toThrow('content guard')
      f.files.set(control, '<Includes/>')
      const malformed: ModContextQueryPort = { async query(scope, question, signal) {
        const answer = await f.port.query(scope, question, signal)
        return (question as { action?: unknown }).action === 'page'
          ? { ...(answer as object), nextCursor: 0 } as JsonValue : answer
      } }
      await expect(queryStarcraft2ContextWorkspaceProjection(malformed, f.workspace, f.request)).rejects.toThrow('page or cursor')
      expect(f.calls.at(-1)).toMatchObject({ action: 'close' })
      const foreign: ModContextQueryPort = { async query(scope, question, signal) {
        const answer = await f.port.query(scope, question, signal)
        return (question as { action?: unknown }).action === 'describe'
          ? { ...(answer as object), schemaRevision: 'foreign' } as JsonValue : answer
      } }
      await expect(queryStarcraft2ContextWorkspaceProjection(foreign, f.workspace, f.request)).rejects.toThrow('description')
      expect(await queryStarcraft2ContextWorkspaceProjection(f.port, f.workspace, f.request)).toBeDefined()
    } finally { f.projection.dispose() }
  })
})
