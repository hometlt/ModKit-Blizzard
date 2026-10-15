/**
 * What SC2 folder sources hide (owner decision 28.09): only what Windows marks hidden, and everything
 * under a hidden folder; a name with a leading dot stays visible. `battlenet-local-sources.test.mjs`
 * is pinned by hash as feature-ledger evidence, so this case lives here.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Sc2FolderSource } from '../battlenet/content-sources/local-files.js'

it.skipIf(process.platform !== 'win32')(
  'documents mark what Windows hides, and everything under it, but not dot names',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'modkit-hidden-sc2-'))
    const source = new Sc2FolderSource(root, 'local:documents', 'Documents')
    try {
      await mkdir(join(root, 'Hidden'))
      for (const name of ['Secret.txt', '.dotfile', 'Visible.txt', 'Hidden/Inner.txt'])
        await writeFile(join(root, name), name)
      for (const name of ['Secret.txt', 'Hidden']) execFileSync('attrib', ['+h', join(root, name)])
      const flags = async (path: string) =>
        Object.fromEntries((await source.list(path)).map(item => [item.path, item.hidden === true]))
      expect(await flags('')).toEqual({ Hidden: true, '.dotfile': false, 'Secret.txt': true, 'Visible.txt': false })
      expect(await flags('Hidden')).toEqual({ 'Hidden/Inner.txt': true })
    } finally {
      await source.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
