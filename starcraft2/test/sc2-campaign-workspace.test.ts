import { describe, expect, it } from 'vitest'
import {
  CAMPAIGN_OPERATIONS,
  declareCampaignDataText,
  extendCampaignInspection,
  patchCampaignDataText,
} from '../modules/campaign/services/workspace.js'

describe('SC2 campaign workspace projection', () => {
  it('projects mission packages and shared mod roles without inventing progression', async () => {
    const root = Object.freeze({ id: 'campaign:test', uri: 'memory://Story.SC2Campaign' })
    const extension = await extendCampaignInspection({
      entries: [
        { path: 'ComponentList.SC2Components', kind: 'file' },
        { path: 'Campaign.SC2Mod/Base.SC2Data/GameData/UnitData.xml', kind: 'file' },
        { path: 'SharedRules.SC2Mod/DocumentInfo', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Opening.SC2Map', kind: 'directory' },
        { path: 'Base.SC2Maps/Maps/Opening.SC2Map/MapInfo', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Opening.SC2Map/Objects', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Opening.SC2Map/Regions', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Opening.SC2Map/t3HeightMap', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Finale.SC2Map', kind: 'file' },
      ],
      root,
      revision: 'content-hash.sha256:campaign',
      context: {},
      bankSemantic: {
        nodes: [Object.freeze({ id: root.id, label: 'Story', type: 'sc2-campaign-package' })],
        edges: [],
      },
    } as never)

    expect(extension.summary).toEqual({
      campaignMissions: 2,
      campaignSharedLayers: 2,
      campaignProgression: 'unresolved',
    })
    const operation = await extension.handlers['inspect-missions']()
    expect(operation).toMatchObject({
      kind: 'json',
      value: {
        schemaVersion: 1,
        missions: [
          { label: 'Finale', topology: 'packed' },
          { label: 'Opening', topology: 'directory', documents: {
            mapInfo: true, objects: true, regions: true, height: true,
          } },
        ],
        sharedLayers: [
          { label: 'Campaign', role: 'campaign-data' },
          { label: 'SharedRules', role: 'shared-layer' },
        ],
        progression: { state: 'unresolved' },
      },
    })
    const table = extension.dataSources['common.view/table-data-source']
    await expect(table.shape()).resolves.toMatchObject({ rows: 2, columns: 8 })
    const graph = extension.dataSources['common.view/relation-graph-source']
    await expect(graph.summary()).resolves.toMatchObject({
      totalNodes: 5,
      totalEdges: 4,
      completeness: 'partial',
    })
    expect(extension.treeNodes[0].children).toHaveLength(2)
    expect(extension.treeNodes[1].children).toHaveLength(2)
    expect(extension.factGroups[0].facts).toHaveLength(5)
    expect(extension.factRelations.map(item => item.role)).toEqual([
      'contains-mission', 'contains-mission', 'campaign-data', 'shared-layer',
    ])
    expect(CAMPAIGN_OPERATIONS).toEqual([expect.objectContaining({
      id: 'blizzard/sc2-campaign.inspect-missions',
      handlerId: 'inspect-missions',
    })])
  })

  it('projects native CCampaign launch maps, banks, achievements, and prerequisites', async () => {
    const root = Object.freeze({ id: 'campaign:catalog', uri: 'memory://Catalog.SC2Campaign' })
    const campaignData = new TextEncoder().encode([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Catalog>',
      '  <CCampaign id="Alpha">',
      '    <!-- unknown authored content must survive scalar edits -->',
      '    <Name value="Campaign/Name/Alpha"/>',
      '    <CampaignData>',
      '      <LaunchMap value="Maps/Campaign/Opening.SC2Map"/>',
      '      <CampaignBanks value="AlphaProgress"/>',
      '      <TransitionBanks value="AlphaTransition"/>',
      '      <ProgressAchievement value="AlphaComplete"/>',
      '    </CampaignData>',
      '  </CCampaign>',
      '  <CCampaign id="Beta" parent="Alpha">',
      '    <CampaignData>',
      '      <ProgressLaunchMap value="Finale"/>',
      '      <PrerequisiteCampaignId value="Alpha"/>',
      '      <SaveName value="BetaSave"/>',
      '      <CompletedSaveName value="BetaComplete"/>',
      '    </CampaignData>',
      '  </CCampaign>',
      '</Catalog>',
    ].join('\n'))
    const namespaceSource = {
      kind: 'bytes' as const,
      ref: Object.freeze({
        id: 'campaign-data-entry',
        uri: 'memory://Catalog.SC2Campaign?entry=CampaignData.xml',
      }),
      revision: 'content-hash.sha256:campaign-data',
      size: BigInt(campaignData.byteLength),
      async read(offset: bigint, length: number) {
        return campaignData.slice(Number(offset), Number(offset) + length)
      },
    }
    const extension = await extendCampaignInspection({
      entries: [
        { path: 'Base.SC2Data/GameData/CampaignData.xml', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Campaign/Opening.SC2Map', kind: 'file' },
        { path: 'Base.SC2Maps/Maps/Campaign/Finale.SC2Map', kind: 'file' },
      ],
      root,
      revision: 'content-hash.sha256:catalog',
      context: {
        budget: {
          maxInputBytes: 64_000n,
          maxNodes: 100,
          maxDepth: 12,
          maxScalarBytes: 64_000,
        },
      },
      namespace: {
        async open(path: string) {
          expect(path).toBe('Base.SC2Data/GameData/CampaignData.xml')
          return { value: namespaceSource, async release() {} }
        },
      },
      readEntry: async (path: string) => {
        expect(path).toBe('Base.SC2Data/GameData/CampaignData.xml')
        return campaignData
      },
      bankSemantic: {
        nodes: [Object.freeze({ id: root.id, label: 'Catalog', type: 'sc2-campaign-package' })],
        edges: [],
      },
    } as never)

    const operation = await extension.handlers['inspect-missions']()
    expect(operation.value).toMatchObject({
      schemaVersion: 1,
      catalog: {
        files: ['Base.SC2Data/GameData/CampaignData.xml'],
        campaigns: [
          {
            id: 'Alpha',
            name: 'Campaign/Name/Alpha',
            campaignBanks: ['AlphaProgress'],
            transitionBanks: ['AlphaTransition'],
            progressAchievement: 'AlphaComplete',
            launchMaps: [{ path: 'Maps/Campaign/Opening.SC2Map', missionId: expect.any(String) }],
          },
          {
            id: 'Beta',
            parent: 'Alpha',
            prerequisiteCampaignId: 'Alpha',
            saveName: 'BetaSave',
            completedSaveName: 'BetaComplete',
            launchMaps: [{ path: 'Finale', missionId: expect.any(String) }],
          },
        ],
      },
      progression: {
        state: 'partial',
        basis: 'CampaignData',
      },
    })
    const graph = extension.dataSources['common.view/relation-graph-source']
    const graphEdges = (await graph.edges({ limit: 50 })).items
    expect(graphEdges.map(edge => edge.role)).toEqual(expect.arrayContaining([
      'defines-campaign',
      'requires-campaign',
      'launches-mission',
    ]))
    expect(extension.treeNodes[2]).toMatchObject({
      kind: 'campaign-catalog',
      children: [
        {
          label: 'Alpha',
          children: expect.arrayContaining([
            expect.objectContaining({ label: 'campaignBanks[0]' }),
            expect.objectContaining({ label: 'progressAchievement' }),
          ]),
        },
        { label: 'Beta' },
      ],
    })
    expect(extension.factRelations.map(item => item.role)).toEqual([
      'contains-mission', 'contains-mission', 'defines-campaign', 'defines-campaign',
    ])
    expect(extension.unsupportedFeatures).not.toContain('campaign-progression-not-decoded')
    expect(extension.unsupportedFeatures).toContain('campaign-mission-order-is-scenario-defined')

    const edit = patchCampaignDataText(new TextDecoder().decode(campaignData), {
      maxInputBytes: 64_000n,
      maxNodes: 100,
      maxDepth: 12,
      maxScalarBytes: 64_000,
    }, {
      campaignId: 'Beta',
      field: 'launchMap',
      value: 'Maps/Campaign/BetaLaunch.SC2Map',
    })
    const editedText = edit.text
    expect(editedText).toContain('<!-- unknown authored content must survive scalar edits -->')
    expect(editedText).toContain('LaunchMap="Maps/Campaign/BetaLaunch.SC2Map"')
    expect(editedText).toContain('<SaveName value="BetaSave"/>')

    const bankEdit = patchCampaignDataText(new TextDecoder().decode(campaignData), {
      maxInputBytes: 64_000n,
      maxNodes: 100,
      maxDepth: 12,
      maxScalarBytes: 64_000,
    }, {
      campaignId: 'Alpha',
      field: 'campaignBanks',
      index: 0,
      value: 'AlphaProgressV2',
    })
    const bankText = bankEdit.text
    expect(bankText).toContain('<CampaignBanks value="AlphaProgressV2"/>')
    expect(bankText).toContain('<TransitionBanks value="AlphaTransition"/>')

    const bankRemoval = patchCampaignDataText(new TextDecoder().decode(campaignData), {
      maxInputBytes: 64_000n,
      maxNodes: 100,
      maxDepth: 12,
      maxScalarBytes: 64_000,
    }, {
      campaignId: 'Alpha',
      field: 'transitionBanks',
      index: 0,
      value: null,
    })
    const removalText = bankRemoval.text
    expect(removalText).toContain('<TransitionBanks index="0" removed="1"/>')

    const declaration = declareCampaignDataText(new TextDecoder().decode(campaignData), {
      maxInputBytes: 64_000n,
      maxNodes: 100,
      maxDepth: 12,
      maxScalarBytes: 64_000,
    }, {
      campaignId: 'Gamma',
    })
    const declarationText = declaration.text
    expect(declarationText).toContain('<CCampaign id="Gamma"/>')
    expect(declarationText).toContain('<!-- unknown authored content must survive scalar edits -->')
    expect(() => declareCampaignDataText(new TextDecoder().decode(campaignData), {
      maxInputBytes: 64_000n,
      maxNodes: 100,
      maxDepth: 12,
      maxScalarBytes: 64_000,
    }, { campaignId: 'Alpha' })).toThrow(/already declared/u)
  })
})
