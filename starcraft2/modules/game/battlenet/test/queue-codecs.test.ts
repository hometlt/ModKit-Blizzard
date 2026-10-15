import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { definition as queueDefinition } from '../codecs/queue-header/src/codec.js'
import { definition as queueLocaleDefinition } from '../codecs/queue-locale/src/codec.js'
import { encodeCacheHeader, type CacheNode } from '../content-sources/cache-header.js'
import { decodeQueueHeader, ladderMode, readQueueHeader } from '../content-sources/queue-header.js'

const budget = { budget: { maxNodes: 10000 } }
const n = (value: number): CacheNode => ({ kind: 9, value: BigInt(value) })
const struct = (entries: [number, CacheNode][]): CacheNode => ({ kind: 5, value: new Map(entries.map(([tag, node]) => [BigInt(tag), node])) })
const list = (items: CacheNode[]): CacheNode => ({ kind: 0, value: items })
const four = (text: string): CacheNode => ({ kind: 7, value: new TextEncoder().encode(text.padStart(4, '\0')) })
const blob = (bytes: Uint8Array): CacheNode => ({ kind: 2, value: bytes })
const handle = (type: string, region: string, sha256: string) => {
  const bytes = new Uint8Array(40)
  bytes.set(new TextEncoder().encode(type), 0)
  bytes.set(new TextEncoder().encode(region), 6)
  bytes.set(Buffer.from(sha256, 'hex'), 8)
  return bytes
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** A queue locale table as the depot serves them (lower-case root). */
const localeTable = (strings: Record<number, string>) => new TextEncoder().encode(
  `<?xml version="1.0" encoding="utf-8"?><locale locale="enUS">${Object.entries(strings).map(([id, text]) => `<e id="${id}">${text}</e>`).join('')}</locale>`)

/** A queue header shaped as the game's (tags of `Battlenet::MatchMaker::Header`), with synthetic values. */
function queueHeader(options: { id: number; version: number; teamSize: number; tags: string[]; maps: number[]; locales: Record<string, Uint8Array> }) {
  const mapSpec = (id: number) => struct([[0, struct([
    [0, n(0)], [1, four('Fasr')],
    [3, list([struct([[0, struct([[0, n(id)], [1, n(0)]])], [1, n(0)]]), struct([[0, struct([[0, n(900001)], [1, n(0)]])], [1, n(1)]])])],
  ])], [1, list([])]])
  const text = (id: number) => struct([[0, { kind: 4, value: undefined }], [1, n(0)], [2, n(id)]])
  return encodeCacheHeader(struct([
    [0, struct([
      [2, list(Object.entries(options.locales).map(([locale, table]) =>
        struct([[0, { kind: 7, value: new TextEncoder().encode(locale) }], [1, list([blob(handle('s2ql', 'EU', createHash('sha256').update(table).digest('hex')))])]])))],
      [4, text(1)], [5, text(0)], [8, n(options.teamSize)], [9, n(2)], [11, four('1v1')],
      [14, list(options.tags.map(four))], [16, { kind: 6, value: Uint8Array.of(1) }],
    ])],
    [2, struct([[0, n(2)], [1, four('S2')], [3, n(options.id)], [4, n(options.version)]])],
    [3, list(options.maps.map(mapSpec))],
  ]))
}

describe('matchmaking queue headers', () => {
  const english = localeTable({ 0: '1V1', 1: 'Ranked 1v1' })
  const russian = localeTable({ 0: '1НА1', 1: 'Рейтинговая 1 на 1' })
  const bytes = queueHeader({ id: 201, version: 163, teamSize: 1, tags: ['Comp', 'FOS', 'LotV', 'Ladd', 'Solo'], maps: [300001, 300002, 300003], locales: { enUS: english, ruRU: russian } })

  it('reads the queue, its tags and its map pool', () => {
    const queue = decodeQueueHeader(bytes)
    expect(queue).toMatchObject({ region: 'EU', program: 'S2', id: 201, version: 163, teamSize: 1, teamCount: 2, active: true,
      tags: ['Comp', 'FOS', 'LotV', 'Ladd', 'Solo'], name: { table: 0, id: 1 } })
    expect(queue.maps).toEqual([300001, 300002, 300003].map(id => ({ id, mods: [900001], variantIndex: 0, speed: 'Fasr' })))
    expect(ladderMode(queue)).toBe('1v1')
    expect(ladderMode({ ...queue, tags: ['Coop', 'LotV'] })).toBeUndefined()
  })

  it('names the queue from its locale tables, preferring the asked locale', async () => {
    const files = new Map([english, russian].map(table => [createHash('sha256').update(table).digest('hex'), table]))
    const headerHandle = hex(handle('s2qh', 'EU', 'ab'.repeat(32)))
    const readComponent = async (request: { handle: string }) => {
      if (request.handle === headerHandle) return bytes
      const found = files.get(request.handle.slice(16))
      if (!found) throw new Error('not on the depot')
      return found
    }
    const signal = new AbortController().signal
    expect(await readQueueHeader(readComponent, { region: 'eu', headerHandle, locale: 'ruRU', signal }))
      .toMatchObject({ id: 201, version: 163, name: 'Рейтинговая 1 на 1', shortName: '1НА1', headerHandle, ladderMode: '1v1' })
    expect(await readQueueHeader(readComponent, { region: 'eu', headerHandle, signal })).toMatchObject({ name: 'Ranked 1v1', shortName: '1V1' })
  })

  it('shows a queue header as the game names its fields, and the pool as a table', async () => {
    expect((await queueDefinition.detect(bytes, 'file:///cache/ab/cd/abcd.s2qh')).confidence).toBe(1)
    const result = await queueDefinition.inspect(bytes, budget)
    expect(result.summary).toMatchObject({ format: 'sc2-queue-header', region: 'EU', id: 201, version: 163, maps: 3, ladder: '1v1' })
    const table = result.dataSources['common.view/table-data-source'] as unknown as {
      rows(request: { kind: string; from: number; count: number }): Promise<{ items: { cells: string[] }[] }>
    }
    const page = await table.rows({ kind: 'range', from: 0, count: 10 })
    expect(page.items.map(row => row.cells[1])).toEqual(['300001', '300002', '300003'])
    const tree = result.dataSources['common.view/tree-data-source'] as unknown as {
      root(): Promise<unknown>
      children(node: unknown, page: unknown): Promise<{ items: readonly unknown[] }>
      facts(node: unknown): Promise<Record<string, unknown>>
    }
    const fields = (await tree.children(await tree.root(), { limit: 10 })).items
    const labels = await Promise.all(fields.map(async node => (await tree.facts(node))['label']))
    expect(labels).toEqual(['HeaderBase', 'm_handle', 'm_maps'])
    const base = (await tree.children(fields[0], { limit: 50 })).items
    expect(await Promise.all(base.map(async node => (await tree.facts(node))['label']))).toContain('m_teamSize')
  })

  it('reads a queue locale table', async () => {
    expect((await queueLocaleDefinition.detect(english, 'file:///cache/ab/cd/abcd.s2ql')).confidence).toBe(1)
    const result = await queueLocaleDefinition.inspect(english, { ...budget, input: {} } as never)
    expect(result.summary).toMatchObject({ rootTag: 'locale', elements: 2 })
    expect(result.diagnostics).toEqual([])
  })
})
