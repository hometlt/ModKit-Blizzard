import { describe, it, expect } from 'vitest'
import { TypedCatalog } from '../../../shared/catalog-engine/sc2-catalog'
import { createBuiltinRegistry } from '../../../shared/catalog-engine/sc2-schema'
import { parseCatalogXml } from '../../../shared/catalog-engine/xml/index.js'
import { SC2Mod } from '../../../../mod/shared/core/index.js'
import { exportWikiData } from '../../../shared/format/wiki/wiki.js'

// A small synthetic mod exercising the full pipeline:
//   parent-chain merge → resolveEntityTyped → coerceBySchema → wiki structure.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="BaseUnit">
    <FlagArray index="PreventDestroy" value="1"/>
    <PlaneArray index="Ground" value="1"/>
  </CUnit>
  <CUnit id="Marine" parent="BaseUnit">
    <LifeMax value="45"/>
    <Food value="-1"/>
    <Speed value="2.25"/>
    <Race value="Terr"/>
    <Mob value="Multiplayer"/>
    <CostCategory value="Army"/>
    <FlagArray index="ArmySelect" value="1"/>
    <CostResource index="Minerals" value="50"/>
    <AbilArray Link="stop"/>
    <AbilArray Link="attack"/>
    <EditorCategories value="ObjectType:Unit,ObjectFamily:Melee"/>
  </CUnit>
  <CWeaponLegacy id="GuassRifle">
    <Range value="5"/>
  </CWeaponLegacy>
</Catalog>`

function makeMod(): SC2Mod {
  const catalog = new TypedCatalog({ schema: createBuiltinRegistry() })
  catalog.loadFromFiles([parseCatalogXml(XML)])
  const locales = new Map<string, Map<string, Map<string, string>>>([
    ['enus', new Map()], ['dede', new Map()], ['zhcn', new Map()],
  ])
  return new SC2Mod(catalog, [], locales as any)
}

describe('exportWikiData', () => {
  const data = exportWikiData(makeMod())
  const marine = (data['Data.Unit'] as any).Marine

  it('produces Data.<Ns> buckets and Mod metadata', () => {
    expect(data['Data.Unit']).toBeTruthy()
    expect(data['Data.Weapon']).toBeTruthy()
    expect((data['Mod'] as any).locales).toEqual(['deDE', 'enUS', 'zhCN'])
  })

  it('coerces Marine scalar fields to numbers / strings', () => {
    expect(marine.LifeMax).toBe(45)
    expect(marine.Food).toBe(-1)
    expect(marine.Speed).toBe(2.25)
    expect(marine.Race).toBe('Terr')
    expect(marine.Mob).toBe('Multiplayer')
    expect(marine.CostCategory).toBe('Army')
  })

  it('merges parent-chain flags and coerces flags/records/structs', () => {
    // BaseUnit (PreventDestroy, Ground) merged with Marine (ArmySelect)
    expect(marine.FlagArray).toEqual({ PreventDestroy: true, ArmySelect: true })
    expect(marine.PlaneArray).toEqual({ Ground: true })
    expect(marine.CostResource).toEqual({ Minerals: 50 })
    expect(marine.AbilArray).toEqual([{ Link: 'stop' }, { Link: 'attack' }])
    expect(marine.EditorCategories).toEqual({ ObjectType: 'Unit', ObjectFamily: 'Melee' })
  })

  it('omits the default class but keeps non-default classes', () => {
    expect('class' in marine).toBe(false)                       // CUnit is default for Unit
    expect((data['Data.Weapon'] as any).GuassRifle.class).toBe('CWeaponLegacy')
  })

  it('does not leak resolved {value,index} wrappers', () => {
    expect(JSON.stringify(marine)).not.toMatch(/"value":"[^"]*","index"/)
  })
})
