import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(
  pathToFileURL(join(extension, 'src', 'war3-mdx', 'codec.js')).href
)) as { createCodec: (context: unknown) => { open: (...args: never[]) => Promise<never> } }

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 64 * 1024 * 1024,
  maxDiagnostics: 200,
}

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service is needed')
    },
    async resolveUnknown() {
      throw new Error('no service is needed')
    },
  },
}

function input(bytes: Uint8Array) {
  const uri = 'memory://model.mdx'
  const revision = 'content-hash.sha256:model'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single',
    bindings: [
      {
        sourceKind: 'candidate',
        bindingId: 'content',
        role: 'content',
        ownership: 'owned',
        source: value.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single',
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: uri,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

/**
 * A real Warcraft III model, not a stub.
 *
 * Warcraft III is not installed here, so this is the example model that ships with the
 * repository-local mdx-m3-viewer reference: 3964 bytes of genuine MDLX carrying two attachments
 * and one collision sphere.
 */
const modelPath = join(
  extension,
  '..',
  '..',
  'references',
  'mdx-m3-viewer',
  'clients',
  'example',
  'resources',
  'SmileyGW_004.mdx',
)

async function openModel() {
  const bytes = new Uint8Array(readFileSync(modelPath))
  expect(new TextDecoder('latin1').decode(bytes.subarray(0, 4))).toBe('MDLX')
  return (codec.createCodec(context) as never as {
    open: (input: unknown, mode: string, budget: unknown) => Promise<never>
  }).open(input(bytes), 'inspect', budget)
}

describe('Warcraft III attachment and collision facets', () => {
  it('publishes the attachments the model declares, with their native names', async () => {
    const session = (await openModel()) as never as {
      dataSource: (contract: string, major: number) => Promise<{ value: never; release: () => Promise<void> }>
      dispose: () => Promise<void>
    }
    const lease = await session.dataSource('common.view/model-socket-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ sockets: number; byRole: Record<string, number> }>
      sockets: (page: { limit: number }) => Promise<{ items: readonly { id: string; nodeId: string; role: string; sourceName?: string }[] }>
    }
    expect(await source.info()).toEqual({ sockets: 2, byRole: { origin: 1, overhead: 1 } })
    const sockets = (await source.sockets({ limit: 32 })).items
    // The native name is carried verbatim: scripts reference it by exactly this string.
    expect(sockets.map(socket => socket.sourceName)).toEqual(['Origin Ref', 'Overhead Ref'])
    // Warcraft III declares no forward or up axis for an attachment, so none is claimed.
    expect(sockets.every(socket => !('orientation' in socket))).toBe(true)
    expect(sockets.every(socket => socket.nodeId.length > 0)).toBe(true)
    await lease.release()
    await session.dispose()
  })

  it('publishes collision volumes as declared volumes, by their own kind', async () => {
    const session = (await openModel()) as never as {
      dataSource: (contract: string, major: number) => Promise<{ value: never; release: () => Promise<void> }>
      dispose: () => Promise<void>
    }
    const lease = await session.dataSource('common.view/model-collision-source', 1)
    const source = lease.value as never as {
      info: () => Promise<{ volumes: number; byKind: Record<string, number> }>
      volumes: (page: { limit: number }) => Promise<{ items: readonly { id: string; kind: string; origin: string }[] }>
    }
    expect(await source.info()).toEqual({ volumes: 1, byKind: { sphere: 1 } })
    const volumes = (await source.volumes({ limit: 32 })).items
    expect(volumes[0]?.kind).toBe('sphere')
    // A Warcraft III collision shape is declared, never a mesh carrying a collision role.
    expect(volumes[0]?.origin).toBe('declared-volume')
    await lease.release()
    await session.dispose()
  })
})
