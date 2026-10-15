import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createCascRootCache } from '../../src/casc/root-cache-node.js'

const log = { warn() {}, info() {} }

let base: string
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-stores-'))
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

describe('createCascRootCache — per-build layout', () => {
  it('stores + loads under <base>/<build>/index/mndx.bin', async () => {
    const cache = createCascRootCache(base, log)
    const key = 'ABCD1234' // build key (hex; sanitized to lower-case)
    const bytes = new Uint8Array([1, 2, 3, 4, 5])

    expect(await cache.load(key)).toBeUndefined()
    await cache.store(key, bytes)

    const onDisk = path.join(base, 'abcd1234', 'index', 'mndx.bin')
    expect(new Uint8Array(await fs.readFile(onDisk))).toEqual(bytes)

    const loaded = await cache.load(key)
    expect(loaded).toEqual(bytes)
  })

  it('prunes stale sibling build dirs on store', async () => {
    const cache = createCascRootCache(base, log)
    await cache.store('aaaa', new Uint8Array([1]))
    // A second build appears (game patch) — the old build dir is removed.
    await cache.store('bbbb', new Uint8Array([2]))

    const entries = await fs.readdir(base)
    expect(entries).toContain('bbbb')
    expect(entries).not.toContain('aaaa')
  })

  it('leaves non-build (non-hex) sibling entries untouched', async () => {
    await fs.mkdir(path.join(base, 'not-a-build'), { recursive: true })
    const cache = createCascRootCache(base, log)
    await cache.store('cccc', new Uint8Array([3]))
    const entries = await fs.readdir(base)
    expect(entries).toContain('not-a-build')
    expect(entries).toContain('cccc')
  })
})
