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
// Single mod — BaseMod only
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2ModReader — single mod', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(fix('BaseMod'))
  })

  it('loads units namespace', () => {
    expect(mod.units.size).toBe(2)
  })

  it('gets Marine by id', () => {
    const marine = mod.units.get('Marine')
    expect(marine).toBeDefined()
    expect(marine!['LifeMax']).toBe('45')
    expect(marine!['ShieldsMax']).toBe('0')
  })

  it('loads weapons namespace', () => {
    expect(mod.weapons.size).toBe(1)
    const rifle = mod.weapons.get('GaussRifle')
    expect(rifle!['Range']).toBe('5')
    expect(rifle!['Period']).toBe('0.8608')
  })

  it('resolves Marauder parent chain — inherits ShieldsMax from Marine', () => {
    const marauder = mod.units.get('Marauder')
    expect(marauder).toBeDefined()
    expect(marauder!['LifeMax']).toBe('125') // own field
    expect(marauder!['ShieldsMax']).toBe('0') // inherited from Marine
    expect(marauder!['Armor']).toBe('1') // own field overrides parent
  })

  it('loadOrder contains one entry', () => {
    expect(mod.loadOrder).toHaveLength(1)
    expect(mod.loadOrder[0]).toContain('BaseMod')
  })

  it('namespaces() lists Unit and Weapon', () => {
    const ns = mod.namespaces()
    expect(ns).toContain('Unit')
    expect(ns).toContain('Weapon')
  })

  it('parses .SC2Layout files into mod.layouts', () => {
    const key = [...mod.layouts.keys()].find(k => /testpanel\.sc2layout$/i.test(k))
    expect(key).toBeDefined()
    const layout = mod.layouts.get(key!)!
    expect(layout.frames).toHaveLength(1)
    expect(layout.frames[0]!.name).toBe('TestPanel')
    // child frames + their references are captured
    const refKeys = layout.references.map(r => r.value)
    expect(refKeys).toContain('UI/TestPanel/Title')
    expect(refKeys).toContain('Button/Hotkey/Cancel')
  })

  it('keeps layout bytes in opaqueFiles for round-trip', () => {
    const key = [...mod.opaqueFiles.keys()].find(k => /testpanel\.sc2layout$/i.test(k))
    expect(key).toBeDefined()
  })

  it('parses BankList.xml into mod.bankList', () => {
    expect(mod.bankList).toBeDefined()
    expect(mod.bankList!.banks.map(bank => bank.name)).toEqual([
      'endofdreamsbank2',
      'shared_progress',
    ])
    expect(mod.bankList!.banks[0]!.player).toBe('1')
  })

  it('keeps BankList.xml bytes in opaqueFiles for round-trip', () => {
    const key = [...mod.opaqueFiles.keys()].find(k => /banklist\.xml$/i.test(k))
    expect(key).toBeDefined()
  })

  it('parses FontStyles constants, font groups, and template styles', () => {
    expect(mod.getTextConstant('ColorAttackInfo')).toBe('ffff8a')
    expect(mod.getTextConstant('ColorLinked')).toBe('ffff8a')

    const style = mod.getTextStyle('TooltipStyle')
    expect(style).toBeDefined()
    expect(style!.attrs['textcolor']).toBe('ffff8a')
    expect(style!.attrs['height']).toBe('18')
    expect(style!.attrs['styleflags']).toBe('Bold|Italic')
    expect(style!.fonts).toEqual(['UI\\Fonts\\Base.ttf'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Locale filter — single-locale consumers skip other locales' string files
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2ModReader — localeFilter', () => {
  it('reads all locales when unfiltered', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(fix('TestMod'))
    expect([...mod.locales.keys()].sort()).toEqual(['dede', 'enus'])
    expect(mod.locales.get('dede')!.get('GameStrings')!.get('Button/Name/Attack')).toBe('Angriff')
  })

  it('reads only the filtered locale (case-insensitive), keeping its font-style overlay', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs(), localeFilter: ['enUS'] })
    const mod = await reader.read(fix('TestMod'))
    expect([...mod.locales.keys()]).toEqual(['enus'])
    expect(mod.locales.get('enus')!.get('GameStrings')!.get('Button/Name/Attack')).toBe('Attack')
    // The enus localized font-style overlay still loads; non-localized sheet always does.
    expect(mod.localizedFontStyles.has('enus')).toBe(true)
  })

  it('drops non-matching locales entirely', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs(), localeFilter: ['dede'] })
    const mod = await reader.read(fix('TestMod'))
    expect([...mod.locales.keys()]).toEqual(['dede'])
    expect(mod.localizedFontStyles.has('enus')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Multi-mod merge — TestMod depends on BaseMod via ComponentList
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2ModReader — multi-mod merge', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(fix('TestMod'))
  })

  it('loads BaseMod before TestMod (ComponentList order)', () => {
    expect(mod.loadOrder).toHaveLength(2)
    expect(mod.loadOrder[0]).toContain('BaseMod')
    expect(mod.loadOrder[1]).toContain('TestMod')
  })

  it('TestMod overrides Marine LifeMax', () => {
    const marine = mod.units.get('Marine')
    expect(marine!['LifeMax']).toBe('55') // TestMod value wins
  })

  it('Marine ShieldsMax survives override (BaseMod field not overwritten)', () => {
    const marine = mod.units.get('Marine')
    expect(marine!['ShieldsMax']).toBe('0')
  })

  it('Marauder from BaseMod is available', () => {
    const marauder = mod.units.get('Marauder')
    expect(marauder).toBeDefined()
    expect(marauder!['LifeMax']).toBe('125')
  })

  it('Marauder inherits from merged Marine (ShieldsMax = 0)', () => {
    const marauder = mod.units.get('Marauder')
    expect(marauder!['ShieldsMax']).toBe('0')
  })

  it('Ghost from TestMod is available', () => {
    const ghost = mod.units.get('Ghost')
    expect(ghost).toBeDefined()
    expect(ghost!['LifeMax']).toBe('100')
  })

  it('units.size includes entities from both mods', () => {
    // Marine (BaseMod+TestMod), Marauder (BaseMod), Ghost (TestMod)
    expect(mod.units.size).toBe(3)
  })

  it('merges FontStyles through dependencies and locale overlays', () => {
    expect(mod.getTextConstant('ColorAttackInfo')).toBe('00ff00')
    expect(mod.getTextConstant('ColorLinked')).toBe('00ff00')
    expect(mod.getTextConstant('ColorAttackInfo', 'enUS')).toBe('abcdef')

    const style = mod.getTextStyle('TooltipStyle', 'enUS')
    expect(style).toBeDefined()
    expect(style!.attrs['textcolor']).toBe('abcdef')
    expect(style!.attrs['height']).toBe('20')
    expect(style!.attrs['styleflags']).toBe('Shadow')
    expect(style!.fonts).toEqual(['UI\\Fonts\\Base.ttf'])
  })

  it('merges the @@ asset-alias table through dependencies, later mods winning', () => {
    // BaseMod declares UI/Foo + UI/Baz; TestMod re-declares UI/Foo and adds UI/Bar.
    expect(mod.assetAliases.get('UI/Baz')).toBe('Assets\\Textures\\baz.dds')
    expect(mod.assetAliases.get('UI/Bar')).toBe('Assets\\Textures\\bar.dds')
    expect(mod.assetAliases.get('UI/Foo')).toBe('Assets\\Textures\\foo.dds')
  })
})

describe('SC2ModReader — DocumentInfo dependency chain', () => {
  it('loads core first and recursively resolves SC2 file dependencies', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(fix('Sc2Root/Mods/Leaf.SC2Mod'))

    expect(mod.loadOrder.map(p => p.slice(p.lastIndexOf('/') + 1).toLowerCase())).toEqual([
      'core.sc2mod',
      'liberty.sc2mod',
      'swarm.sc2mod',
      'void.sc2mod',
      'leaf.sc2mod',
    ])
    expect(mod.units.get('CoreOnly')).toBeDefined()
    expect(mod.units.get('LibertyOnly')).toBeDefined()
    expect(mod.units.get('SwarmOnly')).toBeDefined()
    expect(mod.units.get('VoidOnly')).toBeDefined()
    expect(mod.units.get('LeafOnly')).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Explicit deps — override ComponentList
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2ModReader — explicit deps', () => {
  it('empty deps skips ComponentList entirely', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(fix('TestMod'), { deps: [] })

    expect(mod.loadOrder).toHaveLength(1)
    expect(mod.loadOrder[0]).toContain('TestMod')
    // Only TestMod loaded — Ghost is present, Marauder is not
    expect(mod.units.get('Ghost')).toBeDefined()
    expect(mod.units.get('Marauder')).toBeUndefined()
  })

  it('explicit deps load in provided order', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    const mod = await reader.read(fix('TestMod'), { deps: [fix('BaseMod')] })

    expect(mod.loadOrder).toHaveLength(2)
    expect(mod.loadOrder[0]).toContain('BaseMod')
    expect(mod.loadOrder[1]).toContain('TestMod')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — same dep loaded twice is skipped
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2ModReader — deduplication', () => {
  it('loading the same dep twice does not duplicate entities', async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    // Provide BaseMod twice explicitly
    const mod = await reader.read(fix('BaseMod'), {
      deps: [fix('BaseMod'), fix('BaseMod')],
    })

    expect(mod.loadOrder).toHaveLength(1)
    expect(mod.units.size).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SC2Mod API
// ─────────────────────────────────────────────────────────────────────────────
describe('SC2Mod API', () => {
  let mod: SC2Mod

  beforeAll(async () => {
    const reader = new SC2ModReader({ vfs: makeVfs() })
    mod = await reader.read(fix('BaseMod'))
  })

  it('namespace() returns TypedNamespace for a custom namespace', () => {
    const units = mod.namespace('Unit')
    expect(units.size).toBe(2)
  })

  it('namespace() returns empty TypedNamespace for unknown ns', () => {
    const ns = mod.namespace('NonExistent')
    expect(ns.size).toBe(0)
  })

  it('getResolved() returns resolved fields directly', () => {
    const fields = mod.getResolved('Unit', 'Marauder')
    expect(fields).toBeDefined()
    expect(fields!['LifeMax']).toBe('125')
    expect(fields!['ShieldsMax']).toBe('0')
  })

  it('get() returns raw CatalogEntity', () => {
    const entity = mod.get('Unit', 'Marine')
    expect(entity).toBeDefined()
    expect(entity!.id).toBe('Marine')
    expect(entity!.class).toBe('CUnit')
    expect(entity!.namespace).toBe('Unit')
  })

  it('all() returns all raw entities for a namespace', () => {
    const units = mod.all('Unit')
    expect(units).toHaveLength(2)
    expect(units.map(u => u.id)).toContain('Marine')
    expect(units.map(u => u.id)).toContain('Marauder')
  })

  it('all() for abils returns empty array when none loaded', () => {
    expect(mod.abils.size).toBe(0)
    expect(mod.all('Abil')).toHaveLength(0)
  })
})
