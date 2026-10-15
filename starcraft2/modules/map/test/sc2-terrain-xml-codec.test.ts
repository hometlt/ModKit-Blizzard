import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { parseTerrainXml } from '../shared/format/terrain-params.js'
import { createCodec, operations } from '../codecs/documents/terrain-xml/src/codec.js'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) { const revision = 'content-hash.sha256:terrain-xml'; const ref = { id: 'terrain', uri: 'memory://Map.SC2Map/t3Terrain.xml' }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
const xml = '<?xml version="1.0"?>\r\n<terrain version="115"><heightMap tileSet="Void" dim="65 97" offset="0 0 0" scale="1 1 1"><cliffSetList><cliffSet i="0" name="VoidCliff"/></cliffSetList><textureList><texture i="0" name="BelShirDarkDirt"/></textureList><vertData quantizeBias="1.0" quantizeScale="0.5" standardHeight="8.0" name="t3HeightMap"/></heightMap></terrain>\r\n'
describe('SC2 t3Terrain.xml codec', () => {
  it('publishes terrain relations and edits only height parameter attributes', async () => {
    const bytes = encoder.encode(xml)
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { tileSet: 'Void', dimensions: [65, 97], textures: 1, cliffSets: 1 } } })
      const edited = await session.operations().invoke('set-height-parameters', { quantizeScale: 0.25, quantizeBias: 2, standardHeight: 9 })
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline bytes')
      const outputXml = decoder.decode(payload.bytes)
      expect(parseTerrainXml(outputXml)).toMatchObject({ quantizeScale: 0.25, quantizeBias: 2, standardHeight: 9 })
      expect(outputXml.replace('quantizeBias="2" quantizeScale="0.25" standardHeight="9"', 'quantizeBias="1.0" quantizeScale="0.5" standardHeight="8.0"')).toBe(xml)
      expect(edited.output.plan.fidelity.preservesUnknownData).toBe(true)
    } finally { await session.dispose() }
  })
  it('validates its manifest operations', async () => { const directory = resolve(import.meta.dirname, '../../../contributions'); const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/terrain-xml/codec.json'), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) })
})
