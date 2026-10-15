import { HASH_TYPE, mpqDecrypt, mpqEncrypt, mpqHash } from '@modkit/codec-kit/crypto'
import { describe, expect, it } from 'vitest'
import { createCodec, openMpqReader } from '../src/mpq/codec.js'
import { encodeFreshMpq } from '../src/mpq/fresh-writer.js'
import {
  MPQ_NATIVE_PRESERVING_UNSUPPORTED,
  readNativeMpqSnapshot,
} from '../src/mpq/native-preserving.js'

const FILE_IMPLODE = 0x00000100
const FILE_ENCRYPTED = 0x00010000
const FILE_PATCH = 0x00100000
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 1_000,
  maxScalarBytes: 1_048_576,
  maxDiagnostics: 100,
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true)
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true)
}

function withAllBlockFlags(bytes: Uint8Array, flag: number): Uint8Array {
  const output = bytes.slice()
  const blockOffset = readU32(output, 20)
  const blockCount = readU32(output, 28)
  const key = mpqHash('(block table)', HASH_TYPE.TABLE)
  const plain = mpqDecrypt(output.slice(blockOffset, blockOffset + blockCount * 16), key)
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  for (let index = 0; index < blockCount; index += 1) {
    view.setUint32(index * 16 + 12, (view.getUint32(index * 16 + 12, true) | flag) >>> 0, true)
  }
  output.set(mpqEncrypt(plain, key), blockOffset)
  return output
}

function toLowOffsetExtended(
  bytes: Uint8Array,
  formatVersion: number,
  headerSize: number,
): Uint8Array {
  const extra = headerSize - 32
  const oldHashOffset = readU32(bytes, 16)
  const oldBlockOffset = readU32(bytes, 20)
  const blockCount = readU32(bytes, 28)
  const output = new Uint8Array(bytes.byteLength + extra)
  output.set(bytes.subarray(0, 32))
  output.set(bytes.subarray(32), headerSize)
  writeU32(output, 4, headerSize)
  writeU32(output, 8, output.byteLength)
  writeU16(output, 12, formatVersion)
  writeU32(output, 16, oldHashOffset + extra)
  writeU32(output, 20, oldBlockOffset + extra)

  const key = mpqHash('(block table)', HASH_TYPE.TABLE)
  const tableOffset = oldBlockOffset + extra
  const plain = mpqDecrypt(output.slice(tableOffset, tableOffset + blockCount * 16), key)
  for (let index = 0; index < blockCount; index += 1) {
    writeU32(plain, index * 16, readU32(plain, index * 16) + extra)
  }
  output.set(mpqEncrypt(plain, key), tableOffset)
  return output
}

function highOffsetV1(): Uint8Array {
  const bytes = new Uint8Array(44)
  bytes.set(encoder.encode('MPQ\u001a'), 0)
  writeU32(bytes, 4, 44)
  writeU32(bytes, 8, 44)
  writeU16(bytes, 12, 1)
  writeU16(bytes, 40, 1)
  return bytes
}

function inputFor(bytes: Uint8Array) {
  const uri = 'memory://mpq/archive-audit.SC2Map'
  const revision = 'content-hash.sha256:archive-audit'
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
    bindings: [{
      sourceKind: 'candidate' as const,
      bindingId: 'content',
      role: 'content',
      ownership: 'owned' as const,
      source: source.ref,
      revision,
    }],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: `mpq-audit:${revision}`,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

describe('MPQ source-audit feature gates', () => {
  it.each([
    [FILE_ENCRYPTED, /encrypted entry/u],
    [FILE_IMPLODE, /implode entry/u],
    [FILE_PATCH, /patch entry/u],
  ])('fails closed for block flag 0x%s', async (flag, diagnostic) => {
    const archive = withAllBlockFlags(
      encodeFreshMpq([{ path: 'gated.bin', bytes: Uint8Array.of(1, 2, 3) }]),
      flag,
    )
    await expect(readNativeMpqSnapshot({ sourceBytes: archive })).rejects.toMatchObject({
      code: MPQ_NATIVE_PRESERVING_UNSUPPORTED,
      message: expect.stringMatching(diagnostic),
    })
  })

  it('fails closed for classic high-offset and extended block tables', async () => {
    await expect(readNativeMpqSnapshot({ sourceBytes: highOffsetV1() })).rejects.toMatchObject({
      code: MPQ_NATIVE_PRESERVING_UNSUPPORTED,
      message: expect.stringMatching(/high-offset and extended block tables/u),
    })
  })

  it.each([
    [2, 68],
    [3, 208],
  ])('opens and extracts a low-offset MPQ v%i archive', async (version, headerSize) => {
    const archive = toLowOffsetExtended(
      encodeFreshMpq([{ path: 'inside.txt', bytes: encoder.encode('inside') }]),
      version,
      headerSize,
    )
    const session = await (await createCodec()).open(inputFor(archive), 'full', budget)
    try {
      const result = await session.operations().invoke('extract-entry', { entryId: 'inside.txt' })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'bytes') {
        throw new Error('MPQ audit extraction did not return bytes')
      }
      expect(decoder.decode(result.output.value)).toBe('inside')
    } finally {
      await session.dispose()
    }
  })

  /** A protected StarCraft II map: junk in the declared size and version, tables left alone. */
  it('reads an archive whose declared header size and version are junk', async () => {
    const archive = encodeFreshMpq([{ path: 'inside.txt', bytes: encoder.encode('inside') }])
    writeU32(archive, 4, 0x20d6e548)
    writeU32(archive, 8, 0x2c0175e8)
    writeU16(archive, 12, 3463)
    const reader = await openMpqReader(archive, {
      maxArchiveBytes: 1_048_576,
      maxEntries: 64,
      maxEntryBytes: 65_536,
    })
    try {
      expect(reader.headerRepaired).toBe(true)
      expect(reader.recovered).toBe(false)
      expect(decoder.decode(await reader.read('inside.txt'))).toBe('inside')
    } finally {
      reader.dispose()
    }
  })

  it('rejects future MPQ header versions with a stable diagnostic', async () => {
    const archive = toLowOffsetExtended(
      encodeFreshMpq([{ path: 'inside.txt', bytes: encoder.encode('inside') }]),
      3,
      208,
    )
    writeU16(archive, 12, 4)
    await expect((await createCodec()).open(inputFor(archive), 'full', budget)).rejects.toThrow(
      'MPQ version 4 is not supported',
    )
  })
})
