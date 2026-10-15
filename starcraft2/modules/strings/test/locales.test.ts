/**
 * The localization table: one row per key, one column per locale of the mod.
 *
 * The sibling locales reach the codec only as host-issued bindings (`locales` requirement), so the
 * first half builds that bundle input by hand and checks the table, the per-locale write routing,
 * compare and translate. The second half opens a real loose mod through `createModkit` — the same
 * opener VS Code and the MCP server use — and drives compare, translate and a ruRU cell write
 * through the handlers the table's own `actions` name.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import { createCodec } from '../codecs/strings/src/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const MOD = 'memory://Test.SC2Mod'
const FILES: Record<string, string> = {
  enUS: 'A=Hello\nB=World\nC=Same\n',
  ruRU: 'A=Привет\nC=Same\nD=Orphan\n',
  deDE: 'A=Hallo\nB=\nC=Gleich\n',
}

function source(locale: string, files: Record<string, string> = FILES) {
  const bytes = encoder.encode(files[locale]!)
  const uri = `${MOD}/${locale}.SC2Data/LocalizedData/GameStrings.txt`
  return {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: `content-hash.sha256:${locale}`,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
}

/** enUS opened, ruRU and deDE bound by the host under the codec's `locales` requirement. */
function bundle(files: Record<string, string> = FILES) {
  const sources = { content: source('enUS', files), ru: source('ruRU', files), de: source('deDE', files) }
  const companions = (['ru', 'de'] as const).map(bindingId => ({
    sourceKind: 'requirement' as const,
    requirementId: 'locales',
    bindingId,
    role: 'localization',
    ownership: 'owned' as const,
    source: sources[bindingId].ref,
    revision: sources[bindingId].revision,
  }))
  const primary = {
    sourceKind: 'candidate' as const,
    bindingId: 'content',
    role: 'content',
    ownership: 'owned' as const,
    source: sources.content.ref,
    revision: sources.content.revision,
  }
  const bindings = [primary, ...companions]
  return {
    originKind: 'bundle',
    bindings,
    primaryBindingId: 'content',
    revisions: {
      topology: 'bundle',
      revision: sources.content.revision,
      bindings: bindings.map(item => ({ bindingId: item.bindingId, revision: item.revision })),
      compositionFingerprint: 'locales-fixture',
    },
    bindingsFor: (id: string) => (id === 'locales' ? companions : []),
    async openBinding(id: keyof typeof sources) {
      return { value: sources[id], release: async () => undefined }
    },
  } as never
}

function contextWith(service?: unknown) {
  return {
    budgets: budget,
    diagnostics: { report: () => undefined },
    contracts: {
      async resolve() {
        if (service === undefined) throw new Error('no provider offers common.language/translation')
        return { value: service, release: async () => undefined }
      },
      async resolveUnknown() {
        throw new Error('unused')
      },
    },
  } as never
}

const shouting = {
  async backends() {
    return [{ id: 'google', label: 'Google', requiresCredentials: false, available: true }]
  },
  async translate(request: { text: string }) {
    return { text: request.text.toUpperCase(), changed: true, backend: 'google' }
  },
}
const unconfigured = {
  async backends() {
    return [{ id: 'openai', label: 'OpenAI', requiresCredentials: true, available: false }]
  },
  async translate() {
    throw new Error('unreachable')
  },
}

async function value(session: any, handler: string, input: unknown) {
  const result = await session.operations().invoke(handler, input)
  if (result.state !== 'ok') throw new Error(`${handler} refused: ${String(result.reason)}`)
  return result.output
}

function payloadText(plan: any): string {
  return decoder.decode(plan.edits[0].payload.bytes)
}

describe('SC2 strings localization table', () => {
  it('plans the sibling locales as exact container-relative companions', async () => {
    const codec = createCodec(contextWith()) as any
    const planned = await codec.planInput(source('enUS'), {}, undefined)
    expect(planned.originKind).toBe('bundle')
    expect(planned.requirements).toEqual([
      expect.objectContaining({
        id: 'locales',
        ownership: 'owned',
        required: false,
        scopes: ['enclosing-container', 'current-mount'],
      }),
    ])
    expect(planned.requirements[0].patterns).toHaveLength(12)
    expect(planned.requirements[0].patterns).toContain('ruRU.SC2Data/LocalizedData/GameStrings.txt')
    const loose = { ...source('enUS'), ref: { id: 'memory://x.txt', uri: 'memory://x.txt' } }
    expect((await codec.planInput(loose, {}, undefined)).originKind).toBe('single')
  })

  it('publishes keys × locales with status, column roles and row actions', async () => {
    const session = await createCodec(contextWith()).open(bundle(), 'full', budget as never)
    try {
      const lease = await session.dataSource('common.view/table-data-source', 1)
      const table = lease.value as any
      const shape = await table.shape()
      expect(shape).toMatchObject({
        rows: 4,
        columns: 6,
        header: ['Key', 'enUS', 'deDE', 'ruRU', 'Preview', 'Status'],
        keySeparator: '/',
        actions: {
          addRow: 'edit.content',
          compareVariants: 'asset.compare',
          translateVariant: 'blizzard/sc2-strings.translate',
        },
      })
      expect(shape.columnInfo).toEqual([
        { role: 'key' },
        { role: 'variant', variant: 'enUS', language: 'en', base: true },
        { role: 'variant', variant: 'deDE', language: 'de' },
        { role: 'variant', variant: 'ruRU', language: 'ru' },
        { role: 'detail' },
        { role: 'status' },
      ])
      const rows = (await table.rows({ kind: 'range', from: 0, count: 10 })).items
      expect(rows.map((row: any) => row.cells)).toEqual([
        ['A', 'Hello', 'Hallo', 'Привет', 'Hello', ''],
        ['B', 'World', '', '', 'World', 'missing'],
        ['C', 'Same', 'Gleich', 'Same', 'Same', 'untranslated'],
        ['D', '', '', 'Orphan', '', 'missing'],
      ])
      expect(await table.cell({ row: 1, column: 3 })).toMatchObject({
        type: { kind: 'text' },
        editable: { write: { operation: 'edit.field' } },
      })
      expect((await table.cell({ row: 1, column: 0 })).editable).toBeUndefined()
      await lease.release()
    } finally {
      await session.dispose()
    }
  })

  // Plan 7.36: a value naming an entity the mod context lacks carries `broken-ref`, MK2's status.
  it('marks a row whose reference names an entity the mod context does not have', async () => {
    const files = {
      enUS: 'A=<d ref="Unit,Marine,LifeMax"/>\nB=<d ref="Unit,Ghostling,LifeMax"/>\nC=<d ref="Unit,Marine,Nope"/>\nD=Plain\n',
      ruRU: 'A=1\nB=2\nC=3\nD=4\n',
      deDE: 'A=1\nB=2\nC=3\nD=4\n',
    }
    const asked: string[][] = []
    const catalog = {
      async entities(refs: readonly { namespace: string; entityId: string }[]) {
        asked.push(refs.map(ref => `${ref.namespace}/${ref.entityId}`))
        return refs
          .filter(ref => ref.entityId === 'Marine')
          .map(ref => ({ namespace: ref.namespace, entityId: ref.entityId, typeId: 'CUnit', fields: { LifeMax: 45 } }))
      },
    }
    const statuses = async (context: unknown) => {
      const session = await createCodec(context as never).open(bundle(files), 'full', budget as never)
      try {
        const lease = await session.dataSource('common.view/table-data-source', 1)
        const rows = (await (lease.value as any).rows({ kind: 'range', from: 0, count: 10 })).items
        await lease.release()
        return rows.map((row: any) => [row.cells[0], row.cells.at(-1)])
      } finally {
        await session.dispose()
      }
    }
    // A missing field may be a default the resolved fields leave out, so C is not condemned.
    expect(await statuses({ ...(contextWith() as object), catalog })).toEqual([
      ['A', ''], ['B', 'broken-ref'], ['C', ''], ['D', ''],
    ])
    expect(asked).toEqual([['Unit/Marine', 'Unit/Ghostling']])
    // No mod context: nothing is known, so nothing is called broken.
    expect(await statuses(contextWith())).toEqual([['A', ''], ['B', ''], ['C', ''], ['D', '']])
  })

  // Plan 7.36: the table's Errors filter reads an `error` status on a value the game cannot read.
  it('marks a row whose value in any locale has broken markup (an unclosed ~token~)', async () => {
    const files = { enUS: 'A=Fine\nB=Gold ~Value\n', ruRU: 'A=Хорошо\nB=Открыто\n', deDE: 'A=Gut\nB=Offen\n' }
    const session = await createCodec(contextWith()).open(bundle(files), 'full', budget as never)
    try {
      const lease = await session.dataSource('common.view/table-data-source', 1)
      const rows = (await (lease.value as any).rows({ kind: 'range', from: 0, count: 10 })).items
      expect(rows.map((row: any) => [row.cells[0], row.cells.at(-1)])).toEqual([['A', ''], ['B', 'error']])
      await lease.release()
    } finally {
      await session.dispose()
    }
  })

  it('writes a cell into its own locale file, adding the key when that locale lacks it', async () => {
    const session = await createCodec(contextWith()).open(bundle(), 'full', budget as never)
    try {
      const added = await value(session, 'edit-field', {
        groupId: 'table',
        key: 'ruRU',
        path: ['1', '3'],
        value: 'Мир',
      })
      expect(added.plan.edits[0].targetId).toBe('ru')
      expect(payloadText(added.plan)).toBe('A=Привет\nC=Same\nD=Orphan\nB=Мир\n')
      // Every other bound locale stays a revision guard of the same plan.
      expect(added.plan.targets.map((target: any) => target.targetId)).toEqual([
        'content',
        'ru',
        'de',
      ])
      const set = await value(session, 'edit-field', {
        groupId: 'table',
        key: 'deDE',
        path: ['0', '2'],
        value: 'Servus',
      })
      expect(set.plan.edits[0].targetId).toBe('de')
      expect(payloadText(set.plan)).toBe('A=Servus\nB=\nC=Gleich\n')
      // The tree's own route is unchanged: `['keys', key]` on the opened file.
      const tree = await value(session, 'edit-field', { path: ['keys', 'A'], value: 'Hi' })
      expect(tree.plan.edits[0].targetId).toBe('content')
      const row = await value(session, 'edit-strings', {
        action: 'add',
        key: 'E',
        value: 'New',
        variant: 'enUS',
      })
      expect(payloadText(row.plan)).toBe('A=Hello\nB=World\nC=Same\nE=New\n')
      const batch = await value(session, 'edit-strings', {
        action: 'set-many',
        variant: 'ruRU',
        entries: [
          { key: 'B', value: 'Мир' },
          { key: 'C', value: 'То же' },
        ],
      })
      expect(batch.plan.edits[0].targetId).toBe('ru')
      expect(payloadText(batch.plan)).toBe('A=Привет\nC=То же\nD=Orphan\nB=Мир\n')
      // "Replace all" over several locales: one atomic plan, one rewrite per touched locale file,
      // the untouched locale a revision guard (parity plan 7.33).
      const across = await value(session, 'edit-strings', {
        action: 'set-variants',
        entries: [
          { key: 'A', variant: 'ruRU', value: 'Здравствуй' },
          { key: 'A', variant: 'enUS', value: 'Hi' },
          { key: 'B', variant: 'ruRU', value: 'Мир' },
        ],
      })
      expect(across.plan.edits.map((item: any) => [item.targetId, decoder.decode(item.payload.bytes)])).toEqual([
        ['ru', 'A=Здравствуй\nC=Same\nD=Orphan\nB=Мир\n'],
        ['content', 'A=Hi\nB=World\nC=Same\n'],
      ])
      expect(across.plan.targets.map((target: any) => target.targetId)).toEqual(['content', 'ru', 'de'])
      await expect(
        session.operations().invoke('edit-strings', {
          action: 'set-variants',
          entries: [{ key: 'A', variant: 'koKR', value: 'x' }],
        }),
      ).rejects.toThrow(/no bound locale "koKR"/u)
      // The table's key column (parity plan 7.34): a key renamed or deleted in every locale that
      // holds it, as one plan; the other locales stay revision guards.
      const renamed = await value(session, 'edit-strings', { action: 'rename-variants', oldKey: 'C', newKey: 'Shared' })
      const rewritten = renamed.plan.edits.map((item: any) => [item.targetId, decoder.decode(item.payload.bytes)])
      expect(rewritten.map(([target]: string[]) => target).sort()).toEqual(['content', 'de', 'ru'])
      for (const [, text] of rewritten) {
        expect(text).toMatch(/^Shared=/mu)
        expect(text).not.toMatch(/^C=/mu)
      }
      expect(rewritten.find(([target]: string[]) => target === 'content')?.[1]).toBe('A=Hello\nB=World\nShared=Same\n')
      const deleted = await value(session, 'edit-strings', { action: 'delete-variants', key: 'D' })
      expect(deleted.plan.edits.map((item: any) => [item.targetId, decoder.decode(item.payload.bytes)])).toEqual([
        ['ru', 'A=Привет\nC=Same\n'],
      ])
      expect(deleted.plan.targets.map((target: any) => target.targetId)).toEqual(['content', 'ru', 'de'])
      await expect(
        session.operations().invoke('edit-strings', { action: 'rename-variants', oldKey: 'C', newKey: 'A' }),
      ).rejects.toThrow(/"A" already exists in locale/u)
      await expect(
        session.operations().invoke('edit-strings', { action: 'delete-variants', key: 'Missing' }),
      ).rejects.toThrow(/no string "Missing"/u)
      await expect(
        session
          .operations()
          .invoke('edit-strings', { action: 'add', key: 'A', value: 'x', variant: 'enUS' }),
      ).rejects.toThrow(/already exists/u)
      await expect(
        session
          .operations()
          .invoke('edit-strings', { action: 'add', key: 'Z', value: 'x', variant: 'koKR' }),
      ).rejects.toThrow(/no bound locale "koKR"/u)
    } finally {
      await session.dispose()
    }
  })

  it('compares a bound locale with the base and keeps the caller-supplied form', async () => {
    const session = await createCodec(contextWith()).open(bundle(), 'full', budget as never)
    try {
      expect((await value(session, 'compare-locales', { variant: 'ruRU' })).value).toEqual({
        baseLocale: 'enUS',
        targetLocale: 'ruRU',
        missing: ['B'],
        orphaned: ['D'],
        identical: ['C'],
        empty: [],
        total: 3,
        translated: 1,
      })
      expect(
        (
          await value(session, 'compare-locales', {
            locale: 'xx',
            entries: [{ key: 'A', value: 'a' }],
          })
        ).value,
      ).toMatchObject({ targetLocale: 'xx', missing: ['B', 'C'] })
    } finally {
      await session.dispose()
    }
  })

  it('compares a locale with an earlier text of itself and stages the changed keys', async () => {
    const session = await createCodec(contextWith()).open(bundle(), 'full', budget as never)
    try {
      expect(
        (
          await value(session, 'compare-locales', {
            variant: 'ruRU',
            since: { text: 'A=Старое\nC=Same\nE=Gone\n', label: 'HEAD~1' },
          })
        ).value,
      ).toEqual({
        locale: 'ruRU',
        since: 'HEAD~1',
        added: 1,
        modified: 1,
        deleted: 1,
        changes: [
          { key: 'A', kind: 'modified', oldValue: 'Старое', newValue: 'Привет' },
          { key: 'D', kind: 'added', newValue: 'Orphan' },
          { key: 'E', kind: 'deleted', oldValue: 'Gone' },
        ],
        staged: 'A=Привет\nD=Orphan\n',
      })
      // Without a variant, the opened file.
      expect((await value(session, 'compare-locales', { since: { text: 'A=Hello\nB=World\nC=Same\n' } })).value)
        .toMatchObject({ locale: 'enUS', added: 0, modified: 0, deleted: 0, staged: '' })
      await expect(value(session, 'compare-locales', { since: {} })).rejects.toThrow(/since.text/u)
    } finally {
      await session.dispose()
    }
  })

  it('resolves a bound fallback locale without requiring a caller-built copy', async () => {
    const session = await createCodec(contextWith()).open(bundle(), 'full', budget as never)
    try {
      expect((await value(session, 'resolve-fallback', { key: 'D', locale: 'ruRU' })).value)
        .toMatchObject({ key: 'D', value: 'Orphan', locale: 'ruRU', fromPrimary: false })
      expect((await value(session, 'resolve-fallback', { key: 'A', locale: 'ruRU' })).value)
        .toMatchObject({ value: 'Hello', locale: 'primary', fromPrimary: true })
      expect((await value(session, 'render-markup', { key: 'A', variant: 'deDE' })).value)
        .toMatchObject({ plain: 'Hallo', html: 'Hallo' })
      await expect(value(session, 'resolve-fallback', { key: 'D', locale: 'koKR' }))
        .rejects.toThrow(/no bound locale/u)
    } finally {
      await session.dispose()
    }
  })

  it('says why translation is unavailable before sending anything, and translates from a named locale', async () => {
    for (const [service, expected] of [
      [undefined, { available: false, reason: expect.stringContaining('no translation service') }],
      [
        unconfigured,
        {
          available: false,
          reason: expect.stringContaining('OpenAI need credentials'),
          // The backends a surface lists for `backend`, configured or not (plan 7.35).
          backends: [{ id: 'openai', label: 'OpenAI', available: false }],
        },
      ],
      [shouting, { available: true, backends: [{ id: 'google', label: 'Google', available: true }] }],
    ] as const) {
      const session = await createCodec(contextWith(service)).open(
        bundle(),
        'full',
        budget as never,
      )
      try {
        expect((await value(session, 'translate', { probe: true })).value).toEqual(expected)
      } finally {
        await session.dispose()
      }
    }
    const session = await createCodec(contextWith(shouting)).open(bundle(), 'full', budget as never)
    try {
      const result = await value(session, 'translate', {
        key: 'A',
        sourceVariant: 'deDE',
        targetVariant: 'ruRU',
        sourceLanguage: 'de',
        targetLanguage: 'ru',
      })
      expect(result.value).toMatchObject({
        key: 'A',
        source: 'Hallo',
        translated: 'HALLO',
        changed: true,
      })
    } finally {
      await session.dispose()
    }
  })
})

describe('SC2 strings localization table through the installed host opener', () => {
  const extension = resolve(import.meta.dirname, '..', '..', '..')
  let scratch = ''
  let enUS = ''
  let ruRU = ''
  let host: Awaited<ReturnType<typeof createModkit>>

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sc2-strings-locales-'))
    const path = (locale: string) =>
      join(scratch, 'Test.SC2Mod', `${locale}.SC2Data`, 'LocalizedData', 'GameStrings.txt')
    enUS = path('enUS')
    ruRU = path('ruRU')
    for (const [file, text] of [
      [enUS, FILES.enUS!],
      [ruRU, FILES.ruRU!],
    ] as const) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    host = await createModkit({
      extensions: [extension],
      roots: [scratch],
      writableRoots: [scratch],
    })
  })

  afterAll(async () => {
    await host?.close()
    if (scratch.startsWith(tmpdir())) rmSync(scratch, { recursive: true, force: true })
  })

  it('binds the sibling locale and routes compare, translate and a ruRU write through the table actions', async () => {
    const opened = await host.open(enUS)
    try {
      expect(opened.snapshot.state, JSON.stringify(opened.snapshot)).toBe('opened')
      const session = opened.session as any
      const descriptor = await session.descriptor()
      expect(descriptor.identity.codecId).toBe('blizzard/sc2-strings')
      expect(descriptor.origin.kind).toBe('bundle')
      expect(descriptor.traits.map((trait: any) => trait.id)).toEqual(
        expect.arrayContaining(['game.localization', 'table.cells']),
      )
      const lease = await session.dataSource('common.view/table-data-source', 1)
      const shape = await lease.value.shape()
      expect(shape.header).toEqual(['Key', 'enUS', 'ruRU', 'Preview', 'Status'])
      await lease.release()

      // The handler behind each action, exactly as the table surface resolves it.
      const handlerOf = (id: string) =>
        descriptor.operations.find((operation: any) => operation.id === id)?.handlerId
      const compare = await session
        .operations()
        .invoke(handlerOf(shape.actions.compareVariants), { variant: 'ruRU' })
      expect(compare).toMatchObject({
        state: 'ok',
        output: { value: { missing: ['B'], orphaned: ['D'], identical: ['C'] } },
      })

      // This host grants no network, so translate is refused with a reason the surface shows.
      const translate = descriptor.operations.find(
        (operation: any) => operation.id === shape.actions.translateVariant,
      )
      const probe = await session.operations().invoke(translate.handlerId, { probe: true })
      if (probe.state === 'ok') expect(probe.output.value.available).toBe(false)
      else expect(String(probe.reason ?? probe.message ?? '')).not.toBe('')

      const write = await session.operations().invoke(handlerOf('edit.field'), {
        groupId: 'table',
        key: 'ruRU',
        path: ['1', '2'],
        value: 'Мир',
      })
      expect(write.state).toBe('ok')
      const editing = opened.editing
      if (editing === undefined) throw new Error('the loose mod opened without editing')
      const prepared = await editing.coordinator.prepare(editing.planFromOperation(write.output), {
        grant: editing.grantSnapshot,
      })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') return
      const receipt = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(receipt.state).toBe('committed')
      expect(readFileSync(ruRU, 'utf8')).toBe('A=Привет\nC=Same\nD=Orphan\nB=Мир\n')
      expect(readFileSync(enUS, 'utf8')).toBe(FILES.enUS)
    } finally {
      await opened.close()
    }
  })
})
