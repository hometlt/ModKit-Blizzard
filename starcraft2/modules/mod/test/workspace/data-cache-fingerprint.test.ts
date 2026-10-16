/** Transient code-read failures must not disable the saved Data cache for the process lifetime. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { serialize } from 'node:v8'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads = vi.hoisted(() => ({ failNext: false, failures: 0 }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) => {
    if (reads.failNext && String(args[0]).replaceAll('\\', '/').endsWith('/data-cache-node.ts')) {
      reads.failNext = false
      reads.failures++
      return Promise.reject(new Error('transient code read failed'))
    }
    return fs.readFile(...args)
  } }
})

describe('saved Data code fingerprint', () => {
  beforeEach(() => {
    // Each scenario starts with a cold module-owned code digest, independent of test ordering.
    vi.resetModules()
    reads.failNext = false
    reads.failures = 0
  })

  it('treats an old eager envelope as a miss and retries with the Data-owned stored format', async () => {
    const { createSc2DataCache } = await import('../../shared/workspace/data-cache-node.js')
    const directory = await mkdtemp(join(tmpdir(), 'modkit-data-envelope-'))
    try {
      const cache = createSc2DataCache({ directory })!
      const record = { catalogs: [], editorCategories: [], parses: [], bytes: 0 }
      await cache.save('envelope', record)
      const folder = join(directory, 'sc2-data')
      const name = (await readdir(folder)).find(file => file.endsWith('.v8'))!
      const file = join(folder, name)
      expect(await cache.load('envelope')).toEqual(record)
      await writeFile(file, serialize({ key: 'envelope', parseFormat: 1, record }))
      expect(await cache.load('envelope')).toBeUndefined()
      await cache.save('envelope', record)
      expect(await cache.load('envelope')).toEqual(record)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retries after a failed fingerprint and then reuses a saved record', async () => {
    const { createSc2DataCache } = await import('../../shared/workspace/data-cache-node.js')
    const directory = await mkdtemp(join(tmpdir(), 'modkit-data-fingerprint-'))
    try {
      const cache = createSc2DataCache({ directory })!
      const record = { catalogs: [], editorCategories: [], parses: [], bytes: 0 }
      reads.failNext = true
      expect(await cache.load('retry')).toBeUndefined()
      expect(reads.failures).toBe(1)
      await expect(cache.save('retry', record)).resolves.toBeUndefined()
      expect(await cache.load('retry')).toEqual(record)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
