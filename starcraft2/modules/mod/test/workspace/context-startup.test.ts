/** Context discovery must leave Data and Resources owners dormant until their first operation. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const owners = vi.hoisted(() => ({ data: 0, resources: 0, schema: 0 }))
vi.mock('../../../data/shared/catalog-engine/sc2-schema/index.js', async original => {
  owners.schema += 1
  return original()
})
vi.mock('../../../data/services/catalog/data-session.js', async original => {
  owners.data += 1
  return original()
})
vi.mock('../../services/resources/src/effective-tree.js', async original => {
  owners.resources += 1
  return original()
})

import { createSc2ModContexts } from '../../shared/workspace/mod-contexts.js'
import { Sc2FolderSource } from '../../../game/battlenet/content-sources/local-files.js'

describe('SC2 context startup', () => {
  it('opens and lists a mod before loading Data, then serves complete answers and Resources', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-context-startup-'))
    const mod = join(scratch, 'Startup.SC2Mod')
    await mkdir(join(mod, 'Base.SC2Data', 'GameData'), { recursive: true })
    await writeFile(join(mod, 'DocumentInfo'), '<DocInfo/>')
    await writeFile(join(mod, 'Base.SC2Data', 'GameData', 'UnitData.xml'), '<Catalog><CUnit id="Startup"><LifeMax value="45"/></CUnit></Catalog>')
    const loader = createSc2ModContexts({ sources: () => new Map(), defaultBaseMods: [], hostFolder: directory => {
      const folder = new Sc2FolderSource(directory, 'host', 'host')
      return { id: 'host', list: path => folder.list(path), read: (path, max) => folder.read(path, max), dispose: () => folder.dispose() }
    } })
    try {
      const context = await loader.open({ schemaVersion: 1, target: mod, baseMods: [] })
      try {
        const primary = context.layers.at(-1)!
        await context.files(primary.id, { limit: 10 })
        expect(owners).toEqual({ data: 0, resources: 0, schema: 0 })
        expect(await context.query({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'Startup' }] }))
          .toMatchObject({ entities: [{ fields: { LifeMax: 45 } }] })
        expect(owners).toEqual({ data: 1, resources: 0, schema: 1 })
        expect(await context.query({ kind: 'data.ids', namespace: 'Unit' })).toMatchObject({ complete: true, ids: ['Startup'] })
        await context.query({ kind: 'resources.tree', action: 'root' })
        expect(owners).toEqual({ data: 1, resources: 1, schema: 1 })
      } finally { await context.dispose() }
    } finally { await loader.dispose(); await rm(scratch, { recursive: true, force: true }) }
  })
})
