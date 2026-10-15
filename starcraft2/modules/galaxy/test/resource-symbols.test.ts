import { describe, expect, it } from 'vitest'
import { analyzeGalaxyLanguage, toGalaxySymbolTree } from '@modkit/blizzard-starcraft2/galaxy/analysis/language-service.js'

describe('Galaxy resource projection', () => {
  it('keeps declaration initializers and UTF-16 navigation without publishing runtime values', () => {
    const text = '// 😀 navigation\nconst int limit = 2 + 3;\nint current;\nvoid Main(int player) {}\nstruct State { int count; };'
    const index = analyzeGalaxyLanguage(text, 'resources.galaxy')
    const symbols = toGalaxySymbolTree(index.symbols)
    const limit = symbols.find(symbol => symbol.name === 'limit')!
    expect(limit).toMatchObject({
      kind: 'variable', detail: 'int', declaration: 'const int limit = 2 + 3',
      selectionStart: text.indexOf('limit'),
    })
    expect(limit).not.toHaveProperty('value')
    expect(symbols.find(symbol => symbol.name === 'current')?.declaration).toBe('int current')
    expect(symbols.find(symbol => symbol.name === 'Main')?.detail).toBe('void Main(int player)')
    expect(symbols.find(symbol => symbol.name === 'State')?.children?.[0]).toMatchObject({
      name: 'count', kind: 'property', selectionStart: text.indexOf('count'),
    })
    expect(JSON.parse(JSON.stringify(symbols))).toEqual(symbols)
    expect(index.symbols.find(symbol => symbol.name === 'limit')?.declaration).toBe(limit.declaration)
  })
})
