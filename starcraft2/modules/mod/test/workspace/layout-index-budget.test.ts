/** Carried Layout indexes must preserve the requested file's exemption from workspace budgets. */
import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'

vi.mock('../../../layout/shared/semantic.js', async original => {
  const semantic = await original<typeof import('../../../layout/shared/semantic.js')>()
  return { ...semantic, defaultLayoutBounds: { ...semantic.defaultLayoutBounds, maxDocuments: 2 } }
})

it('serves a previously dropped layout when the requested file changes after an unrelated overlay', async () => {
  const directory = await fs.mkdtemp('C:/MKTEMP/modkit-layout-index-')
  const root = path.join(directory, 'Mine.SC2Mod')
  const folder = 'Base.SC2Data/UI/Layout'
  const text = '<Desc><Frame type="Button" name="Panel"/></Desc>'
  await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.writeFile(path.join(root, 'DocumentInfo'), '<DocInfo/>')
  for (const file of ['A.SC2Layout', 'B.SC2Layout']) await fs.writeFile(path.join(root, folder, file), text)
  const loader = createSc2ModContexts({
    sources: () => new Map(),
    hostFolder: directory => {
      const source = new Sc2FolderSource(directory, 'host', 'host')
      return { id: 'host', list: p => source.list(p), read: (p, max) => source.read(p, max), dispose: () => source.dispose() }
    },
  })
  try {
    const context = await loader.open({ schemaVersion: 1, target: root, baseMods: [] })
    const layerId = context.layers.at(-1)!.id
    const hover = (file: string) => context.query({ kind: 'layout.hover',
      document: { layerId, path: `${folder}/${file}` }, offset: text.indexOf('Button') + 2 })
    expect(await hover('A.SC2Layout')).toMatchObject({ hover: { markdown: expect.stringContaining('Button') } })
    await context.overlay([{ layerId, path: 'Base.SC2Data/MapScript.galaxy', text: 'void Init() {}' }])
    expect(await hover('B.SC2Layout')).toMatchObject({ hover: { markdown: expect.stringContaining('Button') } })
  } finally {
    await loader.dispose()
    // mkdtemp created this test's root under the named scratch directory only.
    const relative = path.relative('C:/MKTEMP', directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unexpected test scratch path')
    await fs.rm(directory, { recursive: true, force: true })
  }
})
