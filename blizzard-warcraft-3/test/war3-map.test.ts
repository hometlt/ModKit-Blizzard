import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TableDataSource, TreeDataSource } from '@modkit/sdk'
import { createModkit, openPathArtifactSource } from '@modkit/host/node'
import { openMpqReader } from '@modkit/blizzard-mpq/reader'
import { MAP_LAYERS_OPERATION, MAP_LAYER_READ_OPERATION, MAP_LAYER_WRITE_OPERATION } from '@modkit/sdk/maps'
import { authoredMap, authoredMapDocuments } from './war3-fixtures.js'
import { extension } from './war3-harness.js'

/**
 * A map written for the test (`war3-fixtures.ts`) — terrain corners and pathing cells south row
 * first, as the game stores them — opened as a `.w3x` through the host: blizzard/mpq carries it,
 * blizzard/war3-map reads it, and the grids come back north row first through the common map-layer
 * operations.
 */
const { readWar3Map, readWar3MapLayer, writeWar3MapLayer } = (await import(
  pathToFileURL(join(extension, 'dist', 'war3-map', 'map.js')).href
)) as typeof import('../dist/war3-map/map.js')

describe('Warcraft III map', () => {
  it('writes every layer into its document and reads it back, the other fields of a corner kept', async () => {
    const documents = new Map(authoredMapDocuments().map(item => [item.path, item.bytes]))
    const read = (docs: ReadonlyMap<string, Uint8Array>) => readWar3Map(async path => docs.get(path))
    const map = await read(documents)
    const all = (layer: string) => readWar3MapLayer(map, { layer }).values
    // Each layer written whole with new samples; every other layer of the map reads as before.
    const writes: Record<string, number[]> = {
      height: [1, 2, 3, 4, 5, 6],
      'cliff-level': [15, 0, 1, 2, 3, 4],
      water: [0, 1, 0x3fff, 100, 200, 300],
      'ground-texture': [9, 8, 7, 6, 5, 4],
      'ground-variation': [31, 0, 3, 9, 17, 24],
      'cliff-variation': [7, 0, 1, 2, 3, 4],
      'cliff-texture': [15, 0, 4, 3, 2, 1],
      'corner-flags': [31, 0, 16, 1, 2, 12],
      pathing: Array.from({ length: 32 }, (_, index) => (index * 37) & 0xff),
    }
    for (const [layer, values] of Object.entries(writes)) {
      const written = writeWar3MapLayer(map, documents.get(layer === 'pathing' ? 'war3map.wpm' : 'war3map.w3e')!, {
        layer,
        width: layer === 'pathing' ? 8 : 3,
        height: layer === 'pathing' ? 4 : 2,
        values,
      })
      const after = await read(new Map([...documents, [written.path, written.bytes]]))
      expect(readWar3MapLayer(after, { layer }).values, layer).toEqual(values)
      for (const other of Object.keys(writes).filter(name => name !== layer))
        expect(readWar3MapLayer(after, { layer: other }).values, `${layer} kept ${other}`).toEqual(all(other))
    }
    expect(() => writeWar3MapLayer(map, documents.get('war3map.w3e')!, { layer: 'cliff-level', width: 3, height: 2, values: [16, 0, 0, 0, 0, 0] })).toThrow(/from 0 to 15/u)
    expect(() => writeWar3MapLayer(map, documents.get('war3map.w3e')!.subarray(0, 50), { layer: 'height', width: 3, height: 2, values: [0, 0, 0, 0, 0, 0] })).toThrow(/shorter/u)
  })

  it('opens a .w3x over the MPQ container and reads its grids north row first', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-war3-map-'))
    const path = join(scratch, 'Test.w3x')
    await writeFile(path, await authoredMap())
    const host = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [scratch] })
    const grant = { id: 'war3-map', classes: ['read-source'] } as const
    const budget = { maxInputBytes: 4_000_000n, maxDepth: 32, maxNodes: 10_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }
    const opened = await host.services.open({ source: await openPathArtifactSource(path), path, intent: 'full', grant, budget })
    if (opened.state !== 'opened') throw new Error(`map did not open: ${JSON.stringify(opened)}`)
    try {
      expect(opened.selected.contributionId).toBe('blizzard/war3-map')
      expect(opened.descriptor.diagnostics).toEqual([])
      const invoke = async (id: string, input: unknown) => {
        const handler = opened.descriptor.operations.find(item => item.id === id)?.handlerId
        const result = await opened.session.operations().invoke(handler!, input as never)
        if (result.state !== 'ok') throw new Error(`${id} failed: ${JSON.stringify(result)}`)
        return (result.output as { value: unknown }).value
      }
      const listed = (await invoke(MAP_LAYERS_OPERATION, {})) as { layers: { id: string; width: number; height: number }[] }
      expect(listed.layers.map(layer => [layer.id, layer.width, layer.height])).toEqual([
        ['height', 3, 2],
        ['cliff-level', 3, 2],
        ['water', 3, 2],
        ['ground-texture', 3, 2],
        ['ground-variation', 3, 2],
        ['cliff-variation', 3, 2],
        ['cliff-texture', 3, 2],
        ['corner-flags', 3, 2],
        ['pathing', 8, 4],
      ])
      const layer = async (id: string, window = {}) => ((await invoke(MAP_LAYER_READ_OPERATION, { layer: id, ...window })) as { values: number[] }).values
      expect(await layer('height')).toEqual([8704, 8708, 8712, 8192, 8196, 8200])
      expect(await layer('cliff-level')).toEqual([3, 3, 3, 2, 2, 2])
      expect(await layer('water')).toEqual([8000, 8000, 8000, 8000, 8000, 8000])
      expect(await layer('ground-texture')).toEqual([0, 1, 2, 0, 1, 2])
      // Water (4) and map edge (16) on the south-west corner.
      expect(await layer('corner-flags')).toEqual([0, 0, 0, 20, 0, 0])
      expect(await layer('pathing', { x: 6, y: 0, width: 2, height: 4 })).toEqual([3, 3, 2, 2, 1, 1, 0, 0])

      const tree = await opened.session.dataSource('common.view/tree-data-source', 1)
      try {
        const source = tree.value as TreeDataSource
        const root = await source.root()
        expect((await source.facts(root)).label).toBe('Lantern Isle')
        const sections = await source.children(root, { limit: 20 })
        const facts = await Promise.all(sections.items.map(item => source.facts(item)))
        expect(facts.map(item => [item.label, item.preview])).toEqual([
          ['Information', 'Modkit'],
          ['Players', '1'],
          ['Forces', '0'],
          ['Terrain', '2 × 1 tiles'],
        ])
      } finally {
        await tree.release()
      }
      const table = await opened.session.dataSource('common.view/table-data-source', 1)
      const rows = await (table.value as TableDataSource).rows({ kind: 'range', from: 0, count: 10 }).finally(() => table.release())
      expect(rows.items.map(row => row.cells)).toEqual([['0', 'Red', 'user', 'orc', '', '-64', '0']])
    } finally {
      await opened.session.dispose()
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('writes a layer window into the map, keeping every other byte, and undoes it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'modkit-war3-map-write-'))
    const path = join(scratch, 'Write.w3x')
    const original = await authoredMap()
    await writeFile(path, original)
    const entries = async (bytes: Uint8Array) => {
      const reader = await openMpqReader(bytes, { maxArchiveBytes: 1 << 24, maxEntries: 64, maxEntryBytes: 1 << 20 })
      try {
        const out = new Map<string, Uint8Array>()
        for (const name of ['war3map.w3i', 'war3map.w3e', 'war3map.wpm', 'war3map.wts']) {
          const entry = reader.find(name)
          if (entry !== undefined) out.set(name, await reader.read(entry.id))
        }
        return out
      } finally {
        reader.dispose()
      }
    }
    const before = await entries(original)
    const m = await createModkit({ extensions: [join(extension, '..', 'mpq'), extension], roots: [scratch], writableRoots: [scratch] })
    // The map is composed over its MPQ: the facade edits it as that carrier, whose container.pack
    // turns the map's entry plan into the archive's.
    const opened = await m.open(path)
    try {
      if (opened.snapshot.state !== 'opened') throw new Error('map did not open')
      const descriptor = opened.snapshot.descriptor
      const handler = (id: string) => descriptor.operations.find(item => item.id === id)!.handlerId
      const editing = opened.editing
      if (editing === undefined) throw new Error('the facade opened the map without editing')
      // Raise the two northern corners of the east column; the host packs the entry into the map.
      const written = await opened.session.operations().invoke(handler(MAP_LAYER_WRITE_OPERATION), {
        layer: 'height',
        x: 1,
        y: 0,
        width: 2,
        height: 1,
        values: [9000, 9001],
      } as never)
      if (written.state !== 'ok') throw new Error(JSON.stringify(written))
      const plan = editing.planFromOperation(written.output)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      if (prepared.state !== 'ready') throw new Error(JSON.stringify(prepared))
      const committed = await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })
      if (committed.state !== 'committed') throw new Error(JSON.stringify(committed))

      const after = await entries(new Uint8Array(await readFile(path)))
      // Only the four bytes of the two written heights changed; the other entries are untouched.
      const changed = [...after.get('war3map.w3e')!].flatMap((byte, index) => (byte === before.get('war3map.w3e')![index] ? [] : [index]))
      const northRow = 45 + 3 * 7
      expect(changed).toEqual([northRow + 7, northRow + 8, northRow + 14, northRow + 15])
      for (const name of ['war3map.w3i', 'war3map.wpm', 'war3map.wts']) expect(after.get(name)).toEqual(before.get(name))

      const reopened = await m.open(path)
      try {
        if (reopened.snapshot.state !== 'opened') throw new Error('map did not reopen')
        const read = await reopened.session.operations().invoke(
          reopened.snapshot.descriptor.operations.find(item => item.id === MAP_LAYER_READ_OPERATION)!.handlerId,
          { layer: 'height' } as never,
        )
        expect(read).toMatchObject({ state: 'ok', output: { value: { values: [8704, 9000, 9001, 8192, 8196, 8200] } } })
      } finally {
        await reopened.close()
      }

      const undone = await editing.coordinator.undo(committed.receipt.transactionId, { grant: editing.grantSnapshot })
      expect(undone.state).toBe('committed')
      expect(new Uint8Array(await readFile(path))).toEqual(original)
    } finally {
      await opened.close()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
