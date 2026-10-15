import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readMapInfo, writeMapInfo, mapInfoEditorTerrainContext } from '../shared/format/formats/map-info.js'
import { createCodec, operations } from '../codecs/documents/map-info/src/codec.js'

const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:map-info-fixture'
  const ref = { id: 'map-info', uri: 'memory://Map.SC2Map/MapInfo' }
  const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } }
}

describe('SC2 MapInfo codec', () => {
  it('exposes and edits the admitted Editor context through the existing content operation', async () => {
    const names = new TextEncoder().encode('Dark\0Korhal\0')
    const body = new Uint8Array(18 + names.length + 16 + 3)
    body.set([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1])
    body.set(names, 18)
    const view = new DataView(body.buffer, 18 + names.length, 16)
    view.setUint32(8, 64, true); view.setUint32(12, 96, true)
    body.set([0xaa, 0xbb, 0xcc], body.length - 3)
    const bytes = writeMapInfo({ version: 39, width: 64, height: 96, unknown1: 11, unknown2: 22, body, strings: [] })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: {
        kind: 'json', value: { editorTerrainContext: 'Korhal' },
      } })
      const edited = await session.operations().invoke('set-dimensions', {
        action: 'set-editor-terrain-context', expectedContext: 'Korhal', context: 'UVWGeneratedTerrain',
      })
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing context edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing context replacement')
      const reopened = readMapInfo(payload.bytes)
      expect(mapInfoEditorTerrainContext(reopened)).toBe('UVWGeneratedTerrain')
      expect(reopened.boundary).toEqual({ left: 0, bottom: 0, right: 64, top: 96 })
      expect(reopened.body.subarray(-3)).toEqual(Uint8Array.of(0xaa, 0xbb, 0xcc))
      expect(edited.output.plan.fidelity).toMatchObject({ preservesUnknownData: true })
      expect(mapInfoEditorTerrainContext(readMapInfo(bytes))).toBe('Korhal')
    } finally { await session.dispose() }
  })

  it('edits fixed dimensions and preserves the opaque version body byte-for-byte', async () => {
    const body = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])
    const bytes = writeMapInfo({ version: 39, width: 64, height: 96, unknown1: 11, unknown2: 22, body, strings: [] })
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { version: 39, width: 64, height: 96, preservedBodyBytes: 9 } } })
      const edited = await session.operations().invoke('set-dimensions', { width: 128, height: 160 })
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline bytes')
      const reopened = readMapInfo(payload.bytes)
      expect([reopened.width, reopened.height]).toEqual([128, 160])
      expect(reopened.body).toEqual(body)
      expect(edited.output.plan.fidelity).toMatchObject({ roundTrip: 'semantic', preservesUnknownData: true })
    } finally { await session.dispose() }
  })

  it('validates the contribution manifest against executable operations', async () => {
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/map-info/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
    expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
    expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })
})
