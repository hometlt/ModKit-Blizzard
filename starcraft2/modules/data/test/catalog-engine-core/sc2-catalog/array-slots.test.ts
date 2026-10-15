/**
 * How a declaration's list meets the list it inherits: SC2 gives every bare element the next slot
 * of its declaration (an explicit `index="N"` takes slot N), elements meet by slot, and
 * `removed="1"` deletes a slot. Cases are the shapes the installed data uses (Liberty
 * `Validator/IsConstructionUnderFire`, `Unit/ChangelingMarine`).
 */
import { describe, expect, it } from 'vitest'
import { parseCatalogXml } from '../../../shared/catalog-engine/xml/index.js'
import { TypedCatalog } from '../../../shared/catalog-engine/sc2-catalog/index.js'
import { createBuiltinRegistry } from '../../../shared/catalog-engine/sc2-schema/index.js'

function catalog(...files: string[]): TypedCatalog {
  const value = new TypedCatalog({ schema: createBuiltinRegistry() })
  value.loadFromFiles(files.map(text => parseCatalogXml(`<Catalog>${text}</Catalog>`)))
  return value
}

describe('catalog list slots', () => {
  it('lets a bare child element take slot 0 of the inherited list', () => {
    const resolved = catalog(`
      <CValidatorCombine id="IsUnderFire">
        <CombineArray value="TargetInCombat"/><CombineArray value="TargetLastDamagedByEnemy"/>
      </CValidatorCombine>
      <CValidatorCombine id="IsConstructionUnderFire" parent="IsUnderFire">
        <CombineArray value="IsConstructing"/>
      </CValidatorCombine>`).getResolved('Validator', 'IsConstructionUnderFire')
    expect(resolved?.['CombineArray']).toEqual(['IsConstructing', 'TargetLastDamagedByEnemy'])
  })

  it('replaces a scalar filter rather than listing both spellings', () => {
    const resolved = catalog(`
      <CWeaponLegacy id="Base"><TargetFilters value="Visible;-"/></CWeaponLegacy>
      <CWeaponLegacy id="Cannon" parent="Base"><TargetFilters value="Ground,Visible;Missile"/></CWeaponLegacy>`)
      .getResolved('Weapon', 'Cannon')
    expect([resolved?.['TargetFilters']].flat()).toEqual(['Ground,Visible;Missile'])
  })

  it('deletes removed slots, bare or indexed, in keyed and appended lists', () => {
    const resolved = catalog(`
      <CUnit id="Marine">
        <AbilArray Link="stop"/><AbilArray Link="move"/><AbilArray Link="attack"/>
        <GlossaryStrongArray value="Marauder"/><GlossaryStrongArray value="Hydralisk"/>
      </CUnit>
      <CUnit id="ChangelingMarine" parent="Marine">
        <AbilArray index="2" removed="1"/>
        <GlossaryStrongArray removed="1"/><GlossaryStrongArray removed="1"/>
      </CUnit>`).getResolved('Unit', 'ChangelingMarine')
    expect((resolved?.['AbilArray'] as { Link: string }[]).map(item => item.Link)).toEqual(['stop', 'move'])
    expect([resolved?.['GlossaryStrongArray'] ?? []].flat()).toEqual([])
  })

  it('keeps sparse slots and the slots after a removal where they were', () => {
    const value = catalog(`
      <CCliffMesh id="Base"><CliffHeights index="0" value="-8"/><CliffHeights index="2" value="2"/></CCliffMesh>
      <CCliffMesh id="Agria" parent="Base"><CliffHeights index="3" value="4"/></CCliffMesh>
      <CValidatorCombine id="List"><CombineArray value="A"/><CombineArray value="B"/><CombineArray value="C"/></CValidatorCombine>
      <CValidatorCombine id="Shorter" parent="List"><CombineArray index="1" removed="1"/></CValidatorCombine>`)
    expect(value.getResolved('CliffMesh', 'Agria')?.['CliffHeights'])
      .toEqual(['-8', { index: '2', value: '2' }, '4'])
    expect(value.getResolved('Validator', 'Shorter')?.['CombineArray']).toEqual(['A', { index: '2', value: 'C' }])
  })

  it('keeps later slots where they were after a removal in an earlier file', () => {
    const resolved = catalog(
      `<CValidatorCombine id="Base">
        <CombineArray value="A"/><CombineArray value="B"/><CombineArray value="C"/>
      </CValidatorCombine>
      <CValidatorCombine id="Child" parent="Base"><CombineArray index="0" removed="1"/></CValidatorCombine>`,
      `<CValidatorCombine id="Child"><CombineArray index="1" value="Z"/></CValidatorCombine>`,
    ).getResolved('Validator', 'Child')
    expect(resolved?.['CombineArray']).toEqual([{ index: '1', value: 'Z' }, 'C'])
  })
})
