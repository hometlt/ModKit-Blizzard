/**
 * EditorCategories completion + validation in the plugin cores (vscode-free), using a
 * fake applicable-categories lookup. `EditorCategories` is a field of every catalog
 * class (CClass base), classified schema-driven as kind 'editorCategories'.
 */
import { describe, it, expect } from 'vitest'
import { computeCompletions } from '../../../shared/format/language/completion.js'
import { collectIssues } from '../../../shared/format/language/diagnostics.js'
import { classifyField, getClassFields } from '../../../shared/catalog-engine/sc2-catalog'
import type { ApplicableCategory } from '../../../shared/catalog-engine/sc2-editor'

function cursor(template: string): { text: string; offset: number } {
  const offset = template.indexOf('|')
  return { text: template.slice(0, offset) + template.slice(offset + 1), offset }
}

const cats = (ns: string): ApplicableCategory[] =>
  ns === 'Unit'
    ? [
        { name: 'ObjectType', values: ['Unit', 'Structure'] },
        { name: 'Race', values: ['Terr', 'Prot'] },
      ]
    : []

describe('schema classifies EditorCategories field', () => {
  it('CUnit has an EditorCategories field of kind editorCategories', () => {
    const ft = getClassFields('CUnit')!['EditorCategories']
    expect(classifyField(ft).kind).toBe('editorCategories')
  })
})

describe('EditorCategories completion', () => {
  it('offers category names on the key side', () => {
    const { text, offset } = cursor('<CUnit id="X"><EditorCategories value="|"/></CUnit>')
    const r = computeCompletions(text, offset, undefined, cats)
    expect(r.kind).toBe('values')
    if (r.kind !== 'values') return
    expect(r.values).toEqual(['ObjectType', 'Race'])
  })

  it("offers a category's values after the colon", () => {
    const { text, offset } = cursor(
      '<CUnit id="X"><EditorCategories value="ObjectType:|"/></CUnit>',
    )
    const r = computeCompletions(text, offset, undefined, cats)
    if (r.kind !== 'values') throw new Error('expected values')
    expect(r.values).toEqual(['Unit', 'Structure'])
  })

  it('works inside the real <Catalog> wrapper', () => {
    const { text, offset } = cursor(
      '<Catalog><CUnit id="X"><EditorCategories value="ObjectType:|"/></CUnit></Catalog>',
    )
    const r = computeCompletions(text, offset, undefined, cats)
    if (r.kind !== 'values') throw new Error('expected values')
    expect(r.values).toEqual(['Unit', 'Structure'])
  })

  it('offers values for the second pair after a comma', () => {
    const { text, offset } = cursor(
      '<CUnit id="X"><EditorCategories value="ObjectType:Unit,Race:|"/></CUnit>',
    )
    const r = computeCompletions(text, offset, undefined, cats)
    if (r.kind !== 'values') throw new Error('expected values')
    expect(r.values).toEqual(['Terr', 'Prot'])
  })
})

// The authoritative set of DEFINED categories (merged base→deps→mod). A SUPERSET of the
// namespace-applicable `cats('Unit')` — `AbilityorEffectType` is defined + usable on the
// entity but is NOT in Unit's `objectUsage`, mirroring the real Scion.SC2Mod case where the
// SC2 editor writes `AbilityorEffectType:Units` onto Abil entities whose usage lists only Race.
const allCategoryValues = new Map<string, readonly string[]>([
  ['ObjectType', ['Unit', 'Structure']],
  ['Race', ['Terr', 'Prot']],
  ['AbilityorEffectType', ['Units', 'Structures']],
])
const refs = { editorCategoryValues: (name: string) => allCategoryValues.get(name) }

describe('EditorCategories validation', () => {
  it('accepts a DEFINED category even when absent from the namespace objectUsage (regression)', () => {
    // `AbilityorEffectType` is defined but not in `cats('Unit')` → must NOT be flagged.
    const issues = collectIssues(
      '<CUnit id="X"><EditorCategories value="Race:Terr,AbilityorEffectType:Units"/></CUnit>',
      undefined,
      cats,
      undefined,
      refs,
    )
    expect(issues.some(i => i.message.includes('editor category'))).toBe(false)
  })

  it('flags a category defined nowhere as unknown (only with the authoritative full map)', () => {
    const doc = '<CUnit id="X"><EditorCategories value="Bogus:Unit"/></CUnit>'
    // With the full-map lookup: a truly-undefined category is a typo → flagged.
    expect(
      collectIssues(doc, undefined, cats, undefined, refs).some(i =>
        i.message.includes("Unknown editor category 'Bogus'"),
      ),
    ).toBe(true)
    // Without the lookup: can't distinguish typo from valid-cross-type → stay lenient.
    expect(
      collectIssues(doc, undefined, cats).some(i => i.message.includes('Unknown editor category')),
    ).toBe(false)
  })

  it('flags an invalid value for a defined category', () => {
    const issues = collectIssues(
      '<CUnit id="X"><EditorCategories value="AbilityorEffectType:Nope"/></CUnit>',
      undefined,
      cats,
      undefined,
      refs,
    )
    expect(
      issues.some(i =>
        i.message.startsWith("Invalid value 'Nope' for editor category 'AbilityorEffectType'"),
      ),
    ).toBe(true)
  })

  it('accepts a valid pair', () => {
    const issues = collectIssues(
      '<CUnit id="X"><EditorCategories value="ObjectType:Unit,Race:Terr"/></CUnit>',
      undefined,
      cats,
      undefined,
      refs,
    )
    expect(issues).toEqual([])
  })

  it('skips validation when no editor data is loaded', () => {
    const issues = collectIssues('<CUnit id="X"><EditorCategories value="Bogus:Whatever"/></CUnit>')
    expect(issues.every(i => !i.message.includes('editor category'))).toBe(true)
  })
})

