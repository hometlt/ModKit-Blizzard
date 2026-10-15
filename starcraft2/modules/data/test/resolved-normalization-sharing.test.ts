import { describe, expect, it } from 'vitest'
import { normalizeStarcraft2ResolvedSnapshot } from '../services/catalog/resolved-data-normalization.js'

const normalize = (fields: unknown) => {
  const entity = Object.freeze({ namespace: 'Unit', typeId: 'CUnit', entityId: 'Marine', fields })
  return {
    entity,
    result: normalizeStarcraft2ResolvedSnapshot({
      definitions: [entity],
      entities: [entity],
      relations: [],
      diagnostics: [],
    }),
  }
}

// Token substitution, `##id##`/`$id` included, is catalog-engine's (S3); see catalog.test.ts.
describe('resolved normalization structural sharing', () => {
  it('shares recursively immutable fields that need no substitution', () => {
    const fields = Object.freeze({
      LifeMax: 45,
      Flags: Object.freeze([Object.freeze({ index: 'Ground', value: 1 })]),
    })
    const { entity, result } = normalize(fields)
    expect(result.definitions[0]).toBe(entity)
    expect(result.entities[0]).toBe(entity)
    expect(result.definitions[0].fields).toBe(fields)
  })

  it('leaves field values to the resolver: tokens stay as catalog-engine left them', () => {
    const fields = Object.freeze({ Link: 'Unit/##id##/$id', Custom: '##icon##' })
    const { entity, result } = normalize(fields)
    expect(result.definitions[0]).toBe(entity)
    expect(result.definitions[0].fields).toBe(fields)
  })
})
