import { describe, expect, it } from 'vitest'
import type { CascBuildConfig, CascSource } from '../../src/casc/types.js'
import { hexToBytes } from '../../src/casc/binary.js'
import { CascStorage } from '../../src/casc/storage.js'

function bucketForKey(key: Uint8Array, keyLength: number): number {
  let acc = 0
  for (let i = 0; i < keyLength; i++) acc ^= key[i] ?? 0
  return (acc & 0x0f) ^ ((acc >> 4) & 0x0f)
}

function writeUintBE(data: Uint8Array, offset: number, value: number, size: number): void {
  for (let i = size - 1; i >= 0; i--) {
    data[offset + i] = value & 0xff
    value = Math.floor(value / 256)
  }
}

function writeUintLE(data: Uint8Array, offset: number, value: number, size: number): void {
  for (let i = 0; i < size; i++) {
    data[offset + i] = value & 0xff
    value = Math.floor(value / 256)
  }
}

function hashBlock(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + block.length)
  writeUintLE(out, 0, block.length, 4)
  out.set(block, 8)
  return out
}

function align16(value: number): number {
  return (value + 15) & ~15
}

function singleChunk(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length)
  out.set([0x42, 0x4c, 0x54, 0x45], 0)
  out[8] = 0x4e
  out.set(payload, 9)
  return out
}

// Frame variant 1: a 30-byte BLTE_ENCODED_HEADER (EKey + size) followed by the BLTE.
function encodedHeaderContainer(
  encodingKey: string,
  payloadText: string,
  { zeroKey = false } = {},
): Uint8Array {
  const blte = singleChunk(new TextEncoder().encode(payloadText))
  const out = new Uint8Array(30 + blte.length)
  if (!zeroKey) out.set(hexToBytes(encodingKey).reverse(), 0)
  writeUintLE(out, 16, out.length, 4)
  out.set(blte, 30)
  return out
}

// Frame variant 2: a bare BLTE stream (no encoded header), as stored for local files.
function bareBlteContainer(payloadText: string): Uint8Array {
  return singleChunk(new TextEncoder().encode(payloadText))
}

function indexFile(
  bucketIndex: number,
  entries: { encodingKey: string; dataOffset: number; fileSize: number }[],
): Uint8Array {
  const keyLength = 9
  const dataOffsetLength = 5
  const fileSizeLength = 4
  const dataFileSizeBits = 20
  const header = new Uint8Array(16)
  header[2] = bucketIndex
  header[4] = fileSizeLength
  header[5] = dataOffsetLength
  header[6] = keyLength
  header[7] = dataFileSizeBits

  const entryLength = keyLength + dataOffsetLength + fileSizeLength
  const entryData = new Uint8Array(entries.length * entryLength)
  for (const [i, entry] of entries.entries()) {
    const offset = i * entryLength
    entryData.set(hexToBytes(entry.encodingKey).slice(0, keyLength), offset)
    writeUintBE(entryData, offset + keyLength, entry.dataOffset, dataOffsetLength)
    writeUintLE(entryData, offset + keyLength + dataOffsetLength, entry.fileSize, fileSizeLength)
  }

  const headerBlock = hashBlock(header)
  const entriesOffset = align16(headerBlock.length)
  const out = new Uint8Array(entriesOffset + hashBlock(entryData).length)
  out.set(headerBlock, 0)
  out.set(hashBlock(entryData), entriesOffset)
  return out
}

class MemorySource implements CascSource {
  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  async list(path: string): Promise<string[]> {
    const prefix = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return [...this.files.keys()]
      .filter(name => name.startsWith(`${prefix}/`))
      .map(name => name.slice(prefix.length + 1))
  }

  async get(path: string): Promise<Uint8Array> {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const data = this.files.get(normalized)
    if (!data) throw new Error(`missing file ${normalized}`)
    return data
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  }
}

const config: CascBuildConfig = {
  values: new Map(),
  get: () => undefined,
  getKeyPair: () => undefined,
  getSizePair: () => undefined,
}

async function openStorageFor(key: string, containers: Uint8Array[]): Promise<CascStorage> {
  let total = 0
  const offsets = containers.map(c => {
    const o = total
    total += c.length
    return o
  })
  const dataFile = new Uint8Array(total)
  containers.forEach((c, i) => dataFile.set(c, offsets[i]!))

  const bucket = bucketForKey(hexToBytes(key), 9)
  const index = indexFile(
    bucket,
    containers.map((c, i) => ({ encodingKey: key, dataOffset: offsets[i]!, fileSize: c.length })),
  )
  const bucketName = bucket.toString(16).padStart(2, '0')
  const source = new MemorySource(
    new Map([
      [`SC2Data/data/${bucketName}00000001.idx`, index],
      ['SC2Data/data/data.000', dataFile],
    ]),
  )
  return CascStorage.open(source, 'SC2Data', config)
}

const KEY = 'bbc7d5d1eb41437253' + '8379a9b522894f'

describe('CASC storage', () => {
  it('looks up keys inside an encoding column without using adjacent keys', async () => {
    const storage = await openStorageFor(KEY, [bareBlteContainer('column')])
    const key = hexToBytes(KEY)
    const column = new Uint8Array(key.length * 3).fill(0xff)
    column.set(key, key.length)
    expect(storage.hasEncodingKeyBytes(key)).toBe(true)
    expect(storage.hasEncodingKeyBytes(column, key.length)).toBe(true)
    expect(storage.hasEncodingKeyBytes(column, key.length, 8)).toBe(false)
    expect(storage.hasEncodingKeyBytes(column, 0)).toBe(false)
    expect(storage.hasEncodingKeyBytes(column, key.length * 2)).toBe(false)
  })

  it('reads a frame with a 30-byte encoded header (EKey present)', async () => {
    const storage = await openStorageFor(KEY, [encodedHeaderContainer(KEY, 'header')])
    await expect(storage.readEncodingKey(KEY)).resolves.toEqual(new TextEncoder().encode('header'))
  })

  it('reads a frame whose encoded-header EKey field is zeroed (data-segment files)', async () => {
    const storage = await openStorageFor(KEY, [
      encodedHeaderContainer(KEY, 'zeroed', { zeroKey: true }),
    ])
    await expect(storage.readEncodingKey(KEY)).resolves.toEqual(new TextEncoder().encode('zeroed'))
  })

  it('reads a bare BLTE stream with no encoded header', async () => {
    const storage = await openStorageFor(KEY, [bareBlteContainer('bare')])
    await expect(storage.readEncodingKey(KEY)).resolves.toEqual(new TextEncoder().encode('bare'))
  })

  it('skips an unreadable prefix-collision candidate and reads a valid one', async () => {
    // First candidate is a freed/garbage slot (no BLTE signature); must fall through.
    const garbage = new Uint8Array(64)
    const storage = await openStorageFor(KEY, [
      garbage,
      encodedHeaderContainer(KEY, 'valid', { zeroKey: true }),
    ])
    await expect(storage.readEncodingKey(KEY)).resolves.toEqual(new TextEncoder().encode('valid'))
  })

  it('decodes only the chunks a prefix needs', async () => {
    // Three chunks; the last is unreadable, so reaching it would fail the read.
    const chunks = [Uint8Array.of(0x4e, 1, 2, 3), Uint8Array.of(0x4e, 4, 5, 6), Uint8Array.of(0x58, 0)]
    const headerSize = 12 + chunks.length * 24
    const blte = new Uint8Array(headerSize + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    blte.set([0x42, 0x4c, 0x54, 0x45])
    writeUintBE(blte, 4, headerSize, 4)
    blte[8] = 0x0f
    writeUintBE(blte, 9, chunks.length, 3)
    let at = headerSize
    chunks.forEach((chunk, i) => {
      writeUintBE(blte, 12 + i * 24, chunk.length, 4)
      writeUintBE(blte, 16 + i * 24, chunk.length - 1, 4)
      blte.set(chunk, at)
      at += chunk.length
    })
    const storage = await openStorageFor(KEY, [blte])
    const heads: number[] = []
    const prefix = await storage.readDecodedPrefix(KEY, (head: Uint8Array) => {
      heads.push(head.length)
      return head.length < 2 ? undefined : 5
    })
    expect(prefix).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    expect(heads).toEqual([3])
    await expect(storage.readEncodingKey(KEY)).rejects.toThrow()
  })
})
