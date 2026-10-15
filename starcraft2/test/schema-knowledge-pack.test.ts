import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { knowledgeTargetKey, type KnowledgeEntry } from '@modkit/sdk/knowledge'

import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../modules/data/services/schema/data-schema-identity.js'
import {
  STARCRAFT2_DATA_SCHEMAS,
  starcraft2DeclaringTypeForField,
} from '../modules/data/services/schema/full-data-schema.js'

const extensionRoot = new URL('../', import.meta.url)
const manifestUrl = new URL('contributions/knowledge-schema-data.json', extensionRoot)
const coverageUrl = new URL(
  '../modules/data/services/schema/generated/knowledge-coverage.json',
  import.meta.url,
)

describe('StarCraft II generated schema knowledge', () => {
  it('backs every declared top-level schema field with exact, source-linked knowledge', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      readonly spec: { readonly entries?: unknown; readonly entriesPath?: string }
    }
    // The entries are read by the host on first query, not with every inventory build.
    expect(manifest.spec.entries).toBeUndefined()
    expect(manifest.spec.entriesPath).toBe('contributions/knowledge/schema-data.entries.json')
    const { entries } = JSON.parse(
      await readFile(new URL(manifest.spec.entriesPath ?? '', extensionRoot), 'utf8'),
    ) as { readonly entries: readonly KnowledgeEntry[] }
    const expected = STARCRAFT2_DATA_SCHEMAS.reduce(
      (count, schema) => count + schema.fields.length,
      0,
    )
    expect(entries).toHaveLength(expected)
    expect(new Set(entries.map(entry => knowledgeTargetKey(entry.target))).size).toBe(expected)
    expect(
      entries.every(
        entry =>
          entry.target.kind === 'field' &&
          entry.target.schema.revision === STARCRAFT2_DATA_SCHEMA_REVISION &&
          entry.sources.some(source => source.kind === 'schema') &&
          entry.sources.some(
            source =>
              source.kind === 'community-wiki' &&
              source.url === 'https://sc2mapster.wiki.gg/wiki/Data_Types',
          ),
      ),
    ).toBe(true)
    expect(entries.some(entry => entry.claimKind === 'documented-interpretation')).toBe(true)
    expect(entries.some(entry => entry.claimKind === 'schema-derived-fact')).toBe(true)
    const coverage = JSON.parse(await readFile(coverageUrl, 'utf8')) as {
      readonly fieldTargets: number
      readonly detailedInterpretations: number
      readonly schemaOnlyDescriptions: number
      readonly sourceBacked: number
      readonly missing: number
    }
    expect(coverage.fieldTargets).toBe(expected)
    expect(coverage.detailedInterpretations + coverage.schemaOnlyDescriptions).toBe(expected)
    expect(coverage.sourceBacked).toBe(expected)
    expect(coverage.missing).toBe(0)
  })

  it('routes inherited facts to the nearest declaring schema type', () => {
    expect(starcraft2DeclaringTypeForField('CAbilTrain', 'Name')).toBe('CAbil')
    expect(starcraft2DeclaringTypeForField('CAbilTrain', 'InfoArray')).toBe('CAbilTrain')
    expect(starcraft2DeclaringTypeForField('CAbilTrain', 'UnknownField')).toBe('CAbilTrain')
  })
})
