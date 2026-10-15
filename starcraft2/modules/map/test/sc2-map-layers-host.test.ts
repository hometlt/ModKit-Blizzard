import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { greyGridFromPng, greyGridToPng } from '@modkit/codec-kit/raster'
import { createModkit, openPathArtifactSource } from '@modkit/host/node'
import { MAP_LAYERS_OPERATION, MAP_LAYER_READ_OPERATION, MAP_LAYER_WRITE_OPERATION } from '@modkit/sdk/maps'
import { readHeightMap, readSyncCliffLevel } from '../shared/format/index.js'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'

/*
 * A map's grid layers through the common map-layer operations: listed, read north row first,
 * carried through a 16-bit PNG unchanged, and written back as one edit plan.
 */
const encoder = new TextEncoder()
const budget = { maxInputBytes: 4_000_000n, maxDepth: 32, maxNodes: 100_000, maxScalarBytes: 1_000_000, maxDiagnostics: 100 }

/** A 2x2 grid document: 32-byte header, then `stride` bytes per cell, south row first. */
function grid(magic: string, version: number, stride: number, values: number[]): Uint8Array {
  const bytes = new Uint8Array(32 + values.length * stride)
  bytes.set(encoder.encode(magic))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, version, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  values.forEach((value, index) => view.setUint16(32 + index * stride, value, true))
  return bytes
}

/** The handler a subject declares for a common operation id. */
function handlerOf(opened: { readonly descriptor: { readonly operations: readonly { readonly id: string; readonly handlerId: string }[] } }, id: string) {
  const operation = opened.descriptor.operations.find(item => item.id === id)
  if (operation === undefined) throw new Error(`the map declares no ${id}`)
  return operation.handlerId
}

describe('SC2 map layers through the common map-layer operations', () => {
  it('lists, reads, round-trips through PNG and writes height and cliff layers', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-map-layers-'))
    const mapPath = join(scratch, 'Layers.SC2Map')
    mkdirSync(mapPath)
    writeFileSync(join(mapPath, 'MapInfo'), encoder.encode('<MapInfo/>'))
    writeFileSync(join(mapPath, 'Objects'), encoder.encode('<PlacedObjects/>'))
    writeFileSync(join(mapPath, 'Regions'), encoder.encode('<Regions/>'))
    const heightPath = join(mapPath, 't3HeightMap')
    const cliffPath = join(mapPath, 't3SyncCliffLevel')
    const height = grid('HMAP', 101, 6, [100, 101, 102, 103])
    writeFileSync(heightPath, height)
    writeFileSync(cliffPath, grid('CLIF', 100, 2, [0, 1, 2, 3]))

    const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch] })
    const grant = { id: 'sc2-map-layers-write', classes: ['read-source', 'write-source'] } as const
    const sessions: { dispose(): Promise<void> }[] = []
    try {
      const opened = await host.services.open({ source: await openPathArtifactSource(mapPath), path: mapPath, intent: 'full', grant, budget })
      if (opened.state !== 'opened') throw new Error(`map did not open: ${JSON.stringify(opened)}`)
      sessions.push(opened.session)
      const invoke = async (operation: string, input: unknown) => {
        const result = await opened.session.operations().invoke(handlerOf(opened, operation), input as never)
        if (result.state !== 'ok') throw new Error(`${operation} failed: ${JSON.stringify(result)}`)
        return result.output
      }

      const listed = await invoke(MAP_LAYERS_OPERATION, {})
      expect(listed).toMatchObject({
        kind: 'json',
        value: {
          layers: [
            { id: 'height', meaning: 'height', width: 2, height: 2, maximum: 65535, editable: true },
            {
              id: 'cliff-level',
              meaning: 'cliff-level',
              width: 2,
              height: 2,
              // Every stored value, named by the level the engine rounds it to ((raw + 8) >> 4).
              categories: [
                { value: 0, label: 'Cliff level 0', color: expect.stringMatching(/^#[0-9a-f]{6}$/u) },
                { value: 1, label: 'Cliff level 0' },
                { value: 2, label: 'Cliff level 0' },
                { value: 3, label: 'Cliff level 0' },
              ],
            },
          ],
          // Pictures the codec draws itself, only for the documents this map has.
          pictures: [{ id: 'height-sum' }, { id: 'cliff-cells' }, { id: 'overlay' }],
        },
      })
      const read = await invoke(MAP_LAYER_READ_OPERATION, { layer: 'height' })
      // The document keeps the south row first; the layer shows the north row first, as an image.
      expect(read).toMatchObject({ kind: 'json', value: { layer: 'height', width: 2, height: 2, values: [102, 103, 100, 101] } })
      const values = (read as { value: { values: number[] } }).value.values
      const png = await greyGridToPng({ width: 2, height: 2, values }, 65535)
      expect((await greyGridFromPng(png, { width: 2, height: 2, minimum: 0, maximum: 65535 })).values).toEqual(values)

      // The plan replaces the height document, south row first; committing an entry plan is the
      // ordinary edit-world path (the container packs it), unchanged by layers.
      const written = await invoke(MAP_LAYER_WRITE_OPERATION, { layer: 'height', width: 2, height: 2, values: [10, 11, 12, 13] })
      const plan = (written as { plan: { targets: { subjectUri: string }[]; edits: { payload: { bytes: Uint8Array } }[] } }).plan
      expect(plan.targets.map(target => target.subjectUri)).toEqual([expect.stringMatching(/t3HeightMap$/u)])
      const heights = readHeightMap(plan.edits[0]!.payload.bytes)
      expect(heights.cells.map(cell => cell.heightBase)).toEqual([12, 13, 10, 11])
      expect(heights.cells.map(cell => cell.heightAdjustments)).toEqual([0, 0, 0, 0])

      await expect(
        opened.session.operations().invoke(handlerOf(opened, MAP_LAYER_WRITE_OPERATION), { layer: 'height', width: 3, height: 1, values: [1, 2, 3] } as never),
      ).rejects.toThrow()
    } finally {
      for (const session of sessions.reverse()) await session.dispose()
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('writes a cliff layer north row first into the south-first document', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-map-cliff-layer-'))
    const mapPath = join(scratch, 'Cliffs.SC2Map')
    mkdirSync(mapPath)
    writeFileSync(join(mapPath, 'MapInfo'), encoder.encode('<MapInfo/>'))
    writeFileSync(join(mapPath, 'Objects'), encoder.encode('<PlacedObjects/>'))
    writeFileSync(join(mapPath, 'Regions'), encoder.encode('<Regions/>'))
    writeFileSync(join(mapPath, 't3HeightMap'), grid('HMAP', 101, 6, [0, 0, 0, 0]))
    const cliffPath = join(mapPath, 't3SyncCliffLevel')
    writeFileSync(cliffPath, grid('CLIF', 100, 2, [0, 1, 2, 3]))
    const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch] })
    const grant = { id: 'sc2-map-cliff-layer', classes: ['read-source', 'write-source'] } as const
    const opened = await host.services.open({ source: await openPathArtifactSource(mapPath), path: mapPath, intent: 'full', grant, budget })
    if (opened.state !== 'opened') throw new Error('map did not open')
    try {
      const written = await opened.session.operations().invoke(handlerOf(opened, MAP_LAYER_WRITE_OPERATION), { layer: 'cliff-level', width: 2, height: 2, values: [7, 7, 5, 5] } as never)
      expect(written).toMatchObject({ state: 'ok', output: { kind: 'edit-plan' } })
      const plan = (written as { output: { plan: { edits: { payload: { bytes: Uint8Array } }[] } } }).output.plan
      expect(readSyncCliffLevel(plan.edits[0]!.payload.bytes).heights).toEqual([5, 5, 7, 7])
    } finally {
      await opened.session.dispose()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
