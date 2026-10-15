import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { describe, expect, it } from 'vitest'
import { ascii, authoredMap, authoredScenario } from './sc1-fixtures.js'

const extension = join(import.meta.dirname, '..')
const { createContentSources, STARCRAFT1_ROOT_ID } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href
)) as typeof import('../dist/game/content-sources.js')

/** An installation folder whose `.build.info` names `cdnPath`; no storage behind it. */
async function installation(cdnPath: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-source-'))
  await writeFile(
    join(root, '.build.info'),
    `Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Path!STRING:0|Version!STRING:0|Product!STRING:0\neu|1|864772b9ff94f6d372aa4ee90ee2f8ab|${cdnPath}|1.23.10.13515|\n`,
    'utf8',
  )
  await mkdir(join(root, 'Data'))
  return root
}

describe('StarCraft content sources', () => {
  it('gives a Remastered installation one root over its storage, opened on first use', async () => {
    const root = await installation('tpr/sc1live')
    const sources = await createContentSources({ installationDirectory: root })
    const snapshot = await sources.snapshot()
    expect(snapshot.roots).toEqual([
      expect.objectContaining({
        id: STARCRAFT1_ROOT_ID,
        storageOf: root,
        product: 's1',
        revision: '864772b9ff94f6d372aa4ee90ee2f8ab',
      }),
    ])
    // Nothing was read to say so: the storage opens when the tree is first asked for, and this
    // folder has none.
    await expect(sources.list(STARCRAFT1_ROOT_ID, '')).rejects.toThrow()
    await sources.dispose?.()
  })

  it('gives another CASC product and a folder without a build record no root', async () => {
    for (const root of [await installation('tpr/sc2'), await mkdtemp(join(tmpdir(), 'modkit-sc1-empty-'))]) {
      const sources = await createContentSources({ installationDirectory: root })
      expect((await sources.snapshot()).roots).toEqual([])
    }
  })

  it('opens a map inside the game: the installation behind it, the map itself last', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'modkit-sc1-context-'))
    const path = join(folder, 'Test.scm')
    await writeFile(path, await authoredMap())
    // No installation here: the context says what it misses rather than pretending to be whole.
    const sources = await createContentSources({ installationDirectory: folder })
    expect(await sources.locateModPackage!(path)).toMatchObject({ kind: 'package', displayName: 'Test.scm' })
    expect(await sources.locateModPackage!(join(folder, 'scenario.chk'))).toEqual({ kind: 'missing' })
    expect(await sources.locateModPackage!(join(folder, 'War.w3x'))).toEqual({ kind: 'foreign' })
    const context = await sources.openModContext!({ target: path })
    try {
      expect(context.gameId).toBe('blizzard/starcraft-1')
      expect(context.layers.map(layer => [layer.id, layer.role, layer.kind])).toEqual([['primary', 'primary', 'package']])
      expect(context.unresolved).toEqual(['StarCraft installation'])
      expect((await context.files('primary', { limit: 10 })).items).toEqual(['staredit/scenario.chk'])
      expect(await context.locate('STAREDIT\\SCENARIO.CHK')).toEqual({ layerId: 'primary', path: 'STAREDIT/SCENARIO.CHK' })
      expect(await context.read('primary', 'staredit/scenario.chk', 1 << 20)).toEqual(authoredScenario())
    } finally {
      await context.dispose()
    }
  })

  it('gives a classic installation one root over its MPQ chain, the patch over the base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-classic-'))
    await writeFile(join(root, 'StarDat.mpq'), encodeFreshMpq([
      { path: 'rez/stat_txt.tbl', bytes: ascii('base') },
      { path: 'tileset/jungle.cv5', bytes: ascii('cv5') },
    ]))
    await writeFile(join(root, 'BrooDat.mpq'), encodeFreshMpq([{ path: 'arr/units.dat', bytes: ascii('units') }]))
    await writeFile(join(root, 'patch_rt.mpq'), encodeFreshMpq([{ path: 'rez/stat_txt.tbl', bytes: ascii('patch') }]))
    const sources = await createContentSources({ installationDirectory: root })
    try {
      expect((await sources.snapshot()).roots).toEqual([
        expect.objectContaining({ id: STARCRAFT1_ROOT_ID, storageOf: root, label: 'StarCraft — MPQ' }),
      ])
      const layers = await sources.layers(STARCRAFT1_ROOT_ID)
      expect(layers.archives).toEqual(['patch_rt.mpq', 'BrooDat.mpq', 'StarDat.mpq'])
      expect(layers.owner('rez/stat_txt.tbl')?.archive).toBe('patch_rt.mpq')
      expect(new TextDecoder().decode(await sources.read(STARCRAFT1_ROOT_ID, 'rez/stat_txt.tbl', 64))).toBe('patch')
      // A map opens inside the chain: the installation's tileset is a file of its game layer.
      const folder = await mkdtemp(join(tmpdir(), 'modkit-sc1-classic-map-'))
      await writeFile(join(folder, 'Test.scm'), await authoredMap())
      const context = await sources.openModContext!({ target: join(folder, 'Test.scm') })
      try {
        expect(context.layers.map(layer => layer.id)).toEqual(['starcraft1-game', 'primary'])
        expect(await context.locate('TILESET\\Jungle.cv5')).toEqual({ layerId: 'starcraft1-game', path: 'TILESET/Jungle.cv5' })
        expect(new TextDecoder().decode(await context.read('starcraft1-game', 'tileset/jungle.cv5', 64))).toBe('cv5')
      } finally {
        await context.dispose()
      }
    } finally {
      await sources.dispose?.()
    }
  })

  it('names the files the game opens where the archive has no (listfile) to name them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-unnamed-'))
    const bytes = encodeFreshMpq([
      { path: 'tileset/jungle.cv5', bytes: ascii('cv5') },
      { path: 'unit/terran/marine.grp', bytes: ascii('grp') },
    ])
    // As a 1.x archive: the (listfile) block holds no names, the hash table still finds them.
    const listfile = ascii(['tileset', 'jungle.cv5\r\nunit', 'terran', 'marine.grp\r\n'].join(String.fromCharCode(0x5c)))
    const at = Buffer.from(bytes).indexOf(Buffer.from(listfile))
    expect(at).toBeGreaterThan(0)
    bytes.fill(0x0a, at, at + listfile.byteLength)
    await writeFile(join(root, 'StarDat.mpq'), bytes)
    const sources = await createContentSources({ installationDirectory: root })
    try {
      const files = (await sources.files(STARCRAFT1_ROOT_ID, '', { limit: 100 })).items.filter(item => item.hidden !== true).map(item => item.path)
      expect(files).toEqual(['tileset/jungle.cv5'])
      // A file the game does not open by name is not listed, but reads by its path.
      expect(new TextDecoder().decode(await sources.read(STARCRAFT1_ROOT_ID, 'unit/terran/marine.grp', 64))).toBe('grp')
    } finally {
      await sources.dispose?.()
    }
  })
})
