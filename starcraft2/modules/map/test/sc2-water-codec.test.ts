import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { encodeWaterTemplateId, readWater, writeWater } from '../shared/format/formats/water.js'
import { createCodec, operations } from '../codecs/documents/water/src/codec.js'
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:water'; const ref = { id: 'water', uri: 'memory://Map.SC2Map/t3Water' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 water codec', () => {
  it('publishes template relations and preserves unknown bytes during zone edits', async () => {
    const templateIdBytes = encodeWaterTemplateId('BelShirWater'); templateIdBytes[39] = 77
    const bytes = writeWater({ version: 2, zones: [{ templateId: 'BelShirWater', templateIdBytes, startX: 1, startY: 2, endX: 3, endY: 4 }], _raw: { zero: new Uint8Array(20).fill(5), trailing: new Uint8Array([6, 7]) } })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try { const graph = await session.dataSource('common.view/relation-graph-source', 1); try { expect(await graph.value.summary()).toMatchObject({ totalEdges: 1 }) } finally { await graph.release() }; const edited = await session.operations().invoke('set-zone', { index: 0, endX: 9 }); if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing plan'); const payload = edited.output.plan.edits[0]?.payload; if (payload?.kind !== 'inline') throw new Error('missing bytes'); const reopened = readWater(payload.bytes); expect(reopened.zones[0]?.endX).toBe(9); expect(reopened.zones[0]?.templateIdBytes).toEqual(templateIdBytes); expect(reopened._raw.zero).toEqual(new Uint8Array(20).fill(5)); expect(reopened._raw.trailing).toEqual(new Uint8Array([6, 7])) } finally { await session.dispose() }
  })
  it('validates manifest operations', async () => { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/water/codec.json'), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) })
})
