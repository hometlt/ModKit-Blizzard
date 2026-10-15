import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/preload-asset-db/src/codec.js'
import { readPreloadAssetDb, resolvePreloadAssetPaths } from '../shared/format/formats/preload-asset-db.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 16, maxNodes: 100_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }

function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:preload-asset-db-fixture'
  const ref = { id: 'preload-asset-db', uri: 'memory://Map.SC2Map/PreloadAssetDB.txt' }
  const source = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: ref.uri }, bindingsFor: () => [], async openBinding() { return { value: source, release: async () => {} } } }
}

const source = '; authored comment\r\n[Textures]\r\nid=Marine\r\npath=Assets\\Textures\\Base.dds\r\nasset=Marine_Diffuse,Marine_Normal\r\n'

describe('SC2 PreloadAssetDB document codec', () => {
  it('publishes asset relations and returns a revision-pinned structured edit', async () => {
    const bytes = encoder.encode(source)
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { sections: 1, entries: 1, fields: 2, resolvedAssets: 2 } } })
      const graph = await session.dataSource('common.view/relation-graph-source', 1)
      try {
        expect(await graph.value.summary()).toMatchObject({ totalEdges: 2, completeness: 'complete' })
        const nodes = await graph.value.nodes({ limit: 10 })
        expect(nodes.items.filter(item => item.type === 'asset').map(item => item.label).sort()).toEqual(['Assets/Textures/Marine_Diffuse.dds', 'Assets/Textures/Marine_Normal.dds'])
      } finally { await graph.release() }
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: bytes } })
      const edited = await session.operations().invoke('set-field', { section: 'Textures', entryId: 'Marine', field: 'asset', values: ['Marine_Emissive'] })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('set-field did not return an edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('set-field did not return inline bytes')
      const reopened = readPreloadAssetDb(decoder.decode(payload.bytes))
      expect(resolvePreloadAssetPaths(reopened.sections[0]!.entries[0]!)).toEqual(['Assets/Textures/Marine_Emissive.dds'])
      expect(edited.output.plan.targets[0]?.ownerSource.uri).toBe('memory://Map.SC2Map/PreloadAssetDB.txt')
      expect(edited.output.plan.fidelity.preservesUnknownData).toBe(false)
    } finally { await session.dispose() }
  })

  it('reports malformed lines and validates manifests against executable operations', async () => {
    const malformed = encoder.encode('orphan\n[Section]\nfield=value\n')
    const session = await createCodec().open(input(malformed) as never, 'full', budget)
    try {
      const validated = await session.operations().invoke('validate', {})
      expect(validated.state).toBe('ok')
      if (validated.state !== 'ok' || validated.output.kind !== 'json') throw new Error('validate failed')
      expect(validated.output.value).toHaveLength(2)
    } finally { await session.dispose() }
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/preload-asset-db/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-preload-asset-db.json']) {
      const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
      const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
      expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })
})
