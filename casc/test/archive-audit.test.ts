import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CachedCascReader } from '../src/casc/cached-reader.js'
import { createCachePolicy } from '../src/casc/cache-policy.js'
import { cdnFetch } from '../src/casc/cdn.js'
import { estimateFullSize } from '../src/casc/estimate.js'
import { CascInstallReader } from '../src/casc/install-reader.js'
import { CascStorage } from '../src/casc/storage.js'
import { encodeBlteStored } from '../src/casc/writer.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('CASC source-audit surfaces', () => {
  it('uses a bounded host-injected CDN fallback, caches successes and observes cancellation', async () => {
    const payload = new TextEncoder().encode('remote CASC bytes')
    const container = encodeBlteStored(payload)
    const urls: string[] = []
    let closes = 0
    const source = {
      close: async () => {
        closes += 1
      },
    }
    const storage = new CascStorage(source, '', {}, [], {
      maxContainerReadBytes: container.byteLength,
      maxDecodedBytes: payload.byteLength,
      cdn: {
        hosts: ['cdn.example.test'],
        path: 'tpr/sc2',
        fetch: async (url: string) => {
          urls.push(url)
          return container
        },
      },
    })
    const key = '00112233445566778899aabbccddeeff'

    await expect(storage.readEncodingKey(key)).resolves.toEqual(payload)
    await expect(storage.readEncodingKey(key)).resolves.toEqual(payload)
    expect(urls).toEqual([
      `https://cdn.example.test/tpr/sc2/data/00/11/${key}`,
    ])

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(storage.readEncodingKey('ffeeddccbbaa99887766554433221100', cancelled.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await storage.close()
    expect(closes).toBe(1)
  })

  it('fails closed when a CDN container exceeds the configured range budget', async () => {
    const storage = new CascStorage({}, '', {}, [], {
      maxContainerReadBytes: 8,
      maxDecodedBytes: 8,
      cdn: {
        hosts: ['cdn.example.test'],
        path: 'tpr/sc2',
        fetch: async () => encodeBlteStored(Uint8Array.of(1)),
      },
    })
    await expect(storage.readEncodingKey('0011223344556677')).rejects.toMatchObject({
      code: 'x3.casc/container-read-budget-exceeded',
    })
  })

  it('keeps cache policy, estimates and install-reader lifecycle explicit', async () => {
    const policy = createCachePolicy('data', { passthroughPrefixes: ['Mods/Streaming'] })
    expect(policy.shouldCache('Mods/Core.SC2Mod/GameData/UnitData.xml')).toBe(true)
    expect(policy.shouldCache('Mods/Core.SC2Mod/Assets/Marine.m3')).toBe(false)
    expect(policy.shouldCache('mods/streaming/readme.txt')).toBe(false)

    const sizes = new Map<string, number | undefined>([
      ['a.xml', 7],
      ['b.txt', undefined],
    ])
    await expect(
      estimateFullSize({
        list: async () => ['A.XML', 'B.TXT'],
        contentSizeOf: (entry: string) => sizes.get(entry),
      }),
    ).resolves.toEqual({ fileCount: 2, totalBytes: 7, unknownSizeCount: 1 })

    let closes = 0
    const reader = new CascInstallReader({
      rootContentKey: 'build-content-key',
      close: async () => {
        closes += 1
      },
    } as never)
    expect(reader.buildGeneration).toBe('build-content-key')
    await reader.close()
    expect(closes).toBe(1)
  })

  it('pulls a cache miss from CASC and persists only policy-approved paths', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modkit-casc-audit-'))
    temporaryDirectories.push(directory)
    const fetched: string[] = []
    const backing = {
      get: async (entry: string) => {
        fetched.push(entry)
        return new TextEncoder().encode(entry)
      },
      exists: async () => true,
    }
    const reader = new CachedCascReader({
      extractDir: directory,
      casc: backing,
      policy: createCachePolicy('data'),
    })
    const textPath = path.join(directory, 'Mods', 'Core.SC2Mod', 'GameData', 'UnitData.xml')
    const modelPath = path.join(directory, 'Mods', 'Core.SC2Mod', 'Assets', 'Marine.m3')

    await reader.get(textPath)
    await reader.get(modelPath)
    expect(fetched).toEqual([
      'mods/core.sc2mod/gamedata/unitdata.xml',
      'mods/core.sc2mod/assets/marine.m3',
    ])
    await expect(fs.readFile(textPath)).resolves.toBeDefined()
    await expect(fs.access(modelPath)).rejects.toBeDefined()
  })

  it('keeps the standalone CDN helper failure-tolerant and byte-exact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.of(3, 1, 4).buffer,
    })))
    await expect(cdnFetch('https://cdn.example.test/object')).resolves.toEqual(
      Uint8Array.of(3, 1, 4),
    )
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(cdnFetch('https://cdn.example.test/missing')).resolves.toBeUndefined()
  })
})
