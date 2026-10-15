import { describe, expect, it } from 'vitest'
import { Parser, TypeChecker, bindSourceFile, normalizeGalaxyIncludeIdentity } from '../language-core/index.js'

describe('Galaxy canonical include identity', () => {
  it('normalizes case, path aliases and the optional extension', () => {
    expect(normalizeGalaxyIncludeIdentity('/TriggerLibs/Helpers.GALAXY')).toBe('triggerlibs/helpers')
    expect(normalizeGalaxyIncludeIdentity('TriggerLibs\\Helpers')).toBe('triggerlibs/helpers')
  })

  it('diagnoses a multi-file cycle by canonical SourceFile identity', () => {
    const parser = new Parser()
    const a = parser.parseFile('file:///A.galaxy', 'include "B"')
    const b = parser.parseFile('file:///B.galaxy', 'include "a.galaxy"')
    const documents = new Map([[a.fileName, a], [b.fileName, b]])
    const qualifiedDocuments = new Map([
      ['a', new Map([[a.fileName, a]])],
      ['b', new Map([[b.fileName, b]])],
    ])
    const host = {
      documents,
      qualifiedDocuments,
      resolveQualifiedDocuments: (name: string) => qualifiedDocuments.get(name),
      resolveGlobalSymbol: () => undefined,
    }
    bindSourceFile(a, host as never)
    bindSourceFile(b, host as never)
    const result = new TypeChecker(host as never).checkSourceFileRecursively(a)
    expect([...result.diagnostics.values()].flat().map(item => item.messageText)).toContain(
      'Circular include reaches file:///A.galaxy',
    )
  })
})
