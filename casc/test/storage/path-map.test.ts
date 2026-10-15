import { describe, expect, it } from 'vitest'
import {
  createCascPathAliases,
  createCascPathMap,
  normalizeCascPath,
  parseCascListfile,
} from '../../src/casc/path-map.js'

describe('CASC path maps', () => {
  it('normalizes slash, colon, case, and edge separators', () => {
    expect(normalizeCascPath('/Mods/Core.SC2Mod:Base.SC2Data/GameData\\Foo.XML')).toBe(
      'mods\\core.sc2mod\\base.sc2data\\gamedata\\foo.xml',
    )
  })

  it('creates normalized file-data-id maps', () => {
    const map = createCascPathMap({ 'Mods/Core.SC2Mod/Base.SC2Data/GameData.xml': 7 })
    expect(map.get('mods\\core.sc2mod\\base.sc2data\\gamedata.xml')).toBe(7)
  })

  it('creates normalized aliases', () => {
    const aliases = createCascPathAliases({ 'Textures/Foo.blp': 'Assets/Foo.dds' })
    expect(aliases.get('textures\\foo.blp')).toBe('assets\\foo.dds')
  })

  it('parses semicolon listfiles with either id column order', () => {
    const map = parseCascListfile(
      [
        '# comment',
        '0007;Mods/Core.SC2Mod/Base.SC2Data/GameData.xml',
        'Mods/Core.SC2Mod/Base.SC2Data/LocalizedData/GameStrings.txt;8',
        'path-only-entry-is-ignored',
      ].join('\n'),
    )

    expect(map.get('mods\\core.sc2mod\\base.sc2data\\gamedata.xml')).toBe(7)
    expect(map.get('mods\\core.sc2mod\\base.sc2data\\localizeddata\\gamestrings.txt')).toBe(8)
  })

  it('parses comma and tab separated file-data-id listfiles', () => {
    const map = parseCascListfile(
      [
        'FileDataID,Filename',
        '9,"Mods/Core.SC2Mod/Base.SC2Data/GameData/AbilData.xml"',
        'Mods/Core.SC2Mod/Base.SC2Data/GameData/ActorData.xml\t10',
      ].join('\n'),
    )

    expect(map.get('mods\\core.sc2mod\\base.sc2data\\gamedata\\abildata.xml')).toBe(9)
    expect(map.get('mods\\core.sc2mod\\base.sc2data\\gamedata\\actordata.xml')).toBe(10)
  })
})
