import { cascProductOf, detectCascDataDirectory, readActiveBuildConfig } from './config.js'
import { Diablo3NameDb, isDiablo3Root } from './diablo3-root.js'
import { encodingPagesEnd, parseEncodingTable } from './encoding.js'
import { CASC_LIMITS, cascError, throwIfCancelled } from './limits.js'
import { MndxNameDb, onNodeMainThread, parseMndxInThread } from './mndx.js'
import { CascPathIndex, CascPathIndexBuilder, arrayPathIndex } from './path-index.js'
import { createCascPathAliases, normalizeCascPath, normalizeCascPrefix } from './path-map.js'
import { Starcraft1NameDb, isStarcraft1TextRoot } from './starcraft1-root.js'
import { CascStorage } from './storage.js'
import { TvfsNameDb, isTvfsRoot } from './tvfs.js'
// Strict TS, built to `dist` by `build:casc` before anything reads a CASC.
import { isWowRoot, parseWowListfile, wowLocaleFlag, wowRootFiles } from '../../dist/casc/wow-root.js'

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function'
  )
}

function optionsFrom(value) {
  if (isAbortSignal(value)) return { signal: value }
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('CASC reader options must be an object or AbortSignal')
  }
  return value
}

function portable(path) {
  return String(path).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
}

function standardizedEntries(nameDb, encoding) {
  const entries = []
  for (const file of nameDb.files()) {
    const contentSize = file.contentSize ?? encoding.get(file.contentKey)?.size ?? 0
    entries.push(Object.freeze({ ...file, path: portable(file.path).toLowerCase(), contentSize }))
  }
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  return Object.freeze(entries)
}

/**
 * The sorted path table the namespace source pages over. A columnar root (MNDX — the one that
 * reaches ~666k names) already is that table: sorted, normalized and held in typed arrays, so it
 * is used as-is rather than copied into an entry object per file. The small object roots keep
 * the standardized array.
 */
/** Rows {@link CascReader.localRows} checks before it gives the thread back. */
const LOCAL_ROWS_SLICE = 32_768

/** Shared exact row test for the complete bitmap and bounded package-presence queries. */
function localRowAt(reader, index, row, keyColumn, width) {
  if (keyColumn === undefined) return reader.hasPath(index.keyAt(row))
  const at = reader.encoding.indexOfBytes(keyColumn, row * 16)
  return at !== -1 && reader.storage.hasEncodingKeyBytes(reader.encoding.encodingKeys, at * width, width)
}

function entryIndexFor(nameDb, encoding) {
  return nameDb instanceof CascPathIndex
    ? nameDb
    : arrayPathIndex(standardizedEntries(nameDb, encoding))
}

/**
 * Roots other than MNDX are rebuilt from their file list: parsing them again is the slow part (a
 * Diablo III root reads and decodes every sub-root it names). The list is cached under the root's
 * content key beside the MNDX cache; bump the version when a record's shape changes, or when a
 * parser fix changes the names it lists (4: TVFS names that share a fragment, Warcraft III).
 */
const FILE_LIST_ROOTS = Object.freeze({
  diablo3: Diablo3NameDb,
  tvfs: TvfsNameDb,
  'starcraft1-text': Starcraft1NameDb,
})
const NAMES_CACHE_VERSION = 4

// Records as columns (one array per field, `null` where a record lacks it): half the size of
// records that repeat every field name, and as plain JSON as they are.
function toColumns(files) {
  const names = [...new Set(files.flatMap(file => Object.keys(file)))]
  return Object.fromEntries(names.map(name => [name, files.map(file => file[name] ?? null)]))
}

function fromColumns(columns) {
  const names = Object.keys(columns)
  const count = names.length === 0 ? 0 : columns[names[0]].length
  const files = new Array(count)
  for (let index = 0; index < count; index++) {
    const file = {}
    for (const name of names) {
      const value = columns[name][index]
      if (value !== null) file[name] = value
    }
    files[index] = file
  }
  return files
}

/** The text locale of a build (`ruRU` of `Tags = … ruRU text?`), which picks a WoW root's variants. */
function textLocaleOf(build) {
  return (build.fields?.get('Tags') ?? '').match(/\b([a-z]{2}[A-Z]{2}) text\?/u)?.[1] ?? 'enUS'
}

const WOW_PATH_PREFIX = new TextEncoder().encode('filedataid/')

/**
 * A World of Warcraft root as a path index: per file the client of `locale` loads, its listfile
 * path, else `filedataid/<id>`; its size from the encoding table; its FileDataID in the package
 * column, so `filedataid/<id>` reads every file, named or not. A file the encoding table lacks
 * cannot be read and is left out. WoW 12: 1.93 million readable files.
 */
function wowNameDb(rootBytes, locale, encoding, listfile) {
  const { fileDataIds, contentKeyOffsets } = wowRootFiles(rootBytes, wowLocaleFlag(locale))
  const builder = new CascPathIndexBuilder()
  let path = new Uint8Array(4096)
  path.set(WOW_PATH_PREFIX)
  let named = 0
  for (let i = 0; i < fileDataIds.length; i++) {
    const at = contentKeyOffsets[i]
    const row = encoding.indexOfBytes(rootBytes, at)
    if (row === -1) continue
    const id = fileDataIds[i]
    while (listfile !== undefined && named < listfile.fileDataIds.length && listfile.fileDataIds[named] < id) named++
    let length
    if (listfile !== undefined && listfile.fileDataIds[named] === id) {
      const start = listfile.starts[named]
      length = listfile.ends[named] - start
      if (length > path.length) path = new Uint8Array(length)
      for (let k = 0; k < length; k++) path[k] = listfile.bytes[start + k]
    } else {
      const digits = String(id)
      for (let d = 0; d < digits.length; d++) path[WOW_PATH_PREFIX.length + d] = digits.charCodeAt(d)
      path.set(WOW_PATH_PREFIX)
      length = WOW_PATH_PREFIX.length + digits.length
    }
    builder.add(path, length, rootBytes, at, encoding.sizes[row], id)
  }
  return builder.build()
}

/**
 * FileDataID → row of a WoW path index, from its package column: IDs and rows packed into one
 * exactly representable double each (IDs < 2^31, rows < 2^22), sorted, binary-searched.
 */
function wowFileDataRows(index) {
  const pairs = new Float64Array(index.count)
  for (let row = 0; row < index.count; row++) pairs[row] = index.packages[row] * 4194304 + row
  return pairs.sort()
}

const FILE_DATA_ID = /^filedataid[\\/](\d+)$/u

/** The cache file a WoW index is kept in: its locale and the listfile it was named with. */
function wowCacheKind(locale, listfile) {
  if (listfile === undefined) return `wow-${locale}`
  let hash = 0x811c9dc5
  for (let i = 0; i < listfile.id.length; i++) hash = Math.imul(hash ^ listfile.id.charCodeAt(i), 0x01000193)
  return `wow-${locale}-${(hash >>> 0).toString(16)}`
}

export async function cachedRoot(cache, key, wowLocale, wowListfile) {
  if (wowLocale !== undefined) {
    // A WoW index depends on the locale whose variants it lists and the listfile that names them.
    const bytes = await cache.load(key, wowCacheKind(wowLocale, wowListfile)).catch(() => undefined)
    try {
      return bytes === undefined ? undefined : Object.freeze({ nameDb: CascPathIndex.deserialize(bytes), rootFormat: 'wow' })
    } catch {
      return undefined
    }
  }
  const mndx = await cache.load(key).catch(() => undefined)
  if (mndx !== undefined) {
    try {
      return Object.freeze({ nameDb: MndxNameDb.deserialize(mndx), rootFormat: 'mndx' })
    } catch {
      // A cache of another layout version is rebuilt below.
    }
  }
  const listed = await cache.load(key, 'names').catch(() => undefined)
  if (listed === undefined) return undefined
  try {
    const { version, rootFormat, columns } = JSON.parse(new TextDecoder().decode(listed))
    const NameDb = FILE_LIST_ROOTS[rootFormat]
    return version === NAMES_CACHE_VERSION && NameDb !== undefined && columns !== null
      ? Object.freeze({ nameDb: new NameDb(fromColumns(columns)), rootFormat })
      : undefined
  } catch {
    return undefined
  }
}

export async function cacheRoot(cache, key, parsed, encoding, wowLocale, wowListfile) {
  if (parsed.rootFormat === 'wow') {
    await cache.store(key, parsed.nameDb.serialize(), wowCacheKind(wowLocale, wowListfile)).catch(() => undefined)
  } else if (parsed.rootFormat === 'mndx') {
    await cache.store(key, parsed.nameDb.serialize()).catch(() => undefined)
  } else if (FILE_LIST_ROOTS[parsed.rootFormat] !== undefined) {
    // A size belongs to its content key, so it is cached too: looking up 285k keys in the encoding
    // table again was a third of a cached Diablo III open.
    const columns = toColumns(
      Array.from(parsed.nameDb.files(), file =>
        file.contentSize === undefined
          ? { ...file, contentSize: encoding.get(file.contentKey)?.size ?? 0 }
          : file,
      ),
    )
    const bytes = new TextEncoder().encode(
      JSON.stringify({ version: NAMES_CACHE_VERSION, rootFormat: parsed.rootFormat, columns }),
    )
    await cache.store(key, bytes, 'names').catch(() => undefined)
  }
}

// The CDN a file the install does not hold is read from (`cdnFetch` turns it on). `cdnArchives`
// finds which CDN archive keeps a file, by the install's own archive indices; `cdnCache` keeps what
// was downloaded. Without them a file is fetched as a loose CDN object, which few files are.
function cdnFrom(build, options, source, dataRoot) {
  if (typeof options.cdnFetch !== 'function') return undefined
  const hosts = (build.fields.get('CDN Hosts') ?? '').split(/\s+/u).filter(Boolean)
  const path = (build.fields.get('CDN Path') ?? '').trim().replace(/^\/+|\/+$/gu, '')
  if (hosts.length === 0 || path.length === 0) return undefined
  const archives = typeof options.cdnArchives === 'function' && build.cdnKey
    ? options.cdnArchives({ source, dataRoot, cdnKey: build.cdnKey })
    : undefined
  return Object.freeze({
    hosts: Object.freeze(hosts),
    path,
    fetch: options.cdnFetch,
    ...(archives === undefined ? {} : { locate: (key, signal) => archives.locate(key, signal) }),
    ...(options.cdnCache === undefined ? {} : { cache: options.cdnCache }),
  })
}

async function parseRoot(rootBytes, rootConfigName, config, encoding, storage, signal, wowLocale, wowListfile) {
  throwIfCancelled(signal)
  if (isWowRoot(rootBytes)) {
    const listfile = wowListfile === undefined ? undefined : parseWowListfile(await wowListfile.load())
    return Object.freeze({ nameDb: wowNameDb(rootBytes, wowLocale, encoding, listfile), rootFormat: 'wow' })
  }
  if (isTvfsRoot(rootBytes)) {
    const directoryEncodingKeys = new Set()
    for (const name of config.values.keys()) {
      if (!/^vfs-\d+$/iu.test(name)) continue
      const pair = config.getKeyPair(name)
      if (pair !== undefined) {
        directoryEncodingKeys.add(encoding.getEncodingKey(pair.contentKey) ?? pair.encodingKey)
      }
    }
    return Object.freeze({
      nameDb: await TvfsNameDb.parse(rootBytes, {
        directoryEncodingKeys,
        readEncodingKey: key => storage.readEncodingKey(key, signal),
      }),
      rootFormat: 'tvfs',
    })
  }
  if (isDiablo3Root(rootBytes)) {
    const readContentKey = async contentKey => {
      const key = encoding.getEncodingKey(contentKey)
      if (key === undefined) {
        throw cascError(
          'x3.casc/encoding-key-not-found',
          'Diablo III root content key is missing from encoding',
          { contentKey },
        )
      }
      return storage.readEncodingKey(key, signal)
    }
    return Object.freeze({
      nameDb: await Diablo3NameDb.parse(rootBytes, readContentKey),
      rootFormat: 'diablo3',
    })
  }
  if (isStarcraft1TextRoot(rootBytes)) {
    return Object.freeze({
      nameDb: Starcraft1NameDb.parse(rootBytes),
      rootFormat: 'starcraft1-text',
    })
  }
  try {
    // On Node's main thread (a content source in the extension host) the ~1 s parse would stall
    // every extension, so it runs in a worker thread there; a failed thread parses in place.
    const nameDb = (await onNodeMainThread())
      ? await parseMndxInThread(rootBytes).catch(() => MndxNameDb.parse(rootBytes))
      : MndxNameDb.parse(rootBytes)
    return Object.freeze({ nameDb, rootFormat: 'mndx' })
  } catch (cause) {
    throw cascError('x3.casc/root-format-unsupported', 'CASC root format is unsupported', {
      rootConfigName,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export class CascReader {
  constructor(storage, encoding, nameDb, entryIndex, rootContentKey, rootFormat, options) {
    this.storage = storage
    this.encoding = encoding
    this.nameDb = nameDb
    this.entryIndex = entryIndex
    this.rootContentKey = rootContentKey
    this.rootFormat = rootFormat
    /** WoW only: FileDataID → index row, so `filedataid/<id>` reads a file the listfile named. */
    this.fileDataRows = rootFormat === 'wow' ? wowFileDataRows(nameDb) : undefined
    /** The install's data directory the storage was read from (`SC2Data`, `HeroesData`, `Data`). */
    this.dataDir = options.dataDir
    this.pathAliases = options.aliases ? createCascPathAliases(options.aliases) : new Map()
    this.prefixes = (options.prefixes ?? []).map(normalizeCascPrefix).filter(Boolean)
  }

  static async open(source, optionsOrSignal) {
    const options = optionsFrom(optionsOrSignal)
    const signal = options.signal
    throwIfCancelled(signal)
    const installRoot = options.installRoot ?? ''
    const dataDir = options.dataDir ?? (await detectCascDataDirectory(source, installRoot, options.product))
    throwIfCancelled(signal)
    const { build, config, dataRoot } = await readActiveBuildConfig(source, installRoot, dataDir, options.product)
    const cdn = cdnFrom(build, options, source, dataRoot)
    const storage = await CascStorage.open(source, dataRoot, config, {
      signal,
      maxIndexFiles: options.maxIndexFiles ?? CASC_LIMITS.maxIndexFiles,
      maxIndexBytes: options.maxIndexBytes ?? CASC_LIMITS.maxIndexBytes,
      maxContainerReadBytes:
        options.maxContainerReadBytes ?? CASC_LIMITS.maxContainerReadBytes,
      maxDecodedBytes: options.maxDecodedBytes ?? CASC_LIMITS.maxDecodedBytes,
      ...(options.inflateZlib === undefined ? {} : { inflateZlib: options.inflateZlib }),
      ...(cdn === undefined ? {} : { cdn }),
      ...(options.encryptionKeys === undefined ? {} : { encryptionKeys: options.encryptionKeys }),
    })
    try {
      const encodingPair = config.getKeyPair('encoding')
      if (encodingPair === undefined) {
        throw cascError('x3.casc/build-config-invalid', 'CASC build config has no encoding entry')
      }
      const encodingBytes = await storage.readDecodedPrefix(encodingPair.encodingKey, encodingPagesEnd, signal)
      const encoding = parseEncodingTable(encodingBytes)
      throwIfCancelled(signal)

      // World of Warcraft keeps its game files in `root` by FileDataID; its `vfs-root` holds only
      // the client's own files beside the storage.
      const product = cascProductOf(build)
      const wowLocale = product.startsWith('wow') ? textLocaleOf(build) : undefined
      const rootConfigName =
        wowLocale !== undefined || config.getKeyPair('vfs-root') === undefined ? 'root' : 'vfs-root'
      const rootPair = config.getKeyPair(rootConfigName)
      if (rootPair === undefined) {
        throw cascError('x3.casc/root-missing', 'CASC build config has no supported root entry')
      }

      // `rootCache` may be chosen per game: a function of the `.build.info` product (`s2`, `d3`…).
      const rootCache =
        typeof options.rootCache === 'function' ? options.rootCache(product) : options.rootCache
      let parsed =
        rootCache === undefined ? undefined : await cachedRoot(rootCache, rootPair.contentKey, wowLocale, options.wowListfile)
      if (parsed === undefined) {
        const rootEncodingKey =
          encoding.getEncodingKey(rootPair.contentKey) ?? rootPair.encodingKey
        const rootBytes = await storage.readEncodingKey(rootEncodingKey, signal)
        parsed = await parseRoot(
          rootBytes,
          rootConfigName,
          config,
          encoding,
          storage,
          signal,
          wowLocale,
          options.wowListfile,
        )
        if (rootCache !== undefined) {
          await cacheRoot(rootCache, rootPair.contentKey, parsed, encoding, wowLocale, options.wowListfile)
        }
      }

      const maxEntries = options.maxEntries ?? CASC_LIMITS.maxEntries
      if (parsed.nameDb.size > maxEntries) {
        throw cascError('x3.casc/entry-budget-exceeded', 'CASC root exceeds its entry budget', {
          entries: parsed.nameDb.size,
          maxEntries,
        })
      }
      const reader = new CascReader(
        storage,
        encoding,
        parsed.nameDb,
        entryIndexFor(parsed.nameDb, encoding),
        rootPair.contentKey,
        parsed.rootFormat,
        { ...options, dataDir },
      )
      // The build's root cache also keeps which of its files are local (`localRows`).
      reader.localRowsCache = rootCache
      return reader
    } catch (error) {
      await storage.close().catch(() => undefined)
      throw error
    }
  }

  close() {
    return this.storage.close()
  }

  /**
   * One byte per row of `entryIndex`, 1 where the file's bytes are in the local data files. A
   * partial installation names every locale's files but stores only its own (StarCraft II with
   * enUS only: 454k of 667k names). Computed once, on first use, and kept on disk by the build's
   * root cache keyed by the local indexes (a locale installed between windows is a miss). About
   * 2.5 s for StarCraft II, in slices that give the thread back between them.
   */
  localRows() {
    this.localRowsPromise ??= this.cachedLocalRows()
    return this.localRowsPromise
  }

  /** Test one root-index row without starting a full availability scan or fetching CDN bytes. */
  localRow(row) {
    const index = this.entryIndex
    if (!Number.isSafeInteger(row) || row < 0 || row >= index.size)
      throw new RangeError('CASC local row is outside the root index')
    const keyColumn = index instanceof CascPathIndex && this.encoding.contentKeyLength === 16
      ? index.contentKeys : undefined
    return localRowAt(this, index, row, keyColumn, this.encoding.encodingKeyLength)
  }

  /**
   * `computeLocalRows` kept beside the build's name index: the record carries the local indexes'
   * fingerprint (`CascStorage.indexFingerprint`), so an installed or removed locale — new index
   * versions — recomputes it. Any failure to read or write the record only costs the computation.
   */
  async cachedLocalRows() {
    const cache = this.localRowsCache
    const fingerprint = this.storage.indexFingerprint
    if (cache === undefined || typeof fingerprint !== 'string' || typeof this.rootContentKey !== 'string')
      return this.computeLocalRows()
    const header = new TextEncoder().encode(fingerprint)
    const held = await cache.load(this.rootContentKey, 'local-rows').catch(() => undefined)
    if (held !== undefined && held.byteLength === 4 + header.byteLength + this.entryIndex.size) {
      const length = new DataView(held.buffer, held.byteOffset, 4).getUint32(0, true)
      const recorded = held.subarray(4, 4 + length)
      if (length === header.byteLength && recorded.every((byte, index) => byte === header[index]))
        return held.slice(4 + length)
    }
    const rows = await this.computeLocalRows()
    const record = new Uint8Array(4 + header.byteLength + rows.byteLength)
    new DataView(record.buffer).setUint32(0, header.byteLength, true)
    record.set(header, 4)
    record.set(rows, 4 + header.byteLength)
    await cache.store(this.rootContentKey, record, 'local-rows').catch(() => undefined)
    return rows
  }

  async computeLocalRows() {
    const index = this.entryIndex
    const rows = new Uint8Array(index.size)
    const encoding = this.encoding
    const keyColumn = index instanceof CascPathIndex && encoding.contentKeyLength === 16
      ? index.contentKeys : undefined
    const width = encoding.encodingKeyLength
    for (let start = 0; start < rows.length; start += LOCAL_ROWS_SLICE) {
      if (start > 0) await new Promise(resolve => setTimeout(resolve, 0))
      const end = Math.min(rows.length, start + LOCAL_ROWS_SLICE)
      for (let row = start; row < end; row++) {
        if (localRowAt(this, index, row, keyColumn, width)) rows[row] = 1
      }
    }
    return rows
  }

  pathCandidates(path) {
    const normalized = normalizeCascPath(path)
    const aliased = this.pathAliases.get(normalized) ?? normalized
    return Object.freeze([...this.prefixes.map(prefix => `${prefix}\\${aliased}`), aliased])
  }

  resolveFile(path) {
    const id = this.fileDataRows === undefined ? undefined : FILE_DATA_ID.exec(normalizeCascPath(path))?.[1]
    if (id !== undefined) {
      const rows = this.fileDataRows
      const wanted = Number(id) * 4194304
      let low = 0
      let high = rows.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (rows[middle] < wanted) low = middle + 1
        else high = middle
      }
      if (low < rows.length && Math.floor(rows[low] / 4194304) === Number(id)) return this.nameDb.fileAt(rows[low] % 4194304)
    }
    for (const candidate of this.pathCandidates(path)) {
      const file = this.nameDb.getByPath(candidate)
      if (file !== undefined) return file
    }
    return undefined
  }

  contentSizeOf(path) {
    const file = this.resolveFile(path)
    return file === undefined
      ? undefined
      : (file.contentSize ?? this.encoding.get(file.contentKey)?.size)
  }

  hasEncodingKey(encodingKey) {
    return this.storage.hasEncodingKey(encodingKey)
  }

  resolveContentKey(contentKey) {
    return this.encoding.getEncodingKey(contentKey)
  }

  hasContentKey(contentKey) {
    const encodingKey = this.resolveContentKey(contentKey)
    return encodingKey !== undefined && this.hasEncodingKey(encodingKey)
  }

  async readEncodingKey(encodingKey, signal) {
    return this.storage.readEncodingKey(encodingKey, signal)
  }

  async readContentKey(contentKey, signal) {
    const encodingKey = this.resolveContentKey(contentKey)
    if (encodingKey === undefined) {
      throw cascError('x3.casc/encoding-key-not-found', 'CASC content key has no encoding key', {
        contentKey,
      })
    }
    return this.readEncodingKey(encodingKey, signal)
  }

  async readPath(path, signal) {
    throwIfCancelled(signal)
    const file = this.resolveFile(path)
    if (file === undefined) {
      throw cascError('x3.casc/entry-not-found', 'CASC entry does not exist', { path })
    }
    if (Array.isArray(file.encodingKeys) && file.encodingKeys.length > 1) {
      throw cascError(
        'x3.casc/tvfs-multi-span-unsupported',
        'CASC TVFS multi-span reads are not supported',
        { path, spans: file.encodingKeys.length },
      )
    }
    const contentSize = this.contentSizeOf(path)
    if (contentSize !== undefined && contentSize > CASC_LIMITS.maxExtractBytes) {
      throw cascError(
        'x3.casc/extract-byte-budget-exceeded',
        'CASC entry exceeds extraction budget',
        { path, bytes: contentSize, maxExtractBytes: CASC_LIMITS.maxExtractBytes },
      )
    }
    const encodingKey = file.encodingKey ?? this.encoding.getEncodingKey(file.contentKey)
    if (encodingKey === undefined) {
      throw cascError('x3.casc/encoding-key-not-found', 'CASC entry has no encoding key', { path })
    }
    const bytes = await this.storage.readEncodingKey(encodingKey, signal)
    if (bytes.byteLength > CASC_LIMITS.maxExtractBytes) {
      throw cascError(
        'x3.casc/extract-byte-budget-exceeded',
        'CASC extraction exceeded its budget',
        { path, bytes: bytes.byteLength, maxExtractBytes: CASC_LIMITS.maxExtractBytes },
      )
    }
    return bytes
  }

  hasPath(path) {
    const file = this.resolveFile(path)
    if (file === undefined || (file.encodingKeys?.length ?? 1) > 1) return false
    const encodingKey = file.encodingKey ?? this.encoding.getEncodingKey(file.contentKey)
    return encodingKey !== undefined && this.storage.hasEncodingKey(encodingKey)
  }

  hasPrefix(path) {
    return this.pathCandidates(path).some(candidate => this.nameDb.hasPrefix(candidate))
  }

  listPaths(path = '') {
    const result = new Set()
    for (const candidate of this.pathCandidates(path)) {
      for (const relative of this.nameDb.listPaths(candidate)) result.add(portable(relative))
    }
    return [...result].sort()
  }

  getEncodingEntryCount() {
    return this.encoding.size
  }

  getFileCount() {
    return this.nameDb.size
  }

  getBuildConfigValue(name) {
    return this.storage.config.get(name)
  }
}
