import { describe, it, expect } from 'vitest'
import { tokenTypeNamespace, LINK_CLASS_NAMESPACES } from '../../../shared/catalog-engine/sc2-schema/index.js'

describe('tokenTypeNamespace', () => {
  it('resolves catalog CLink subclass names to their namespace', () => {
    expect(tokenTypeNamespace('CUnitLink')).toBe('Unit')
    expect(tokenTypeNamespace('CEffectLink')).toBe('Effect')
    expect(tokenTypeNamespace('CBehaviorLink')).toBe('Behavior')
    expect(tokenTypeNamespace('CActorLink')).toBe('Actor')
    expect(tokenTypeNamespace('CModelLink')).toBe('Model')
    expect(tokenTypeNamespace('CWeaponLink')).toBe('Weapon')
    expect(tokenTypeNamespace('CConstLink')).toBe('Const')
  })

  it('treats a missing type as a plain string (the default) — not a link', () => {
    expect(tokenTypeNamespace(undefined)).toBeUndefined()
    expect(tokenTypeNamespace(null)).toBeUndefined()
    expect(tokenTypeNamespace('')).toBeUndefined()
  })

  it('ignores links to non-catalog namespaces', () => {
    expect(tokenTypeNamespace('CStringLink')).toBeUndefined() // String
    expect(tokenTypeNamespace('CHotkeyLink')).toBeUndefined() // Hotkey
    expect(tokenTypeNamespace('CTokenLink')).toBeUndefined()  // Token
    expect(tokenTypeNamespace('CTexturePath')).toBeUndefined() // file type
  })

  it('matches type names exactly (SC2 type names are case-sensitive)', () => {
    expect(tokenTypeNamespace('CUNITLINK')).toBeUndefined()
    expect(tokenTypeNamespace('cunitlink')).toBeUndefined()
  })

  it('returns undefined for unknown type names', () => {
    expect(tokenTypeNamespace('Nonsense')).toBeUndefined()
  })

  it('is derived from the declared link classes (no hardcoded token table)', () => {
    expect(Object.keys(LINK_CLASS_NAMESPACES).length).toBeGreaterThan(100)
    expect(LINK_CLASS_NAMESPACES['CUnitLink']).toBe('Unit')
  })
})
