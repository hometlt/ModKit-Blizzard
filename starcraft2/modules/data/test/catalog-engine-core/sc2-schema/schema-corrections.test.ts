/**
 * Corrections to the ported MK2 structure-types schema, each verified against the installed
 * SC2 5.0 data: EditorCatalogStrings.txt (EDSTR_ENUMVAL_e_*), core TriggerLibs Galaxy constants,
 * the recovered editor binary schema and shipped GameData XML.
 * See reports/SC2DATA_MODULE_SCHEMA_DISCREPANCIES_RU.md.
 */
import { describe, expect, it } from 'vitest'
import { DATA_CLASS_SCHEMA } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.classes.js'
import { SCost, SModification } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.struct.js'
import { CEnum, CFlags } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.core.js'
import { classifyField, validateFieldValue } from '../../../shared/catalog-engine/sc2-catalog/index.js'
import { CModelFile, CImageLink } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.links.js'

const fieldsOf = (cls: string) => (DATA_CLASS_SCHEMA as Record<string, { schema: Record<string, any> }>)[cls]!.schema
const members = (t: any): readonly string[] => t.list ?? t.enum

describe('structure-types schema corrections', () => {
  it('uses an M3 file for a road material and an image for its editor icon', () => {
    // Accepted native CTile road profile and pinned Open Realm CTile→M3 loading agree.
    expect(fieldsOf('CTile').Material).toBe(CModelFile)
    expect(fieldsOf('CTile').EditorIcon).toBe(CImageLink)
  })
  it('uses the engine field names (KineticArray, TacticalAIFunc)', () => {
    for (const cls of ['CKineticSet', 'CKineticSequence']) {
      expect(fieldsOf(cls)).toHaveProperty('KineticArray')
      expect(fieldsOf(cls)).not.toHaveProperty('Kinetiarray')
    }
    expect(fieldsOf('CAbil')).toHaveProperty('TacticalAIFunc')
    expect(fieldsOf('CAbil')).not.toHaveProperty('TafcticalAIFunc')
  })

  it('types SCost.Display as resource flags and CVoicePack.LocaleRestriction as a FourCC', () => {
    expect(SCost.schema.Display.prototype).toBeInstanceOf(CFlags)
    expect(classifyField(fieldsOf('CVoicePack').LocaleRestriction).kind).not.toBe('enum')
  })

  it('indexes fields by the enum the shipped XML actually uses', () => {
    expect(members(fieldsOf('CGame').AttackArmorTable.index)).toEqual(
      expect.arrayContaining(['Spell', 'Normal', 'Pierce', 'Siege', 'Magic', 'Chaos', 'Hero']),
    )
    expect(members(fieldsOf('CGameUI').CostDisplayColor.index)).toEqual(
      expect.arrayContaining(['Minerals', 'Life', 'Shields', 'Energy']),
    )
    expect(members(SModification.schema.SoundArray.index)).toEqual(expect.arrayContaining(['What', 'Yes']))
    expect(members(fieldsOf('CAbilArmMagazine').EffectArray.index)).toContain('Recall')
    expect(members(fieldsOf('CEffectLaunchMissile').SearchFlags)).toEqual(['DynamicSearchArea', 'ArriveOnSearchHit'])
  })

  it('carries complete engine enums instead of observed subsets', () => {
    expect(members(fieldsOf('CAbil').AbilityCategories)).toHaveLength(21)
    expect(members(fieldsOf('CAbil').AbilityCategories)).toContain('CanBeSilenced')
    expect(members(fieldsOf('CEffectIssueOrder').CmdFlags)).toEqual(expect.arrayContaining(['AttackOnce', 'SmartRally', 'ToSelection']))
    expect(members(fieldsOf('CAbilResearch').Flags)).toEqual(
      expect.arrayContaining(['BestUnit', 'Transient', 'UnitOrderQueue', 'SmartRequirement']),
    )
    expect(members(fieldsOf('CItem').Flags)).toContain('IncludeInLootItemPool')
    expect(members(fieldsOf('CEffectRemoveBehavior').Heroic)).toEqual(['Any', 'Heroic', 'NonHeroic'])
    expect(members(fieldsOf('CConversation').ProductionLevel)).toEqual(['0', '1', '2', '3', '4'])
  })

  it('completes enums reachable only through their field names in the editor strings', () => {
    // e_weaponOption*, e_buttonTooltipFlag*, e_scoreValueFlag*, e_effectCreepFlag*, e_objectiveReward*
    // Blizzard's own spelling of the engine value (e_weaponOptionHoldFileInShrubs).
    expect(members(fieldsOf('CWeapon').Options)).toContain('HoldFileInShrubs')
    expect(members(fieldsOf('CButton').TooltipFlags)).toEqual(expect.arrayContaining(['ShowDuration', 'ShowRange']))
    expect(members(fieldsOf('CScoreValue').Flags)).toEqual(expect.arrayContaining(['Hidden', 'ProfileStat']))
    expect(members(fieldsOf('CEffectCreep').CreepFlags)).toEqual(expect.arrayContaining(['Permanent', 'RemoveCreep']))
    expect(members(fieldsOf('CObjective').RewardArray.index)).toEqual(expect.arrayContaining(['Mutagen', 'DNA']))
  })

  it('keeps Galaxy positional order and drops values the engine does not define', () => {
    // c_unitCollideLand1 = 0, c_unitCollideAir1 = 16; c_resourceTypeCustom = 3; c_soundCategoryTest = 0.
    const collide = members(fieldsOf('CUnit').Collide)
    expect([collide.indexOf('Land1'), collide.indexOf('Air1')]).toEqual([0, 16])
    expect(members(fieldsOf('CUnit').CostResource.index)).toEqual(['Minerals', 'Vespene', 'Terrazine', 'Custom'])
    expect(members(fieldsOf('CSound').Category)[0]).toBe('Test')
  })

  it('treats an empty member list as unknown rather than as "nothing is allowed"', () => {
    const info = classifyField(CEnum.FromArray([]))
    expect(info.enumMembers).toBeUndefined()
    expect(validateFieldValue(info, 'AnyMapDefinedName')).toBeUndefined()
    expect(validateFieldValue(classifyField(fieldsOf('CUnit').UserFlagArray), 'CanSleep')).toBeUndefined()
  })
})

describe('class-id sentinels', () => {
  it('accepts the editor "None" sentinels CAbilUnknown and CBehaviorUnknown', () => {
    expect(validateFieldValue(classifyField(fieldsOf('CValidatorUnitAbil').AbilClass), 'CAbilUnknown')).toBeUndefined()
    expect(validateFieldValue(classifyField(fieldsOf('CEffectRemoveBehavior').BehaviorClass), 'CBehaviorUnknown')).toBeUndefined()
    expect(validateFieldValue(classifyField(fieldsOf('CValidatorUnitAbil').AbilClass), 'Unknown')).toBeDefined()
  })
})
