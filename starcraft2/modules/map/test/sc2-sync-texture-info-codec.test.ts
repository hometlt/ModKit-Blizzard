import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readSyncTextureInfo, writeSyncTextureInfo } from '../shared/format/formats/sync-texture-info.js'
import { createCodec, operations } from '../codecs/documents/texture-info/src/codec.js'
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:texture-info'; const ref = { id: 'texture-info', uri: 'memory://Map.SC2Map/t3SyncTextureInfo' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 synchronized texture info codec', () => {
  it('preserves names and edits one uint32 cell through the common grid API', async () => {
    const bytes = writeSyncTextureInfo({ version: 100, sizeX: 2, sizeY: 2, textureNames: ['Dirt', 'Rock'], cells: new Uint32Array([0, 1, 1, 0]) })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try { const edited = await session.operations().invoke('set-cell', { x: 0, y: 1, textureIndex: 0xffffffff }); if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing plan'); const payload = edited.output.plan.edits[0]?.payload; if (payload?.kind !== 'inline') throw new Error('missing bytes'); const reopened = readSyncTextureInfo(payload.bytes); expect(reopened.textureNames).toEqual(['Dirt', 'Rock']); expect(reopened.cells).toEqual(new Uint32Array([0, 1, 0xffffffff, 0])) } finally { await session.dispose() }
  })
  it('validates manifest operations', async () => { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/texture-info/codec.json'), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) })
})
