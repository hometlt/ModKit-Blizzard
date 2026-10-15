import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/objects/src/codec.js'
import { readObjects } from '../shared/format/formats/objects.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 16, maxNodes: 100_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }

function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:objects-fixture'
  const ref = { id: 'objects', uri: 'memory://Map.SC2Map/Objects' }
  const source = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: ref.uri }, bindingsFor: () => [], async openBinding() { return { value: source, release: async () => {} } } }
}

const xml = `<?xml version="1.0"?><PlacedObjects Version="12">
<ObjectUnit Id="1" Variation="0" Position="1,2,3" Scale="1,1,1" UnitType="Marine" Player="1"/>
<ObjectPoint Id="2" Position="4,5,6" Scale="1,1,1" Type="Normal" Model="Beacon" Sound="Ping"/>
</PlacedObjects>`

describe('SC2 Objects document codec', () => {
  it('publishes object sources and revision-pinned reference edits', async () => {
    const bytes = encoder.encode(xml)
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      const summary = await session.operations().invoke('inspect', {})
      expect(summary).toMatchObject({ state: 'ok', output: { kind: 'json', value: { objects: 2, units: 1, points: 1, references: 3 } } })
      const graph = await session.dataSource('common.view/relation-graph-source', 1)
      try {
        expect(await graph.value.summary()).toMatchObject({ totalEdges: 3, completeness: 'complete' })
        const nodes = await graph.value.nodes({ limit: 20 })
        expect(nodes.items.map(item => item.type)).toEqual(expect.arrayContaining(['CUnit', 'CModel', 'CSound']))
      } finally { await graph.release() }
      const edited = await session.operations().invoke('set-reference', { id: 1, field: 'unitType', value: 'Marauder' })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('set-reference did not return an edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline replacement')
      expect(readObjects(decoder.decode(payload.bytes)).units[0]?.unitType).toBe('Marauder')
      expect(edited.output.plan.targets[0]?.ownerSource.uri).toBe('memory://Map.SC2Map/Objects')
      expect(edited.output.plan.fidelity.preservesUnknownData).toBe(false)
    } finally { await session.dispose() }
  })

  it('validates manifests against the executable operation table', async () => {
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/objects/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-map-objects.json']) {
      const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
      const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
      expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })
})
