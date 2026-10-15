/**
 * SC2 desktop content source owner (modules/game): confined read-only folders, packed MPQ
 * maps/mods/campaigns and hash-named map-cache projections. Public LocalSource entries/reads,
 * bulk files, physical reveal, refresh/dispose use realpath/link refusal, bounded complete reads,
 * SHA guards and the existing MPQ reader. Hidden names and native DocumentInfo remain native.
 * LocalArchives serializes operations/eviction, retains one MPQ per owning cache, and keeps only a
 * completion barrier in its queue: returned action values belong to callers. Source dispose
 * drops hidden metadata and closes its archive; no writes, new parser, SDK/RPC or game dispatch.
 * Per-file64MiB/archive256MiB limits are independent of aggregate readers/model/heap/RSS budgets.
 */
import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { openMpqReader, type MpqReader } from '@modkit/blizzard-mpq/reader'
import { windowsHiddenPaths } from '@modkit/vfs/content-sources/node'
import { sc2BuiltinDocumentInfo } from '../../../mod/shared/workspace/implicit-dependencies.js'

export interface LocalEntry { path: string; name: string; directory: boolean; size?: number; hidden?: true }
export interface LocalSourceRoot { id: string; label: string; region: string; kind: 'local'; storageOf?: string
  /** For index caches (vfs `ContentSourceRoot`): what changes when the files may, the game product, and the game its caches group under. */
  revision?: string; product?: string; game?: string }
export interface LocalPath { path: string; kind: 'file' | 'directory' }
/** A workspace search's question to one source; see `ContentSources.files`. */
export interface LocalFilesQuery { pattern?: string; extensions?: readonly string[]; cursor?: string; limit: number }
export interface LocalFilesPage { items: { path: string; size?: number }[]; nextCursor?: string }
export interface LocalSource {
  root: LocalSourceRoot
  list(path: string): Promise<LocalEntry[]>
  read(path: string, maximum: number): Promise<Uint8Array>
  /** Files beneath `path` in bulk, when the source keeps them indexed. */
  files?(path: string, query: LocalFilesQuery): Promise<LocalFilesPage>
  /**
   * Every file beneath `path`, relative to it, exactly as walking `list` from there finds them, in
   * one pass over an index the source keeps; undefined where the source cannot answer (walk instead).
   */
  listFiles?(path: string): Promise<string[] | undefined>
  resolveLocalPath(path: string): Promise<LocalPath | undefined>
  refresh(): Promise<void>
  dispose(): Promise<void>
}
export const MAX_FILE = 64 * 1024 * 1024
const MAX_ARCHIVE = 256 * 1024 * 1024
export function parts(path: string): string[] {
  if (path === '') return []
  const result = path.split('/')
  if (path.length > 4096 || result.some(p => !p || p === '.' || p === '..' || /[\\:\u0000-\u001f]/u.test(p))) throw new Error('Invalid local source path')
  return result
}
export const entry = (path: string, directory: boolean, size?: number): LocalEntry => ({
  path, name: path.split('/').at(-1)!, directory, ...(size === undefined ? {} : { size }),
})
export const sorted = (items: LocalEntry[]) => items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
/** Only a package root gets stock metadata; nested directories never do. */
const stockDocumentInfo = (path: string) => /\.sc2(?:mod|campaign)$/iu.test(path) ? sc2BuiltinDocumentInfo(path) : undefined
const withDocumentInfo = (path: string, entries: LocalEntry[]): LocalEntry[] => {
  const text = stockDocumentInfo(path)
  if (text !== undefined && !entries.some(item => item.name.toLowerCase() === 'documentinfo')) {
    entries.push(entry(`${path}/DocumentInfo`, false, new TextEncoder().encode(text).byteLength))
  }
  return sorted(entries)
}
export async function confined(root: string, path: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error('Local source root must be absolute')
  const base = await realpath(root)
  let target = base
  for (const part of parts(path)) {
    target = join(target, part)
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Filesystem links are not followed by this source')
  }
  const resolved = await realpath(target), tail = relative(base, resolved)
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) throw new Error('Path leaves its local source')
  return resolved
}
export async function readBounded(root: string, path: string, maximum: number, hash?: string): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_ARCHIVE) throw new Error('Invalid read limit')
  const file = await open(await confined(root, path), 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Local file exceeds the read limit')
    const bytes = new Uint8Array(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Local file changed during reading')
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Local file changed during reading')
    if (hash && createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Local cache SHA-256 mismatch')
    return bytes
  } finally { await file.close() }
}
/** One retained MPQ per provider; operations/eviction are serialized so active reads cannot be disposed. */
export class LocalArchives {
  private current: { key: string; reader: MpqReader } | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  /** Retention is independent of archive admission; oversized active results remain complete. */
  constructor(private readonly maximumRetainedBytes = MAX_ARCHIVE) {
    if (!Number.isSafeInteger(maximumRetainedBytes) || maximumRetainedBytes < 0 || maximumRetainedBytes > MAX_ARCHIVE)
      throw new TypeError('Invalid archive retention limit')
  }
  /** Admit a live view before filesystem work, then run its action under the existing queue. */
  use<T>(root: string, path: string, hash: string | undefined, action: (reader: MpqReader) => Promise<T> | T, admit?: () => void): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.closed) throw new Error('Local source is closed')
      admit?.()
      const location = await confined(root, path), info = await lstat(location)
      const key = `${location}:${info.size}:${info.mtimeMs}:${hash ?? ''}`
      if (this.current?.key !== key) {
        this.current?.reader.dispose(); this.current = undefined
        const bytes = await readBounded(root, path, MAX_ARCHIVE, hash)
        const reader = await openMpqReader(bytes, { maxArchiveBytes: MAX_ARCHIVE, maxEntries: 100000, maxEntryBytes: MAX_FILE })
        this.current = { key, reader }
      }
      try { return await action(this.current.reader) }
      finally {
        if (this.current.reader.retainedBytes > this.maximumRetainedBytes) { this.current.reader.dispose(); this.current = undefined }
      }
    })
    this.queue = task.then(() => undefined, () => undefined); return task
  }
  /** Await the current operation barrier without dropping a shared owner's recoverable archive. */
  drain(): Promise<void> { return this.queue }
  async refresh(): Promise<void> { await this.drain(); this.current?.reader.dispose(); this.current = undefined }
  async dispose(): Promise<void> { this.closed = true; await this.refresh() }
}
export function archiveList(reader: MpqReader, base: string, inner: string): LocalEntry[] {
  const prefix = inner ? `${inner}/` : '', foldedPrefix = prefix.toLowerCase()
  const found = new Map<string, LocalEntry>()
  for (const file of reader.entries) {
    const path = file.path.replace(/\\/g, '/'); parts(path)
    if (!path.toLowerCase().startsWith(foldedPrefix)) continue
    const tail = path.slice(prefix.length), name = tail.split('/')[0]!
    if (!name) continue
    const directory = tail.includes('/'), target = [base, inner, name].filter(Boolean).join('/')
    const old = found.get(name)
    if (old && old.directory !== directory) throw new Error('Conflicting MPQ file and directory names')
    const item = entry(target, directory, directory ? undefined : file.size)
    // The reader marks the archive's own bookkeeping, which sits at its root.
    found.set(name, !directory && file.hidden === true ? { ...item, hidden: true } : item)
  }
  if (inner && !found.size) throw new Error('Archive directory was not found')
  return sorted([...found.values()])
}
export async function archiveRead(reader: MpqReader, inner: string, maximum: number): Promise<Uint8Array> {
  parts(inner)
  const folded = inner.toLowerCase()
  const file = reader.entries.find(item => item.path.replace(/\\/g, '/').toLowerCase() === folded)
  if (!file) throw new Error('Archive file was not found')
  if (file.size > maximum) throw new Error('Archive file exceeds the preview limit')
  const bytes = await reader.read(file.id)
  if (bytes.length > maximum) throw new Error('Archive file exceeds the preview limit')
  return bytes
}
/** Read-only folder source; packed maps/mods and loose package directories share one tree. */
export class Sc2FolderSource implements LocalSource {
  readonly root: LocalSourceRoot
  private readonly archives: LocalArchives
  private readonly ownsArchives: boolean
  private closed = false
  /** One hidden listing per requested installation directory; no scan of unrelated descendants. */
  private readonly hidden = new Map<string, Promise<ReadonlySet<string>>>()
  /** A supplied cache belongs to the content-source owner; closing this view leaves it usable. */
  constructor(private directory: string, id: string, label: string, private children?: readonly string[], sharedArchives?: LocalArchives) {
    if (!isAbsolute(directory)) throw new Error('Local source root must be absolute')
    this.root = { id, label, kind: 'local', region: 'local' }
    this.ownsArchives = sharedArchives === undefined
    this.archives = sharedArchives ?? new LocalArchives()
  }
  /** A queued view checks its own close state when the shared archive actually admits it. */
  private archive<T>(outer: string, action: (reader: MpqReader) => Promise<T> | T): Promise<T> {
    return this.archives.use(this.directory, outer, undefined, action, () => {
      if (this.closed) throw new Error('Local source is closed')
    })
  }
  private async locate(path: string) {
    if (this.closed) throw new Error('Local source is closed')
    const names = parts(path)
    if (this.children && names.length && !this.children.includes(names[0]!)) throw new Error('Select Maps or Mods')
    for (let count = 1; count <= names.length; count++) {
      const outer = names.slice(0, count).join('/'), absolute = await confined(this.directory, outer)
      const stat = await lstat(absolute)
      if (stat.isFile() && /\.SC2(?:Map|Mod|Campaign)$/iu.test(outer)) {
        return { outer, inner: names.slice(count).join('/'), archive: true, absolute }
      }
    }
    return { outer: path, inner: '', archive: false, absolute: await confined(this.directory, path) }
  }
  /** Keep whole-package listings; installation browsing reads shallow ancestors for inherited hidden flags. */
  private async hiddenPaths(path: string): Promise<ReadonlySet<string>> {
    const scope = this.children === undefined ? '' : path
    let pending = this.hidden.get(scope)
    if (pending === undefined) {
      const listing = windowsHiddenPaths(join(this.directory, scope), undefined,
        { recursive: this.children === undefined })
      const parentPath = scope.split('/').slice(0, -1).join('/')
      pending = scope === '' ? listing : Promise.all([this.hiddenPaths(parentPath), listing])
        .then(([parent, children]) => new Set([...parent, ...Array.from(children, name => `${scope}/${name}`)]))
      this.hidden.set(scope, pending)
    }
    return pending
  }
  async list(path: string): Promise<LocalEntry[]> {
    const location = await this.locate(path)
    if (location.archive) return this.archive(location.outer,
      reader => withDocumentInfo(path, archiveList(reader, location.outer, location.inner)))
    const entries = await readdir(location.absolute, { withFileTypes: true }), output: LocalEntry[] = []
    const hidden = await this.hiddenPaths(path)
    // Under a hidden folder everything is hidden, as the host's folder layers read it.
    const isHidden = (relativePath: string) => hidden.size > 0 &&
      relativePath.split('/').some((_, index, names) => hidden.has(names.slice(0, index + 1).join('/')))
    for (const item of entries) {
      if (item.isSymbolicLink() || (!path && this.children && !this.children.includes(item.name))) continue
      if (!item.isFile() && !item.isDirectory()) continue
      const relativePath = [path, item.name].filter(Boolean).join('/'); parts(relativePath)
      const directory = item.isDirectory() || /\.SC2(?:Map|Mod|Campaign)$/iu.test(item.name)
      const listed = entry(relativePath, directory, directory ? undefined : (await lstat(join(location.absolute, item.name))).size)
      output.push(isHidden(relativePath) ? { ...listed, hidden: true } : listed)
    }
    return withDocumentInfo(path, output)
  }
  async read(path: string, maximum: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_FILE) throw new Error('Invalid preview limit')
    const names = parts(path), parent = names.slice(0, -1).join('/')
    const text = names.at(-1)?.toLowerCase() === 'documentinfo' ? stockDocumentInfo(parent) : undefined
    if (text !== undefined) {
      const location = await this.locate(parent)
      const virtual = () => {
        const bytes = new TextEncoder().encode(text)
        if (bytes.byteLength > maximum) throw new Error('Local file exceeds the read limit')
        return bytes
      }
      if (location.archive) return this.archive(location.outer, reader =>
        reader.entries.some(item => item.path.replaceAll('\\', '/').toLowerCase() === 'documentinfo')
          ? archiveRead(reader, 'DocumentInfo', maximum) : virtual())
      const real = (await readdir(location.absolute)).find(name => name.toLowerCase() === 'documentinfo')
      return real === undefined ? virtual() : readBounded(this.directory, `${parent}/${real}`, maximum)
    }
    const location = await this.locate(path)
    return location.archive && location.inner
      ? this.archive(location.outer, reader => archiveRead(reader, location.inner, maximum))
      : readBounded(this.directory, path, maximum)
  }
  async resolveLocalPath(path: string): Promise<LocalPath> {
    const names = parts(path), parent = names.slice(0, -1).join('/')
    if (names.at(-1)?.toLowerCase() === 'documentinfo' && stockDocumentInfo(parent) !== undefined) {
      const packageLocation = await this.locate(parent)
      if (packageLocation.archive) return { path: packageLocation.absolute, kind: 'file' }
      const real = (await readdir(packageLocation.absolute)).find(name => name.toLowerCase() === 'documentinfo')
      if (real === undefined) return { path: packageLocation.absolute, kind: 'directory' }
    }
    const location = await this.locate(path)
    // Entries below a packed package are virtual. Reveal the package which owns them.
    if (location.archive) return { path: location.absolute, kind: 'file' }
    const stat = await lstat(location.absolute)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Local source target is not revealable')
    return { path: location.absolute, kind: stat.isDirectory() ? 'directory' : 'file' }
  }
  refresh() { this.hidden.clear(); return this.archives.refresh() }
  async dispose() {
    this.closed = true; this.hidden.clear()
    if (this.ownsArchives) await this.archives.dispose()
    else await this.archives.drain()
  }
}

/**
 * The SC2 map-data cache stores logical packages in hash-named `.s2ma` directories. This adapter
 * keeps those physical names private and projects stable `.SC2Map` / `.SC2Mod` names while every
 * operation still runs through the confined folder source.
 */
export class Sc2MapsCacheSource implements LocalSource {
  readonly root: LocalSourceRoot = {
    id: 'local:sc2-maps-cache',
    label: 'StarCraft II — кеш данных карт',
    kind: 'local',
    region: 'local',
  }
  private readonly folder: Sc2FolderSource
  private mapping: Promise<ReadonlyMap<string, string>> | undefined
  constructor(private directory: string, private labels: () => Promise<ReadonlyMap<string, string>>) {
    this.folder = new Sc2FolderSource(directory, this.root.id, this.root.label)
  }
  private names(): Promise<ReadonlyMap<string, string>> {
    this.mapping ??= this.buildNames()
    return this.mapping
  }
  private async buildNames(): Promise<ReadonlyMap<string, string>> {
    const known = await this.labels().catch(() => new Map<string, string>())
    const result = new Map<string, string>(), used = new Set<string>()
    for (const item of await this.folder.list('')) {
      const match = /^([a-f0-9]{64})\.s2ma$/iu.exec(item.name)
      let virtual = match === null
        ? item.name
        : known.get(item.name.toLowerCase()) ?? `Кеш карты [${match[1]!.slice(0, 16)}].SC2Map`
      if (used.has(virtual.toLowerCase())) {
        const extension = /\.SC2(?:Map|Mod|Campaign)$/iu.exec(virtual)?.[0] ?? '.SC2Map'
        virtual = `${virtual.slice(0, -extension.length)} [${match?.[1]?.slice(0, 12) ?? item.name}]${extension}`
      }
      used.add(virtual.toLowerCase())
      result.set(virtual, item.name)
    }
    return result
  }
  private async translate(path: string): Promise<{ virtual: string; physical: string }> {
    const names = parts(path)
    if (!names.length) return { virtual: '', physical: '' }
    const physical = (await this.names()).get(names[0]!)
    if (!physical) throw new Error('Cached map was not found')
    return { virtual: names[0]!, physical: [physical, ...names.slice(1)].join('/') }
  }
  private rewrite(item: LocalEntry, virtual: string, physical: string): LocalEntry {
    const path = item.path === physical
      ? virtual
      : `${virtual}${item.path.slice(physical.length)}`
    return { ...item, path, name: path.split('/').at(-1)! }
  }
  async list(path: string): Promise<LocalEntry[]> {
    if (path === '') {
      const mapping = await this.names(), rows = await this.folder.list('')
      const reverse = new Map([...mapping].map(([virtual, physical]) => [physical, virtual]))
      return sorted(rows.map(item => this.rewrite(item, reverse.get(item.name) ?? item.name, item.name)))
    }
    const translated = await this.translate(path)
    return (await this.folder.list(translated.physical)).map(item =>
      this.rewrite(item, translated.virtual, translated.physical.split('/')[0]!),
    )
  }
  async read(path: string, maximum: number): Promise<Uint8Array> {
    return this.folder.read((await this.translate(path)).physical, maximum)
  }
  async resolveLocalPath(path: string): Promise<LocalPath | undefined> {
    return this.folder.resolveLocalPath((await this.translate(path)).physical)
  }
  async refresh(): Promise<void> { this.mapping = undefined; await this.folder.refresh() }
  dispose(): Promise<void> { return this.folder.dispose() }
}
