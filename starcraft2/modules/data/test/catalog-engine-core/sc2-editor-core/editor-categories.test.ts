import { describe, it, expect } from 'vitest'
import {
  parseEditorCategories, mergeEditorCategories, categoriesForType,
} from '../../../shared/catalog-engine/sc2-editor-core/editor-categories.js'
import {
  parseEditorCategoryStrings, categoryDisplayName, categoryValueDisplayName,
} from '../../../shared/catalog-engine/sc2-editor-core/strings.js'

const XML = `<?xml version="1.0" encoding="utf-8"?>
<EditorCategories>
  <category name="ObjectType">
    <value>Unit</value>
    <value>Structure</value>
  </category>
  <category name="Race">
    <value>Terr</value>
    <value>Prot</value>
  </category>
  <category name="FieldType">
    <value>Combat</value>
  </category>
  <objectUsage type="Abil">
    <objects>
      <usage source="External">Race</usage>
      <usage source="EntryType"></usage>
    </objects>
    <fields>
      <usage source="External">FieldType</usage>
    </fields>
  </objectUsage>
  <objectUsage type="Unit">
    <objects>
      <usage source="External">ObjectType</usage>
      <usage source="External">Race</usage>
    </objects>
  </objectUsage>
</EditorCategories>`

describe('parseEditorCategories', () => {
  it('parses categories and object usage', () => {
    const data = parseEditorCategories(XML)
    expect(data.categories.get('ObjectType')).toEqual(['Unit', 'Structure'])
    expect(data.categories.get('Race')).toEqual(['Terr', 'Prot'])
    expect(data.objectUsage.get('Abil')!.objects.map((u) => u.source)).toEqual(['External', 'EntryType'])
    expect(data.objectUsage.get('Abil')!.objects[0]!.category).toBe('Race')
  })

  it('returns empty on malformed input without throwing', () => {
    const data = parseEditorCategories('<nonsense')
    expect(data.categories.size).toBe(0)
    expect(data.objectUsage.size).toBe(0)
  })
})

describe('categoriesForType', () => {
  it('resolves applicable categories + values for a namespace (objects scope)', () => {
    const data = parseEditorCategories(XML)
    const cats = categoriesForType(data, 'Unit')
    expect(cats.map((c) => c.name)).toEqual(['ObjectType', 'Race'])
    expect(cats.find((c) => c.name === 'ObjectType')!.values).toEqual(['Unit', 'Structure'])
  })

  it('skips dynamic (EntryType/Parent) usages, keeps External', () => {
    const data = parseEditorCategories(XML)
    const cats = categoriesForType(data, 'Abil', 'objects')
    expect(cats.map((c) => c.name)).toEqual(['Race']) // EntryType dropped
    expect(categoriesForType(data, 'Abil', 'fields').map((c) => c.name)).toEqual(['FieldType'])
  })

  it('returns [] for an unknown type', () => {
    expect(categoriesForType(parseEditorCategories(XML), 'Nope')).toEqual([])
  })
})

describe('mergeEditorCategories', () => {
  it('unions category values (base first) and overrides objectUsage per type', () => {
    const base = parseEditorCategories(XML)
    const dep = parseEditorCategories(`<EditorCategories>
      <category name="Race"><value>Zerg</value><value>Terr</value></category>
      <objectUsage type="Unit"><objects><usage source="External">Race</usage></objects></objectUsage>
    </EditorCategories>`)
    const merged = mergeEditorCategories(base, dep)
    // Terr already present → not duplicated; Zerg appended.
    expect(merged.categories.get('Race')).toEqual(['Terr', 'Prot', 'Zerg'])
    // Unit objectUsage replaced by the later mod (only Race now).
    expect(categoriesForType(merged, 'Unit').map((c) => c.name)).toEqual(['Race'])
  })
})

describe('EditorCategoryStrings', () => {
  const strings = parseEditorCategoryStrings(
    'EDSTR_CATEGORY_Climate=Climate\nEDSTR_CATEGORY_Climate_SpacePlatform=Space Platform\n\n// comment\n',
  )
  it('parses key=value and resolves display names', () => {
    expect(categoryDisplayName(strings, 'Climate')).toBe('Climate')
    expect(categoryValueDisplayName(strings, 'Climate', 'SpacePlatform')).toBe('Space Platform')
    expect(categoryValueDisplayName(strings, 'Climate', 'Nope')).toBeUndefined()
  })
})
