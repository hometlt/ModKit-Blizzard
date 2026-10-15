/**
 * Moving an object on a version 3 SC2Map, as StarCraft II's editor saves it, through the product
 * route: the map codec's edit.world, the MPQ container's container.pack and the host's ordinary
 * editor committing it atomically — then the map reopens with the object where it was put.
 *
 * Version 3 archives repeat each file's sizes in a BET table and keep MD5s of tables, header and
 * raw chunks; a changed Objects document usually outgrows its slot. The maps are the installed
 * game's own Maps folder (smallest version 3 maps with placed units), copied before any write.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  codecFidelityEvidenceRecords,
  createEvidenceRegistry,
  createHostContributionContractRegistry,
  createSubjectEditing,
} from '@modkit/host'
import { createFileEditingBackend, loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import { readNativeMpqSnapshot } from '@modkit/blizzard-mpq/native-preserving'
import { createCodec as createMpqCodec } from '../../mpq/src/mpq/codec.js'
import { createCodec } from '../modules/map/codecs/package/src/codec.js'
import { readObjects } from '../modules/map/shared/format/formats/objects.js'
import { createNamespaceInput } from './support/namespace-input.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'
const budget = { maxInputBytes: 268_435_456n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 67_108_864, maxDiagnostics: 1_000 }
const limits = { maxArchiveBytes: 268_435_456, maxBlocks: 100_000, maxEntryBytes: 67_108_864, maxTotalBytes: 268_435_456 }
const utf8 = new TextDecoder()

/** The two smallest version 3 maps of the installation's Maps folder that place units. */
function versionThreeMaps(): string[] {
  if (process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1') return []
  const folder = join(installation, 'Maps')
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter(name => name.toLowerCase().endsWith('.sc2map'))
    .map(name => join(folder, name))
    .filter(path => {
      if (!statSync(path).isFile()) return false
      const head = readFileSync(path).subarray(0, 16)
      return head.readUInt32LE(0) === 0x1a51504d && head.readUInt16LE(12) === 3
    })
    .sort((left, right) => statSync(left).size - statSync(right).size)
    .slice(0, 4)
}

const objectsOf = (entries: readonly { path: string; bytes: Uint8Array }[]) =>
  readObjects(utf8.decode(entries.find(entry => entry.path.toLowerCase() === 'objects')?.bytes ?? new Uint8Array()))

const maps = versionThreeMaps()

/** What the MPQ codec's manifest proves, as an application's registry reads it from inventory. */
async function mpqEvidence() {
  const inventory = await buildInventory(
    [{ ...(await loadExtensionDirectory(join(import.meta.dirname, '..', '..', 'mpq'))), execution: { origin: 'bundled', allowTrustedInProcess: true } }],
    createHostContributionContractRegistry(),
  )
  return createEvidenceRegistry(codecFidelityEvidenceRecords(inventory, { codecId: 'blizzard/mpq', formatId: 'mpq' }))
}

describe.skipIf(maps.length === 0)('moving an object on a version 3 SC2Map', () => {
  it.each(maps)('commits the move on a copy of %s and reopens it', async installed => {
    const sourceBefore = readFileSync(installed)
    const snapshot = await readNativeMpqSnapshot({ sourceBytes: new Uint8Array(sourceBefore), ...limits })
    const unit = objectsOf(snapshot.entries).units[0]
    if (unit === undefined) return
    const [x, y, z] = unit.position.split(',').map(Number) as [number, number, number]
    const moved = [x + 1, y, z] as const

    const directory = mkdtempSync(join(tmpdir(), 'sc2-map-v3-save-'))
    const path = join(directory, 'Copy.SC2Map')
    copyFileSync(installed, path)
    const backend = createFileEditingBackend({ roots: [directory] })
    const context = {
      budgets: budget,
      diagnostics: { report: () => undefined },
      contracts: { resolve: async () => { throw new Error('no services') }, resolveUnknown: async () => { throw new Error('no services') } },
    }
    try {
      const source = await openFileArtifactSource(path)
      const session = await (await createCodec(context as never)).open(
        createNamespaceInput(Object.fromEntries(snapshot.entries.map(entry => [entry.path, entry.bytes])), {
          revision: String(source.revision),
        }) as never,
        'full',
        budget,
      )
      const container = await (await createMpqCodec()).open(
        {
          originKind: 'single',
          bindings: [{ sourceKind: 'candidate', bindingId: 'content', role: 'content', ownership: 'owned', source: source.ref, revision: source.revision }],
          primaryBindingId: 'content',
          revisions: { topology: 'single', revision: source.revision, bindings: [{ bindingId: 'content', revision: source.revision }], compositionFingerprint: 'sc2-map-v3-save' },
          bindingsFor: () => [],
          openBinding: async () => ({ value: source, release: async () => undefined }),
        } as never,
        'full',
        budget,
      )
      try {
        const semantic = await session.operations().invoke('edit-world', {
          expectedSourceRevision: String(source.revision),
          edits: [{ kind: 'object.update', objectId: Number(unit.id), patch: { position: [...moved] } }],
        })
        if (semantic.state !== 'ok' || semantic.output.kind !== 'edit-plan') throw new Error('edit.world returned no plan')
        const plan = semantic.output.plan as unknown as {
          planId: string
          targets: { targetId: string; ownerSource: { uri: string }; expectedRevision: { bindings: Record<string, string> } }[]
          edits: { targetId: string; payload: { bytes: Uint8Array } }[]
        }
        const replacements = plan.edits.map(edit => {
          const target = plan.targets.find(item => item.targetId === edit.targetId)!
          return {
            entryId: new URL(target.ownerSource.uri).searchParams.get('entry'),
            expectedRevision: Object.values(target.expectedRevision.bindings)[0],
            bytesBase64: Buffer.from(edit.payload.bytes).toString('base64'),
          }
        })
        const packed = await container.operations().invoke('pack-container', {
          schemaVersion: 1,
          expectedContainerRevision: String(source.revision),
          replacements,
          intent: { operation: 'blizzard/sc2-map.edit-world', input: {}, semanticPlanId: plan.planId },
        })
        if (packed.state !== 'ok' || packed.output.kind !== 'edit-plan') {
          throw new Error(`container.pack failed: ${JSON.stringify(packed).slice(0, 400)}`)
        }
        const registry = await mpqEvidence()
        const editing = createSubjectEditing({
          opened: { descriptor: await container.descriptor() } as never,
          grant: { id: 'sc2-map-v3-save', classes: ['read-source', 'write-source'] },
          backendFor: () => backend,
          // The product's evidence: the plan is proven only by what the MPQ codec's manifest declares.
          evidenceFor: plan => {
            const evidence = registry.evidenceFor(plan)
            expect(evidence?.evidenceId).toBe('mpq-container-pack-replace-v1')
            return evidence
          },
        })
        const prepared = await editing.coordinator.prepare(editing.planFromOperation(packed.output), { grant: editing.grantSnapshot })
        if (prepared.state !== 'ready') throw new Error(`prepare: ${JSON.stringify(prepared).slice(0, 400)}`)
        const committed = await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })
        expect(committed.state).toBe('committed')
      } finally {
        await session.dispose()
        await container.dispose()
      }

      // Reopened: the object stands where it was moved, every other entry reads as before.
      const after = await readNativeMpqSnapshot({ sourceBytes: new Uint8Array(readFileSync(path)), ...limits })
      const reopened = objectsOf(after.entries).units.find(item => item.id === unit.id)
      expect(reopened?.position.split(',').map(Number)).toEqual([...moved])
      const drifted = snapshot.entries
        .filter(entry => entry.path.toLowerCase() !== 'objects')
        .filter(entry => {
          const now = after.entries.find(item => item.path === entry.path)?.bytes
          return now === undefined || !Buffer.from(now).equals(Buffer.from(entry.bytes))
        })
        .map(entry => entry.path)
      expect(drifted).toEqual([])
      // The installed map itself is untouched.
      expect(readFileSync(installed).equals(sourceBefore)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 300_000)
})
