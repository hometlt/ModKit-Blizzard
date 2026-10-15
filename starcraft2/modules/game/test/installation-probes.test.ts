/**
 * StarCraft II discovery reads the Windows uninstall registry through the host's installation
 * probes (core c53f0fbc) rather than launching reg.exe; a host without probes adds no registry
 * candidate.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { discoverStarcraft2Installations } from '../providers/installation/provider.js'

const root = mkdtempSync(join(tmpdir(), 'sc2-registry-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('StarCraft II installation discovery', () => {
  it('takes the uninstall registry from the host probes', async () => {
    const asked: string[] = []
    const probes = {
      async registryValues(hive: string, key: string, names: readonly string[]) {
        asked.push(`${hive}\\${key}`)
        return hive === 'HKLM' && names.includes('InstallLocation') ? { InstallLocation: `  ${root}  ` } : {}
      },
    }
    const request = { gameId: 'blizzard/starcraft-2', configuredPaths: [], maxCandidates: 16 }
    const withProbes = await discoverStarcraft2Installations(request, probes)
    expect(asked).toEqual([
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II',
    ])
    const fromRegistry = (result: typeof withProbes) =>
      result.probes.filter((probe: { candidate: { origin: string } }) => probe.candidate.origin === 'registry')
    expect(fromRegistry(withProbes).map((probe: { candidate: { path: string } }) => probe.candidate.path))
      .toEqual([root.replaceAll('\\', '/')])

    expect(fromRegistry(await discoverStarcraft2Installations(request))).toEqual([])
  })
})
