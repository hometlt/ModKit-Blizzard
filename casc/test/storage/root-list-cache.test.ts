import { describe, expect, it } from 'vitest'

import { Diablo3NameDb, getDiablo3AssetInfoForPath } from '../../src/casc/diablo3-root.js'
import { cacheRoot, cachedRoot } from '../../src/casc/reader.js'
import { TvfsNameDb } from '../../src/casc/tvfs.js'

function memoryCache() {
  const stored = new Map<string, Uint8Array>()
  return {
    stored,
    async load(key: string, kind = 'mndx') {
      return stored.get(`${key}/${kind}`)
    },
    async store(key: string, bytes: Uint8Array, kind = 'mndx') {
      stored.set(`${key}/${kind}`, bytes)
    },
  }
}

const encoding = { get: (contentKey: string) => (contentKey === 'aa'.repeat(16) ? { size: 5 } : undefined) }

describe('CASC root file-list cache (roots other than MNDX)', () => {
  it('rebuilds a Diablo III root with its SNO paths and cached sizes', async () => {
    const texture = getDiablo3AssetInfoForPath('x.tex')!
    const files = [
      { path: 'Textures/01sun.tex', contentKey: 'aa'.repeat(16), kind: 'asset', assetIndex: texture.assetIndex, fileIndex: 42 },
      { path: 'Base/CoreTOC.dat', contentKey: 'bb'.repeat(16), kind: 'named' },
    ]
    const cache = memoryCache()
    await cacheRoot(cache, 'e40c', { rootFormat: 'diablo3', nameDb: new Diablo3NameDb(files) }, encoding)
    expect(cache.stored.has('e40c/names')).toBe(true)

    const restored = await cachedRoot(cache, 'e40c')
    expect(restored?.rootFormat).toBe('diablo3')
    expect(restored?.nameDb.getByPath('textures/01sun.tex')).toMatchObject({ contentSize: 5, fileIndex: 42 })
    // The SNO path still resolves by asset id; a key the encoding lacked keeps size 0.
    expect(restored?.nameDb.getByPath('Textures/42.tex')?.path).toBe('Textures/01sun.tex')
    expect(restored?.nameDb.getByPath('Base/CoreTOC.dat')).toMatchObject({ kind: 'named', contentSize: 0 })
    expect(restored?.nameDb.getByPath('Base/CoreTOC.dat')).not.toHaveProperty('assetIndex')
  })

  it('keeps a TVFS record with its span keys and refuses a cache of another version', async () => {
    const file = {
      path: 'data/a.txt',
      contentKey: 'cc'.repeat(9),
      encodingKey: 'cc'.repeat(9),
      encodingKeys: ['cc'.repeat(9), 'dd'.repeat(9)],
      contentSize: 12,
      spanCount: 2,
    }
    const cache = memoryCache()
    await cacheRoot(cache, 'f00d', { rootFormat: 'tvfs', nameDb: new TvfsNameDb([file]) }, encoding)
    expect((await cachedRoot(cache, 'f00d'))?.nameDb.getByPath('data/a.txt')).toEqual(file)

    const foreign = JSON.stringify({ version: 1, rootFormat: 'tvfs', files: [file] })
    cache.stored.set('f00d/names', new TextEncoder().encode(foreign))
    await expect(cachedRoot(cache, 'f00d')).resolves.toBeUndefined()
  })
})
