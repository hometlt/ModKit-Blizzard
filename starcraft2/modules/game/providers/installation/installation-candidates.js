import { resolve } from 'node:path'

const DISPLAY_NAME = 'StarCraft II'

/** Normalize one installation root for stable comparison and service output. */
export function normalizeStarcraft2InstallationPath(value) {
  return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
}

function nonEmptyPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty path`)
  }
  return resolve(value.trim())
}

function candidate(origin, path) {
  return {
    origin,
    displayName: DISPLAY_NAME,
    path: normalizeStarcraft2InstallationPath(path),
  }
}

function candidateKey(candidateValue, platform) {
  const path = normalizeStarcraft2InstallationPath(candidateValue.path)
  return platform === 'win32' ? path.toLowerCase() : path
}

function configuredCandidates(paths) {
  if (paths === undefined) return []
  if (!Array.isArray(paths)) throw new TypeError('configuredPaths must be an array when present')
  return paths.map((path, index) =>
    candidate('configured-path', nonEmptyPath(path, `configuredPaths[${index}]`)),
  )
}

function discoveredCandidates(paths, origin) {
  return paths.flatMap(path =>
    typeof path === 'string' && path.trim().length > 0
      ? [candidate(origin, resolve(path.trim()))]
      : [],
  )
}

/**
 * Merge already-bounded candidate sources in product precedence order.
 *
 * Manual paths win over the environment root, which wins over registry and platform defaults.
 * Deduplication is first-wins, case-insensitive on Windows, and retains every observed origin.
 */
export function collectStarcraft2InstallationCandidates(
  { environmentPath, configuredPaths, registryPaths, defaultPaths, platform },
  limit,
) {
  const discovered = [
    ...configuredCandidates(configuredPaths),
    ...(typeof environmentPath === 'string' && environmentPath.trim().length > 0
      ? [candidate('configured-path', nonEmptyPath(environmentPath, 'MODKITX_SC2_ROOT'))]
      : []),
    ...discoveredCandidates(registryPaths, 'registry'),
    ...discoveredCandidates(defaultPaths, 'default-directory'),
  ]
  const unique = new Map()
  for (const entry of discovered) {
    const key = candidateKey(entry, platform)
    const existing = unique.get(key)
    if (existing === undefined) {
      unique.set(key, { candidate: entry, origins: [entry.origin] })
    } else if (!existing.origins.includes(entry.origin)) {
      existing.origins.push(entry.origin)
    }
  }
  const selected = [...unique.values()].slice(0, limit)
  return Object.freeze({
    candidates: Object.freeze(selected.map(entry => Object.freeze(entry.candidate))),
    candidateOrigins: Object.freeze(selected.map(entry => Object.freeze([...entry.origins]))),
    truncated: unique.size > limit,
  })
}
