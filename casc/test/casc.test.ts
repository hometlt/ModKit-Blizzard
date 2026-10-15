import { describe, expect, it } from 'vitest'

import { cacheIndexEnabled, createCascNamespaceSource, detectCascMarkers } from '../src/casc/codec.js'
import { cascProductOf, parseBuildInfo } from '../src/casc/config.js'
import { CASC_LIMITS } from '../src/casc/limits.js'
import { arrayPathIndex } from '../src/casc/path-index.js'
import { cascSourceFromNamespace } from '../src/casc/source.js'

const revision = 'content-hash.sha256:casc-test'
const sourceRef = { id: 'casc-test', uri: 'memory://casc-test' }

function fakeReader(count = 300) {
  const entries = Object.freeze(
    Array.from({ length: count }, (_, index) => ({
      path: `files/entry-${String(index).padStart(4, '0')}.bin`,
      contentSize: index + 1,
    })),
  )
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  return {
    entryIndex: arrayPathIndex(entries),
    resolveFile(path: string) {
      return byPath.get(path)
    },
  }
}

describe('CASC namespace adapter', () => {
  it('reads the product code of a build even where .build.info leaves Product empty', () => {
    const header = 'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Path!STRING:0|Product!STRING:0'
    const build = (product: string, cdnPath: string) =>
      parseBuildInfo(`${header}\neu|1|5bc8dcc1fade3a320c12936586b7c0ed|${cdnPath}|${product}\n`)[0]!
    expect(cascProductOf(build('', 'tpr/sc2'))).toBe('s2')
    expect(cascProductOf(build('', 'tpr/diablo3'))).toBe('d3')
    expect(cascProductOf(build('', 'tpr/hero'))).toBe('hero')
    expect(cascProductOf(build('', 'tpr/Hero-Live-a'))).toBe('hero')
    expect(cascProductOf(build('', 'tpr/sc1live'))).toBe('s1')
    expect(cascProductOf(build('wow_classic', 'tpr/wow'))).toBe('wow_classic')
  })

  it('switches the name-index cache per game, then for all games, else keeps it on', () => {
    expect(cacheIndexEnabled({}, 'd3')).toBe(true)
    expect(cacheIndexEnabled({ cacheIndex: false }, 'd3')).toBe(false)
    expect(cacheIndexEnabled({ games: { d3: { cacheIndex: false } } }, 'd3')).toBe(false)
    expect(cacheIndexEnabled({ games: { d3: { cacheIndex: false } } }, 's2')).toBe(true)
    expect(cacheIndexEnabled({ cacheIndex: false, games: { s2: { cacheIndex: true } } }, 's2')).toBe(true)
  })


  it('detects .build.info beside one complete data directory of any Blizzard product', async () => {
    const storage = (dir: string) => [
      { path: '.build.info', kind: 'file' },
      { path: `${dir}/config`, kind: 'directory' },
      { path: `${dir}/data`, kind: 'directory' },
      { path: `${dir}/indices`, kind: 'directory' },
    ]
    // StarCraft II, Heroes of the Storm, Diablo III and most other installs.
    for (const dir of ['SC2Data', 'HeroesData', 'Data']) {
      await expect(detectCascMarkers(storage(dir))).resolves.toMatchObject({
        confidence: 0.99,
        kind: 'structure',
        note: `CASC installation structure (${dir})`,
      })
    }
    await expect(
      detectCascMarkers([
        { path: '.build.info', kind: 'file' },
        { path: 'Data/data', kind: 'directory' },
      ]),
    ).resolves.toMatchObject({ confidence: 0 })
    // The storage folders must share one data directory.
    await expect(
      detectCascMarkers([
        { path: '.build.info', kind: 'file' },
        { path: 'SC2Data/config', kind: 'directory' },
        { path: 'Data/data', kind: 'directory' },
        { path: 'Data/indices', kind: 'directory' },
      ]),
    ).resolves.toMatchObject({ confidence: 0 })
    await expect(detectCascMarkers(storage('Data').slice(1))).resolves.toMatchObject({
      confidence: 0,
    })
  })

  it('answers an exact path the reader resolves but the table does not spell (Diablo III SNO)', async () => {
    const stone = { path: 'textures/stone.tex', contentSize: 7 }
    // As Diablo3NameDb.getByPath resolves `Textures/<sno>.tex` by asset id.
    const byPath = new Map([
      [stone.path, stone],
      ['textures/42.tex', stone],
    ])
    const reader = {
      entryIndex: arrayPathIndex([stone]),
      resolveFile: (path: string) => byPath.get(path),
      contentSizeOf: (path: string) => byPath.get(path)?.contentSize,
    }
    const namespace = createCascNamespaceSource(reader, sourceRef, revision)
    const alias = await namespace.list('Textures/42.tex', { limit: 4 })
    expect(alias.items).toMatchObject([{ id: 'textures/42.tex', path: 'textures/42.tex', size: 7n }])
    expect(alias.nextCursor).toBeUndefined()
    // A folder lists the table's own names only; an unknown number stays unknown.
    const folder = await namespace.list('textures/', { limit: 4 })
    expect(folder.items.map(item => item.path)).toEqual(['textures/stone.tex'])
    await expect(namespace.list('textures/43.tex', { limit: 4 })).resolves.toMatchObject({ items: [] })
    await expect(namespace.openEntry('textures/42.tex')).resolves.toBeDefined()
    // An exact lookup (a nested open) finds the same paths without a walk, under the asked spelling.
    await expect(namespace.lookup('textures/42.tex')).resolves.toMatchObject({
      id: 'textures/42.tex',
      size: 7n,
    })
    await expect(namespace.lookup('Textures\\42.tex')).resolves.toMatchObject({
      id: 'Textures/42.tex',
      name: '42.tex',
    })
    await expect(namespace.lookup('textures/stone.tex')).resolves.toMatchObject({
      id: 'textures/stone.tex',
    })
    await expect(namespace.lookup('textures/43.tex')).resolves.toBeUndefined()
    await expect(namespace.lookup('textures')).resolves.toBeUndefined()
    await expect(namespace.openEntry('Textures/42.tex')).resolves.toBeDefined()
  })

  it('lists stable pages, enforces the page cap and honors cancellation', async () => {
    const namespace = createCascNamespaceSource(fakeReader(), sourceRef, revision)
    const first = await namespace.list('files/', { limit: 2 })
    expect(first.items.map(item => item.path)).toEqual([
      'files/entry-0000.bin',
      'files/entry-0001.bin',
    ])
    const second = await namespace.list('files/', { cursor: first.nextCursor, limit: 2 })
    expect(second.items.map(item => item.path)).toEqual([
      'files/entry-0002.bin',
      'files/entry-0003.bin',
    ])
    const capped = await namespace.list('', { limit: CASC_LIMITS.maxPageItems + 256 })
    expect(capped.items).toHaveLength(CASC_LIMITS.maxPageItems)
    expect(capped.nextCursor).toBeDefined()

    const controller = new AbortController()
    controller.abort()
    await expect(namespace.list('', { limit: 1 }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('lists immediate CASC children without scanning the flattened namespace', async () => {
    const entries = Object.freeze([
      { path: 'campaigns/liberty.sc2campaign/base.sc2data/game.xml', contentSize: 1 },
      { path: 'mods/core.sc2mod/base.sc2data/game.xml', contentSize: 2 },
      { path: 'mods/liberty.sc2mod/base.sc2data/game.xml', contentSize: 3 },
    ])
    const namespace = createCascNamespaceSource(
      {
        entryIndex: arrayPathIndex(entries),
        resolveFile(path: string) {
          return entries.find(entry => entry.path === path)
        },
      },
      sourceRef,
      revision,
    )

    await expect(namespace.children('', { limit: 8 })).resolves.toMatchObject({
      items: [
        { path: 'Campaigns', name: 'Campaigns', kind: 'directory' },
        { path: 'Mods', name: 'Mods', kind: 'directory' },
      ],
    })
    await expect(namespace.children('Mods', { limit: 8 })).resolves.toMatchObject({
      items: [
        { path: 'Mods/core.sc2mod', name: 'core.sc2mod', kind: 'directory' },
        { path: 'Mods/liberty.sc2mod', name: 'liberty.sc2mod', kind: 'directory' },
      ],
    })
  })

  it('searches marker basenames in bounded source-index pages without retaining every match', async () => {
    const commonEntries = Object.freeze(
      Array.from({ length: 20_000 }, (_, index) => ({
        path: `maps/map-${String(index).padStart(5, '0')}.sc2map/index`,
        contentSize: index + 1,
      })),
    )
    const byPath = new Map(commonEntries.map(item => [item.path, item]))
    const namespace = createCascNamespaceSource(
      {
        entryIndex: arrayPathIndex(commonEntries),
        resolveFile(path: string) {
          return byPath.get(path)
        },
      },
      sourceRef,
      revision,
    )
    const first = await namespace.search(
      { kind: 'basename-any', basenames: ['INDEX'], caseSensitive: false },
      { limit: 2 },
    )
    expect(first.items.map(item => item.path)).toEqual([
      'maps/map-00000.sc2map/index',
      'maps/map-00001.sc2map/index',
    ])
    expect(first.nextCursor).toBe('2')
    const second = await namespace.search(
      { kind: 'basename-any', basenames: ['index'], caseSensitive: false },
      { cursor: first.nextCursor, limit: 2 },
    )
    expect(second.items.map(item => item.path)).toEqual([
      'maps/map-00002.sc2map/index',
      'maps/map-00003.sc2map/index',
    ])

    await expect(
      namespace.search(
        { kind: 'basename-any', basenames: ['index', 'INDEX'], caseSensitive: false },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ code: 'x3.casc/search-query-invalid' })
    await expect(
      namespace.search(
        {
          kind: 'basename-any',
          basenames: Array.from(
            { length: CASC_LIMITS.maxSearchBasenames + 1 },
            (_, index) => `marker-${String(index)}`,
          ),
          caseSensitive: true,
        },
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ code: 'x3.casc/search-query-invalid' })
    await expect(
      namespace.search(
        { kind: 'basename-any', basenames: ['index'], caseSensitive: false },
        { cursor: '20001', limit: 1 },
      ),
    ).rejects.toMatchObject({ code: 'x3.casc/search-cursor-invalid' })
  })

  it('chunks Host reads and rejects oversized ranges before opening a file', async () => {
    const size = CASC_LIMITS.maxHostReadBytes + 1
    const reads: number[] = []
    let opens = 0
    const namespace = {
      async open() {
        opens += 1
        return {
          value: {
            kind: 'bytes' as const,
            size: BigInt(size),
            async read(_offset: bigint, length: number) {
              reads.push(length)
              return new Uint8Array(length)
            },
          },
          async release() {
            return undefined
          },
        }
      },
      async *list() {
        return undefined
      },
    }
    const source = cascSourceFromNamespace(namespace)
    await expect(source.get('metadata.bin')).resolves.toHaveLength(size)
    expect(reads).toEqual([CASC_LIMITS.maxHostReadBytes, 1])
    await expect(
      source.getRange('data.000', 0, CASC_LIMITS.maxContainerReadBytes + 1),
    ).rejects.toMatchObject({ code: 'x3.casc/container-read-budget-exceeded' })
    expect(opens).toBe(1)
  })

  it('bounds each read, not the session: extracts keep working past 256 MiB in total', async () => {
    const chunk = new Uint8Array(CASC_LIMITS.maxHostReadBytes)
    const namespace = {
      async open() {
        return {
          value: {
            kind: 'bytes' as const,
            size: BigInt(CASC_LIMITS.maxContainerReadBytes),
            async read(_offset: bigint, length: number) {
              return chunk.subarray(0, length)
            },
          },
          async release() {
            return undefined
          },
        }
      },
      async *list() {
        return undefined
      },
    }
    const source = cascSourceFromNamespace(namespace)
    // Five full container ranges: 320 MiB through one session, which once refused after 256 MiB.
    for (let read = 0; read < 5; read += 1) {
      await expect(
        source.getRange('data.000', 0, CASC_LIMITS.maxContainerReadBytes),
      ).resolves.toHaveLength(CASC_LIMITS.maxContainerReadBytes)
    }
  })

  it('bounds directory listings and cancellation at the namespace boundary', async () => {
    const namespace = {
      async open() {
        throw Object.assign(new Error('not found'), {
          code: 'x3.host/namespace-entry-not-found',
        })
      },
      async *list() {
        for (let index = 0; index <= CASC_LIMITS.maxListEntries; index += 1) {
          yield { path: `entry-${index}`, kind: 'bytes' as const }
        }
      },
    }
    await expect(cascSourceFromNamespace(namespace).list('SC2Data/data')).rejects.toMatchObject({
      code: 'x3.casc/list-entry-budget-exceeded',
    })

    const controller = new AbortController()
    controller.abort()
    await expect(
      cascSourceFromNamespace(namespace, controller.signal).exists('entry'),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
