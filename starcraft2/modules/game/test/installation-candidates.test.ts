import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectStarcraft2InstallationCandidates,
  normalizeStarcraft2InstallationPath,
} from '../providers/installation/installation-candidates.js'

const fixtureRoot = join(process.cwd(), '.starcraft2-candidate-order-fixtures')

function normalized(name: string): string {
  return normalizeStarcraft2InstallationPath(join(fixtureRoot, name))
}

describe('StarCraft II installation candidate collection', () => {
  it('keeps manual, env, registry and default precedence while retaining duplicate origins', () => {
    const environment = join(fixtureRoot, 'z-environment')
    const manualFirst = join(fixtureRoot, 'z-manual-first')
    const manualSecond = join(fixtureRoot, 'a-manual-second')
    const registry = join(fixtureRoot, 'z-registry')
    const fallback = join(fixtureRoot, 'a-default')
    const configuredPaths = Object.freeze([manualFirst, manualSecond, environment])

    const result = collectStarcraft2InstallationCandidates(
      {
        environmentPath: environment,
        configuredPaths,
        registryPaths: [registry, manualSecond.toUpperCase()],
        defaultPaths: [fallback, registry.toUpperCase()],
        platform: 'win32',
      },
      16,
    )

    expect(result.candidates.map(({ origin, path }) => ({ origin, path }))).toEqual([
      { origin: 'configured-path', path: normalized('z-manual-first') },
      { origin: 'configured-path', path: normalized('a-manual-second') },
      { origin: 'configured-path', path: normalized('z-environment') },
      { origin: 'registry', path: normalized('z-registry') },
      { origin: 'default-directory', path: normalized('a-default') },
    ])
    expect(result.candidateOrigins).toEqual([
      ['configured-path'],
      ['configured-path', 'registry'],
      ['configured-path'],
      ['registry', 'default-directory'],
      ['default-directory'],
    ])
    expect(configuredPaths).toEqual([manualFirst, manualSecond, environment])
    expect(result.truncated).toBe(false)
  })

  it('ignores an empty environment value without dropping manual paths', () => {
    const manual = join(fixtureRoot, 'manual')
    const result = collectStarcraft2InstallationCandidates(
      {
        environmentPath: '   ',
        configuredPaths: [manual],
        registryPaths: [],
        defaultPaths: [],
        platform: process.platform,
      },
      16,
    )

    expect(result.candidates).toEqual([
      {
        origin: 'configured-path',
        displayName: 'StarCraft II',
        path: normalized('manual'),
      },
    ])
  })

  it('rejects an empty manual path instead of resolving it to the working directory', () => {
    expect(() =>
      collectStarcraft2InstallationCandidates(
        {
          environmentPath: undefined,
          configuredPaths: [''],
          registryPaths: [],
          defaultPaths: [],
          platform: process.platform,
        },
        16,
      ),
    ).toThrow('configuredPaths[0] must be a non-empty path')
  })
})
