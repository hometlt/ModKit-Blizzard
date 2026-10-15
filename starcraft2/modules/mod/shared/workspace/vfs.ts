/**
 * The loader's file system: package readers registered by protocol (`file:`, `content-source0:`,
 * `loose0:`, …) and routed by `protocol:path`. The surface is exactly what `ModContextManager`
 * uses — list, read, text, existence and closing.
 * A transient loose chain may own a scope with a shared-source fallback. Its readers stay in
 * that scope, never the shared registry. Scope close leaves the fallback owned by its manager;
 * manager close revokes every scope. Existing normalization and read boundaries are unchanged.
 * Content-source readers can resolve a listed point read by directory; other readers preserve
 * the complete-list membership gate, including loose roots' virtual metadata.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** URI scheme including its trailing colon. */
export type Protocol = `${string}:`

/** One package's (or the disk's) files, addressed by paths relative to the reader. */
export interface BaseReader {
  /** Every file under a folder, recursively, as paths relative to it. */
  list(path: string): Promise<string[]>
  get(path: string): Promise<Uint8Array>
  /** Optional native-spelling lookup for one listed file under a root, without a recursive scan. */
  readListed?(root: string, filePath: string): Promise<Uint8Array | undefined>
  getText(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  close?(): Promise<void> | void
}

const PROTOCOL = /^([A-Za-z][A-Za-z0-9+.-]*:)(?:\/\/)?/u
const decoder = new TextDecoder()

/** A path with `.`/empty segments dropped and `..` applied; one that climbs out is refused. */
function normalize(inner: string, uri: string): string {
  const forward = inner.replace(/\\/gu, '/')
  const parts: string[] = []
  for (const part of forward.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) throw new Error(`Path escapes its VFS root: ${uri}`)
  }
  return `${forward.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

/** Routes `protocol:path` to the reader registered for that protocol. */
export class VirtualFileSystem {
  private readonly readers = new Map<string, BaseReader>()
  private closed = false

  /** Optional shared-source owner; this scope never closes the fallback's readers. */
  constructor(private readonly fallback?: VirtualFileSystem) {}

  /** Register a reader owned by this realm, retaining the existing reopen behavior. */
  register(protocol: Protocol, reader: BaseReader): this {
    this.closed = false
    this.readers.set(protocol.toLowerCase(), reader)
    return this
  }

  private route(uri: string): readonly [BaseReader, string] {
    this.assertOpen()
    const match = PROTOCOL.exec(uri)
    const reader = match === null ? undefined : this.readers.get((match[1] as string).toLowerCase())
    if (match !== null && reader === undefined && this.fallback !== undefined) return this.fallback.route(uri)
    if (match === null || reader === undefined) throw new Error(`No reader registered for ${uri}`)
    return [reader, normalize(uri.slice(match[0].length), uri)]
  }

  /** A manager's closed source realm also revokes routes owned by its loose scopes. */
  private assertOpen(): void {
    if (this.closed) throw new Error('Loader VFS is closed')
    this.fallback?.assertOpen()
  }

  list(uri: string): Promise<string[]> {
    const [reader, inner] = this.route(uri)
    return reader.list(inner)
  }
  get(uri: string): Promise<Uint8Array> {
    const [reader, inner] = this.route(uri)
    return reader.get(inner)
  }
  getText(uri: string): Promise<string> {
    const [reader, inner] = this.route(uri)
    return reader.getText(inner)
  }
  /** Read a member of this layer; preserve complete-list gating for readers without point lookup. */
  async readListed(uri: string, filePath: string): Promise<Uint8Array | undefined> {
    const [reader, root] = this.route(uri)
    if (reader.readListed !== undefined) return reader.readListed(root, filePath)
    const wanted = filePath.replace(/\\/gu, '/').replace(/^\/+/u, '').toLowerCase()
    const listed = (await reader.list(root)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .filter(file => file.toLowerCase() === wanted).at(-1)
    return listed === undefined ? undefined : reader.get(`${root.replace(/\/+$/u, '')}/${listed}`)
  }
  exists(uri: string): Promise<boolean> {
    const [reader, inner] = this.route(uri)
    return reader.exists(inner)
  }

  /** Close every reader; all are attempted, and the first failure is rethrown. */
  async close(): Promise<void> {
    this.closed = true
    const readers = [...this.readers.values()]
    this.readers.clear()
    const results = await Promise.allSettled(readers.map(async reader => reader.close?.()))
    const failed = results.find(result => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }
}

/** The host disk: paths are absolute (or relative to the working directory). */
export class FsReader implements BaseReader {
  async list(folder: string): Promise<string[]> {
    const root = path.resolve(folder)
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile())
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/gu, '/'))
      .sort((left, right) => left.localeCompare(right))
  }
  async get(file: string): Promise<Uint8Array> {
    const bytes = await fs.readFile(path.resolve(file))
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  async getText(file: string): Promise<string> {
    return decoder.decode(await this.get(file))
  }
  async exists(file: string): Promise<boolean> {
    return fs.stat(path.resolve(file)).then(() => true, () => false)
  }
}
