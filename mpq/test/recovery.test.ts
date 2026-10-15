import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MPQ_RECOVERED_WRITE_UNSUPPORTED,
  MPQ_RECOVERY_FAILED,
  MPQ_RECOVERY_LIMIT,
  recoverArchive,
} from '@modkit/blizzard-mpq/recovery'
import { createCodec } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'

const TRUNCATED_BASE64 =
  'TVBRGiAAAADEAgAAAAADAAQCAACEAgAACAAAAAQAAAACeNpLzCnISFQoSk3OL0stqlQoSKzMyU9MAQBiNAigAAAAAAAAAAAAAAAAAAAAAAJ42gEAAf/+AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/632f4EAAAAAAAAAAAAAAAAAAAAAAnjas3FPzM1NVMhMsVUqSk3OL0stSk1R0rcDAF2xB7oAAAAAAAAAAAAAAAAAAAAAAnjacywuTi0pjglJrSgpLUotjnHMKchIhPL0UlKKebmcEotT9YKdjVwSSxJj3BNzU8GM0LzMEhBDryI3h5crOLkoswBojG9iAYSpl56Yk1hRycsFALzYItAAAAAAAAAAAAAAAAAAAAAA'
const CORRUPT_POINTER_BASE64 =
  'TVBRGiAAAADAEAAAAAADAAAQAACAEAAACAAAAAQAAAACeNpLzCnISFQoSk3OL0stqlQoSKzMyU9MAQBiNAigAAAAAAAAAAAAAAAAAAAAAAJ42gEAAf/+AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/632f4EAAAAAAAAAAAAAAAAAAAAAAnjas3FPzM1NVMhMsVUqSk3OL0stSk1R0rcDAF2xB7oAAAAAAAAAAAAAAAAAAAAAAnjacywuTi0pjglJrSgpLUotjnHMKchIhPL0UlKKebmcEotT9YKdjVwSSxJj3BNzU8GM0LzMEhBDryI3h5crOLkoswBojG9iAYSpl56Yk1hRycsFALzYItAAAAAAAAAAAAAAAAAAAAAA'

const encoder = new TextEncoder()
const hints = [
  'Assets\\Textures\\AlphaTexture.dds',
  'Base.SC2Data\\GameData\\UnitData.xml',
  'Scripts\\MapScript.galaxy',
]
const expectedPayloads = [
  encoder.encode('alpha recovery payload'),
  Uint8Array.from({ length: 256 }, (_, index) => index),
  encoder.encode('<Gamma id="recovered"/>'),
  encoder.encode(`${hints.join('\r\n')}\r\n`),
]

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function headerFor(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    offset: 0,
    userDataBytes: 0,
    headerSize: view.getUint32(4, true),
    archivedSize: view.getUint32(8, true),
    version: view.getUint16(12, true),
    sectorShift: view.getUint16(14, true),
    hashOffset: view.getUint32(16, true),
    blockOffset: view.getUint32(20, true),
    hashEntries: view.getUint32(24, true),
    blockEntries: view.getUint32(28, true),
  }
}

function inputFor(bytes: Uint8Array, revision = `content-hash.sha256:${digest(bytes)}`) {
  const uri = 'memory://mpq/recovery.SC2Map'
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
      compositionFingerprint: revision,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes: 1_048_576,
  maxDiagnostics: 100,
}

function tablelessArchive(encoded: Uint8Array) {
  const bytes = new Uint8Array(32 + encoded.byteLength + 16)
  bytes.set([0x4d, 0x50, 0x51, 0x1a])
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 32, true)
  view.setUint32(8, bytes.byteLength + 192, true)
  view.setUint16(12, 0, true)
  view.setUint16(14, 3, true)
  view.setUint32(16, bytes.byteLength, true)
  view.setUint32(20, bytes.byteLength + 128, true)
  view.setUint32(24, 8, true)
  view.setUint32(28, 1, true)
  bytes.set(encoded, 32)
  return bytes
}

describe('bounded MPQ recovery', () => {
  it('exports the public recovery surface and exactly recovers the fixed truncated vector', async () => {
    const bytes = fromBase64(TRUNCATED_BASE64)
    expect(bytes.byteLength).toBe(516)
    expect(digest(bytes)).toBe(
      '383535974c2764ff7910abcc57aef86050b28698444b6e1b0a43a459c9b21534',
    )

    const result = await recoverArchive(bytes, headerFor(bytes))
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'mpq-compressed-block-recovery-v1',
      recovery: true,
      complete: false,
      scanStart: 32,
      scanEnd: 516,
      scanBytes: 484,
      recoveredBlocks: 4,
      decodeAttempts: 4,
      decodedBytes: 397,
      unverifiedListfileHints: hints,
    })
    expect(result.entries.map(entry => entry.id)).toEqual([
      'recovered/block/0000',
      'recovered/block/0001',
      'recovered/block/0002',
      'recovered/block/0003',
    ])
    expect(result.entries.map(entry => entry.offset)).toEqual([32, 79, 363, 411])
    expect(result.entries.map(entry => entry.archivedSize)).toEqual([31, 268, 32, 89])
    expect(result.entries.map(entry => entry.method)).toEqual(['zlib', 'zlib', 'zlib', 'zlib'])
    expect(result.entries.map(entry => entry.bytes)).toEqual(expectedPayloads)
    expect(result.entries.every(entry => !('path' in entry) && !('hash' in entry))).toBe(true)
  })

  it.each([
    ['truncated tables', TRUNCATED_BASE64],
    ['corrupt table pointers', CORRUPT_POINTER_BASE64],
  ])('recovers through ordinary codec open for %s', async (_label, encoded) => {
    const bytes = fromBase64(encoded)
    if (encoded === CORRUPT_POINTER_BASE64) {
      expect(digest(bytes)).toBe('ba5fcba1249c8423e55e0d09d180c0b02f46f34cf86325bccd6841618feb1a1e')
    }
    const session = await (await createCodec()).open(inputFor(bytes), 'full', budget)
    try {
      const inspected = await session.operations().invoke('inspect', {})
      expect(inspected).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            format: 'mpq',
            entries: 4,
            recovery: true,
            complete: false,
            recoveredBlocks: 4,
            unverifiedListfileHints: hints,
          },
        },
      })
      for (const [index, expected] of expectedPayloads.entries()) {
        const extracted = await session.operations().invoke('extract-entry', {
          entryId: `recovered/block/${String(index).padStart(4, '0')}`,
        })
        expect(extracted).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: expected } })
      }
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw).toMatchObject({ state: 'ok', output: { kind: 'bytes', value: bytes } })
      const writeAttempt = session.operations().invoke('pack-container', {
        schemaVersion: 1,
        expectedContainerRevision: `content-hash.sha256:${digest(bytes)}`,
        replacements: [],
      })
      await expect(writeAttempt).rejects.toThrow(/recovered MPQ archives are read-only/u)
      await expect(writeAttempt).rejects.toMatchObject({
        cause: { code: MPQ_RECOVERED_WRITE_UNSUPPORTED },
      })
    } finally {
      await session.dispose()
    }
  })

  it('recovers a complete independently validated bzip2 block', async () => {
    const plain = encoder.encode('SC2 replay bzip2 stream\n'.repeat(20))
    const compressed = fromBase64(
      'QlpoOTFBWSZTWYCcA18AAE/fgAAQQAAQAAgACAAyJlwwIABwUNNMAAUqiM1Gnqaep0T8TyJwTJME5J0TJPZPomiYJknZME0TAmicE0T+LuSKcKEhATgGvg==',
    )
    const bytes = tablelessArchive(Uint8Array.from([0x10, ...compressed]))
    const result = await recoverArchive(bytes, headerFor(bytes))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      id: 'recovered/block/0000',
      method: 'bzip2',
      bytes: plain,
    })
  })

  it('fails closed on stored, corrupt, and incomplete data', async () => {
    const stored = encodeFreshMpq([{ path: 'Objects', bytes: encoder.encode('stored payload') }])
    const storedHeader = headerFor(stored)
    const tablelessStored = stored.slice(0, storedHeader.hashOffset)
    await expect(recoverArchive(tablelessStored, headerFor(tablelessStored))).rejects.toMatchObject({
      code: MPQ_RECOVERY_FAILED,
    })

    const corrupt = fromBase64(TRUNCATED_BASE64)
    corrupt[62] ^= 0xff
    await expect(recoverArchive(corrupt, headerFor(corrupt))).rejects.toMatchObject({
      code: MPQ_RECOVERY_FAILED,
    })

    const partial = fromBase64(TRUNCATED_BASE64).slice(0, -8)
    await expect(recoverArchive(partial, headerFor(partial))).rejects.toMatchObject({
      code: MPQ_RECOVERY_FAILED,
    })
  })

  it('enforces scan, candidate, boundary, block, decode, entry, and total-output caps', async () => {
    const bytes = fromBase64(TRUNCATED_BASE64)
    const header = headerFor(bytes)
    const capOptions = [
      { maxScanBytes: 100 },
      { maxCandidates: 3 },
      { maxBlocks: 3 },
      { maxDecodeAttempts: 3 },
      { maxDecodedEntryBytes: 128 },
      { maxTotalDecodedBytes: 300 },
    ]
    for (const options of capOptions) {
      await expect(recoverArchive(bytes, header, options)).rejects.toMatchObject({
        code: MPQ_RECOVERY_LIMIT,
      })
    }

    const falseBoundary = bytes.slice()
    falseBoundary.set([0x02, 0x78, 0x9c], 64)
    await expect(
      recoverArchive(falseBoundary, headerFor(falseBoundary), { maxBoundaryCandidates: 1 }),
    ).rejects.toMatchObject({ code: MPQ_RECOVERY_FAILED })
    const recovered = await recoverArchive(falseBoundary, headerFor(falseBoundary), {
      maxBoundaryCandidates: 2,
    })
    expect(recovered.recoveredBlocks).toBe(4)
  })

  it('honors cancellation before and during a bounded scan', async () => {
    const bytes = fromBase64(TRUNCATED_BASE64)
    const before = new AbortController()
    before.abort()
    await expect(
      recoverArchive(bytes, headerFor(bytes), { signal: before.signal }),
    ).rejects.toHaveProperty('name', 'AbortError')

    const large = new Uint8Array(4 * 1_048_576)
    large.set(bytes.slice(0, 32))
    const view = new DataView(large.buffer)
    view.setUint32(8, large.byteLength + 192, true)
    view.setUint32(16, large.byteLength, true)
    view.setUint32(20, large.byteLength + 128, true)
    const during = new AbortController()
    const pending = recoverArchive(large, headerFor(large), {
      maxScanBytes: large.byteLength,
      signal: during.signal,
    })
    setTimeout(() => during.abort(), 0)
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
  })

  it('does not enter recovery when the MPQ header itself is invalid', async () => {
    const bytes = fromBase64(TRUNCATED_BASE64)
    bytes[0] = 0
    await expect((await createCodec()).open(inputFor(bytes), 'full', budget)).rejects.toThrow(
      /MPQ magic is missing/u,
    )
  })
})
