import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { indexCacheEnabled, type IndexCacheSwitches } from '@modkit/sdk'
import type { CascReader } from '@modkit/blizzard-casc'
import { installationBuild, openCascInstallation } from '@modkit/blizzard-casc/installation-node'
import { SC2_BUILTIN_PACKAGE_DEPENDENCIES, sc2BuiltinDocumentInfo } from '../../../mod/shared/workspace/implicit-dependencies.js'
import { entry, parts, sorted, MAX_FILE, type LocalEntry, type LocalFilesPage, type LocalFilesQuery, type LocalSource,
  type LocalSourceRoot } from './local-files.js'

/** What of the storage this source shows: the packages, as the installation folder shows its own. */
const TOP_LEVEL = new Map([['mods', 'Mods'], ['campaigns', 'Campaigns']])
/** Rows one `files` page may scan before it answers, so a search over 666k names stays cancellable. */
const FILES_SCAN_BUDGET = 100_000
const encoder = new TextEncoder()
// Source revisions include projected metadata, so an older persisted file index cannot hide it.
const STOCK_METADATA_REVISION = createHash('sha256')
  .update(Object.keys(SC2_BUILTIN_PACKAGE_DEPENDENCIES).map(path => sc2BuiltinDocumentInfo(path)).join(''))
  .digest('hex')

/**
 * Where the name index is kept between windows. `directory`: the host's shared index cache directory
 * (the codec keeps the same installation's index in the same folder), or this source's own. `legacy`:
 * where the index lay before the shared one, removed on first use. `switches`: the user's index
 * cache switches per product (`modkit.indexCaches`); a product whose names are off keeps no index.
 */
export interface CascIndexCache {
  readonly directory: string
  readonly legacy?: string
  readonly switches?: IndexCacheSwitches
}

/** The first row from `at` before `end` whose bytes are installed (any row without `local`), or `end`. */
function nextLocal(local: Uint8Array | undefined, at: number, end: number): number {
  while (local !== undefined && at < end && local[at] !== 1) at++
  return at
}

/** Whether `needle` occurs in `bytes[from..to)` in order, not necessarily together. */
function inOrder(bytes: Uint8Array, from: number, to: number, needle: Uint8Array): boolean {
  let at = 0
  for (let i = from; i < to && at < needle.length; i++) if (bytes[i] === needle[at]) at++
  return at === needle.length
}

/**
 * Whether the name ending at `to` has one of `extensions` (lower-case, no dot; empty is none). One
 * set lookup: a text search asks for every extension VS Code knows as a language — over three
 * hundred — and comparing each name with each of them cost seconds over 655k names.
 */
function hasExtension(bytes: Uint8Array, from: number, to: number, extensions: ReadonlySet<string>): boolean {
  let dot = to - 1
  while (dot >= from && bytes[dot] !== 0x2e && bytes[dot] !== 0x2f) dot--
  const start = dot >= from && bytes[dot] === 0x2e ? dot + 1 : to
  if (to - start > 32) return false
  let extension = ''
  for (let i = start; i < to; i++) extension += String.fromCharCode(bytes[i]!)
  return extensions.has(extension)
}

/**
 * The stock packages of an installed StarCraft II — `Mods/Core.SC2Mod`, Liberty and the rest — which
 * the game keeps in its CASC storage rather than in the `Mods` folder beside user mods.
 *
 * The storage is opened on first use and kept: indexing it costs seconds, and every map and mod
 * resolves Core through it. With a cache directory the parsed name index is kept between windows
 * (~2 s of MNDX parsing becomes a ~0.2 s file read until the game updates).
 * Online package metadata checks only the selected package's rows until a local file is found;
 * online scoped installed-file searches check only matching rows; offline listings and broad searches
 * share the full local-availability bitmap.
 */
export class Sc2CascSource implements LocalSource {
  private reader: Promise<CascReader> | undefined
  /**
   * `online` (the default): a file the install names but does not hold (another locale, content
   * not yet streamed in) is listed and read from Blizzard's CDN, once, into the cache directory;
   * workspace search still walks only installed files, so a text search downloads nothing. Offline
   * such files are not listed at all.
   */
  constructor(private readonly installation: string, private readonly cache?: CascIndexCache,
    private readonly online = true) {
    if (!isAbsolute(installation)) throw new Error('Local source root must be absolute')
  }
  /** The rows a listing shows: offline only names whose bytes are installed, online every name. */
  private async listedRows(reader: CascReader): Promise<Uint8Array | undefined> {
    return this.online ? undefined : reader.localRows()
  }
  /**
   * Opening the installation as a container is answered with this root: one reader per window.
   * `revision` (the build key) and `product` come from `.build.info` each time, so a game update
   * shows as a new revision to the index caches that key by it.
   */
  get root(): LocalSourceRoot {
    const build = installationBuild(this.installation)
    return { id: 'local:casc', label: 'StarCraft II — CASC', kind: 'local', region: 'local', storageOf: this.installation,
      game: 'starcraft2', ...(build === undefined ? {} : { revision: `${build.buildKey}:${STOCK_METADATA_REVISION}`, product: build.product }) }
  }
  private open(): Promise<CascReader> {
    if (this.reader === undefined) {
      const cache = this.cache
      const opening = openCascInstallation(this.installation, cache === undefined ? undefined : {
        directory: cache.directory,
        ...(cache.legacy === undefined ? {} : { legacy: cache.legacy }),
        names: product => indexCacheEnabled(cache.switches, product, 'names'),
      }, { online: this.online })
      // A refused open is not kept: the game may be repaired or finish updating.
      opening.catch(() => { if (this.reader === opening) this.reader = undefined })
      // Offline listings need the whole bitmap; online metadata/navigation must not wait for it.
      if (!this.online) opening.then(reader => reader.localRows()).catch(() => undefined)
      this.reader = opening
    }
    return this.reader
  }
  /** Missing stock metadata is a file of the source; real metadata always takes precedence. */
  private async documents(reader: CascReader, path: string): Promise<LocalFilesPage['items']> {
    const prefix = path === '' ? '' : `${path.toLowerCase()}/`
    const index = reader.entryIndex
    return Object.keys(SC2_BUILTIN_PACKAGE_DEPENDENCIES).flatMap(packagePath => {
      const file = `${packagePath}/DocumentInfo`
      if (!file.toLowerCase().startsWith(prefix) || reader.contentSizeOf(file) !== undefined) return []
      const packagePrefix = `${packagePath}/`
      // A known name alone does not manufacture an uninstalled package.
      const end = index.lowerBound(`${packagePrefix}￿`)
      let local = false
      for (let row = index.lowerBound(packagePrefix); row < end && !local; row++) local = reader.localRow(row)
      if (!local) return []
      const text = sc2BuiltinDocumentInfo(packagePath)
      return text === undefined ? [] : [{ path: file, size: encoder.encode(text).byteLength }]
    })
  }
  async list(path: string): Promise<LocalEntry[]> {
    const names = parts(path)
    if (names.length > 0 && !TOP_LEVEL.has(names[0]!.toLowerCase())) throw new Error('Select Mods or Campaigns')
    const reader = await this.open()
    const index = reader.entryIndex, local = await this.listedRows(reader)
    const prefix = names.length === 0 ? '' : `${names.join('/').toLowerCase()}/`
    const end = index.lowerBound(`${prefix}￿`)
    const found: LocalEntry[] = []
    // Keys are sorted, so each child directory is skipped past in one jump. Offline only names whose
    // bytes are installed are shown: a partial install names every locale's files (enUS only: 454k
    // of 667k), and a folder holding none of its own is not shown either.
    for (let at = nextLocal(local, index.lowerBound(prefix), end); at < end;) {
      const tail = index.keyAt(at).slice(prefix.length), slash = tail.indexOf('/')
      const name = slash === -1 ? tail : tail.slice(0, slash)
      const shown = names.length > 0 ? name : TOP_LEVEL.get(name)
      if (shown !== undefined) {
        found.push(entry([path, shown].filter(Boolean).join('/'), slash !== -1,
          slash === -1 ? index.contentSizeAt(at) : undefined))
      }
      at = nextLocal(local, slash === -1 ? at + 1 : index.lowerBound(`${prefix}${name}/￿`), end)
    }
    if (names.length === 2) {
      for (const document of await this.documents(reader, path)) {
        found.push(entry(`${path}/DocumentInfo`, false, document.size))
      }
    }
    if (names.length > 0 && found.length === 0) throw new Error('CASC directory was not found')
    return sorted(found)
  }
  /**
   * A package's files (or a folder's within one) for the mod loader, straight from the name index:
   * the rows `list` shows — online every name, offline only installed ones — under one sorted range,
   * plus the virtual DocumentInfo `list` adds at package level. The same names, spelled the same, as
   * walking `list` folder by folder, without a call and an entry object per folder (Liberty: 179k
   * names, a walk ~1.5 s, one pass ~0.3 s). Above package level the loader walks `list` as before.
   */
  async listFiles(path: string): Promise<string[] | undefined> {
    const names = parts(path)
    if (names.length < 2) return undefined
    if (!TOP_LEVEL.has(names[0]!.toLowerCase())) throw new Error('Select Mods or Campaigns')
    const reader = await this.open()
    const index = reader.entryIndex, local = await this.listedRows(reader)
    const prefix = `${names.join('/').toLowerCase()}/`
    const files: string[] = []
    for (let at = index.lowerBound(prefix), end = index.lowerBound(`${prefix}￿`); at < end; at++) {
      if (local === undefined || local[at] === 1) files.push(index.keyAt(at).slice(prefix.length))
    }
    if (names.length === 2) {
      for (const document of await this.documents(reader, path)) files.push(document.path.slice(path.length + 1))
    }
    if (files.length === 0) throw new Error('CASC directory was not found')
    return files
  }
  /**
   * Files beneath `path` for a workspace search, straight from the name index. Rows are sorted, so
   * a folder is one range of them, and a row the query rules out is judged on its bytes alone.
   * Online, a package's page checks local availability after its filters, without scanning other mods.
   */
  async files(path: string, query: LocalFilesQuery): Promise<LocalFilesPage> {
    const names = parts(path)
    if (names.length > 0 && !TOP_LEVEL.has(names[0]!.toLowerCase())) throw new Error('Select Mods or Campaigns')
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('Invalid file page limit')
    const reader = await this.open()
    const index = reader.entryIndex
    const local = !this.online || names.length < 2 ? await reader.localRows() : undefined
    // Under the root this source shows Mods and Campaigns: each one range of the sorted keys.
    const prefixes = names.length === 0 ? [...TOP_LEVEL.keys()].sort().map(key => `${key}/`)
      : [`${names.join('/').toLowerCase()}/`]
    const ranges = prefixes.map(prefix => ({ prefix, start: index.lowerBound(prefix), end: index.lowerBound(`${prefix}￿`) }))
    const shown = (prefix: string, key: string) => names.length > 0 ? `${path}/${key.slice(prefix.length)}`
      : `${TOP_LEVEL.get(prefix.slice(0, -1))}/${key.slice(prefix.length)}`
    const pattern = encoder.encode((query.pattern ?? '').replace(/\s+/gu, '').replaceAll('\\', '/').toLowerCase())
    const extensions = query.extensions === undefined ? undefined : new Set(query.extensions.map(extension => extension.toLowerCase()))
    const virtualPage = async (offset: number, items: LocalFilesPage['items']): Promise<LocalFilesPage> => {
      const documents = (await this.documents(reader, path)).filter(document => {
        const bytes = encoder.encode(document.path.toLowerCase())
        return (extensions === undefined || extensions.has('')) &&
          (pattern.length === 0 || inOrder(bytes, 0, bytes.length, pattern))
      })
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > documents.length) throw new Error('Invalid file cursor')
      const count = Math.min(query.limit - items.length, documents.length - offset)
      items.push(...documents.slice(offset, offset + count))
      return offset + count < documents.length ? { items, nextCursor: `virtual:${offset + count}` } : { items }
    }
    if (query.cursor?.startsWith('virtual:')) return virtualPage(Number(query.cursor.slice(8)), [])
    let row = query.cursor === undefined ? ranges[0]!.start : Number(query.cursor)
    if (!Number.isSafeInteger(row) || row < 0) throw new Error('Invalid file cursor')
    const items: LocalFilesPage['items'] = []
    let scanned = 0
    for (const range of ranges) {
      if (row >= range.end) continue
      row = Math.max(row, range.start)
      index.forEachKey(row, range.end, (bytes, from, to, at) => {
        row = at + 1
        if ((extensions === undefined || hasExtension(bytes, from, to, extensions)) &&
          (pattern.length === 0 || inOrder(bytes, from, to, pattern)) &&
          (local === undefined ? reader.localRow(at) : local[at] === 1)) {
          items.push({ path: shown(range.prefix, index.keyAt(at)), size: index.contentSizeAt(at) })
        }
        return items.length < query.limit && ++scanned < FILES_SCAN_BUDGET
      })
      if (items.length >= query.limit || scanned >= FILES_SCAN_BUDGET) break
    }
    return row < ranges.at(-1)!.end && (items.length >= query.limit || scanned >= FILES_SCAN_BUDGET)
      ? { items, nextCursor: String(row) } : virtualPage(0, items)
  }
  async read(path: string, maximum: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_FILE) throw new Error('Invalid preview limit')
    parts(path)
    const reader = await this.open(), size = reader.contentSizeOf(path)
    if (size === undefined) {
      const parent = path.slice(0, path.lastIndexOf('/'))
      const document = (await this.documents(reader, parent)).find(item => item.path.toLowerCase() === path.toLowerCase())
      const text = document === undefined ? undefined : sc2BuiltinDocumentInfo(parent)
      if (text === undefined) throw new Error('CASC file was not found')
      const bytes = encoder.encode(text)
      if (bytes.byteLength > maximum) throw new Error('CASC file exceeds the read limit')
      return bytes
    }
    if (size > maximum) throw new Error('CASC file exceeds the read limit')
    return reader.readPath(path)
  }
  async resolveLocalPath(): Promise<undefined> { return undefined }
  async refresh(): Promise<void> {}
  async dispose(): Promise<void> {
    const reader = this.reader
    this.reader = undefined
    await reader?.then(value => value.close(), () => undefined)
  }
}
