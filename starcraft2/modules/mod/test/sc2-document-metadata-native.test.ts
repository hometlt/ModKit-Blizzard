import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { A1_SPEC_SCHEMA_ENTRIES, createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import { createCodec, metadataFormat, operations, writeSc2DocumentInfoDependencies } from '../../../dist/modules/mod/codecs/document-metadata/codec.js'
import { writeDocumentHeader } from '../../../dist/modules/mod/codecs/document-metadata/core/document-header.js'
import { writeVersionFile } from '../../../dist/modules/mod/codecs/document-metadata/core/version-file.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

function input(bytes: Uint8Array, uri: string) {
  const revision = 'content-hash.sha256:sc2-document-metadata-native-fixture'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single' as const,
    bindings: [{ sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: ref, revision }],
    primaryBindingId: 'content',
    revisions: { topology: 'single' as const, revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: uri },
    bindingsFor: () => [],
    async openBinding() { return { value: source, release: async () => {} } },
  }
}

async function opened(bytes: Uint8Array, uri: string) {
  return createCodec().open(input(bytes, uri) as never, 'full', budget)
}

describe('SC2 document metadata native M5 adapter', () => {
  it('uses the authoritative three-format parser, type tags and marker validation', async () => {
    const header = writeDocumentHeader({ flags: 0x0501, headerSize: 958, timestamp1: 95_841, timestamp2: 95_841, unknown3: 2, hash1: 1, hash2: 2, dependencies: ['file:Mods/Liberty.SC2Mod'], entries: [{ key: 'DocInfo/Name', type: 'SUne', value: 'Fixture' }] })
    const headerSession = await opened(header, 'memory://Test.SC2Mod/DocumentHeader')
    try {
      const inspected = await headerSession.operations().invoke('inspect', {})
      expect(inspected).toMatchObject({ state: 'ok', output: { kind: 'json', value: { markerVersion: 8, gameSignature: 0x5332, artifactType: 'mod-or-campaign', dependencies: ['file:Mods/Liberty.SC2Mod'] } } })
      const descriptor = await headerSession.descriptor()
      expect(descriptor.dataSources).toEqual(expect.arrayContaining([
        { contract: 'common.view/tree-data-source', major: 1 },
        { contract: 'common.view/byte-range-source', major: 1 },
      ]))
      const tree = await headerSession.dataSource('common.view/tree-data-source', 1)
      try {
        const root = await tree.value.root()
        expect(await tree.value.facts(root)).toMatchObject({ kind: 'document-header', label: 'DocumentHeader' })
        expect((await tree.value.children(root, { cursor: '0', limit: 8 })).items).toHaveLength(1)
      } finally { await tree.release() }
      const ranges = await headerSession.dataSource('common.view/byte-range-source', 1)
      try {
        expect(await ranges.value.size()).toBe(BigInt(header.byteLength))
        expect(await ranges.value.read(0n, 4)).toEqual(header.slice(0, 4))
      } finally { await ranges.release() }
      expect(await headerSession.operations().invoke('validate', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: [] } })
      const converted = await headerSession.operations().invoke('export-convert', {})
      expect(converted).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: header } })
    } finally { await headerSession.dispose() }

    const version = writeVersionFile({ versionPath: 'Triggers.version', formatVersion: 2, buildNumber: 95_841, entryCount: 7 })
    const versionSession = await opened(version, 'memory://Test.SC2Map/Triggers.version')
    try {
      expect(await versionSession.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { componentType: 'Triggers', formatVersion: 2 } } })
    } finally { await versionSession.dispose() }

    const emptySession = await opened(new Uint8Array(), 'memory://Test.SC2Map/FontStyles.version')
    try {
      expect(await emptySession.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { format: 'version-file', empty: true } } })
    } finally { await emptySession.dispose() }

    expect(metadataFormat(encoder.encode('H2CS'), 'memory://Test.SC2Map/DocumentHeader')).toBeUndefined()
    const malformedVersion = new Uint8Array(36)
    malformedVersion.set(encoder.encode('cdes'))
    new DataView(malformedVersion.buffer).setUint32(8, 2, true)
    expect(metadataFormat(malformedVersion, 'memory://Test.SC2Map/MapInfo.version')).toBeUndefined()
  })

  it('publishes valid codec and subject-kind manifests with the executable operation table', async () => {
    const contributionDirectory = resolve(import.meta.dirname, '../../../contributions')
    const codecManifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../codecs/document-metadata/codec.json'), 'utf8'))
    expect(codecManifest.status).toBe('partial')
    expect(codecManifest.spec.operations).toEqual(expect.arrayContaining(operations.map(item => expect.objectContaining(item))))
    for (const path of [resolve(import.meta.dirname, '../codecs/document-metadata/codec.json'), resolve(contributionDirectory, 'subject-kind-sc2-document-metadata.json')]) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      const validation = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
      expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('serializes and revision-pins ordered dependency edits, then structurally reopens the output', async () => {
    const header = writeDocumentHeader({ flags: 0x0501, headerSize: 958, timestamp1: 95_841, timestamp2: 95_841, unknown3: 0, hash1: 1, hash2: 1, dependencies: ['file:Mods/Liberty.SC2Mod'], entries: [] })
    const session = await opened(header, 'memory://Test.SC2Map/DocumentHeader')
    try {
      const result = await session.operations().invoke('replace-dependencies', { dependencies: ['file:Mods/Swarm.SC2Mod', 'file:Mods/Void.SC2Mod'] })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      const replacement = result.output.plan.edits[0]?.payload
      expect(replacement?.kind).toBe('inline')
      if (replacement?.kind !== 'inline') return
      const reopened = await opened(replacement.bytes, 'memory://Test.SC2Map/DocumentHeader')
      try {
        expect(await reopened.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { dependencies: ['file:Mods/Swarm.SC2Mod', 'file:Mods/Void.SC2Mod'] } } })
      } finally { await reopened.dispose() }
    } finally { await session.dispose() }

    const info = writeSc2DocumentInfoDependencies(['file:Mods/Liberty.SC2Mod'])
    expect(decoder.decode(info)).toContain('<Dependencies>')
    const infoSession = await opened(info, 'memory://Test.SC2Mod/DocumentInfo')
    try {
      const result = await infoSession.operations().invoke('replace-dependencies', { dependencies: ['file:Mods/Swarm.SC2Mod'] })
      expect(result).toMatchObject({ state: 'ok', output: { kind: 'edit-plan' } })
    } finally { await infoSession.dispose() }
  })

  it('refuses dependency edits for .version sidecars', async () => {
    const session = await opened(encoder.encode(''), 'memory://Test.SC2Map/FontStyles.version')
    try {
      await expect(session.operations().invoke('replace-dependencies', { dependencies: [] })).resolves.toMatchObject({ state: 'rejected', reason: 'disabled' })
    } finally { await session.dispose() }
  })
})
