/** Shared existing MPQ owner: independent input/retention budgets, view lifetime and desktop wiring. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeFreshMpq } from '@modkit/blizzard-mpq/fresh-writer'
import { LocalArchives, Sc2FolderSource } from '../battlenet/content-sources/local-files.js'
import { Sc2DesktopContentSources } from '../battlenet/content-sources/local-content-sources.js'

const root = await mkdtemp(join(tmpdir(), 'sc2-shared-host-archives-'))
afterAll(async () => {
  const suffix = relative(resolve(tmpdir()), resolve(root))
  if (suffix.startsWith('..') || !suffix.startsWith('sc2-shared-host-archives-')) throw new Error('cleanup escaped fixture')
  await rm(root, { recursive: true, force: true })
})
/** Real native fixtures avoid bypassing the archive retention boundary. */
async function packed(directory: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const name = 'Mine.SC2Mod'
  await writeFile(join(directory, name), await encodeFreshMpq([{ path: 'DocumentInfo', bytes: new TextEncoder().encode('<DocInfo/>') },
    { path: 'Value.txt', bytes: new TextEncoder().encode(text) }]))
  return name
}

describe('shared host archives', () => {
  it('validates retention separately and preserves complete oversized results', async () => {
    for (const limit of [-1, 0.5, NaN, Infinity, 256 * 1024 * 1024 + 1]) expect(() => new LocalArchives(limit)).toThrow('retention')
    const directory = join(root, 'budget'), name = await packed(directory, 'complete')
    const warm = new LocalArchives(64 * 1024 * 1024), cold = new LocalArchives(0)
    try {
      await expect(warm.use(join(root, 'missing'), 'Missing.SC2Mod', undefined, () => 'must not run', () => { throw new Error('view closed') })).rejects.toThrow('view closed')
      const first = await warm.use(directory, name, undefined, reader => reader)
      expect(await warm.use(directory, name, undefined, reader => reader)).toBe(first)
      const zeroFirst = await cold.use(directory, name, undefined, reader => reader)
      expect(await cold.use(directory, name, undefined, reader => reader)).not.toBe(zeroFirst)
      const value = await cold.use(directory, name, undefined, async reader => reader.read(reader.entries.find(entry => entry.path === 'Value.txt')!.id))
      expect(new TextDecoder().decode(value)).toBe('complete')
    } finally { await warm.dispose(); await cold.dispose() }
  })

  it('keeps sibling views usable when one closes and serializes cache replacement', async () => {
    const one = join(root, 'one'), two = join(root, 'two'), name = await packed(one, 'one')
    await packed(two, 'two')
    const pool = new LocalArchives(64 * 1024 * 1024)
    const alpha = new Sc2FolderSource(one, 'one', 'one', undefined, pool), beta = new Sc2FolderSource(two, 'two', 'two', undefined, pool)
    try {
      const original = await alpha.read(`${name}/Value.txt`, 64)
      expect(new TextDecoder().decode(await beta.read(`${name}/Value.txt`, 64))).toBe('two')
      await alpha.dispose()
      expect(new TextDecoder().decode(original)).toBe('one')
      expect(new TextDecoder().decode(await beta.read(`${name}/Value.txt`, 64))).toBe('two')
      await expect(alpha.read(`${name}/Value.txt`, 64)).rejects.toThrow('closed')
      await pool.dispose()
      await expect(beta.read(`${name}/Value.txt`, 64)).rejects.toThrow('closed')
    } finally { await alpha.dispose(); await beta.dispose(); await pool.dispose() }
  })

  it('refuses a queued closed view without canceling its sibling', async () => {
    const one = join(root, 'queued-one'), two = join(root, 'queued-two'), name = await packed(one, 'one')
    await packed(two, 'two')
    const pool = new LocalArchives(), alpha = new Sc2FolderSource(one, 'one', 'one', undefined, pool), beta = new Sc2FolderSource(two, 'two', 'two', undefined, pool)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const first = pool.use(one, name, undefined, async () => { entered(); await gate; return 'active complete' })
    await started
    const use = vi.spyOn(pool, 'use')
    const queued = alpha.read(`${name}/Value.txt`, 64), refused = expect(queued).rejects.toThrow('closed')
    try {
      await vi.waitFor(() => expect(use.mock.calls.length).toBeGreaterThan(0), { timeout: 10000, interval: 5 })
      const closing = alpha.dispose(), sibling = beta.read(`${name}/Value.txt`, 64)
      release(); expect(await first).toBe('active complete')
      await refused; await closing
      expect(new TextDecoder().decode(await sibling)).toBe('two')
    } finally { release(); use.mockRestore(); await alpha.dispose(); await beta.dispose(); await pool.dispose() }
  })

  it('wires one cache for desktop contexts and releases it with their owner', async () => {
    const directory = join(root, 'desktop'), one = join(directory, 'one'), two = join(directory, 'two')
    const name = await packed(one, 'one'); await packed(two, 'two')
    const sources = new Sc2DesktopContentSources({ battleNetCacheDirectory: join(directory, 'bnet'), sc2MapsCacheDirectory: join(directory, 'map-cache'),
      documentsDirectory: join(directory, 'documents'), wizardDirectories: [], cascOnline: false })
    const use = vi.spyOn(LocalArchives.prototype, 'use'), disposed = vi.spyOn(LocalArchives.prototype, 'dispose')
    try {
      for (const [folder, text] of [[one, 'one'], [two, 'two']] as const) {
        const context = await sources.openModContext({ schemaVersion: 1, target: join(folder, name), sessionId: text, baseMods: [] })
        try { expect(new TextDecoder().decode(await context.read(context.layers.at(-1)!.id, 'Value.txt', 64))).toBe(text) } finally { await context.dispose() }
      }
      const owners = use.mock.contexts.filter((_owner, i) => [one, two].includes(use.mock.calls[i]![0]))
      expect(owners.length).toBeGreaterThan(1)
      expect(new Set(owners).size).toBe(1)
      await sources.dispose()
      expect(disposed.mock.contexts).toContain(owners[0])
    } finally { await sources.dispose(); use.mockRestore(); disposed.mockRestore() }
  })
})
