import { describe, it, expect, beforeAll } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import { loadLayoutWorkspace, parseIncludes } from '../../../../shared/format/rendering/workspace/workspace.js'
import { fsLayoutSource } from '../../../../shared/format/rendering/workspace/fs-source.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { REPO, createTestRegistry } from '../repo-root.js'

const CORE_DATA = path.join(REPO, '-references/SC2GameData/mods/core.sc2mod/base.sc2data')
const hasDump = fs.existsSync(path.join(CORE_DATA, 'UI/Layout/DescIndex.SC2Layout'))

describe('parseIncludes', () => {
  it('extracts paths and requiredtoload flags, skipping comments', () => {
    const xml = `<Desc>
      <Include path="UI/Layout/A.SC2Layout"/>
      <!-- <Include path="UI/Layout/Ignored.SC2Layout"/> -->
      <Include requiredtoload="IS_X_ENABLED" path="UI/Layout/B.SC2Layout"/>
    </Desc>`
    expect(parseIncludes(xml)).toEqual([
      { path: 'UI/Layout/A.SC2Layout' },
      { path: 'UI/Layout/B.SC2Layout', requiredToLoad: 'IS_X_ENABLED' },
    ])
  })
})

// End-to-end over the real base-game layout dump — proves the loader + resolver
// reproduce the tech-tree hookup the game itself uses. Skipped when the dump
// isn't present.
describe.skipIf(!hasDump)('base-game workspace load', () => {
  let schema: SchemaRegistry
  beforeAll(() => {
    schema = createTestRegistry()
  })

  it('loads the GameUI include chain and gates requiredtoload files', async () => {
    const { report } = await loadLayoutWorkspace(schema, [fsLayoutSource('core', CORE_DATA)])
    expect(report.loaded).toContain('UI/Layout/UI/GameUI.SC2Layout')
    expect(report.loaded).toContain('UI/Layout/Glue/HelpMenuDialog.SC2Layout')
    // PERF2/lobby-gated screens are skipped by default (flags disabled).
    expect(report.gatedSkipped.length).toBeGreaterThan(0)
  })

  it('resolves GameUI/ConsoleUIContainer/CommandPanel with its 15 command buttons', async () => {
    const { store } = await loadLayoutWorkspace(schema, [fsLayoutSource('core', CORE_DATA)])
    const gameUI = resolveFrameByPath(store, 'GameUI/GameUI')!
    expect(gameUI).toBeDefined()
    const cmd = getResolvedDescendant(gameUI, [
      'UIContainer',
      'ConsoleUIContainer',
      'CommandPanel',
    ])!
    expect(cmd).toBeDefined()
    const grid = getResolvedDescendant(cmd, ['CommandButtonGrid']) ?? cmd
    // CommandButton00..14 live on the grid (name varies by template); assert the
    // panel subtree contains all 15 buttons somewhere.
    const buttons = countDescendantsNamed(cmd, /^CommandButton\d\d$/)
    expect(buttons).toBeGreaterThanOrEqual(15)
    void grid
  })
})

function countDescendantsNamed(
  frame: { name: string; children: { name: string; children: unknown[] }[] },
  re: RegExp,
): number {
  let n = re.test(frame.name) ? 1 : 0
  for (const c of frame.children) n += countDescendantsNamed(c as never, re)
  return n
}
