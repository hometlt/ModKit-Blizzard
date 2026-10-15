import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(pathToFileURL(join(extension, 'src', 'diablo3-stl', 'codec.js')).href)) as {
  createCodec: (context: unknown) => {
    open: (input: unknown, mode: string, budget: unknown) => Promise<Session>
  }
}

interface Session {
  descriptor: () => Promise<{ diagnostics?: { code: string }[] }>
  dataSource: (contract: string, major: number) => Promise<{ value: unknown; release: () => Promise<void> }>
  dispose: () => Promise<void>
}

const budget = { maxInputBytes: 10n ** 9n, maxDepth: 128, maxNodes: 1_000_000, maxScalarBytes: 64 * 1024 * 1024, maxDiagnostics: 200 }
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service is needed')
    },
    async resolveUnknown() {
      throw new Error('no service is needed')
    },
  },
}

/** A StringList laid out as the game stores one: preamble, entry array at data offset 0x28, strings. */
function stringList(entries: readonly (readonly [string, string, number?])[]): Uint8Array {
  const encoder = new TextEncoder()
  const table = 0x38
  const strings: number[] = []
  const records = entries.map(([label, text, hash]) => {
    const place = (value: string) => {
      const bytes = [...encoder.encode(value), 0]
      const offset = table + entries.length * 40 + strings.length - 0x10
      strings.push(...bytes)
      return { offset, size: bytes.length }
    }
    const labelBytes = encoder.encode(label)
    let djb2 = 0
    for (const byte of labelBytes) djb2 = (Math.imul(djb2, 33) + byte) >>> 0 // an ASCII label; others pass the game's hash
    return { label: place(label), text: place(text), hash: hash ?? djb2 }
  })
  const bytes = new Uint8Array(table + entries.length * 40 + strings.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xdeadbeef, true)
  view.setUint32(4, 45, true)
  view.setInt32(0x10, 1234, true)
  view.setUint32(0x28, 0x28, true)
  view.setUint32(0x2c, entries.length * 40, true)
  records.forEach((record, index) => {
    const at = table + index * 40
    view.setUint32(at + 8, record.label.offset, true)
    view.setUint32(at + 12, record.label.size, true)
    view.setUint32(at + 24, record.text.offset, true)
    view.setUint32(at + 28, record.text.size, true)
    view.setUint32(at + 32, record.hash, true)
  })
  bytes.set(strings, table + entries.length * 40)
  return bytes
}

function input(bytes: Uint8Array) {
  const uri = 'memory://list.stl'
  const revision = 'content-hash.sha256:list'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single',
    bindings: [{ sourceKind: 'candidate', bindingId: 'content', role: 'content', ownership: 'owned', source: value.ref, revision }],
    primaryBindingId: 'content',
    revisions: { topology: 'single', revision, bindings: [{ bindingId: 'content', revision }], compositionFingerprint: uri },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

async function open(bytes: Uint8Array) {
  return codec.createCodec(context).open(input(bytes), 'inspect', budget)
}

describe('Diablo III StringList', () => {
  it('reads labels and texts with the game markup kept verbatim', async () => {
    const session = await open(stringList([['Unstoppable_desc', 'Longest Kill Streak {s1}'], ['Rockworm_A', 'Камнеед']]))
    const table = await session.dataSource('common.view/table-data-source', 1)
    const rows = await (table.value as { rows: (request: unknown) => Promise<{ items: { cells: string[] }[] }> }).rows({ kind: 'range', from: 0, count: 10 })
    expect(rows.items.map(row => row.cells.slice(0, 2))).toEqual([
      ['Unstoppable_desc', 'Longest Kill Streak {s1}'],
      ['Rockworm_A', 'Камнеед'],
    ])
    await table.release()
    expect((await session.descriptor()).diagnostics ?? []).toEqual([])
    await session.dispose()
  })

  it('hashes a label byte above 127 as the game does, as a signed char', async () => {
    // stringlist/credits.stl on the installed game (2.8.0.99920) stores exactly this pair
    const session = await open(stringList([['name-Johannes Thé-00000', 'Johannes Thé', 0x4dd6d409]]))
    expect((await session.descriptor()).diagnostics ?? []).toEqual([])
    await session.dispose()
  })

  it('opens an empty list, which stores a zero offset and size', async () => {
    const bytes = stringList([])
    new DataView(bytes.buffer).setUint32(0x28, 0, true)
    const session = await open(bytes)
    const table = await session.dataSource('common.view/table-data-source', 1)
    expect(await (table.value as { shape: () => Promise<{ rows: number }> }).shape()).toMatchObject({ rows: 0 })
    await table.release()
    await session.dispose()
  })

  it('reports a stored hash that is not the hash of its label', async () => {
    const session = await open(stringList([['Healing', 'Лечение', 7]]))
    expect((await session.descriptor()).diagnostics?.map(item => item.code)).toEqual(['blizzard.diablo3-stl/label-hash-mismatch'])
    await session.dispose()
  })

  it('refuses a string that runs past the end of the file', async () => {
    const bytes = stringList([['Healing', 'Лечение']])
    new DataView(bytes.buffer).setUint32(0x38 + 28, 4096, true)
    await expect(open(bytes).then(session => session.descriptor())).rejects.toThrow(/terminated string inside the file/u)
  })
})
