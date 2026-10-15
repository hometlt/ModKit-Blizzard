import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/documents/attributes/src/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = { maxInputBytes: 1_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:attributes'
  const ref = { id: 'attributes', uri: 'memory://Map.SC2Map/Attributes' }
  const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } }
}
async function planText(result: { state: string; output?: unknown }): Promise<string> {
  const output = result.state === 'ok' ? (result.output as { kind: string; plan?: { edits: { payload: { kind: string; bytes?: Uint8Array } }[] } }) : undefined
  const payload = output?.kind === 'edit-plan' ? output.plan?.edits[0]?.payload : undefined
  if (payload?.kind !== 'inline' || payload.bytes === undefined) throw new Error('missing inline edit bytes')
  return decoder.decode(payload.bytes)
}

// A map's own game attribute with one value and its default, then one variant as written — with
// an element whose attributes are not in sorted order, which the JSON edit must keep.
const document = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Attributes>',
  '    <Attribute>',
  '        <Id Value="5"/>',
  '        <Type Value="Global"/>',
  '        <Name Value="Attribute005/Name"/>',
  '        <Access Value="Host"/>',
  '        <Value>',
  '            <Id Value="1"/>',
  '            <Name Value="Attribute005/Value001/Name"/>',
  '        </Value>',
  '        <Default>',
  '            <Slot Id="Global"/>',
  '            <Value Id="1"/>',
  '        </Default>',
  '    </Attribute>',
  '    <DefaultVariants Value="1"/>',
  '    <Variant>',
  '        <Id Value="1"/>',
  '        <MaxTeamSize Value="4"/>',
  '        <AttributeHidden Namespace="999" Id="3006"/>',
  '    </Variant>',
  '</Attributes>',
].join('\r\n')

describe('SC2 Attributes codec', () => {
  it('publishes typed attributes and keeps variants as written', async () => {
    const session = await createCodec().open(input(encoder.encode(document)) as never, 'full', budget)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { rootTag: 'Attributes', semanticModel: 'typed', attributes: 1, values: 1, variants: 1, defaultVariants: 1, unknownElements: 0 } } })
      expect(await session.operations().invoke('document', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: {
        attributes: [{ id: '5', type: 'Global', name: 'Attribute005/Name', access: 'Host', values: [{ id: '1', name: 'Attribute005/Value001/Name' }] }],
        defaultVariants: 1,
        variants: [{ name: 'Variant' }],
      } } })
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as never as {
          root(): Promise<unknown>
          children(node: unknown, page: unknown): Promise<{ items: readonly unknown[] }>
          facts(node: unknown): Promise<Record<string, unknown>>
        }
        const [attribute, variant] = (await tree.children(await tree.root(), { limit: 10 })).items
        expect(await tree.facts(attribute)).toMatchObject({ label: 'Attribute 5', preview: 'Global, Host, 1 values' })
        expect(await tree.facts(variant)).toMatchObject({ label: 'Variant 1', semanticPath: ['variants', '0'] })
      } finally {
        await lease.release()
      }
    } finally { await session.dispose() }
  })

  it('writes an edited document through the model and root-checked XML verbatim', async () => {
    const session = await createCodec().open(input(encoder.encode(document)) as never, 'full', budget)
    try {
      const typed = await session.operations().invoke('document', {})
      if (typed.state !== 'ok' || typed.output.kind !== 'json') throw new Error('missing document')
      const edited = JSON.parse(JSON.stringify(typed.output.value))
      edited.attributes[0].access = 'Self'
      expect(await planText(await session.operations().invoke('replace-xml', { document: edited }))).toBe(document.replace('<Access Value="Host"/>', '<Access Value="Self"/>'))
      const xml = '<Attributes><Variant><Id Value="2"/></Variant></Attributes>'
      expect(await planText(await session.operations().invoke('replace-xml', { xml }))).toBe(xml)
      await expect(session.operations().invoke('replace-xml', { xml: '<Other/>' })).rejects.toThrow('not an <Attributes> document')
    } finally { await session.dispose() }
  })

  it('validates its manifest and operation parity', async () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/documents/attributes/codec.json'), 'utf8'))
    expect(manifest.spec.operations).toEqual(operations.map(item => expect.objectContaining(item)))
    const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
    expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
    expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })
})
