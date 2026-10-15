import { describe, it, expect, beforeAll } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { applyStateGroups } from '../../../../shared/format/rendering/states/apply.js'
import { REPO, createTestRegistry } from '../repo-root.js'

const GAMEUI = path.join(
  REPO,
  '.cache/sc2-game-data/mods/core.sc2mod/base.sc2data/UI/Layout/UI/GameUI.SC2Layout',
)
const present = fs.existsSync(GAMEUI)

describe.skipIf(!present)('real GameUI StateGroups', () => {
  let schema: SchemaRegistry
  beforeAll(() => {
    schema = createTestRegistry()
  })

  function loadControlGroupPanel() {
    const store = new Store(schema)
    store.updateDocument('file:///GameUI.SC2Layout', fs.readFileSync(GAMEUI, 'utf8'))
    // ControlGroupPanel is declared inline in GameUI's GameUI frame.
    const cgp = resolveFrameByPath(
      store,
      'GameUI/GameUI/UIContainer/ConsoleUIContainer/ControlGroupPanel',
    )
    return { store, cgp }
  }

  it('captures the AlignmentRatioCheck StateGroup from the shipped layout', () => {
    const { cgp } = loadControlGroupPanel()
    expect(cgp).toBeDefined()
    const sg = cgp!.stateGroups.find(s => s.name === 'AlignmentRatioCheck')
    expect(sg).toBeDefined()
    expect(sg!.defaultState).toBe('CenterAligned')
    expect(sg!.states.map(s => s.name)).toContain('LeftAligned')
  })

  it('re-anchors ControlGroupPanel by state (CenterAligned default vs LeftAligned)', () => {
    // Default: no inputs → CenterAligned → Left anchored to InfoPanel Mid.
    const def = loadControlGroupPanel()
    const res1 = applyStateGroups(def.cgp!, { stateInputs: {}, index: def.store.index })
    expect(res1.active.get(`${def.cgp!.path.join('/')}#AlignmentRatioCheck`)).toBe('CenterAligned')
    expect(def.cgp!.anchors.Left?.pos).toBe('Mid')

    // Wide aspect: AspectRatioListener_16x10 hidden → LeftAligned → anchored to MinimapPanel Max.
    const wide = loadControlGroupPanel()
    applyStateGroups(wide.cgp!, {
      stateInputs: { 'AspectRatioListener_16x10.Visible': 'False' },
      index: wide.store.index,
    })
    expect(wide.cgp!.anchors.Left?.pos).toBe('Max')
    expect(wide.cgp!.anchors.Left?.relative).toContain('MinimapPanel')
  })
})
