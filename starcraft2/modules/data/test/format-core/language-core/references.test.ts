/**
 * Find-all-references core (vscode-free): target detection + reference collection.
 * Uses a real link field discovered off the catalog schema so test docs stay valid.
 */
import { describe, it, expect } from 'vitest'
import { referenceTargetAt, findReferences, collectAllRefs } from '../../../shared/format/language/references.js'
import { getClassFields, classifyField, namespaceOfClass, type FieldInfo } from '../../../shared/catalog-engine/sc2-catalog'

function cursor(template: string): { text: string; offset: number } {
  const offset = template.indexOf('|')
  return { text: template.slice(0, offset) + template.slice(offset + 1), offset }
}

function findLink(): { name: string; info: FieldInfo } | undefined {
  const schema = getClassFields('CUnit')
  if (!schema) return undefined
  for (const [name, ft] of Object.entries(schema)) {
    const info = classifyField(ft)
    if (info.kind === 'link' && info.linkNamespace && !info.isTextLink && !info.isFileLink)
      return { name, info }
  }
  return undefined
}

describe('referenceTargetAt', () => {
  it('targets the entity when the cursor is on its id', () => {
    const { text, offset } = cursor('<CUnit id="Mar|ine"></CUnit>')
    expect(referenceTargetAt(text, offset)).toEqual({ namespace: 'Unit', id: 'Marine' })
  })

  it('targets the parent entity from parent="…"', () => {
    const { text, offset } = cursor('<CUnit id="X" parent="Ba|se"></CUnit>')
    expect(referenceTargetAt(text, offset)).toEqual({ namespace: 'Unit', id: 'Base' })
  })

  it('targets the linked entity from a link field value', () => {
    const link = findLink()!
    const { text, offset } = cursor(`<CUnit id="X"><${link.name} value="Tar|get"/></CUnit>`)
    expect(referenceTargetAt(text, offset)).toEqual({
      namespace: link.info.linkNamespace,
      id: 'Target',
    })
  })

  // DX7: go-to-definition from inside an actor-message / actor-term arg token.
  it('targets the model from inside an actor `Send` arg (ModelSwap <Model> 9)', () => {
    const { text, offset } = cursor(
      '<CActorModel id="A"><On Send="ModelSwap My|Model 9"/></CActorModel>',
    )
    expect(referenceTargetAt(text, offset)).toEqual({ namespace: 'Model', id: 'MyModel' })
  })

  it('targets the unit from inside a `;`-list actor Terms segment', () => {
    const { text, offset } = cursor(
      '<CActorModel id="A"><On Terms="Age; AbilTrainProduced Tal|DarimDeathStar"/></CActorModel>',
    )
    expect(referenceTargetAt(text, offset)).toEqual({ namespace: 'Unit', id: 'TalDarimDeathStar' })
  })

  it('returns undefined on the instruction keyword itself (not a reference)', () => {
    const { text, offset } = cursor(
      '<CActorModel id="A"><On Send="Model|Swap MyModel 9"/></CActorModel>',
    )
    expect(referenceTargetAt(text, offset)).toBeUndefined()
  })
})

describe('actor instruction relation extraction (DX7)', () => {
  it('extracts model/unit/effect edges from actor Send + `;`-list Terms args', () => {
    const text =
      '<CActorModel id="A">' +
      '<On Terms="AbilTrainProduced SomeUnit; EffectParent SomeEffect" Send="ModelSwap SomeModel 9"/>' +
      '</CActorModel>'
    const refs = collectAllRefs(text)
    const has = (ns: string, id: string): boolean =>
      refs.some(m => m.kind === 'link' && m.namespace === ns && m.id === id)
    expect(has('Model', 'SomeModel')).toBe(true)
    expect(has('Unit', 'SomeUnit')).toBe(true)
    expect(has('Effect', 'SomeEffect')).toBe(true)
    // Each edge's range points exactly at the referenced token.
    for (const m of refs.filter(r => r.kind === 'link'))
      expect(['SomeModel', 'SomeUnit', 'SomeEffect']).toContain(text.slice(m.start, m.end))
  })

  it('does not extract edges from an unmodeled message keyword', () => {
    const text = '<CActorModel id="A"><On Send="UnmodeledMsg___ SomeToken"/></CActorModel>'
    expect(collectAllRefs(text).filter(m => m.kind === 'link')).toHaveLength(0)
  })
})

describe('findReferences', () => {
  it('collects the definition and a link usage of the same id', () => {
    const link = findLink()!
    const ns = link.info.linkNamespace!
    // A linked-namespace entity defined, then referenced by a CUnit link field.
    const text =
      `<CUnit id="Marine"><${link.name} value="Thing"/></CUnit>\n` + `<C${ns} id="Thing"></C${ns}>`
    const target = { namespace: ns, id: 'Thing' }

    const withDecl = findReferences(text, target, true)
    expect(withDecl.some(m => m.kind === 'definition')).toBe(true)
    expect(withDecl.some(m => m.kind === 'link')).toBe(true)

    const withoutDecl = findReferences(text, target, false)
    expect(withoutDecl.every(m => m.kind !== 'definition')).toBe(true)
    // Each match range points at the referenced id text.
    for (const m of withoutDecl) expect(text.slice(m.start, m.end)).toBe('Thing')
  })

  it('collects a parent reference', () => {
    const refs = collectAllRefs('<CUnit id="Child" parent="Base"></CUnit>')
    expect(refs.some(m => m.kind === 'parent' && m.namespace === 'Unit' && m.id === 'Base')).toBe(
      true,
    )
  })
})

describe('namespaceOfClass (via catalog)', () => {
  it('maps subclasses to their root namespace', () => {
    expect(namespaceOfClass('CUnit')).toBe('Unit')
    // A subclass still resolves to its catalog namespace.
    expect(namespaceOfClass('CEffectDamage')).toBe('Effect')
  })
})
