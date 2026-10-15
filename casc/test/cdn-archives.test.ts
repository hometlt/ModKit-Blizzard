import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdnFetch } from '../src/casc/cdn.js'
import { cdnArchiveLocator } from '../src/casc/cdn-archives.js'
import type { CascFileSource } from '../src/casc/index.js'

const key = (byte: number) => new Uint8Array(16).fill(byte)
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

/** A merged archive index as the agent writes it: one 4 KiB block, its last key, a 28-byte footer. */
function archiveGroup(entries: readonly { key: Uint8Array; size: number; archive: number; offset: number }[]): Uint8Array {
  const entryBytes = 16 + 4 + 5
  const bytes = new Uint8Array(4096 + 16 + 8 + 28)
  const view = new DataView(bytes.buffer)
  entries.forEach((entry, index) => {
    const at = index * entryBytes
    bytes.set(entry.key, at)
    view.setUint32(at + 16, entry.size)
    bytes[at + 20] = entry.archive
    view.setUint32(at + 21, entry.offset)
  })
  bytes.set(entries.at(-1)!.key, 4096)
  const footer = 4096 + 16 + 8
  bytes.set([1, 0, 0, 4, 5, 4, 16, 8], footer + 8)
  view.setUint32(footer + 16, entries.length, true)
  return bytes
}

function source(files: Record<string, Uint8Array | string>): CascFileSource {
  const bytesOf = (path: string) => {
    const file = files[path]
    if (file === undefined) throw new Error(`no ${path}`)
    return typeof file === 'string' ? new TextEncoder().encode(file) : file
  }
  return {
    list: async () => [],
    get: async path => bytesOf(path),
    getRange: async (path, offset, length) => bytesOf(path).subarray(offset, offset + length),
    exists: async path => path in files,
  }
}

describe('CDN archives of a partial install', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('finds the archive and range of a file by the install\'s merged archive index', async () => {
    const cdnKey = 'e4f2e2da310c08495f2701d401d14659'
    const locator = cdnArchiveLocator({
      dataRoot: 'SC2Data',
      cdnKey,
      source: source({
        [`SC2Data/config/e4/f2/${cdnKey}`]: 'archives = aaaa0000 bbbb1111\narchive-group = cccc2222\n',
        'SC2Data/indices/cccc2222.index': archiveGroup([
          { key: key(0x10), size: 100, archive: 0, offset: 7 },
          { key: key(0x20), size: 31599, archive: 1, offset: 34553816 },
        ]),
      }),
    })
    expect(await locator.locate(hex(key(0x20)))).toEqual({ archive: 'bbbb1111', offset: 34553816, size: 31599 })
    expect(await locator.locate(hex(key(0x10)))).toEqual({ archive: 'aaaa0000', offset: 7, size: 100 })
    expect(await locator.locate(hex(key(0x18)))).toBeUndefined()
    expect(await locator.locate(hex(key(0x30)))).toBeUndefined()
  })

  it('answers nothing for an install without the agent\'s CDN files', async () => {
    const locator = cdnArchiveLocator({ dataRoot: 'SC2Data', cdnKey: 'e4f2e2da310c08495f2701d401d14659', source: source({}) })
    expect(await locator.locate(hex(key(0x20)))).toBeUndefined()
  })

  it('reads one range of an archive and refuses a server that answers the whole archive', async () => {
    const requests: (string | null)[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get('Range')
      requests.push(range)
      return range === 'bytes=10-13'
        ? new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 })
        : new Response(new Uint8Array(64), { status: 200 })
    })
    expect(await cdnFetch('https://cdn.example.test/archive', undefined, [10, 4])).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(await cdnFetch('https://cdn.example.test/archive', undefined, [20, 4])).toBeUndefined()
    expect(requests).toEqual(['bytes=10-13', 'bytes=20-23'])
  })
})
