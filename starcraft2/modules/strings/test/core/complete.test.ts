import { describe, it, expect } from 'vitest'
import { completeStringValue, completeStringKey, findTagOrAttrDocAt, type StringCatalog } from '../../shared/core/complete.js'

const catalog: StringCatalog = {
  namespaces: () => ['Unit', 'Weapon', 'Effect'],
  entities: (ns) => (ns === 'Weapon' ? ['Gauss', 'GaussShell'] : ['Marine', 'Marauder']),
  fields: (_ns, _e) => ['Amount', 'AmountArray', 'Life'],
  properties: (ns) => (ns === 'Unit' ? ['Name', 'Tooltip', 'Description'] : ['Name']),
  colors: () => ['ColorAttackInfo', 'ColorGreen'],
  colorHex: (name) => ({ ColorAttackInfo: 'ffff8a', ColorGreen: '00ff00' } as Record<string, string>)[name],
  styles: () => ['Bold', 'BoldTooltipNumbers'],
  assets: () => ['UI/ResourceIconPower', 'UI/ResourceIconMinerals'],
}

/** Completions at the end of `text` (caret at text.length). */
function at(text: string) {
  return completeStringValue({ text, offset: text.length, catalog })
}

describe('completeStringValue', () => {
  it('suggests tag snippets right after "<"', () => {
    const r = at('Hello <')
    expect(r.replaceLength).toBe(0)
    expect(r.items.map((i) => i.label)).toContain('d ref')
    expect(r.items.every((i) => i.kind === 'tag')).toBe(true)
  })

  it('filters tag snippets by the partial name', () => {
    const r = at('<im')
    expect(r.replaceLength).toBe(2)
    expect(r.items.map((i) => i.label)).toEqual(['img'])
  })

  it('suggests attribute names after the tag name and a space', () => {
    const r = at('<d ')
    expect(r.items.map((i) => i.label)).toContain('ref')
    expect(r.items.every((i) => i.kind === 'attribute')).toBe(true)
  })

  it('suggests namespaces at the start of a ref expression', () => {
    const r = at('<d ref="')
    expect(r.items.map((i) => i.label)).toEqual(['Unit', 'Weapon', 'Effect'])
    expect(r.items[0]!.kind).toBe('namespace')
  })

  it('suggests entities after the namespace comma', () => {
    const r = at('<d ref="Weapon,Ga')
    expect(r.replaceLength).toBe(2)
    expect(r.items.map((i) => i.label)).toEqual(['Gauss', 'GaussShell'])
    expect(r.items[0]!.kind).toBe('entity')
  })

  it('suggests fields after the entity comma', () => {
    const r = at('<d ref="Weapon,Gauss,Am')
    expect(r.items.map((i) => i.label)).toEqual(['Amount', 'AmountArray'])
    expect(r.items[0]!.kind).toBe('field')
  })

  it('re-triggers a fresh reference after an operator', () => {
    const r = at('<d ref="Weapon,Gauss,Amount + Un')
    expect(r.replaceLength).toBe(2)
    expect(r.items.map((i) => i.label)).toEqual(['Unit'])
  })

  it('handles stringref values as a single tuple', () => {
    const r = at('<d stringref="Unit,Mar')
    expect(r.items.map((i) => i.label)).toEqual(['Marine', 'Marauder'])
  })

  it('returns nothing outside a tag', () => {
    expect(at('plain text').items).toEqual([])
    expect(at('<c val="ff">closed</c> ').items).toEqual([])
  })

  it('suggests color constants for <c val>, each with a resolved hex swatch, "Custom Color…" always first', () => {
    const r = at('<c val="Color')
    expect(r.items.map((i) => i.label)).toEqual(['Custom Color…', 'ColorAttackInfo', 'ColorGreen'])
    expect(r.items.every((i) => i.kind === 'color')).toBe(true)
    expect(r.items[0]!.swatch).toBe('ffffff')
    expect(r.items[1]!.swatch).toBe('ffff8a')
    expect(r.items[2]!.swatch).toBe('00ff00')
  })

  it('"Custom Color…" inserts an editable literal hex', () => {
    const r = at('<c val="')
    const custom = r.items.find((i) => i.label === 'Custom Color…')!
    expect(custom.insert).toBe('FFFFFFFF')
  })

  it('suggests text styles for <s val> (same attribute name, different tag)', () => {
    const r = at('<s val="Bold')
    expect(r.items.map((i) => i.label)).toEqual(['Bold', 'BoldTooltipNumbers'])
    expect(r.items[0]!.kind).toBe('style')
  })

  it('suggests @@Alias asset references for <img path>', () => {
    const r = at('<img path="@@UI/ResourceIconP')
    expect(r.items.map((i) => i.label)).toEqual(['UI/ResourceIconPower'])
    expect(r.items[0]!.insert).toBe('@@UI/ResourceIconPower')
    expect(r.items[0]!.kind).toBe('asset')
  })

  it('suggests assets for <img path> even before the "@@" is typed', () => {
    const r = at('<img path="UI/ResourceIconM')
    expect(r.items.map((i) => i.label)).toEqual(['UI/ResourceIconMinerals'])
  })
})

/** Key completions at the end of `text` (caret at text.length). */
function atKey(text: string) {
  return completeStringKey({ text, offset: text.length, catalog })
}

describe('completeStringKey', () => {
  it('suggests namespaces for the first segment', () => {
    const r = atKey('Uni')
    expect(r.replaceLength).toBe(3)
    expect(r.items.map((i) => i.label)).toEqual(['Unit'])
    expect(r.items[0]!.kind).toBe('namespace')
  })

  it('suggests properties for the middle segment', () => {
    const r = atKey('Unit/Tool')
    expect(r.replaceLength).toBe(4)
    expect(r.items.map((i) => i.label)).toEqual(['Tooltip'])
    expect(r.items[0]!.kind).toBe('field')
  })

  it('suggests object ids only once a third segment has started', () => {
    const r = atKey('Unit/Name/Mar')
    expect(r.replaceLength).toBe(3)
    expect(r.items.map((i) => i.label)).toEqual(['Marine', 'Marauder'])
    expect(r.items[0]!.kind).toBe('entity')
  })

  it('treats the 3rd segment as the object id even when a property was already typed (3-segment convention)', () => {
    // "Unit/CardLayouts/Tool" — 3 segments so far, so the 3rd is assumed to be the
    // object id being typed; a 4th "/" would be needed before it re-reads as property.
    const r = atKey('Unit/CardLayouts/Mar')
    expect(r.items.map((i) => i.label)).toEqual(['Marine', 'Marauder'])
    expect(r.items[0]!.kind).toBe('entity')
  })

  it('returns nothing without a catalog', () => {
    expect(completeStringKey({ text: 'Unit/', offset: 5 }).items).toEqual([])
  })
})

describe('completeStringValue enum attributes', () => {
  it('suggests <a name=""> link types', () => {
    const r = at('<a name="Web')
    expect(r.items.map((i) => i.label)).toEqual(['WebsiteUrl'])
    expect(r.items[0]!.kind).toBe('enum')
  })

  it('suggests <img alignment=""> values', () => {
    const r = at('<img path="x" alignment="Mid')
    expect(r.items.map((i) => i.label)).toEqual(['Middle'])
  })

  it('suggests <d GameValue=""> keywords ahead of tuple completion', () => {
    const r = at('<d GameValue="Play')
    expect(r.items.map((i) => i.label)).toEqual(['PlayerRace', 'PlayerName', 'PlayerColor', 'PlayerFoodCap', 'PlayerClanTag'])
  })
})

describe('findTagOrAttrDocAt', () => {
  it('finds the doc for a tag name', () => {
    const value = 'Damage: <c val="ff0000">hi</c>'
    const at = findTagOrAttrDocAt(value, value.indexOf('c val') )
    expect(at?.label).toBe('<c>')
    expect(at?.doc).toMatch(/color/i)
  })

  it('finds the doc for an attribute name', () => {
    const value = '<img path="x" alignment="Top"/>'
    const at = findTagOrAttrDocAt(value, value.indexOf('alignment') + 2)
    expect(at?.label).toBe('alignment')
    expect(at?.doc).toMatch(/vertical alignment/i)
  })

  it('returns undefined outside any tag, and for an unknown tag/attribute', () => {
    expect(findTagOrAttrDocAt('plain text', 3)).toBeUndefined()
    expect(findTagOrAttrDocAt('<None foo="1"/>', 1)).toBeUndefined()
  })
})
