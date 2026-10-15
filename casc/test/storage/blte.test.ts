import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { loadInflateSync } from '@modkit/codec-kit/compression/inflate'
import { decodeBlte } from '../../src/casc/blte.js'

function singleChunk(mode: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length)
  out.set([0x42, 0x4c, 0x54, 0x45], 0)
  out.set([0, 0, 0, 0], 4)
  out[8] = mode
  out.set(payload, 9)
  return out
}

/** A BLTE stream with a chunk table: each chunk is its mode byte, then its payload. */
function chunked(chunks: readonly { mode: number; payload: Uint8Array; size: number }[]): Uint8Array {
  const headerSize = 12 + chunks.length * 24
  const body = chunks.reduce((total, chunk) => total + 1 + chunk.payload.length, 0)
  const out = new Uint8Array(headerSize + body)
  const view = new DataView(out.buffer)
  out.set([0x42, 0x4c, 0x54, 0x45], 0)
  view.setUint32(4, headerSize)
  out[8] = 0x0f
  out[9] = 0
  view.setUint16(10, chunks.length)
  let offset = headerSize
  chunks.forEach((chunk, index) => {
    view.setUint32(12 + index * 24, 1 + chunk.payload.length)
    view.setUint32(16 + index * 24, chunk.size)
    out[offset] = chunk.mode
    out.set(chunk.payload, offset + 1)
    offset += 1 + chunk.payload.length
  })
  return out
}

describe('BLTE decoding', () => {
  it('decodes single uncompressed chunks into bytes that own their buffer', () => {
    const payload = new TextEncoder().encode('hello')
    const stream = singleChunk(0x4e, payload)
    const decoded = decodeBlte(stream)
    expect(new TextDecoder().decode(decoded)).toBe('hello')
    // Results cross the host's worker RPC, which refuses a view into a larger buffer.
    expect(decoded.byteOffset).toBe(0)
    expect(decoded.byteLength).toBe(decoded.buffer.byteLength)
  })

  it('keeps an inflated chunk that owns its buffer, and copies one that does not', () => {
    const whole = new TextEncoder().encode('exactly')
    const inPool = new Uint8Array(64).subarray(8, 8 + whole.length)
    inPool.set(whole)
    const stream = singleChunk(0x5a, new Uint8Array([1]))
    expect(decodeBlte(stream, { inflateZlib: () => whole })).toBe(whole)
    const copied = decodeBlte(stream, { inflateZlib: () => inPool })
    expect(copied).not.toBe(inPool)
    expect(copied.byteLength).toBe(copied.buffer.byteLength)
    expect(new TextDecoder().decode(copied)).toBe('exactly')
  })

  it('decodes single zlib chunks through the codec-kit inflate, and needs one', async () => {
    const payload = new TextEncoder().encode('hello')
    const chunk = singleChunk(0x5a, deflateSync(payload))
    expect(() => decodeBlte(chunk)).toThrow(/needs an inflate/u)
    const inflateZlib = await loadInflateSync('zlib')
    expect(new TextDecoder().decode(decodeBlte(chunk, { inflateZlib }))).toBe('hello')
    expect(() => decodeBlte(chunk, { inflateZlib, maxOutputBytes: 4 })).toThrow()
  })

  it('uses an injected zlib inflater for Z chunks when provided', () => {
    const payload = new TextEncoder().encode('compressed-by-caller')
    let called = false
    const decoded = decodeBlte(singleChunk(0x5a, payload), {
      inflateZlib: (chunk: Uint8Array) => {
        called = true
        expect(chunk).toEqual(payload)
        return new TextEncoder().encode('hello')
      },
    })

    expect(called).toBe(true)
    expect(new TextDecoder().decode(decoded)).toBe('hello')
  })

  it('joins the chunks of a table in order and keeps to the output budget', async () => {
    const first = new TextEncoder().encode('zlib head, ')
    const plain = new TextEncoder().encode('plain middle, ')
    const last = new TextEncoder().encode('zlib tail')
    const stream = chunked([
      { mode: 0x5a, payload: deflateSync(first), size: first.length },
      { mode: 0x4e, payload: plain, size: plain.length },
      { mode: 0x5a, payload: deflateSync(last), size: last.length },
    ])
    const inflateZlib = await loadInflateSync('zlib')
    expect(new TextDecoder().decode(decodeBlte(stream, { inflateZlib }))).toBe(
      'zlib head, plain middle, zlib tail',
    )
    expect(() => decodeBlte(stream, { inflateZlib, maxOutputBytes: 20 })).toThrow(/budget/u)
  })
})
