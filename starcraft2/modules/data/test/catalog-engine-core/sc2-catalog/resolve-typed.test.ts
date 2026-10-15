/**
 * Tests for resolveEntityTyped — verifying it precisely matches old-parser's
 * $$resolved / $$data / resolveArrays behavior.
 *
 * Old-parser algorithm:
 *   $$data: deep(resolved, parent.$$data); deep(resolved, this)
 *   $$resolved: deep({}, class.$$data); deep(result, $$data, default?'replace':'merge');
 *               resolveArrays(result, schema)
 *
 * deep(a, b, 'merge'):
 *   - arrays:  target = [...parent, ...child]
 *   - objects: recursive deep merge
 *   - string/type-mismatch: child always wins
 *   - scalar same-type: child wins
 *
 * resolveArrays (indexed array):
 *   - item has no index:                append positional (push)
 *   - item.index is numeric:            go to result[n]; deep-merge if object, replace if scalar
 *   - item.removed:                     null the slot (removed from final)
 *   - all items are { value: x } only:  unwrap → scalar array
 */
import { describe, it, expect } from 'vitest'
import { resolveEntityTyped } from '../../../shared/catalog-engine/sc2-catalog/resolve-typed.js'
import type { CatalogEntity } from '../../../shared/catalog-engine/sc2-catalog/types.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NS = 'Unit'

function ent(
  id: string,
  data: Record<string, unknown>,
  opts: { cls?: string; parent?: string } = {},
): CatalogEntity {
  return {
    id,
    class: opts.cls ?? 'CUnknownTestClass',  // unknown class → all fields use fallback path
    namespace: NS,
    data: data as any,
    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
  }
}

function lookup(entities: CatalogEntity[]) {
  return (ns: string, id: string) => entities.find(e => e.namespace === ns && e.id === id)
}

// ─── Group 1: Unknown class — mirrors old-parser deep() logic ────────────────

describe('unknown class — deep() fallback', () => {

  it('scalar: child overrides parent (last wins)', () => {
    const base = ent('', { LifeMax: 100 })
    const child = ent('Marine', { LifeMax: 150 }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect(result.LifeMax).toBe(150)
  })

  it('scalar: inherits from parent when child does not define it', () => {
    const base = ent('', { Race: 'Terr' })
    const child = ent('Marine', { LifeMax: 45 }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect(result.Race).toBe('Terr')
    expect(result.LifeMax).toBe(45)
  })

  it('object: deep-merged from parent and child (both fields present)', () => {
    const base = ent('', { Cost: { Mineral: 50 } })
    const child = ent('Marine', { Cost: { Vespene: 0 } }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect((result.Cost as any).Mineral).toBe(50)
    expect((result.Cost as any).Vespene).toBe(0)
  })

  it('object: child field overrides parent field of same key', () => {
    const base = ent('', { Cost: { Mineral: 50, Vespene: 25 } })
    const child = ent('Marine', { Cost: { Mineral: 100 } }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect((result.Cost as any).Mineral).toBe(100)
    expect((result.Cost as any).Vespene).toBe(25)
  })

  it('array: concat parent and child arrays (merge mode)', () => {
    const base = ent('', { Tags: ['a', 'b'] })
    const child = ent('Marine', { Tags: ['c'] }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect(result.Tags).toEqual(['a', 'b', 'c'])
  })

  it('type mismatch — string child wins over array parent', () => {
    // old-parser: value.constructor === String → target = value
    const base = ent('', { Flags: ['A', 'B'] })
    const child = ent('Marine', { Flags: 'CDE' }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect(result.Flags).toBe('CDE')
  })

  it('type mismatch — object child wins over scalar parent', () => {
    const base = ent('', { Effect: 'OldEffect' })
    const child = ent('Marine', { Effect: { Link: 'NewEffect' } }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    expect((result.Effect as any).Link).toBe('NewEffect')
  })

  it('implicit default (id="") used when no explicit parent', () => {
    const defaultEnt = ent('', { Race: 'Terr', Sight: 9 })
    const child = ent('Marine', { LifeMax: 45 })  // no parent attr
    const result = resolveEntityTyped(child, lookup([defaultEnt, child]))
    expect(result.Race).toBe('Terr')
    expect(result.Sight).toBe(9)
    expect(result.LifeMax).toBe(45)
  })

  it('three-level chain: grandparent → parent → child', () => {
    const gp = ent('', { A: 1, B: 2, C: 3 })
    const parent = ent('Base', { B: 20 }, { parent: '' })
    const child = ent('Child', { C: 300 }, { parent: 'Base' })
    const result = resolveEntityTyped(child, lookup([gp, parent, child]))
    expect(result.A).toBe(1)   // from grandparent
    expect(result.B).toBe(20)  // from parent
    expect(result.C).toBe(300) // from child
  })

  it('entity with no data only inherits default', () => {
    const defaultEnt = ent('', { Speed: 2.25, Sight: 7 })
    const child = ent('Drone', {})
    const result = resolveEntityTyped(child, lookup([defaultEnt, child]))
    expect(result.Speed).toBe(2.25)
    expect(result.Sight).toBe(7)
  })

})

// ─── Group 2: resolveIndexedArray — mirrors old-parser resolveArrays ─────────

// CUnit is in DATA_CLASS_SCHEMA and has AbilArray as a typed array field.
// AbilArray items have {Link: CAbilLink} as the nested link field.

describe('resolveIndexedArray — AbilArray (CUnit schema)', () => {

  it('items without index appended in order (positional)', () => {
    const child = ent('Zergling', {
      AbilArray: [
        { Link: 'attack' },
        { Link: 'move' },
        { Link: 'stop' },
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect((result.AbilArray as any[]).map((x: any) => x.Link))
      .toEqual(['attack', 'move', 'stop'])
  })

  it('numeric-indexed items go to correct slots', () => {
    const child = ent('Marine', {
      AbilArray: [
        { index: '0', Link: 'stop' },
        { index: '1', Link: 'attack' },
        { index: '2', Link: 'move' },
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const arr = result.AbilArray as any[]
    expect(arr[0].Link).toBe('stop')
    expect(arr[1].Link).toBe('attack')
    expect(arr[2].Link).toBe('move')
  })

  it('positional items + one indexed: indexed replaces its slot', () => {
    // Old-parser behaviour: positional items fill slots 0,1,2,...
    // item {index:1, Link:REPLACED} replaces slot 1.
    const child = ent('Zergling', {
      AbilArray: [
        { Link: 'stop' },
        { Link: 'attack' },
        { Link: 'move' },
        { index: '1', Link: 'REPLACED' },
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const arr = result.AbilArray as any[]
    expect(arr.find((x: any) => x.Link === 'attack')).toBeUndefined() // replaced
    expect(arr.find((x: any) => x.Link === 'REPLACED')).toBeDefined() // slot 1 now
    expect(arr.find((x: any) => x.Link === 'stop')).toBeDefined()   // slot 0 intact
    expect(arr.find((x: any) => x.Link === 'move')).toBeDefined()   // slot 2 intact
  })

  it('removed flag removes the slot', () => {
    const child = ent('Marine', {
      AbilArray: [
        { index: '0', Link: 'stop' },
        { index: '1', Link: 'attack' },
        { index: '1', removed: '1' },  // removes slot 1
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const arr = result.AbilArray as any[]
    expect(arr.length).toBe(1)
    expect(arr[0].Link).toBe('stop')
  })

  it('indexed item merges with existing object at that slot', () => {
    const child = ent('Marine', {
      AbilArray: [
        { index: '0', Link: 'stop', Extra: 'base' },
        { index: '0', Cooldown: 5 },   // merges into slot 0
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const item = (result.AbilArray as any[])[0]
    expect(item.Link).toBe('stop')
    expect(item.Extra).toBe('base')
    expect(item.Cooldown).toBe(5)
  })

  it('real Zergling AbilArray pattern: positional + specific index override', () => {
    // Matches the VoidMulti5015 Zergling data structure exactly
    const child = ent('Zergling', {
      AbilArray: [
        { Link: 'stop' },
        { Link: 'attack' },
        { Link: 'move' },
        { Link: 'que1' },
        { Link: 'BurrowZerglingDown' },
        { Link: 'MorphZerglingToBaneling' },
        { index: '5', Link: 'MorphToBaneling' },  // replaces slot 5
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const links = (result.AbilArray as any[]).map((x: any) => x.Link)
    expect(links).toContain('stop')
    expect(links).toContain('attack')
    expect(links).toContain('move')
    expect(links).toContain('que1')
    expect(links).toContain('BurrowZerglingDown')
    expect(links).toContain('MorphToBaneling')
    expect(links).not.toContain('MorphZerglingToBaneling')  // replaced
    expect(links.length).toBe(6)
  })

  it('parent chain: parent items accumulated then child overrides by index', () => {
    const base = ent('', {
      AbilArray: [
        { index: '0', Link: 'stop' },
        { index: '1', Link: 'attack' },
        { index: '2', Link: 'move' },
      ],
    }, { cls: 'CUnit' })
    const child = ent('Marine', {
      AbilArray: [
        { index: '3', Link: 'Stimpack' },   // new slot
        { index: '1', Link: 'NewAttack' },  // replaces parent's slot 1
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    const links = (result.AbilArray as any[]).map((x: any) => x.Link)
    expect(links).toContain('stop')
    expect(links).toContain('NewAttack')
    expect(links).not.toContain('attack')  // replaced by NewAttack
    expect(links).toContain('move')
    expect(links).toContain('Stimpack')
  })

})

// ─── Group 3: single-value unwrap — GlossaryStrongArray pattern ──────────────

describe('resolveIndexedArray — GlossaryStrongArray ({value:x} unwrap)', () => {

  it('all {value:x} items unwrapped to scalar array', () => {
    const child = ent('Marine', {
      GlossaryStrongArray: [
        { value: 'Mutalisk' },
        { value: 'SiegeTank' },
      ],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect(result.GlossaryStrongArray).toEqual(['Mutalisk', 'SiegeTank'])
  })

  it('plain strings in array kept as-is (already scalars)', () => {
    const child = ent('Marine', {
      GlossaryStrongArray: ['Mutalisk', 'SiegeTank'],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect(result.GlossaryStrongArray).toEqual(['Mutalisk', 'SiegeTank'])
  })

  it('mixed scalars + indexed {value:x}: indexed replaces its slot', () => {
    // Matches VoidMulti5015 Marine GlossaryStrongArray pattern:
    // ["Marauder","Hydralisk","Immortal",{index:"1",value:"Mutalisk"}]
    // Slot 1 was "Hydralisk", replaced by "Mutalisk"
    const child = ent('Marine', {
      GlossaryStrongArray: ['Marauder', 'Hydralisk', 'Immortal', { index: '1', value: 'Mutalisk' }],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const arr = result.GlossaryStrongArray as string[]
    expect(arr).toContain('Marauder')
    expect(arr).toContain('Mutalisk')  // replaced Hydralisk at slot 1
    expect(arr).toContain('Immortal')
    expect(arr).not.toContain('Hydralisk')  // replaced
    expect(arr.length).toBe(3)
  })

  it('single {value:x} object (not in array) normalised to scalar array', () => {
    // Matches VoidMulti5015 GlossaryWeakArray pattern: {index:"0",value:"SiegeTank"}
    const child = ent('Marine', {
      GlossaryWeakArray: { index: '0', value: 'SiegeTank' },
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect(result.GlossaryWeakArray).toEqual(['SiegeTank'])
  })

})

// ─── Group 4: WeaponArray nested struct ──────────────────────────────────────

describe('WeaponArray nested struct', () => {

  it('items with Link sub-field preserved', () => {
    const child = ent('Marine', {
      WeaponArray: [{ index: '0', Link: 'GuassRifle' }],
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    const arr = result.WeaponArray as any[]
    expect(arr[0].Link).toBe('GuassRifle')
  })

  it('single object {Link:X} (not in array) normalised to array', () => {
    // Matches how VoidMulti5015 stores WeaponArray for some units
    const child = ent('Marine', {
      WeaponArray: { Link: 'GuassRifle' },
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect(Array.isArray(result.WeaponArray)).toBe(true)
    expect((result.WeaponArray as any[])[0].Link).toBe('GuassRifle')
  })

})

// ─── Group 5: Edge cases ─────────────────────────────────────────────────────

describe('edge cases', () => {

  it('empty data returns empty object', () => {
    const child = ent('Empty', {})
    expect(resolveEntityTyped(child, lookup([child]))).toEqual({})
  })

  it('cycle guard: entity with parent pointing to itself', () => {
    // buildChain must not infinite-loop
    const self = ent('Self', { X: 1 }, { parent: 'Self' })
    expect(() => resolveEntityTyped(self, lookup([self]))).not.toThrow()
  })

  it('missing parent: lookup returns undefined — skips gracefully', () => {
    const child = ent('Marine', { X: 5 }, { parent: 'NonExistent' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect(result.X).toBe(5)
  })

  it('removed item at non-existent slot is a no-op', () => {
    const child = ent('Marine', {
      AbilArray: [{ index: '5', removed: '1' }],  // slot 5 does not exist
    }, { cls: 'CUnit' })
    const result = resolveEntityTyped(child, lookup([child]))
    expect((result.AbilArray as any[]).length).toBe(0)
  })

  it('scalar null/undefined in data ignored (mirrors deep() null skip)', () => {
    const base = ent('', { X: 10 })
    // Even if child has undefined for a key it should not override parent
    const child = ent('Marine', { X: undefined as any }, { parent: '' })
    const result = resolveEntityTyped(child, lookup([base, child]))
    // Our implementation: undefined is filtered from chain.map().filter()
    // so parent value wins for that key
    expect(result.X).toBe(10)
  })

})
