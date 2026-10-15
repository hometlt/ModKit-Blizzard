import { describe, expect, it } from 'vitest'
import {
  preloadAssetDbEntries,
  readPreloadAssetDb,
  resolvePreloadAssetPaths,
  writePreloadAssetDb,
} from '../../shared/format/index.js'

describe('PreloadAssetDB.txt', () => {
  it('parses sections, entries, repeated keyed values, and canonical round-trips', () => {
    const text = `[Actor]
id=InterceptorOnboardFighter
path=Assets\\Textures\\.dds
asset=btn-unit-protoss-interceptor,wireframe-protoss-interceptor
Actor=GroundLocalSelection,PortraitActor
Model=Interceptor,InterceptorDeath

[Effect]
id=BlinkAndNova
Effect=BlinkNova3Novas,BlinkTeleport
`
    const parsed = readPreloadAssetDb(text)
    const entries = preloadAssetDbEntries(parsed)

    expect(parsed.sections.map(section => section.name)).toEqual(['Actor', 'Effect'])
    expect(entries.map(entry => entry.id)).toEqual(['InterceptorOnboardFighter', 'BlinkAndNova'])
    expect(entries[0]!.fields['Actor']).toEqual(['GroundLocalSelection', 'PortraitActor'])
    expect(resolvePreloadAssetPaths(entries[0]!)).toEqual([
      'Assets/Textures/btn-unit-protoss-interceptor.dds',
      'Assets/Textures/wireframe-protoss-interceptor.dds',
    ])
    expect(readPreloadAssetDb(writePreloadAssetDb(parsed))).toEqual(parsed)
  })
})
