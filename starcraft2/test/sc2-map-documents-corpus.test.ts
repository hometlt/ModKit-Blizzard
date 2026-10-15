import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSc2MapDocuments, serializeSc2MapDocuments } from '../modules/map/shared/coordinator.js'

const repository = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')
const mapRoot =
  `${repository}/../artifacts/legacy-parity-sc2/sc2-map/harness-prep/corpus/real/loose/` +
  'tiberium-full/mission-nod.SC2Map/'
const installedRoot = 'C:/Apps/StarCraft II/Maps/all-races-coop-maps'
const corpusIt = process.env.MODKIT_TEST_INSTALLED_CORPUS === '1' ? it : it.skip

describe('SC2 map document installed corpus', () => {
  corpusIt('reads confirmed documents and preserves no-op serialization byte-for-byte', () => {
    const paths = new Map([
      ['MapInfo', `${mapRoot}MapInfo`],
      ['CellAttribute_Pnp', `${mapRoot}CellAttribute_Pnp`],
      ['CellAttribute_Pgr', `${mapRoot}CellAttribute_Pgr`],
      ['CellAttribute_Pnb', `${mapRoot}CellAttribute_Pnb`],
      ['PreloadAssetDB.txt', `${mapRoot}PreloadAssetDB.txt`],
      ['Objects', `${mapRoot}Objects`],
      ['Attributes', `${installedRoot}/03-DeadOfNight.SC2Map/Attributes`],
      ['CustomAI', `${installedRoot}/02-CradleOfDeath.SC2Map/CustomAI`],
    ])
    const files = new Map(
      [...paths].map(([name, path]) => [name, new Uint8Array(readFileSync(path))]),
    )
    const failures: string[] = []
    const data = parseSc2MapDocuments(files, {
      onError: (path, error) => failures.push(`${path}: ${String(error)}`),
    })

    expect(failures).toEqual([])
    expect([data.info?.width, data.info?.height]).toEqual([232, 232])
    expect(Object.keys(data.cellAttributes ?? {}).sort()).toEqual(['pgr', 'pnb', 'pnp'])
    for (const document of Object.values(data.cellAttributes ?? {})) {
      expect(document.value?.cells).toHaveLength(53_824)
    }
    expect(data.preloadAssetDb?.sections).toHaveLength(9)
    expect(data.objects?.byId.size).toBeGreaterThan(0)
    expect(data.attributes?.rootTag).toBe('Attributes')
    expect(data.customAi?.rootTag).toBe('AIData')
    expect(data.objects?.byId.size).toBeGreaterThan(0)

    const serialized = serializeSc2MapDocuments(data)
    for (const [name, bytes] of files) expect(serialized.get(name)).toEqual(bytes)
  })
})
