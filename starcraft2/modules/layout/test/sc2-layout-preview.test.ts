import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewSc2Layout, previewSc2TechTree } from '../shared/preview.js'

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures', 'layout', name), 'utf8')

const document = (name: string) => ({
  uri: `file:///fixture/${name}`,
  languageId: 'sc2-layout',
  version: 1,
  text: fixture(name),
})

const documents = [document('StandardTemplates.SC2Layout'), document('TechTreePanel.SC2Layout')]

type FrameView = Readonly<{
  name: string
  rect: Readonly<{ x: number; y: number; width: number; height: number }>
  properties: readonly Readonly<{
    name: string
    val?: string
    source: Readonly<{ uri: string; origin: string }>
  }>[]
  children: readonly FrameView[]
}>

function find(frame: FrameView, ...path: string[]): FrameView {
  let current = frame
  for (const name of path) {
    const child = current.children.find(candidate => candidate.name === name)
    if (child === undefined) throw new Error(`Missing preview frame ${name}`)
    current = child
  }
  return current
}

describe('SC2Layout semantic preview', () => {
  it('matches the pinned legacy tech-tree geometry assertions without pixel comparison', async () => {
    const result = await previewSc2TechTree({
      document: documents[1],
      workspaceDocuments: documents,
      rootPath: 'CategoryFrame_Nod',
      viewport: { width: 1280, height: 1024 },
    })

    const root = result.resolvedTree
    const cy = find(root, 'NodConstructionYard').rect
    const crane = find(root, 'NodCrane').rect
    const emissary = find(root, 'NodEmissaryDeployed').rect
    const powerPlant = find(root, 'NodPowerPlant').rect
    const hand = find(root, 'NodHand').rect
    const warFactory = find(root, 'NodWarFactory').rect
    const line = find(root, 'LineH1').rect
    const cyIcon = find(root, 'NodConstructionYard', 'BuildingIconBackgroundImage').rect
    const craneIcon = find(root, 'NodCrane', 'BuildingIconBackgroundImage').rect

    expect(cy.y).toBeCloseTo(crane.y, 5)
    expect(crane.x).toBeGreaterThan(cy.x + cy.width - 1)
    expect(emissary.x).toBeGreaterThan(crane.x + crane.width - 1)
    expect(powerPlant.y).toBeGreaterThan(cy.y + cy.height - 1)
    expect(powerPlant.x).toBeCloseTo(cy.x, 5)
    expect(warFactory.y).toBeGreaterThan(hand.y + hand.height - 1)
    expect(line.x).toBeCloseTo(cyIcon.x + cyIcon.width / 2, 5)
    expect(line.x + line.width).toBeCloseTo(craneIcon.x + craneIcon.width / 2, 5)
    expect(line.height).toBeCloseTo(2, 5)
    expect(result).toMatchObject({
      candidateContract: 'blizzard/game-template-preview-candidate@1',
      templateKind: 'sc2-tech-tree-v1',
      completeness: 'partial',
      fidelity: {
        comparison: 'semantic',
        sourceDocuments: 2,
      },
      provenance: {
        legacySource: 'modkit@1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
        schemaReference: 'SC2Mapster/sc2layout-schema@80ff763e735e20da8b826b1fa7e62e8ea49b92ed',
      },
    })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'sc2-layout/schema/invalid-value', message: expect.stringContaining('EFrameType') }),
    )
    expect(result.fidelity.resolvedFrames).toBeGreaterThan(12)
    expect(result.digest).toEqual({
      algorithm: 'fnv1a-32',
      value: expect.stringMatching(/^[\da-f]{8}$/u),
    })
  })

  it('applies the deterministic state-action subset and reports unsupported input honestly', async () => {
    const hidden = await previewSc2Layout({
      document: documents[1],
      workspaceDocuments: documents,
      rootPath: 'CategoryFrame_Nod',
      states: { Mode: 'Hidden' },
    })
    const yardItem = hidden.displayItems.find(item => item.path.at(-1) === 'NodConstructionYard')
    expect(yardItem?.visible).toBe(false)

    const broken = await previewSc2Layout({
      document: document('Broken.SC2Layout'),
      workspaceDocuments: [document('Broken.SC2Layout')],
    })
    expect(broken.completeness).toBe('partial')
    expect(broken.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining(['missing-template', expect.stringContaining('sc2-layout/schema/')]),
    )
  })

  it('merges file hookups with exact source attribution into the resolved tree', async () => {
    const hookup = document('TechTreeHookup.SC2Layout')
    const result = await previewSc2Layout({
      document: documents[1],
      workspaceDocuments: [...documents, hookup],
      rootPath: 'CategoryFrame_Nod',
    })
    const yard = find(result.resolvedTree, 'NodConstructionYard')
    const text = yard.properties.find(item => item.name === 'Text')
    expect(text).toMatchObject({
      val: 'UI/TechTree/NodConstructionYard',
      source: { uri: hookup.uri, origin: 'hookup' },
    })
    expect(
      result.displayItems.find(item => item.path.at(-1) === 'NodConstructionYard'),
    ).toMatchObject({ kind: 'text', text: 'UI/TechTree/NodConstructionYard' })
  })

  it('honors cancellation and hard workspace/node bounds', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      previewSc2Layout(
        { document: documents[1], workspaceDocuments: documents },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      previewSc2Layout({
        document: documents[1],
        workspaceDocuments: documents,
        maxNodes: 2,
      }),
    ).rejects.toThrow(/maxNodes/u)
  })
})
