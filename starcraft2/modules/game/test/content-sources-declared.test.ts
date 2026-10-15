/**
 * The host finds StarCraft II's content sources the way it finds every game's: from
 * `modkit.contentSources` in the extension's package.json (`pnpm build` first — the declared module
 * is the compiled one), with the installation the user chose passed through `moduleOptions`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveContentSources } from '@modkit/host/node'

const extensionRoot = join(import.meta.dirname, '..', '..', '..')
const root = mkdtempSync(join(tmpdir(), 'sc2-declared-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('StarCraft II content sources declared in the extension manifest', () => {
  it('are loaded and composed by the host with the chosen installation', async () => {
    // Every folder the module would otherwise discover on this machine is pinned to an empty one.
    const folder = (name: string) => {
      const path = join(root, name)
      mkdirSync(path, { recursive: true })
      return path
    }
    const options = {
      installationDirectory: folder('installation'),
      battleNetCacheDirectory: folder('battlenet-cache'),
      sc2MapsCacheDirectory: folder('maps-cache'),
      documentsDirectory: folder('documents'),
    }
    const sources = await resolveContentSources({
      extensionRoots: [extensionRoot],
      storage: join(root, 'storage'),
      moduleOptions: extension => (extension === 'blizzard/starcraft2' ? options : undefined),
    })
    expect(sources).toBeDefined()
    try {
      const ids = (await sources!.snapshot()).roots.map(source => source.id)
      expect(ids).toEqual(expect.arrayContaining(['local:cache', 'local:installation', 'local:documents']))
      expect(typeof sources!.openModContext).toBe('function')
    } finally {
      await sources!.dispose()
    }
  })
})
