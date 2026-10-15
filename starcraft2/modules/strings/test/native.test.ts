import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, operations } from '../codecs/strings/src/codec.js'

const encoder = new TextEncoder()
const fixture = encoder.encode('\ufeff// translator note\r\nA=First\r\nA=Final <d ref="Unit,Marine,Life"/>\r\nB=Second\r\n')
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 4_000_000, maxDiagnostics: 1_000 }

function input(bytes: Uint8Array, uri = 'memory://Test.SC2Mod/enUS.SC2Data/LocalizedData/GameStrings.txt') {
  const revision = 'content-hash.sha256:sc2-strings-native-fixture'
  const ref = { id: uri, uri }
  const source = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }
  return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: uri }, bindingsFor: () => [], async openBinding() { return { value: source, release: async () => {} } } }
}

async function opened(bytes = fixture) { return createCodec().open(input(bytes) as never, 'full', budget) }

describe('SC2 strings native M5 adapter', () => {
  it('uses canonical lossless model, exposes data sources, and executes every M5 operation', async () => {
    const session = await opened()
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { entries: 2, duplicateKeys: 1, references: 1 } } })
      const descriptor = await session.descriptor()
      expect(descriptor.dataSources).toEqual(expect.arrayContaining([{ contract: 'common.view/table-data-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 }, { contract: 'common.view/byte-range-source', major: 1 }]))
      const table = await session.dataSource('common.view/table-data-source', 1)
      /*
       * Four columns, not three: the rendered preview sits beside the raw value. MK2's editor had
       * both views and a toggle between them, because the markup a modder writes and the text a
       * player reads answer different questions. With no catalog in this session the `<d ref>`
       * cannot resolve, and the ported renderer marks the gap with `?` rather than echoing the
       * markup or dropping it silently — the reader sees that a value is missing, not that it is
       * empty.
       */
      try { expect(await table.value.shape()).toMatchObject({ rows: 2, columns: 4, header: ['Key', 'enUS', 'Preview', 'Status'] }); expect((await table.value.rows({ kind: 'range', from: 0, count: 2 })).items[0]).toMatchObject({ cells: ['A', 'Final <d ref="Unit,Marine,Life"/>', 'Final ?', 'duplicate'] }) } finally { await table.release() }
      const ranges = await session.dataSource('common.view/byte-range-source', 1)
      try { expect(await ranges.value.read(0n, fixture.length)).toEqual(fixture) } finally { await ranges.release() }
      expect(await session.operations().invoke('validate', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: expect.arrayContaining([expect.objectContaining({ code: 'blizzard.sc2-strings/duplicate-key' })]) } })
      // References carry the shape MK2 reports and the port requirement names — namespace, entity,
      // field. The single `target: 'Unit,Marine,Life'` string this used to assert was the previous
      // adapter's own invention, and it is gone with the adapter that made it up.
      expect(await session.operations().invoke('references', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: [expect.objectContaining({ key: 'A', ns: 'Unit', entity: 'Marine', field: 'Life' })] } })
      expect(await session.operations().invoke('resolve-fallback', { key: 'Missing', locale: 'ruRU', entries: [{ key: 'Missing', value: 'Запас' }] })).toMatchObject({ state: 'ok', output: { kind: 'json', value: { value: 'Запас', locale: 'ruRU', fromPrimary: false } } })
      expect(await session.operations().invoke('compare-locales', { locale: 'ruRU', entries: [{ key: 'A', value: 'Финал' }, { key: 'C', value: 'Extra' }] })).toMatchObject({ state: 'ok', output: { kind: 'json', value: { missing: ['B'], orphaned: ['C'] } } })
      expect(await session.operations().invoke('export-raw', {})).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: fixture } })
      expect(await session.operations().invoke('export-convert', {})).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: fixture } })
      const edit = await session.operations().invoke('edit-strings', { action: 'set', key: 'A', value: 'Changed' })
      expect(edit.state).toBe('ok')
      if (edit.state !== 'ok' || edit.output.kind !== 'edit-plan') return
      const payload = edit.output.plan.edits[0]?.payload
      expect(payload?.kind).toBe('inline')
      if (payload?.kind !== 'inline') return
      expect(payload.bytes).toEqual(encoder.encode('\ufeff// translator note\r\nA=First\r\nA=Changed\r\nB=Second\r\n'))
      const renamed = await session.operations().invoke('edit-strings', { action: 'rename', oldKey: 'A', newKey: 'Z' })
      expect(renamed.state).toBe('ok')
      if (renamed.state !== 'ok' || renamed.output.kind !== 'edit-plan') return
      const renamedPayload = renamed.output.plan.edits[0]?.payload
      expect(renamedPayload?.kind).toBe('inline')
      if (renamedPayload?.kind !== 'inline') return
      expect(renamedPayload.bytes).toEqual(encoder.encode('\ufeff// translator note\r\nZ=First\r\nZ=Final <d ref="Unit,Marine,Life"/>\r\nB=Second\r\n'))
      const added = await session.operations().invoke('edit-strings', { action: 'add', key: 'C', value: 'Third', afterKey: 'B' })
      expect(added.state).toBe('ok')
      if (added.state !== 'ok' || added.output.kind !== 'edit-plan') return
      const addedPayload = added.output.plan.edits[0]?.payload
      expect(addedPayload?.kind).toBe('inline')
      if (addedPayload?.kind !== 'inline') return
      expect(addedPayload.bytes).toEqual(encoder.encode('\ufeff// translator note\r\nA=First\r\nA=Final <d ref="Unit,Marine,Life"/>\r\nB=Second\r\nC=Third\n'))
    } finally { await session.dispose() }
  })

  /*
   * A catalog inside a package or a CASC archive is reached as a member: its path lives in the
   * subject URI's `vfs-path` query, percent-encoded. Read raw, that URI names no locale and no
   * catalog, and the host hands GameStrings.txt to the generic text codec instead.
   */
  it('recognises a catalog reached as a container member', async () => {
    const member = (path: string) =>
      `content-source://local:casc/Mods/Core.SC2Mod?vfs-path=${encodeURIComponent(path)}`
    const probe = async (uri: string) => {
      const ref = { id: uri, uri }
      const source = {
        kind: 'bytes' as const,
        ref,
        revision: 'content-hash.sha256:sc2-strings-detect',
        size: BigInt(fixture.length),
        async read(offset: bigint, length: number) { return fixture.slice(Number(offset), Number(offset) + length) },
        async *stream() { yield fixture },
      }
      const plan = { kind: 'bytes' as const, ranges: [{ from: 'start' as const, length: 4096 }], maxBytes: 4096 }
      return createCodec().probe({ source, plan } as never, undefined)
    }
    expect(await probe(member('enUS.SC2Data/LocalizedData/GameStrings.txt')))
      .toMatchObject({ evidence: [{ note: 'known-catalog-and-locale' }] })
    expect(await probe(member('enUS.SC2Data/LocalizedData/GameHotkeys.txt')))
      .toMatchObject({ evidence: [{ note: 'gamehotkeys-path-and-entries' }] })
    expect(await probe('memory://notes/Readme.txt')).toMatchObject({ confidence: 0 })
  })

  /*
   * What a table cell shows and offers while a translator works in it, at MK2's level: the value
   * drawn with the mod's style sheet, the `<d ref>` filled in once the host answers the catalog
   * question, and the markup highlighted and completed as it is typed.
   */
  it('draws, highlights and completes table values', async () => {
    const session = await opened()
    const json = async (handler: string, request: unknown) => {
      const result = await session.operations().invoke(handler, request as never)
      if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error(JSON.stringify(result))
      return result.output.value as any
    }
    try {
      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        expect(((await table.value.shape()) as any).actions).toMatchObject({
          renderValues: expect.stringContaining('sc2-strings.render'),
          highlightValue: expect.stringContaining('sc2-strings.highlight'),
          completeValue: expect.stringContaining('sc2-strings.complete'),
        })
      } finally { await table.release() }

      const workspaceDocuments = [{
        uri: 'memory://Core.SC2Mod/Base.SC2Data/UI/FontStyles.SC2Style',
        languageId: 'sc2-style',
        text: '<StyleFile><Constant name="ColorWarn" val="FF0000"/><Style name="Bold" styleflags="Bold"/></StyleFile>',
      }]
      const text = '<c val="ColorWarn">Hi</c><n/><s val="Bold">B</s><d ref="Unit,Marine,Life"/><img path="Assets\\Icon.dds"/> /// note'
      const first = await json('render-markup', { items: [{ column: 1, text }], workspaceDocuments })
      expect(first.items[0].runs).toEqual([
        { text: 'Hi', color: '#ff0000' },
        { text: '\n' },
        { text: 'B', bold: true },
        { text: '?', unresolved: expect.any(String) },
        { text: '', asset: 'Assets\\Icon.dds' },
      ])
      expect(first.catalogQueries).toEqual([{ namespace: 'Unit', entityId: 'Marine' }])
      const answered = await json('render-markup', {
        items: [{ column: 1, text }],
        workspaceDocuments,
        catalogEntities: [{ namespace: 'Unit', entityId: 'Marine', fields: { Life: '45' } }],
      })
      expect(answered.items[0].runs).toContainEqual({ text: '45' })
      expect(answered.catalogQueries).toBeUndefined()

      const highlight = await json('highlight-value', { column: 1, text: '<c val="FF0000">x</c>' })
      expect(highlight.spans.length).toBeGreaterThan(0)
      expect(highlight.diagnostics).toEqual([])
      const broken = '<d ref="(Weapon,A,Amount*2"/>'
      expect((await json('highlight-value', { column: 1, text: broken })).diagnostics).toEqual([
        expect.objectContaining({ code: 'malformed-operation', severity: 'error', from: expect.any(Number), to: expect.any(Number) }),
      ])

      const completion = await json('complete-value', { row: 0, column: 1, text: 'a <', offset: 3, workspaceDocuments })
      expect(completion).toMatchObject({ to: 3 })
      expect(completion.items).toContainEqual(expect.objectContaining({ insertTextFormat: 'snippet', insertText: expect.stringContaining('$0') }))
      const colors = await json('complete-value', { row: 0, column: 1, text: '<c val="', offset: 8, workspaceDocuments })
      expect(colors.items).toContainEqual(expect.objectContaining({ label: 'ColorWarn' }))
    } finally { await session.dispose() }
  })

  it('publishes the compiled partial contribution with every executable operation', async () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/strings/codec.json'), 'utf8'))
    expect(manifest.status).toBe('partial')
    expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(operation => expect.objectContaining(operation))))
    const validation = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
    expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })
})
