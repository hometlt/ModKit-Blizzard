/**
 * World of Warcraft installation discovery — `common.game/installation-discovery`.
 *
 * Owner: the `blizzard-world-of-warcraft` root. One installation folder holds one CASC storage
 * (`Data`) and every product the Battle.net agent installed into it — retail (`wow`), classic
 * (`wow_classic`), classic era (`wow_classic_era`), PTR and beta — one active `.build.info` row
 * each, its client in a flavor folder (`_retail_`, `_classic_`…). Every CASC product has a
 * `.build.info`, so the file alone proves nothing; an active row of a `wow*` product does. The
 * installation reports its products ({@link installedWowProducts}); the content sources serve one
 * root per product.
 *
 * Candidates, bounded by construction: paths the user configured, `MODKIT_WOW_ROOT`, the uninstall
 * entry the Battle.net installer writes (read through the host's installation probes; it can name a
 * folder the user has since moved, so it is only a candidate), platform defaults, and the folders the
 * host's folder search found by this offer's markers (`.build.info` beside the launcher). A host
 * without probes or folder search (a browser) uses configured paths and the environment root.
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
import { cascProductOf, parseBuildInfo } from '@modkit/blizzard-casc'
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

export const WOW_GAME_ID = 'blizzard/world-of-warcraft'
const DISCOVERY_ID = 'blizzard.world-of-warcraft'
const DISPLAY_NAME = 'World of Warcraft'
const MAXIMUM_CANDIDATES = 128
const MAXIMUM_BUILD_INFO_BYTES = 256 * 1024
const ENVIRONMENT_ROOT = 'MODKIT_WOW_ROOT'
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft'
// The probe reads both registry views of a hive itself.
const REGISTRY_HIVES: readonly RegistryHive[] = Object.freeze(['HKLM', 'HKCU'])
/** The CASC payload folder every WoW product shares. */
export const WOW_DATA_DIRECTORY = 'Data'

/** One product of an installation: its `.build.info` row. */
export interface WowProduct {
  /** `wow`, `wow_classic`, `wow_classic_era`, `wowt`, `wow_beta`… */
  readonly product: string
  readonly buildKey: string
  readonly version: string
}

/** Whether a CASC product code is a World of Warcraft product. */
export function isWowProduct(product: string): boolean {
  return /^wow(?:$|[_a-z])/u.test(product.toLowerCase())
}

/** The WoW products of an installation's `.build.info`, retail first; none when it is missing. */
export async function installedWowProducts(installation: string): Promise<readonly WowProduct[]> {
  try {
    const path = join(installation, '.build.info')
    if ((await stat(path)).size > MAXIMUM_BUILD_INFO_BYTES) return []
    const products = parseBuildInfo(await readFile(path, 'utf8'))
      .filter(build => build.active && build.buildKey !== '')
      .map(build => ({ product: cascProductOf(build), buildKey: build.buildKey, version: build.version }))
      .filter(build => isWowProduct(build.product))
    return Object.freeze(products.sort((left, right) => rank(left.product) - rank(right.product)))
  } catch {
    return []
  }
}

/** Retail before the others, so the installation's version is retail's when it has one. */
function rank(product: string): number {
  return product === 'wow' ? 0 : 1
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** An uninstall entry may point at a flavor or support folder rather than the installation root. */
function normalizeRegistryPath(value: string): string {
  const path = resolve(value.trim())
  const leaf = basename(path).toLowerCase()
  return /^_[a-z_]+_$/u.test(leaf) || leaf === 'support' || leaf === 'support64' ? dirname(path) : path
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
    return ['/Applications/World of Warcraft', join(homedir(), 'Applications', 'World of Warcraft')]
  if (process.platform !== 'win32') return []
  return [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].flatMap(base =>
    base === undefined || base.trim() === '' ? [] : [join(base.trim(), 'World of Warcraft')],
  )
}

/** Confirm one candidate by its build rows; report what was found either way. */
async function probeCandidate(
  candidate: GameInstallationCandidate,
  signal?: AbortSignal,
): Promise<GameInstallationProbe> {
  signal?.throwIfAborted()
  const root = candidate.path
  const buildInfoPath = join(root, '.build.info')
  const products = await installedWowProducts(root)
  const dataPath = join(root, WOW_DATA_DIRECTORY)
  const evidence: GameInstallationEvidence[] = [
    Object.freeze({
      kind: 'wow-build-products',
      path: buildInfoPath,
      found: products.length > 0,
      detail: products.length === 0 ? 'no active WoW product' : products.map(item => `${item.product}=${item.version}`).join(';'),
    }),
    Object.freeze({ kind: 'casc-data-directory', path: dataPath, found: await isDirectory(dataPath) }),
  ]
  const version = products[0]?.version
  return Object.freeze({
    candidate,
    normalizedPath: normalizePath(root),
    confirmed: products.length > 0,
    ...(version === undefined || version === '' ? {} : { version }),
    evidence: Object.freeze(evidence),
  })
}

/** Every candidate the request and the host name, deduplicated, each confirmed or not. */
export async function discoverWowInstallations(
  request: GameInstallationDiscoveryRequest,
  installationProbes?: InstallationProbes,
): Promise<GameInstallationDiscoveryResult> {
  request.signal?.throwIfAborted()
  if (request.gameId !== WOW_GAME_ID)
    throw new TypeError(`World of Warcraft discovery cannot inspect ${request.gameId}`)
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
            gameId: WOW_GAME_ID,
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
        code: 'blizzard.world-of-warcraft/candidates-truncated',
        message: `candidate discovery was truncated at ${String(limit)}`,
      }),
    )
  if (installations.length === 0)
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.world-of-warcraft/installation-not-found',
        message: 'no candidate contained a confirmed World of Warcraft installation',
      }),
    )
  return Object.freeze({
    gameId: WOW_GAME_ID,
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
      gameIds: Object.freeze([WOW_GAME_ID]),
      origins: Object.freeze(['configured-path', 'default-directory', 'registry', 'search-folder'] as const),
      discover: (request: GameInstallationDiscoveryRequest) =>
        discoverWowInstallations(request, context?.installationProbes),
    }),
    release: async (): Promise<void> => undefined,
  })
}
