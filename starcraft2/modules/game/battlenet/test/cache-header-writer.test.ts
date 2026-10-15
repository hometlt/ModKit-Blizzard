import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decodeCacheHeader,
  encodeCacheHeader,
  field,
  number,
  type CacheNode,
} from '../content-sources/cache-header.js'

const struct = (entries: readonly [number, CacheNode][]): CacheNode => ({
  kind: 5,
  value: new Map(entries.map(([tag, node]) => [BigInt(tag), node])),
})
const int = (value: number | bigint): CacheNode => ({ kind: 9, value: BigInt(value) })
const blob = (...bytes: number[]): CacheNode => ({ kind: 2, value: Uint8Array.from(bytes) })

describe('SC2 cache metadata writer', () => {
  it('writes every node kind back to the bytes it was read from', () => {
    const node = struct([
      [0, struct([[0, int(377020)], [1, int(65537)]])],
      [1, blob(...new TextEncoder().encode('testmod.SC2Mod'))],
      [2, { kind: 0, value: [int(0), int(-1), int(1 << 20), int(0x7fffffffn)] }],
      [3, { kind: 4, value: undefined }],
      [4, { kind: 4, value: int(24) }],
      [5, { kind: 3, index: 7n, value: blob(1, 2, 3) }],
      [6, { kind: 1, bits: 12, value: Uint8Array.of(0b1010_1010, 0b0000_1111) }],
      [7, { kind: 6, value: Uint8Array.of(9) }],
      [8, { kind: 7, value: Uint8Array.of(1, 2, 3, 4) }],
      [9, { kind: 8, value: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }],
    ])
    const bytes = encodeCacheHeader(node)
    const decoded = decodeCacheHeader(bytes)
    expect(encodeCacheHeader(decoded)).toEqual(bytes)
    expect(number(field(field(decoded, 0), 0))).toBe(377020)
    expect(field(decoded, 6).bits).toBe(12)
    expect(field(decoded, 5).index).toBe(7n)
  })

  it('refuses a node it cannot write back exactly', () => {
    expect(() => encodeCacheHeader({ kind: 3, value: int(1) })).toThrow('no index')
    expect(() => encodeCacheHeader({ kind: 1, bits: 20, value: Uint8Array.of(1) })).toThrow('length mismatch')
    expect(() => encodeCacheHeader({ kind: 7, value: Uint8Array.of(1) })).toThrow('length mismatch')
  })

  /**
   * An editor-produced header, when this machine has one: `MODKIT_SC2_HEADER_FIXTURE` points at a
   * `.s2mh`. Real headers are a user's own publication, so none is committed.
   */
  const fixture = process.env['MODKIT_SC2_HEADER_FIXTURE']
  it.skipIf(!fixture || !existsSync(fixture))('round-trips a real published header', () => {
    const bytes = new Uint8Array(readFileSync(fixture!))
    const decoded = decodeCacheHeader(bytes)
    expect(encodeCacheHeader(decoded)).toEqual(bytes)
    // The publisher amends exactly these before upload; they must survive a rewrite.
    const publication = field(decoded, 0)
    expect(number(field(field(publication, 0), 0))).toBeGreaterThan(0)
    expect(number(field(publication, 3))).toBeGreaterThan(0)
  })
})
