/**
 * StarCraft II sc2arcade dependency loader (offline: injected fetch).
 */
import { describe, it, expect } from 'vitest'
import { Sc2ArcadeClient, depotUrl, parseDependencies, REGION_DEPOTS } from '../battlenet/content-sources/sc2arcade.js'

const SAMPLE = {
  regionId: 1,
  bnetId: 175600,
  list: [
    {
      map: { name: 'Core (Mod)', type: 'dependency_mod' },
      mapHeader: {
        regionId: 1,
        bnetId: 1,
        majorVersion: 1,
        minorVersion: 34,
        headerHash: 'be76...',
        archiveHash: '6de41503',
        archiveFilename: 'Core.SC2Mod',
        archiveSize: 26,
        isExtensionMod: false,
      },
    },
    {
      map: { name: 'Liberty (Mod)', type: 'dependency_mod' },
      mapHeader: {
        regionId: 1,
        bnetId: 2,
        majorVersion: 1,
        minorVersion: 81,
        headerHash: 'c2e6...',
        archiveHash: '421c8aa0',
        archiveFilename: 'Liberty.SC2Mod',
        archiveSize: 29,
        isExtensionMod: false,
      },
    },
  ],
}

describe('depotUrl + REGION_DEPOTS', () => {
  it('builds region depot URLs', () => {
    expect(depotUrl(1, 'abc', 's2ma')).toBe('https://us-s2-depot.classic.blizzard.com/abc.s2ma')
    expect(depotUrl(2, 'def', 's2mh')).toBe('https://eu-s2-depot.classic.blizzard.com/def.s2mh')
    expect(REGION_DEPOTS[5]).toContain('netease')
  })
  it('throws on unknown region', () => {
    let threw = false
    try {
      depotUrl(99, 'x', 's2ma')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('parseDependencies', () => {
  it('extracts the dependency list', () => {
    const deps = parseDependencies(SAMPLE)
    expect(deps.length).toBe(2)
    expect(deps[0]!.name).toBe('Core (Mod)')
    expect(deps[0]!.archiveHash).toBe('6de41503')
    expect(deps[1]!.archiveFilename).toBe('Liberty.SC2Mod')
  })
  it('tolerates missing list', () => {
    expect(parseDependencies({})).toEqual([])
  })
})

describe('Sc2ArcadeClient (injected fetch)', () => {
  it('resolves dependencies via the API + Bearer token', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, status: 200, json: async () => SAMPLE } as Response
    }) as unknown as typeof fetch
    const client = new Sc2ArcadeClient({ token: 'TOK', fetch: fetchImpl })
    const deps = await client.dependencies(1, 175600)
    expect(deps.length).toBe(2)
    expect(calls[0]!.url).toBe('https://api.sc2arcade.com/maps/1/175600/dependencies')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer TOK')
  })
})
