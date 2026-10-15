import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/cell-attribute/src/codec.js'
import { readCellAttribute } from '../shared/format/formats/cell-attribute.js'

const budget = { maxInputBytes: 1_000_000n, maxDepth: 16, maxNodes: 100_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:cell-attribute-fixture'
  const ref = { id: 'cell', uri: 'memory://Map.SC2Map/CellAttribute_Pnp' }
  const source = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: ref.uri }, bindingsFor: () => [], async openBinding() { return { value: source, release: async () => {} } } }
}

describe('SC2 CellAttribute document codec', () => {
  it('stays raw without geometry, then inspects and edits with explicit dimensions', async () => {
    const bytes = new Uint8Array([0, 200, 3, 0, 0, 255, 10, 20, 7, 8])
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { suffix: 'Pnp', payloadBytes: 6, context: 'map-dimensions-required' } } })
      const grid = await session.operations().invoke('inspect-grid', { width: 2, height: 2 })
      expect(grid).toMatchObject({ state: 'ok', output: { kind: 'json', value: { width: 2, height: 2, cells: 4, trailingBytes: 2, values: { '0': 1, '10': 1, '20': 1, '255': 1 } } } })
      const edited = await session.operations().invoke('set-cell', { width: 2, height: 2, x: 1, y: 0, value: 33 })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('set-cell did not return an edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline replacement')
      const reopened = readCellAttribute(payload.bytes, { sizeX: 2, sizeY: 2 })
      expect(Array.from(reopened.cells)).toEqual([0, 33, 10, 20])
      expect(reopened._raw.trailing).toEqual(new Uint8Array([7, 8]))
      expect(edited.output.plan.targets[0]?.ownerSource.uri).toBe('memory://Map.SC2Map/CellAttribute_Pnp')
    } finally { await session.dispose() }
  })

  it('validates manifests and operation declarations', async () => {
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/cell-attribute/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-cell-attribute.json']) {
      const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
      const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
      expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })
})
