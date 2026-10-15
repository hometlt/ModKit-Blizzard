import { describe, expect, it } from 'vitest'
import { createCodec } from '../src/mpq/codec.js'
import {
  encodeFreshMpq,
  encodeFreshMpqCooperative,
  MPQ_FRESH_PACK_UNSUPPORTED,
} from '../src/mpq/fresh-writer.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes: 1_048_576,
  maxDiagnostics: 100,
}

function inputFor(bytes: Uint8Array, revision: string) {
  const uri = 'memory://mpq/container-pack.SC2Map'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single' as const,
    bindings: [
      {
        sourceKind: 'candidate' as const,
        bindingId: 'content',
        role: 'content',
        ownership: 'owned' as const,
        source: source.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: `mpq-pack:${revision}`,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))

function editBytes(result: unknown): Uint8Array {
  const invocation = result as {
    state?: string
    output?: {
      kind?: string
      plan?: {
        edits?: Array<{
          operation?: string
          payload?: { kind?: string; bytes?: Uint8Array }
        }>
      }
    }
  }
  const edit = invocation.output?.plan?.edits?.[0]
  if (
    invocation.state !== 'ok' ||
    invocation.output?.kind !== 'edit-plan' ||
    edit?.operation !== 'replace' ||
    edit.payload?.kind !== 'inline' ||
    !(edit.payload.bytes instanceof Uint8Array)
  ) {
    throw new Error('container.pack did not return one inline replacement')
  }
  return edit.payload.bytes
}

describe('MPQ container.pack', () => {
  it('materializes revision-pinned entry replacements as a whole-container edit plan', async () => {
    const original = encodeFreshMpq([
      { path: 'Objects', bytes: encoder.encode('<PlacedObjects/>') },
      { path: 'MapInfo', bytes: encoder.encode('<MapInfo/>') },
    ])
    const revision = 'content-hash.sha256:mpq-pack-source'
    const session = await (await createCodec()).open(inputFor(original, revision), 'full', budget)
    try {
      const replacement = encoder.encode('<PlacedObjectz/>')
      const packed = await session.operations().invoke('pack-container', {
        schemaVersion: 1,
        expectedContainerRevision: revision,
        replacements: [
          { entryId: 'Objects', expectedRevision: revision, bytesBase64: base64(replacement) },
        ],
        intent: {
          operation: 'blizzard/sc2-map.edit-world',
          input: { archiveMode: 'native-preserving' },
          semanticPlanId: 'semantic-map-plan',
        },
      })
      expect(packed.state).toBe('ok')
      if (packed.state !== 'ok' || packed.output.kind !== 'edit-plan') {
        throw new Error('container.pack did not return an edit plan')
      }
      expect(packed.output.plan.edits).toHaveLength(1)
      const edit = packed.output.plan.edits[0]
      expect(edit).toMatchObject({ operation: 'replace', targetId: 'content' })
      if (edit.operation !== 'replace' || edit.payload.kind !== 'inline') {
        throw new Error('container.pack did not return an inline outer replacement')
      }
      expect(edit.range).toEqual({ kind: 'bytes', offset: 0n, length: BigInt(original.length) })

      const reopened = await (
        await createCodec()
      ).open(inputFor(edit.payload.bytes, 'content-hash.sha256:mpq-pack-output'), 'full', budget)
      try {
        const extracted = await reopened.operations().invoke('extract-entry', { entryId: 'Objects' })
        expect(extracted.state).toBe('ok')
        if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
          throw new Error('reopened MPQ did not extract Objects')
        }
        expect(decoder.decode(extracted.output.value)).toBe('<PlacedObjectz/>')
      } finally {
        await reopened.dispose()
      }

      const deterministic = await session.operations().invoke('pack-container', {
        schemaVersion: 1,
        expectedContainerRevision: revision,
        replacements: [
          { entryId: 'Objects', expectedRevision: revision, bytesBase64: base64(replacement) },
        ],
        intent: {
          operation: 'blizzard/sc2-map.edit-world',
          input: { archiveMode: 'deterministic-rebuild' },
          semanticPlanId: 'semantic-map-plan-deterministic',
        },
      })
      expect(deterministic.state).toBe('ok')
      if (deterministic.state !== 'ok' || deterministic.output.kind !== 'edit-plan') {
        throw new Error('deterministic container.pack did not return an edit plan')
      }
      const deterministicEdit = deterministic.output.plan.edits[0]
      if (deterministicEdit.operation !== 'replace' || deterministicEdit.payload.kind !== 'inline') {
        throw new Error('deterministic container.pack did not return outer bytes')
      }
      expect(deterministicEdit.payload.bytes).not.toEqual(original)
    } finally {
      await session.dispose()
    }
  })

  it('creates one deterministic MPQ from a complete explicit named-file list and reopens it', async () => {
    const original = encodeFreshMpq([{ path: 'Old.txt', bytes: encoder.encode('old') }])
    const revision = 'content-hash.sha256:mpq-create-source'
    const session = await (await createCodec()).open(inputFor(original, revision), 'full', budget)
    try {
      const files = [
        { name: 'readme.txt', bytesBase64: base64(new Uint8Array()) },
        { name: 'Folder/Data.bin', bytesBase64: base64(new Uint8Array([0, 1, 127, 255])) },
        { name: 'MapScript.galaxy', bytesBase64: base64(encoder.encode('void main() {}\r\n')) },
      ]
      const request = (orderedFiles: typeof files) => ({
        schemaVersion: 1,
        mode: 'create',
        expectedContainerRevision: revision,
        files: orderedFiles,
      })
      const forward = await session.operations().invoke('pack-container', request(files))
      const reverse = await session.operations().invoke('pack-container', request([...files].reverse()))
      const created = editBytes(forward)
      expect([...editBytes(reverse)]).toEqual([...created])
      expect(forward).toMatchObject({
        output: {
          plan: {
            fidelity: { roundTrip: 'semantic', preservesUnknownData: false },
            diagnostics: [
              {
                code: 'blizzard/mpq-fresh-pack-receipt',
                message: expect.stringContaining('explicit-named-files-mpq-v0-stored-single-unit'),
              },
            ],
          },
        },
      })

      const reopened = await (
        await createCodec()
      ).open(inputFor(created, 'content-hash.sha256:mpq-create-output'), 'full', budget)
      try {
        const expected = new Map([
          ['readme.txt', new Uint8Array()],
          ['Folder/Data.bin', new Uint8Array([0, 1, 127, 255])],
          ['MapScript.galaxy', encoder.encode('void main() {}\r\n')],
          [
            '(listfile)',
            encoder.encode('Folder\\Data.bin\r\nMapScript.galaxy\r\nreadme.txt\r\n'),
          ],
        ])
        for (const [entryId, value] of expected) {
          const extracted = await reopened.operations().invoke('extract-entry', { entryId })
          expect(extracted).toMatchObject({ state: 'ok', output: { kind: 'bytes', value } })
        }
        await expect(
          reopened.operations().invoke('extract-entry', { entryId: 'Old.txt' }),
        ).rejects.toThrow(/known \{entryId\}/u)
      } finally {
        await reopened.dispose()
      }
    } finally {
      await session.dispose()
    }
  })

  it('creates a valid empty named-file set with only the generated listfile', async () => {
    const original = encodeFreshMpq([{ path: 'Old.txt', bytes: encoder.encode('old') }])
    const revision = 'content-hash.sha256:mpq-create-empty-source'
    const session = await (await createCodec()).open(inputFor(original, revision), 'full', budget)
    try {
      const result = await session.operations().invoke('pack-container', {
        schemaVersion: 1,
        mode: 'create',
        expectedContainerRevision: revision,
        files: [],
      })
      const created = editBytes(result)
      const reopened = await (
        await createCodec()
      ).open(inputFor(created, 'content-hash.sha256:mpq-create-empty-output'), 'full', budget)
      try {
        const extracted = await reopened.operations().invoke('extract-entry', {
          entryId: '(listfile)',
        })
        expect(extracted).toMatchObject({
          state: 'ok',
          output: { kind: 'bytes', value: encoder.encode('\r\n') },
        })
      } finally {
        await reopened.dispose()
      }
    } finally {
      await session.dispose()
    }
  })

  it('rejects unsafe create options, invalid names, duplicates, stale sources and budget overruns', async () => {
    const original = encodeFreshMpq([{ path: 'Old.txt', bytes: new Uint8Array([1]) }])
    const revision = 'content-hash.sha256:mpq-create-validation-source'
    const codec = await createCodec()
    const session = await codec.open(inputFor(original, revision), 'full', budget)
    const invoke = (value: Record<string, unknown>) =>
      session.operations().invoke('pack-container', {
        schemaVersion: 1,
        mode: 'create',
        expectedContainerRevision: revision,
        files: [],
        ...value,
      })
    try {
      const unsupported = invoke({ options: { raw: true, listfile: false, unnamedBlocks: [] } })
      await expect(unsupported).rejects.toThrow(/unsupported field.*options/u)
      await expect(unsupported).rejects.toMatchObject({
        cause: { code: MPQ_FRESH_PACK_UNSUPPORTED },
      })
      await expect(invoke({ mode: 'append' })).rejects.toMatchObject({
        cause: { code: MPQ_FRESH_PACK_UNSUPPORTED },
      })
      await expect(
        invoke({ files: [{ name: '../escape', bytesBase64: '' }] }),
      ).rejects.toThrow(/traversal/u)
      await expect(
        invoke({ files: [{ name: '(listfile)', bytesBase64: '' }] }),
      ).rejects.toThrow(/reserves/u)
      await expect(
        invoke({
          files: [
            { name: 'Data.bin', bytesBase64: '' },
            { name: 'data.BIN', bytesBase64: '' },
          ],
        }),
      ).rejects.toThrow(/duplicate case-insensitive/u)
      await expect(
        invoke({ files: [{ name: 'Data.bin', bytesBase64: 'not-base64' }] }),
      ).rejects.toThrow(/canonical standard base64/u)
      for (const bytesBase64 of ['AB==', 'AAB=']) {
        await expect(
          invoke({ files: [{ name: 'Data.bin', bytesBase64 }] }),
        ).rejects.toThrow(/canonical standard base64/u)
      }
      for (const bytesBase64 of ['AA==', 'AAA=']) {
        await expect(
          invoke({ files: [{ name: 'Data.bin', bytesBase64 }] }),
        ).resolves.toMatchObject({ state: 'ok', output: { kind: 'edit-plan' } })
      }
      await expect(
        invoke({ files: [{ name: 'Data.bin', bytesBase64: '', flags: 0x81000200 }] }),
      ).rejects.toMatchObject({ cause: { code: MPQ_FRESH_PACK_UNSUPPORTED } })
      await expect(
        session.operations().invoke('pack-container', {
          schemaVersion: 1,
          mode: 'create',
          expectedContainerRevision: 'content-hash.sha256:stale',
          files: [],
        }),
      ).rejects.toThrow(/expectedContainerRevision is stale/u)
    } finally {
      await session.dispose()
    }

    const scalarBudget = { ...budget, maxScalarBytes: 1 }
    const scalarSession = await codec.open(inputFor(original, revision), 'full', scalarBudget)
    try {
      await expect(
        scalarSession.operations().invoke('pack-container', {
          schemaVersion: 1,
          mode: 'create',
          expectedContainerRevision: revision,
          files: [{ name: 'Data.bin', bytesBase64: base64(new Uint8Array([1, 2])) }],
        }),
      ).rejects.toThrow(/1-byte bound/u)
    } finally {
      await scalarSession.dispose()
    }

    const nodeBudget = { ...budget, maxNodes: 8 }
    const nodeSession = await codec.open(inputFor(original, revision), 'full', nodeBudget)
    try {
      await expect(
        nodeSession.operations().invoke('pack-container', {
          schemaVersion: 1,
          mode: 'create',
          expectedContainerRevision: revision,
          files: Array.from({ length: 4 }, (_, index) => ({
            name: `File${index}.bin`,
            bytesBase64: '',
          })),
        }),
      ).rejects.toThrow(/node budget/u)
    } finally {
      await nodeSession.dispose()
    }

    const outputBudget = { ...budget, maxInputBytes: 150n, maxScalarBytes: 64 }
    const outputSession = await codec.open(inputFor(original, revision), 'full', outputBudget)
    try {
      await expect(
        outputSession.operations().invoke('pack-container', {
          schemaVersion: 1,
          mode: 'create',
          expectedContainerRevision: revision,
          files: [{ name: 'Data.bin', bytesBase64: base64(new Uint8Array(32)) }],
        }),
      ).rejects.toThrow(/output budget/u)
    } finally {
      await outputSession.dispose()
    }
  })

  it('honors create cancellation before encoding and after cooperative encoding starts', async () => {
    const original = encodeFreshMpq([{ path: 'Old.txt', bytes: new Uint8Array([1]) }])
    const revision = 'content-hash.sha256:mpq-create-cancellation-source'
    const codec = await createCodec()
    const before = new AbortController()
    before.abort()
    await expect(codec.open(inputFor(original, revision), 'full', budget, before.signal)).rejects
      .toHaveProperty('name', 'AbortError')

    const during = new AbortController()
    const session = await codec.open(inputFor(original, revision), 'full', budget, during.signal)
    try {
      const pending = session.operations().invoke('pack-container', {
        schemaVersion: 1,
        mode: 'create',
        expectedContainerRevision: revision,
        files: Array.from({ length: 64 }, (_, index) => ({
          name: `Folder/File${index}.bin`,
          bytesBase64: base64(new Uint8Array([index])),
        })),
      })
      queueMicrotask(() => during.abort())
      await expect(pending).rejects.toMatchObject({ cause: { name: 'AbortError' } })
    } finally {
      await session.dispose()
    }

    const afterStart = new AbortController()
    const largePayload = new Uint8Array(12 * 1_048_576)
    let encoderStarted = false
    let abortScheduled = false
    const entry = {
      path: 'Large.bin',
      get bytes() {
        encoderStarted = true
        if (!abortScheduled) {
          abortScheduled = true
          setTimeout(() => afterStart.abort(), 2)
        }
        return largePayload
      },
    }
    await expect(
      encodeFreshMpqCooperative([entry], 16 * 1_048_576, { signal: afterStart.signal }),
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(encoderStarted).toBe(true)
  })

  it('rejects stale outer and entry revisions', async () => {
    const bytes = encodeFreshMpq([{ path: 'Objects', bytes: encoder.encode('before') }])
    const revision = 'content-hash.sha256:mpq-pack-current'
    const session = await (await createCodec()).open(inputFor(bytes, revision), 'full', budget)
    try {
      await expect(
        session.operations().invoke('pack-container', {
          schemaVersion: 1,
          expectedContainerRevision: 'content-hash.sha256:stale',
          replacements: [
            {
              entryId: 'Objects',
              expectedRevision: revision,
              bytesBase64: base64(encoder.encode('after!')),
            },
          ],
        }),
      ).rejects.toThrow(/expectedContainerRevision is stale/u)

      await expect(
        session.operations().invoke('pack-container', {
          schemaVersion: 1,
          expectedContainerRevision: revision,
          replacements: [
            {
              entryId: 'Objects',
              expectedRevision: 'content-hash.sha256:stale',
              bytesBase64: base64(encoder.encode('after!')),
            },
          ],
        }),
      ).rejects.toThrow(/replacement revision is stale/u)
    } finally {
      await session.dispose()
    }
  })
})
