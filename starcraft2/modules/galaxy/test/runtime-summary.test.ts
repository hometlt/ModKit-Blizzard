import { describe, expect, it } from 'vitest'
import { scanGalaxySource } from '../services/analysis/runtime-summary.js'
import { scanGalaxy } from '../../../shared/language/galaxy-analysis.js'

describe('Galaxy runtime summary', () => {
  it('uses one parser for includes, declarations and structural depth', () => {
    const source = 'include "Base";\nvoid main() { if (true) { } }'
    const budget = { maxNodes: 1, maxDepth: 2 }
    expect(scanGalaxySource(source, budget)).toEqual(scanGalaxy(source, budget))
    expect(scanGalaxy(source, budget)).toMatchObject({
      functions: [{ name: 'main', parameters: 0 }], includes: ['Base'], maximumDepth: 2,
    })
    expect(() => scanGalaxy(source, { maxNodes: 1, maxDepth: 1 })).toThrow(/maxDepth/u)
    expect(() => scanGalaxy(source, { maxNodes: 0, maxDepth: 2 })).toThrow(/maxNodes/u)
  })

  it('rejects malformed source instead of reporting a plausible regex match', () => {
    expect(() => scanGalaxy('void main() {', { maxNodes: 4, maxDepth: 4 })).toThrow(/syntax/u)
  })
})
