import { describe, expect, it } from 'vitest'
import { HASH_TYPE, mpqDecrypt, mpqEncrypt, mpqHash } from '@modkit/codec-kit/crypto'
import { createCodec } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'

const FILE_COMPRESS = 0x00000200
const FILE_SINGLE_UNIT = 0x01000000
const FILE_EXISTS = 0x80000000
const encoder = new TextEncoder()

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function blockIndexFor(hashTable: Uint8Array, entries: number, path: string) {
  const normalized = path.replaceAll('/', '\\')
  const view = new DataView(hashTable.buffer, hashTable.byteOffset, hashTable.byteLength)
  const hashA = mpqHash(normalized, HASH_TYPE.HASH_A)
  const hashB = mpqHash(normalized, HASH_TYPE.HASH_B)
  const start = mpqHash(normalized, HASH_TYPE.TABLE_OFFSET) % entries
  for (let probe = 0; probe < entries; probe += 1) {
    const offset = ((start + probe) % entries) * 16
    const blockIndex = view.getUint32(offset + 12, true)
    if (blockIndex === 0xffffffff) break
    if (
      blockIndex !== 0xfffffffe &&
      view.getUint32(offset, true) === hashA &&
      view.getUint32(offset + 4, true) === hashB
    ) {
      return blockIndex
    }
  }
  throw new Error(`test fixture has no block for ${path}`)
}

function replaceEncoding(
  fresh: Uint8Array,
  path: string,
  encoded: Uint8Array,
  originalSize: number,
  flags: number,
) {
  const output = fresh.slice()
  const hashOffset = u32(output, 16)
  const blockOffset = u32(output, 20)
  const hashEntries = u32(output, 24)
  const blockEntries = u32(output, 28)
  const hashTable = mpqDecrypt(
    output.slice(hashOffset, hashOffset + hashEntries * 16),
    mpqHash('(hash table)', HASH_TYPE.TABLE),
  )
  const blockIndex = blockIndexFor(hashTable, hashEntries, path)
  const blockTable = mpqDecrypt(
    output.slice(blockOffset, blockOffset + blockEntries * 16),
    mpqHash('(block table)', HASH_TYPE.TABLE),
  )
  const view = new DataView(blockTable.buffer, blockTable.byteOffset, blockTable.byteLength)
  const entryOffset = blockIndex * 16
  const payloadOffset = view.getUint32(entryOffset, true)
  const capacity = view.getUint32(entryOffset + 4, true)
  if (encoded.byteLength > capacity) throw new Error('test encoding exceeds its fixture slot')
  output.fill(0, payloadOffset, payloadOffset + capacity)
  output.set(encoded, payloadOffset)
  view.setUint32(entryOffset + 4, encoded.byteLength, true)
  view.setUint32(entryOffset + 8, originalSize, true)
  view.setUint32(entryOffset + 12, flags >>> 0, true)
  output.set(mpqEncrypt(blockTable, mpqHash('(block table)', HASH_TYPE.TABLE)), blockOffset)
  return output
}

function inputFor(bytes: Uint8Array, revision = 'content-hash.sha256:bzip2-fixture') {
  const uri = 'memory://mpq/bzip2-fixture.SC2Replay'
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

const budget = (maxScalarBytes = 16_384) => ({
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes,
  maxDiagnostics: 100,
})

async function extract(bytes: Uint8Array, entryId: string, maxScalarBytes = 16_384) {
  const session = await (await createCodec()).open(inputFor(bytes), 'full', budget(maxScalarBytes))
  try {
    return await session.operations().invoke('extract-entry', { entryId })
  } finally {
    await session.dispose()
  }
}

describe('MPQ bzip2 extraction', () => {
  it('decodes a single-unit bzip2 entry through the production compression helper', async () => {
    const plain = encoder.encode('SC2 replay bzip2 stream\n'.repeat(20))
    const compressed = fromBase64(
      'QlpoOTFBWSZTWYCcA18AAE/fgAAQQAAQAAgACAAyJlwwIABwUNNMAAUqiM1Gnqaep0T8TyJwTJME5J0TJPZPomiYJknZME0TAmicE0T+LuSKcKEhATgGvg==',
    )
    const encoded = Uint8Array.from([0x10, ...compressed])
    const archive = replaceEncoding(
      encodeFreshMpq([{ path: 'replay.details', bytes: plain }]),
      'replay.details',
      encoded,
      plain.byteLength,
      FILE_EXISTS | FILE_SINGLE_UNIT | FILE_COMPRESS,
    )
    const result = await extract(archive, 'replay.details')
    expect(result).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: plain } })
  })

  it('decodes independently bounded bzip2 sectors', async () => {
    const plain = encoder.encode('0123456789abcdef'.repeat(320))
    const first = fromBase64(
      'QlpoOTFBWSZTWVIv4QsAAH+JAH/gPwAgAHBTAATQKqAmAmdAIgEgCYBQAqAfAFgC4BgAyAaANgHAD8A6AeF3JFOFCQUi/hCw',
    )
    const second = fromBase64(
      'QlpoOTFBWSZTWdChaeYAAB+JAH/gPwAgAHBTAATQKqAmAmdAiBICYFAKgfAWAuBgDIGgNgcA/A6B4XckU4UJDQoWnmA=',
    )
    const tableBytes = 12
    const firstOffset = tableBytes
    const secondOffset = firstOffset + first.byteLength + 1
    const endOffset = secondOffset + second.byteLength + 1
    const encoded = new Uint8Array(endOffset)
    const view = new DataView(encoded.buffer)
    view.setUint32(0, firstOffset, true)
    view.setUint32(4, secondOffset, true)
    view.setUint32(8, endOffset, true)
    encoded.set(Uint8Array.from([0x10, ...first]), firstOffset)
    encoded.set(Uint8Array.from([0x10, ...second]), secondOffset)
    const archive = replaceEncoding(
      encodeFreshMpq([{ path: 'replay.game.events', bytes: plain }]),
      'replay.game.events',
      encoded,
      plain.byteLength,
      FILE_EXISTS | FILE_COMPRESS,
    )
    const result = await extract(archive, 'replay.game.events')
    expect(result).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: plain } })
  })

  it('fails closed on corrupt bzip2, unknown methods, and decode-budget overruns', async () => {
    const plain = encoder.encode('SC2 replay bzip2 stream\n'.repeat(20))
    const compressed = fromBase64(
      'QlpoOTFBWSZTWYCcA18AAE/fgAAQQAAQAAgACAAyJlwwIABwUNNMAAUqiM1Gnqaep0T8TyJwTJME5J0TJPZPomiYJknZME0TAmicE0T+LuSKcKEhATgGvg==',
    )
    const valid = Uint8Array.from([0x10, ...compressed])
    const fixture = (encoded: Uint8Array) =>
      replaceEncoding(
        encodeFreshMpq([{ path: 'replay.details', bytes: plain }]),
        'replay.details',
        encoded,
        plain.byteLength,
        FILE_EXISTS | FILE_SINGLE_UNIT | FILE_COMPRESS,
      )
    const corrupt = valid.slice()
    corrupt[corrupt.length - 3] ^= 0xff
    await expect(extract(fixture(corrupt), 'replay.details')).rejects.toThrow()
    await expect(extract(fixture(Uint8Array.from([0x20, ...compressed])), 'replay.details')).rejects
      .toThrow(/compression 0x20 is not supported/u)
    await expect(extract(fixture(valid), 'replay.details', plain.byteLength - 1)).rejects.toThrow(
      /decode budget/u,
    )
  })

  it('stops raw-deflate output at the declared entry-size bound', async () => {
    const plain = encoder.encode('A'.repeat(10_000))
    const encoded = Uint8Array.from([0x02, ...deflateRawSync(plain)])
    const archive = replaceEncoding(
      encodeFreshMpq([{ path: 'replay.details', bytes: plain }]),
      'replay.details',
      encoded,
      32,
      FILE_EXISTS | FILE_SINGLE_UNIT | FILE_COMPRESS,
    )
    await expect(extract(archive, 'replay.details')).rejects.toThrow(/deflate output exceeds/u)
  })
})
import { deflateRawSync } from 'node:zlib'
