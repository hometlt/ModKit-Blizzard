/** Valid baseline JPEG BLP1 through public Host activation and raster full/crop reads.
 * Reuses SmileyGW read-only; this fixture does not establish installed WoW profile acceptance.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInventory, createExecutionBackendRegistry, createHostContributionContractRegistry,
  openSubject, TRUSTED_IN_PROCESS_EXECUTION_BACKEND } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'
import { revisionId, type ArtifactByteSource, type RasterImageSource } from '@modkit/sdk'

const budget = { maxInputBytes: 32_000_000n, maxScalarBytes: 32_000_000,
  maxDepth: 64, maxNodes: 100_000, maxDiagnostics: 100 }

/** Pin the unchanged reference's bytes as a Host artifact, without a private decoder. */
function fixture(): ArtifactByteSource {
  const bytes = new Uint8Array(readFileSync(new URL('../../../references/mdx-m3-viewer/clients/example/resources/Textures/SmileyGW.blp', import.meta.url)))
  const digest = createHash('sha256').update(bytes).digest('hex')
  expect(digest).toBe('02f9920c49cada88df00101a0d176b5d127dfef1ee705e36e6fd576d821c91dd')
  return { kind: 'bytes', ref: { id: 'blp-jpeg-fixture', uri: 'memory://SmileyGW.blp' },
    revision: revisionId(`content-hash.sha256:${digest}`), size: BigInt(bytes.byteLength),
    async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length) },
    async *stream() { yield bytes },
  }
}

describe('JPEG BLP1 Host pixels', () => {
  it.each(['trusted-node', 'portable'] as const)('reads full RGBA and identical crops through %s', async variant => {
    const input = await loadExtensionDirectory(fileURLToPath(new URL('../', import.meta.url)))
    const inventory = await buildInventory([{ ...input,
      execution: { origin: 'bundled', allowTrustedInProcess: true } }], createHostContributionContractRegistry())
    const result = await openSubject({ inventory, source: fixture(), path: 'SmileyGW.blp', intent: 'full',
      target: { environment: variant === 'portable' ? 'node-worker' : 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: `blp-jpeg:${variant}`, classes: ['read-source'] }, budget,
      executionBackends: createExecutionBackendRegistry(variant === 'portable'
        ? [createNodeWorkerBackend()] : [TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
    })
    expect(result.state).toBe('opened')
    if (result.state !== 'opened') throw new Error(JSON.stringify(result))
    try {
      expect(result.selected.contributionId).toBe('blizzard/blp')
      const lease = await result.session.dataSource('common.view/raster-image-source', 1)
      try {
        const raster = lease.value as RasterImageSource
        expect(await raster.info()).toMatchObject({ width: 256, height: 256, decodedAccess: true })
        const full = await raster.readRegion!({ x: 0, y: 0, width: 256, height: 256, pixelFormat: 'rgba8', maxBytes: 256 * 256 * 4 })
        expect(full.pixels.byteLength).toBe(256 * 256 * 4)
        const cheek = (150 * 256 + 40) * 4
        expect(full.pixels[cheek]).toBeGreaterThan(200)
        expect(full.pixels[cheek + 1]).toBeGreaterThan(150)
        expect(full.pixels[cheek + 2]).toBeLessThan(80)
        expect(full.pixels[cheek + 3]).toBeGreaterThan(200)
        expect(full.pixels[(2 * 256 + 2) * 4 + 3]).toBeLessThan(60)
        const crop = await raster.readRegion!({ x: 40, y: 150, width: 3, height: 2, pixelFormat: 'rgba8', maxBytes: 24 })
        for (let row = 0; row < 2; row += 1) {
          const start = ((150 + row) * 256 + 40) * 4
          expect(crop.pixels.subarray(row * 12, (row + 1) * 12)).toEqual(full.pixels.subarray(start, start + 12))
        }
      } finally { await lease.release() }
    } finally { await result.session.dispose() }
  })
})
