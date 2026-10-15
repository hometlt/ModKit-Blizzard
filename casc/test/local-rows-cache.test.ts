import { describe, expect, it, vi } from 'vitest'

import { CascReader } from '../src/casc/reader.js'
import { CascPathIndex, arrayPathIndex } from '../src/casc/path-index.js'
import { EncodingTable } from '../src/casc/encoding.js'

/**
 * Which of a build's files are local is kept with the build's root cache and keyed by the local
 * indexes: the same indexes reuse the record, new index versions (a locale installed) recompute it.
 */
function reader(fingerprint: string, cache: Map<string, Uint8Array>, computed: { count: number }) {
  const value = Object.create(CascReader.prototype) as CascReader & Record<string, unknown>
  value['storage'] = { indexFingerprint: fingerprint }
  value['entryIndex'] = { size: 4 }
  value['rootContentKey'] = 'ab12'
  value['localRowsCache'] = {
    load: async (key: string, kind: string) => cache.get(`${key}/${kind}`),
    store: async (key: string, bytes: Uint8Array, kind: string) => {
      cache.set(`${key}/${kind}`, bytes)
    },
  }
  value['computeLocalRows'] = async () => {
    computed.count += 1
    return Uint8Array.from([1, 0, 1, fingerprint.length % 2])
  }
  return value
}

describe('CASC local rows on disk', () => {
  it('answers single rows identically to the complete bitmap without building it', async () => {
    const files = [1, 2, 3].map(key => ({ path: `mods/a.sc2mod/${key}`, contentKey: key.toString(16).padStart(32, '0'), contentSize: 1 }))
    const keys = new Uint8Array(32)
    keys[15] = 1
    keys[31] = 2
    const encoding = new EncodingTable(2, 16, 16, keys, keys, new Float64Array(2), new Map())
    const storage = { hasEncodingKeyBytes: vi.fn((bytes: Uint8Array, at: number) => bytes[at + 15] === 1) }
    const index = CascPathIndex.fromFiles(files)
    const value = new CascReader(storage, encoding, index, index, 'root', 'mndx', {})
    const scan = vi.spyOn(value, 'cachedLocalRows')
    expect(files.map((_, row) => value.localRow(row))).toEqual([true, false, false])
    expect(scan).not.toHaveBeenCalled()
    expect(await value.localRows()).toEqual(new Uint8Array([1, 0, 0]))
    const checks = storage.hasEncodingKeyBytes.mock.calls.length
    for (const invalid of [-1, 0.5, 3, Number.NaN]) expect(() => value.localRow(invalid)).toThrow(RangeError)
    expect(storage.hasEncodingKeyBytes.mock.calls).toHaveLength(checks)

    // Object-backed roots use the same existing path-aware availability rules as full scans.
    const objectIndex = arrayPathIndex(files)
    const fallback = new CascReader(storage, encoding, objectIndex, objectIndex, 'root', 'array', {})
    vi.spyOn(fallback, 'hasPath').mockImplementation((file: string) => file.endsWith('/2'))
    expect(files.map((_, row) => fallback.localRow(row))).toEqual([false, true, false])
    expect(await fallback.localRows()).toEqual(new Uint8Array([0, 1, 0]))
  })

  it('reuses the record for the same local indexes and recomputes for new ones', async () => {
    const cache = new Map<string, Uint8Array>()
    const computed = { count: 0 }
    const first = await reader('0000000001.idx:10', cache, computed).localRows()
    expect(computed.count).toBe(1)
    const second = await reader('0000000001.idx:10', cache, computed).localRows()
    expect(computed.count).toBe(1)
    expect([...second]).toEqual([...first])
    await reader('0000000002.idx:12', cache, computed).localRows()
    expect(computed.count).toBe(2)
  })

  it('computes without a cache', async () => {
    const computed = { count: 0 }
    const value = reader('x', new Map(), computed)
    value['localRowsCache'] = undefined
    expect([...(await value.localRows())]).toEqual([1, 0, 1, 1])
    expect(computed.count).toBe(1)
  })
})
