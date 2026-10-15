import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Codec, ContributionContext, TableDataSource, TreeDataSource } from '@modkit/sdk'
import War3MapW3d from '../src/lib/mdx-m3-viewer/parsers/w3x/w3d/file.js'
import War3MapW3u from '../src/lib/mdx-m3-viewer/parsers/w3x/w3u/file.js'
import { authoredUnitChanges as units, changedObject as object, objectChange as change } from './war3-fixtures.js'
import { budget, context, extension, input, source } from './war3-harness.js'

/**
 * Object-editor changes written by the vendored writer the way the World Editor saves them: a
 * changed footman and a custom unit made from the peasant, and an ability changed at level 2.
 */
const { createCodec } = (await import(pathToFileURL(join(extension, 'dist', 'war3-object-mods', 'codec.js')).href)) as {
  createCodec(context: ContributionContext): Codec
}

function abilities() {
  const file = new War3MapW3d()
  file.version = 2
  file.originalTable.objects.push(object('AHbz', '\0\0\0\0', [change('Hbz2', 0, 6, 2, 2)]))
  return file.save()
}

async function rows(bytes: Uint8Array, name: string) {
  const session = await createCodec(context).open(input(source(bytes, `memory://blizzard-warcraft-3/${name}`)), 'inspect', budget)
  try {
    const lease = await session.dataSource('common.view/table-data-source', 1)
    try {
      const table = lease.value as TableDataSource
      return { header: (await table.shape()).header, rows: (await table.rows({ kind: 'range', from: 0, count: 10 })).items.map(row => row.cells) }
    } finally {
      await lease.release()
    }
  } finally {
    await session.dispose()
  }
}

/** Independent v3 layout: opaque uint32 array then ONE list, in both original/custom tables. */
function v3Bytes(unknownInts: readonly number[], levels: boolean): Uint8Array {
  const bytes: number[] = []
  const integer = (value: number) => { bytes.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24) }
  const id = (value: string) => { bytes.push(...new TextEncoder().encode(value)) }
  integer(3)
  for (const custom of [false, true]) {
    integer(1); id(custom ? 'hpea' : 'hfoo'); custom ? id('h000') : integer(0)
    integer(unknownInts.length)
    for (const value of unknownInts) integer(value)
    integer(2)
    id('uhpm'); integer(0)
    if (levels) { integer(2); integer(3) }
    integer(custom ? 600 : 500); id(custom ? 'h000' : 'hfoo')
    id('unam'); integer(3)
    if (levels) { integer(1); integer(0) }
    id('Guard\0'); id(custom ? 'h000' : 'hfoo')
  }
  return Uint8Array.from(bytes)
}

describe('Warcraft III object-editor changes', () => {
  it('lists every change of the standard and custom units', async () => {
    expect(await rows(units(), 'war3map.w3u')).toEqual({
      header: ['table', 'object', 'base', 'field', 'level', 'data', 'type', 'value'],
      rows: [
        ['original', 'hfoo', '', 'uhpm', '', '', 'int', '999'],
        ['original', 'hfoo', '', 'unam', '', '', 'string', 'Guard'],
        ['custom', 'h000', 'hpea', 'umvs', '', '', 'real', '1.5'],
      ],
    })
  })

  it('reads the level and data column in an ability file', async () => {
    expect((await rows(abilities(), 'Test.w3a')).rows).toEqual([['original', 'AHbz', '', 'Hbz2', '2', '2', 'int', '6']])
  })

  it('reads a format 1 doodad file without those columns, as the 1.24 campaign maps keep it', async () => {
    const file = new War3MapW3u()
    file.version = 1
    file.originalTable.objects.push(object('NWf1', '\0\0\0\0', [change('donc', 0, 1)]))
    expect((await rows(file.save(), 'war3map.w3d')).rows).toEqual([['original', 'NWf1', '', 'donc', '', '', 'int', '1']])
    // The same bytes read with the columns would leave a tail or run short: refused, not guessed.
    expect(() => new War3MapW3d().load(file.save())).toThrow()
  })

  it('shows the tables as a tree', async () => {
    const session = await createCodec(context).open(input(source(units(), 'memory://blizzard-warcraft-3/war3map.w3u')), 'inspect', budget)
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as TreeDataSource
        const facts = async (nodes: readonly unknown[]) =>
          Promise.all(nodes.map(async node => (await tree.facts(node as never)) as { label: string; preview?: string }))
        const tables = (await tree.children(await tree.root(), { limit: 10 })).items
        expect((await facts(tables)).map(node => [node.label, node.preview])).toEqual([
          ['Changed standard objects', '1'],
          ['Custom objects', '1'],
        ])
        const custom = (await tree.children(tables[1]!, { limit: 10 })).items
        expect((await facts(custom)).map(node => [node.label, node.preview])).toEqual([['h000', 'from hpea, 1 changes']])
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('refuses a file whose name is not one of the object-editor kinds', async () => {
    await expect(rows(units(), 'war3map.bin')).rejects.toThrow()
  })

  it('refuses the obsolete invented repeated-set layout instead of treating it as native v3', async () => {
    const bytes = new Uint8Array(72)
    const view = new DataView(bytes.buffer)
    let at = 0
    const integer = (value: number) => { view.setInt32(at, value, true); at += 4 }
    const id = (value: string) => { bytes.set(new TextEncoder().encode(value), at); at += 4 }
    integer(3); integer(1); id('hfoo'); integer(0); integer(2)
    for (const [flag, field, value] of [[0, 'uhpm', 500], [1, 'umvs', 300]] as const) {
      integer(flag); integer(1); id(field); integer(0); integer(value); id('hfoo')
    }
    integer(0)
    expect(at).toBe(bytes.length)
    await expect(rows(bytes, 'war3map.w3u')).rejects.toThrow()
  })

  it.each([
    { unknownInts: [], levels: false }, { unknownInts: [0], levels: false },
    { unknownInts: [0, 1, 0xffffffff], levels: false },
    { unknownInts: [], levels: true }, { unknownInts: [0], levels: true },
    { unknownInts: [0, 1, 0xffffffff], levels: true },
  ])('preserves the opaque header and single list $unknownInts with levels=$levels', async ({ unknownInts, levels }) => {
    const bytes = v3Bytes(unknownInts, levels)
    const file = levels ? new War3MapW3d() : new War3MapW3u()
    file.load(bytes)
    for (const table of [file.originalTable, file.customTable]) {
      expect(table.objects[0]!.unknownInts).toEqual(unknownInts)
      expect(table.objects[0]!.modifications.map(item => item.id)).toEqual(['uhpm', 'unam'])
      expect(table.objects[0]!.modifications.map(item => item.value)).toEqual([table === file.originalTable ? 500 : 600, 'Guard'])
    }
    expect(file.getByteLength()).toBe(bytes.length)
    expect(file.save()).toEqual(bytes)
    const result = await rows(bytes, levels ? 'war3map.w3a' : 'war3map.w3u')
    expect(result.header?.at(-1)).toBe('v3-unknown-ints')
    expect(result.rows).toHaveLength(4)
    expect(result.rows.map(row => row.at(-1))).toEqual(Array(4).fill(unknownInts.join(',')))
    expect(result.rows[0]!.slice(3, 8)).toEqual(['uhpm', levels ? '2' : '', levels ? '3' : '', 'int', '500'])
    file.version = 2
    if (unknownInts.length > 0) expect(() => file.save()).toThrow('unknown header')
  })

  it('rejects truncated headers, changes, count overflows and trailing bytes', async () => {
    const bytes = v3Bytes([0, 1], false)
    for (const length of [0, 3, 19, 23, bytes.length - 1])
      await expect(rows(bytes.slice(0, length), 'war3map.w3u')).rejects.toThrow()
    const overflow = bytes.slice()
    new DataView(overflow.buffer).setUint32(16, 0xffffffff, true)
    await expect(rows(overflow, 'war3map.w3u')).rejects.toThrow('unknown integer array')
    const changesOverflow = bytes.slice()
    new DataView(changesOverflow.buffer).setUint32(28, 0xffffffff, true)
    await expect(rows(changesOverflow, 'war3map.w3u')).rejects.toThrow('modification count')
    const tail = new Uint8Array(bytes.length + 1)
    tail.set(bytes)
    await expect(rows(tail, 'war3map.w3u')).rejects.toThrow('bytes after')
  })

  it.each([-1, 0x100000000, 0.5, NaN])('refuses an invalid opaque integer %s on write', value => {
    const file = new War3MapW3u()
    file.version = 3
    file.originalTable.objects.push(Object.assign(object('hfoo', '\0\0\0\0', []), { unknownInts: [value] }))
    expect(() => file.save()).toThrow('uint32')
  })

  it('shows opaque headers even when an object has no changes, and charges their node budget', async () => {
    const file = new War3MapW3u()
    file.version = 3
    file.originalTable.objects.push(Object.assign(object('hfoo', '\0\0\0\0', []), { unknownInts: [42] }))
    const bytes = file.save()
    expect((await rows(bytes, 'war3map.w3u')).rows).toEqual([])
    const session = await createCodec(context).open(input(source(bytes, 'memory://blizzard-warcraft-3/war3map.w3u')), 'inspect', budget)
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as TreeDataSource
        const table = (await tree.children(await tree.root(), { limit: 2 })).items[0]!
        const node = (await tree.children(table, { limit: 2 })).items[0]!
        const header = (await tree.children(node, { limit: 2 })).items[0]!
        expect(await tree.facts(header)).toMatchObject({ label: 'v3 unknown integers', preview: '[42]' })
      } finally { await lease.release() }
    } finally { await session.dispose() }
    await expect(createCodec(context).open(input(source(bytes, 'memory://blizzard-warcraft-3/war3map.w3u')), 'inspect', { ...budget, maxNodes: 1 }))
      .rejects.toThrow('node budget')
  })
})
