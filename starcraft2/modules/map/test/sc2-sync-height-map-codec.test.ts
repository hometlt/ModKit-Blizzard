import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readSyncHeightMap, writeSyncHeightMap } from '../shared/format/formats/sync-height-map.js'
import { createCodec, operations } from '../codecs/documents/sync-height-map/src/codec.js'
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:sync-height'; const ref = { id: 'sync-height', uri: 'memory://Map.SC2Map/t3SyncHeightMap' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 synchronized height map codec', () => {
  it('uses the common grid API and preserves header, trailing bytes and other cells', async () => {
    const bytes = writeSyncHeightMap({ version: 100, sizeX: 2, sizeY: 2, cells: [{ height: -1, mask: 1 }, { height: 2, mask: 2 }, { height: 3, mask: 3 }, { height: 4, mask: 4 }], _raw: { headerExtra: new Uint8Array(48).fill(7), trailing: new Uint8Array([8, 9]) } })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect-cell', { x: 0, y: 0 })).toMatchObject({ state: 'ok', output: { kind: 'json', value: { height: -1, mask: 1 } } })
      const edited = await session.operations().invoke('set-cell', { x: 1, y: 0, height: -32768, mask: 65535 })
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline bytes')
      const reopened = readSyncHeightMap(payload.bytes)
      expect(reopened.cells).toEqual([{ height: -1, mask: 1 }, { height: -32768, mask: 65535 }, { height: 3, mask: 3 }, { height: 4, mask: 4 }])
      expect(reopened._raw.headerExtra).toEqual(new Uint8Array(48).fill(7)); expect(reopened._raw.trailing).toEqual(new Uint8Array([8, 9]))
    } finally { await session.dispose() }
  })
  it('validates manifest operations', async () => { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/sync-height-map/codec.json'), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) })
})
