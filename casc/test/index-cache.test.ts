import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { openIndexCache } from '../src/casc/codec.js'
import { canonicalInstallation, installationCacheFolder } from '../src/casc/root-cache-node.js'

const installation = 'file:///c%3A/Games/StarCraft II'
const other = 'file:///d%3A/Games/StarCraft II'

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'casc-index-cache-'))
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
})

describe('CASC index cache settings', () => {
  it('caches by default once the host names a directory', async () => {
    const notes: string[] = []
    const cache = (await openIndexCache({ cacheDirectory: directory }, installation, notes))?.('s2')
    expect(cache).toBeDefined()

    const bytes = new Uint8Array([1, 2, 3, 4])
    await cache!.store('abcdef01', bytes)
    expect(await cache!.load('abcdef01')).toEqual(bytes)
    expect(notes.join(' ')).toContain('cache')
  })

  it('is off when the user turns it off for this installation or this game', async () => {
    const off = await openIndexCache({ cacheDirectory: directory, cacheIndex: false }, installation, [])
    expect(off?.('s2')).toBeUndefined()
    const perGame = await openIndexCache(
      { cacheDirectory: directory, games: { d3: { cacheIndex: false } } },
      installation,
      [],
    )
    expect(perGame?.('d3')).toBeUndefined()
    expect(perGame?.('s2')).toBeDefined()
  })

  it('does nothing when the host named no directory', async () => {
    expect(await openIndexCache({}, installation, [])).toBeUndefined()
    expect(await openIndexCache({ cacheDirectory: '  ' }, installation, [])).toBeUndefined()
  })

  it('keeps one installation from evicting another', async () => {
    // A cache prunes the older builds under its own directory; two installations must not share
    // one, or opening either would throw the other's index away.
    const first = (await openIndexCache({ cacheDirectory: directory }, installation, []))?.('s2')
    const second = (await openIndexCache({ cacheDirectory: directory }, other, []))?.('s2')
    await first!.store('aaaaaaaa', new Uint8Array([1]))
    await second!.store('bbbbbbbb', new Uint8Array([2]))

    expect(await first!.load('aaaaaaaa')).toEqual(new Uint8Array([1]))
    expect(await second!.load('bbbbbbbb')).toEqual(new Uint8Array([2]))
    const folders = await fs.readdir(directory)
    expect(folders).toHaveLength(2)
    expect(folders.every(name => name.startsWith('source-'))).toBe(true)
  })

  it('keeps the index in the shared directory, one folder per installation, with its cache.json', async () => {
    const shared = path.join(directory, 'index-cache')
    const own = path.join(directory, 'contribution-cache')
    // The copy a host without the shared directory made, under the raw uri.
    const legacy = path.join(own, installationCacheFolder(installation))
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, 'old.bin'), 'x')

    const cache = (await openIndexCache({ indexCacheDirectory: shared, cacheDirectory: own }, installation, []))?.('s2')
    await cache!.store('abcdef01', new Uint8Array([1, 2]))

    await expect(fs.stat(legacy)).rejects.toThrow()
    const folders = await fs.readdir(shared)
    expect(folders).toEqual([installationCacheFolder(canonicalInstallation(installation))])
    const manifest = JSON.parse(await fs.readFile(path.join(shared, folders[0]!, 'cache.json'), 'utf8'))
    expect(manifest).toEqual({
      game: 'starcraft2',
      product: 's2',
      kind: 'names',
      installation: canonicalInstallation(installation),
    })
  })

  it.runIf(process.platform === 'win32')('names one folder for the uri and the path of an installation', () => {
    expect(canonicalInstallation(installation)).toBe(canonicalInstallation(String.raw`C:\Games\StarCraft II`))
    expect(canonicalInstallation(installation)).not.toBe(canonicalInstallation(other))
  })
})
