import { describe, expect, it } from 'vitest'
import type { CascSource } from '../../src/casc/types.js'
import {
  detectCascDataDirectory,
  getActiveBuild,
  parseBuildInfo,
  parseConfig,
} from '../../src/casc/config.js'

function dataDirectorySource(buildInfo: string, directories: readonly string[]): CascSource {
  return {
    list: async () => [],
    get: async path => {
      if (path === 'Game/.build.info') return new TextEncoder().encode(buildInfo)
      throw new Error(`unexpected read: ${path}`)
    },
    exists: async path => directories.includes(path),
  }
}

describe('CASC config parsing', () => {
  it('parses active .build.info records', () => {
    const records = parseBuildInfo(
      [
        'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0',
        'eu|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|5.0|SC2',
      ].join('\n'),
    )

    const active = getActiveBuild(records)
    expect(active.branch).toBe('eu')
    expect(active.active).toBe(true)
    expect(active.buildKey).toBe('00112233445566778899aabbccddeeff')
    expect(active.product).toBe('SC2')
  })

  it('parses key and size pairs from build config files', () => {
    const config = parseConfig(
      [
        '# Build Configuration',
        'encoding = contentkey encodingkey',
        'encoding-size = 123 100',
        'root = rootcontent',
      ].join('\n'),
    )

    expect(config.getKeyPair('encoding')).toEqual({
      contentKey: 'contentkey',
      encodingKey: 'encodingkey',
    })
    expect(config.getSizePair('encoding')).toEqual({ size: 123, storedSize: 100 })
    expect(config.getKeyPair('root')).toEqual({
      contentKey: 'rootcontent',
      encodingKey: 'rootcontent',
    })
  })

  it('selects HeroesData from active Heroes product identity', async () => {
    const buildInfo = [
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0|Build UID!STRING:0|Build Product!STRING:0|CDN Path!STRING:0',
      'us|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|2.55.16.97039|hero|hero|Hero|tpr/Hero-Live-a',
    ].join('\n')
    const source = dataDirectorySource(buildInfo, ['Game/HeroesData', 'Game/SC2Data', 'Game/Data'])

    await expect(detectCascDataDirectory(source, 'Game')).resolves.toBe('HeroesData')
  })

  it('keeps SC2Data preferred for an SC2 build when multiple directories exist', async () => {
    const buildInfo = [
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0|Build Product!STRING:0',
      'us|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|5.0|s2|StarCraft2',
    ].join('\n')
    const source = dataDirectorySource(buildInfo, ['Game/HeroesData', 'Game/SC2Data'])

    await expect(detectCascDataDirectory(source, 'Game')).resolves.toBe('SC2Data')
  })

  it('selects Data for a Warcraft III build when multiple directories exist', async () => {
    const buildInfo = [
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0|Build Product!STRING:0',
      'us|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|2.0.4.23556-retail|w3|War3',
    ].join('\n')
    const source = dataDirectorySource(buildInfo, ['Game/Data', 'Game/SC2Data'])

    await expect(detectCascDataDirectory(source, 'Game')).resolves.toBe('Data')
  })

  it('selects Data for Diablo II: Resurrected and Warcraft II: Remastered builds', async () => {
    const diablo2BuildInfo = [
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0|CDN Path!STRING:0',
      'us|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|2.8.0|osi|tpr/osi',
    ].join('\n')
    const warcraft2BuildInfo = [
      'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0|CDN Path!STRING:0',
      'us|1|00112233445566778899aabbccddeeff|ffeeddccbbaa99887766554433221100|1.0.2|w2r|tpr/w2r-live',
    ].join('\n')

    await expect(
      detectCascDataDirectory(
        dataDirectorySource(diablo2BuildInfo, ['Game/Data', 'Game/SC2Data']),
        'Game',
      ),
    ).resolves.toBe('Data')
    await expect(
      detectCascDataDirectory(
        dataDirectorySource(warcraft2BuildInfo, ['Game/Data', 'Game/SC2Data']),
        'Game',
      ),
    ).resolves.toBe('Data')
  })
})
