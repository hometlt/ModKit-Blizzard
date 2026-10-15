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
  const root = await mkdtemp(join(tmpdir(), 'modkit-hots-'))
  const names = ['Branch', 'Active', 'Build Key', ...Object.keys(fields)]
  const values = ['eu', '1', 'f1b2d344c9b966d07d525626ee9c1801', ...Object.values(fields)]
  await writeFile(
    join(root, '.build.info'),
    `${names.map(name => `${name}!STRING:0`).join('|')}\n${values.join('|')}\n`,
    'utf8',
  )
  await mkdir(join(root, 'HeroesData'))
  return root
}

const discover = (root: string) =>
  module.discoverHeroesInstallations({
    gameId: 'blizzard/heroes-of-the-storm',
    configuredPaths: [root],
    maxCandidates: 8,
  })

describe('Heroes of the Storm installation discovery', () => {
  it('confirms the live channel by its CDN path when the product column is empty, as installed copies leave it', async () => {
    const root = await cascRoot({ 'CDN Path': 'tpr/Hero-Live-a', Version: '2.55.13.95170', Product: '' })
    const result = await discover(root)
    expect(result.installations).toHaveLength(1)
    const installation = result.installations[0]!
    expect(installation.displayName).toBe('Heroes of the Storm')
    expect(installation.version).toBe('2.55.13.95170')
    expect(installation.evidence.find(item => item.kind === 'casc-data-directory')?.found).toBe(true)
  })

  it('confirms the product column `hero`', async () => {
    expect((await discover(await cascRoot({ Product: 'hero' }))).installations).toHaveLength(1)
  })

  it('refuses another CASC product: a .build.info proves CASC, not Heroes', async () => {
    const result = await discover(await cascRoot({ 'CDN Path': 'tpr/sc2', Product: 's2' }))
    expect(result.installations).toHaveLength(0)
    expect(result.diagnostics.map(item => item.code)).toContain('blizzard.heroes/installation-not-found')
  })

  it('takes the uninstall entry and the host folder search as candidates, keeping every origin', async () => {
    const root = await cascRoot({ 'CDN Path': 'tpr/Hero-Live-a' })
    const moved = join(root, 'moved-away')
    const result = await module.discoverHeroesInstallations(
      { gameId: 'blizzard/heroes-of-the-storm', searchPaths: [root], maxCandidates: 8 },
      {
        registryValues: async (hive, key, names) =>
          hive === 'HKLM' && key.endsWith('Uninstall\\Heroes of the Storm') ? { [names[0]!]: moved } : {},
      } as Parameters<typeof module.discoverHeroesInstallations>[1],
    )
    // The uninstall entry names a folder that is gone: a candidate, never an installation.
    expect(result.installations.map(item => item.installPath)).not.toContain(moved)
    expect(result.installations).toHaveLength(1)
    expect(result.installations[0]!.origins).toEqual(['search-folder'])
  })

  it('refuses a foreign game id and an out-of-range candidate ceiling', async () => {
    await expect(
      module.discoverHeroesInstallations({ gameId: 'blizzard/starcraft-2', maxCandidates: 1 }),
    ).rejects.toThrow(TypeError)
    await expect(
      module.discoverHeroesInstallations({ gameId: 'blizzard/heroes-of-the-storm', maxCandidates: 0 }),
    ).rejects.toThrow(TypeError)
  })
})
