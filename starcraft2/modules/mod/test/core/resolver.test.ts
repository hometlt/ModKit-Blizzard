import { describe, expect, it } from 'vitest'
import { ModResolver, type ResolveProbe, type ResolverSource } from '../../shared/workspace/resolver.js'

function source(label: string, values: Record<string, string>): ResolverSource {
  return {
    label,
    async resolve(name) {
      return values[name]
    },
  }
}

describe('ModResolver', () => {
  it('uses first-hit source order and reports each probe', async () => {
    const resolver = new ModResolver({
      sources: [
        source('workspace', { Shared: 'workspace:Shared' }),
        source('install', { Core: 'install:Core', Shared: 'install:Shared' }),
      ],
    })
    const probes: ResolveProbe[] = []

    expect(await resolver.resolve('Shared', probe => probes.push(probe))).toBe('workspace:Shared')
    expect(probes.map(probe => [probe.source, probe.hit])).toEqual([['workspace', true]])

    probes.length = 0
    expect(await resolver.resolve('Core', probe => probes.push(probe))).toBe('install:Core')
    expect(probes.map(probe => [probe.source, probe.hit])).toEqual([
      ['workspace', false],
      ['install', true],
    ])
  })

  it('returns semantic absence after every source misses', async () => {
    const resolver = new ModResolver({ sources: [source('empty', {})] })
    expect(await resolver.resolve('Missing')).toBeUndefined()
  })
})
