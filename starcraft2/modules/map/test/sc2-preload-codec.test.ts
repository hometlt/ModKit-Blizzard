import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { readPreload } from '../shared/format/formats/preload.js'
import { createCodec, operations } from '../codecs/documents/preload/src/codec.js'

const encoder = new TextEncoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 64, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:preload-fixture'
  const ref = { id: 'preload', uri: 'memory://Map.SC2Map/Preload.xml' }
  const byteSource = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) },
    async *stream() { yield bytes },
  }
  return {
    originKind: 'single' as const,
    bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }],
    primaryBindingId: 'content',
    revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] },
    compositionFingerprint: ref.uri,
    bindingsFor: () => [],
    async openBinding() { return { value: byteSource, release: async () => {} } },
  }
}

const fixtureXml = '<?xml version="1.0" encoding="utf-8"?>\r\n<Preload>\r\n<!-- keep on no-op -->\r\n<Unit id="Marine" UserTag="Terr"/>\r\n<Asset path="Assets/Textures/Marine.dds" Type="Image"/>\r\n</Preload>\r\n'

describe('SC2 Preload document codec', () => {
  it('publishes catalog and asset relations and creates a typed edit plan', async () => {
    const bytes = encoder.encode(fixtureXml)
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { entries: 2, references: 2, tags: 2 } } })
      const graph = await session.dataSource('common.view/relation-graph-source', 1)
      try { expect(await graph.value.summary()).toMatchObject({ totalEdges: 2, completeness: 'complete' }) } finally { await graph.release() }
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined).toEqual(bytes)
      const edited = await session.operations().invoke('set-attribute', { index: 0, attribute: 'id', value: 'Marauder' })
      expect(edited.state).toBe('ok')
      if (edited.state !== 'ok' || edited.output.kind !== 'edit-plan') throw new Error('missing edit plan')
      const payload = edited.output.plan.edits[0]?.payload
      if (payload?.kind !== 'inline') throw new Error('missing inline bytes')
      expect(readPreload(new TextDecoder().decode(payload.bytes)).entries[0]?.attrs['id']).toBe('Marauder')
      expect(edited.output.plan.targets[0]?.ownerSource.uri).toBe('memory://Map.SC2Map/Preload.xml')
      expect(edited.output.plan.fidelity.preservesUnknownData).toBe(false)
    } finally { await session.dispose() }
  })

  it('diagnoses malformed XML shape and validates manifests', async () => {
    const session = await createCodec().open(input(encoder.encode('<Preload><Unit id="Marine"></Preload>')) as never, 'full', budget)
    try {
      const result = await session.operations().invoke('validate', {})
      expect(result.state === 'ok' && result.output.kind === 'json' ? result.output.value : []).toHaveLength(1)
    } finally { await session.dispose() }
    const directory = resolve(import.meta.dirname, '../../../contributions')
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/preload/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const name of ['subject-kind-sc2-preload.json']) {
      const value = JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
      const result = await validateContributionManifest(value, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
      expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })
})
