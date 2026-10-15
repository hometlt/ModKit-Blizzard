import { describe, it, expect } from 'vitest'
import { CBoolean, CNumber, CString, CLink } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.primitives.js'
import { CEnum, CFlags } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.core.js'
import { Int, Real, UReal, Int32, UInt, UInt8, CGameTime, CGameRate, CString4, CString32 } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.types.js'
import { CActorLink, CUnitLink, CEffectLink, CWeaponLink, CAbilLink, CBehaviorLink } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.links.js'
import { CTargetFilters, CATALOG_DATA_TYPES } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.complex.js'
import { DATA_CLASS_SCHEMA } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.classes.js'
import { ETargetFilter, EGameCatalog, ETypeId } from '../../../shared/catalog-engine/sc2-schema/structure-types/schema.enums.js'

// ─────────────────────────────────────────────────────────────────────────────
// Primitive scalar types
// ─────────────────────────────────────────────────────────────────────────────
describe('CBoolean', () => {
  it('fromString "1" → true', () => expect(new CBoolean().fromString('1')).toBe(true))
  it('fromString "0" → false', () => expect(new CBoolean().fromString('0')).toBe(false))
  it('toString true → "1"', () => expect(new CBoolean().toString(true)).toBe('1'))
  it('toString false → "0"', () => expect(new CBoolean().toString(false)).toBe('0'))
})

describe('CNumber / Int / Real / UInt', () => {
  it('Int.fromString parses integer', () => expect(new Int().fromString('42')).toBe(42))
  it('Real.fromString parses float', () => expect(new Real().fromString('3.14')).toBeCloseTo(3.14))
  it('UInt validates non-negative', () => {
    expect(new UInt().validate(0)).toBe(true)
    expect(new UInt().validate(-1)).toBe(false)
  })
  it('UInt8 rejects out-of-range', () => {
    expect(new UInt8().validate(255)).toBe(true)
    expect(new UInt8().validate(256)).toBe(false)
  })
  it('Int32 validates signed 32-bit range', () => {
    expect(new Int32().validate(2147483647)).toBe(true)
    expect(new Int32().validate(2147483648)).toBe(false)
    expect(new Int32().validate(-2147483648)).toBe(true)
  })
  it('Real accepts float values', () => {
    expect(new Real().validate(1.5)).toBe(true)
    expect(new Real().validate(-0.001)).toBe(true)
  })
  it('Int rejects float', () => expect(new Int().validate(1.5)).toBe(false))
})

describe('CGameTime / CGameRate', () => {
  it('CGameTime.fromString parses as float', () => {
    expect(new CGameTime().fromString('22.4')).toBeCloseTo(22.4)
  })
  it('CGameTime rejects negative', () => {
    expect(new CGameTime().validate(-1)).toBe(false)
    expect(new CGameTime().validate(0)).toBe(true)
  })
  it('CGameRate.fromString', () => {
    expect(new CGameRate().fromString('1.0')).toBeCloseTo(1.0)
  })
})

describe('CString', () => {
  it('fromString passes through plain string', () => {
    expect(new CString().fromString('Marine')).toBe('Marine')
  })
  it('validate rejects when maxlength exceeded', () => {
    const t = new CString4()
    expect(t.validate('ZERG')).toBe(true)
    expect(t.validate('TOOLONG')).toBe(false)
  })
  it('CString32 accepts string up to 32 chars', () => {
    const t = new CString32()
    expect(t.validate('a'.repeat(32))).toBe(true)
    expect(t.validate('a'.repeat(33))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CEnum
// ─────────────────────────────────────────────────────────────────────────────
describe('CEnum', () => {
  const EColor = CEnum.Ex({ Red: 0, Green: 1, Blue: 2 })

  it('fromString accepts valid enum string', () => {
    const e = new EColor()
    expect(e.fromString('Red')).toBe('Red')
    expect(e.fromString('Blue')).toBe('Blue')
  })

  it('fromString converts integer index to name', () => {
    const e = new EColor()
    expect(e.fromString('1')).toBe('Green')
  })

  it('validate accepts known value', () => {
    const e = new EColor()
    expect(e.validate('Red')).toBe(true)
    expect(e.validate('Yellow')).toBe(false)
  })

  it('validate accepts -1 as Unknown sentinel', () => {
    const e = new EColor()
    expect(e.validate('Unknown')).toBe(true)
  })

  it('FromArray creates enum from string array', () => {
    const EDir = CEnum.FromArray(['North', 'South', 'East', 'West'])
    const d = new EDir()
    expect(d.fromString('North')).toBe('North')
    expect(d.fromString('0')).toBe('North')
    expect(d.fromString('3')).toBe('West')
  })

  it('ETargetFilter is a valid CEnum (has enum list)', () => {
    const e = new ETargetFilter()
    expect(Array.isArray(e.enum)).toBe(true)
    expect(e.enum!.length).toBeGreaterThan(0)
    expect(e.enum).toContain('Ground')
    expect(e.enum).toContain('Air')
  })

  it('EGameCatalog contains Abil and Unit', () => {
    const e = new EGameCatalog()
    expect(e.enum).toContain('Abil')
    expect(e.enum).toContain('Unit')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CFlags
// ─────────────────────────────────────────────────────────────────────────────
describe('CFlags', () => {
  const FColor = CFlags.Ex(['Red', 'Green', 'Blue'])

  it('fromString parses semicolon-separated flags', () => {
    const result = new FColor().fromString('Red;Blue')
    expect(result).toMatchObject({ Red: true, Blue: true })
  })

  it('toString serialises active flags', () => {
    const f = new FColor()
    const result = f.toString({ Red: true, Green: false, Blue: true })
    const parts = result.split(';').sort()
    expect(parts).toEqual(['Blue', 'Red'])
  })

  it('fromString empty string yields empty record', () => {
    const result = new FColor().fromString('')
    expect(Object.keys(result).length).toBe(0)
  })

  it('CTargetFilters parses Ground;Air', () => {
    const result = new CTargetFilters().fromString('Ground;Air')
    expect(result).toMatchObject({ Ground: true, Air: true })
  })

  it('CTargetFilters toString round-trips', () => {
    const t = new CTargetFilters()
    const flags = t.fromString('Ground;Structure')
    const back = t.toString(flags)
    const parts = back.split(';').sort()
    expect(parts).toEqual(['Ground', 'Structure'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLink subclasses — static link property
// ─────────────────────────────────────────────────────────────────────────────
describe('CLink static link', () => {
  it('CActorLink.link === "Actor"', () => expect(CActorLink.link).toBe('Actor'))
  it('CUnitLink.link === "Unit"', () => expect(CUnitLink.link).toBe('Unit'))
  it('CEffectLink.link === "Effect"', () => expect(CEffectLink.link).toBe('Effect'))
  it('CWeaponLink.link === "Weapon"', () => expect(CWeaponLink.link).toBe('Weapon'))
  it('CAbilLink.link === "Abil"', () => expect(CAbilLink.link).toBe('Abil'))
  it('CBehaviorLink.link === "Behavior"', () => expect(CBehaviorLink.link).toBe('Behavior'))

  it('CLink.Ex creates subclass with correct link', () => {
    const CCustomLink = CLink.Ex('CustomNS')
    expect(CCustomLink.link).toBe('CustomNS')
  })

  it('CLink.FromNamespace caches and reuses', () => {
    const a = CLink.FromNamespace('TestNS')
    const b = CLink.FromNamespace('TestNS')
    expect(a).toBe(b)
    expect(a.link).toBe('TestNS')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG_DATA_TYPES — key coverage
// ─────────────────────────────────────────────────────────────────────────────
describe('CATALOG_DATA_TYPES', () => {
  it('contains basic numeric types', () => {
    expect('Int' in CATALOG_DATA_TYPES).toBe(true)
    expect('Real' in CATALOG_DATA_TYPES).toBe(true)
    expect('UInt' in CATALOG_DATA_TYPES).toBe(true)
    expect('Int32' in CATALOG_DATA_TYPES).toBe(true)
  })

  it('contains SC2-specific time and rate types', () => {
    expect('CGameTime' in CATALOG_DATA_TYPES).toBe(true)
    expect('CGameRate' in CATALOG_DATA_TYPES).toBe(true)
    expect('CGameAcceleration' in CATALOG_DATA_TYPES).toBe(true)
  })

  it('contains string types', () => {
    expect('CString' in CATALOG_DATA_TYPES).toBe(true)
    expect('CString4' in CATALOG_DATA_TYPES).toBe(true)
    expect('CString32' in CATALOG_DATA_TYPES).toBe(true)
  })

  it('contains link types', () => {
    expect('CActorCreateKey' in CATALOG_DATA_TYPES).toBe(true)
    expect('CActorLabelKey' in CATALOG_DATA_TYPES).toBe(true)
  })

  it('ETypeId enum contains same keys as CATALOG_DATA_TYPES', () => {
    const catalogKeys = new Set(Object.keys(CATALOG_DATA_TYPES))
    const enumKeys = (new ETypeId().enum ?? []) as string[]
    for (const k of enumKeys) {
      expect(catalogKeys.has(k)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DATA_CLASS_SCHEMA — catalog class registry
// ─────────────────────────────────────────────────────────────────────────────
describe('DATA_CLASS_SCHEMA', () => {
  it('contains all major namespaces', () => {
    expect('CUnit' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CActor' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CAbil' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CEffect' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CWeapon' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CBehavior' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CUpgrade' in DATA_CLASS_SCHEMA).toBe(true)
    expect('CButton' in DATA_CLASS_SCHEMA).toBe(true)
  })

  it('CUnit schema has LifeMax field', () => {
    const schema = DATA_CLASS_SCHEMA.CUnit.getMergedSchema()
    expect('LifeMax' in schema).toBe(true)
  })

  it('CUnit schema has WeaponArray field', () => {
    const schema = DATA_CLASS_SCHEMA.CUnit.getMergedSchema()
    expect('WeaponArray' in schema).toBe(true)
  })

  it('CAbil schema has Name and EditorCategories', () => {
    const schema = DATA_CLASS_SCHEMA.CAbil.getMergedSchema()
    expect('Name' in schema).toBe(true)
    expect('EditorCategories' in schema).toBe(true)
  })

  it('CActor schema has Terms and Flags fields', () => {
    const schema = DATA_CLASS_SCHEMA.CActor.getMergedSchema()
    expect('Terms' in schema).toBe(true)
    expect('Flags' in schema).toBe(true)
  })

  it('CActorBase schema has On and Remove event fields', () => {
    const schema = DATA_CLASS_SCHEMA.CActorBase.getMergedSchema()
    expect('On' in schema).toBe(true)
    expect('Remove' in schema).toBe(true)
  })

  it('CWeapon schema has Range and Period fields', () => {
    const schema = DATA_CLASS_SCHEMA.CWeapon.getMergedSchema()
    expect('Range' in schema).toBe(true)
    expect('Period' in schema).toBe(true)
  })

  it('DATA_CLASS_SCHEMA has hundreds of entries', () => {
    expect(Object.keys(DATA_CLASS_SCHEMA).length).toBeGreaterThan(200)
  })
})
