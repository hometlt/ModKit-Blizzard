/**
 * StarCraft installation discovery — `common.game/installation-discovery`.
 *
 * Two kinds of installation are StarCraft. Remastered is a Blizzard CASC product: its active
 * `.build.info` record names the game (product `s1`, or the `sc1` CDN path when the product column
 * is empty, as on installed copies). A classic 1.x installation has no build record: its own MPQ
 * archive `StarDat.mpq` beside a file that runs it is the identity, and `BrooDat.mpq` makes it
 * Brood War. The MK2 detector only sniffed a `.build.info` file, which every CASC product has.
 *
 * Bounded by construction: paths the user configured, `MODKIT_STARCRAFT1_ROOT`, the registry values
 * the installers write (read through the host's installation probes) and platform defaults. It
 * never walks a drive.
 */
import {
  collectInstallationCandidates,
  normalizeInstallationPath as normalizePath,
} from '@modkit/host/node'
import { readdir, readFile, stat } from 'node:fs/promises'
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

export const STARCRAFT1_GAME_ID = 'blizzard/starcraft-1'
const DISCOVERY_ID = 'blizzard.starcraft1'
const REMASTERED = 'StarCraft: Remastered'
const CLASSIC = 'StarCraft'
const BROOD_WAR = 'StarCraft: Brood War'
const MAXIMUM_CANDIDATES = 128
const MAXIMUM_BUILD_INFO_BYTES = 256 * 1024
const ENVIRONMENT_ROOT = 'MODKIT_STARCRAFT1_ROOT'
// The probe reads both registry views of a hive itself.
const REGISTRY_HIVES: readonly RegistryHive[] = Object.freeze(['HKLM', 'HKCU'])
/** Remastered's uninstall entry, and the key both the classic and Remastered installers keep. */
const REGISTRY_ROOTS = Object.freeze([
  {
    key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft',
    names: ['InstallLocation'],
  },
  { key: 'SOFTWARE\\Blizzard Entertainment\\Starcraft', names: ['InstallPath'] },
])
/** Names are compared without case: the installers vary them. */
export const CLASSIC_ARCHIVE = 'stardat.mpq'
export const BROOD_WAR_ARCHIVE = 'broodat.mpq'
const CLASSIC_RUNTIME = Object.freeze(['starcraft.exe', 'storm.dll'])

interface BuildRecord {
  readonly version: string
  readonly product: string
  readonly cdnPath: string
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
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

async function registryCandidates(
  probes: InstallationProbes | undefined,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (probes === undefined) return []
  const candidates: string[] = []
  for (const { key, names } of REGISTRY_ROOTS)
    for (const hive of REGISTRY_HIVES) {
      signal?.throwIfAborted()
      const values = await probes.registryValues(hive, key, names, signal)
      for (const name of names) {
        const path = values[name]?.trim()
        if (path !== undefined && path !== '') candidates.push(normalizeRegistryPath(path))
      }
    }
  return candidates
}

function defaultCandidates(): readonly string[] {
  if (process.platform === 'darwin')
    return ['/Applications/StarCraft', join(homedir(), 'Applications', 'StarCraft')]
  if (process.platform !== 'win32') return []
  return [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].flatMap(base =>
    base === undefined || base.trim() === '' ? [] : [join(base.trim(), 'StarCraft')],
  )
}

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

/** StarCraft ships as the `s1` CASC product (`cascProductOf` also names `tpr/sc1live` so). */
function matchesStarcraft1(build: BuildRecord | undefined): boolean {
  return build?.product.toLowerCase() === 's1'
}

async function probeCandidate(
  candidate: GameInstallationCandidate,
  signal?: AbortSignal,
): Promise<GameInstallationProbe> {
  signal?.throwIfAborted()
  const root = candidate.path
  const buildInfoPath = join(root, '.build.info')
  const hasBuildInfo = await isFile(buildInfoPath)
  const build = hasBuildInfo ? await readBuildRecord(buildInfoPath) : undefined
  const remastered = matchesStarcraft1(build)
  const evidence: GameInstallationEvidence[] = [
    Object.freeze({ kind: 'casc-build-info-file', path: buildInfoPath, found: hasBuildInfo }),
    Object.freeze({
      kind: 'starcraft1-build-identity',
      path: buildInfoPath,
      found: remastered,
      detail:
        build === undefined
          ? 'no active build record'
          : `product=${build.product || 'unknown'};cdn=${build.cdnPath || 'unknown'}`,
    }),
  ]
  let names = new Set<string>()
  try {
    names = new Set((await readdir(root)).map(name => name.toLowerCase()))
  } catch {
    // An unreadable candidate is simply not confirmed.
  }
  if (remastered)
    evidence.push(
      Object.freeze({
        kind: 'casc-data-directory',
        path: join(root, 'Data'),
        found: names.has('data'),
      }),
    )
  const classic =
    !remastered && names.has(CLASSIC_ARCHIVE) && CLASSIC_RUNTIME.some(name => names.has(name))
  if (!remastered)
    evidence.push(
      Object.freeze({
        kind: 'starcraft1-classic-archive',
        path: join(root, 'StarDat.mpq'),
        found: classic,
      }),
      Object.freeze({
        kind: 'starcraft1-brood-war-archive',
        path: join(root, 'BrooDat.mpq'),
        found: names.has(BROOD_WAR_ARCHIVE),
      }),
    )
  const displayName = remastered
    ? REMASTERED
    : classic && names.has(BROOD_WAR_ARCHIVE)
      ? BROOD_WAR
      : CLASSIC
  return Object.freeze({
    candidate: Object.freeze({ ...candidate, displayName }),
    normalizedPath: normalizePath(root),
    confirmed: remastered || classic,
    ...(remastered && build !== undefined && build.version !== ''
      ? { version: build.version }
      : {}),
    evidence: Object.freeze(evidence),
  })
}

// ponytail: the same candidate bookkeeping as the other game providers; moves to the host's
// discovery helper beside `installationProbes` when [MK] Core ships it (AGENTS.md §4.4).

export async function discoverStarcraft1Installations(
  request: GameInstallationDiscoveryRequest,
  installationProbes?: InstallationProbes,
): Promise<GameInstallationDiscoveryResult> {
  request.signal?.throwIfAborted()
  if (request.gameId !== STARCRAFT1_GAME_ID)
    throw new TypeError(`StarCraft discovery cannot inspect ${request.gameId}`)
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

  const collected = collectInstallationCandidates(
    entries.map(entry => ({ ...entry, displayName: CLASSIC })),
    { maxCandidates: limit, ...(request.signal === undefined ? {} : { signal: request.signal }) },
  )
  const probes: GameInstallationProbe[] = []
  for (const candidate of collected.candidates)
    probes.push(await probeCandidate(candidate, request.signal))
  const installations: GameInstallation[] = probes.flatMap((probe, index) =>
    probe.confirmed
      ? [
          Object.freeze({
            gameId: STARCRAFT1_GAME_ID,
            displayName: probe.candidate.displayName,
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
        code: 'blizzard.starcraft1/candidates-truncated',
        message: `candidate discovery was truncated at ${String(limit)}`,
      }),
    )
  if (installations.length === 0)
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft1/installation-not-found',
        message: 'no candidate contained a confirmed StarCraft installation',
      }),
    )
  return Object.freeze({
    gameId: STARCRAFT1_GAME_ID,
    complete: !collected.truncated,
    probes: Object.freeze(probes),
    installations: Object.freeze(installations),
    diagnostics: Object.freeze(diagnostics),
  })
}

export const abiVersion = 1
export const provides = Object.freeze([GAME_INSTALLATION_DISCOVERY_CONTRACT])

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
      gameIds: Object.freeze([STARCRAFT1_GAME_ID]),
      origins: Object.freeze(['configured-path', 'default-directory', 'registry'] as const),
      discover: (request: GameInstallationDiscoveryRequest) =>
        discoverStarcraft1Installations(request, context?.installationProbes),
    }),
    release: async (): Promise<void> => undefined,
  })
}
