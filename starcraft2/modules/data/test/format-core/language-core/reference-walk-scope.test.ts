import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../../../shared/catalog-engine/sc2-catalog/index.js'
import { CLink, DATA_CLASS_SCHEMA } from '../../../shared/catalog-engine/sc2-schema/index.js'
import { collectAllRefs } from '../../../shared/format/language/references.js'

afterEach(() => vi.restoreAllMocks())

it('classifies repeated entity fields once per document while retaining every reference and range', () => {
  const weapon = schema.getClassFields('CUnit')!['WeaponArray']
  const fields = vi.spyOn(schema, 'getClassFields')
  const classify = vi.spyOn(schema, 'classifyField')
  const text = '<Catalog>' + ['A', 'B'].map(id =>
    `<CUnit id="${id}"><WeaponArray Link="Laser"/><WeaponArray Link="Cannon"/></CUnit>`).join('') + '</Catalog>'
  const links = collectAllRefs(text).filter(ref => ref.kind === 'link')
  expect(links.map(ref => [ref.namespace, ref.id])).toEqual([
    ['Weapon', 'Laser'], ['Weapon', 'Cannon'], ['Weapon', 'Laser'], ['Weapon', 'Cannon'],
  ])
  for (const ref of links) expect(text.slice(ref.start, ref.end)).toBe(ref.id)
  expect(fields).toHaveBeenCalledTimes(1)
  expect(classify.mock.calls.filter(([type]) => type === weapon)).toHaveLength(1)
})

it('observes canonical schema changes on the next collection instead of keeping a global type cache', () => {
  class MutableLink extends CLink { static override link = 'Unit' }
  const fields = (DATA_CLASS_SCHEMA['CUnit'] as unknown as { schema: Record<string, unknown> }).schema
  const field = 'ModkitReferenceWalkProbe'
  expect(Object.hasOwn(fields, field)).toBe(false)
  fields[field] = MutableLink
  try {
    const text = `<CUnit id="A"><${field} value="Target"/></CUnit>`
    expect(collectAllRefs(text).filter(ref => ref.kind === 'link').map(ref => ref.namespace)).toEqual(['Unit'])
    MutableLink.link = 'Effect'
    expect(collectAllRefs(text).filter(ref => ref.kind === 'link').map(ref => ref.namespace)).toEqual(['Effect'])
  } finally {
    delete fields[field]
  }
})
