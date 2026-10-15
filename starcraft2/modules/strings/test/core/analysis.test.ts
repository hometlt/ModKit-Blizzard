import { describe, it, expect } from 'vitest'
import { parseSc2StringsOrdered } from '../../shared/core/text-file.js'
import { analyzeStringFile, compareLocales } from '../../shared/core/analysis.js'
import type { CatalogResolver } from '../../shared/core/resolve.js'

const mod: CatalogResolver = {
  getResolved: (ns, id) => (ns === 'Unit' && id === 'Marine' ? { Life: 45 } : undefined),
}

describe('analyzeStringFile', () => {
  it('warns on duplicate keys (every occurrence after the first)', () => {
    const model = parseSc2StringsOrdered('A=1\nA=2\nA=3\nB=4\n')
    const diags = analyzeStringFile(model)
    const dups = diags.filter((d) => d.code === 'duplicate-key')
    expect(dups).toHaveLength(2)
    expect(dups[0]).toMatchObject({ key: 'A', severity: 'warning', line: 1 })
    expect(dups[1]).toMatchObject({ key: 'A', line: 2 })
  })

  it('does not warn on empty values (intentional/common in SC2)', () => {
    const diags = analyzeStringFile(parseSc2StringsOrdered('A=\nB=\n'))
    expect(diags).toHaveLength(0)
  })

  it('flags broken refs as errors when a resolver is supplied', () => {
    const model = parseSc2StringsOrdered('A=<d ref="Unit,Ghost,Life"/>\nB=<d ref="Unit,Marine,Life"/>\n')
    const diags = analyzeStringFile(model, mod)
    const broken = diags.filter((d) => d.code === 'broken-ref')
    expect(broken).toHaveLength(1)
    expect(broken[0]).toMatchObject({ key: 'A', severity: 'error' })
  })

  it('reports the broken-ref offset span as just the <d ref> tag, not the whole value', () => {
    const value = 'Life: <d ref="Unit,Ghost,Life"/> total'
    const model = parseSc2StringsOrdered(`A=${value}\n`)
    const [broken] = analyzeStringFile(model, mod).filter((d) => d.code === 'broken-ref')
    expect(broken).toBeDefined()
    expect(value.slice(broken!.start!, broken!.end!)).toBe('<d ref="Unit,Ghost,Life"/>')
  })

  it('reports the broken-ref offset span for a ref nested inside a <c> color tag', () => {
    const value = '<c val="ff0000">Life: <d ref="Unit,Ghost,Life"/></c>'
    const model = parseSc2StringsOrdered(`A=${value}\n`)
    const [broken] = analyzeStringFile(model, mod).filter((d) => d.code === 'broken-ref')
    expect(broken).toBeDefined()
    expect(value.slice(broken!.start!, broken!.end!)).toBe('<d ref="Unit,Ghost,Life"/>')
  })

  it('flags malformed tilde runtime tokens with an offset span covering just the token', () => {
    const value = 'Hello ~PLA!YER~ and goodbye' // '!' breaks the token, but it's still closed by a later '~'
    const model = parseSc2StringsOrdered(`A=${value}\nB=Hello ~PLAYER~\n`)
    const malformed = analyzeStringFile(model).filter((d) => d.code === 'malformed-markup')
    expect(malformed).toHaveLength(1)
    expect(malformed[0]).toMatchObject({ key: 'A', severity: 'error' })
    expect(value.slice(malformed[0]!.start!, malformed[0]!.end!)).toBe('~PLA!YER~')
  })

  it('accepts computed d-tags inside attributes', () => {
    const model = parseSc2StringsOrdered("A=<c val=\"[d Player='~ID~' GameValue='PlayerColor'/]\">~PLAYER~</c>\n")
    expect(analyzeStringFile(model).filter((d) => d.code === 'malformed-markup')).toHaveLength(0)
  })
})

describe('compareLocales', () => {
  it('reports missing/orphaned/identical/empty', () => {
    const source = parseSc2StringsOrdered('A=Apple\nB=Bee\nC=Cat\nD=Dog\n')
    const target = parseSc2StringsOrdered('A=Яблоко\nB=Bee\nC=\nE=Extra\n')
    const cmp = compareLocales(source, target)
    expect(cmp.missing).toEqual(['D'])
    expect(cmp.identical).toEqual(['B'])
    expect(cmp.empty).toEqual(['C'])
    expect(cmp.orphaned).toEqual(['E'])
    expect(cmp.translated).toBe(1) // only A
    expect(cmp.total).toBe(4)
  })
})
