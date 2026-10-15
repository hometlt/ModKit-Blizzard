/** Canonical leaf provenance survives subtree replacement, removal and appended slot compaction. */
import { describe, expect, it } from 'vitest'
import { entityProvenance } from '../../../shared/catalog-engine/sc2-catalog/provenance.js'
import type { CatalogEntity } from '../../../shared/catalog-engine/sc2-catalog/types.js'

describe('catalog leaf provenance', () => {
  it('keeps exact paths and sibling sources through removals and repeated declarations', () => {
    const baseSource = { mod: 'core', file: 'base.xml' }
    const firstSource = { mod: 'liberty', file: 'first.xml' }
    const secondSource = { mod: 'liberty', file: 'second.xml' }
    const base: CatalogEntity = {
      id: 'Base', class: 'CUnit', namespace: 'Unit', source: baseSource,
      data: {
        Indexed: [
          { index: 'a', Nested: { Old: 'base', Other: 'base' } },
          { index: 'ab', value: 'sibling' },
          { index: '__proto__', value: 'ordinary slot' },
        ],
        Append: [{ Name: 'first' }, { Name: 'second' }],
        Struct: { A: { X: 'base', Y: 'base' }, AB: { Z: 'sibling' } },
        Scalar: 'base',
        FullReplace: { X: 'base' },
      },
    }
    const child: CatalogEntity = {
      id: 'Child', parent: 'Base', class: 'CUnit', namespace: 'Unit', data: {},
      declarations: [
        { source: firstSource, data: {
          Indexed: [{ index: 'a', removed: '1' }],
          Append: [{ index: '0', removed: '1' }],
          Struct: { A: 'scalar' },
          Scalar: { X: 'nested' },
          FullReplace: 'child',
        } },
        { source: secondSource, data: {
          Indexed: [{ index: 'a', Nested: {} }],
          Struct: { A: { X: 'nested' } },
        } },
      ],
    }
    const traced = entityProvenance(child, [base, child], {
      Indexed: { isArray: true, arrayMerge: 'indexed', indexAttr: 'index' },
      Append: { isArray: true, arrayMerge: 'append' },
    })
    const sourceAt = (field: string, path: readonly string[]) => traced.fields.get(field)?.originAt(path)?.source
    expect(sourceAt('Indexed', ['a', 'Nested'])).toBe(secondSource)
    expect(sourceAt('Indexed', ['a', 'Nested', 'Old'])).toBeUndefined()
    expect(sourceAt('Indexed', ['a', 'Nested', 'Other'])).toBeUndefined()
    expect(sourceAt('Indexed', ['ab'])).toBe(baseSource)
    expect(sourceAt('Indexed', ['__proto__'])).toBe(baseSource)
    expect(sourceAt('Append', ['0', 'Name'])).toBe(baseSource)
    expect(sourceAt('Append', ['1', 'Name'])).toBeUndefined()
    expect(sourceAt('Struct', ['A'])).toBe(firstSource)
    expect(sourceAt('Struct', ['A', 'X'])).toBe(secondSource)
    expect(sourceAt('Struct', ['A', 'Y'])).toBeUndefined()
    expect(sourceAt('Struct', ['AB', 'Z'])).toBe(baseSource)
    expect(sourceAt('Scalar', [])).toBe(baseSource)
    expect(sourceAt('Scalar', ['X'])).toBe(firstSource)
    expect(sourceAt('FullReplace', [])).toBe(firstSource)
    expect(sourceAt('FullReplace', ['X'])).toBeUndefined()
    expect([...traced.own].sort()).toEqual(['Append', 'FullReplace', 'Indexed', 'Scalar', 'Struct'])
    expect(traced.tombstones).toEqual([{ path: ['Indexed', 'a'], source: firstSource }])
  })
})
