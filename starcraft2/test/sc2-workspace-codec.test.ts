import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  createSc2DirectoryDefinition,
  detectSc2CampaignDirectoryMarkers,
  detectSc2MapDirectoryMarkers,
  detectSc2ModDirectoryMarkers,
} from '../shared/package-namespace/runtime.js'
import {
  campaignOperations,
  extendCampaignInspection,
} from '../modules/campaign/services/workspace.js'
import { sc2BuiltinDocumentInfo } from '../modules/mod/shared/workspace/implicit-dependencies.js'

const encoder = new TextEncoder()

function fixtureNamespace(files: Readonly<Record<string, string>>) {
  const encoded = new Map(
    Object.entries(files).map(([path, value]) => [path, encoder.encode(value)]),
  )
  const directories = new Set<string>()
  for (const path of encoded.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'))
    }
  }
  const children = (parent: string) => {
    const prefix = parent === '' ? '' : `${parent}/`
    const values = new Map<string, { path: string; kind: 'file' | 'directory'; size?: bigint }>()
    for (const path of directories) {
      if (!path.startsWith(prefix)) continue
      const remainder = path.slice(prefix.length)
      if (remainder.includes('/')) continue
      values.set(path, { path, kind: 'directory' })
    }
    for (const [path, bytes] of encoded) {
      if (!path.startsWith(prefix)) continue
      const remainder = path.slice(prefix.length)
      if (remainder.includes('/')) continue
      values.set(path, { path, kind: 'file', size: BigInt(bytes.byteLength) })
    }
    return [...values.values()].sort((left, right) => left.path.localeCompare(right.path))
  }
  return Object.freeze({
    revision: 'content-hash.sha256:sc2-workspace-fixture',
    async *list(path: string) {
      yield* children(path)
    },
    async open(path: string) {
      if (directories.has(path)) {
        return {
          value: { kind: 'namespace' as const },
          release: async () => undefined,
        }
      }
      const bytes = encoded.get(path)
      if (bytes === undefined) {
        const error = Object.assign(new Error(`missing ${path}`), {
          code: 'x3.host/namespace-entry-not-found',
        })
        throw error
      }
      return {
        value: {
          kind: 'bytes' as const,
          ref: Object.freeze({ id: `entry:${path}`, uri: `memory://fixture?entry=${encodeURIComponent(path)}` }),
          revision: `content-hash.sha256:${encodeURIComponent(path)}`,
          size: BigInt(bytes.byteLength),
          async read(offset: bigint, length: number) {
            return bytes.slice(Number(offset), Number(offset) + length)
          },
        },
        release: async () => undefined,
      }
    },
  })
}

const budget = Object.freeze({
  maxInputBytes: 1_073_741_824n,
  maxDepth: 128,
  maxNodes: 100_000,
  maxScalarBytes: 134_217_728n,
  maxDiagnostics: 1_000,
})

function context(namespace: ReturnType<typeof fixtureNamespace>) {
  return {
    budget,
    intent: 'inspect' as const,
    namespace,
    input: {
      root: { id: 'sc2-workspace', uri: 'memory://fixture.SC2Map' },
      revisions: {
        namespaceRevision: namespace.revision,
        revision: namespace.revision,
      },
    },
  }
}

describe('loose StarCraft II workspace codecs', () => {
  it('admits the minimal map terrain marker within the namespace probe budget', () => {
    const manifest = JSON.parse(readFileSync(new URL('../modules/map/codecs/package-directory/codec.json', import.meta.url), 'utf8'))
    const probe = manifest.spec.probe
    expect(probe.kind).toBe('namespace')
    expect(probe.markers).toContain('t3Terrain.xml')
    expect(probe.markers.length).toBeLessThanOrEqual(probe.maxEntries)
  })

  it('keeps map and mod structural detection disjoint', async () => {
    const mapMarkers = [
      { path: 'Objects', kind: 'file' as const },
      { path: 'Regions', kind: 'file' as const },
      { path: 't3HeightMap', kind: 'file' as const },
    ]
    await expect(detectSc2MapDirectoryMarkers(mapMarkers)).resolves.toMatchObject({
      confidence: 0.999,
    })
    await expect(
      detectSc2MapDirectoryMarkers([
        { path: 'MapInfo', kind: 'file' },
        { path: 'Objects', kind: 'file' },
        { path: 't3HeightMap', kind: 'file' },
      ]),
    ).resolves.toMatchObject({ confidence: 0.999 })
    await expect(
      detectSc2MapDirectoryMarkers([
        { path: 'MapInfo', kind: 'file' },
        { path: 'MapObjects', kind: 'file' },
        { path: 'MapHeightMap', kind: 'file' },
      ]),
    ).resolves.toMatchObject({ confidence: 0.999 })
    const minimalRoadMap = [
      { path: 'MapInfo', kind: 'file' as const },
      { path: 't3HeightMap', kind: 'file' as const },
      { path: 't3Terrain.xml', kind: 'file' as const },
    ]
    await expect(detectSc2MapDirectoryMarkers(minimalRoadMap)).resolves.toMatchObject({ confidence: 0.999 })
    await expect(detectSc2ModDirectoryMarkers(minimalRoadMap)).resolves.toMatchObject({ confidence: 0, note: 'loose-sc2-map-not-mod' })
    await expect(detectSc2CampaignDirectoryMarkers(minimalRoadMap)).resolves.toMatchObject({ confidence: 0, note: 'loose-sc2-map-not-campaign' })
    for (const missing of ['MapInfo', 't3HeightMap', 't3Terrain.xml']) {
      await expect(detectSc2MapDirectoryMarkers(minimalRoadMap.filter(marker => marker.path !== missing))).resolves.toMatchObject({ confidence: 0 })
    }
    await expect(detectSc2MapDirectoryMarkers([
      { path: 'ComponentList.SC2Components', kind: 'file' },
      { path: 'Base.SC2Maps', kind: 'directory' },
    ])).resolves.toMatchObject({ confidence: 0 })
    await expect(detectSc2MapDirectoryMarkers([
      { path: 'DocumentInfo', kind: 'file' },
      { path: 'Base.SC2Data', kind: 'directory' },
    ])).resolves.toMatchObject({ confidence: 0 })
    for (const markers of [
      [
        { path: 'MapInfo', kind: 'file' as const },
        { path: 't3HeightMap', kind: 'file' as const },
      ],
      [
        { path: 'MapInfo', kind: 'file' as const },
        { path: 'Objects', kind: 'file' as const },
      ],
      [
        { path: 'Objects', kind: 'file' as const },
        { path: 't3HeightMap', kind: 'file' as const },
      ],
      [
        { path: 'MapInfo', kind: 'directory' as const },
        { path: 'Objects', kind: 'file' as const },
        { path: 't3HeightMap', kind: 'file' as const },
      ],
    ]) {
      await expect(detectSc2MapDirectoryMarkers(markers)).resolves.toMatchObject({
        confidence: 0,
      })
    }
    await expect(
      detectSc2ModDirectoryMarkers([
        { path: 'ComponentList.SC2Components', kind: 'file' },
        { path: 'Base.SC2Data', kind: 'directory' },
        ...mapMarkers,
      ]),
    ).resolves.toMatchObject({ confidence: 0, note: 'loose-sc2-map-not-mod' })
    await expect(
      detectSc2ModDirectoryMarkers([
        { path: 'ComponentList.SC2Components', kind: 'file' },
        { path: 'Base.SC2Assets', kind: 'directory' },
      ]),
    ).resolves.toMatchObject({ confidence: 0.997 })
    /*
     * A localization-only mod ships `enUS.SC2Data` and nothing a fixed marker list can name — the
     * host hands `detect` only the markers the manifest declares — so the component list, which is
     * the mod's own manifest of what the game loads, decides on its own.
     */
    await expect(
      detectSc2ModDirectoryMarkers([
        { path: 'ComponentList.SC2Components', kind: 'file' },
        { path: 'DocumentInfo', kind: 'file' },
      ]),
    ).resolves.toMatchObject({ confidence: 0.95, note: 'loose-sc2-mod-components-only' })
    await expect(
      detectSc2ModDirectoryMarkers([{ path: 'DocumentInfo', kind: 'file' }]),
    ).resolves.toMatchObject({ confidence: 0, note: 'loose-sc2-mod-markers-missing' })
    const campaignMarkers = [
      { path: 'ComponentList.SC2Components', kind: 'file' as const },
      { path: 'Base.SC2Maps', kind: 'directory' as const },
    ]
    await expect(detectSc2CampaignDirectoryMarkers(campaignMarkers)).resolves.toMatchObject({
      confidence: 0.998,
    })
    await expect(detectSc2ModDirectoryMarkers(campaignMarkers)).resolves.toMatchObject({
      confidence: 0,
      note: 'loose-sc2-campaign-not-mod',
    })
  })

  it('publishes a bounded loose-map namespace, package card and extraction', async () => {
    const namespace = fixtureNamespace({
      MapInfo: '<MapInfo/>',
      Objects: '<PlacedObjects/>',
      Regions: '<Regions/>',
      t3HeightMap: 'height',
      'Base.SC2Data/GameData/UnitData.xml': '<Catalog/>',
      'MapScript.galaxy': 'void main() {}',
      DocumentInfo:
        '<DocInfo><Dependencies><Value>file:Mods/Liberty.SC2Mod</Value><Value>file:Mods/TibData.SC2Mod</Value></Dependencies></DocInfo>',
    })
    const definition = createSc2DirectoryDefinition({
      id: 'blizzard/sc2-map-directory',
      kind: 'map',
    })
    const inspected = await definition.namespace.inspect(
      namespace as never,
      context(namespace) as never,
    )
    expect(inspected.summary).toMatchObject({
      format: 'sc2-map-directory',
      topology: 'mounted-directory',
      packageKind: 'map',
      gameDataEntries: 1,
      scripts: 1,
      dependencies: ['Mods/Liberty.SC2Mod', 'Mods/TibData.SC2Mod'],
    })
    const facts = inspected.dataSources?.['common.view/subject-facts-source'] as {
      summary(): Promise<{ identity: { kind: string }; relationCount: number }>
    }
    await expect(facts.summary()).resolves.toMatchObject({
      identity: { kind: 'map' },
      relationCount: 2,
    })
    const namespaceSource = inspected.dataSources?.['common.view/namespace-entry-source'] as {
      list(prefix: string, page: { limit: number }): Promise<{ items: { path: string }[] }>
    }
    await expect(namespaceSource.list('', { limit: 20 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ path: 'Base.SC2Data/GameData/UnitData.xml' }),
        expect.objectContaining({ path: 'MapScript.galaxy' }),
      ]),
    })
    const extracted = await inspected.handlers?.['extract-entry']({ entryId: 'Objects' })
    expect(extracted).toMatchObject({ kind: 'bytes' })
    if (extracted?.kind !== 'bytes') throw new Error('Objects was not extracted')
    expect(new TextDecoder().decode(extracted.value)).toBe('<PlacedObjects/>')
  })

  it('reads package BankList and bank files and relates exact Galaxy BankLoad calls', async () => {
    const namespace = fixtureNamespace({
      MapInfo: '<MapInfo/>',
      Objects: '<PlacedObjects/>',
      Regions: '<Regions/>',
      t3HeightMap: 'height',
      'BankList.xml':
        '<BankList><Bank Name="Progress" Player="1"/><Bank Name="External"/></BankList>',
      'Banks/Progress.SC2Bank':
        '<Bank version="1"><Section name="Stats"><Key name="Wins"><Value int="9"/></Key></Section></Bank>',
      'MapScript.galaxy': `void Init() {
        bank progress = BankLoad("Progress", 1);
        bank dynamic = BankLoad(bankName, 2);
      }`,
    })
    const definition = createSc2DirectoryDefinition({
      id: 'blizzard/sc2-map-directory',
      kind: 'map',
    })
    const inspected = await definition.namespace.inspect(
      namespace as never,
      context(namespace) as never,
    )
    expect(inspected.summary).toMatchObject({
      bankLists: 1,
      declaredBanks: 2,
      bankFiles: 1,
      parsedBankFiles: 1,
      bankSections: 1,
      bankKeys: 1,
      bankNames: ['External', 'Progress'],
      galaxyBankLoads: 1,
      dynamicGalaxyBankLoads: 1,
    })

    const facts = inspected.dataSources?.['common.view/subject-facts-source'] as {
      groups(page: { limit: number }): Promise<{ items: { id: string }[] }>
      facts(
        group: string,
        page: { limit: number },
      ): Promise<{ items: { id: string; value: unknown }[] }>
    }
    await expect(facts.groups({ limit: 10 })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: 'banks' })]),
    })
    await expect(facts.facts('banks', { limit: 20 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'bank-keys', value: 1 }),
        expect.objectContaining({ id: 'galaxy-bank-loads', value: 1 }),
      ]),
    })

    const graph = inspected.dataSources?.['common.view/relation-graph-source'] as {
      summary(): Promise<{ completeness: string; totalNodes: number; totalEdges: number }>
      nodes(page: { limit: number }): Promise<{ items: { label: string; type: string }[] }>
      edges(page: { limit: number }): Promise<{ items: { role?: string }[] }>
    }
    await expect(graph.summary()).resolves.toMatchObject({
      completeness: 'partial',
      totalNodes: 8,
      totalEdges: 9,
    })
    await expect(graph.nodes({ limit: 20 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ label: 'Stats', type: 'sc2-bank-section' }),
        expect.objectContaining({ label: 'Wins', type: 'sc2-bank-key' }),
        expect.objectContaining({ label: 'MapScript.galaxy', type: 'galaxy-script' }),
      ]),
    })
    await expect(graph.edges({ limit: 20 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ role: 'declares-bank' }),
        expect.objectContaining({ role: 'loads-bank' }),
        expect.objectContaining({ role: 'contains-section' }),
        expect.objectContaining({ role: 'contains-key' }),
      ]),
    })
    const table = inspected.dataSources?.['common.view/table-data-source'] as {
      shape(): Promise<{ rows: number; columns: number }>
    }
    await expect(table.shape()).resolves.toEqual(expect.objectContaining({ rows: 1, columns: 6 }))
    expect(inspected.unsupportedFeatures).toContain('bank-and-bank-list-writeback-not-advertised')
  })

  it('publishes a loose campaign package without confusing it with a mod', async () => {
    const namespace = fixtureNamespace({
      'ComponentList.SC2Components': '<Components/>',
      DocumentInfo: '<DocInfo><Dependencies/></DocInfo>',
      'Base.SC2Data/GameData/CampaignData.xml': [
        '<Catalog>',
        '  <CCampaign id="Story">',
        '    <CampaignData><LaunchMap value="Maps/Story.SC2Map"/></CampaignData>',
        '  </CCampaign>',
        '</Catalog>',
      ].join('\n'),
      'Base.SC2Maps/Maps/Story.SC2Map/MapInfo': '<MapInfo/>',
      'Base.SC2Maps/Maps/Story.SC2Map/Objects': '<PlacedObjects/>',
      'Base.SC2Maps/Maps/Story.SC2Map/Regions': '<Regions/>',
      'Base.SC2Maps/Maps/Story.SC2Map/t3HeightMap': 'height',
    })
    const definition = createSc2DirectoryDefinition({
      id: 'blizzard/sc2-campaign-directory',
      kind: 'campaign',
      virtualDocumentInfo: sc2BuiltinDocumentInfo,
      operations: campaignOperations('blizzard/sc2-campaign-directory'),
      extendInspection: extendCampaignInspection,
    })
    const inspected = await definition.namespace.inspect(
      namespace as never,
      context(namespace) as never,
    )
    expect(inspected.summary).toMatchObject({
      format: 'sc2-campaign-directory',
      topology: 'mounted-directory',
      packageKind: 'campaign',
      mapDocuments: expect.arrayContaining([
        'base.sc2maps/maps/story.sc2map/objects',
        'base.sc2maps/maps/story.sc2map/regions',
      ]),
      campaignMissions: 1,
      campaignProgression: 'partial',
    })
    const missions = await inspected.handlers?.['inspect-missions']({})
    expect(missions).toMatchObject({
      kind: 'json',
      value: {
        schemaVersion: 1,
        missions: [{ label: 'Story', topology: 'directory' }],
        catalog: {
          campaigns: [{ id: 'Story', launchMaps: [{ missionId: expect.any(String) }] }],
        },
      },
    })
    expect(inspected.handlers?.['edit-campaign-data']).toBeUndefined()
    const facts = inspected.dataSources?.['common.view/subject-facts-source'] as {
      groups(page: { limit: number }): Promise<{ items: { id: string }[] }>
    }
    await expect(facts.groups({ limit: 10 })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: 'campaign' })]),
    })
  })

  it('opens an installed Story campaign without authored manifests and publishes its engine chain', async () => {
    const namespace = fixtureNamespace({
      'Base.SC2Data/GameData/CampaignData.xml': '<Catalog/>',
    })
    const definition = createSc2DirectoryDefinition({
      id: 'blizzard/sc2-campaign-directory',
      kind: 'campaign',
      virtualDocumentInfo: sc2BuiltinDocumentInfo,
      operations: campaignOperations('blizzard/sc2-campaign-directory'),
      extendInspection: extendCampaignInspection,
    })
    await expect(
      definition.namespace.detect(
        [{ path: 'Base.SC2Data', kind: 'directory' }],
        'modkit-container:/c:/Apps/StarCraft%20II!/Campaigns/VoidStory.SC2Campaign',
      ),
    ).resolves.toMatchObject({ confidence: 0.96, note: 'installed-sc2-campaign-data' })
    const inspected = await definition.namespace.inspect(
      namespace as never,
      {
        ...context(namespace),
        input: {
          ...context(namespace).input,
          root: {
            id: 'void-story',
            uri: 'modkit-container:/c:/Apps/StarCraft%20II!/Campaigns/VoidStory.SC2Campaign',
          },
        },
      } as never,
    )
    expect(inspected.summary).toMatchObject({
      dependencies: ['Campaigns/Void.SC2Campaign'],
    })
    const namespaceSource = inspected.dataSources?.['common.view/namespace-entry-source'] as {
      list(prefix: string, page: { limit: number }): Promise<{ items: { path: string }[] }>
    }
    await expect(namespaceSource.list('', { limit: 20 })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ path: 'DocumentInfo' })]),
    })
    const extracted = await inspected.handlers?.['extract-entry']({ entryId: 'DocumentInfo' })
    expect(extracted).toMatchObject({ kind: 'bytes' })
    if (extracted?.kind !== 'bytes') throw new Error('virtual DocumentInfo was not extracted')
    expect(new TextDecoder().decode(extracted.value)).toContain(
      '<Value>file:Campaigns/Void.SC2Campaign</Value>',
    )
  })
})
