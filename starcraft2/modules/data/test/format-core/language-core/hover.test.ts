/**
 * M4 — hover + codelens cores (vscode-free), driven by a fake HoverCatalog.
 */
import { describe, it, expect } from 'vitest'
import { computeHover, computeEntityLenses, type HoverCatalog } from '../../../shared/format/language/hover.js'

function cursor(template: string): { text: string; offset: number } {
  const offset = template.indexOf('|')
  return { text: template.slice(0, offset) + template.slice(offset + 1), offset }
}

const catalog = (over: Partial<HoverCatalog> = {}): HoverCatalog => ({
  namespaceOf: cls => (cls === 'CUnit' ? 'Unit' : undefined),
  resolvedField: () => undefined,
  fieldOrigin: () => undefined,
  parentChain: () => [],
  inheritedFieldCount: () => 0,
  ...over,
})

describe('computeHover — field', () => {
  it('shows the resolved value and the inheriting ancestor', () => {
    const { text, offset } = cursor('<CUnit id="Marine"><LifeMax value="4|5"/></CUnit>')
    const md = computeHover(
      text,
      offset,
      catalog({
        resolvedField: (_ns, _id, f) => (f === 'LifeMax' ? '45' : undefined),
        fieldOrigin: () => 'Base',
      }),
    )
    expect(md).toContain('LifeMax')
    expect(md).toContain('45')
    expect(md).toContain('inherited from')
  })

  it('marks a locally-set field', () => {
    const { text, offset } = cursor('<CUnit id="Marine"><LifeMax value="4|5"/></CUnit>')
    const md = computeHover(
      text,
      offset,
      catalog({
        resolvedField: () => '45',
        fieldOrigin: () => 'Marine', // same as entity id
      }),
    )
    expect(md).toContain('set on this entity')
  })
})

describe('computeHover — entity', () => {
  it('shows the parent chain on the entity tag', () => {
    const { text, offset } = cursor('<CUn|it id="Marine"></CUnit>')
    const md = computeHover(text, offset, catalog({ parentChain: () => ['', 'Base', 'Marine'] }))
    expect(md).toContain('Marine')
    expect(md).toContain('Base')
    expect(md).toContain('→')
  })

  it('returns undefined when the entity is not in the catalog', () => {
    const { text, offset } = cursor('<CUn|it id="Ghost"></CUnit>')
    expect(computeHover(text, offset, catalog({ namespaceOf: () => undefined }))).toBeUndefined()
  })
})

describe('computeEntityLenses', () => {
  it('emits one lens per entity with a parent chain', () => {
    const text = '<CUnit id="A"></CUnit><CUnit id="B"></CUnit>'
    const lenses = computeEntityLenses(
      text,
      catalog({
        parentChain: (_ns, id) => (id === 'A' ? ['', 'A'] : ['', 'Base', 'B']),
        inheritedFieldCount: () => 7,
      }),
    )
    // A's chain is length 2 but root is '' (default) → still ≥2 so it shows; B shows.
    expect(lenses.map(l => l.id)).toContain('B')
    const b = lenses.find(l => l.id === 'B')!
    expect(b.chain).toContain('Base')
    expect(b.parent).toBe('Base')
    expect(b.inherited).toBe(7)
  })
})
