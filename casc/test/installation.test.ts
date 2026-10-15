import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CascReader } from '../src/casc/index.js'
import { cascInstallationArchive, installationBuild, openCascInstallation } from '../src/casc/installation.js'
import { arrayPathIndex } from '../src/casc/path-index.js'

describe('CASC installation for content sources', () => {
  it('names the build, the product and the game of .build.info, and nothing without it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'casc-installation-'))
    try {
      expect(installationBuild(folder)).toBeUndefined()
      await writeFile(join(folder, '.build.info'),
        'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Path!STRING:0|Product!STRING:0\n' +
        'eu|1|5bc8dcc1fade3a320c12936586b7c0ed|tpr/sc2|\n')
      expect(installationBuild(folder)).toEqual({ buildKey: '5bc8dcc1fade3a320c12936586b7c0ed', product: 's2', game: 'starcraft2' })
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('refuses a relative installation folder', async () => {
    await expect(openCascInstallation('StarCraft II')).rejects.toThrow(/absolute/u)
  })

  it('lists every name of the index as one archive and reads within the limit', async () => {
    const sizes = new Map([['mods/core.sc2mod/base.sc2data/gamedata/unitdata.xml', 5], ['versions.winarchive', 3]])
    let closed = false
    const reader = {
      entryIndex: arrayPathIndex([...sizes].map(([path, contentSize]) => ({ path, contentSize }))),
      contentSizeOf: (path: string) => sizes.get(path),
      readPath: async (path: string) => new Uint8Array(sizes.get(path)!),
      close: async () => { closed = true },
    } as unknown as CascReader
    const archive = cascInstallationArchive(reader, 'CASC')
    expect(archive.entries).toEqual([
      { path: 'mods/core.sc2mod/base.sc2data/gamedata/unitdata.xml', size: 5 },
      { path: 'versions.winarchive', size: 3 },
    ])
    expect((await archive.read('versions.winarchive', 3)).length).toBe(3)
    await expect(archive.read('versions.winarchive', 2)).rejects.toThrow(/read limit/u)
    await expect(archive.read('missing', 10)).rejects.toThrow(/not found/u)
    await archive.close()
    expect(closed).toBe(true)
  })
})
