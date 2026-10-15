import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readCellFlags, writeCellFlags } from '../shared/format/formats/cell-flags.js'
import { readSyncCliffLevel, writeSyncCliffLevel } from '../shared/format/formats/sync-cliff-level.js'
import { createCodec as createCellFlagsCodec, operations as cellFlagOperations } from '../codecs/documents/cell-flags/src/codec.js'
import { createCodec as createCliffCodec, operations as cliffOperations } from '../codecs/documents/cliff-level/src/codec.js'
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array, name: string) { const revision = `content-hash.sha256:${name}`; const ref = { id: name, uri: `memory://Map.SC2Map/${name}` }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 basic terrain grid codecs', () => {
  it('edits cliff uint16 values through the shared grid surface', async () => {
    const bytes = writeSyncCliffLevel({ version: 1, sizeX: 2, sizeY: 2, heights: [1, 2, 3, 4], _raw: { padding: new Uint8Array(16).fill(5), trailing: new Uint8Array([6]) } })
    const session = await createCliffCodec().open(input(bytes, 't3SyncCliffLevel') as never, 'full', budget)
    try { const edited = await session.operations().invoke('set-cell', { x: 1, y: 1, height: 65535 }); if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing plan'); const payload = edited.output.plan.edits[0]?.payload; if (payload?.kind !== 'inline') throw new Error('missing bytes'); const reopened = readSyncCliffLevel(payload.bytes); expect(reopened.heights).toEqual([1, 2, 3, 65535]); expect(reopened._raw.padding).toEqual(new Uint8Array(16).fill(5)); expect(reopened._raw.trailing).toEqual(new Uint8Array([6])) } finally { await session.dispose() }
  })
  it('edits cell flag uint8 values through the same surface', async () => {
    const bytes = writeCellFlags({ version: 1, sizeX: 2, sizeY: 2, types: new Uint8Array([0, 1, 2, 3]), _raw: { zero: new Uint8Array(16).fill(4), trailing: new Uint8Array([7]) } })
    const session = await createCellFlagsCodec().open(input(bytes, 't3CellFlags') as never, 'full', budget)
    try { const edited = await session.operations().invoke('set-cell', { x: 0, y: 1, type: 255 }); if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing plan'); const payload = edited.output.plan.edits[0]?.payload; if (payload?.kind !== 'inline') throw new Error('missing bytes'); const reopened = readCellFlags(payload.bytes); expect(reopened.types).toEqual(new Uint8Array([0, 1, 255, 3])); expect(reopened._raw.zero).toEqual(new Uint8Array(16).fill(4)); expect(reopened._raw.trailing).toEqual(new Uint8Array([7])) } finally { await session.dispose() }
  })
  it('keeps both manifests equal to the executable operation table', async () => { for (const [name, operations] of [['codec-sc2-cliff-level.json', cliffOperations], ['codec-sc2-cell-flags.json', cellFlagOperations]] as const) { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, `../codecs/documents/${name.replace('codec-sc2-', '').replace('.json', '')}/codec.json`), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) } })
})
