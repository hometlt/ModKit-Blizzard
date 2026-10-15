import { describe, expect, it } from 'vitest'
import { CascInstallReader } from '../../src/casc/install-reader.js'
import type { CascReader } from '../../src/casc/reader.js'

function listMockPaths(paths: readonly string[], prefix = ''): string[] {
  const key = prefix
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!key) return paths.map(p => p.replace(/\\/g, '/')).sort()
  const child = `${key}/`
  return paths
    .map(p => p.replace(/\\/g, '/'))
    .filter(p => p.toLowerCase().startsWith(child))
    .map(p => p.slice(child.length))
    .sort()
}

describe('CascInstallReader', () => {
  it('adapts CASC path lookup to BaseReader', async () => {
    const data = new TextEncoder().encode('hello')
    const mockPaths = [
      'mods\\core.sc2mod\\base.sc2data\\gamedata\\unitdata.xml',
      'mods\\core.sc2mod\\base.sc2data\\localizeddata\\gamestrings.txt',
    ]
    const casc = {
      listPaths: (prefix?: string) => listMockPaths(mockPaths, prefix),
      readPath: async (path: string) => {
        expect(path).toBe('Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml')
        return data
      },
      hasPath: (path: string) => path.toLowerCase().includes('unitdata.xml'),
      hasPrefix: (path: string) => {
        const key = path
          .toLowerCase()
          .replace(/[\\/]+/g, '/')
          .replace(/\/+$/, '')
        return mockPaths.some(p => {
          const lp = p.toLowerCase().replace(/\\/g, '/')
          return lp === key || lp.startsWith(`${key}/`)
        })
      },
    } as unknown as CascReader

    const reader = new CascInstallReader(casc)

    await expect(reader.list('Mods/Core.SC2Mod/Base.SC2Data')).resolves.toEqual([
      'gamedata/unitdata.xml',
      'localizeddata/gamestrings.txt',
    ])
    await expect(
      reader.get('Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml'),
    ).resolves.toEqual(data)
    await expect(
      reader.getText('Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml'),
    ).resolves.toBe('hello')
    // exists() resolves both files and directories (CASC has no folder entries).
    await expect(
      reader.exists('Mods/Core.SC2Mod/Base.SC2Data/GameData/UnitData.xml'),
    ).resolves.toBe(true)
    await expect(reader.exists('Mods/Core.SC2Mod')).resolves.toBe(true)
    await expect(reader.exists('Mods/Nonexistent.SC2Mod')).resolves.toBe(false)
  })

  it('lists a folder whose name is a prefix of many sibling names', async () => {
    // Regression: `marine/` sorts differently under `localeCompare` (used to build the index)
    // than under the plain `<` comparison the binary search actually uses, because `/` (the
    // child separator) and `_` (common in sibling names like `marine_blackops`) collate
    // differently — the mismatch made the binary search land in the wrong spot and return zero
    // results for `list('.../terran/marine')`, even though `marine/marine.m3` is in the array.
    const mockPaths = [
      'mods/liberty.sc2mod/base.sc2assets/assets/units/terran/marine/marine.m3',
      'mods/liberty.sc2mod/base.sc2assets/assets/units/terran/marine_blackops/marine_blackops.m3',
      'mods/liberty.sc2mod/base.sc2assets/assets/units/terran/marine_remastered/marine_remastered.m3',
      'mods/liberty.sc2mod/base.sc2assets/assets/units/terran/marinedeath/marinedeath.m3',
    ]
    const casc = {
      listPaths: (prefix?: string) => listMockPaths(mockPaths, prefix),
      readPath: async () => new Uint8Array(),
      hasPath: () => true,
      hasPrefix: () => true,
    } as unknown as CascReader

    const reader = new CascInstallReader(casc)

    await expect(
      reader.list('mods/liberty.sc2mod/base.sc2assets/assets/units/terran/marine'),
    ).resolves.toEqual(['marine.m3'])
    const terran = await reader.list('mods/liberty.sc2mod/base.sc2assets/assets/units/terran')
    expect(terran.sort()).toEqual([
      'marine/marine.m3',
      'marine_blackops/marine_blackops.m3',
      'marine_remastered/marine_remastered.m3',
      'marinedeath/marinedeath.m3',
    ])
  })

  it('can reject non-local CASC reads without calling readPath', async () => {
    const casc = {
      listPaths: (prefix?: string) =>
        listMockPaths(['mods/example.sc2mod/local.txt', 'mods/example.sc2mod/missing.txt'], prefix),
      readPath: async (path: string) => {
        if (path.endsWith('missing.txt')) throw new Error('should not fetch missing path')
        return new TextEncoder().encode('local')
      },
      hasPath: (path: string) => path.endsWith('local.txt'),
      hasPrefix: () => true,
    } as unknown as CascReader

    const reader = new CascInstallReader(casc).asLocalOnly()

    await expect(reader.get('mods/example.sc2mod/local.txt')).resolves.toEqual(
      new TextEncoder().encode('local'),
    )
    await expect(reader.get('mods/example.sc2mod/missing.txt')).rejects.toThrow(
      'not available locally',
    )
  })
})
