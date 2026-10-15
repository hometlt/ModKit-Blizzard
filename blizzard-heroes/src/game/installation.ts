/**
 * Heroes of the Storm installation discovery — `common.game/installation-discovery`.
 *
 * Owner: the `blizzard-heroes` root. Heroes of the Storm is a Blizzard CASC product: its active
 * `.build.info` record names the game — product `hero`, or, as installed copies leave the product
 * column empty, the CDN path `tpr/Hero-Live-a` (any `hero-*` channel). Every CASC product has a
 * `.build.info`, so the file alone proves nothing; the record does. The payload folder `HeroesData`
 * is reported as evidence, not required.
 *
 * Candidates, bounded by construction: paths the user configured, `MODKIT_HOTS_ROOT`, the uninstall
 * entry the Battle.net installer writes (read through the host's installation probes; it can name a
 * folder the user has since moved, so it is only a candidate), platform defaults, and the folders the
 * host's folder search found by this offer's markers (`.build.info` beside `Heroes of the Storm.exe`).
 * A host without probes or folder search (a browser) uses configured paths and the environment root.
 *
 * Launching, provisioning and content mounting are outside this provider; the installation's files
 * are served by `./content-sources.ts`.
 */
import {
  collectInstallationCandidates,
  normalizeInstallationPath as normalizePath,
} from '@modkit/host/node'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { cascProductOf, getActiveBuild, parseBuildInfo } from '@modkit/blizzard-casc'
import type { InstallationProbes, RegistryHive } from '@modkit/sdk'
import { GAME_INSTALLATION_DISCOVERY_CONTRACT } from '@modkit/sdk/games'
import type {
  GameInstallation,
  GameInstallationCandidate,
  GameInstallationDiagnostic,
  GameInstallationDiscoveryRequest,
  GameInstallationDiscoveryResult,
  GameInstallationEvidence,
  GameInstallationOrigin,
  GameInstallationProbe,
} from '@modkit/sdk/games'

export const HEROES_GAME_ID = 'blizzard/heroes-of-the-storm'
const DISCOVERY_ID = 'blizzard.heroes'
const DISPLAY_NAME = 'Heroes of the Storm'
const MAXIMUM_CANDIDATES = 128
const MAXIMUM_BUILD_INFO_BYTES = 256 * 1024
const ENVIRONMENT_ROOT = 'MODKIT_HOTS_ROOT'
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Heroes of the Storm'
// The probe reads both registry views of a hive itself.
const REGISTRY_HIVES: readonly RegistryHive[] = Object.freeze(['HKLM', 'HKCU'])
/** The CASC payload folder of the game: SC2 keeps `SC2Data`, Heroes `HeroesData`. */
export const HEROES_DATA_DIRECTORY = 'HeroesData'

interface BuildRecord {
  readonly version: string
  readonly product: string
  readonly cdnPath: string
}

/** Whether `path` is a file; missing or unreadable is simply no. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Whether `path` is a folder; missing or unreadable is simply no. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** An uninstall entry may point at a support folder rather than the installation root. */
function normalizeRegistryPath(value: string): string {
  const path = resolve(value.trim())
  const leaf = basename(path).toLowerCase()
  return leaf === 'support' || leaf === 'support64' ? dirname(path) : path
}

/** The uninstall entry's `InstallLocation`, from both hives, through the host's probes. */
async function registryCandidates(
  probes: InstallationProbes | undefined,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (probes === undefined) return []
  const candidates: string[] = []
  for (const hive of REGISTRY_HIVES) {
    signal?.throwIfAborted()
    const values = await probes.registryValues(hive, UNINSTALL_KEY, ['InstallLocation'], signal)
    const path = values['InstallLocation']?.trim()
    if (path !== undefined && path !== '') candidates.push(normalizeRegistryPath(path))
  }
  return candidates
}

/** Where the Battle.net installer puts the game unless asked otherwise. */
function defaultCandidates(): readonly string[] {
  if (process.platform === 'darwin')
    return ['/Applications/Heroes of the Storm', join(homedir(), 'Applications', 'Heroes of the Storm')]
  if (process.platform !== 'win32') return []
  return [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].flatMap(base =>
    base === undefined || base.trim() === '' ? [] : [join(base.trim(), 'Heroes of the Storm')],
  )
}

/** The active build of a bounded `.build.info`, or nothing when it is missing or malformed. */
async function readBuildRecord(path: string): Promise<BuildRecord | undefined> {
  try {
    if ((await stat(path)).size > MAXIMUM_BUILD_INFO_BYTES) return undefined
    const build = getActiveBuild(parseBuildInfo(await readFile(path, 'utf8')))
    return {
      version: build.version,
      product: cascProductOf(build),
      cdnPath: (build.fields.get('CDN Path') ?? '').trim(),
    }
  } catch {
    return undefined
  }
}

/**
 * Heroes ships as the `hero` CASC product. `cascProductOf` names a build by its CDN path when the
 * product column is empty, which for the live channel is `hero-live-a`; any `hero-*` channel counts.
 */
export function matchesHeroes(product: string | undefined): boolean {
  return product !== undefined && /^hero(?:$|-)/u.test(product.toLowerCase())
}

/** Confirm one candidate by its build record; report what was found either way. */
async function probeCandidate(
  candidate: GameInstallationCandidate,
  signal?: AbortSignal,
): Promise<GameInstallationProbe> {
  signal?.throwIfAborted()
  const root = candidate.path
  const buildInfoPath = join(root, '.build.info')
  const hasBuildInfo = await isFile(buildInfoPath)
  const build = hasBuildInfo ? await readBuildRecord(buildInfoPath) : undefined
  const identity = matchesHeroes(build?.product)
  const dataPath = join(root, HEROES_DATA_DIRECTORY)
  const evidence: GameInstallationEvidence[] = [
    Object.freeze({ kind: 'casc-build-info-file', path: buildInfoPath, found: hasBuildInfo }),
    Object.freeze({
      kind: 'heroes-build-identity',
      path: buildInfoPath,
      found: identity,
      detail:
        build === undefined
          ? 'no active build record'
          : `product=${build.product || 'unknown'};cdn=${build.cdnPath || 'unknown'}`,
    }),
    Object.freeze({ kind: 'casc-data-directory', path: dataPath, found: await isDirectory(dataPath) }),
  ]
  return Object.freeze({
    candidate,
    normalizedPath: normalizePath(root),
    confirmed: identity,
    ...(identity && build !== undefined && build.version !== '' ? { version: build.version } : {}),
    evidence: Object.freeze(evidence),
  })
}

/** Every candidate the request and the host name, deduplicated, each confirmed or not. */
export async function discoverHeroesInstallations(
  request: GameInstallationDiscoveryRequest,
  installationProbes?: InstallationProbes,
): Promise<GameInstallationDiscoveryResult> {
  request.signal?.throwIfAborted()
  if (request.gameId !== HEROES_GAME_ID)
    throw new TypeError(`Heroes of the Storm discovery cannot inspect ${request.gameId}`)
  const limit = request.maxCandidates
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAXIMUM_CANDIDATES)
    throw new TypeError(
      `maxCandidates must be a positive safe integer no greater than ${String(MAXIMUM_CANDIDATES)}`,
    )
  const entries: { origin: GameInstallationOrigin; path: string }[] = []
  for (const path of request.configuredPaths ?? []) {
    if (typeof path !== 'string' || path.trim() === '')
      throw new TypeError('configuredPaths entries must be non-empty paths')
    entries.push({ origin: 'configured-path', path })
  }
  const environmentRoot = process.env[ENVIRONMENT_ROOT]?.trim()
  if (environmentRoot !== undefined && environmentRoot !== '')
    entries.push({ origin: 'configured-path', path: environmentRoot })
  for (const path of await registryCandidates(installationProbes, request.signal))
    entries.push({ origin: 'registry', path })
  for (const path of defaultCandidates()) entries.push({ origin: 'default-directory', path })
  // Folders the host's search found shaped like the game (its markers), confirmed after the rest.
  for (const path of request.searchPaths ?? []) {
    if (typeof path !== 'string' || path.trim() === '')
      throw new TypeError('searchPaths entries must be non-empty paths')
    entries.push({ origin: 'search-folder', path })
  }

  const collected = collectInstallationCandidates(
    entries.map(entry => ({ ...entry, displayName: DISPLAY_NAME })),
    { maxCandidates: limit, ...(request.signal === undefined ? {} : { signal: request.signal }) },
  )
  const probes: GameInstallationProbe[] = []
  for (const candidate of collected.candidates)
    probes.push(await probeCandidate(candidate, request.signal))
  const installations: GameInstallation[] = probes.flatMap((probe, index) =>
    probe.confirmed
      ? [
          Object.freeze({
            gameId: HEROES_GAME_ID,
            displayName: DISPLAY_NAME,
            installPath: probe.candidate.path,
            normalizedPath: probe.normalizedPath,
            origins: collected.origins[index] ?? Object.freeze([probe.candidate.origin]),
            ...(probe.version === undefined ? {} : { version: probe.version }),
            evidence: probe.evidence,
          }),
        ]
      : [],
  )
  const diagnostics: GameInstallationDiagnostic[] = []
  if (collected.truncated)
    diagnostics.push(
      Object.freeze({
        severity: 'warning',
        code: 'blizzard.heroes/candidates-truncated',
        message: `candidate discovery was truncated at ${String(limit)}`,
      }),
    )
  if (installations.length === 0)
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.heroes/installation-not-found',
        message: 'no candidate contained a confirmed Heroes of the Storm installation',
      }),
    )
  return Object.freeze({
    gameId: HEROES_GAME_ID,
    complete: !collected.truncated,
    probes: Object.freeze(probes),
    installations: Object.freeze(installations),
    diagnostics: Object.freeze(diagnostics),
  })
}

export const abiVersion = 1
export const provides = Object.freeze([GAME_INSTALLATION_DISCOVERY_CONTRACT])

/** The provider entry the host activates for the discovery contract. */
export function createProvider(
  selection: { readonly contract: string; readonly major: number },
  context?: { readonly installationProbes?: InstallationProbes },
) {
  if (selection.contract !== GAME_INSTALLATION_DISCOVERY_CONTRACT || selection.major !== 1)
    throw new TypeError(
      `unsupported game-installation selection ${selection.contract}@${String(selection.major)}`,
    )
  return Object.freeze({
    value: Object.freeze({
      contract: GAME_INSTALLATION_DISCOVERY_CONTRACT,
      discoveryId: DISCOVERY_ID,
      gameIds: Object.freeze([HEROES_GAME_ID]),
      origins: Object.freeze(['configured-path', 'default-directory', 'registry', 'search-folder'] as const),
      discover: (request: GameInstallationDiscoveryRequest) =>
        discoverHeroesInstallations(request, context?.installationProbes),
    }),
    release: async (): Promise<void> => undefined,
  })
}
