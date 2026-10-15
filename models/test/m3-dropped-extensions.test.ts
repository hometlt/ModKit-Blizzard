import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
} from '@modkit/uv/model/container'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { findModkitCoreWorkspace } from './workspace-root.js'

const codec = (await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'm3', 'codec.js')).href)) as {
  createCodec: (context: unknown) => unknown
}

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 64 * 1024 * 1024,
  maxDiagnostics: 200,
}
const limits = {
  maxInputBytes: 10 ** 9,
  maxJsonBytes: 2 * 10 ** 8,
  maxDepth: 128,
  maxNodes: 1_000_000,
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
  const uri = 'memory://model.m3'
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

/** The committed triangle, exported to UVM: a document the M3 writer already takes as-is. */
async function baseline(): Promise<UvmContainer> {
  const path = join(
    findModkitCoreWorkspace(import.meta.dirname),
    'packages/testkit/test/fixtures/models/triangle.m3',
  )
  const session = (await (
    codec.createCodec(context) as {
      open: (
        value: unknown,
        mode: string,
        budget: unknown,
      ) => Promise<{
        operations: () => {
          invoke: (
            id: string,
            value: unknown,
          ) => Promise<{ state: string; output: { value: Uint8Array } }>
        }
        dispose: () => Promise<void>
      }>
    }
  ).open(input(new Uint8Array(await readFile(path))), 'inspect', budget))
  const exported = await session
    .operations()
    .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
  await session.dispose()
  expect(exported.state).toBe('ok')
  return readUvmContainer(exported.output.value, limits)
}

function withExtension(container: UvmContainer, name: string, value: unknown): UvmContainer {
  const document = container.document as Record<string, unknown>
  const rewritten = {
    ...container,
    document: {
      ...document,
      extensionsUsed: [...((document['extensionsUsed'] ?? []) as string[]), name],
      extensions: { ...((document['extensions'] ?? {}) as object), [name]: value },
    } as UvmContainer['document'],
  }
  return readUvmContainer(writeUvmContainer(rewritten, limits), limits)
}

describe('extensions StarCraft II has no field for', () => {
  it('converts the model anyway and says what the drop cost', async () => {
    const container = await baseline()
    const plain: string[] = []
    const before = await exportM3FromUvm(container, limits, undefined, plain)
    expect(plain).toEqual([])

    const notes: string[] = []
    const after = await exportM3FromUvm(
      withExtension(container, 'UV_game_model_states', {
        schemaVersion: 1,
        states: [{ state: 'active', model: 'other.m3' }],
      }),
      limits,
      undefined,
      notes,
    )

    // Byte-identical: the dropped extension named a sibling file and said nothing about this
    // mesh, which is the whole reason dropping it is safe rather than merely convenient.
    expect(after).toEqual(before)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/UV_game_model_states was dropped/u)
    expect(notes[0]).toMatch(/base state alone/u)
  }, 60_000)

  it('still refuses an extension it has no answer for', async () => {
    const container = await baseline()
    await expect(
      exportM3FromUvm(withExtension(container, 'UV_invented_by_this_test', { schemaVersion: 1 }), limits),
    ).rejects.toThrow(/UV_invented_by_this_test/u)
  }, 60_000)
})
