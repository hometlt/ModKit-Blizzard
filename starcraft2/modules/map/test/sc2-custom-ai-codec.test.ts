import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/custom-ai/src/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:custom-ai-fixture'
  const ref = { id: 'custom-ai', uri: 'memory://Map.SC2Map/CustomAI' }
  const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } }
}
async function planText(result: { state: string; output?: unknown }): Promise<{ text: string; fidelity: unknown }> {
  const output = result.state === 'ok' ? (result.output as { kind: string; plan?: { edits: { payload: { kind: string; bytes?: Uint8Array } }[]; fidelity: unknown } }) : undefined
  const payload = output?.kind === 'edit-plan' ? output.plan?.edits[0]?.payload : undefined
  if (payload?.kind !== 'inline' || payload.bytes === undefined) throw new Error('missing inline edit bytes')
  return { text: decoder.decode(payload.bytes), fidelity: output!.plan!.fidelity }
}

// One attack-wave AI as the editor writes it: a wave with a unit count per difficulty, a gather
// time with its trigger and a point used on two levels.
const document = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AIData>',
  '    <RepeatShow Value="1800"/>',
  '    <Definition Id="12AB34CD" Color="255,255,0,0">',
  '        <SourcePlayer Value="2"/>',
  '        <TargetPlayer Value="1"/>',
  '        <GatherDefault Id="55"/>',
  '        <Step Type="Wave" Id="1">',
  '            <CreateUnits/>',
  '            <Unit Type="Marine">',
  '                <Count DiffLevel="1" Value="2"/>',
  '                <Count DiffLevel="2" Value="4"/>',
  '            </Unit>',
  '            <Time Type="GatherTime" Trigger="1A2B3C4D">',
  '                <Duration DiffLevel="1" Value="30"/>',
  '            </Time>',
  '            <Point Type="TargetPoint" Id="77">',
  '                <Active DiffLevel="1"/>',
  '                <Active DiffLevel="2"/>',
  '            </Point>',
  '        </Step>',
  '        <Step Type="Comment" Text="then repeat"/>',
  '    </Definition>',
  '</AIData>',
].join('\r\n')

describe('SC2 CustomAI document codec', () => {
  it('publishes the typed document, its tree and table, and exports the bytes read', async () => {
    const bytes = encoder.encode(document)
    const session = await createCodec().open(input(bytes) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { rootTag: 'AIData', semanticModel: 'typed', definitions: 1, steps: 2, waves: 1, unknownElements: 0 } } })
      const typed = await session.operations().invoke('document', {})
      expect(typed).toMatchObject({ state: 'ok', output: { kind: 'json', value: {
        repeatShow: 1800,
        definitions: [{ id: '12AB34CD', sourcePlayer: 2, targetPlayers: [1], gatherDefault: '55', steps: [
          { type: 'Wave', id: 1, createUnits: true, units: [{ type: 'Marine', counts: [{ level: 1, value: 2 }, { level: 2, value: 4 }] }], times: [{ type: 'GatherTime', trigger: '1A2B3C4D' }], points: [{ type: 'TargetPoint', id: '77', active: [1, 2] }] },
          { type: 'Comment', text: 'then repeat' },
        ] }],
      } } })
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw.state === 'ok' && raw.output.kind === 'bytes' ? raw.output.value : undefined).toEqual(bytes)
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as never as {
          root(): Promise<unknown>
          children(node: unknown, page: unknown): Promise<{ items: readonly unknown[] }>
          facts(node: unknown): Promise<Record<string, unknown>>
        }
        const [definition] = (await tree.children(await tree.root(), { limit: 10 })).items
        expect(await tree.facts(definition)).toMatchObject({ label: 'Definition 12AB34CD', semanticPath: ['definitions', '0'] })
        const [wave] = (await tree.children(definition, { limit: 10 })).items
        expect(await tree.facts(wave)).toMatchObject({ label: 'Wave 1' })
        const [marine] = (await tree.children(wave, { limit: 10 })).items
        expect(await tree.facts(marine)).toMatchObject({ label: 'Marine', preview: '1:2 2:4', semanticPath: ['definitions', '0', 'steps', '0', 'units', '0'] })
      } finally {
        await lease.release()
      }
    } finally { await session.dispose() }
  })

  it('writes an edited document in the editor layout and replacement XML verbatim', async () => {
    const session = await createCodec().open(input(encoder.encode(document)) as never, 'full', budget)
    try {
      const typed = await session.operations().invoke('document', {})
      if (typed.state !== 'ok' || typed.output.kind !== 'json') throw new Error('missing document')
      const edited = JSON.parse(JSON.stringify(typed.output.value))
      edited.definitions[0].steps[0].units[0].counts[1].value = 6
      const byDocument = await planText(await session.operations().invoke('replace-xml', { document: edited }))
      expect(byDocument.text).toBe(document.replace('<Count DiffLevel="2" Value="4"/>', '<Count DiffLevel="2" Value="6"/>'))
      expect(byDocument.fidelity).toMatchObject({ roundTrip: 'semantic', preservesUnknownData: true })
      const xml = '<AIData><RepeatShow Value="3600"/><Unknown Keep="yes"/></AIData>'
      const byXml = await planText(await session.operations().invoke('replace-xml', { xml }))
      expect(byXml.text).toBe(xml)
      expect(byXml.fidelity).toMatchObject({ roundTrip: 'byte-identical', preservesUnknownData: true })
      await expect(session.operations().invoke('replace-xml', { xml: '<Other/>' })).rejects.toThrow('not an <AIData> document')
      await expect(session.operations().invoke('replace-xml', { document: { definitions: 'none' } })).rejects.toThrow('CustomAI document cannot be written')
      await expect(session.operations().invoke('replace-xml', {})).rejects.toThrow('xml string or a document')
    } finally { await session.dispose() }
  })

  it('reports a document it cannot read and validates its manifest', async () => {
    const session = await createCodec().open(input(encoder.encode('<Other/>')) as never, 'full', budget)
    try {
      const result = await session.operations().invoke('validate', {})
      expect(result.state === 'ok' && result.output.kind === 'json' ? result.output.value : []).toMatchObject([{ severity: 'error', code: 'blizzard.sc2-custom-ai/invalid-root' }])
      await expect(session.operations().invoke('document', {})).rejects.toThrow('CustomAI cannot be read')
    } finally { await session.dispose() }
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/custom-ai/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(operations.map(item => expect.objectContaining(item)))
    const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
    expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
    expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })
})
