import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codecFidelityEvidenceRecords, createEvidenceRegistry } from '@modkit/host'
import { createModkit } from '@modkit/host/node'
import { MAP_LAYERS_OPERATION, MAP_LAYER_READ_OPERATION, MAP_LAYER_WRITE_OPERATION } from '@modkit/sdk/maps'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'

/*
 * Proof `sc2-map-layer-window-v1` (codec.json fidelityEvidence of both map codecs): a window of a
 * layer is read and written north row first, the plan changes only the written samples, the host
 * MCP and the CLI use prepares it on the codec's declared proof and commits it into the folder
 * map, the map reopens with the written samples, and undo restores the original bytes.
 */
const encoder = new TextEncoder()

/** 3x3 HMAP, south row first: base 100 + index, adjustment 10 + index, mask 1, two trailing bytes. */
function heightMap(): Uint8Array {
  const bytes = new Uint8Array(32 + 9 * 6 + 2)
  bytes.set(encoder.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 3, true)
  view.setUint32(12, 3, true)
  for (let index = 0; index < 9; index += 1) {
    view.setUint16(32 + index * 6, 100 + index, true)
    view.setUint16(34 + index * 6, 10 + index, true)
    view.setUint16(36 + index * 6, 1, true)
  }
  bytes.set([0xaa, 0xbb], 32 + 9 * 6)
  return bytes
}

/** 3x3 SMAP: 64-byte header, int16 height and uint16 mask per cell. */
function syncHeightMap(): Uint8Array {
  const bytes = new Uint8Array(64 + 9 * 4)
  bytes.set(encoder.encode('SMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 1, true)
  view.setUint32(8, 3, true)
  view.setUint32(12, 3, true)
  return bytes
}

const terrain =
  '<terrain version="1"><heightMap dim="2 2" offset="0 0 2" scale="1 1 0.5">' +
  '<vertData quantizeBias="1" quantizeScale="0.25" standardHeight="8" name="t3HeightMap"/></heightMap></terrain>'

type Descriptor = { readonly operations: readonly { readonly id: string; readonly handlerId: string; readonly inputSchema?: { $ref?: string } }[] }

describe('SC2 map layer window (sc2-map-layer-window-v1)', () => {
  it('reads and writes a height window, keeps every other byte, commits on the declared proof and undoes', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-map-layer-window-'))
    const mapPath = join(scratch, 'Window.SC2Map')
    mkdirSync(mapPath)
    writeFileSync(join(mapPath, 'MapInfo'), encoder.encode('<MapInfo/>'))
    writeFileSync(join(mapPath, 'Objects'), encoder.encode('<PlacedObjects/>'))
    writeFileSync(join(mapPath, 'Regions'), encoder.encode('<Regions/>'))
    writeFileSync(join(mapPath, 't3Terrain.xml'), encoder.encode(terrain))
    writeFileSync(join(mapPath, 't3SyncHeightMap'), syncHeightMap())
    const heightPath = join(mapPath, 't3HeightMap')
    const original = heightMap()
    writeFileSync(heightPath, original)

    const modkit = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch], writableRoots: [scratch] })
    try {
      const open = async () => {
        const opened = await modkit.open(mapPath)
        if (opened.snapshot.state !== 'opened' || opened.session === undefined) {
          throw new Error(`map did not open: ${JSON.stringify(opened.snapshot)}`)
        }
        const descriptor = opened.snapshot.descriptor as unknown as Descriptor
        const session = opened.session
        const invoke = async (id: string, input: unknown) => {
          const handler = descriptor.operations.find(item => item.id === id)?.handlerId
          if (handler === undefined) throw new Error(`the map declares no ${id}`)
          return session.operations().invoke(handler, input as never)
        }
        const json = async (id: string, input: unknown) => {
          const result = await invoke(id, input)
          if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error(`${id} failed: ${JSON.stringify(result)}`)
          return result.output.value
        }
        return { opened, descriptor, invoke, json }
      }

      const first = await open()
      expect(first.descriptor.operations.find(item => item.id === MAP_LAYER_WRITE_OPERATION)?.inputSchema?.$ref).toBe('modkit://map/layer-write.v1')
      // valueScale = quantizeScale · scale.z; valueOffset = offset.z − quantizeBias · scale.z.
      expect(await first.json(MAP_LAYERS_OPERATION, null)).toMatchObject({
        layers: [{ id: 'height', meaning: 'height', width: 3, height: 3, valueScale: 0.125, valueOffset: 1.5, unit: 'sc2-game-unit', sampling: 'vertex' }],
      })
      // North row first: layer row 0 is document row 2 (bases 106–108).
      expect(await first.json(MAP_LAYER_READ_OPERATION, { layer: 'height', x: 1, y: 0, width: 2, height: 2 })).toEqual({
        layer: 'height', x: 1, y: 0, width: 2, height: 2, values: [107, 108, 104, 105],
      })
      // A window needs all four of x, y, width, height to read, and must stay inside the layer.
      const refused = (result: Promise<{ readonly state: string }>) => result.then(answer => answer.state !== 'ok', () => true)
      expect(await refused(first.invoke(MAP_LAYER_READ_OPERATION, { layer: 'height', x: 1 }))).toBe(true)
      expect(await refused(first.invoke(MAP_LAYER_WRITE_OPERATION, { layer: 'height', x: 2, y: 0, width: 2, height: 1, values: [1, 2] }))).toBe(true)

      const written = await first.invoke(MAP_LAYER_WRITE_OPERATION, { layer: 'height', x: 1, y: 1, width: 2, height: 1, values: [7, 8] })
      if (written.state !== 'ok' || written.output.kind !== 'edit-plan') throw new Error(`map.layer-write failed: ${JSON.stringify(written)}`)
      const plan = written.output.plan as unknown as {
        fidelity: { roundTrip: string; preservesUnknownData: boolean }
        diagnostics: { code: string; severity: string }[]
        edits: { payload: { bytes: Uint8Array } }[]
      }
      expect(plan.fidelity).toMatchObject({ roundTrip: 'semantic', preservesUnknownData: true })
      expect(plan.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'blizzard/sc2-map-sync-height-not-updated' }))
      // Only the heightBase words of document cells 4 and 5 (layer row 1, columns 1–2) differ.
      const expected = original.slice()
      new DataView(expected.buffer).setUint16(32 + 4 * 6, 7, true)
      new DataView(expected.buffer).setUint16(32 + 5 * 6, 8, true)
      expect(plan.edits).toHaveLength(1)
      expect([...plan.edits[0]!.payload.bytes]).toEqual([...expected])

      // The codec's declared proof covers the plan, as createModkit (MCP, CLI) cites it.
      const snapshot = first.opened.snapshot as unknown as { descriptor: { identity: { codecId: string; formatId: string } } }
      const records = codecFidelityEvidenceRecords(modkit.services.inventory, {
        codecId: snapshot.descriptor.identity.codecId,
        formatId: snapshot.descriptor.identity.formatId,
        acceptedOrigins: ['bundled', 'linked'],
      })
      expect(records.map(record => [record.evidenceId, record.writer.representationId])).toEqual([['sc2-map-layer-window-v1', 'map-layers']])
      expect(createEvidenceRegistry(records).evidenceFor(written.output.plan)).toMatchObject({ evidenceId: 'sc2-map-layer-window-v1' })

      // The folder map's plan names its file; the host prepares it on that proof, commits and undoes.
      const editing = first.opened.editing
      if (editing === undefined) throw new Error('the folder map opened without editing')
      const syncBefore = readFileSync(join(mapPath, 't3SyncHeightMap'))
      const prepared = await editing.coordinator.prepare(editing.planFromOperation(written.output), { grant: editing.grantSnapshot })
      if (prepared.state !== 'ready') throw new Error(`prepare: ${JSON.stringify(prepared)}`)
      const committed = await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })
      if (committed.state !== 'committed') throw new Error(`commit: ${JSON.stringify(committed)}`)
      expect([...readFileSync(heightPath)]).toEqual([...expected])
      expect(readFileSync(join(mapPath, 't3SyncHeightMap')).equals(syncBefore)).toBe(true)
      const reopened = await open()
      expect(await reopened.json(MAP_LAYER_READ_OPERATION, { layer: 'height' })).toMatchObject({ values: [106, 107, 108, 103, 7, 8, 100, 101, 102] })
      await reopened.opened.close()
      const undone = await editing.coordinator.undo(committed.receipt.transactionId, { grant: editing.grantSnapshot })
      expect(undone.state).toBe('committed')
      expect([...readFileSync(heightPath)]).toEqual([...original])
      await first.opened.close()
    } finally {
      await modkit.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
