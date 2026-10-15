import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'
import { readHeightMap } from '../shared/format/index.js'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'

const budget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 16,
  maxNodes: 100_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}

function fixture(): Uint8Array {
  const bytes = new Uint8Array(32 + 4 * 6 + 3)
  bytes.set(new TextEncoder().encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  for (let index = 0; index < 4; index += 1) {
    view.setUint16(32 + index * 6, 100 + index, true)
    view.setUint16(34 + index * 6, 200 + index, true)
    view.setUint16(36 + index * 6, 1, true)
  }
  bytes.set([7, 8, 9], 32 + 4 * 6)
  return bytes
}

describe('SC2 HeightMap native host editing', () => {
  it('commits, reopens, rejects a stale plan, and supports undo/redo', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-height-map-host-'))
    const path = join(scratch, 't3HeightMap')
    const original = fixture()
    writeFileSync(path, original)
    const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch] })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const grant = { id: 'sc2-height-map-host-write', classes: ['read-source', 'write-source'] } as const
    const sessions: { dispose(): Promise<void> }[] = []
    try {
      const open = async () => {
        const opened = await host.services.open({
          source: await openFileArtifactSource(path),
          path,
          intent: 'full',
          grant,
          budget,
        })
        expect(opened.state).toBe('opened')
        if (opened.state !== 'opened') throw new Error('HeightMap did not open')
        expect(opened.selected.contributionId).toBe('blizzard/sc2-height-map')
        sessions.push(opened.session)
        return opened
      }

      const opened = await open()
      const invoked = await opened.session.operations().invoke('set-cell', {
        x: 1,
        y: 0,
        heightBase: 600,
      })
      expect(invoked.state).toBe('ok')
      if (invoked.state !== 'ok') throw new Error('HeightMap edit did not run')
      const editing = createSubjectEditing({
        opened,
        grant,
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'semantic',
          preservesUnknownData: true,
          evidenceId: 'sc2-height-map-native-host-v1',
          corpusId: 'sc2-height-map-native-host',
          corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
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
          optionsFingerprint: 'set-cell-v1',
          inputClass: 'synthetic-hmap-v101',
          provenAt: '2026-09-10T00:00:00Z',
        }) as never,
      })
      const plan = editing.planFromOperation(invoked.output)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') throw new Error('HeightMap edit did not prepare')
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      if (committed.state !== 'committed') throw new Error('HeightMap edit did not commit')

      expect(readHeightMap(new Uint8Array(readFileSync(path))).cells[1]?.heightBase).toBe(600)
      const reopened = await open()
      expect(await reopened.session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { width: 2, height: 2 } },
      })
      expect(await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })).toMatchObject({
        state: 'conflict',
      })

      const undone = await editing.coordinator.undo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })
      expect(undone.state).toBe('committed')
      expect(new Uint8Array(readFileSync(path))).toEqual(original)
      const redone = await editing.coordinator.redo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })
      expect(redone.state).toBe('committed')
      expect(readHeightMap(new Uint8Array(readFileSync(path))).cells[1]?.heightBase).toBe(600)
    } finally {
      for (const session of sessions) await session.dispose()
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
