/**
 * The bridge from a catalog-analysis snapshot to the strings library's resolver.
 *
 * This is the link that lets one codec read another's resolved data, so the cases below are the
 * ways it could quietly answer wrongly — each of which turns a healthy catalog into a broken one,
 * or the reverse.
 */
import { describe, expect, it } from 'vitest'
import { catalogResolverFromSnapshot } from '../shared/language/catalog-resolver.js'

const snapshot = {
  entities: [
    { namespace: 'Effect', entityId: 'Foo', fields: { Amount: 42, Name: 'Foo effect' } },
    { namespace: 'Unit', entityId: 'Marine', fields: { LifeMax: 45 } },
  ],
  localizedStrings: [
    { key: 'Unit/Name/Marine', value: 'Marine', resolvedLocale: 'enUS' },
    { key: 'Unit/Name/Marine', value: 'Marine (stale)', resolvedLocale: 'enGB' },
  ],
}

describe('catalog snapshot bridge', () => {
  it('resolves a field of an entity the snapshot covers', () => {
    const { resolver } = catalogResolverFromSnapshot(snapshot)
    expect(resolver.getResolved('Effect', 'Foo')).toMatchObject({ Amount: 42 })
  })

  /*
   * The important negative. `validateStringRefs` reads an empty record as "the entity exists and
   * has no such field" and reports a broken reference; answering `{}` for an entity the snapshot
   * never covered would condemn a healthy catalog.
   */
  it('answers undefined for an entity the snapshot does not cover, never an empty record', () => {
    const { resolver } = catalogResolverFromSnapshot(snapshot)
    expect(resolver.getResolved('Effect', 'Absent')).toBeUndefined()
    expect(resolver.getResolved('Nope', 'Foo')).toBeUndefined()
  })

  it('keeps the first localized value for a key rather than the last', () => {
    // The analyzer emits the requested locale first; a later fallback must not overwrite it.
    const { resolver } = catalogResolverFromSnapshot(snapshot)
    expect(resolver.getString?.('Unit/Name/Marine')).toBe('Marine')
  })

  it('lets a queried entity override a definition of the same id', () => {
    const { resolver } = catalogResolverFromSnapshot({
      definitions: [{ namespace: 'Unit', entityId: 'Marine', fields: { LifeMax: 1 } }],
      entities: [{ namespace: 'Unit', entityId: 'Marine', fields: { LifeMax: 45 } }],
    })
    expect(resolver.getResolved('Unit', 'Marine')).toMatchObject({ LifeMax: 45 })
  })

  it('reports what it actually holds, so a caller can state limits instead of guessing', () => {
    const { coverage } = catalogResolverFromSnapshot(snapshot)
    expect(coverage).toEqual({ entities: 2, strings: 1, namespaces: ['Effect', 'Unit'] })
  })

  it('carries text styles and constants, which come from a different file than the data', () => {
    const { resolver } = catalogResolverFromSnapshot(snapshot, {
      constants: { ColorGood: '00ff00' },
      styles: { Alert: { name: 'Alert', attrs: { TextColor: 'ff0000' } } },
      galaxyVariables: { libCore_gv_playerCount: 4 },
    })
    expect(resolver.getTextConstant?.('ColorGood')).toBe('00ff00')
    expect(resolver.getTextStyle?.('Alert')).toMatchObject({ name: 'Alert' })
    expect(resolver.getGalaxyVar?.('libCore_gv_playerCount')).toMatchObject({ value: 4 })
  })

  it('is empty but usable for an empty snapshot', () => {
    const { resolver, coverage } = catalogResolverFromSnapshot({})
    expect(resolver.getResolved('Unit', 'Marine')).toBeUndefined()
    expect(coverage.entities).toBe(0)
  })
})
