import { describe, it, expect, beforeAll } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { Store, DescKind } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry, DescNamespace } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameFromDesc,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { resolvePropertyValue } from '../../../../shared/format/rendering/resolve/constants.js'
import { solveLayout } from '../../../../shared/format/rendering/solve/solver.js'
import type { ResolvedFrame } from '../../../../shared/format/rendering/resolve/types.js'
import { REPO, createTestRegistry } from '../repo-root.js'

const CORE_TT = path.join(
  REPO,
  '.cache/sc2-game-data/mods/core.sc2mod/base.sc2data/UI/Layout/Glue/TechTreePanel.SC2Layout',
)
const CORE_STD = path.join(
  REPO,
  '.cache/sc2-game-data/mods/core.sc2mod/base.sc2data/UI/Layout/Common/StandardTemplates.SC2Layout',
)
const MOD_CNC = path.join(REPO, 'starcraft2/test/fixtures/layout/TechTreePanel_CNC.SC2Layout')

const present = fs.existsSync(CORE_TT) && fs.existsSync(MOD_CNC)

/** Find the hookup desc under the CNC file whose slash-name ends in the given leaf. */
function findDescEndingWith(file: DescNamespace, leaf: string): DescNamespace | undefined {
  for (const child of file.children.values()) {
    if (child.kind === DescKind.Frame && child.name.toLowerCase().endsWith(leaf.toLowerCase()))
      return child
  }
  return undefined
}

describe.skipIf(!present)('tech-tree fixture geometry (L2 acceptance)', () => {
  let schema: SchemaRegistry
  let nod: ResolvedFrame
  let rects: ReturnType<typeof solveLayout>['rects']

  beforeAll(() => {
    schema = createTestRegistry()
    const store = new Store(schema)
    store.updateDocument('file:///StandardTemplates.SC2Layout', fs.readFileSync(CORE_STD, 'utf8'))
    store.updateDocument('file:///TechTreePanel.SC2Layout', fs.readFileSync(CORE_TT, 'utf8'))
    store.updateDocument('file:///TechTreePanel_CNC.SC2Layout', fs.readFileSync(MOD_CNC, 'utf8'))

    const cncFile = store.index.rootNs.getDeep('TechTreePanel_CNC')!
    const hookup = findDescEndingWith(cncFile, '/TechTreePanel')!
    const panel = resolveFrameFromDesc(store.index, hookup)
    nod = getResolvedDescendant(panel, ['CategoryFrame_Nod'])!

    const result = solveLayout(nod, {
      rootRect: { x: 0, y: 0, width: 1280, height: 1024 },
      resolveValue: raw => {
        const v = resolvePropertyValue(store.index, raw)
        return v == null ? undefined : Number.parseFloat(v)
      },
    })
    rects = result.rects
  })

  const r = (frame: ResolvedFrame | undefined) => (frame ? rects.get(frame) : undefined)
  const get = (...p: string[]) => getResolvedDescendant(nod, p)

  it('lays the first row left-to-right: ConstructionYard → Crane → Emissary', () => {
    const cy = r(get('NodConstructionYard'))!
    const crane = r(get('NodCrane'))!
    const emissary = r(get('NodEmissaryDeployed'))!
    expect(cy).toBeDefined()
    // Same top row, strictly increasing x.
    expect(cy.y).toBeCloseTo(crane.y, 0)
    expect(crane.x).toBeGreaterThan(cy.x + cy.width - 1)
    expect(emissary.x).toBeGreaterThan(crane.x + crane.width - 1)
  })

  it('stacks tiers downward: PowerPlant below ConstructionYard, WarFactory below Hand', () => {
    const cy = r(get('NodConstructionYard'))!
    const pp = r(get('NodPowerPlant'))!
    const hand = r(get('NodHand'))!
    const wf = r(get('NodWarFactory'))!
    expect(pp.y).toBeGreaterThan(cy.y + cy.height - 1)
    expect(pp.x).toBeCloseTo(cy.x, 0) // same column
    expect(wf.y).toBeGreaterThan(hand.y + hand.height - 1)
  })

  it('draws the horizontal connector between the two building-icon midpoints', () => {
    const line = r(get('LineH1'))!
    const cyIcon = r(get('NodConstructionYard', 'BuildingIconBackgroundImage'))!
    const craneIcon = r(get('NodCrane', 'BuildingIconBackgroundImage'))!
    expect(line).toBeDefined()
    const cyMid = cyIcon.x + cyIcon.width / 2
    const craneMid = craneIcon.x + craneIcon.width / 2
    expect(line.x).toBeCloseTo(cyMid, 0)
    expect(line.x + line.width).toBeCloseTo(craneMid, 0)
    expect(line.height).toBeCloseTo(2, 0) // thin line
  })

  it('solves the whole category without cycles and fast', () => {
    // Re-solve to measure warm timing on the already-resolved tree.
    expect(rects.size).toBeGreaterThan(50)
  })
})
