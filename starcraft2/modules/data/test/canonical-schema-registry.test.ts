import { describe, expect, it } from 'vitest'
import { createStarcraft2CatalogRegistry } from '../services/schema/catalog-registry.js'
import { resolveStarcraft2SchemaFields } from '../services/schema/full-data-schema.js'
import { createBuiltinRegistry } from '../shared/catalog-engine/sc2-schema/builtin.js'
import { createLinkRegistry } from '../shared/catalog-engine/sc2-schema/link-registry.js'
import { TypedCatalog } from '../shared/catalog-engine/sc2-catalog/catalog.js'
import { parseCatalogXml } from '../shared/catalog-engine/xml/index.js'

describe('Data schema authority across catalog entry points', () => {
  it('publishes road materials as M3 file references in the generated schema', () => {
    expect(resolveStarcraft2SchemaFields('CTile').find(field => field.fieldId === 'Material')).toMatchObject({
      assetKind: 'File', valueType: 'CModelFile',
    })
  })
  it('discovers subclass and nested references through the default registry', () => {
    const registry = createBuiltinRegistry()
    const data = { ImpactEffect: 'Damage', ValidatorArray: ['TargetAlive'] }
    const targets: string[] = []
    registry.walkFields('CEffectLaunchMissile', data, (value, field, location) => {
      if (field.isLink) targets.push(`${location.path.join('.')}:${field.linkNamespace}/${value}`)
    })
    expect(targets).toContain('ImpactEffect:Effect/Damage')
    expect(targets).toContain('ValidatorArray:Validator/TargetAlive')
    const info = registry.resolveFields('CAbilTrain').InfoArray
    expect(info.arrayMerge).toBe('indexed')
    expect(info.fields!.Unit).toMatchObject({ isArray: true, isLink: true, linkNamespace: 'Unit' })
  })

  it('uses the same inherited fields and merge rules for relations and catalog resolution', () => {
    const catalog = createBuiltinRegistry()
    const links = createLinkRegistry()
    expect(catalog.get('CAbilTrain')).toBe(links.get('CAbilTrain'))
    expect(Object.keys(catalog.resolveFields('CAbilTrain')).sort()).toEqual(
      resolveStarcraft2SchemaFields('CAbilTrain').map(field => field.fieldId).sort(),
    )
    // The old link-only registry did not retain these rules.
    expect(links.resolveFields('CActor').Aliases.arrayMerge).toBe('append')
    expect(links.resolveFields('CUnit').WeaponArray.arrayMerge).toBe('indexed')
  })

  it('merges subclass record patches without losing the inherited entry fields', () => {
    const catalog = new TypedCatalog({ schema: createStarcraft2CatalogRegistry() })
    catalog.loadFromFiles([
      parseCatalogXml('<Catalog><CAbilTrain id="Train"><InfoArray index="Train1"><Unit value="Marine"/><Time value="20"/></InfoArray></CAbilTrain></Catalog>'),
      parseCatalogXml('<Catalog><CAbilTrain id="Train"><InfoArray index="Train1"><Time value="10"/></InfoArray></CAbilTrain></Catalog>'),
    ])
    const info = catalog.getResolved('Abil', 'Train')!.InfoArray as Record<string, unknown>[]
    expect(info).toHaveLength(1)
    expect(info[0]).toMatchObject({ index: 'Train1', Time: '10' })
    expect(info[0].Unit).toBe('Marine')
  })

  it('does not leak a session-specific type into another catalog', () => {
    const first = createLinkRegistry()
    first.register({ name: 'CPrivate', fields: {} })
    expect(createLinkRegistry().has('CPrivate')).toBe(false)
    expect(createBuiltinRegistry().has('CPrivate')).toBe(false)
  })
})
