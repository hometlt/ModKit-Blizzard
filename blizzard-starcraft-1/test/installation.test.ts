import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const module = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

/** A `.build.info` table with one active record, as the Battle.net agent writes it. */
async function cascRoot(fields: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-'))
  const names = ['Branch', 'Active', 'Build Key', ...Object.keys(fields)]
  const values = ['eu', '1', '864772b9ff94f6d372aa4ee90ee2f8ab', ...Object.values(fields)]
  await writeFile(join(root, '.build.info'), `${names.map(name => `${name}!STRING:0`).join('|')}\n${values.join('|')}\n`, 'utf8')
  await mkdir(join(root, 'Data'))
  return root
}

const discover = (root: string) =>
  module.discoverStarcraft1Installations({ gameId: 'blizzard/starcraft-1', configuredPaths: [root], maxCandidates: 8 })

describe('StarCraft installation discovery', () => {
  it('confirms Remastered by its CDN path when the product column is empty, as installed copies leave it', async () => {
    const root = await cascRoot({ 'CDN Path': 'tpr/sc1live', Version: '1.23.10.13515', Product: '' })
    const result = await discover(root)
    expect(result.installations).toHaveLength(1)
    const installation = result.installations[0]!
    expect(installation.displayName).toBe('StarCraft: Remastered')
    expect(installation.version).toBe('1.23.10.13515')
    expect(installation.origins).toEqual(['configured-path'])
    expect(installation.evidence.find(item => item.kind === 'casc-data-directory')?.found).toBe(true)
  })

  it('refuses another CASC product: a .build.info proves CASC, not StarCraft', async () => {
    const result = await discover(await cascRoot({ 'CDN Path': 'tpr/sc2', Product: 's2' }))
    expect(result.installations).toHaveLength(0)
    expect(result.probes[0]?.confirmed).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toContain('blizzard.starcraft1/installation-not-found')
  })

  it('confirms a classic installation by StarDat.mpq beside the game, and names Brood War by BrooDat.mpq', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-classic-'))
    await writeFile(join(root, 'StarDat.mpq'), '')
    await writeFile(join(root, 'StarCraft.exe'), '')
    expect((await discover(root)).installations[0]?.displayName).toBe('StarCraft')
    await writeFile(join(root, 'BROODAT.MPQ'), '')
    const installation = (await discover(root)).installations[0]!
    expect(installation.displayName).toBe('StarCraft: Brood War')
    expect(installation.version).toBeUndefined()
  })

  it('does not confirm an archive without the game beside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-sc1-archive-'))
    await writeFile(join(root, 'StarDat.mpq'), '')
    expect((await discover(root)).installations).toHaveLength(0)
  })

  it('reads the installers’ registry values through the host probes and keeps every origin', async () => {
    const root = await cascRoot({ 'CDN Path': 'tpr/sc1live' })
    const asked: string[] = []
    const result = await module.discoverStarcraft1Installations(
      { gameId: 'blizzard/starcraft-1', configuredPaths: [root], maxCandidates: 8 },
      {
        registryValues: async (hive, key, names) => {
          asked.push(`${hive}\\${key}`)
          return hive === 'HKLM' && key.endsWith('Uninstall\\StarCraft') ? { [names[0]!]: `${root}\\` } : {}
        },
      } as Parameters<typeof module.discoverStarcraft1Installations>[1],
    )
    expect(asked).toContain('HKLM\\SOFTWARE\\Blizzard Entertainment\\Starcraft')
    expect(result.installations).toHaveLength(1)
    expect(result.installations[0]!.origins).toEqual(['configured-path', 'registry'])
  })

  it('refuses a foreign game id and an out-of-range candidate ceiling', async () => {
    await expect(module.discoverStarcraft1Installations({ gameId: 'blizzard/starcraft-2', maxCandidates: 1 })).rejects.toThrow(TypeError)
    await expect(module.discoverStarcraft1Installations({ gameId: 'blizzard/starcraft-1', maxCandidates: 0 })).rejects.toThrow(TypeError)
  })
})
