import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export function sanitizeBuildKey(value) {
  const key = String(value).trim().toLowerCase()
  if (!/^[0-9a-f]+$/u.test(key)) throw new TypeError('CASC build key must be hexadecimal')
  return key
}

export function perBuildDir(base, key) {
  return path.join(base, sanitizeBuildKey(key))
}

export async function pruneOtherBuilds(base, keepKey) {
  const keep = sanitizeBuildKey(keepKey)
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep || !/^[0-9a-f]+$/u.test(entry.name)) continue
    await fs.rm(path.join(base, entry.name), { recursive: true, force: true })
  }
}

/** Games by `.build.info` product, for the cache manifest; another product names itself. */
const CASC_GAMES = Object.freeze({ s2: 'starcraft2', d3: 'diablo3', hero: 'heroes', s1: 'starcraft1', w3: 'warcraft3' })

export function cascGameOf(product) {
  return CASC_GAMES[product] ?? product
}

/**
 * One installation however it is named: the codec knows it as a `file:` uri, the SC2 content
 * source as a path. As an absolute path (without case on Windows) both name the same folder.
 */
export function canonicalInstallation(installation) {
  const value = String(installation)
  let local
  try {
    local = value.startsWith('file:') ? fileURLToPath(value) : value
  } catch {
    return value
  }
  if (!path.isAbsolute(local)) return value
  const resolved = path.resolve(local)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** The folder of an installation's cache: FNV-1a of its identity. */
export function installationCacheFolder(installation) {
  let hash = 0x811c9dc5
  for (let index = 0; index < installation.length; index++) {
    hash ^= installation.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `source-${hash.toString(16).padStart(8, '0')}`
}

/**
 * Before the host's shared directory, an installation's cache lay in a directory of its own
 * reader's (the codec's contribution directory, the SC2 source's `casc-index`), named by the raw
 * identity; once the shared one is used that copy only takes space.
 */
export async function removeLegacyCache(directory, installation) {
  await fs
    .rm(path.join(directory, installationCacheFolder(String(installation))), {
      recursive: true,
      force: true,
    })
    .catch(() => undefined)
}

/**
 * The root cache of one installation under a shared directory. Each installation gets its own
 * folder: a cache prunes the other builds of its game, and two installed games must not evict
 * each other. `installation` is a source uri or an absolute path; both spell one folder. With
 * `describe` the folder carries the host's `cache.json` (sdk `IndexCacheManifest`), so an
 * application can list it, size it and clear it.
 */
export function createInstallationRootCache(directory, installation, log, describe) {
  return createCascRootCache(
    path.join(directory, installationCacheFolder(canonicalInstallation(installation))),
    log,
    describe,
  )
}

/**
 * `kind` names the file of one build: `mndx` holds a serialized MNDX index (StarCraft II), `names`
 * the file list of any other root (Diablo III, TVFS, StarCraft: Remastered) — see `reader.js`;
 * `local-rows` which of the build's files the local indexes hold, with their fingerprint.
 */
export function createCascRootCache(base, log, describe) {
  const rawFileFor = (key, kind) =>
    path.join(perBuildDir(base, key), 'index', kind === 'mndx' ? 'mndx.bin' : kind.startsWith('wow-') || kind === 'local-rows' ? `${kind}.bin` : `${kind}.json`)
  return {
    async load(key, kind = 'mndx') {
      try {
        const raw = await fs.readFile(rawFileFor(key, kind))
        log.info(
          `CASC index cache hit (${(raw.length / 1e6).toFixed(1)} MB ${kind} on disk) - skipping the root parse`,
        )
        return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      } catch {
        return undefined
      }
    },
    async store(key, bytes, kind = 'mndx') {
      try {
        const buildKey = sanitizeBuildKey(key)
        const dest = rawFileFor(buildKey, kind)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        const temporary = `${dest}.${process.pid}.tmp`
        await fs.writeFile(temporary, bytes)
        await fs.rename(temporary, dest)
        await pruneOtherBuilds(base, buildKey)
        if (describe !== undefined) {
          await fs.writeFile(path.join(base, 'cache.json'), `${JSON.stringify(describe)}\n`)
        }
        log.info(
          `CASC index cache written (${(bytes.length / 1e6).toFixed(1)} MB ${kind}) - next open skips the root parse`,
        )
      } catch (error) {
        log.warn(
          `CASC index cache write failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
