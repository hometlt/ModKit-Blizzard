import { deflateSync } from 'node:zlib'

import { afterAll, describe, expect, it } from 'vitest'

import { loadInflateSync } from '@modkit/codec-kit/compression/inflate'

import { decodeBlte } from '../../src/casc/blte.js'
import { BLTE_IN_PLACE_BYTES, createBlteDecodePool } from '../../src/casc/blte-pool.js'
import { CascStorage } from '../../src/casc/storage.js'

/** A single-chunk BLTE stream: header without a chunk table, then the mode byte and payload. */
function singleChunk(mode: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length)
  out.set([0x42, 0x4c, 0x54, 0x45, 0, 0, 0, 0, mode], 0)
  out.set(payload, 9)
  return out
}

const text = new TextEncoder().encode('<CUnit id="Marine"/>\n'.repeat(8192))
const zlibStream = singleChunk(0x5a, deflateSync(text))
const pool = await createBlteDecodePool(2)
afterAll(() => pool.close())

describe('BLTE decode pool', () => {
  it('decodes on a thread exactly as in place, into bytes that own their buffer', async () => {
    const inflateZlib = await loadInflateSync('zlib')
    const inPlace = decodeBlte(zlibStream, { maxOutputBytes: 1 << 24, inflateZlib })
    const results = await Promise.all([1, 2, 3].map(() => pool.decode(zlibStream, 1 << 24)))
    for (const decoded of results) {
      expect(decoded).toEqual(inPlace)
      expect(decoded.byteLength).toBe(decoded.buffer.byteLength)
    }
    // The caller keeps its bytes: the pool sends a copy.
    expect(zlibStream.byteLength).toBeGreaterThan(9)
  })

  it('answers a thread error and the output budget as rejections', async () => {
    await expect(pool.decode(singleChunk(0x5a, new Uint8Array([1, 2, 3])), 1 << 24)).rejects.toThrow()
    await expect(pool.decode(zlibStream, 16)).rejects.toThrow(/exceeds/)
    await expect(pool.decode(zlibStream, 1 << 24)).resolves.toHaveLength(text.byteLength)
  })

  it('reads in place when a thread fails, so a bundle without blte-thread.js still reads', async () => {
    const inflateZlib = await loadInflateSync('zlib')
    const large = singleChunk(0x4e, new Uint8Array(BLTE_IN_PLACE_BYTES).fill(7))
    const storage = new CascStorage(undefined, '', undefined, [], {
      decodeThreads: 1,
      maxDecodedBytes: 1 << 24,
      inflateZlib,
    })
    storage.decodePool = Promise.resolve({
      decode: async () => {
        throw new Error('BLTE decode thread exited with code 1')
      },
      close: async () => undefined,
    })
    await expect(storage.decode(large)).resolves.toEqual(new Uint8Array(BLTE_IN_PLACE_BYTES).fill(7))
  })
})
