import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { decompressBounded } from '@modkit/codec-kit/compression/bounded'
import { HASH_TYPE, mpqDecrypt, mpqEncrypt, mpqHash, type HashType } from '@modkit/codec-kit/crypto'
import { encodeFreshMpq, createProvider } from '../src/mpq/fresh-writer.js'
import {
  MPQ_NATIVE_PRESERVING_UNSUPPORTED,
  encodeNativePreservingMpq,
  readNativeMpqSnapshot,
  snapshotNativePreservingMpq,
} from '../src/mpq/native-preserving.js'

const HASH_TABLE_OFFSET = HASH_TYPE.TABLE_OFFSET
const HASH_NAME_A = HASH_TYPE.HASH_A
const HASH_NAME_B = HASH_TYPE.HASH_B
const HASH_TABLE = HASH_TYPE.TABLE
const FILE_COMPRESS = 0x00000200
const FILE_ENCRYPTED = 0x00010000
const BLOCK_TABLE_BYTES = 16
const encoder = new TextEncoder()
const TEST_PROVIDER_IDENTITY = Object.freeze({
  providerId: 'blizzard/mpq-fresh-writer',
  providerVersion: '1.0.0-test',
  artifactDigest: `sha256:${'0'.repeat(64)}`,
})

// The algorithms are codec-kit's; an archive name is hashed with backslashes, as the game writes it.
const nameHash = (input: string, type: HashType): number => mpqHash(input.replaceAll('/', '\\'), type)
const tableCipher = (data: Uint8Array, key: number, decrypting: boolean): Uint8Array =>
  (decrypting ? mpqDecrypt : mpqEncrypt)(data, key)

interface RawBlock {
  readonly index: number
  readonly offset: number
  readonly archivedSize: number
  readonly size: number
  readonly flags: number
  readonly raw: Uint8Array
}

function layout(bytes: Uint8Array) {
  const headerOffset = String.fromCharCode(...bytes.slice(0, 4)) === 'MPQ\u001b' ? u32(bytes, 8) : 0
  const hashOffset = u32(bytes, headerOffset + 16)
  const blockOffset = u32(bytes, headerOffset + 20)
  const hashEntries = u32(bytes, headerOffset + 24)
  const blockEntries = u32(bytes, headerOffset + 28)
  const hashCipher = bytes.slice(
    headerOffset + hashOffset,
    headerOffset + hashOffset + hashEntries * 16,
  )
  const hashPlain = tableCipher(hashCipher, nameHash('(hash table)', HASH_TABLE), true)
  const blockCipher = bytes.slice(
    headerOffset + blockOffset,
    headerOffset + blockOffset + blockEntries * BLOCK_TABLE_BYTES,
  )
  const blockPlain = tableCipher(blockCipher, nameHash('(block table)', HASH_TABLE), true)
  return {
    headerOffset,
    hashOffset,
    blockOffset,
    hashEntries,
    blockEntries,
    hashCipher,
    hashPlain,
    blockCipher,
    blockPlain,
  }
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function blockFor(bytes: Uint8Array, path: string): RawBlock {
  const archive = layout(bytes)
  const hashView = new DataView(
    archive.hashPlain.buffer,
    archive.hashPlain.byteOffset,
    archive.hashPlain.byteLength,
  )
  const expectedA = nameHash(path, HASH_NAME_A)
  const expectedB = nameHash(path, HASH_NAME_B)
  const first = nameHash(path, HASH_TABLE_OFFSET) % archive.hashEntries
  let blockIndex: number | undefined
  for (let probe = 0; probe < archive.hashEntries; probe += 1) {
    const slot = (first + probe) % archive.hashEntries
    const offset = slot * 16
    const candidate = hashView.getUint32(offset + 12, true)
    if (candidate === 0xffffffff) break
    if (
      candidate !== 0xfffffffe &&
      hashView.getUint32(offset, true) === expectedA &&
      hashView.getUint32(offset + 4, true) === expectedB
    ) {
      blockIndex = candidate
      break
    }
  }
  if (blockIndex === undefined) throw new Error(`no block for ${path}`)
  const blockView = new DataView(
    archive.blockPlain.buffer,
    archive.blockPlain.byteOffset,
    archive.blockPlain.byteLength,
  )
  const base = blockIndex * BLOCK_TABLE_BYTES
  const offset = blockView.getUint32(base, true)
  const archivedSize = blockView.getUint32(base + 4, true)
  const size = blockView.getUint32(base + 8, true)
  const flags = blockView.getUint32(base + 12, true)
  return {
    index: blockIndex,
    offset,
    archivedSize,
    size,
    flags,
    raw: bytes.slice(archive.headerOffset + offset, archive.headerOffset + offset + archivedSize),
  }
}

function addHiddenAliasHashToBlock(
  bytes: Uint8Array,
  aliasPath: string,
  targetPath: string,
): Uint8Array {
  const output = bytes.slice()
  const archive = layout(output)
  const hashView = new DataView(
    archive.hashPlain.buffer,
    archive.hashPlain.byteOffset,
    archive.hashPlain.byteLength,
  )
  const expectedA = nameHash(aliasPath, HASH_NAME_A)
  const expectedB = nameHash(aliasPath, HASH_NAME_B)
  const first = nameHash(aliasPath, HASH_TABLE_OFFSET) % archive.hashEntries
  let aliasSlot: number | undefined
  for (let probe = 0; probe < archive.hashEntries; probe += 1) {
    const slot = (first + probe) % archive.hashEntries
    const offset = slot * 16
    const blockIndex = hashView.getUint32(offset + 12, true)
    if (blockIndex === 0xffffffff || blockIndex === 0xfffffffe) {
      aliasSlot = slot
      break
    }
  }
  if (aliasSlot === undefined) throw new Error(`no empty hash slot for ${aliasPath}`)
  const aliasOffset = aliasSlot * 16
  hashView.setUint32(aliasOffset, expectedA, true)
  hashView.setUint32(aliasOffset + 4, expectedB, true)
  hashView.setUint16(aliasOffset + 8, 0, true)
  hashView.setUint16(aliasOffset + 10, 0, true)
  hashView.setUint32(aliasOffset + 12, blockFor(output, targetPath).index, true)
  output.set(
    tableCipher(archive.hashPlain, nameHash('(hash table)', HASH_TABLE), false),
    archive.headerOffset + archive.hashOffset,
  )
  return output
}

function setBlockEncoding(
  bytes: Uint8Array,
  path: string,
  archived: Uint8Array,
  size: number,
  flag: number,
): Uint8Array {
  const output = bytes.slice()
  const archive = layout(output)
  const block = blockFor(output, path)
  if (archived.byteLength > block.archivedSize) throw new Error('encoded fixture exceeds its slot')
  output.set(archived, archive.headerOffset + block.offset)
  const blockView = new DataView(
    archive.blockPlain.buffer,
    archive.blockPlain.byteOffset,
    archive.blockPlain.byteLength,
  )
  const base = block.index * BLOCK_TABLE_BYTES
  blockView.setUint32(base + 4, archived.byteLength, true)
  blockView.setUint32(base + 8, size, true)
  blockView.setUint32(base + 12, (block.flags | flag) >>> 0, true)
  output.set(
    tableCipher(archive.blockPlain, nameHash('(block table)', HASH_TABLE), false),
    archive.headerOffset + archive.blockOffset,
  )
  return output
}

function wrappedFixture(): Uint8Array {
  const archive = encodeFreshMpq([
    { path: 'MapScript.galaxy', bytes: encoder.encode('void Before() {}\r\n') },
    { path: 'Opaque.bin', bytes: new Uint8Array([0, 255, 4, 8, 15, 16, 23, 42]) },
    { path: '(attributes)', bytes: new Uint8Array([1, 7, 9, 13]) },
    { path: '(signature)', bytes: new Uint8Array([99, 88, 77, 66]) },
  ])
  const prefixBytes = 64
  const suffix = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  const result = new Uint8Array(prefixBytes + archive.byteLength + suffix.byteLength)
  result.set(encoder.encode('MPQ\u001b'), 0)
  const view = new DataView(result.buffer)
  view.setUint32(4, prefixBytes - 16, true)
  view.setUint32(8, prefixBytes, true)
  view.setUint32(12, archive.byteLength, true)
  for (let index = 16; index < prefixBytes; index += 1) result[index] = (index * 17) & 0xff
  result.set(archive, prefixBytes)
  result.set(suffix, prefixBytes + archive.byteLength)
  return result
}

const target = {
  targetId: 'destination',
  ownerSource: { id: 'file:///destination', uri: 'file:///destination' },
  expectedRevision: { namespaceRevision: 'provider-token:destination' },
}

describe('Block 15 native-preserving MPQ Save As', () => {
  it('preserves untouched payloads, flags, methods, opaque records and wrapper bytes', async () => {
    const source = wrappedFixture()
    const replacement = encoder.encode('void After_() {}\r\n')
    expect(replacement.byteLength).toBe(blockFor(source, 'MapScript.galaxy').size)
    const before = new Map(
      ['Opaque.bin', '(attributes)', '(signature)', '(listfile)'].map(path => [
        path,
        blockFor(source, path),
      ]),
    )

    const result = await encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: replacement }],
    })

    expect(result.bytes.byteLength).toBe(source.byteLength)
    expect([...result.bytes.slice(0, 64)]).toEqual([...source.slice(0, 64)])
    expect([...result.bytes.slice(-4)]).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect([...layout(result.bytes).hashCipher]).toEqual([...layout(source).hashCipher])
    for (const [path, original] of before) {
      const reopened = blockFor(result.bytes, path)
      expect(reopened.flags).toBe(original.flags)
      expect([...reopened.raw]).toEqual([...original.raw])
    }
    expect([...blockFor(result.bytes, 'MapScript.galaxy').raw]).toEqual([...replacement])
    expect(result.receipt).toMatchObject({
      strategy: 'whole-archive-save-as-fixed-slots',
      archiveByteIdentity: 'changed',
      unchanged: { guarantee: 'raw-payload-flags-and-method-byte-identical' },
      tables: {
        hash: 'byte-identical',
        block: 'deterministic-semantic-rebuild-in-original-slot',
        blockOrder: 'preserved',
        blockOffsets: 'preserved',
      },
      opaque: {
        prefix: 'byte-identical',
        suffix: 'byte-identical',
        extendedHeader: 'byte-identical',
        interstitialBytes: 'byte-identical',
        changedEntrySlack: 'zero-filled-no-source-payload-retained',
        sourceArchive: 'not-mutated',
        attributes: {
          present: true,
          bytes: 'preserved-opaque',
          status: 'invalidated-by-modification',
        },
      },
      signature: {
        present: true,
        bytes: 'preserved-opaque',
        status: 'invalidated-by-modification',
      },
      launchData: 'outside-writer-scope',
    })
  })

  it('recognizes and preserves an external NGIS strong signature without an internal signature', async () => {
    const archive = encodeFreshMpq([
      { path: 'MapScript.galaxy', bytes: encoder.encode('void Before() {}\r\n') },
      { path: 'Opaque.bin', bytes: new Uint8Array([4, 3, 2, 1]) },
    ])
    const source = new Uint8Array(archive.byteLength + 260)
    source.set(archive)
    source.set(encoder.encode('NGIS'), archive.byteLength)
    for (let index = 0; index < 256; index += 1) {
      source[archive.byteLength + 4 + index] = (index * 29) & 0xff
    }

    const result = await encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
    })

    expect([...result.bytes.slice(archive.byteLength)]).toEqual([
      ...source.slice(archive.byteLength),
    ])
    expect(result.receipt.signature).toEqual({
      present: true,
      kind: 'external-strong-ngis-256',
      kinds: ['external-strong-ngis-256'],
      externalStrongBytes: 260,
      bytes: 'preserved-opaque',
      status: 'invalidated-by-modification',
    })
  })

  it('re-encodes a changed single-unit zlib entry with the original method and flags', async () => {
    const plain = encoder.encode(`${'AAAAABBBBBCCCCCDDDDDEEEEE'.repeat(80)}\r\n`)
    const fresh = encodeFreshMpq([
      { path: 'MapScript.galaxy', bytes: plain },
      { path: 'Opaque.bin', bytes: new Uint8Array([3, 1, 4, 1, 5]) },
    ])
    const compressed = deflateSync(plain)
    const encoded = new Uint8Array(compressed.byteLength + 1)
    encoded[0] = 2
    encoded.set(compressed, 1)
    const source = setBlockEncoding(
      fresh,
      'MapScript.galaxy',
      encoded,
      plain.byteLength,
      FILE_COMPRESS,
    )
    const replacement = encoder.encode(`${'ZZZZZYYYYYXXXXXWWWWWVVVVV'.repeat(80)}\r\n`)
    const sourceBlock = blockFor(source, 'MapScript.galaxy')

    const result = await encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: replacement }],
    })
    const outputBlock = blockFor(result.bytes, 'MapScript.galaxy')

    expect(outputBlock.flags).toBe(sourceBlock.flags)
    expect(outputBlock.raw[0]).toBe(2)
    expect([
      ...(await decompressBounded(outputBlock.raw.slice(1), 'deflate', { maxOutputBytes: replacement.byteLength })),
    ]).toEqual([...replacement])
    const outputLayout = layout(result.bytes)
    expect([
      ...result.bytes.slice(
        outputLayout.headerOffset + sourceBlock.offset + outputBlock.archivedSize,
        outputLayout.headerOffset + sourceBlock.offset + sourceBlock.archivedSize,
      ),
    ]).toEqual(Array.from({ length: sourceBlock.archivedSize - outputBlock.archivedSize }, () => 0))
    expect(result.receipt.changed).toMatchObject([
      {
        path: 'MapScript.galaxy',
        method: 'zlib',
        flags: '0x81000200',
        zeroFilledSlackBytes: sourceBlock.archivedSize - outputBlock.archivedSize,
      },
    ])
  })

  it('creates one atomic Save As plan with a validated native receipt', async () => {
    const source = wrappedFixture()
    const change = await snapshotNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      target,
      archiveName: 'Changed.SC2Map',
    })
    const selection = {
      contract: 'common.edit/writer' as const,
      major: 1,
      offerId: 'mpq-native-preserving-v1',
    }
    const budgets = {
      maxInputBytes: 1_000_000n,
      maxScalarBytes: 1_000_000,
      maxNodes: 10_000,
    }
    expect(() => createProvider(selection, { budgets })).toThrow(/host-attested/u)
    expect(() =>
      createProvider(selection, {
        providerIdentity: { ...TEST_PROVIDER_IDENTITY, providerId: 'org.example/substitute' },
        budgets,
      }),
    ).toThrow(/host-attested/u)
    const provider = createProvider(selection, {
      providerIdentity: TEST_PROVIDER_IDENTITY,
      budgets,
    })
    expect(provider.value.identity).toEqual({
      ...TEST_PROVIDER_IDENTITY,
      formatId: 'mpq',
      representationId: 'native-source',
    })
    expect(typeof provider.value.snapshotNativePreservingMpq).toBe('function')
    await expect(
      provider.value.snapshotNativePreservingMpq({
        sourceBytes: source,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
        target,
        archiveName: 'Changed.SC2Map',
      }),
    ).resolves.toMatchObject({
      semanticIntent: { kind: 'mpq-native-preserving-export-v1' },
      edits: [{ operation: 'create', newPath: 'Changed.SC2Map' }],
    })
    const freshProvider = createProvider(
      { contract: 'common.edit/writer', major: 1, offerId: 'mpq-fresh-archive-v1' },
      { providerIdentity: TEST_PROVIDER_IDENTITY, budgets },
    )
    expect(
      (freshProvider.value as Record<string, unknown>).snapshotNativePreservingMpq,
    ).toBeUndefined()
    expect(await provider.value.validate(change)).toEqual({ valid: true, diagnostics: [] })
    const plan = await provider.value.plan(change)
    expect(plan).toMatchObject({
      semantics: { mutationMode: 'export-only', minimumGuarantee: 'atomic' },
      fidelity: { roundTrip: 'semantic', preservesUnknownData: true },
    })
    expect(change).toMatchObject({
      edits: [{ operation: 'create', newPath: 'Changed.SC2Map' }],
      semanticIntent: {
        sourceMode: 'native-mpq',
        replacementMode: 'whole-archive-save-as',
        unknownDataPolicy: 'preserve-opaque-source-bytes',
      },
    })
  })

  it('fails closed for unsafe features, slot growth, paths, forged receipts and cancellation', async () => {
    const source = wrappedFixture()
    const encrypted = setBlockEncoding(
      source,
      'MapScript.galaxy',
      blockFor(source, 'MapScript.galaxy').raw,
      blockFor(source, 'MapScript.galaxy').size,
      FILE_ENCRYPTED,
    )
    await expect(
      encodeNativePreservingMpq({
        sourceBytes: encrypted,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      }),
    ).rejects.toMatchObject({ code: MPQ_NATIVE_PRESERVING_UNSUPPORTED })
    // Versions 0–3 are rewritten (3 is StarCraft II's); a later version is named, not guessed at.
    const versionFour = source.slice()
    new DataView(versionFour.buffer).setUint16(layout(versionFour).headerOffset + 12, 4, true)
    await expect(
      encodeNativePreservingMpq({
        sourceBytes: versionFour,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      }),
    ).rejects.toMatchObject({ code: MPQ_NATIVE_PRESERVING_UNSUPPORTED })
    // An entry that outgrows its slot moves to where the tables began; the tables follow it.
    const grown = new Uint8Array(100).fill(7)
    const relocated = await encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: grown }],
    })
    expect(relocated.receipt.changed[0]).toMatchObject({ path: 'MapScript.galaxy', relocated: true })
    expect(relocated.receipt.tables).toMatchObject({
      blockOffsets: 'preserved-except-relocated',
      placement: 'relocated-entries-then-tables-at-end',
    })
    const reread = await readNativeMpqSnapshot({ sourceBytes: relocated.bytes })
    expect([...reread.entries.find(entry => entry.path === 'MapScript.galaxy')!.bytes]).toEqual([...grown])
    await expect(
      encodeNativePreservingMpq({
        sourceBytes: source,
        replacements: [{ path: '../escape', bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/traversal/u)
    const hiddenAlias = 'InvisibleAlias.galaxy'
    const aliasSource = addHiddenAliasHashToBlock(
      encodeFreshMpq([
        { path: 'MapScript.galaxy', bytes: encoder.encode('void Before() {}\r\n') },
        { path: 'Opaque.bin', bytes: new Uint8Array([1, 2, 3]) },
      ]),
      hiddenAlias,
      'MapScript.galaxy',
    )
    expect(blockFor(aliasSource, hiddenAlias).index).toBe(
      blockFor(aliasSource, 'MapScript.galaxy').index,
    )
    expect(new TextDecoder().decode(blockFor(aliasSource, '(listfile)').raw)).not.toContain(
      hiddenAlias,
    )
    await expect(
      encodeNativePreservingMpq({
        sourceBytes: aliasSource,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      }),
    ).rejects.toMatchObject({
      code: MPQ_NATIVE_PRESERVING_UNSUPPORTED,
      message: expect.stringMatching(/multiple live hash-table entries/u),
    })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      encodeNativePreservingMpq({
        sourceBytes: source,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const cancelledDuringRead = new AbortController()
    const cancelledDuringReadResult = encodeNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      signal: cancelledDuringRead.signal,
    })
    queueMicrotask(() => cancelledDuringRead.abort())
    await expect(cancelledDuringReadResult).rejects.toMatchObject({ name: 'AbortError' })

    const change = await snapshotNativePreservingMpq({
      sourceBytes: source,
      replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
      target,
      archiveName: 'Changed.SC2Map',
    })
    const forged = {
      ...change,
      semanticIntent: {
        ...change.semanticIntent,
        nativeExportReceipt: {
          ...change.semanticIntent.nativeExportReceipt,
          outputArchiveDigest: `sha256:${'0'.repeat(64)}`,
        },
      },
    }
    const provider = createProvider(
      { contract: 'common.edit/writer', major: 1, offerId: 'mpq-native-preserving-v1' },
      {
        providerIdentity: TEST_PROVIDER_IDENTITY,
        budgets: { maxInputBytes: 1_000_000n, maxScalarBytes: 1_000_000, maxNodes: 10_000 },
      },
    )
    expect((await provider.value.validate(forged)).diagnostics[0]?.code).toBe(
      'blizzard/mpq-native-export-edit-invalid',
    )
    const cancelledDuringValidation = new AbortController()
    const cancelledValidationResult = provider.value.validate(
      change,
      cancelledDuringValidation.signal,
    )
    queueMicrotask(() => cancelledDuringValidation.abort())
    await expect(cancelledValidationResult).rejects.toMatchObject({ name: 'AbortError' })

    const subtle = globalThis.crypto.subtle
    const originalDigest = subtle.digest.bind(subtle)
    let abortAfterDigest: AbortController | undefined
    const digestSpy = vi.spyOn(subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await originalDigest(algorithm, data)
      abortAfterDigest?.abort()
      return result
    })
    try {
      const contextDigestCancellation = new AbortController()
      abortAfterDigest = contextDigestCancellation
      const contextCancelledProvider = createProvider(
        { contract: 'common.edit/writer', major: 1, offerId: 'mpq-native-preserving-v1' },
        {
          providerIdentity: TEST_PROVIDER_IDENTITY,
          budgets: { maxInputBytes: 1_000_000n, maxScalarBytes: 1_000_000, maxNodes: 10_000 },
          signal: contextDigestCancellation.signal,
        },
      )
      await expect(contextCancelledProvider.value.validate(change)).rejects.toMatchObject({
        name: 'AbortError',
      })

      const callDigestCancellation = new AbortController()
      abortAfterDigest = callDigestCancellation
      const callCancelledProvider = createProvider(
        { contract: 'common.edit/writer', major: 1, offerId: 'mpq-native-preserving-v1' },
        {
          providerIdentity: TEST_PROVIDER_IDENTITY,
          budgets: { maxInputBytes: 1_000_000n, maxScalarBytes: 1_000_000, maxNodes: 10_000 },
          signal: new AbortController().signal,
        },
      )
      await expect(
        callCancelledProvider.value.validate(change, callDigestCancellation.signal),
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      digestSpy.mockRestore()
    }
    const escapedSource = {
      ...change,
      edits: change.edits.map(edit => ({
        ...edit,
        source: { id: 'file:///outside', uri: 'file:///outside' },
      })),
    }
    expect((await provider.value.validate(escapedSource)).diagnostics[0]?.code).toBe(
      'blizzard/mpq-native-export-edit-invalid',
    )
    await expect(
      snapshotNativePreservingMpq({
        sourceBytes: source,
        replacements: [{ path: 'MapScript.galaxy', bytes: encoder.encode('void After_() {}\r\n') }],
        target,
        archiveName: '../Changed.SC2Map',
      }),
    ).rejects.toThrow(/portable|traversal/u)
  })
})
