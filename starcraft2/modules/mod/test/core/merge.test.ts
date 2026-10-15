/**
 * Merge scenario tests — validates multi-mod field merging behaviour:
 *   - Scalar override (later mod wins)
 *   - Indexed array merge by `index` attribute (WeaponArray, Attributes)
 *   - Append array concat (GlossaryStrongArray)
 *   - Cross-mod parent chain (child in patch mod, parent in base mod)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { FsReader, VirtualFileSystem } from '../../shared/workspace/vfs.js'
import { SC2ModReader } from '../../shared/core/reader.js'
import type { SC2Mod } from '../../shared/core/mod.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

function makeVfs(): VirtualFileSystem {
  const vfs = new VirtualFileSystem()
  vfs.register('file:', new FsReader())
  return vfs
}

function fix(name: string): string {
  return `file:${FIXTURES.replace(/\\/g, '/')}/${name}`
}

// ─────────────────────────────────────────────────────────────────────────────
// MergeBase standalone — verifies fixture content before testing merge
// ─────────────────────────────────────────────────────────────────────────────
describe('Merge fixtures — MergeBase standalone', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(fix('MergeBase'))
  })

  it('Soldier has LifeMax = 100', () => {
    expect(mod.units.get('Soldier')!['LifeMax']).toBe('100')
  })

  it('Soldier WeaponArray has 2 slots', () => {
    const weapons = mod.units.get('Soldier')!['WeaponArray'] as Array<Record<string, string>>
    expect(Array.isArray(weapons)).toBe(true)
    expect(weapons).toHaveLength(2)
    expect(weapons.find(w => w['index'] === '0')?.['Link']).toBe('Rifle')
    expect(weapons.find(w => w['index'] === '1')?.['Link']).toBe('Grenade')
  })

  it('Soldier Attributes has Light and Biological', () => {
    const attrs = mod.units.get('Soldier')!['Attributes'] as Array<Record<string, string>>
    expect(Array.isArray(attrs)).toBe(true)
    const keys = attrs.map(a => a['index'])
    expect(keys).toContain('Light')
    expect(keys).toContain('Biological')
    expect(keys).not.toContain('Mechanical')
  })

  it('Soldier GlossaryStrongArray has Medic and Engineer', () => {
    const gloss = mod.units.get('Soldier')!['GlossaryStrongArray'] as string[]
    expect(gloss).toContain('Medic')
    expect(gloss).toContain('Engineer')
  })

  it('BaseHero LifeMax = 500', () => {
    expect(mod.units.get('BaseHero')!['LifeMax']).toBe('500')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MergePatch stacked on MergeBase
// ─────────────────────────────────────────────────────────────────────────────
describe('Merge scenarios — MergeBase → MergePatch', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(fix('MergePatch'))
  })

  it('load order: MergeBase first, MergePatch second', () => {
    expect(mod.loadOrder).toHaveLength(2)
    expect(mod.loadOrder[0]).toContain('MergeBase')
    expect(mod.loadOrder[1]).toContain('MergePatch')
  })

  // ── scalar ────────────────────────────────────────────────────────────────
  it('scalar override: Soldier LifeMax = 120 (patch wins)', () => {
    expect(mod.units.get('Soldier')!['LifeMax']).toBe('120')
  })

  // ── indexed array (WeaponArray) ───────────────────────────────────────────
  it('indexed array: slot 0 is updated to RifleUpgraded', () => {
    const weapons = mod.units.get('Soldier')!['WeaponArray'] as Array<Record<string, string>>
    expect(weapons.find(w => w['index'] === '0')?.['Link']).toBe('RifleUpgraded')
  })

  it('indexed array: slot 1 (Grenade) survives from base', () => {
    const weapons = mod.units.get('Soldier')!['WeaponArray'] as Array<Record<string, string>>
    expect(weapons.find(w => w['index'] === '1')?.['Link']).toBe('Grenade')
  })

  it('indexed array: slot 2 (Rocket) added by patch', () => {
    const weapons = mod.units.get('Soldier')!['WeaponArray'] as Array<Record<string, string>>
    expect(weapons.find(w => w['index'] === '2')?.['Link']).toBe('Rocket')
    expect(weapons).toHaveLength(3)
  })

  // ── indexed array (Attributes) ────────────────────────────────────────────
  it('indexed array: base Attributes (Light, Biological) survive', () => {
    const attrs = mod.units.get('Soldier')!['Attributes'] as Array<Record<string, string>>
    const keys = attrs.map(a => a['index'])
    expect(keys).toContain('Light')
    expect(keys).toContain('Biological')
  })

  it('indexed array: Mechanical attribute added by patch', () => {
    const attrs = mod.units.get('Soldier')!['Attributes'] as Array<Record<string, string>>
    const keys = attrs.map(a => a['index'])
    expect(keys).toContain('Mechanical')
    expect(attrs).toHaveLength(3)
  })

  // ── append array (GlossaryStrongArray) ───────────────────────────────────
  it('append array: GlossaryStrongArray contains base entries (Medic, Engineer)', () => {
    const gloss = mod.units.get('Soldier')!['GlossaryStrongArray'] as string[]
    expect(gloss).toContain('Medic')
    expect(gloss).toContain('Engineer')
  })

  it('append array: GlossaryStrongArray also contains patch entry (Sniper)', () => {
    const gloss = mod.units.get('Soldier')!['GlossaryStrongArray'] as string[]
    expect(gloss).toContain('Sniper')
    expect(gloss).toHaveLength(3)
  })

  // ── cross-mod parent chain ────────────────────────────────────────────────
  it('cross-mod inheritance: EliteHero (patch) resolves parent BaseHero (base)', () => {
    const elite = mod.units.get('EliteHero')
    expect(elite).toBeDefined()
    // Own field overrides parent
    expect(elite!['LifeMax']).toBe('800')
    expect(elite!['Armor']).toBe('10')
    // Inherited from BaseHero in base mod
    expect(elite!['Race']).toBe('Terr')
  })

  it('BaseHero unchanged by patch (EliteHero patch does not mutate parent)', () => {
    const hero = mod.units.get('BaseHero')
    expect(hero!['LifeMax']).toBe('500')
    expect(hero!['Armor']).toBe('5')
  })
})
