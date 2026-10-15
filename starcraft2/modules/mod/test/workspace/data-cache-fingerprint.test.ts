/** Transient code-read failures must not disable the saved Data cache for the process lifetime. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
