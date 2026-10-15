import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createSpecSchemaRegistry, validateContributionManifest } from '@modkit/sdk'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  KNOWLEDGE_PACK_CONTRIBUTION_CONTRACT,
  knowledgeTargetKey,
  type ContributionManifestV1Wire,
  type KnowledgePackSpecV1Wire,
} from '@modkit/sdk'
import { STARCRAFT2_DATA_SCHEMA_REVISION } from '../modules/data/services/catalog/provider.js'

const manifestUrl = new URL('../contributions/knowledge-data.json', import.meta.url)

describe('StarCraft II knowledge pack', () => {
  it('is data-only, schema-bound and keeps SC2Mapster links separate from licenses', async () => {
    const manifest = JSON.parse(
      await readFile(manifestUrl, 'utf8'),
    ) as ContributionManifestV1Wire<KnowledgePackSpecV1Wire>
    expect(manifest.contract.id).toBe(KNOWLEDGE_PACK_CONTRIBUTION_CONTRACT)
    const result = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(result.specState, JSON.stringify(result.diagnostics)).toBe('validated')
    expect(result.inventoryEligible).toBe(true)
    expect(result.activationEligible).toBe(false)
    expect(manifest.spec.entries).toHaveLength(28)
    expect(new Set(manifest.spec.entries.map(entry => knowledgeTargetKey(entry.target))).size).toBe(
      manifest.spec.entries.length,
    )
    for (const entry of manifest.spec.entries) {
      if (entry.target.kind === 'field') {
        expect(entry.target.schema.revision).toBe(STARCRAFT2_DATA_SCHEMA_REVISION)
      }
      const community = entry.sources.find(source => source.kind === 'community-wiki')
      expect(community?.url).toMatch(/^https:\/\/sc2mapster\.wiki\.gg\/wiki\/Data/u)
      expect(community?.license).toBeUndefined()
      expect(entry.summary.length).toBeLessThanOrEqual(1024)
    }
  })
})
