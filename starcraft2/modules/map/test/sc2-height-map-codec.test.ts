import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/height-map/src/codec.js'
import { readHeightMap } from '../shared/format/index.js'

const budget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 16,
  maxNodes: 100_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}

function heightMap(): Uint8Array {
  const bytes = new Uint8Array(32 + 4 * 6 + 3)
  bytes.set(new TextEncoder().encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) {
    view.setUint16(32 + index * 6, 100 + index, true)
    view.setUint16(34 + index * 6, 200 + index, true)
    view.setUint16(36 + index * 6, 1, true)
  }
  bytes.set([7, 8, 9], 32 + 4 * 6)
  return bytes
}

function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:height-map-fixture'
  const ref = { id: 'height', uri: 'memory://Map.SC2Map/t3HeightMap' }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() { yield bytes },
  }
  return {
    originKind: 'single' as const,
    bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }],
    primaryBindingId: 'content',
    revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: ref.uri },
    bindingsFor: () => [],
    async openBinding() { return { value: source, release: async () => {} } },
  }
}

describe('SC2 HeightMap document codec', () => {
  it('publishes paged grid sources and creates a revision-pinned native cell edit', async () => {
    const bytes = heightMap()
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      const inspected = await session.operations().invoke('inspect', {})
      expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { width: 2, height: 2, cells: 4, trailingBytes: 3 } } })
      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        expect(await table.value.shape()).toEqual({ rows: 4, columns: 5, header: ['x', 'y', 'heightBase', 'heightAdjustments', 'mask'] })
        expect((await table.value.rows({ kind: 'range', from: 1, count: 1 })).items[0]?.cells).toEqual(['1', '0', '101', '201', '1'])
      } finally { await table.release() }

      const edited = await session.operations().invoke('set-cell', { x: 1, y: 0, heightBase: 600 })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('set-cell did not return an edit plan')
      expect(edited.output.plan.targets[0]?.ownerSource.uri).toBe('memory://Map.SC2Map/t3HeightMap')
      expect(edited.output.plan.targets[0]?.expectedRevision.bindings.content).toBe('content-hash.sha256:height-map-fixture')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('set-cell did not return inline bytes')
      const reopened = readHeightMap(payload.bytes)
      expect(reopened.cells[1]).toEqual({ heightBase: 600, heightAdjustments: 201, mask: 1 })
      expect(reopened._raw.trailing).toEqual(new Uint8Array([7, 8, 9]))
    } finally { await session.dispose() }
  })

  it('keeps manifest operations equal to the executable operation table', async () => {
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/height-map/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-height-map.json']) {
      const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
      const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
      expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })
})
