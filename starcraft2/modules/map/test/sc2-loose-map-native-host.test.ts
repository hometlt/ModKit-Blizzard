import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSubjectEditing, nestedSubjectServices, openNestedSubject } from '@modkit/host'
import { createFileEditingBackend, createModkit, openPathArtifactSource } from '@modkit/host/node'
import { readHeightMap } from '../shared/format/index.js'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 32,
  maxNodes: 100_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}

function heightMap(): Uint8Array {
  const bytes = new Uint8Array(32 + 4 * 6)
  bytes.set(encoder.encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) view.setUint16(32 + index * 6, 100 + index, true)
  return bytes
}

describe('SC2 loose map native host editing', () => {
  it('writes the owned entry, reopens it, rejects stale plans, and supports undo/redo', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-loose-map-host-'))
    const mapPath = join(scratch, 'Loose.SC2Map')
    mkdirSync(mapPath)
    writeFileSync(join(mapPath, 'MapInfo'), encoder.encode('<MapInfo/>'))
    writeFileSync(join(mapPath, 'Objects'), encoder.encode('<PlacedObjects/>'))
    writeFileSync(join(mapPath, 'Regions'), encoder.encode('<Regions/>'))
    const heightPath = join(mapPath, 't3HeightMap')
    const originalHeight = heightMap()
    writeFileSync(heightPath, originalHeight)
    const opaquePath = join(mapPath, 'Opaque.bin')
    const opaque = new Uint8Array([9, 8, 7, 6])
    writeFileSync(opaquePath, opaque)

    const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const grant = { id: 'sc2-loose-map-host-write', classes: ['read-source', 'write-source'] } as const
    const sessions: { dispose(): Promise<void> }[] = []
    try {
      const open = async () => {
        const opened = await host.services.open({
          source: await openPathArtifactSource(mapPath),
          path: mapPath,
          intent: 'full',
          grant,
          budget,
        })
        if (opened.state !== 'opened') {
          throw new Error(`Loose SC2 map did not open: ${JSON.stringify(opened)}`)
        }
        expect(opened.selected.contributionId).toBe('blizzard/sc2-map-directory')
        sessions.push(opened.session)
        return opened
      }
      const openHeight = async () => {
        const parent = await open()
        const nested = await openNestedSubject({
          parent: parent.session,
          entryId: 't3HeightMap',
          ...nestedSubjectServices(host.services),
          grant,
          budget,
          intent: 'full',
        })
        expect(nested.result.state).toBe('opened')
        if (nested.result.state !== 'opened') throw new Error('Nested HeightMap did not open')
        expect(nested.result.selected.contributionId).toBe('blizzard/sc2-height-map')
        sessions.push(nested.result.session)
        return nested.result
      }

      const opened = await openHeight()
      const invoked = await opened.session.operations().invoke('set-cell', {
        x: 1,
        y: 0,
        heightBase: 444,
      })
      expect(invoked.state).toBe('ok')
      if (invoked.state !== 'ok') throw new Error('Loose map edit did not run')
      const editing = createSubjectEditing({
        opened,
        grant,
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'semantic',
          preservesUnknownData: true,
          evidenceId: 'sc2-loose-map-native-host-v1',
          corpusId: 'sc2-loose-map-native-host',
          corpusDigest: `sha256:${createHash('sha256').update(originalHeight).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1',
          writer: {
            providerId: 'blizzard/sc2-height-map',
            providerVersion: '1.0.0',
            artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
              item => item.manifest?.id === 'blizzard/sc2-height-map',
            )?.record?.artifactDigest,
            formatId: 'sc2-height-map',
            representationId: 'source',
          },
          optionsFingerprint: 'terrain-cell-set-v1',
          inputClass: 'synthetic-loose-map',
          provenAt: '2026-09-10T00:00:00Z',
        }) as never,
      })
      const plan = editing.planFromOperation(invoked.output)
      expect(plan.targets[0]?.ownerSource.uri).toContain('t3HeightMap')
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('Loose map plan did not prepare')
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      if (committed.state !== 'committed') throw new Error('Loose map plan did not commit')
      expect(readHeightMap(new Uint8Array(readFileSync(heightPath))).cells[1]?.heightBase).toBe(444)
      expect(new Uint8Array(readFileSync(opaquePath))).toEqual(opaque)

      const reopened = await openHeight()
      const extracted = await reopened.session.operations().invoke('export-raw', {})
      expect(extracted.state).toBe('ok')
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
        throw new Error('Edited loose map did not reopen')
      }
      expect(readHeightMap(extracted.output.value).cells[1]?.heightBase).toBe(444)

      expect((await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })).state).toBe('conflict')
      expect((await editing.coordinator.undo(committed.receipt.transactionId, { grant: editing.grantSnapshot })).state).toBe('committed')
      expect(new Uint8Array(readFileSync(heightPath))).toEqual(originalHeight)
      expect((await editing.coordinator.redo(committed.receipt.transactionId, { grant: editing.grantSnapshot })).state).toBe('committed')
      expect(readHeightMap(new Uint8Array(readFileSync(heightPath))).cells[1]?.heightBase).toBe(444)
    } finally {
      for (const session of sessions) await session.dispose()
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
