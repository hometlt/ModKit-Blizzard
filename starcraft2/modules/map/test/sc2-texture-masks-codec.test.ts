import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readTextureMasks, textureMaskWeight, writeTextureMasks } from '../shared/format/formats/texture-masks.js'
import { createCodec, operations } from '../codecs/documents/texture-masks/src/codec.js'
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:texture-masks'; const ref = { id: 'texture-masks', uri: 'memory://Map.SC2Map/t3TextureMasks' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 texture masks codec', () => {
  it('edits one packed nibble without changing its neighbour, other layers or trailing bytes', async () => {
    const body = new Uint8Array(4096); body[0] = 0x37; body[2048] = 0xab
    const bytes = writeTextureMasks({ version: 1, unk: 2, sizeX: 4, sizeY: 3, tilesX: 1, tilesY: 1, blocksPerLayer: 1, layers: 2, body, _raw: { zero: new Uint8Array(44).fill(6), trailing: new Uint8Array([8, 9]) } })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try { expect(await session.operations().invoke('inspect-weight', { layer: 0, x: 0, y: 0 })).toMatchObject({ state: 'ok', output: { kind: 'json', value: { weight: 3 } } }); const edited = await session.operations().invoke('set-weight', { layer: 0, x: 0, y: 0, weight: 12 }); if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing plan'); const payload = edited.output.plan.edits[0]?.payload; if (payload?.kind !== 'inline') throw new Error('missing bytes'); const reopened = readTextureMasks(payload.bytes); expect(textureMaskWeight(reopened, 0, 0, 0)).toBe(12); expect(textureMaskWeight(reopened, 0, 1, 0)).toBe(7); expect(textureMaskWeight(reopened, 1, 0, 0)).toBe(10); expect(reopened._raw.zero).toEqual(new Uint8Array(44).fill(6)); expect(reopened._raw.trailing).toEqual(new Uint8Array([8, 9])) } finally { await session.dispose() }
  })
  it('validates manifest operations', async () => { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/texture-masks/codec.json'), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) })
})
