import { describe, expect, it } from 'vitest'
import { createCodec, metadataFormat } from '../../../dist/modules/mod/codecs/document-metadata/codec.js'
import { writeDocumentHeader } from '../../../dist/modules/mod/codecs/document-metadata/core/document-header.js'
import { writeVersionFile } from '../../../dist/modules/mod/codecs/document-metadata/core/version-file.js'

const encoder = new TextEncoder()
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 4_000_000, maxDiagnostics: 1_000 }

function input(bytes: Uint8Array, uri: string) {
  const revision = 'content-hash.sha256:sc2-document-metadata-card'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const, ref, revision, size: BigInt(bytes.length),
    async read(offset: bigint, length: number) { return bytes.slice(Number(offset), Number(offset) + length) },
    async *stream() { yield bytes },
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

interface Fact { id: string; label: string; value: unknown; note?: string; locale?: string }

async function card(bytes: Uint8Array, uri: string) {
  const session = await createCodec().open(input(bytes, uri) as never, 'full', budget)
  const lease = await session.dataSource('common.view/subject-facts-source', 1)
  try {
    const facts = lease.value
    const summary = await facts.summary()
    const groups: Record<string, Fact[]> = {}
    for (const group of (await facts.groups({ limit: 64 })).items) {
      groups[group.id] = (await facts.facts(group.id, { limit: 256 })).items as Fact[]
    }
    const relations = (await facts.relations({ limit: 64 })).items
    const descriptor = await session.descriptor()
    return { summary, groups, relations, descriptor }
  } finally {
    await lease.release()
    await session.dispose()
  }
}

describe('SC2 document metadata subject card facts', () => {
  it('types a DocumentHeader: noted header fields, dependency links and localized strings', async () => {
    const header = writeDocumentHeader({
      flags: 0x0501, headerSize: 958, timestamp1: 93_077, timestamp2: 93_077, unknown3: 2, hash1: 1, hash2: 1,
      dependencies: ['bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod', 'file:Mods\\Custom\\Hybrids.SC2Mod'],
      entries: [
        { key: 'DocInfo/Name', type: 'SUne', value: 'All Races' },
        { key: 'DocInfo/Name', type: 'URur', value: 'Все расы' },
      ],
    })
    const { summary, groups, relations, descriptor } = await card(header, 'memory://AllRaces2-Data.SC2Mod/DocumentHeader')
    expect(summary.identity).toMatchObject({ label: 'DocumentHeader', kind: 'sc2-document-header' })
    expect(groups['document-header']).toContainEqual(expect.objectContaining({ id: 'hash2', note: 'Expected to match the first hash' }))
    expect(groups['document-header']).toContainEqual(expect.objectContaining({ id: 'timestamp1', label: 'Game build', value: 93_077 }))
    expect(groups['dependencies']).toEqual([
      expect.objectContaining({ label: 'Void Multi (Mod)', value: { 'Battle.net id': '999', version: '0.0', file: 'Mods/VoidMulti.SC2Mod' } }),
      expect.objectContaining({ label: 'Hybrids.SC2Mod', value: { file: 'Mods/Custom/Hybrids.SC2Mod' } }),
    ])
    expect(relations.map(item => [item.role, item.label])).toEqual([
      ['dependency', 'Void Multi (Mod) · 999 · Mods/VoidMulti.SC2Mod'],
      ['dependency', 'Hybrids.SC2Mod · Mods/Custom/Hybrids.SC2Mod'],
    ])
    expect(groups['document-header']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'magic', value: 'H2CS' }),
      expect.objectContaining({ id: 'flags', value: '0x0501', note: 'Standard/full profile' }),
      expect.objectContaining({ id: 'gameSignature', value: '0x00005332 (S2)' }),
      expect.objectContaining({ id: 'reserved', value: '00 00 00 00 00 00 00 00' }),
    ]))
    // Entries sit in the section their key names, as MK2 showed them; the rest stay "Localized strings".
    expect(groups['document-info']).toEqual([
      expect.objectContaining({ id: 'DocInfo/Name', value: 'All Races', locale: 'enUS' }),
      expect.objectContaining({ id: 'DocInfo/Name', value: 'Все расы', locale: 'ruRU' }),
    ])
    expect(groups['strings']).toBeUndefined()
    expect(groups['entry-types']).toEqual([
      expect.objectContaining({ label: 'SUne', value: 1, locale: 'enUS' }),
      expect.objectContaining({ label: 'URur', value: 1, locale: 'ruRU' }),
    ])
    // Descriptor metadata no longer carries lists or records a card would print as JSON.
    const metadata = (descriptor as unknown as { metadata: { entries: { key: string; value: unknown }[] }[] }).metadata[0]!
    expect(metadata.entries.every(entry => entry.value === null || typeof entry.value !== 'object')).toBe(true)
    expect(metadata.entries).toContainEqual(expect.objectContaining({ key: 'hash2', note: 'Expected to match the first hash' }))
  })

  it('types DocumentInfo, .version and ComponentList.SC2Components', async () => {
    const info = encoder.encode('<?xml version="1.0" encoding="utf-8"?>\n<DocInfo>\n  <Icon>\n    <Value>logo-small.png</Value>\n  </Icon>\n  <Dependencies>\n    <Value>bnet:Liberty/0.0/999,file:Mods/Liberty.SC2Mod</Value>\n  </Dependencies>\n</DocInfo>\n')
    const infoCard = await card(info, 'memory://Test.SC2Mod/DocumentInfo')
    expect(infoCard.groups['document-info']).toContainEqual(expect.objectContaining({ id: 'Icon', value: 'logo-small.png' }))
    expect(infoCard.groups['document-info']!.some(item => item.id === 'Dependencies')).toBe(false)
    expect(infoCard.relations).toEqual([expect.objectContaining({ role: 'dependency', kind: 'sc2-mod-dependency' })])

    const version = writeVersionFile({ versionPath: 'GameData.version', formatVersion: 2, buildNumber: 93_077, entryCount: 14 })
    const versionCard = await card(version, 'memory://Test.SC2Mod/GameData.version')
    expect(versionCard.groups['version-file']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'componentType', value: 'GameData' }),
      expect.objectContaining({ id: 'buildNumber', value: 93_077 }),
      expect.objectContaining({ id: 'entryCount', value: 14 }),
      expect.objectContaining({ id: 'buildNumber2', value: 93_077, note: 'Matches the game build' }),
      expect.objectContaining({ id: 'formatVersion', value: 2, note: '44-byte record' }),
      expect.objectContaining({ id: 'terminal' }),
      expect.objectContaining({ id: 'bytesConsumed', value: 44 }),
    ]))
    const oldVersion = writeVersionFile({ versionPath: 'GameData.version', formatVersion: 0, buildNumber: 93_077 })
    const oldIds = (await card(oldVersion, 'memory://Test.SC2Mod/GameData.version')).groups['version-file']!.map(item => item.id)
    expect(oldIds).not.toContain('entryCount')
    expect(oldIds).not.toContain('buildNumber2')

    const list = encoder.encode('<?xml version="1.0" encoding="utf-8"?>\n<Components>\n    <Optimized/>\n    <DataComponent Type="gada">GameData</DataComponent>\n    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>\n    <DataComponent Type="text" Locale="ruRU">GameText</DataComponent>\n</Components>')
    expect(metadataFormat(list, 'memory://Test.SC2Mod/ComponentList.SC2Components')).toBe('component-list')
    const listCard = await card(list, 'memory://Test.SC2Mod/ComponentList.SC2Components')
    expect(listCard.summary.identity).toMatchObject({ kind: 'sc2-component-list', label: 'ComponentList.SC2Components' })
    expect(listCard.groups['components']!.map(item => [item.label, item.value])).toEqual([
      ['Game data', 'GameData'],
      ['Localized text (enUS)', 'GameText'],
      ['Localized text (ruRU)', 'GameText'],
    ])
    expect(listCard.groups['overview']).toContainEqual(expect.objectContaining({ id: 'locales', value: ['enUS', 'ruRU'] }))
  })
})
