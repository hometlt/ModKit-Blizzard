import { describe, expect, it } from 'vitest'
import { orderGameDataFilePaths } from '../shared/catalog-engine/gamedata-order.js'

describe('SC2 GameData document order', () => {
  it('orders schema catalogs before extra flat files and manifest-declared nested catalogs', async () => {
    const manifest = 'Base.SC2Data/GameData.xml'
    const ordered = await orderGameDataFilePaths(
      [
        'Base.SC2Data/GameData/Nested/Balance.xml',
        'Base.SC2Data/GameData/ZExtra.xml',
        'Base.SC2Data/GameData/UnitData.xml',
        manifest,
      ],
      async path =>
        path === manifest ? '<Includes><Catalog path="GameData/Nested/Balance.xml"/></Includes>' : undefined,
    )

    expect(ordered).toEqual([
      'Base.SC2Data/GameData/UnitData.xml',
      'Base.SC2Data/GameData/ZExtra.xml',
      'Base.SC2Data/GameData/Nested/Balance.xml',
    ])
  })

  it('falls back to GameData files below a nonstandard archive prefix', async () => {
    await expect(
      orderGameDataFilePaths(['Custom/Base/GameData/UnitData.xml'], async () => undefined),
    ).resolves.toEqual(['Custom/Base/GameData/UnitData.xml'])
  })
})
