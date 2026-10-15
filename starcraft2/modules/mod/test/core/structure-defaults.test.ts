/**
 * Root-level structure defaults through the MK2 chain loader (`SC2ModReader`): a dependency's
 * `<SCost>` applies to its own and dependent mods' entities of the same catalog, and the resolved
 * `Cost` agrees with the MK3 resolved-data provider on the same files.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { FsReader, VirtualFileSystem } from '../../shared/workspace/vfs.js'
import { SC2ModReader } from '../../shared/core/reader.js'
import type { SC2Mod } from '../../shared/core/mod.js'
import { analyzeStarcraft2ResolvedData } from '../../../data/services/catalog/provider.js'
import { resolveDataCatalog } from '@modkit/sdk/data'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureUrl = (name: string) => `file:${FIXTURES.replace(/\\/g, '/')}/${name}`
const CHAIN_FILES = [
  'StructDefaultsBase/GameData/AbilData.xml',
  'StructDefaultsBase/GameData/BehaviorData.xml',
  'StructDefaultsPatch/GameData/AbilData.xml',
]

/**
 * Whether the @modkit/sdk resolver this test actually loads merges inherited structures deeply
 * (Core 6c1b112d). The vendored SDK predates it until its next release, and this Vitest config
 * does not apply core link-mode aliases, so probe the loaded resolver instead of the environment.
 */
const sdkMergesStructuresDeeply = (() => {
  const source = { rootId: 'probe', path: 'probe.xml', documentIndex: 0 }
  const snapshot = resolveDataCatalog({
    workspaceId: 'probe',
    gameId: 'probe',
    analyzerId: 'probe',
    schemas: [
      {
        typeId: 'CProbe',
        fields: [
          {
            fieldId: 'Struct',
            cardinality: 'scalar',
            fields: [
              { fieldId: 'Kept', cardinality: 'scalar' },
              { fieldId: 'Added', cardinality: 'scalar' },
            ],
          },
        ],
      },
    ],
    patches: [
      {
        namespace: 'Probe',
        typeId: 'CProbe',
        entityId: 'Parent',
        fields: { Struct: { Kept: 1 } },
        source,
      },
      {
        namespace: 'Probe',
        typeId: 'CProbe',
        entityId: 'Child',
        parentEntityId: 'Parent',
        fields: { Struct: { Added: 2 } },
        source,
      },
    ],
    queries: [],
    includeWorkspaceFacets: true,
    maxEntities: 8,
    maxDepth: 8,
  } as never) as { definitions?: { entityId: string; fields: Record<string, any> }[] }
  const child = snapshot.definitions?.find(item => item.entityId === 'Child')
  return child?.fields['Struct']?.Kept === 1
})()

type Json = null | string | number | boolean | Json[] | { [key: string]: Json }
const isRecord = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * One comparable shape for both catalog representations: MK3 positional slots
 * (`{index:'0', value}`) flatten without dropping the slot, one-element lists collapse like the MK2 XML parser collapses a
 * single element, and scalars compare as the strings the XML carried.
 */
function comparable(value: unknown): Json {
  if (Array.isArray(value)) {
    const items = value.map(comparable)
    return items.length === 1 ? items[0]! : items
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 2 && /^\d+$/u.test(String(value['index'])) && isRecord(value['value'])) {
      return comparable({ index: value['index'], ...value['value'] })
    }
    return Object.fromEntries(keys.sort().map(key => [key, comparable(value[key])]))
  }
  return value === undefined || value === null ? null : String(value)
}

// An unmerged raw singleton has no index attribute; the resolved API always spells out
// its positional slot. Keep explicit indices on both sides instead of discarding them.
function comparableCost(value: unknown): Json {
  let next = 0
  return comparable(
    [value].flat().map(item => {
      if (!isRecord(item)) return item
      const index = item['index'] ?? String(next)
      if (/^\d+$/u.test(String(index))) next = Number(index) + 1
      return { ...item, index }
    }),
  )
}

async function mk3Definitions() {
  const snapshot = await analyzeStarcraft2ResolvedData({
    workspaceId: 'workspace:mk2-structure-defaults',
    gameId: 'blizzard/starcraft-2',
    documents: CHAIN_FILES.map((file, index) => ({
      rootId: file.split('/')[0]!,
      path: file.replace(/^[^/]+/u, 'base.sc2data').replace('GameData', 'gamedata'),
      text: readFileSync(path.join(FIXTURES, file), 'utf8'),
      revision: `sha256:fixture-${index}`,
    })),
    localizationDocuments: [],
    locales: [],
    localizationKeys: [],
    queries: [],
    maxDocuments: 8,
    maxTextBytes: 1_048_576,
    maxEntities: 64,
    maxDepth: 64,
    plannedDocumentCount: CHAIN_FILES.length,
    unresolvedRequirementIds: [],
  })
  return (namespace: string, entityId: string) =>
    snapshot.definitions.find(
      (item: { namespace: string; entityId: string }) =>
        item.namespace === namespace && item.entityId === entityId,
    )?.fields as Record<string, unknown> | undefined
}

describe('SC2ModReader structure defaults', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const vfs = new VirtualFileSystem()
    vfs.register('file:', new FsReader())
    mod = await new SC2ModReader({ vfs }).read(fixtureUrl('StructDefaultsPatch'))
  })

  it('applies a dependency catalog default to entities of the dependent mod', () => {
    expect(mod.loadOrder.map(root => root.split('/').at(-1))).toEqual([
      'StructDefaultsBase',
      'StructDefaultsPatch',
    ])
    const recall = mod.getResolved('Abil', 'Recall') as Record<string, any>
    expect(recall['InterruptCost']).toEqual({
      Charge: { Link: 'Abil/Recall' },
      Cooldown: { Link: 'Abil/Recall' },
    })
    const elite = mod.getResolved('Abil', 'BlinkElite') as Record<string, any>
    expect([elite['Cost']].flat()[0]).toMatchObject({
      Charge: { Link: 'Abil/BlinkElite' },
      Cooldown: { Link: 'Abil/BlinkElite', TimeUse: '5' },
      Vital: { index: 'Energy', value: '50' },
    })
    expect(mod.getResolved('Behavior', 'Stim')).toMatchObject({
      Cost: { Charge: { Link: 'Behavior/Stim', Location: 'Behavior' } },
    })
  })

  it('resolves the same Cost as the MK3 resolved-data provider for a declared structure', async () => {
    const mk3 = await mk3Definitions()
    expect(comparableCost(mk3('Abil', 'Blink')?.['Cost'])).toEqual(
      comparableCost((mod.getResolved('Abil', 'Blink') as Record<string, unknown>)['Cost']),
    )
    expect(comparable(mk3('Abil', 'Recall')?.['InterruptCost'])).toEqual(
      comparable((mod.getResolved('Abil', 'Recall') as Record<string, unknown>)['InterruptCost']),
    )
  })

  // An inherited Cost needs the deep structured merge of @modkit/sdk (Core 6c1b112d).
  it.skipIf(!sdkMergesStructuresDeeply)(
    'resolves the same inherited Cost as the MK3 resolved-data provider',
    async () => {
      const mk3 = await mk3Definitions()
      expect(comparableCost(mk3('Abil', 'BlinkElite')?.['Cost'])).toEqual(
        comparableCost((mod.getResolved('Abil', 'BlinkElite') as Record<string, unknown>)['Cost']),
      )
    },
  )
})
