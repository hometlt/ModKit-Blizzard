import { describe, it, expect } from 'vitest'
import { MndxNameDb } from '../../src/casc/mndx.js'

describe('MndxNameDb cache serialize/deserialize', () => {
  const files = [
    {
      path: 'mods/core.sc2mod/base.sc2data/GameData/UnitData.xml',
      contentKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      contentSize: 1234,
      packageIndex: 1,
    },
    {
      path: 'mods/void.sc2mod/base.sc2assets/assets/textures/foo.dds',
      contentKey: '00112233445566778899aabbccddeeff',
      contentSize: 5242880,
      packageIndex: 2,
    },
    {
      path: 'Mods/Core.SC2Mod/DocumentHeader',
      contentKey: 'ffffffffffffffffffffffffffffffff',
      contentSize: 0,
      packageIndex: 0,
    },
  ]

  it('round-trips file count, paths, keys, and lookups', () => {
    const db = MndxNameDb.fromEntries(files)
    const restored = MndxNameDb.deserialize(db.serialize())
    expect(restored.size).toBe(db.size)
    expect(restored.listPaths()).toEqual(db.listPaths())
    for (const f of files) {
      const r = restored.getByPath(f.path)
      expect(r?.contentKey).toBe(f.contentKey)
      expect(r?.contentSize).toBe(f.contentSize)
      expect(r?.packageIndex).toBe(f.packageIndex)
    }
    // Case-insensitive lookup (mixed-case path) still resolves.
    expect(
      restored.getByPath('MODS/CORE.SC2MOD/BASE.SC2DATA/GAMEDATA/UNITDATA.XML')?.contentKey,
    ).toBe(files[0]!.contentKey)
    expect(restored.hasPrefix('mods/void.sc2mod')).toBe(true)
    expect(restored.listPaths('mods/core.sc2mod')).toEqual([
      'DocumentHeader',
      'base.sc2data/GameData/UnitData.xml',
    ])
  })

  it('rejects a corrupt / foreign cache blob', () => {
    expect(() => MndxNameDb.deserialize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow()
  })
})
