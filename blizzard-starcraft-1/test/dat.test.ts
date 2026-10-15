import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import type { TableDataSource } from '@modkit/sdk'

const extension = join(import.meta.dirname, '..')
const { DAT_LAYOUTS, datBytes, datLayoutOf, readDat } = (await import(pathToFileURL(join(extension, 'dist', 'dat', 'dat.js')).href)) as typeof import('../dist/dat/dat.js')

/** `mapdata.dat`: one u32 per mission, its 1-based id in `mapdata.tbl`. */
const mapdata = () => new Uint8Array(new Uint32Array(Array.from({ length: 65 }, (_, index) => index + 1)).buffer)

describe('StarCraft data tables', () => {
  it('knows the size of every Brood War table, as the game ships it', () => {
    expect(Object.fromEntries(DAT_LAYOUTS.map(layout => [layout.file, datBytes(layout)]))).toEqual({
      'units.dat': 19876,
      'weapons.dat': 5460,
      'flingy.dat': 3135,
      'sprites.dat': 3229,
      'images.dat': 37962,
      'upgrades.dat': 1281,
      'techdata.dat': 836,
      'sfxdata.dat': 10296,
      'portdata.dat': 1320,
      'mapdata.dat': 260,
    })
  })

  it('reads a column per field, pairs as tuples, and nothing where a field covers no entry', () => {
    const layout = datLayoutOf('SPRITES.DAT')!
    const bytes = new Uint8Array(datBytes(layout))
    const data = new DataView(bytes.buffer)
    data.setUint16(0, 589, true) // sprite 0's image
    bytes[2 * 517] = 7 // the health bar of sprite 130, the first that has one
    const table = readDat(bytes, layout)
    expect(table.columns[0]![0]).toBe(589)
    expect(table.columns[1]![129]).toBeNull()
    expect(table.columns[1]![130]).toBe(7)

    const units = datLayoutOf('units.dat')!
    const unitBytes = new Uint8Array(datBytes(units))
    const box = units.fields.findIndex(field => field.name === 'placementBox')
    let at = 0
    for (const field of units.fields.slice(0, box)) at += (field.count ?? 228 - (field.first ?? 0)) * field.bytes * (field.parts ?? 1)
    new DataView(unitBytes.buffer).setUint16(at, 17, true)
    new DataView(unitBytes.buffer).setUint16(at + 2, 20, true)
    expect(readDat(unitBytes, units).columns[box]![0]).toEqual([17, 20])
  })

  it('refuses a table whose size is not its layout, a modded or extended one', () => {
    expect(() => readDat(new Uint8Array(261), datLayoutOf('mapdata.dat')!)).toThrow(/260/u)
  })

  it('opens through the host by its file name; without its string table the name column is empty', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc1-dat-'))
    await mkdir(join(scratch, 'arr'))
    const path = join(scratch, 'arr', 'mapdata.dat')
    await writeFile(path, mapdata())
    const m = await createModkit({ extensions: [extension], roots: [scratch] })
    const opened = await m.open(path)
    try {
      if (opened.snapshot.state !== 'opened') throw new Error(JSON.stringify(opened.snapshot))
      expect(opened.snapshot.selected.contributionId).toBe('blizzard/starcraft1-dat')
      expect(opened.snapshot.descriptor.diagnostics.map(item => item.code)).toContain('blizzard/starcraft1-dat-names')
      const lease = await opened.session!.dataSource('common.view/table-data-source', 1)
      try {
        const table = lease.value as TableDataSource
        expect((await table.shape()).header).toEqual(['id', 'name', 'mission'])
        const rows = await table.rows({ kind: 'range', from: 0, count: 2 })
        expect(rows.items.map(row => row.cells)).toEqual([['0', '', '1'], ['1', '', '2']])
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
