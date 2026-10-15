import { describe, expect, it } from 'vitest'
import { createProvider } from '../services/catalog/provider.js'
import { analyzeStarcraft2GraphIsolation } from '../services/editing/graph-isolation.js'

const definition = (namespace: string, entityId: string) => ({ namespace, entityId })
const relation = (fromId: string, toId: string, role: string, dead = false) => ({
  from: { namespace: 'Unit', entityId: fromId },
  to: { namespace: 'Weapon', entityId: toId },
  role,
  dead,
})

const request = {
  schemaVersion: 1,
  owner: { namespace: 'Unit', entityId: 'Marine' },
  target: { namespace: 'Weapon', entityId: 'GaussRifle' },
  ownerFieldPath: ['WeaponArray', '0', 'Link'],
  maxEdges: 32,
} as const

describe('SC2 graph isolation impact', () => {
  it('detects a shared weapon and selects only the exact unit field', () => {
    const result = analyzeStarcraft2GraphIsolation(
      {
        definitions: [
          definition('Unit', 'Marine'),
          definition('Unit', 'Marauder'),
          definition('Weapon', 'GaussRifle'),
        ],
        relations: [
          relation('Marine', 'GaussRifle', 'WeaponArray.0.Link'),
          relation('Marine', 'GaussRifle', 'WeaponArray.1.Link'),
          relation('Marauder', 'GaussRifle', 'WeaponArray.0.Link'),
        ],
        complete: true,
      },
      request,
    )
    expect(result).toMatchObject({
      schemaVersion: 1,
      state: 'ready',
      shared: true,
      cloneRequired: true,
      otherReferrers: [{ namespace: 'Unit', entityId: 'Marauder' }],
      ownerFieldPath: ['WeaponArray', '0', 'Link'],
    })
    expect(result.rewireFieldPaths).toEqual([['WeaponArray', '0', 'Link']])
  })

  it('does not claim safety for partial dependency graphs', () => {
    const result = analyzeStarcraft2GraphIsolation(
      {
        definitions: [definition('Unit', 'Marine'), definition('Weapon', 'GaussRifle')],
        relations: [relation('Marine', 'GaussRifle', 'WeaponArray.0.Link')],
        complete: false,
      },
      request,
    )
    expect(result).toMatchObject({
      state: 'unavailable',
      cloneRequired: false,
      reason: expect.stringContaining('incomplete'),
    })
  })

  it('refuses a guessed path and a dead typed relation', () => {
    const snapshot = {
      definitions: [definition('Unit', 'Marine'), definition('Weapon', 'GaussRifle')],
      relations: [relation('Marine', 'GaussRifle', 'WeaponArray.0.Link')],
      complete: true,
    }
    expect(
      analyzeStarcraft2GraphIsolation(snapshot, {
        ...request,
        ownerFieldPath: ['WeaponArray', '1', 'Link'],
      }),
    ).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('no selected') })
    expect(
      analyzeStarcraft2GraphIsolation(
        { ...snapshot, relations: [relation('Marine', 'GaussRifle', 'WeaponArray.0.Link', true)] },
        request,
      ),
    ).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('no selected') })
  })

  it('is exposed by the resolved workspace over its pinned schema-derived graph', async () => {
    const lease = createProvider({ contract: 'common.data/resolved-workspace', major: 1 })
    const service = lease.value as any
    const workspace = {
      schemaVersion: 1,
      workspaceId: 'graph-provider',
      gameId: 'blizzard/starcraft-2',
      activeRootId: 'D',
      sources: [{ sourceId: 'source-D', kind: 'directory', location: 'D.SC2Mod' }],
      loadOrder: [
        {
          rootId: 'D',
          sourceId: 'source-D',
          sourcePath: 'D.SC2Mod',
          displayName: 'D',
          kind: 'mod',
          dependencies: [],
        },
      ],
      dependencyOrder: [],
      logicalRoots: [
        {
          rootId: 'D',
          sourceId: 'source-D',
          sourcePath: 'D.SC2Mod',
          displayName: 'D',
          kind: 'mod',
          dependencies: [],
        },
      ],
      diagnostics: [],
      complete: true,
    }
    await service.plan({ workspace, locales: ['enUS'], maxRequirements: 1_000 })
    const text = [
      '<Catalog>',
      '  <CUnit id="Marine"><WeaponArray index="0" Link="GaussRifle"/></CUnit>',
      '  <CUnit id="Marauder"><WeaponArray index="0" Link="GaussRifle"/></CUnit>',
      '  <CWeaponLegacy id="GaussRifle"><DisplayEffect value="GaussDamage"/></CWeaponLegacy>',
      '  <CWeaponLegacy id="MarauderWeapon"><DisplayEffect value="GaussDamage"/></CWeaponLegacy>',
      '  <CEffectDamage id="GaussDamage"><Amount value="6"/></CEffectDamage>',
      '</Catalog>',
    ].join('\n')
    const snapshot = await service.analyze({
      workspaceId: workspace.workspaceId,
      gameId: workspace.gameId,
      documents: [
        {
          rootId: 'D',
          path: 'd.sc2mod/base.sc2data/gamedata/unitdata.xml',
          text,
          revision: 'revision:D',
        },
      ],
      localizationDocuments: [],
      locales: ['enUS'],
      localizationKeys: [],
      queries: [],
      maxDocuments: 8,
      maxTextBytes: 1_000_000,
      maxEntities: 100,
      maxDepth: 16,
      plannedDocumentCount: 1,
      unresolvedRequirementIds: [],
    })
    try {
      const result = await service.analyzeIsolation({ ...request, snapshotId: snapshot.snapshotId })
      expect(result).toMatchObject({
        state: 'ready',
        shared: true,
        cloneRequired: true,
        otherReferrers: [{ namespace: 'Unit', entityId: 'Marauder' }],
      })
      const planned = await service.planIsolation({
        ...request,
        snapshotId: snapshot.snapshotId,
        selectedRootId: 'D',
        writableRootIds: ['D'],
        cloneEntityId: 'MarineGaussRifle',
      })
      expect(planned).toMatchObject({
        schemaVersion: 1,
        state: 'planned',
        clone: { namespace: 'Weapon', entityId: 'MarineGaussRifle' },
        replacements: [{ purpose: 'clone-and-rewire' }],
      })
      const replacement = planned.replacements[0].replacementText
      expect(replacement).toContain(
        '<CUnit id="Marine"><WeaponArray index="0" Link="MarineGaussRifle"/></CUnit>',
      )
      expect(replacement).toContain(
        '<CUnit id="Marauder"><WeaponArray index="0" Link="GaussRifle"/></CUnit>',
      )
      expect(replacement).toContain('<CWeaponLegacy id="MarineGaussRifle">')
      expect(replacement).toContain('<DisplayEffect value="GaussDamage"/>')
      const effectPlan = await service.planIsolation({
        schemaVersion: 1,
        snapshotId: snapshot.snapshotId,
        selectedRootId: 'D',
        writableRootIds: ['D'],
        owner: { namespace: 'Weapon', entityId: 'GaussRifle' },
        target: { namespace: 'Effect', entityId: 'GaussDamage' },
        ownerFieldPath: ['DisplayEffect'],
        maxEdges: 32,
        cloneEntityId: 'MarineGaussDamage',
      })
      expect(effectPlan).toMatchObject({
        schemaVersion: 1,
        state: 'planned',
        analysis: {
          shared: true,
          otherReferrers: [{ namespace: 'Weapon', entityId: 'MarauderWeapon' }],
        },
        clone: { namespace: 'Effect', entityId: 'MarineGaussDamage' },
      })
      const effectReplacement = effectPlan.replacements[0].replacementText
      expect(effectReplacement).toContain(
        '<CWeaponLegacy id="GaussRifle"><DisplayEffect value="MarineGaussDamage"/></CWeaponLegacy>',
      )
      expect(effectReplacement).toContain(
        '<CWeaponLegacy id="MarauderWeapon"><DisplayEffect value="GaussDamage"/></CWeaponLegacy>',
      )
      expect(effectReplacement).toContain('<CEffectDamage id="MarineGaussDamage">')
      await expect(
        service.analyzeIsolation({ ...request, snapshotId: 'stale' }),
      ).rejects.toThrow(/stale, unknown or evicted/u)
    } finally {
      await lease.release()
    }
  })
})
