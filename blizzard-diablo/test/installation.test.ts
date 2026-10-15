import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInventory, createHostContributionContractRegistry, gameInstallationSearchOf } from '@modkit/host'
import { loadExtensionDirectory, searchInstallationFolders } from '@modkit/host/node'

const module = (await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

/** One `.build.info` table with a single active record, as a CASC install writes it. */
async function installationRoot(fields: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modkit-d3-'))
  const names = ['Active', ...Object.keys(fields)]
  const values = ['1', ...Object.values(fields)]
  await writeFile(
    join(root, '.build.info'),
    `${names.map(name => `${name}!STRING:0`).join('|')}\n${values.join('|')}\n`,
    'utf8',
  )
  return root
}

describe('Diablo III installation discovery', () => {
  it('confirms a root whose active build record names the Diablo III product', async () => {
    const root = await installationRoot({
      Product: 'd3',
      'Build Product': 'Diablo3',
      Version: '2.7.7.90885',
      'Build Name': 'D3-90885patch2.7.7',
      'Build UID': 'd3',
      'CDN Path': 'tpr/d3',
    })
    await mkdir(join(root, 'Data'))
    const result = await module.discoverDiablo3Installations({
      gameId: 'blizzard/diablo-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations).toHaveLength(1)
    const installation = result.installations[0]!
    expect(installation.gameId).toBe('blizzard/diablo-3')
    expect(installation.version).toBe('2.7.7.90885')
    expect(installation.origins).toContain('configured-path')
    // The payload directory is evidence, not a requirement.
    expect(installation.evidence.map(entry => entry.kind)).toContain('casc-data-directory')
  })

  it('confirms a live install that names itself only by its CDN path', async () => {
    // Shape of a real 2.8.0 install: `Product` is empty, the CDN path is `tpr/diablo3`.
    const root = await installationRoot({ Product: '', Version: '2.8.0.99920', 'CDN Path': 'tpr/diablo3' })
    const result = await module.discoverDiablo3Installations({
      gameId: 'blizzard/diablo-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations.map(installation => installation.version)).toEqual(['2.8.0.99920'])
  })

  it('reads the uninstall registry through the host probes the provider context carries', async () => {
    const root = await installationRoot({ Product: 'd3', 'CDN Path': 'tpr/diablo3' })
    const asked: string[] = []
    const probes = {
      async registryValues(hive: string, key: string, names: readonly string[]) {
        asked.push(`${hive}\\${key}:${names.join(',')}`)
        return hive === 'HKLM' ? { InstallLocation: root } : {}
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
    const result = await provider.value.discover({ gameId: 'blizzard/diablo-3', maxCandidates: 8 })
    expect(asked).toEqual([
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Diablo III:InstallLocation',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Diablo III:InstallLocation',
    ])
    expect(result.installations.map(installation => installation.origins)).toEqual([['registry']])
  })

  it('refuses another Blizzard CASC product sharing the same marker file', async () => {
    // This is the case the MK2 detector explicitly could not tell apart: a `.build.info` alone
    // proves CASC, not Diablo III.
    const root = await installationRoot({ Product: 's2', 'Build Product': 'StarCraft2', 'CDN Path': 'tpr/sc2' })
    const result = await module.discoverDiablo3Installations({
      gameId: 'blizzard/diablo-3',
      configuredPaths: [root],
      maxCandidates: 8,
    })
    expect(result.installations).toHaveLength(0)
    expect(result.probes[0]?.confirmed).toBe(false)
    expect(result.diagnostics.map(entry => entry.code)).toContain(
      'blizzard.diablo3/installation-not-found',
    )
  })

  it('is found by the host folder search through the markers it declares, then confirmed', async () => {
    const drive = await mkdtemp(join(tmpdir(), 'modkit-d3-drive-'))
    const folder = join(drive, 'Games', 'Diablo III')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '.build.info'), ['Active!DEC:1|Version!STRING:0|CDN Path!STRING:0', '1|2.8.0.99920|tpr/diablo3', ''].join('\n'), 'utf8')
    await writeFile(join(folder, 'Diablo III.exe'), '')
    // another CASC game's folder carries .build.info too, but not the game's executable
    await mkdir(join(drive, 'Games', 'StarCraft II'))
    await writeFile(join(drive, 'Games', 'StarCraft II', '.build.info'), '')
    const inventory = await buildInventory(
      [{ ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))), execution: { origin: 'bundled' as const, allowTrustedInProcess: true } }],
      createHostContributionContractRegistry(),
    )
    const search = await searchInstallationFolders({ markers: gameInstallationSearchOf(inventory).markers, drives: [drive], commonFolders: ['Games'], environment: {} })
    expect(search.found['blizzard/diablo-3']).toEqual([folder])
    const result = await module.discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', searchPaths: search.found['blizzard/diablo-3']!, maxCandidates: 8 })
    expect(result.installations.map(installation => [installation.version, installation.origins])).toEqual([['2.8.0.99920', ['search-folder']]])
  })

  it('refuses a foreign game id and an out-of-range candidate ceiling', async () => {
    await expect(
      module.discoverDiablo3Installations({
        gameId: 'blizzard/starcraft-2',
        maxCandidates: 8,
      }),
    ).rejects.toThrow(/cannot inspect/u)
    await expect(
      module.discoverDiablo3Installations({
        gameId: 'blizzard/diablo-3',
        maxCandidates: 0,
      }),
    ).rejects.toThrow(/maxCandidates/u)
  })

  it('offers exactly the discovery contract it implements', () => {
    expect(module.provides).toEqual(['common.game/installation-discovery'])
    const provider = module.createProvider({
      contract: 'common.game/installation-discovery',
      major: 1,
    })
    expect(provider.value.gameIds).toEqual(['blizzard/diablo-3'])
    expect(() =>
      module.createProvider({ contract: 'common.game/launch-plan', major: 1 }),
    ).toThrow(/unsupported/u)
  })
})
