import { describe, it, expect } from 'vitest'
import { SchemaRegistry, createBuiltinRegistry } from '../../../shared/catalog-engine/sc2-schema/index.js'

describe('SchemaRegistry', () => {
  it('returns undefined for unknown type', () => {
    const reg = new SchemaRegistry()
    expect(reg.get('CUnknown')).toBeUndefined()
  })

  it('resolves builtin CUnit schema', () => {
    const reg = createBuiltinRegistry()
    const unit = reg.get('CUnit')
    expect(unit).toBeDefined()
    expect(unit!.fields['WeaponArray']).toBeDefined()
    expect(unit!.fields['WeaponArray']!.isArray).toBe(true)
    expect(unit!.fields['WeaponArray']!.arrayMerge).toBe('indexed')
  })

  it('inherits fields from parent chain', () => {
    const reg = new SchemaRegistry()
    reg.register({ name: 'CBase', fields: { Id: { isArray: false, isLink: false } } })
    reg.register({
      name: 'CUnit',
      parent: 'CBase',
      fields: { Life: { isArray: false, isLink: false } },
    })
    const resolved = reg.resolveFields('CUnit')
    expect(resolved['Id']).toBeDefined()
    expect(resolved['Life']).toBeDefined()
  })

  it('inheritanceChain returns root-first order', () => {
    const reg = createBuiltinRegistry()
    const chain = reg.inheritanceChain('CUnit')
    expect(chain[0]!.name).toBe('CBase')
    expect(chain[chain.length - 1]!.name).toBe('CUnit')
  })
})

describe('typeToNamespace', () => {
  it('maps CUnit → Unit', async () => {
    const { typeToNamespace } = await import('../../../shared/catalog-engine/sc2-schema/namespaces.js')
    expect(typeToNamespace('CUnit')).toBe('Unit')
  })

  it('maps CAbilResearch → Abil', async () => {
    const { typeToNamespace } = await import('../../../shared/catalog-engine/sc2-schema/namespaces.js')
    expect(typeToNamespace('CAbilResearch')).toBe('Abil')
  })
})
