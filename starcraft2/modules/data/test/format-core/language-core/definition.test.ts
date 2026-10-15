/**
 * M4 — go-to-definition core (vscode-free): request detection + entity location.
 */
import { describe, it, expect } from 'vitest'
import { definitionRequestAt, locateEntityOffset } from '../../../shared/format/language/definition.js'
import { getClassFields, classifyField, type FieldInfo } from '../../../shared/catalog-engine/sc2-catalog'

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

describe('definitionRequestAt', () => {
  it('detects a parent="…" reference', () => {
    const { text, offset } = cursor('<CUnit id="X" parent="Ba|se"></CUnit>')
    const req = definitionRequestAt(text, offset)
    expect(req).toEqual({ kind: 'parent', id: 'Base', entityClass: 'CUnit', entityId: 'X' })
  })

  it('detects an entity link field value', () => {
    const link = findLink()
    expect(link, 'expected a link field on CUnit').toBeDefined()
    const { text, offset } = cursor(`<CUnit id="X"><${link!.name} value="Ta|rget"/></CUnit>`)
    const req = definitionRequestAt(text, offset)
    expect(req).toEqual({ kind: 'link', namespace: link!.info.linkNamespace, id: 'Target' })
  })

  it('detects a text-link field value as a text key (DX4)', () => {
    const schema = getClassFields('CUnit')!
    const entry = Object.entries(schema).find(([, ft]) => {
      const i = classifyField(ft)
      return i.kind === 'link' && i.isTextLink
    })
    if (!entry) return
    const { text, offset } = cursor(`<CUnit id="X"><${entry[0]} value="Unit/Na|me/X"/></CUnit>`)
    expect(definitionRequestAt(text, offset)).toEqual({ kind: 'text', key: 'Unit/Name/X' })
  })

  it('detects a file-link field value as a file path (DX3)', () => {
    const schema = getClassFields('CActor') ?? getClassFields('CUnit')!
    const entry = Object.entries(schema).find(([, ft]) => {
      const i = classifyField(ft)
      return i.kind === 'file' || (i.kind === 'link' && i.isFileLink)
    })
    if (!entry) return
    const cls = getClassFields('CActor') ? 'CActor' : 'CUnit'
    const { text, offset } = cursor(`<${cls} id="X"><${entry[0]} value="Foo|.m3"/></${cls}>`)
    expect(definitionRequestAt(text, offset)).toEqual({ kind: 'file', path: 'Foo.m3' })
  })

  it('detects a catalogRef value as a link to the referenced entity (DX2)', () => {
    // Discover a catalogRef field (Effect/Validator/Requirement style "Ns,Entry,Field").
    let found: { cls: string; name: string } | undefined
    for (const cls of [
      'CEffectDamage',
      'CEffectApplyBehavior',
      'CAbil',
      'CValidatorUnitCompareField',
      'CBehaviorBuff',
    ]) {
      const schema = getClassFields(cls)
      if (!schema) continue
      const entry = Object.entries(schema).find(([, ft]) => classifyField(ft).kind === 'catalogRef')
      if (entry) {
        found = { cls, name: entry[0] }
        break
      }
    }
    if (!found) return
    const { text, offset } = cursor(
      `<${found.cls} id="X"><${found.name} value="Effect,My|Effect,Amount"/></${found.cls}>`,
    )
    expect(definitionRequestAt(text, offset)).toEqual({
      kind: 'link',
      namespace: 'Effect',
      id: 'MyEffect',
    })
  })

  // DX7: go-to-definition from inside an actor-message / actor-term arg token.
  it('detects an actor `Send` arg as a link to the referenced entity (ModelSwap → Model)', () => {
    const { text, offset } = cursor(
      '<CActorModel id="A"><On Send="ModelSwap My|Model 9"/></CActorModel>',
    )
    expect(definitionRequestAt(text, offset)).toEqual({
      kind: 'link',
      namespace: 'Model',
      id: 'MyModel',
    })
  })

  it('detects a unit ref inside a `;`-list actor Terms segment (AbilTrainProduced → Unit)', () => {
    const { text, offset } = cursor(
      '<CActorModel id="A"><On Terms="Age; AbilTrainProduced My|Unit"/></CActorModel>',
    )
    expect(definitionRequestAt(text, offset)).toEqual({
      kind: 'link',
      namespace: 'Unit',
      id: 'MyUnit',
    })
  })

  it('returns undefined on the instruction keyword or a numeric arg (not a reference)', () => {
    const kw = cursor('<CActorModel id="A"><On Send="Model|Swap MyModel 9"/></CActorModel>')
    expect(definitionRequestAt(kw.text, kw.offset)).toBeUndefined()
    const num = cursor('<CActorModel id="A"><On Send="ModelSwap MyModel |9"/></CActorModel>')
    expect(definitionRequestAt(num.text, num.offset)).toBeUndefined()
  })

  it('returns undefined off any reference', () => {
    const { text, offset } = cursor('<CUnit id="X"|></CUnit>')
    expect(definitionRequestAt(text, offset)).toBeUndefined()
  })
})

describe('locateEntityOffset', () => {
  it('finds the entity opening tag by id', () => {
    const text = '<CUnit id="A"></CUnit>\n<CUnit id="B"></CUnit>'
    const off = locateEntityOffset(text, 'B')
    expect(off).toBeDefined()
    expect(text.slice(off!, off! + 5)).toBe('CUnit')
    expect(text.indexOf('id="B"')).toBeGreaterThan(off!)
  })

  it('prefers a class match when given', () => {
    const text = '<CEffectDamage id="X"/>\n<CUnit id="X"/>'
    const off = locateEntityOffset(text, 'X', 'CUnit')
    expect(text.slice(off!, off! + 5)).toBe('CUnit')
  })
})
