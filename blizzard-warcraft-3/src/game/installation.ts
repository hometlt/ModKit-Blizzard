/**
 * Warcraft III installation discovery — `common.game/installation-discovery`.
 *
 * Replaces the MK2 copy this package used to carry, which could only sniff a `.build.info` marker
 * and said so itself: that marker is shared by every Blizzard CASC product, so it could not tell
 * Warcraft III from StarCraft II. This reads the active build record and matches the product,
 * which is the fact that actually identifies the game. A classic (1.x, pre-Reforged) installation
 * has no build record: it is identified by its own MPQ archive next to the files that run it.
 *
 * Bounded by construction: verified platform defaults, the registry keys the game writes (read
 * through the host's installation probes, when the host offers them), paths the user configured
 * and, confirmed last, the folders the host's folder search found by the offer's markers
 * (`provider.json`). It never walks a drive itself.
 */
import {
  collectInstallationCandidates,
  normalizeInstallationPath as normalizePath,
} from '@modkit/host/node'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

const DISCOVERY_ID = 'blizzard.warcraft3'
const GAME_ID = 'blizzard/warcraft-3'
const DISPLAY_NAME = 'Warcraft III'
/** A classic installation with the expansion archive is the one a player knows by this name. */
const EXPANSION_DISPLAY_NAME = 'Warcraft III: The Frozen Throne'
const MAXIMUM_CANDIDATES = 128
const MAXIMUM_BUILD_INFO_BYTES = 256 * 1024
const ENVIRONMENT_ROOT = 'MODKIT_WARCRAFT3_ROOT'
// The probe reads both registry views of a hive itself.
const REGISTRY_HIVES: readonly RegistryHive[] = Object.freeze(['HKLM', 'HKCU'])
/** Registry values naming an installation root: Reforged's uninstall entry, classic's own key. */
const REGISTRY_ROOTS = Object.freeze([
  {
    key: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft III',
    names: ['InstallLocation'],
  },
  // Classic installers record Reign of Chaos and The Frozen Throne separately.
  { key: 'SOFTWARE\\Blizzard Entertainment\\Warcraft III', names: ['InstallPath', 'InstallPathX'] },
])
/** A classic installation: its base archive, the expansion's, and a file that runs them. */
const CLASSIC_ARCHIVE = 'war3.mpq'
const CLASSIC_EXPANSION_ARCHIVE = 'war3x.mpq'
const CLASSIC_RUNTIME = Object.freeze([
  'game.dll',
  'war3.exe',
  'warcraft iii.exe',
  'frozen throne.exe',
])

interface BuildRecord {
  readonly version: string
  readonly buildName: string
  readonly buildUid: string
  readonly product: string
  readonly buildProduct: string
  readonly cdnPath: string
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

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

/** Registry roots through the host's probes; a host that offers none contributes no candidate. */
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
    return ['/Applications/Warcraft III', join(homedir(), 'Applications', 'Warcraft III')]
  if (process.platform === 'linux')
    return [
      join(homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'Warcraft III'),
      join(homedir(), '.wine', 'drive_c', 'Program Files', 'Warcraft III'),
    ]
  if (process.platform !== 'win32') return []
  const roots: string[] = []
  for (const base of [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']])
    if (base !== undefined && base.trim() !== '') roots.push(join(base.trim(), 'Warcraft III'))
  return roots
}

async function readBoundedBuildInformation(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAXIMUM_BUILD_INFO_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAXIMUM_BUILD_INFO_BYTES)
      throw new RangeError(`.build.info exceeds ${String(MAXIMUM_BUILD_INFO_BYTES)} bytes`)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** `.build.info` is a pipe-separated table whose header names each column as `Name!TYPE:SIZE`. */
function parseBuildInformation(text: string): BuildRecord | undefined {
  const lines = text
    .replace(/^﻿/u, '')
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
  const header = lines[0]
  if (header === undefined) return undefined
  const names = header.split('|').map(column => column.split('!')[0]?.trim() ?? '')
  for (const line of lines.slice(1)) {
    const values = line.split('|')
    const fields = new Map(names.map((name, index) => [name, values[index] ?? '']))
    if (fields.get('Active') !== '1') continue
    return {
      version: fields.get('Version')?.trim() ?? '',
      buildName: fields.get('Build Name')?.trim() ?? '',
      buildUid: fields.get('Build UID')?.trim() ?? '',
      product: fields.get('Product')?.trim() ?? '',
      buildProduct: fields.get('Build Product')?.trim() ?? '',
      cdnPath: fields.get('CDN Path')?.trim() ?? '',
    }
  }
  return undefined
}

/** Warcraft III ships as the `w3` CASC product; Reforged keeps it and serves from `tpr/war3`. */
function matchesWarcraft3(build: BuildRecord | undefined): boolean {
  if (build === undefined) return false
  const product = build.product.toLowerCase()
  const buildProduct = build.buildProduct.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
  const cdnPath = build.cdnPath.toLowerCase()
  return (
    product === 'w3' ||
    product === 'w3t' ||
    buildProduct === 'warcraft3' ||
    buildProduct === 'warcraftiii' ||
    /(?:^|[/._-])(?:w3|war3)(?:[/._-]|$)/u.test(cdnPath)
  )
}

async function probeCandidate(
  candidate: GameInstallationCandidate,
  signal?: AbortSignal,
): Promise<GameInstallationProbe> {
  signal?.throwIfAborted()
  const root = candidate.path
  const buildInfoPath = join(root, '.build.info')
  const hasBuildInfo = await isFile(buildInfoPath)
  let build: BuildRecord | undefined
  if (hasBuildInfo) {
    try {
      build = parseBuildInformation(await readBoundedBuildInformation(buildInfoPath))
    } catch {
      build = undefined
    }
  }
  const identityMatched = matchesWarcraft3(build)
  const evidence: GameInstallationEvidence[] = [
    Object.freeze({ kind: 'casc-build-info-file', path: buildInfoPath, found: hasBuildInfo }),
    Object.freeze({
      kind: 'warcraft3-build-identity',
      path: buildInfoPath,
      found: identityMatched,
      detail:
        build === undefined
          ? 'no active build record'
          : `product=${build.product || 'unknown'};cdn=${build.cdnPath || 'unknown'}`,
    }),
  ]
  // The CASC payload folder is reported, not required: its name has moved between Warcraft III
  // builds, and the build record above already identifies the product on its own.
  for (const name of ['Data', 'data']) {
    signal?.throwIfAborted()
    const path = join(root, name)
    if (await isDirectory(path)) {
      evidence.push(Object.freeze({ kind: 'casc-data-directory', path, found: true }))
      break
    }
  }
  // A classic installation has no build record; its own archive beside the files that run it is
  // the identity. Names are compared case-insensitively, as the game's installers vary them.
  let names = new Set<string>()
  if (!identityMatched)
    try {
      names = new Set((await readdir(root)).map(name => name.toLowerCase()))
    } catch {
      // An unreadable candidate is simply not confirmed.
    }
  const classic = names.has(CLASSIC_ARCHIVE) && CLASSIC_RUNTIME.some(name => names.has(name))
  if (!identityMatched)
    evidence.push(
      Object.freeze({
        kind: 'warcraft3-classic-archive',
        path: join(root, CLASSIC_ARCHIVE),
        found: classic,
      }),
      Object.freeze({
        kind: 'warcraft3-expansion-archive',
        path: join(root, CLASSIC_EXPANSION_ARCHIVE),
        found: names.has(CLASSIC_EXPANSION_ARCHIVE),
      }),
    )
  const expansion = classic && names.has(CLASSIC_EXPANSION_ARCHIVE)
  return Object.freeze({
    candidate: expansion
      ? Object.freeze({ ...candidate, displayName: EXPANSION_DISPLAY_NAME })
      : candidate,
    normalizedPath: normalizePath(root),
    confirmed: (hasBuildInfo && identityMatched) || classic,
    ...(build?.version === undefined || build.version === '' ? {} : { version: build.version }),
    ...(build?.buildName === undefined || build.buildName === ''
      ? {}
      : { buildName: build.buildName }),
    ...(build?.buildUid === undefined || build.buildUid === '' ? {} : { buildUid: build.buildUid }),
    evidence: Object.freeze(evidence),
  })
}

function validatedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_CANDIDATES)
    throw new TypeError(
      `maxCandidates must be a positive safe integer no greater than ${String(MAXIMUM_CANDIDATES)}`,
    )
  return value
}

/** Deduplicate by normalized path, keeping every origin that pointed at it. */

export async function discoverWarcraft3Installations(
  request: GameInstallationDiscoveryRequest,
  installationProbes?: InstallationProbes,
): Promise<GameInstallationDiscoveryResult> {
  request.signal?.throwIfAborted()
  if (request.gameId !== GAME_ID)
    throw new TypeError(`Warcraft III discovery cannot inspect ${request.gameId}`)
  const limit = validatedLimit(request.maxCandidates)
  const environmentRoot = process.env[ENVIRONMENT_ROOT]
  const entries: { origin: GameInstallationOrigin; path: string }[] = []
  for (const path of request.configuredPaths ?? []) {
    if (typeof path !== 'string' || path.trim() === '')
      throw new TypeError('configuredPaths entries must be non-empty paths')
    entries.push({ origin: 'configured-path', path })
  }
  if (environmentRoot !== undefined && environmentRoot.trim() !== '')
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
  for (const candidate of collected.candidates) {
    request.signal?.throwIfAborted()
    probes.push(await probeCandidate(candidate, request.signal))
  }
  const installations: GameInstallation[] = probes.flatMap((probe, index) =>
    probe.confirmed
      ? [
          Object.freeze({
            gameId: GAME_ID,
            displayName: probe.candidate.displayName,
            installPath: probe.candidate.path,
            normalizedPath: probe.normalizedPath,
            origins: collected.origins[index] ?? Object.freeze([probe.candidate.origin]),
            ...(probe.version === undefined ? {} : { version: probe.version }),
            ...(probe.buildName === undefined ? {} : { buildName: probe.buildName }),
            ...(probe.buildUid === undefined ? {} : { buildUid: probe.buildUid }),
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
        code: 'blizzard.warcraft3/candidates-truncated',
        message: `candidate discovery was truncated at ${String(limit)}`,
      }),
    )
  if (installations.length === 0)
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.warcraft3/installation-not-found',
        message: 'no candidate contained a confirmed Warcraft III installation',
      }),
    )
  return Object.freeze({
    gameId: GAME_ID,
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
      gameIds: Object.freeze([GAME_ID]),
      origins: Object.freeze(['configured-path', 'default-directory', 'registry', 'search-folder'] as const),
      discover: (request: GameInstallationDiscoveryRequest) =>
        discoverWarcraft3Installations(request, context?.installationProbes),
    }),
    release: async (): Promise<void> => undefined,
  })
}
