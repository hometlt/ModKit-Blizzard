/**
 * `edit.field` is a translation, not a second writer.
 *
 * The surfaces (tree, table, metadata panel) invoke it with a `FieldWriteRequest`; it resolves the
 * section and key and hands the write to the raw-preserving MK2 patcher that `edit.content` has
 * always used. These tests pin that equivalence: the bytes an inline edit produces must be the
 * bytes MK2 produces for the same change, and the resolution rules must refuse rather than write
 * to the wrong key when the request does not identify one.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { patchBankValueXml } from '../shared/core/patcher.js'
import { createCodec } from '../codecs/bank/src/codec.js'

const FIXTURE_URL = new URL(
  './fixtures/endofdreamsbank2.SC2Bank',
  import.meta.url,
)
const FIXTURE_XML = readFileSync(FIXTURE_URL, 'utf8').trim()
const FIXTURE_BYTES = new TextEncoder().encode(FIXTURE_XML)
const decoder = new TextDecoder()

function input() {
  const uri = 'memory://bank/endofdreamsbank2.SC2Bank'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: 'content-hash.sha256:fixture',
    size: BigInt(FIXTURE_BYTES.byteLength),
    async read(offset: bigint, length: number) {
      return FIXTURE_BYTES.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield FIXTURE_BYTES
    },
  }
  const binding = {
    sourceKind: 'candidate',
    bindingId: 'content',
    role: 'content',
    ownership: 'owned',
    source: source.ref,
    revision: source.revision,
  }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: binding.bindingId,
    revisions: {
      topology: 'single',
      revision: source.revision,
      bindings: [{ bindingId: binding.bindingId, revision: source.revision }],
      compositionFingerprint: source.ref.id,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, async release() {} }
    },
  } as never
}

const budget = {
  maxInputBytes: 400000000n,
  maxDepth: 64,
  maxNodes: 100000,
  maxScalarBytes: 104857600,
  maxDiagnostics: 1000,
} as never

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service dependency in this test')
    },
    async resolveUnknown() {
      throw new Error('no foreign service in this test')
    },
  },
} as never

async function openSession() {
  const codec = createCodec(context)
  const session = await codec.open(input(), 'edit', budget)
  return session
}

/** Operations live behind their own session; a data-source session never writes. */
async function invokeField(
  session: { operations(): { invoke(id: string, input: unknown): Promise<unknown> } },
  request: unknown,
) {
  return session.operations().invoke('edit-field', request as never)
}

/** Apply the bytes of an edit plan to the fixture, the way a commit coordinator would. */
function applyPlan(result: unknown): string {
  const record = result as {
    state?: string
    reason?: string
    output?: { plan?: { edits?: readonly { bytes: Uint8Array }[] } }
    plan?: { edits?: readonly { bytes: Uint8Array }[] }
  }
  if (record.state === 'rejected') throw new Error(`refused: ${String(record.reason)}`)
  const plan = record.output?.plan ?? record.plan
  const edit = plan?.edits?.[0] as Record<string, unknown> | undefined
  if (edit === undefined) throw new Error(`the plan carried no edit: ${JSON.stringify(record)}`)
  /*
   * A `replace` SourceEdit carries the new bytes as an inline payload; the range says what they
   * supersede. The bytes survive the operation boundary as an index-keyed object rather than a
   * `Uint8Array`, so they are rebuilt here the way a commit coordinator would.
   */
  const payload = edit['payload'] as { kind?: string; bytes?: unknown } | undefined
  if (payload?.kind !== 'inline' || payload.bytes === undefined) {
    throw new Error(`the edit carried no inline payload: ${JSON.stringify(payload).slice(0, 120)}`)
  }
  const bytes = ArrayBuffer.isView(payload.bytes)
    ? (payload.bytes as Uint8Array)
    : Uint8Array.from(Object.values(payload.bytes as Record<string, number>))
  return decoder.decode(bytes)
}

describe('sc2-bank edit.field', () => {
  it('writes the same bytes MK2’s patcher writes for the same change', async () => {
    const session = await openSession()
    try {
      const result = await invokeField(session, {
        groupId: 'tree',
        key: 'TotalKills',
        path: ['Stats', 'TotalKills'],
        value: 42,
      })
      expect((result as { state?: string }).state).not.toBe('rejected')
      const produced = applyPlan(result)
      const expected = patchBankValueXml(FIXTURE_XML, {
        section: 'Stats',
        key: 'TotalKills',
        type: 'int',
        value: '42',
      })
      expect(expected.ok).toBe(true)
      expect(produced).toBe((expected as { xml: string }).xml)
      // Only the one attribute moved: everything else in the file is byte-identical.
      expect(produced.replace('int="42"', 'int="9999999"')).toBe(FIXTURE_XML)
    } finally {
      await session.dispose()
    }
  })

  it('keeps the declared type from the document rather than taking one from the request', async () => {
    const session = await openSession()
    try {
      const result = await invokeField(session, {
        groupId: 'tree',
        key: 'Rank',
        path: ['Ranks', 'Rank'],
        // A request cannot retype a value: `Rank` is a string in the file and stays one.
        type: 'int',
        value: 'Champion',
      } as never)
      const produced = applyPlan(result)
      expect(produced).toContain('string="Champion"')
      expect(produced).not.toContain('int="Champion"')
    } finally {
      await session.dispose()
    }
  })

  it('resolves a table write by the row order the codec itself published', async () => {
    const session = await openSession()
    try {
      const lease = await session.dataSource('common.view/table-data-source', 1)
      try {
        const page = await (lease.value as never as {
          rows(request: unknown): Promise<{ items: readonly { cells: readonly string[] }[] }>
        }).rows({ kind: 'range', from: 0, count: 10 })
        const row = 1 // Stats / TotalKills, per the published order
        expect(page.items[row]?.cells.slice(0, 2)).toEqual(['Stats', 'TotalKills'])
        const result = await invokeField(session, {
          groupId: 'table',
          key: 'Value',
          path: [String(row), '3'],
          value: 7,
        } as never)
        expect(applyPlan(result)).toContain('int="7"')
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('refuses a request that does not identify a key instead of writing somewhere', async () => {
    const session = await openSession()
    try {
      await expect(
        invokeField(session, { groupId: 'tree', key: 'x', value: 1 }),
      ).rejects.toThrow(/semantic path/u)
      await expect(
        invokeField(session, {
          groupId: 'tree',
          key: 'x',
          path: ['Nope', 'Missing'],
          value: 1,
        }),
      ).rejects.toThrow(/no bank key/u)
      await expect(
        invokeField(session, {
          groupId: 'table',
          key: 'Value',
          path: ['9999', '3'],
          value: 1,
        }),
      ).rejects.toThrow(/no bank key at table row/u)
    } finally {
      await session.dispose()
    }
  })

  it('resolves a metadata-panel write by the Section/Key the properties group publishes', async () => {
    const session = await openSession()
    try {
      const descriptor = await session.descriptor()
      const group = (descriptor as never as {
        metadata: readonly { id: string; entries: readonly Record<string, unknown>[] }[]
      }).metadata.find(item => item.id === 'values')
      expect(group).toBeDefined()
      const entry = group!.entries.find(item => item['key'] === 'Stats/TotalKills')
      // The panel offers a control only when the codec typed the entry and said how to write it.
      expect(entry?.['type']).toEqual({ kind: 'number', integer: true })
      expect(entry?.['editable']).toEqual({ write: { operation: 'edit.field' }, editor: 'scalar' })
      const result = await invokeField(session, {
        groupId: 'values',
        key: 'Stats/TotalKills',
        value: 5,
      })
      expect(applyPlan(result)).toContain('int="5"')
    } finally {
      await session.dispose()
    }
  })

  it('leaves the descriptive counts group read-only', async () => {
    const session = await openSession()
    try {
      const descriptor = await session.descriptor()
      const group = (descriptor as never as {
        metadata: readonly { id: string; entries: readonly Record<string, unknown>[] }[]
      }).metadata.find(item => item.id === 'sc2-bank')
      // `sections` and `keys` are observations about the file; no writer can carry out a change.
      for (const entry of group!.entries) expect(entry['editable']).toBeUndefined()
    } finally {
      await session.dispose()
    }
  })
})

describe('sc2-bank publishes typed, editable values', () => {
  it('types each tree leaf by its bank value type and names how to write it', async () => {
    const session = await openSession()
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as never as {
          root(): Promise<{ id: string; hasChildren: boolean }>
          children(node: unknown, page: unknown): Promise<{ items: readonly { id: string }[] }>
          facts(node: unknown): Promise<Record<string, unknown>>
        }
        const root = await tree.root()
        const sections = await tree.children(root, { limit: 10 })
        const stats = sections.items[1]
        const keys = await tree.children(stats, { limit: 10 })
        const facts = await tree.facts(keys.items[0])
        expect(facts['label']).toBe('TotalKills')
        expect(facts['value']).toBe(9999999)
        expect(facts['type']).toEqual({ kind: 'number', integer: true })
        expect(facts['unit']).toBe('int')
        expect(facts['semanticPath']).toEqual(['Stats', 'TotalKills'])
        expect(facts['editable']).toEqual({
          write: { operation: 'edit.field' },
          editor: 'scalar',
        })
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('offers only the Value column of the table for editing', async () => {
    const session = await openSession()
    try {
      const lease = await session.dataSource('common.view/table-data-source', 1)
      try {
        const table = lease.value as never as {
          cell(coord: { row: number; column: number }): Promise<Record<string, unknown>>
        }
        const value = await table.cell({ row: 1, column: 3 })
        expect(value['typedValue']).toBe(9999999)
        expect(value['editable']).toBeDefined()
        for (const column of [0, 1, 2]) {
          const other = await table.cell({ row: 1, column })
          expect(other['editable']).toBeUndefined()
          expect(other['type']).toBeUndefined()
        }
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })
})
