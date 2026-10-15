import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { GAME_INSTALLATION_DISCOVERY_CONTRACT } from '@modkit/sdk/games'
import {
  collectStarcraft2InstallationCandidates,
  normalizeStarcraft2InstallationPath,
} from './installation-candidates.js'

const DISCOVERY_ID = 'blizzard.starcraft2'
const GAME_ID = 'blizzard/starcraft-2'
const DISPLAY_NAME = 'StarCraft II'
const MAXIMUM_CANDIDATES = 128
const MAXIMUM_BUILD_INFO_BYTES = 256 * 1024
const MARKER_DIRECTORIES = Object.freeze([
  ['casc-config-directory', 'SC2Data', 'config'],
  ['casc-data-directory', 'SC2Data', 'data'],
  ['casc-indices-directory', 'SC2Data', 'indices'],
])
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StarCraft II'
// The host's probe reads both registry views of a hive itself.
const REGISTRY_HIVES = Object.freeze(['HKLM', 'HKCU'])

async function pathKind(path, expected) {
  try {
    const value = await stat(path)
    return expected === 'file' ? value.isFile() : value.isDirectory()
  } catch {
    return false
  }
}

function normalizeRegistryInstallationPath(value) {
  const path = resolve(value.trim())
  const leaf = basename(path).toLowerCase()
  return leaf === 'support' || leaf === 'support64' ? dirname(path) : path
}

/**
 * The Windows uninstall registry, read through the host's installation probes; a host without
 * them (a browser) contributes no registry candidate.
 */
async function registryCandidates(probes, signal) {
  if (probes === undefined) return []
  const candidates = []
  for (const hive of REGISTRY_HIVES) {
    signal?.throwIfAborted()
    const values = await probes.registryValues(hive, UNINSTALL_KEY, ['InstallLocation'], signal)
    const path = values['InstallLocation']?.trim()
    if (path) candidates.push(normalizeRegistryInstallationPath(path))
  }
  return candidates
}

function defaultCandidates() {
  if (process.platform === 'darwin') {
    return ['/Applications/StarCraft II', join(homedir(), 'Applications', 'StarCraft II')]
  }
  if (process.platform === 'linux') {
    return [
      join(homedir(), '.wine', 'drive_c', 'Program Files (x86)', 'StarCraft II'),
      join(homedir(), '.wine', 'drive_c', 'Program Files', 'StarCraft II'),
    ]
  }
  if (process.platform !== 'win32') return []
  const roots = []
  for (const base of [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']]) {
    if (base?.trim()) roots.push(join(base.trim(), 'StarCraft II'))
  }
  return roots
}

async function readBoundedBuildInformation(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAXIMUM_BUILD_INFO_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAXIMUM_BUILD_INFO_BYTES) {
      throw new RangeError(`.build.info exceeds ${MAXIMUM_BUILD_INFO_BYTES} bytes`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function parseBuildInformation(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
  const header = lines[0]
  if (header === undefined) return undefined
  const names = header.split('|').map(field => field.split('!')[0]?.trim() ?? '')
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

function matchesStarcraft2Build(build) {
  if (build === undefined) return false
  const product = build.product.toLowerCase()
  const buildProduct = build.buildProduct.toLowerCase().replace(/[^a-z0-9]/gu, '')
  const cdnPath = build.cdnPath.toLowerCase()
  return (
    product === 's2' ||
    product === 's2b' ||
    buildProduct === 'starcraft2' ||
    /(?:^|[/._-])sc?2(?:[/._-]|$)/u.test(cdnPath)
  )
}

async function probeCandidate(candidateValue, signal) {
  signal?.throwIfAborted()
  const root = candidateValue.path
  const buildInfoPath = join(root, '.build.info')
  const hasBuildInfo = await pathKind(buildInfoPath, 'file')
  let build
  if (hasBuildInfo) {
    try {
      build = parseBuildInformation(await readBoundedBuildInformation(buildInfoPath))
    } catch {
      build = undefined
    }
  }
  const identityMatched = matchesStarcraft2Build(build)
  const evidence = [
    Object.freeze({ kind: 'casc-build-info-file', path: buildInfoPath, found: hasBuildInfo }),
    Object.freeze({
      kind: 'starcraft2-build-identity',
      path: buildInfoPath,
      found: identityMatched,
      ...(build === undefined
        ? { detail: 'no active build record' }
        : { detail: `product=${build.product || 'unknown'};cdn=${build.cdnPath || 'unknown'}` }),
    }),
  ]
  for (const [kind, ...segments] of MARKER_DIRECTORIES) {
    signal?.throwIfAborted()
    const path = join(root, ...segments)
    evidence.push(Object.freeze({ kind, path, found: await pathKind(path, 'directory') }))
  }
  const confirmed = evidence.every(entry => entry.found)
  return Object.freeze({
    candidate: candidateValue,
    normalizedPath: normalizeStarcraft2InstallationPath(root),
    confirmed,
    ...(build?.version ? { version: build.version } : {}),
    ...(build?.buildName ? { buildName: build.buildName } : {}),
    ...(build?.buildUid ? { buildUid: build.buildUid } : {}),
    evidence: Object.freeze(evidence),
  })
}

function validatedLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_CANDIDATES) {
    throw new TypeError(
      `maxCandidates must be a positive safe integer no greater than ${MAXIMUM_CANDIDATES}`,
    )
  }
  return value
}

async function collectCandidates(request, limit, installationProbes) {
  const explicit = collectStarcraft2InstallationCandidates(
    {
      environmentPath: process.env['MODKITX_SC2_ROOT'],
      configuredPaths: request.configuredPaths,
      registryPaths: [],
      defaultPaths: [],
      platform: process.platform,
    },
    limit,
  )
  if (explicit.candidates.length >= limit) {
    return Object.freeze({ ...explicit, truncated: true })
  }
  return collectStarcraft2InstallationCandidates(
    {
      environmentPath: process.env['MODKITX_SC2_ROOT'],
      configuredPaths: request.configuredPaths,
      registryPaths: await registryCandidates(installationProbes, request.signal),
      defaultPaths: defaultCandidates(),
      platform: process.platform,
    },
    limit,
  )
}

/** `installationProbes`: the host's, when it offers them (a desktop host does). */
export async function discoverStarcraft2Installations(request, installationProbes) {
  request.signal?.throwIfAborted()
  if (request.gameId !== GAME_ID) {
    throw new TypeError(`StarCraft II discovery cannot inspect ${request.gameId}`)
  }
  const limit = validatedLimit(request.maxCandidates)
  const collected = await collectCandidates(request, limit, installationProbes)
  const probes = []
  for (const entry of collected.candidates) {
    request.signal?.throwIfAborted()
    probes.push(await probeCandidate(entry, request.signal))
  }
  const installations = probes.flatMap((probe, index) =>
    probe.confirmed
      ? [
          Object.freeze({
            gameId: GAME_ID,
            displayName: DISPLAY_NAME,
            installPath: probe.candidate.path,
            normalizedPath: probe.normalizedPath,
            origins: collected.candidateOrigins[index] ?? Object.freeze([probe.candidate.origin]),
            ...(probe.version === undefined ? {} : { version: probe.version }),
            ...(probe.buildName === undefined ? {} : { buildName: probe.buildName }),
            ...(probe.buildUid === undefined ? {} : { buildUid: probe.buildUid }),
            evidence: probe.evidence,
          }),
        ]
      : [],
  )
  const diagnostics = []
  if (collected.truncated) {
    diagnostics.push(
      Object.freeze({
        severity: 'warning',
        code: 'blizzard.starcraft2/candidates-truncated',
        message: `candidate discovery was truncated at ${limit}`,
      }),
    )
  }
  if (installations.length === 0) {
    diagnostics.push(
      Object.freeze({
        severity: 'information',
        code: 'blizzard.starcraft2/installation-not-found',
        message: 'no candidate contained a confirmed StarCraft II installation',
      }),
    )
  }
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

export function createProvider(selection, context) {
  if (selection.contract !== GAME_INSTALLATION_DISCOVERY_CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `unsupported game-installation selection ${selection.contract}@${selection.major}`,
    )
  }
  return Object.freeze({
    value: Object.freeze({
      contract: GAME_INSTALLATION_DISCOVERY_CONTRACT,
      discoveryId: DISCOVERY_ID,
      gameIds: Object.freeze([GAME_ID]),
      origins: Object.freeze(['configured-path', 'default-directory', 'registry']),
      discover: request => discoverStarcraft2Installations(request, context?.installationProbes),
    }),
    release: async () => undefined,
  })
}
