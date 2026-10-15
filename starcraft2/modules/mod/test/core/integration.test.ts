/**
 * Integration tests against real SC2 game data.
 * Uses the same pinned SC2GameData cache as the language and Runtime integration suites.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FsReader, VirtualFileSystem } from '../../shared/workspace/vfs.js'
import { SC2ModReader } from '../../shared/core/reader.js'
import type { SC2Mod } from '../../shared/core/mod.js'

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..')
const SC2_DEPS = join(REPO_ROOT, '.cache', 'sc2-game-data', 'mods')
const CORE_MOD = `${SC2_DEPS}/core.sc2mod`
const LIBERTY_MOD = `${SC2_DEPS}/liberty.sc2mod`
const SWARM_MOD = `${SC2_DEPS}/swarm.sc2mod`
const VOID_BASE_MOD = `${SC2_DEPS}/void.sc2mod`
const VOID_MOD = `${SC2_DEPS}/voidmulti.sc2mod`
const SC2_ROOT = join(REPO_ROOT, '.cache', 'sc2-game-data')

const hasCore = existsSync(CORE_MOD)
const hasVoid = existsSync(VOID_MOD)

function makeVfs(): VirtualFileSystem {
  const vfs = new VirtualFileSystem()
  vfs.register('file:', new FsReader())
  return vfs
}

function f(path: string): string {
  return `file:${path.replace(/\\/g, '/')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// voidmulti.sc2mod — the pinned multiplayer mod, loaded standalone (no deps)
// XML ground truth confirmed by reading files directly
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!hasVoid)('Integration: voidmulti.sc2mod (standalone)', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    // Load standalone — ignore DocumentInfo deps (bnet + all-races-factions base)
    mod = await reader.read(f(VOID_MOD), { deps: [] })
  }, 60_000)

  it('loads unit namespace with 200+ entities', () => {
    // 246 <CUnit> entries in UnitData.xml
    expect(mod.units.size).toBeGreaterThan(200)
  })

  it('loads 200+ abilities from the standalone multiplayer layer', () => {
    expect(mod.abils.size).toBeGreaterThan(200)
  })

  it('loads 500+ effects from the standalone multiplayer layer', () => {
    expect(mod.effects.size).toBeGreaterThan(500)
  })

  it('loads weapon namespace', () => {
    // 94 <CWeapon*> entries in WeaponData.xml
    expect(mod.weapons.size).toBeGreaterThan(50)
  })

  it('keeps a standalone Marine override unresolved without its dependency chain', () => {
    const marine = mod.units.get('Marine')
    expect(marine).toBeDefined()
    expect(marine!['LifeMax']).toBeUndefined()
    expect(marine!['Race']).toBeUndefined()
  })

  it('all namespaces loaded (Unit, Abil, Effect, Weapon, Behavior, Actor, Button)', () => {
    const ns = mod.namespaces()
    expect(ns).toContain('Unit')
    expect(ns).toContain('Abil')
    expect(ns).toContain('Effect')
    expect(ns).toContain('Weapon')
    expect(ns).toContain('Behavior')
    expect(ns).toContain('Actor')
    expect(ns).toContain('Button')
  })

  it('loadOrder contains only voidmulti (no deps loaded)', () => {
    expect(mod.loadOrder).toHaveLength(1)
    expect(mod.loadOrder[0]?.toLowerCase()).toContain('voidmulti')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// core.sc2mod — Blizzard base mod, loaded standalone
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!hasCore)('Integration: core.sc2mod (standalone)', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(f(CORE_MOD), { deps: [] })
  }, 60_000)

  it('loads many namespaces from 116 GameData files', () => {
    const ns = mod.namespaces()
    expect(ns.length).toBeGreaterThan(10)
    expect(ns).toContain('Unit')
    expect(ns).toContain('Abil')
    expect(ns).toContain('Effect')
    expect(ns).toContain('Behavior')
    expect(ns).toContain('Upgrade')
  })

  it('default CUnit (empty id) has LifeMax = "1" and Race = "Neut"', () => {
    // The core default: <CUnit default="1"> with no id attribute → stored as id = ""
    const defaultUnit = mod.units.get('')
    expect(defaultUnit).toBeDefined()
    expect(defaultUnit!['LifeMax']).toBe('1')
    expect(defaultUnit!['Race']).toBe('Neut')
  })

  it('unit count from core unitdata.xml is in expected range', () => {
    // 18 <CUnit> in unitdata.xml; other files may add more
    expect(mod.units.size).toBeGreaterThanOrEqual(18)
  })

  it('loadOrder contains only core.sc2mod', () => {
    expect(mod.loadOrder).toHaveLength(1)
    expect(mod.loadOrder[0]).toContain('core.sc2mod')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DocumentInfo dependency resolution
// Loads core.sc2mod with rootPath — verifies DocumentInfo is parsed
// but the ARC-ASSETS dep is gracefully skipped if it doesn't exist
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!hasCore)('Integration: DocumentInfo dep resolution', () => {
  it('reads DocumentInfo and resolves file: dep paths', async () => {
    const reader = new SC2ModReader({
      vfs: makeVfs(),
    })
    // core.sc2mod DocumentInfo has: file:Mods\ARC-ASSETS.SC2Mod
    // With rootPath = SC2 install root, this resolves to file:.../Mods/ARC-ASSETS.SC2Mod
    // ARC-ASSETS.SC2Mod may or may not exist — reader skips missing deps gracefully
    const mod = await reader.read(f(CORE_MOD), {
      rootPath: f(SC2_ROOT),
    })
    // core.sc2mod itself always loads
    expect(mod.loadOrder).toContain(f(CORE_MOD))
    // core data is present regardless
    expect(mod.units.size).toBeGreaterThan(0)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// Stacked load: core → liberty → swarm → void → voidmulti
// Tests merge of two real mods in dependency order
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!hasCore || !hasVoid)('Integration: full dependency chain → voidmulti.sc2mod', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(f(VOID_MOD), {
      deps: [f(CORE_MOD), f(LIBERTY_MOD), f(SWARM_MOD), f(VOID_BASE_MOD)],
    })
  }, 60_000)

  it('loadOrder follows the complete dependency chain', () => {
    expect(mod.loadOrder).toHaveLength(5)
    expect(mod.loadOrder[0]).toContain('core.sc2mod')
    expect(mod.loadOrder[1]).toContain('liberty.sc2mod')
    expect(mod.loadOrder[2]).toContain('swarm.sc2mod')
    expect(mod.loadOrder[3]).toContain('void.sc2mod')
    expect(mod.loadOrder[4]?.toLowerCase()).toContain('voidmulti')
  })

  it('entities from both mods are accessible', () => {
    // VoidMulti has Marine
    expect(mod.units.get('Marine')).toBeDefined()
    // core defines const entries and CUnit default, which survive merge
    expect(mod.units.get('')).toBeDefined()
  })

  it('resolves Marine fields through the complete chain', () => {
    const marine = mod.units.get('Marine')
    expect(marine!['LifeMax']).toBe('45')
    expect(marine!['Race']).toBe('Terr')
  })

  it('unit count >= VoidMulti standalone count', () => {
    // Stacked load has at least as many units as VoidMulti alone
    expect(mod.units.size).toBeGreaterThan(200)
  })
})
