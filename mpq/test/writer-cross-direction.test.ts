import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createCodec } from '../src/mpq/codec.js'
import { encodeFreshMpq, encodeFreshMpqCooperative } from '../src/mpq/fresh-writer.js'
import { readNativeMpqSnapshot } from '../src/mpq/native-preserving.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const entries = [
  { path: 'Alpha.txt', bytes: encoder.encode('alpha') },
  { path: 'Data/Repeated.bin', bytes: encoder.encode('SC2'.repeat(100)) },
]
/** What the MK2 writer produced for `entries` (parity with it was reached in M4, 2026-09-05). */
const frozenMk2Writer = Uint8Array.from(
  Buffer.from(
    'TVBRGiAAAAB8AQAAAAADAEwAAABMAQAAEAAAAAMAAABhbHBoYQILdjYaRUQiAEFscGhhLnR4dA0KRGF0YVxSZXBlYXRlZC5iaW4NCjMww3ko2TKYvHNvn7KITukXogSExEC/ymO/e5gM5xl+h8zNQRs3Wnlfj20Ckh/5iQlUt6xyEMgZUwEnW+VEfuuq5KNTt9VGjrby9cy/hNpBQP+HhXIA/2HXETyahKjkpyMfThrMPjg67fqcib9xs+jErH73EaF6rVApo9KZji79WkRdq8zofEJxBXeKXg9+n9LnjgdNLAUxUQi0uWL5vcSh3d+bju0B3m0FFBRW7rpst5t1DMkroMYOqAKTmwV+ubMPMfmNJYnG0ZnDBuC6v7Mj7KXMUMyJJ2+8l46YhbU3ORvDNoubnToQEK6G3W2WIpyPOOtlvnAopm3lPpg7CkerZ0g9pNMIyt26NfhzcjPp76iisyLfmg6viv/GjZScsSsPif/LqVZqGMw0iuBp8UY=',
    'base64',
  ),
)

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes: 1_048_576,
  maxDiagnostics: 100,
}

function inputFor(bytes: Uint8Array) {
  const revision = 'content-hash.sha256:writer-cross-direction'
  const uri = 'memory://mpq/writer-cross-direction.mpq'
  const source = {
    kind: 'bytes' as const,
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
      compositionFingerprint: revision,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

async function readWithCodec(bytes: Uint8Array, entryId: string) {
  const session = await (await createCodec()).open(inputFor(bytes), 'full', budget)
  try {
    const result = await session.operations().invoke('extract-entry', { entryId })
    if (result.state !== 'ok' || result.output.kind !== 'bytes') {
      throw new Error(`MPQ entry ${entryId} did not decode`)
    }
    return result.output.value
  } finally {
    await session.dispose()
  }
}

describe('MPQ writer vectors', () => {
  it('reads the archive the MK2 writer produced', async () => {
    expect(createHash('sha256').update(frozenMk2Writer).digest('hex')).toBe(
      '6352323df397b2706c2ac808f06ed3cb779b232d89ac1918fd42475e3e1b4164',
    )
    await expect(readWithCodec(frozenMk2Writer, 'Alpha.txt')).resolves.toEqual(entries[0].bytes)
    await expect(readWithCodec(frozenMk2Writer, 'Data/Repeated.bin')).resolves.toEqual(
      entries[1].bytes,
    )
  })

  it('keeps the production writer deterministic and readable by the independent native reader', async () => {
    const first = encodeFreshMpq(entries)
    const second = encodeFreshMpq([...entries].reverse())
    const cooperative = await encodeFreshMpqCooperative(entries)
    expect(second).toEqual(first)
    expect(cooperative).toEqual(first)
    expect(first.byteLength).toBe(543)
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      'bceeadd4f289d0870f64f2f41decf676ea984b857e1d3c14ed6783c54c003a5e',
    )
    const snapshot = await readNativeMpqSnapshot({ sourceBytes: first })
    expect(snapshot.completeNamedSnapshot).toBe(true)
    expect(snapshot.entries.map(entry => [entry.path, decoder.decode(entry.bytes)])).toEqual([
      ['Alpha.txt', 'alpha'],
      ['Data/Repeated.bin', 'SC2'.repeat(100)],
    ])

    await expect(readWithCodec(encodeFreshMpq([]), '(listfile)')).resolves.toBeInstanceOf(Uint8Array)
  })

  it('bounds cooperative yields for many small entries while preserving exact bytes', async () => {
    const many = Array.from({ length: 4_096 }, (_, index) => ({
      path: `Small/${String(index).padStart(5, '0')}.bin`,
      bytes: new Uint8Array([index & 0xff]),
    }))
    const sync = encodeFreshMpq(many, 8_388_608)
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const cooperative = await encodeFreshMpqCooperative(many, 8_388_608)
      expect(cooperative).toEqual(sync)
      expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0)
      expect(timeoutSpy.mock.calls.length).toBeLessThan(100)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('fails closed for malformed vectors and unsafe writer requests', async () => {
    const corrupt = frozenMk2Writer.slice()
    corrupt[0] = 0
    await expect(readWithCodec(corrupt, 'Alpha.txt')).rejects.toThrow(/magic is missing/u)
    expect(() =>
      encodeFreshMpq([
        { path: 'Alpha.txt', bytes: encoder.encode('one') },
        { path: 'alpha.TXT', bytes: encoder.encode('two') },
      ]),
    ).toThrow(/duplicate case-insensitive/u)
    expect(() => encodeFreshMpq([{ path: '../escape', bytes: new Uint8Array([1]) }])).toThrow(
      /traversal/u,
    )
    expect(() => encodeFreshMpq(entries, 64)).toThrow(/output budget|source payloads/u)
  })
})
