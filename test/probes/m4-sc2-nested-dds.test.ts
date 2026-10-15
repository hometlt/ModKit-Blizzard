import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openNestedSubject,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { revisionId, type ArtifactByteSource } from '@modkit/sdk'
import { encodeFreshMpq } from '../../mpq/src/mpq/fresh-writer.js'

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 10_000,
  maxScalarBytes: 8_388_608,
  maxDiagnostics: 100,
  deadlineMs: 10_000,
}

function onePixelDds() {
  const bytes = new Uint8Array(132)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x2053_4444, true)
  view.setUint32(4, 124, true)
  view.setUint32(8, 0x0002_1007, true)
  view.setUint32(12, 1, true)
  view.setUint32(16, 1, true)
  view.setUint32(28, 1, true)
  view.setUint32(76, 32, true)
  view.setUint32(80, 0x41, true)
  view.setUint32(88, 32, true)
  view.setUint32(92, 0x00ff_0000, true)
  view.setUint32(96, 0x0000_ff00, true)
  view.setUint32(100, 0x0000_00ff, true)
  view.setUint32(104, 0xff00_0000, true)
  view.setUint32(108, 0x1000, true)
  bytes.set([0x20, 0x40, 0x80, 0xff], 128)
  return bytes
}

function heightGrid() {
  const bytes = new Uint8Array(32 + 4 * 6)
  bytes.set(new TextEncoder().encode('HMAP'))
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 101, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 2, true)
  return bytes
}

function byteSource(bytes: Uint8Array): ArtifactByteSource {
  const uri = 'memory://sc2-nested-dds/Texture.SC2Map'
  return Object.freeze({
    kind: 'bytes' as const,
    ref: Object.freeze({ id: uri, uri }),
    revision: revisionId('content-hash.sha256:sc2-nested-dds-source'),
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  })
}

describe('SC2 composed namespace nested-resource routing', () => {
  it('reopens a DDS map entry through the core image codec', async () => {
    const coreRoot = resolve(
      process.env.MODKIT_CORE_ROOT ?? join(import.meta.dirname, '..', '..', '..', 'modkit-core'),
    )
    const roots = [
      join(import.meta.dirname, '..', '..', 'mpq'),
      join(import.meta.dirname, '..', '..', 'starcraft2'),
      join(coreRoot, 'extensions', 'images'),
    ]
    const extensions = await Promise.all(
      roots.map(async root => ({
        ...(await loadExtensionDirectory(root)),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      })),
    )
    const inventory = await buildInventory(extensions, createHostContributionContractRegistry())
    const executionBackends = createExecutionBackendRegistry([
      {
        profile: 'trusted-in-process',
        supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
        async activate(context) {
          return {
            module: (await import(context.entrypoint.href)) as Record<string, unknown>,
            release: async () => undefined,
          }
        },
      },
    ])
    const texturePath = 'Assets/Textures/Nested.dds'
    const archive = encodeFreshMpq([
      { path: 'MapInfo', bytes: new TextEncoder().encode('<MapInfo/>') },
      { path: 'Objects', bytes: new TextEncoder().encode('<PlacedObjects/>') },
      { path: 'Regions', bytes: new TextEncoder().encode('<Regions/>') },
      { path: 't3HeightMap', bytes: heightGrid() },
      { path: texturePath, bytes: onePixelDds() },
    ])
    const parent = await openSubject({
      inventory,
      executionBackends,
      source: byteSource(archive),
      path: 'Texture.SC2Map',
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'sc2-nested-dds', classes: ['read-source'] },
      budget,
    })
    if (parent.state !== 'opened') throw new Error(`SC2 map did not open: ${parent.reason}`)
    try {
      expect(parent.selected.contributionId).toBe('blizzard/sc2-map')
      const nested = await openNestedSubject({
        parent: parent.session,
        entryId: texturePath,
        inventory,
        executionBackends,
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
        grant: { id: 'sc2-nested-dds-entry', classes: ['read-source'] },
        budget,
        intent: 'full',
      })
      expect(nested.entry).toMatchObject({ id: texturePath, path: texturePath, kind: 'file' })
      expect(nested.result.state).toBe('opened')
      if (nested.result.state !== 'opened') {
        throw new Error(`DDS nested subject did not open: ${nested.result.reason}`)
      }
      try {
        expect(nested.result.selected.contributionId).toBe('modkit/dds')
        expect(nested.result.descriptor.identity.formatId).toBe('dds')
      } finally {
        await nested.result.session.dispose()
      }
    } finally {
      await parent.session.dispose()
    }
  })
})
