import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createModkit, openPathArtifactSource } from '@modkit/host/node'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'
import { readFluffDoodad, writeFluffDoodad } from '../shared/format/formats/fluff-doodad.js'
import { PAINTED_LAYER_BYTE_LENGTH, readPaintedPathing } from '../shared/format/formats/painted-pathing.js'
import { readVertexColor } from '../shared/format/formats/vertex-color.js'
import { readHardTile, writeHardTile } from '../shared/format/formats/hard-tile.js'
import { createCodec as createFluff, operations as fluffOperations } from '../codecs/documents/fluff-doodad/src/codec.js'
import { createCodec as createHardTile, operations as hardTileOperations } from '../codecs/documents/hard-tile/src/codec.js'
import { createCodec as createPainted, operations as paintedOperations } from '../codecs/documents/painted-pathing/src/codec.js'
import { createCodec as createPaintedCreep, operations as paintedCreepOperations } from '../codecs/documents/painted-creep/src/codec.js'
import { createCodec as createVertexColor, operations as vertexColorOperations } from '../codecs/documents/vertex-color/src/codec.js'

const budget = { maxInputBytes: 2_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 2_000_000, maxDiagnostics: 100 }
function input(bytes: Uint8Array, name: string) { const revision = `content-hash.sha256:${name}`; const ref = { id: name, uri: `memory://Map.SC2Map/${name}` }; const byteSource = { kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length), async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) }, async *stream() { yield bytes } }; return { originKind: 'single' as const, bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }], primaryBindingId: 'content', revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }] }, compositionFingerprint: ref.uri, bindingsFor: () => [], async openBinding() { return { value: byteSource, release: async () => {} } } } }
function editBytes(result: any, original: Uint8Array): Uint8Array { if (result.state !== 'ok' || result.output.kind !== 'edit-plan') throw new Error('missing edit plan'); const edit = result.output.plan.edits[0]; if (edit?.payload?.kind !== 'inline' || edit.range?.kind !== 'bytes') throw new Error('missing inline byte edit'); const offset = Number(edit.range.offset); const deleteCount = Number(edit.range.length); const output = new Uint8Array(original.length - deleteCount + edit.payload.bytes.length); output.set(original.subarray(0, offset)); output.set(edit.payload.bytes, offset); output.set(original.subarray(offset + deleteCount), offset + edit.payload.bytes.length); return output }

describe('SC2 auxiliary terrain document codecs', () => {
  it('edits fluff doodads while preserving unknown bytes', async () => {
    const bytes = writeFluffDoodad({ version: 7, doodads: [{ x: 1, y: 2, type: 3 }], _raw: { zero: new Uint8Array(16).fill(9), trailing: new Uint8Array([8, 7]) } })
    const session = await createFluff().open(input(bytes, 't3FluffDoodad') as never, 'full', budget)
    try { const output = editBytes(await session.operations().invoke('set-doodad', { index: 0, x: 4, type: 5 }), bytes); const reopened = readFluffDoodad(output); expect(reopened.doodads[0]).toMatchObject({ x: 4, y: 2, type: 5 }); expect(reopened._raw.zero).toEqual(new Uint8Array(16).fill(9)); expect(reopened._raw.trailing).toEqual(new Uint8Array([8, 7])) } finally { await session.dispose() }
  })

  it('patches one VTCL color without normalizing unknown bytes', async () => {
    const bytes = new Uint8Array(32 + 36 + 3 + 2); const view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode('VTCL')); view.setUint32(4, 104, true); view.setUint32(8, 1, true); view.setUint32(12, 0x12345678, true); bytes.fill(6, 16, 32); view.setFloat32(32, 1, true); view.setFloat32(40, 2, true); view.setFloat32(48, 4, true); view.setFloat32(52, 3, true); view.setUint32(64, 3, true); bytes.set([10, 20, 30, 0xaa, 0xbb], 68)
    const session = await createVertexColor().open(input(bytes, 't3VertCol') as never, 'full', budget)
    try { const output = editBytes(await session.operations().invoke('set-color', { entry: 0, index: 1, value: 99 }), bytes); expect(readVertexColor(output).entries[0]?.data).toEqual(new Uint8Array([10, 99, 30])); expect(output.slice(0, 68)).toEqual(bytes.slice(0, 68)); expect(output.slice(71)).toEqual(new Uint8Array([0xaa, 0xbb])) } finally { await session.dispose() }
  })

  it('inspects and patches one painted-pathing channel', async () => {
    const bytes = new Uint8Array(PAINTED_LAYER_BYTE_LENGTH + 2); const view = new DataView(bytes.buffer); view.setInt32(0, 1, true); view.setInt32(4, 2, true); view.setInt32(8, 3, true); view.setInt32(12, 4, true); bytes.set([0xcc, 0xdd], PAINTED_LAYER_BYTE_LENGTH)
    const session = await createPainted().open(input(bytes, 'PaintedPathingLayer') as never, 'full', budget)
    try { const inspected = await session.operations().invoke('inspect-cell', { x: 2, y: 3 }); expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { primary: 0, secondary: 0 } } }); const output = editBytes(await session.operations().invoke('set-cell', { x: 2, y: 3, channel: 'secondary', value: 41 }), bytes); const reopened = readPaintedPathing(output); expect(reopened.paint?.[2 * (2 + 3 * 512) + 1]).toBe(41); expect(output.slice(PAINTED_LAYER_BYTE_LENGTH)).toEqual(new Uint8Array([0xcc, 0xdd])) } finally { await session.dispose() }
  })

  it('keeps painted creep storage separate from unproven creep semantics', async () => {
    const bytes = new Uint8Array(PAINTED_LAYER_BYTE_LENGTH); const session = await createPaintedCreep().open(input(bytes, 'PaintedCreepLayer') as never, 'full', budget)
    try { const inspected = await session.operations().invoke('inspect-cell', { x: 0, y: 0 }); expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { primary: 0, secondary: 0, semantics: 'raw-paint-channels' } } }) } finally { await session.dispose() }
  })

  it('preserves hard-tile raw export and exposes explicit repair and group replacement', async () => {
    const bytes = new Uint8Array(28); const view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode('HRDT')); view.setUint32(4, 102, true)
    const session = await createHardTile().open(input(bytes, 't3HardTile') as never, 'full', budget)
    try { expect(hardTileOperations.map(operation => operation.id)).toEqual(['asset.validate', 'export.raw', 'blizzard/sc2-hard-tile.repair-group-keys', 'blizzard/sc2-hard-tile.replace-groups']); const raw = await session.operations().invoke('export-raw', {}); expect(raw).toMatchObject({ state: 'ok', output: { kind: 'bytes' } }) } finally { await session.dispose() }
  })

  it('does not invent groups for unsupported, over-counted or unterminated HRDT data', () => {
    const unsupported = new Uint8Array(28)
    unsupported.set(new TextEncoder().encode('HRDT'))
    new DataView(unsupported.buffer).setUint32(4, 103, true)
    expect(readHardTile(unsupported)).toMatchObject({ version: 103, decodedBytes: 8, blocks: [], rawRemainder: unsupported.slice(8) })

    const overCounted = new Uint8Array(32)
    overCounted.set(new TextEncoder().encode('HRDT'))
    const overCountedView = new DataView(overCounted.buffer)
    overCountedView.setUint32(4, 102, true)
    overCountedView.setUint32(24, 1, true)
    overCountedView.setUint32(28, 0xffffffff, true)
    expect(readHardTile(overCounted)).toMatchObject({ decodedBytes: 28, blocks: [], rawRemainder: overCounted.slice(28) })

    const unterminated = new Uint8Array(39)
    unterminated.set(new TextEncoder().encode('HRDT'))
    const unterminatedView = new DataView(unterminated.buffer)
    unterminatedView.setUint32(4, 102, true)
    unterminatedView.setUint32(24, 1, true)
    unterminated.set([0, 1, 0, 65, 66, 67, 68], 32)
    expect(readHardTile(unterminated)).toMatchObject({ decodedBytes: 28, blocks: [], rawRemainder: unterminated.slice(28) })

    const invalidName = new Uint8Array(41)
    invalidName.set(new TextEncoder().encode('HRDT'))
    const invalidNameView = new DataView(invalidName.buffer)
    invalidNameView.setUint32(4, 102, true)
    invalidNameView.setUint32(24, 1, true)
    invalidName[35] = 0xff
    expect(readHardTile(invalidName)).toMatchObject({ decodedBytes: 28, blocks: [], rawRemainder: invalidName.slice(28) })

    const overlongName = new Uint8Array(28 + 4 + 3 + 257 + 4)
    overlongName.set(new TextEncoder().encode('HRDT'))
    const overlongView = new DataView(overlongName.buffer)
    overlongView.setUint32(4, 102, true)
    overlongView.setUint32(24, 1, true)
    overlongName.fill(65, 35, 35 + 256)
    expect(readHardTile(overlongName)).toMatchObject({ decodedBytes: 28, blocks: [], rawRemainder: overlongName.slice(28) })
  })

  it('reads bounded version-102 HRDT records and keeps unexplained trailing bytes opaque', async () => {
    const bytes = new Uint8Array(339)
    const view = new DataView(bytes.buffer)
    bytes.set(new TextEncoder().encode('HRDT'))
    view.setUint32(4, 102, true)
    view.setUint32(24, 1, true)
    view.setUint32(28, 5, true)
    for (let index = 0; index < 5; index += 1) {
      const offset = 32 + index * 58
      view.setFloat32(offset, index + 0.5, true)
      view.setFloat32(offset + 4, index + 1.5, true)
      view.setFloat32(offset + 8, index + 2.5, true)
      view.setFloat32(offset + 20, 1, true)
      for (let word = 0; word < 6; word += 1) view.setUint32(offset + 24 + word * 4, word + index, true)
      view.setFloat32(offset + 48, 1, true)
      view.setUint32(offset + 52, 0x40000000, true)
      bytes.set([index, 0x12], offset + 56)
    }
    bytes.set([0, 1, 0], 322)
    bytes.set(new TextEncoder().encode('RoadTest'), 325)
    view.setUint32(334, 0x789abcde, true)
    bytes[338] = 0xa5

    const parsed = readHardTile(bytes)
    expect(parsed).toMatchObject({ version: 102, declaredBlocks: 1, decodedBytes: 338 })
    expect(parsed.blocks[0]?.subs).toHaveLength(5)
    expect(parsed.blocks[0]).toMatchObject({ name: 'RoadTest', flags: [0, 1, 0], tailWord: 0x789abcde })
    expect(parsed.blocks[0]?.subs[4]).toMatchObject({ x: 4.5, y: 5.5, z: 6.5, normal: [0, 0, 1], unknownWords: [4, 5, 6, 7, 8, 9], scale: 1, tailWord: 0x40000000, flags: [4, 0x12] })
    expect(parsed.blocks[0]?.subs[4]?.raw).toEqual(bytes.slice(32 + 4 * 58, 322))
    expect(parsed.rawRemainder).toEqual(new Uint8Array([0xa5]))
    expect(writeHardTile(parsed)).toEqual(bytes)
    const truncated = readHardTile(bytes.slice(0, 100))
    expect(truncated).toMatchObject({ declaredBlocks: 1, decodedBytes: 28, blocks: [] })
    expect(truncated.rawRemainder).toEqual(bytes.slice(28, 100))

    const session = await createHardTile().open(input(bytes, 't3HardTile') as never, 'full', budget)
    try {
      const inspected = await session.operations().invoke('inspect', {})
      expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { blocks: 1, placements: 5, partial: true, decodedBytes: 338, opaqueBytes: 1 } } })
      expect(await session.operations().invoke('validate', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: [{ code: 'blizzard.sc2-hard-tile/partial-layout', category: 'structure' }] } })
      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        expect(await table.value.shape()).toEqual({ rows: 1, columns: 5, header: ['index', 'name', 'placements', 'flags', 'tailWord'] })
        expect((await table.value.rows({ kind: 'range', from: 0, count: 1 })).items[0]?.cells).toEqual(['0', 'RoadTest', '5', '0,1,0', '2023406814'])
      } finally { await table.release() }
      const tree = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const blocks = await tree.value.children(await tree.value.root(), { limit: 10 })
        const records = await tree.value.children(blocks.items[0]!, { limit: 10 })
        expect(records.items).toHaveLength(5)
        expect(await tree.value.facts(records.items[4]!)).toMatchObject({
          kind: 'hard-tile-placement',
          value: { x: 4.5, y: 5.5, z: 6.5, normal: [0, 0, 1], unknownWords: [4, 5, 6, 7, 8, 9], scale: 1, tailWord: 0x40000000, flags: [4, 0x12], rawHex: Array.from(bytes.slice(32 + 4 * 58, 322), byte => byte.toString(16).padStart(2, '0')).join('') },
        })
      } finally { await tree.release() }
    } finally { await session.dispose() }
  })

  it.skipIf(!existsSync('C:/MODDING/references/RoadExampleMap.SC2Map'))('opens RoadExampleMap HRDT through the public Host route', async () => {
    const path = join('C:/MODDING/references/RoadExampleMap.SC2Map', 't3HardTile')
    const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: ['C:/MODDING/references'] })
    const grant = { id: 'sc2-hrdt-read', classes: ['read-source'] } as const
    const opened = await host.services.open({ source: await openPathArtifactSource(path), path, intent: 'full', grant, budget })
    if (opened.state !== 'opened') throw new Error(`t3HardTile did not open: ${JSON.stringify(opened)}`)
    try {
      const raw = await opened.session.operations().invoke('export-raw', {})
      if (raw.state !== 'ok' || raw.output.kind !== 'bytes') throw new Error('HRDT raw export failed')
      const bytes = raw.output.value
      expect(bytes.byteLength).toBe(341)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe('94dd219f288320a154484137a74279f54cffa1024c832c5d63efcb8c7b869652')
      const parsed = readHardTile(bytes)
      expect(parsed).toMatchObject({ version: 102, declaredBlocks: 1, decodedBytes: 341 })
      expect(parsed.blocks[0]?.subs).toHaveLength(5)
      expect(parsed.blocks[0]).toMatchObject({ name: 'MarSaraTile', flags: [0, 1, 0] })
      expect(parsed.blocks[0]?.subs[0]?.normal).toHaveLength(3)
      expect(parsed.rawRemainder).toBeUndefined()
      expect(writeHardTile(parsed)).toEqual(bytes)
      const current = await createHardTile().open(input(bytes, 't3HardTile') as never, 'full', budget)
      try {
        expect(await current.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { blocks: 1, placements: 5, decodedBytes: 341, opaqueBytes: 0, partial: false } } })
        const tree = await current.dataSource('common.view/tree-data-source', 1)
        try {
          const blocks = await tree.value.children(await tree.value.root(), { limit: 10 })
          expect((await tree.value.children(blocks.items[0]!, { limit: 10 })).items).toHaveLength(5)
        } finally { await tree.release() }
      } finally { await current.dispose() }
    } finally { await opened.session.dispose() }
  }, 120_000)

  it('walks multiple bounded groups without assuming a fixed name width', () => {
    const names = ['A', 'MarSaraTile', 'LongerGroupName']
    const bytes = new Uint8Array(28 + names.reduce((size, name) => size + 4 + 3 + name.length + 1 + 4, 0))
    bytes.set(new TextEncoder().encode('HRDT'))
    const view = new DataView(bytes.buffer)
    view.setUint32(4, 102, true)
    view.setUint32(24, names.length, true)
    let offset = 28
    for (const [index, name] of names.entries()) {
      view.setUint32(offset, 0, true)
      offset += 4
      bytes.set([0, 1, index], offset)
      offset += 3
      bytes.set(new TextEncoder().encode(name), offset)
      offset += name.length + 1
      view.setUint32(offset, 0xabcdef00 + index, true)
      offset += 4
    }
    const parsed = readHardTile(bytes)
    expect(parsed.blocks.map(block => block.name)).toEqual(names)
    expect(parsed.blocks.map(block => block.tailWord)).toEqual([0xabcdef00, 0xabcdef01, 0xabcdef02])
    expect(parsed.decodedBytes).toBe(bytes.length)
    expect(parsed.rawRemainder).toBeUndefined()

    const truncated = new Uint8Array(44)
    truncated.set(new TextEncoder().encode('HRDT'))
    const truncatedView = new DataView(truncated.buffer)
    truncatedView.setUint32(4, 102, true)
    truncatedView.setUint32(24, 2, true)
    truncatedView.setUint32(40, 1, true)
    const prefix = readHardTile(truncated)
    expect(prefix.blocks).toHaveLength(1)
    expect(prefix.decodedBytes).toBe(40)
    expect(prefix.rawRemainder).toEqual(truncated.slice(40))
  })

  it('validates contribution manifests and executable operation parity', async () => {
    const cases = [['fluff-doodad', fluffOperations], ['vertex-color', vertexColorOperations], ['painted-pathing', paintedOperations], ['painted-creep', paintedCreepOperations], ['hard-tile', hardTileOperations]] as const
    for (const [slug, operations] of cases) { const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, `../codecs/documents/${slug}/codec.json`), 'utf8')); expect(manifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item)))); const result = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES)); expect(result.specState, `${slug}: ${JSON.stringify(result.diagnostics)}`).toBe('validated'); expect(result.diagnostics.filter(item => item.severity === 'error')).toEqual([]) }
  })
})
