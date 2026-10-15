/** Stage a prepared, hash-bound package. Compiling game metadata is a separate responsibility. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink, rmdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { BattleNetPublishRequest, BattleNetPublishReceipt, BattleNetPublishRejection } from './publisher.js'
import { readBounded } from '../content-sources/local-files.js'

export interface PreparedPublicationManifest {
  schema: 1
  region: 'us' | 'eu' | 'kr'
  name: string
  locale: string
  kind: 'map' | 'mod'
  archiveSha256: string
  header: { file: string; sha256: string }
  locales: { file: string; sha256: string }[]
  visuals?: { file: string; sha256: string }[]
  /** Exact S2Map metadata emitted by the package compiler, except identity/privacy/lock fields. */
  metadata: Record<string, unknown>
  target: { mode: 'create' } | { mode: 'update'; id: number; expectedVersion: number }
  visibility: 'private' | 'public'
  locked: boolean
}
type Rpc = (method: string, signal: AbortSignal, payload: Record<string, unknown>, timeout?: number) => Promise<unknown>

export async function publishDesktopPackage(request: BattleNetPublishRequest, directory: string,
  identity: string, rpc: Rpc): Promise<BattleNetPublishReceipt | BattleNetPublishRejection> {
  if (!request.packagePath || !isAbsolute(request.packagePath)) {
    return { status: 'rejected', operationId: request.operationId, region: request.region,
      reason: 'A prepared .modkit-publish.json package is required; an archive alone has no compiled Battle.net metadata.' }
  }
  const raw = await readBounded(dirname(request.packagePath), basename(request.packagePath), 1024 * 1024)
  if (request.packageSha256 && createHash('sha256').update(raw).digest('hex') !== request.packageSha256) throw new Error('Prepared manifest changed after review')
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as PreparedPublicationManifest
  if (manifest.schema !== 1 || manifest.region !== request.region || manifest.kind !== request.kind ||
    manifest.name !== request.name || manifest.locale !== request.locale || manifest.archiveSha256 !== request.archiveSha256 ||
    !manifest.header || !Array.isArray(manifest.locales) || manifest.locales.length > 256 ||
    (manifest.visuals !== undefined && (!Array.isArray(manifest.visuals) || manifest.visuals.length > 256))) {
    throw new Error('Prepared package does not match the selected archive, name, locale, kind or region')
  }
  const base = await realpath(dirname(request.packagePath))
  const components: { usage: string; sha256: string; bytes: Uint8Array }[] = []
  let totalBytes = request.archiveBytes
  for (const [usage, entries] of [['s2mh', [manifest.header]], ['s2ml', manifest.locales], ['s2mv', manifest.visuals ?? []]] as const) {
    for (const item of entries) {
      request.signal.throwIfAborted()
      if (!item || typeof item.file !== 'string' || isAbsolute(item.file) || /[\u0000-\u001f:]/u.test(item.file) ||
        item.file.split(/[\\/]/u).some(part => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('Invalid prepared component')
      const path = await realpath(join(base, item.file))
      const rel = relative(base, path)
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Package component escapes its directory')
      const maximum = usage === 's2mh' ? 8 * 1024 * 1024 : usage === 's2mv' ? 16 * 1024 * 1024 : 1024 * 1024
      const bytes = await readBounded(base, rel.replaceAll('\\', '/'), maximum, item.sha256)
      totalBytes += bytes.length
      if (totalBytes > 256 * 1024 * 1024) throw new Error('Prepared package exceeds the total size limit')
      components.push({ usage, sha256: item.sha256, bytes })
    }
  }
  const scope = createHash('sha256').update(identity).digest('hex')
  const journalDirectory = join(directory, 'publications', scope)
  const stage = join(journalDirectory, `stage-${randomUUID()}`)
  await mkdir(stage, { recursive: true })
  const written: string[] = []
  try {
    // The immutable archive snapshot is copied in bounded chunks; no base64 archive travels over IPC.
    const { open } = await import('node:fs/promises')
    const archivePath = join(stage, 'archive.s2ma')
    const output = await open(archivePath, 'wx'); written.push(archivePath)
    try {
      for (let offset = 0; offset < request.archiveBytes;) {
        const bytes = await request.source.readAt(offset, Math.min(64 * 1024, request.archiveBytes - offset), request.signal)
        let used = 0
        while (used < bytes.length) { const result = await output.write(bytes, used, bytes.length - used); if (!result.bytesWritten) throw new Error('Cannot stage archive'); used += result.bytesWritten }
        offset += bytes.length
      }
      await output.sync()
    } finally { await output.close() }
    const files = []
    for (const [index, component] of components.entries()) {
      const file = `${index}.${component.usage}`
      const path = join(stage, file)
      await writeFile(path, component.bytes, { flag: 'wx' }); written.push(path)
      files.push({ file, usage: component.usage, sha256: component.sha256 })
    }
    const packageFile = join(stage, 'package.json')
    await writeFile(packageFile, JSON.stringify({ ...manifest, files, archiveFile: 'archive.s2ma', archiveBytes: request.archiveBytes,
      operationId: request.operationId, target: request.target, visibility: request.visibility, locked: request.locked,
      ...(request.description === undefined ? {} : { description: request.description }) }), { flag: 'wx' })
    written.push(packageFile)
    request.signal.throwIfAborted()
    request.onProgress({ stage: 'allocating' })
    return await rpc('publish', request.signal, { packageFile, journalDirectory }, 30 * 60_000) as BattleNetPublishReceipt | BattleNetPublishRejection
  } finally {
    // Native worker termination is awaited by RPC cancellation before its staged inputs are removed.
    await Promise.all(written.map(path => unlink(path).catch(() => undefined)))
    await rmdir(stage).catch(() => undefined)
  }
}
