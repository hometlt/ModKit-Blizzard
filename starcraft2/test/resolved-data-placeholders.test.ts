import { describe, expect, it } from 'vitest'
import { analyzeStarcraft2ResolvedData } from '../modules/data/services/catalog/provider.js'
import { openStarcraft2DataSource } from '../modules/data/services/projections/data-sources.js'

function request(documents: readonly { rootId: string; path: string; text: string }[]) {
  return {
    workspaceId: 'workspace:resolved-placeholders',
    gameId: 'blizzard/starcraft-2',
    documents,
    localizationDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 8,
    maxTextBytes: 1_048_576,
    maxEntities: 2_048,
    maxDepth: 64,
    plannedDocumentCount: documents.length,
    unresolvedRequirementIds: [],
  }
}

const document = (rootId: string, path: string, text: string) => ({ rootId, path, text })

describe('SC2 resolved template relations', () => {
  it('resolves the built-in id token and excludes unresolved templates from concrete edges', async () => {
    const snapshot = await analyzeStarcraft2ResolvedData(
      request([
        document(
          'core',
          'mods/core.sc2mod/base.sc2data/gamedata/sc2data.xml',
          `<Catalog>
            <CTalent id="CommanderDefaultSettings" default="1"><Face value="##id##"/></CTalent>
            <CTalent id="GenericTemplate" default="1"><Face value="##FaceToken##"/></CTalent>
            <CButton id="TalentOne"/>
          </Catalog>`,
        ),
        document(
          'liberty',
          'mods/liberty.sc2mod/base.sc2data/gamedata/talentdata.xml',
          `<Catalog>
            <CTalent id="TalentOne" parent="CommanderDefaultSettings"/>
            <CTalent id="GenericChild" parent="GenericTemplate"/>
          </Catalog>`,
        ),
      ]),
    )

    expect(snapshot.complete).toBe(true)
    expect(
      snapshot.definitions.find(
        entity => entity.namespace === 'Talent' && entity.entityId === 'TalentOne',
      )?.fields,
    ).toMatchObject({ Face: 'TalentOne' })
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        from: { namespace: 'Talent', entityId: 'TalentOne' },
        to: { namespace: 'Button', entityId: 'TalentOne' },
        role: 'Face',
        dead: false,
      }),
    )
    expect(snapshot.relations.some(relation => /##|\$[A-Za-z_]/u.test(relation.to.entityId))).toBe(
      false,
    )
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'information',
        code: 'blizzard.starcraft2/data-template-relations-deferred',
      }),
    )

    const lease = openStarcraft2DataSource(snapshot, 'relations', 32)
    try {
      await expect(lease.value.summary()).resolves.toMatchObject({ completeness: 'complete' })
      // A node opens its entity's card, under the id cards link by (parity plan 5.20); every
      // namespace has a card.
      const nodes = (await lease.value.nodes({ limit: 32 })).items
      expect(nodes.find(node => node.id === 'Button/TalentOne')?.subject).toBe('Button/TalentOne')
      expect(nodes.find(node => node.id === 'Talent/CommanderDefaultSettings')?.subject).toBe(
        'Talent/CommanderDefaultSettings',
      )
    } finally {
      await lease.release()
    }
  })

  it('keeps real missing parents and concrete link targets visible as completeness failures', async () => {
    const snapshot = await analyzeStarcraft2ResolvedData(
      request([
        document(
          'fixture',
          'mods/fixture.sc2mod/base.sc2data/gamedata/talentdata.xml',
          `<Catalog>
            <CTalent id="BrokenInheritance" parent="ActuallyMissing"/>
            <CTalent id="BrokenLink"><Face value="MissingButton"/></CTalent>
          </Catalog>`,
        ),
      ]),
    )

    expect(snapshot.complete).toBe(false)
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'common.data/entity-parent-unavailable',
        entityId: 'BrokenInheritance',
      }),
    )
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        from: { namespace: 'Talent', entityId: 'BrokenLink' },
        to: { namespace: 'Button', entityId: 'MissingButton' },
        dead: true,
      }),
    )

    const lease = openStarcraft2DataSource(snapshot, 'relations', 32)
    try {
      await expect(lease.value.summary()).resolves.toMatchObject({ completeness: 'partial' })
    } finally {
      await lease.release()
    }
  })
})
