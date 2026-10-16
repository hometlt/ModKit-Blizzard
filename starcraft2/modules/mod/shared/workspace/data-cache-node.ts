/**
 * Kept parses of saved SC2 mod chains on disk (owner decision 10.10; Node only): the
 * `ChainDataCache` of `chain-data.ts` over the host's shared index cache directory (sdk
 * `index-caches`, folder `sc2-data`).
 *
 * Which leading layers are kept: Core up to the last layer that is one of `mods` (a stock mod's name
 * as `Mods/<name>.SC2Mod` names it; `Liberty`, `Void`, `VoidMulti` by default), when every one of
 * them carries a content fingerprint (CASC layers: the installation's build). A record is keyed by
 * the code that reads and parses it (SHA-256 of this module's folder files and the Data module's
 * files) and by those layers' paths, roots and fingerprints, so a new build, another installation or
 * a changed parser is a miss. Records contain separate V8 document frames (`data-cache-record`),
 * preserving native references within each document and yielding between document turns. They
 * are written to a temporary file and renamed; at most
 * `MAXIMUM_RECORDS` are kept, oldest removed first. Any failure to read or write is a miss: the chain
 * is read and parsed as without a cache.
 * Instances over the same absolute cache directory and immutable prefix share an in-flight cold
 * producer, reads and writes. A producer builds its existing full session once, not a prefix model.
 * Its record bridges to the pending disk write only; failures release operations for retry.
 * Data owns the stored parse form and restores lazy fields after decoding; V8 never enumerates
 * derived own values during a save. Older parse envelopes are ordinary misses, not eager fallbacks.
 * Code fingerprints read at most four files concurrently and hash them in sorted order,
 * preserving the digest rules without serial filesystem latency or an unbounded buffer batch.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChainDataCache, ChainLayer, ChainPrefixRecord } from './chain-data.js'
import { encodeDataCacheRecord, decodeDataCacheRecord } from './data-cache-record.js'

/** Stock mods kept when the user names none. */
export const DEFAULT_CACHED_MODS: readonly string[] = Object.freeze(['Liberty', 'Void', 'VoidMulti'])
const MAXIMUM_RECORDS = 8
const RECORD_VERSION = 2

const slash = (value: string) => value.split(String.fromCharCode(92)).join('/')

/** Files of a folder (recursively), sorted, for the code digest. */
async function codeFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isFile() && /\.(?:js|ts|json)$/u.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

let codeDigest: Promise<string> | undefined
/** One physical cache record has one in-flight read/producer and writer across cache instances. */
const loading = new Map<string, Promise<ChainPrefixRecord | undefined>>()
const writing = new Map<string, Promise<void>>()
/** Stable SHA-256 of the parser owners; transient read failures release the shared attempt. */
function parserCode(): Promise<string> {
  if (codeDigest !== undefined) return codeDigest
  const digest = (async () => {
    const here = fileURLToPath(new URL('./', import.meta.url))
    const data = fileURLToPath(new URL('../../../data/', import.meta.url))
    const hash = createHash('sha256')
    for (const root of [here, data]) {
      const files = await codeFiles(root)
      for (let start = 0; start < files.length; start += 4) {
        const batch = files.slice(start, start + 4)
        const contents = await Promise.all(batch.map(file => readFile(file)))
        for (let index = 0; index < batch.length; index++) {
          hash.update(slash(relative(root, batch[index]!)))
          hash.update(contents[index]!)
        }
      }
    }
    return hash.digest('hex')
  })()
  codeDigest = digest
  void digest.catch(() => {
    if (codeDigest === digest) codeDigest = undefined
  })
  return digest
}

export interface Sc2DataCacheOptions {
  /** The host's shared index cache directory. */
  readonly directory: string
  /** Stock mods whose chain prefix is kept; empty keeps nothing. */
  readonly mods?: readonly string[]
  /** The installation the records belong to, as the user would recognise it (the cache manifest). */
  readonly installation?: string
}

/** The kept-parses cache of saved chains, or undefined when it keeps nothing. */
export function createSc2DataCache(options: Sc2DataCacheOptions): ChainDataCache | undefined {
  const mods = (options.mods ?? DEFAULT_CACHED_MODS).map(name => `mods/${name.toLowerCase()}.sc2mod`)
  if (mods.length === 0) return undefined
  const folder = resolve(options.directory, 'sc2-data')
  // Retain only current read/producer/write operations; active models own the lasting parsed state.
  const physicalRoot = process.platform === 'win32' ? slash(folder).toLowerCase() : folder
  /** Include the physical folder so independent installations/cache directories cannot collide. */
  const operationKey = (key: string) => JSON.stringify([physicalRoot, key])
  const fileOf = async (key: string) =>
    join(folder, `${createHash('sha256').update(await parserCode()).update(key).digest('hex')}.v8`)
  return {
    prefixOf(layers: readonly ChainLayer[]) {
      let last = -1
      layers.forEach((layer, index) => {
        const path = slash(layer.sourcePath).toLowerCase()
        if (mods.some(mod => path === mod || path.endsWith(`/${mod}`))) last = index
      })
      if (last < 0) return undefined
      const prefix = layers.slice(0, last + 1)
      if (prefix.some(layer => layer.fingerprint === undefined)) return undefined
      return {
        count: prefix.length,
        key: JSON.stringify([RECORD_VERSION, prefix.map(layer => [layer.sourcePath, layer.rootId, layer.fingerprint])]),
      }
    },
    async load(key: string, create?: () => Promise<ChainPrefixRecord | undefined>) {
      const operation = operationKey(key)
      const existing = loading.get(operation)
      if (existing !== undefined) return existing
      const reading = (async () => {
        try {
          const bytes = await readFile(await fileOf(key))
          return await decodeDataCacheRecord(bytes, key)
        } catch {
          // Absent/corrupt/unreadable records are misses; producer errors must remain retryable.
        }
        return create?.()
      })()
      loading.set(operation, reading)
      const release = () => {
        if (loading.get(operation) !== reading) return
        const saving = writing.get(operation)
        // Bridge the producer's completed parse to its pending disk write without rereading it.
        if (saving !== undefined) void saving.then(release, release)
        else loading.delete(operation)
      }
      void reading.then(release, release)
      return reading
    },
    async save(key: string, record: ChainPrefixRecord) {
      const operation = operationKey(key)
      const existing = writing.get(operation)
      if (existing !== undefined) return existing
      const saving = (async () => {
        await mkdir(folder, { recursive: true })
        const manifest = join(folder, 'cache.json')
        if (await stat(manifest).catch(() => undefined) === undefined) {
          await writeFile(manifest, JSON.stringify({
            game: 'starcraft2', product: 's2', kind: 'data',
            installation: options.installation ?? 'StarCraft II mod chains',
          }, null, 2))
        }
        const file = await fileOf(key)
        // Separate cache instances in this process must not rename one another's temporary files.
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, encodeDataCacheRecord(key, record))
          await rename(temporary, file)
        } finally { await rm(temporary, { force: true }).catch(() => {}) }
        // Keep the newest records only.
        const records = await Promise.all((await readdir(folder)).filter(name => name.endsWith('.v8')).map(async name => ({
          name, time: (await stat(join(folder, name)).catch(() => undefined))?.mtimeMs ?? 0,
        })))
        for (const old of records.sort((left, right) => right.time - left.time).slice(MAXIMUM_RECORDS)) {
          await rm(join(folder, old.name), { force: true })
        }
      })()
      writing.set(operation, saving)
      const release = () => { if (writing.get(operation) === saving) writing.delete(operation) }
      void saving.then(release, release)
      return saving
    },
  }
}
