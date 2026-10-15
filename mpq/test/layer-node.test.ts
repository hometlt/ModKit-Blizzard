/**
 * An MPQ archive on disk as a layer of the layered-archive helper — the owner `local:warcraft3` and
 * the StarCraft content source share instead of each keeping a copy.
 */
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'
import { openMpqArchiveLayer, openMpqFile } from '../src/mpq/layer-node.js'

const encoder = new TextEncoder()
const limits = { maxArchiveBytes: 1_048_576, maxEntries: 64, maxEntryBytes: 1_048_576 }
let directory = ''
let archive = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mpq-layer-'))
  archive = join(directory, 'War3Patch.mpq')
  await writeFile(archive, encodeFreshMpq([
    { path: 'Units/UnitData.slk', bytes: encoder.encode('ID;PWXL') },
    { path: 'Scripts/Blizzard.j', bytes: encoder.encode('function Init takes nothing returns nothing\nendfunction') },
  ]))
})
afterAll(() => rm(directory, { recursive: true, force: true }))

describe('an MPQ file as a layer', () => {
  it('lists its named entries, finds a path by hash and reads within the bound', async () => {
    const layer = await openMpqArchiveLayer(archive, limits)
    try {
      expect(layer.id).toBe('War3Patch.mpq')
      const named = layer.entries.filter(entry => entry.hidden !== true)
      expect(named.map(entry => [entry.path, entry.size])).toEqual(
        expect.arrayContaining([['Units/UnitData.slk', 7], ['Scripts/Blizzard.j', 55]]),
      )
      expect(layer.entries.some(entry => /^block\/\d+$/u.test(entry.path))).toBe(false)
      expect(await layer.lookup('\\scripts\\BLIZZARD.J/')).toEqual({ path: 'scripts/BLIZZARD.J', size: 55 })
      expect(await layer.lookup('Scripts/Common.j')).toBeUndefined()
      expect(new TextDecoder().decode(await layer.read('Units/UnitData.slk', 7))).toBe('ID;PWXL')
      await expect(layer.read('Scripts/Blizzard.j', 54)).rejects.toThrow(/more than 54/u)
      await expect(layer.read('Scripts/Common.j', 64)).rejects.toThrow(/has no/u)
    } finally {
      await layer.close()
    }
  })

  it('closes the file again when the archive does not open', async () => {
    const broken = join(directory, 'broken.mpq')
    await writeFile(broken, encoder.encode('not an archive'))
    await expect(openMpqFile(broken, limits)).rejects.toThrow()
    // A handle left open would keep the file locked on Windows.
    await unlink(broken)
  })
})
