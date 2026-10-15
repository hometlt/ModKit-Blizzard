/** Top-level MDX write admission; nested records and MDL unknown blocks need separate coverage. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildInventory, createExecutionBackendRegistry, createHostContributionContractRegistry, openSubject } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'
import { authoredModelBytes, budget, extension, fixturePath, inspect, open, source } from './war3-harness.js'

/** Append a bounded opaque chunk whose semantics the native parser does not implement. */
async function modelWithOpaqueChunk() {
  const fixture = new Uint8Array(await readFile(fixturePath))
  const chunk = Uint8Array.of(0x58, 0x54, 0x52, 0x41, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef)
  const bytes = new Uint8Array(fixture.length + chunk.length)
  bytes.set(fixture)
  bytes.set(chunk, fixture.length)
  return bytes
}

describe('MDX write preservation admission', () => {
  it('refuses the same data loss through the actual Host portable worker', async () => {
    const bytes = await modelWithOpaqueChunk()
    const inventory = await buildInventory([await loadExtensionDirectory(extension)], createHostContributionContractRegistry())
    const opened = await openSubject({ inventory, source: source(bytes), path: 'opaque.mdx', intent: 'full',
      target: { environment: 'node-worker', operatingSystem: 'windows', architecture: 'x64' },
      executionBackends: createExecutionBackendRegistry([createNodeWorkerBackend()]),
      grant: { id: 'wc3-opaque-write-worker', classes: ['read-source'] }, budget })
    if (opened.state !== 'opened') throw new Error(`opaque model did not open in worker: ${JSON.stringify(opened).slice(0, 1000)}`)
    try {
      expect(opened.selected.variantId).toBe('portable')
      for (const encoding of ['mdx', 'mdl']) {
        const invoked = opened.session.operations().invoke('model-write', { schemaVersion: 1, encoding }).then(result => {
          if (result.state === 'ok' && result.output.kind === 'bytes')
            throw new Error(`Host portable model.write published ${String((result.output.value as Uint8Array).length)} bytes from ${String(bytes.length)}-byte XTRA input instead of refusing`)
          return result
        })
        await expect(invoked)
          .rejects.toThrow(/cannot preserve MDX XTRA chunk at byte/)
      }
    } finally { await opened.session.dispose() }
  })

  it.each(['mdx', 'mdl'])('keeps an opaque chunk readable but refuses its silent omission in %s', async encoding => {
    const bytes = await modelWithOpaqueChunk()
    const before = bytes.slice()
    const session = await open(bytes)
    try {
      expect(await inspect(session)).toMatchObject({ encoding: 'mdx', chunks: 3, geosets: 0 })
      await expect(session.operations().invoke('model-write', { schemaVersion: 1, encoding }))
        .rejects.toThrow(/cannot preserve MDX XTRA chunk at byte/)
      expect(await inspect(session)).toMatchObject({ chunks: 3 })
      expect(bytes).toEqual(before)
    } finally { await session.dispose() }
  })

  it('rejects a truncated opaque chunk before native parsing', async () => {
    const bytes = await modelWithOpaqueChunk()
    await expect(open(bytes.subarray(0, bytes.length - 1))).rejects.toThrow(/MDX XTRA chunk is out of bounds/)
  })

  it('does not publish output for a cancelled write', async () => {
    const session = await open(new Uint8Array(await readFile(fixturePath)))
    try {
      const controller = new AbortController()
      controller.abort(new Error('cancelled preservation test'))
      const result = await session.operations().invoke('model-write', { schemaVersion: 1, encoding: 'mdx' }, { signal: controller.signal })
      expect(result).toMatchObject({ state: 'rejected', reason: 'cancelled' })
      expect(result).not.toHaveProperty('output')
    } finally { await session.dispose() }
  })

  it('accepts the existing native writer known-chunk control in both formats', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    try {
      for (const encoding of ['mdx', 'mdl']) {
        const result = await session.operations().invoke('model-write', { schemaVersion: 1, encoding })
        if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('known-chunk control failed')
        const reopened = await open(result.output.value as Uint8Array)
        try { expect(await inspect(reopened)).toMatchObject({ encoding, geosets: 1, bones: 1, sequences: 1 }) }
        finally { await reopened.dispose() }
      }
    } finally { await session.dispose() }
  })
})
