import { describe, it, expect } from 'vitest'
import { DATA_CLASS_SCHEMA } from '../../../shared/catalog-engine/sc2-schema'
import { coerceBySchema } from '../../../shared/format/wiki/coerce.js'

const U = (DATA_CLASS_SCHEMA as any).CUnit.getMergedSchema()

describe('coerceBySchema', () => {
  it('coerces numbers (int / negative / real)', () => {
    expect(coerceBySchema('45', U.LifeMax)).toBe(45)
    expect(coerceBySchema('-1', U.Food)).toBe(-1)
    expect(coerceBySchema('2.25', U.Speed)).toBe(2.25)
  })

  it('coerces CFlags arrays to {name:boolean}, keeping explicit false', () => {
    expect(coerceBySchema(
      [{ value: '1', index: 'PreventDestroy' }, { value: '1', index: 'ArmySelect' }], U.FlagArray,
    )).toEqual({ PreventDestroy: true, ArmySelect: true })
    expect(coerceBySchema(
      [{ value: '1', index: 'A' }, { value: '0', index: 'B' }], U.FlagArray,
    )).toEqual({ A: true, B: false })
  })

  it('coerces CFlags from a ";"-separated string', () => {
    expect(coerceBySchema('Ground;Air', U.FlagArray)).toEqual({ Ground: true, Air: true })
  })

  it('coerces CRecord arrays to {index: value} with the value typed', () => {
    expect(coerceBySchema([{ value: '50', index: 'Minerals' }], U.CostResource))
      .toEqual({ Minerals: 50 })
    expect(coerceBySchema(
      [{ value: '50', index: 'Minerals' }, { value: '25', index: 'Vespene' }], U.CostResource,
    )).toEqual({ Minerals: 50, Vespene: 25 })
  })

  it('leaves enums / links / text-keys as strings', () => {
    expect(coerceBySchema('Terr', U.Race)).toBe('Terr')
    expect(coerceBySchema('Multiplayer', U.Mob)).toBe('Multiplayer')
    expect(coerceBySchema('Unit/LifeArmorName/TerranInfantryArmor', U.LifeArmorName))
      .toBe('Unit/LifeArmorName/TerranInfantryArmor')
  })

  it('coerces an array of struct items, keeping composite-scalar strings verbatim', () => {
    expect(coerceBySchema([{ Link: 'stop' }, { Link: 'move' }], U.AbilArray))
      .toEqual([{ Link: 'stop' }, { Link: 'move' }])
    // nested struct: numeric Row/Column coerced, AbilCmd ("a,b") kept as string
    expect(coerceBySchema(
      [{ LayoutButtons: [{ Face: 'Move', Type: 'AbilCmd', AbilCmd: 'move,Move', Row: '0', Column: '1' }] }],
      U.CardLayouts,
    )).toEqual([{ LayoutButtons: [{ Face: 'Move', Type: 'AbilCmd', AbilCmd: 'move,Move', Row: 0, Column: 1 }] }])
  })

  it('parses CSObject "K:V,K:V" into an object', () => {
    expect(coerceBySchema('ObjectType:Unit,ObjectFamily:Melee', U.EditorCategories))
      .toEqual({ ObjectType: 'Unit', ObjectFamily: 'Melee' })
  })

  it('prunes empties', () => {
    expect(coerceBySchema('', U.LifeMax)).toBeUndefined()
    expect(coerceBySchema([], U.AbilArray)).toBeUndefined()
    expect(coerceBySchema([{ value: '', index: '' }], U.CostResource)).toBeUndefined()
  })
})
