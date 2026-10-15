/**
 * The CASC extension on a real StarCraft II installation, whatever its build: one entry extracted
 * through the public `container.extract` operation matches the size the storage lists for it, a
 * missing path is refused, listing bounds hold, and every lease is released. (Parity with MK2 on
 * this entry was reached in M4, 2026-09-05; the comparison is no longer run.)
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

const repositoryRoot = join(import.meta.dirname, '..', '..')
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'casc-installation.json'), 'utf8'),
) as {
  installation: {
    environmentVariable: string
    defaultRoot: string
    entry: string
    missingPath: string
  }
  operation: { publicId: string; handlerId: string }
  bounds: { listPrefix: string; listLimit: number; oversizedListLimit: number }
}

const budget = Object.freeze({
  maxInputBytes: 536_870_912n,
  maxDepth: 128,
  maxNodes: 750_000,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 1_000,
})

describe('CASC on an installed StarCraft II', () => {
  it('extracts an entry at its listed size, refuses a missing one and bounds listings', async () => {
    const installRoot = resolve(
      process.env[fixture.installation.environmentVariable] ?? fixture.installation.defaultRoot,
    )
    const extension = await loadExtensionDirectory(join(repositoryRoot, 'casc'))
    const inventory = await buildInventory(
      [{ ...extension, execution: { origin: 'bundled' as const, allowTrustedInProcess: true } }],
      createHostContributionContractRegistry(),
    )
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(installRoot).href)
    const opened = await openSubject({
      inventory,
      executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
      source: artifactNamespaceSourceFromVfsMount(mount),
      path: 'StarCraft II',
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'casc-installation', classes: ['read-source'] },
      budget,
    })
    if (opened.state !== 'opened') throw new Error(`CASC refused: ${opened.reason}`)
    const namespace = await opened.session.dataSource('common.view/namespace-entry-source', 1)
    try {
      expect(opened.selected.contributionId).toBe('blizzard/casc')
      const extract = opened.descriptor.operations.find(item => item.id === fixture.operation.publicId)
      expect(extract && { handlerId: extract.handlerId, state: extract.state }).toEqual({
        handlerId: fixture.operation.handlerId,
        state: 'available',
      })

      const extracted = await opened.session.operations().invoke(fixture.operation.handlerId, {
        entryId: fixture.installation.entry,
      })
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
        throw new Error('container.extract did not return bytes')
      }
      const [listed] = (await namespace.value.list(fixture.installation.entry, { limit: 1 })).items
      expect(listed?.path.toLowerCase()).toBe(fixture.installation.entry)
      expect(extracted.output.value.byteLength).toBe(Number(listed?.size))
      expect(new TextDecoder().decode(extracted.output.value.subarray(0, 5))).toBe('<?xml')

      const missing = await opened.session
        .operations()
        .invoke(fixture.operation.handlerId, { entryId: fixture.installation.missingPath })
        .then(result => result.state, () => 'refused')
      expect(missing).not.toBe('ok')

      const page = await namespace.value.list(fixture.bounds.listPrefix, { limit: fixture.bounds.listLimit })
      expect(page.items.length).toBeLessThanOrEqual(fixture.bounds.listLimit)
      // A page above the CASC budget comes back budget-sized, with a cursor to the rest.
      const oversized = await namespace.value.list('', { limit: fixture.bounds.oversizedListLimit })
      expect(oversized.items.length).toBeLessThan(fixture.bounds.oversizedListLimit)
      expect(oversized.nextCursor).toBeDefined()
    } finally {
      await namespace.release()
      await opened.session.dispose()
      await vfs.dispose()
    }
  }, 180_000)
})
