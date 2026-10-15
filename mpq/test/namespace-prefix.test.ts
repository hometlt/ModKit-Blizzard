import { describe, expect, it } from 'vitest'
import { createCodec } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes: 1_048_576,
  maxDiagnostics: 100,
}

function inputFor(bytes: Uint8Array, revision: string) {
  const uri = 'memory://mpq/namespace-prefix.SC2Map'
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
      compositionFingerprint: `mpq-namespace-prefix:${revision}`,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

describe('MPQ namespace prefixes', () => {
  it('lists what is under a prefix, not siblings whose name starts with it', async () => {
    // The host rejects an entry outside the requested prefix, which used to fail whole maps whose
    // archives hold both «Assets/Crystal/...» and «Assets/Crystal_Death/...».
    const archive = encodeFreshMpq([
      { path: 'Assets/Crystal/model.m3', bytes: encoder.encode('a') },
      { path: 'Assets/Crystal_Death/model.m3', bytes: encoder.encode('b') },
      { path: 'Assets/Crystal', bytes: encoder.encode('c') },
      { path: 'MapInfo', bytes: encoder.encode('<MapInfo/>') },
    ])
    const revision = 'content-hash.sha256:mpq-namespace-prefix'
    const session = await (
      await createCodec()
    ).open(inputFor(archive, revision) as never, 'full', budget as never)
    try {
      const lease = await session.dataSource('common.view/namespace-entry-source', 1)
      try {
        const page = await lease.value.list('Assets/Crystal', { limit: 16 })
        expect(page.items.map((item: { path: string }) => item.path).sort()).toEqual([
          'Assets/Crystal',
          'Assets/Crystal/model.m3',
        ])
        const all = await lease.value.list('', { limit: 16 })
        expect(all.items.map((item: { path: string }) => item.path)).toEqual(
          expect.arrayContaining(['Assets/Crystal_Death/model.m3', 'MapInfo']),
        )
        // The archive's own (listfile) is hidden; content is not.
        const hidden = (path: string) =>
          all.items.find((item: { path: string }) => item.path === path)?.hidden
        expect(hidden('(listfile)')).toBe(true)
        expect(hidden('MapInfo')).toBeUndefined()
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })
})
