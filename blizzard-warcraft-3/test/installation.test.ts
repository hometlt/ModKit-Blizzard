import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const module = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

/** One `.build.info` table with a single active record, as a CASC install writes it. */
async function installationRoot(fields: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modkit-war3-'))
  const names = ['Active', ...Object.keys(fields)]
  const values = ['1', ...Object.values(fields)]
  await writeFile(
    join(root, '.build.info'),
    `${names.map(name => `${name}!STRING:0`).join('|')}\n${values.join('|')}\n`,
    'utf8',
  )
  return root
}

describe('Warcraft III installation discovery', () => {
  it('confirms a root whose active build record names the Warcraft III product', async () => {
    const root = await installationRoot({
      Product: 'w3',
      'Build Product': 'Warcraft3',
      Version: '1.36.1.20719',
      'Build Name': 'WOW-20719patch1.36.1',
      'Build UID': 'w3',
      'CDN Path': 'tpr/w3',
    })
    await mkdir(join(root, 'Data'))
    const result = await module.discoverWarcraft3Installations({
      gameId: 'blizzard/warcraft-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations).toHaveLength(1)
    const installation = result.installations[0]!
    expect(installation.gameId).toBe('blizzard/warcraft-3')
    expect(installation.version).toBe('1.36.1.20719')
    expect(installation.origins).toContain('configured-path')
    // The payload directory is evidence, not a requirement.
    expect(installation.evidence.map(entry => entry.kind)).toContain('casc-data-directory')
  })

  it("confirms a folder the host's folder search found, with its own checks and origin", async () => {
    const root = await installationRoot({ Product: 'w3', 'Build Product': 'Warcraft3', Version: '1.36.1.20719' })
    const result = await module.discoverWarcraft3Installations({
      gameId: 'blizzard/warcraft-3',
      searchPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations.map(installation => installation.origins)).toEqual([['search-folder']])
    await expect(
      module.discoverWarcraft3Installations({ gameId: 'blizzard/warcraft-3', searchPaths: [''], maxCandidates: 8 }),
    ).rejects.toThrow(/searchPaths/u)
  })

  it('refuses another Blizzard CASC product sharing the same marker file', async () => {
    // This is the case the MK2 detector explicitly could not tell apart: a `.build.info` alone
    // proves CASC, not Warcraft III.
    const root = await installationRoot({
      Product: 's2',
      'Build Product': 'StarCraft2',
      'CDN Path': 'tpr/sc2',
    })
    const result = await module.discoverWarcraft3Installations({
      gameId: 'blizzard/warcraft-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations).toHaveLength(0)
    expect(result.probes[0]?.confirmed).toBe(false)
    expect(result.diagnostics.map(entry => entry.code)).toContain(
      'blizzard.warcraft3/installation-not-found',
    )
  })

  it('refuses a foreign game id and an out-of-range candidate ceiling', async () => {
    await expect(
      module.discoverWarcraft3Installations({
        gameId: 'blizzard/starcraft-2',
        maxCandidates: 8,
      }),
    ).rejects.toThrow(/cannot inspect/u)
    await expect(
      module.discoverWarcraft3Installations({
        gameId: 'blizzard/warcraft-3',
        maxCandidates: 0,
      }),
    ).rejects.toThrow(/maxCandidates/u)
  })

  it('confirms Reforged by its CDN path alone, as a live build record may leave Product empty', async () => {
    const root = await installationRoot({ Product: '', 'CDN Path': 'tpr/war3' })
    const result = await module.discoverWarcraft3Installations({
      gameId: 'blizzard/warcraft-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations).toHaveLength(1)
  })

  it('confirms a classic installation by its own archive beside the files that run it', async () => {
    // A 1.x installation has no .build.info; the installers vary the case of these names.
    const root = await mkdtemp(join(tmpdir(), 'modkit-war3-classic-'))
    for (const name of ['War3.mpq', 'War3x.mpq', 'Game.dll']) await writeFile(join(root, name), '')
    const archiveOnly = await mkdtemp(join(tmpdir(), 'modkit-war3-archive-'))
    await writeFile(join(archiveOnly, 'war3.mpq'), '')
    const result = await module.discoverWarcraft3Installations({
      gameId: 'blizzard/warcraft-3',
      configuredPaths: [root, archiveOnly],
      maxCandidates: 8,
    })
    expect(result.installations.map(installation => installation.installPath)).toEqual([
      result.probes[0]!.normalizedPath,
    ])
    const evidence = Object.fromEntries(
      result.installations[0]!.evidence.map(entry => [entry.kind, entry.found]),
    )
    expect(evidence['warcraft3-classic-archive']).toBe(true)
    expect(evidence['warcraft3-expansion-archive']).toBe(true)
    expect(result.installations[0]!.displayName).toBe('Warcraft III: The Frozen Throne')
    // An archive alone is a copied file, not an installation.
    expect(result.probes[1]?.confirmed).toBe(false)
  })

  it('reads the registry through the host probes the provider context carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-war3-registry-'))
    for (const name of ['war3.mpq', 'war3.exe']) await writeFile(join(root, name), '')
    const asked: string[] = []
    const probes = {
      async registryValues(hive: string, key: string, names: readonly string[]) {
        asked.push(`${hive}\\${key}:${names.join(',')}`)
        return hive === 'HKCU' && key.endsWith('Blizzard Entertainment\\Warcraft III')
          ? { InstallPath: root }
          : {}
      },
      steamAppDir: async () => undefined,
      epicInstallLocation: async () => undefined,
      gogInstallPath: async () => undefined,
      storePackageLocation: async () => undefined,
    }
    const provider = module.createProvider(
      { contract: 'common.game/installation-discovery', major: 1 },
      { installationProbes: probes },
    )
    const result = await provider.value.discover({
      gameId: 'blizzard/warcraft-3',
      maxCandidates: 8,
    })
    expect(asked).toEqual([
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft III:InstallLocation',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft III:InstallLocation',
      'HKLM\\SOFTWARE\\Blizzard Entertainment\\Warcraft III:InstallPath,InstallPathX',
      'HKCU\\SOFTWARE\\Blizzard Entertainment\\Warcraft III:InstallPath,InstallPathX',
    ])
    expect(result.installations.map(installation => installation.origins)).toEqual([['registry']])
  })

  it('offers exactly the discovery contract it implements', () => {
    expect(module.provides).toEqual(['common.game/installation-discovery'])
    const provider = module.createProvider({
      contract: 'common.game/installation-discovery',
      major: 1,
    })
    expect(provider.value.gameIds).toEqual(['blizzard/warcraft-3'])
    expect(() => module.createProvider({ contract: 'common.game/launch-plan', major: 1 })).toThrow(
      /unsupported/u,
    )
  })
})
