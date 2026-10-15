import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readRegions } from '../shared/format/formats/regions.js'
import { createCodec, operations } from '../codecs/documents/regions/src/codec.js'
const encoder = new TextEncoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:regions'; const ref = { id: 'regions', uri: 'memory://Map.SC2Map/Regions' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
describe('SC2 Regions codec', () => {
  it('models shapes and verifies a native region rename', async () => {
    const bytes = encoder.encode('<Regions><region id="7"><name value="Start"/><color value="255,0,0"/><shape type="circle"><center value="10,20"/><radius value="5"/></shape></region></Regions>')
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { regions: 1, shapes: 1 } } })
      const edited = await session.operations().invoke('set-name', { id: 7, name: 'Spawn' })
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline bytes')
      expect(readRegions(new TextDecoder().decode(payload.bytes)).byId.get(7)?.name).toBe('Spawn')
      expect(edited.output.plan.fidelity.preservesUnknownData).toBe(false)
    } finally { await session.dispose() }
  })
  it('validates manifests and executable operations', async () => {
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/regions/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-map-region.json']) { const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8')); const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) }
  })
})
