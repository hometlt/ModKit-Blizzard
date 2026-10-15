import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { URI } from 'vscode-uri'
import type { GalaxyDocumentIndex, GalaxyIndexedDocument } from './document-source.js'

export interface GalaxyFileSystemIndexOptions {
  readonly maximumFiles?: number
  readonly maximumFileBytes?: number
  readonly maximumTotalBytes?: number
}

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist'])

/** Bounded filesystem adapter for the protocol-neutral Galaxy workspace document source. */
export class GalaxyFileSystemIndex implements GalaxyDocumentIndex {
  readonly documents = new Map<string, GalaxyIndexedDocument>()
  lazyFileCount = 0
  private roots: string[] = []
  private readonly skippedUris = new Set<string>()
  private readonly maximumFiles: number
  private readonly maximumFileBytes: number
  private readonly maximumTotalBytes: number

  constructor(options: GalaxyFileSystemIndexOptions = {}) {
    this.maximumFiles = Math.max(1, options.maximumFiles ?? 10_000)
    this.maximumFileBytes = Math.max(1, options.maximumFileBytes ?? 16 * 1024 * 1024)
    this.maximumTotalBytes = Math.max(1, options.maximumTotalBytes ?? 128 * 1024 * 1024)
  }

  getDocument(uri: string): GalaxyIndexedDocument | undefined {
    return this.documents.get(uri)
  }

  contains(uri: string): boolean {
    return this.documents.has(uri)
  }

  async setRoots(rootUris: readonly string[], signal?: AbortSignal): Promise<void> {
    // A root keeps the spelling the client gives it, the one its document URIs use: under the real
    // path, a file named through a junction or an 8.3 short name was no longer inside any root and
    // `refresh` ignored its changes. The real path only merges roots that are one directory.
    const paths: string[] = []
    const realPaths = new Set<string>()
    for (const uri of rootUris) {
      signal?.throwIfAborted()
      if (URI.parse(uri).scheme !== 'file') continue
      const path = resolve(URI.parse(uri).fsPath)
      const real = await realpath(path).catch(() => undefined)
      if (real === undefined || realPaths.has(real)) continue
      realPaths.add(real)
      paths.push(path)
    }
    this.roots = paths.sort((left, right) => left.localeCompare(right))
    await this.rescan(signal)
  }

  async rescan(signal?: AbortSignal): Promise<void> {
    const next = new Map<string, GalaxyIndexedDocument>()
    let totalBytes = 0
    const skipped = new Set<string>()
    const visit = async (directory: string): Promise<void> => {
      signal?.throwIfAborted()
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        signal?.throwIfAborted()
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path)
          continue
        }
        if (!entry.isFile() || extname(entry.name).toLocaleLowerCase() !== '.galaxy') continue
        if (next.size >= this.maximumFiles) {
          skipped.add(URI.file(path).toString())
          continue
        }
        const info = await stat(path).catch(() => undefined)
        if (info === undefined || info.size > this.maximumFileBytes ||
            totalBytes + info.size > this.maximumTotalBytes) {
          skipped.add(URI.file(path).toString())
          continue
        }
        const text = await readFile(path, 'utf8').catch(() => undefined)
        if (text === undefined) {
          skipped.add(URI.file(path).toString())
          continue
        }
        totalBytes += Buffer.byteLength(text)
        const uri = URI.file(path).toString()
        next.set(uri, { fileName: uri, text })
      }
    }
    for (const root of this.roots) await visit(root)
    this.documents.clear()
    for (const [uri, item] of next) this.documents.set(uri, item)
    this.skippedUris.clear()
    for (const uri of skipped) this.skippedUris.add(uri)
    this.lazyFileCount = skipped.size
  }

  async refresh(uri: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const parsed = URI.parse(uri)
    if (parsed.scheme !== 'file' || extname(parsed.fsPath).toLocaleLowerCase() !== '.galaxy') return
    const absolute = resolve(parsed.fsPath)
    const owned = this.roots.some(root => {
      const child = relative(root, absolute)
      return child === '' || (!child.startsWith('..') && !isAbsolute(child))
    })
    if (!owned) return
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      this.documents.delete(uri)
      this.skippedUris.delete(uri)
      this.lazyFileCount = this.skippedUris.size
      return
    }
    const totalWithoutCurrent = [...this.documents.entries()].reduce(
      (total, [candidate, item]) => candidate === uri ? total : total + Buffer.byteLength(item.text),
      0,
    )
    if (info.size > this.maximumFileBytes || totalWithoutCurrent + info.size > this.maximumTotalBytes ||
        (!this.documents.has(uri) && this.documents.size >= this.maximumFiles)) {
      this.documents.delete(uri)
      this.skippedUris.add(uri)
      this.lazyFileCount = this.skippedUris.size
      return
    }
    const text = await readFile(absolute, 'utf8').catch(() => undefined)
    if (text === undefined) {
      this.documents.delete(uri)
      this.skippedUris.add(uri)
    } else {
      this.documents.set(uri, { fileName: uri, text })
      this.skippedUris.delete(uri)
    }
    this.lazyFileCount = this.skippedUris.size
  }
}
