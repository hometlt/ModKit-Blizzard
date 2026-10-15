/**
 * The strings adapter must route to the ported MK2 library, not re-derive its rules.
 *
 * These tests are written against the behaviours the previous adapter got wrong or lacked, so a
 * regression back to inline regular expressions fails here rather than silently shipping weaker
 * answers under the same operation names. Each one names the ported module it exercises.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCodec, operations } from '../codecs/strings/src/codec.js'

const NL = '\n'
const FIXTURE = new URL(
  '../../mod/test/core/fixtures/TestMod/enus.sc2data/LocalizedData/GameStrings.txt',
  import.meta.url,
)
const encoder = new TextEncoder()

function input(bytes: Uint8Array, uri: string) {
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: 'content-hash.sha256:fixture',
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
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

async function open(text: string, uri = 'memory://enUS.SC2Data/LocalizedData/GameStrings.txt') {
  const codec = createCodec(context)
  return codec.open(input(encoder.encode(text), uri), 'edit', budget)
}

async function invoke(session: never, handler: string, request: unknown) {
  return (session as never as { operations(): { invoke(id: string, input: unknown): Promise<unknown> } })
    .operations()
    .invoke(handler, request as never)
}

function jsonOf(result: unknown) {
  const record = result as { state?: string; reason?: string; output?: { value?: unknown } }
  if (record.state === 'rejected') throw new Error(`refused: ${String(record.reason)}`)
  return record.output?.value
}

describe('sc2-strings routes to the ported library', () => {
  it('declares the operations the port requires, including field writes and rendering', () => {
    const ids = operations.map(operation => operation.id)
    for (const required of [
      'view.inspect',
      'asset.validate',
      'export.convert',
      'edit.content',
      'edit.field',
      'asset.compare',
      'blizzard/sc2-strings.references',
      'blizzard/sc2-strings.resolve-fallback',
      'blizzard/sc2-strings.render',
    ]) {
      expect(ids).toContain(required)
    }
  })

  /*
   * `markupCatalogRefs` walks nested segments and reads ref/time/dynamic/token expressions. The
   * previous adapter matched only a top-level `<d ref=…>`, so a reference inside `<c>` was
   * invisible to it — this is the concrete capability the adaptation restores.
   */
  it('finds a catalog reference nested inside colour markup, which the old regex could not', async () => {
    const session = await open(
      ['Button/Name/Attack=<c val="ffffff"><d ref="Effect,Foo,Amount"/></c>', ''].join(NL),
    )
    try {
      const refs = jsonOf(await invoke(session, 'references', {})) as readonly Record<string, unknown>[]
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ ns: 'Effect', entity: 'Foo', field: 'Amount' })
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('reports duplicate keys from the library, on the overriding line', async () => {
    const session = await open(['A/B/C=first', 'A/B/C=second', ''].join(NL))
    try {
      const diagnostics = jsonOf(await invoke(session, 'validate', {})) as readonly {
        code: string
        severity: string
      }[]
      const duplicates = diagnostics.filter(item => item.code.endsWith('duplicate-key'))
      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]?.severity).toBe('warning')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * `analyzeHotkeyStringFile` knows the key-name table and modifier grammar. The previous adapter
   * used one regular expression, which accepted anything shaped like a word.
   */
  it('validates hotkeys through the ported table, not a shape heuristic', async () => {
    const session = await open(
      ['Button/Hotkey/Attack=Shift+A', 'Button/Hotkey/Move=NotAKey', ''].join(NL),
      'memory://GameHotkeys.txt',
    )
    try {
      const diagnostics = jsonOf(await invoke(session, 'validate', {})) as readonly {
        code: string
        message: string
      }[]
      const invalid = diagnostics.filter(item => item.code.endsWith('invalid-hotkey'))
      expect(invalid.length).toBeGreaterThanOrEqual(1)
      expect(invalid.some(item => item.message.includes('NotAKey'))).toBe(true)
      // `Shift+A` is a legal binding and must not be reported.
      expect(invalid.some(item => item.message.includes('Shift+A'))).toBe(false)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * `compareLocales` answers the four questions a translator asks. The previous hand-rolled version
   * reported "changed", which is not one of them, and never counted what was actually translated.
   */
  it('compares locales with the library’s own vocabulary', async () => {
    const session = await open(['A=one', 'B=two', 'C=three', ''].join(NL))
    try {
      const comparison = jsonOf(
        await invoke(session, 'compare-locales', {
          locale: 'deDE',
          entries: [
            { key: 'A', value: 'eins' },
            { key: 'B', value: 'two' },
            { key: 'D', value: 'vier' },
          ],
        }),
      ) as Record<string, unknown>
      expect(comparison['missing']).toEqual(['C'])
      expect(comparison['orphaned']).toEqual(['D'])
      expect(comparison['identical']).toEqual(['B'])
      expect(comparison['translated']).toBe(1)
      expect(comparison['targetLocale']).toBe('deDE')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('renders markup only when given a resolver, and says so when it has none', async () => {
    const session = await open(['A=<d ref="Effect,Foo,Amount"/> damage', ''].join(NL))
    try {
      const without = jsonOf(await invoke(session, 'render-markup', { key: 'A' })) as Record<
        string,
        unknown
      >
      expect(without['html']).toBeNull()
      expect(without['unavailable']).toMatch(/catalog resolver/u)
      expect(Array.isArray(without['segments'])).toBe(true)

      const withCatalog = jsonOf(
        await invoke(session, 'render-markup', {
          key: 'A',
          catalog: { entities: { 'Effect/Foo': { Amount: '42' } } },
        }),
      ) as Record<string, unknown>
      expect(String(withCatalog['plain'])).toContain('42')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('renders literal markup without GameData and resolves supplied styles alone', async () => {
    const session = await open('A=<c val="ff0000">Red</c><n/>Text /// translator note\nB=<s val="Title">Title</s>\n')
    try {
      const literal = jsonOf(await invoke(session, 'render-markup', { key: 'A' })) as Record<string, unknown>
      expect(literal['plain']).toBe('Red\nText')
      expect(literal['html']).toContain('color:#ff0000')
      expect(literal['html']).not.toContain('translator note')
      const styled = jsonOf(await invoke(session, 'render-markup', {
        key: 'B',
        catalog: { styles: { styles: { Title: { name: 'Title', attrs: { height: '24' }, resolved: true } } } },
      })) as Record<string, unknown>
      expect(styled['html']).toContain('font-size:24px')
    } finally {
      await session.dispose()
    }
  })

  it('writes one value through edit.field and keeps every other byte', async () => {
    const text = ['# comment', 'A/B=one', '', 'C/D=two', ''].join(NL)
    const session = await open(text)
    try {
      const result = (await invoke(session, 'edit-field', {
        groupId: 'tree',
        key: 'A/B',
        path: ['keys', 'A/B'],
        value: 'changed',
      })) as { output?: { plan?: { edits?: readonly { payload?: { bytes?: unknown } }[] } } }
      const payload = result.output?.plan?.edits?.[0]?.payload as { bytes?: unknown } | undefined
      const bytes = ArrayBuffer.isView(payload?.bytes)
        ? (payload?.bytes as Uint8Array)
        : Uint8Array.from(Object.values((payload?.bytes ?? {}) as Record<string, number>))
      const written = new TextDecoder().decode(bytes)
      expect(written).toBe(text.replace('A/B=one', 'A/B=changed'))
      // The comment, the blank line and the untouched entry all survive unchanged.
      expect(written).toContain('# comment')
      expect(written).toContain('C/D=two')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('recognises a real GameStrings.txt by catalog and locale, and publishes both', async () => {
    const text = readFileSync(FIXTURE, 'utf8')
    const session = await open(text)
    try {
      const descriptor = await (session as never as { descriptor(): Promise<never> }).descriptor()
      const groups = (descriptor as never as {
        metadata: readonly { id: string; entries: readonly { key: string; value: unknown }[] }[]
      }).metadata
      const catalog = groups.find(group => group.id === 'catalog')
      const value = (key: string) => catalog?.entries.find(entry => entry.key === key)?.value
      expect(value('catalog')).toBe('GameStrings')
      expect(value('locale')).toBe('enUS')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
  /*
   * The end of the chain the catalog bridge exists for: a string references a field of an entity
   * owned by the data codec, and validation now says whether that reference resolves. Without a
   * catalog the answer is the structural diagnostics only — an empty catalog would report every
   * reference as broken, which is worse than not checking.
   */
  it('checks references against a catalog snapshot, and only when given one', async () => {
    const session = await open(
      ['A/B=<d ref="Effect,Foo,Amount"/>', 'C/D=<d ref="Effect,Ghost,Amount"/>', ''].join(NL),
    )
    try {
      const withoutCatalog = jsonOf(await invoke(session, 'validate', {})) as readonly {
        code: string
      }[]
      expect(withoutCatalog.some(item => item.code.endsWith('broken-ref'))).toBe(false)

      const withCatalog = jsonOf(
        await invoke(session, 'validate', {
          catalog: {
            snapshot: {
              entities: [{ namespace: 'Effect', entityId: 'Foo', fields: { Amount: 42 } }],
            },
          },
        }),
      ) as readonly { code: string; message: string }[]
      const broken = withCatalog.filter(item => item.code.endsWith('broken-ref'))
      expect(broken).toHaveLength(1)
      expect(broken[0]?.message).toContain('Ghost')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('renders a reference to its resolved value when given a snapshot', async () => {
    const session = await open(['A=<d ref="Effect,Foo,Amount"/> damage', ''].join(NL))
    try {
      const rendered = jsonOf(
        await invoke(session, 'render-markup', {
          key: 'A',
          catalog: {
            snapshot: {
              entities: [{ namespace: 'Effect', entityId: 'Foo', fields: { Amount: 42 } }],
            },
          },
        }),
      ) as Record<string, unknown>
      expect(String(rendered['plain'])).toContain('42')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
  /*
   * Syntax runs for the surfaces that show one value: the tree node and the Value column. The tree
   * shows what the file holds, coloured — not a resolved rendering, which needs a catalog and is
   * what `render` is for. A half-resolved preview would be a value the file does not contain.
   */
  it('publishes syntax runs for markup, on the tree leaf and the value cell only', async () => {
    const session = await open(['A/B=Deals <d ref="Effect,Foo,Amount"/> damage', ''].join(NL))
    try {
      const tree = await (session as never as {
        dataSource(contract: string, major: number): Promise<{ value: never; release(): Promise<void> }>
      }).dataSource('common.view/tree-data-source', 1)
      try {
        const source = tree.value as never as {
          root(): Promise<unknown>
          children(node: unknown, page: unknown): Promise<{ items: readonly unknown[] }>
          facts(node: unknown): Promise<Record<string, unknown>>
        }
        /*
         * A key is a path, and the tree groups by its segments, so `A/B` is a leaf under `A`. The
         * runs belong to the leaf: a group has no value to colour.
         */
        const groups = await source.children(await source.root(), { limit: 10 })
        expect((await source.facts(groups.items[0]))['spans']).toBeUndefined()
        const leaves = await source.children(groups.items[0], { limit: 10 })
        const facts = await source.facts(leaves.items[0])
        const spans = facts['spans'] as readonly { kind: string }[] | undefined
        expect(spans).toBeDefined()
        expect(spans!.some(span => span.kind === 'variable')).toBe(true)
      } finally {
        await tree.release()
      }

      const table = await (session as never as {
        dataSource(contract: string, major: number): Promise<{ value: never; release(): Promise<void> }>
      }).dataSource('common.view/table-data-source', 1)
      try {
        const source = table.value as never as {
          cell(coord: { row: number; column: number }): Promise<Record<string, unknown>>
        }
        expect((await source.cell({ row: 0, column: 1 }))['spans']).toBeDefined()
        // The key and the duplicate flag have no grammar, so they carry no runs.
        expect((await source.cell({ row: 0, column: 0 }))['spans']).toBeUndefined()
        expect((await source.cell({ row: 0, column: 2 }))['spans']).toBeUndefined()
      } finally {
        await table.release()
      }
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('publishes no runs for a value with no markup, rather than colouring plain text', async () => {
    const session = await open(['A/B=Marine', ''].join(NL))
    try {
      const table = await (session as never as {
        dataSource(contract: string, major: number): Promise<{ value: never; release(): Promise<void> }>
      }).dataSource('common.view/table-data-source', 1)
      try {
        const source = table.value as never as {
          cell(coord: { row: number; column: number }): Promise<Record<string, unknown>>
        }
        expect((await source.cell({ row: 0, column: 1 }))['spans']).toBeUndefined()
      } finally {
        await table.release()
      }
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})
