import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import type { RasterImageSource, TableDataSource, TreeDataSource } from '@modkit/sdk'
import { MAP_LAYERS_OPERATION, MAP_LAYER_READ_OPERATION } from '@modkit/sdk/maps'
import { authoredScenario, authoredTbl, authoredTileset } from './sc1-fixtures.js'

const extension = join(import.meta.dirname, '..')

describe('StarCraft terrain', () => {
  it('draws a scenario with the tileset beside it, reads its minitile layers and names its units', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-terrain-'))
    await mkdir(join(scratch, 'tileset'))
    for (const [extensionName, bytes] of Object.entries(authoredTileset())) await writeFile(join(scratch, 'tileset', `jungle.${extensionName}`), bytes)
    await mkdir(join(scratch, 'rez'))
    await writeFile(join(scratch, 'rez', 'stat_txt.tbl'), authoredTbl())
    const path = join(scratch, 'scenario.chk')
    await writeFile(path, authoredScenario())
    const m = await createModkit({ extensions: [extension], roots: [scratch] })
    const opened = await m.open(path)
    try {
      if (opened.snapshot.state !== 'opened') throw new Error(JSON.stringify(opened.snapshot))
      const descriptor = opened.snapshot.descriptor
      expect(descriptor.diagnostics).toEqual([])
      const invoke = async (id: string, input: unknown) => {
        const result = await opened.session!.operations().invoke(descriptor.operations.find(item => item.id === id)!.handlerId, input as never)
        if (result.state !== 'ok') throw new Error(JSON.stringify(result))
        return (result.output as { value: unknown }).value
      }
      const listed = (await invoke(MAP_LAYERS_OPERATION, {})) as { layers: { id: string; width: number; height: number; editable: boolean }[] }
      expect(listed.layers.map(layer => [layer.id, layer.width, layer.height, layer.editable])).toEqual([
        ['tiles', 4, 2, true],
        ['walkable', 16, 8, false],
        ['elevation', 16, 8, false],
      ])
      expect(await invoke(MAP_LAYER_READ_OPERATION, { layer: 'elevation', x: 0, y: 0, width: 2, height: 1 })).toMatchObject({ values: [1, 1] })

      // Unit 0, named by entry 0 of the game's string table.
      const tree = await opened.session!.dataSource('common.view/tree-data-source', 1)
      try {
        const source = tree.value as TreeDataSource
        const units = (await source.children(await source.root(), { limit: 20 })).items[3]!
        const first = (await source.children(units, { limit: 1 })).items[0]!
        expect((await source.facts(first)).label).toBe('Terran Marine')
      } finally {
        await tree.release()
      }

      const lease = await opened.session!.dataSource('common.view/raster-image-source', 1)
      try {
        const raster = lease.value as RasterImageSource
        expect(await raster.info()).toMatchObject({ width: 128, height: 64, storedMipLevels: 6 })
        // The first minitile is drawn mirrored: its first pixel is minitile 1's last, index 8.
        const first = await raster.readRegion!({ x: 0, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 64 })
        expect([...first.pixels]).toEqual([80, 160, 240, 255])
        const second = await raster.readRegion!({ x: 8, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 64 })
        expect([...second.pixels]).toEqual([10, 20, 30, 255])
        // Level 5 is one pixel a tile: the whole map is 4 × 2.
        const minimap = await raster.readRegion!({ x: 0, y: 0, width: 4, height: 2, mipLevel: 5, pixelFormat: 'rgba8', maxBytes: 64 })
        expect(minimap.width * minimap.height).toBe(8)
      } finally {
        await lease.release()
      }
    } finally {
      await opened.close()
      await m.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('opens a tileset by its .cv5: the tile groups as a table, the megatiles as an atlas', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-tileset-'))
    for (const [extensionName, bytes] of Object.entries(authoredTileset())) await writeFile(join(scratch, `jungle.${extensionName}`), bytes)
    const m = await createModkit({ extensions: [extension], roots: [scratch] })
    const opened = await m.open(join(scratch, 'jungle.cv5'))
    try {
      if (opened.snapshot.state !== 'opened') throw new Error(JSON.stringify(opened.snapshot))
      expect(opened.snapshot.selected.contributionId).toBe('blizzard/starcraft1-tileset')
      expect(opened.snapshot.descriptor.diagnostics).toEqual([])
      const table = await opened.session!.dataSource('common.view/table-data-source', 1)
      try {
        const rows = await (table.value as TableDataSource).rows({ kind: 'range', from: 0, count: 3 })
        expect(rows.items.map(row => row.cells[0])).toEqual(['0', '1', '2'])
        expect(rows.items[1]!.cells[3]).toBe(Array.from({ length: 16 }, () => '1').join(', '))
      } finally {
        await table.release()
      }
      const lease = await opened.session!.dataSource('common.view/raster-image-source', 1)
      try {
        const raster = lease.value as RasterImageSource
        expect(await raster.info()).toMatchObject({ width: 1024, height: 32 })
        // Megatile 1 starts at x 32; its first minitile is drawn mirrored, as on the map.
        const pixel = await raster.readRegion!({ x: 32, y: 0, width: 1, height: 1, pixelFormat: 'rgba8', maxBytes: 64 })
        expect([...pixel.pixels]).toEqual([80, 160, 240, 255])
      } finally {
        await lease.release()
      }
    } finally {
      await opened.close()
      await m.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
