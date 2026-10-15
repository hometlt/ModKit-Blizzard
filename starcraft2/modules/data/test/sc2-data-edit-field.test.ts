/**
 * `edit.field` on a catalog: one value, written through the ported raw-preserving patcher.
 *
 * The patcher is MK2's — `patchCatalogField`, 400 lines that rewrite exactly the targeted attribute
 * or element and leave the rest of the file alone. What is tested here is the translation from what
 * a surface sends to what that patcher needs, and the refusals, which matter more than the writes:
 * a field edit that lands in the wrong file still parses, so it fails silently.
 */
import { describe, expect, it } from 'vitest'
import { createCodec, allOperations } from '../codecs/sc2data/src/codec.js'
import {
  patchCatalogIndexedEntry,
  patchCatalogIndexedEntryRemoval,
} from '../services/editing/catalog-field-patch.js'

const NL = '\n'
const encoder = new TextEncoder()

const CATALOG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  '    <!-- a comment that must survive -->',
  '    <CUnit id="Marine">',
  '        <LifeMax value="45"/>',
  '    </CUnit>',
  '    <CUnit id="Marauder" parent="Marine">',
  '        <LifeMax value="125"/>',
  '    </CUnit>',
  '</Catalog>',
  '',
].join(NL)

function input(text: string, uri = 'memory://UnitData.xml') {
  const bytes = encoder.encode(text)
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

async function open(text = CATALOG) {
  return createCodec(context).open(input(text), 'edit', budget)
}

async function write(session: never, request: unknown) {
  return (
    session as never as {
      operations(): { invoke(id: string, input: unknown): Promise<unknown> }
    }
  )
    .operations()
    .invoke('edit-field', request as never)
}

/** The bytes an edit plan carries, rebuilt the way a commit coordinator would. */
function written(result: unknown): string {
  const record = result as {
    state?: string
    reason?: string
    output?: { plan?: { edits?: readonly { payload?: { kind?: string; bytes?: unknown } }[] } }
  }
  if (record.state === 'rejected') throw new Error(`refused: ${String(record.reason)}`)
  const payload = record.output?.plan?.edits?.[0]?.payload
  if (payload?.kind !== 'inline' || payload.bytes === undefined) {
    throw new Error(`no inline payload: ${JSON.stringify(record).slice(0, 200)}`)
  }
  const bytes = ArrayBuffer.isView(payload.bytes)
    ? (payload.bytes as Uint8Array)
    : Uint8Array.from(Object.values(payload.bytes as Record<string, number>))
  return new TextDecoder().decode(bytes)
}

describe('sc2-data edit.field', () => {
  it('declares the operation the surfaces invoke', () => {
    expect(allOperations.map(operation => String(operation.id))).toContain('edit.field')
  })

  it('rewrites one field and leaves every other byte alone', async () => {
    const session = await open()
    try {
      const text = written(
        await write(session, { groupId: 'tree', key: 'LifeMax', path: ['Unit', 'Marine', 'LifeMax', 'value'], value: '60' }),
      )
      expect(text).toContain('<LifeMax value="60"/>')
      // The comment, the second unit and its own value are untouched.
      expect(text).toContain('<!-- a comment that must survive -->')
      expect(text).toContain('<LifeMax value="125"/>')
      expect(text.replace('value="60"', 'value="45"')).toBe(CATALOG)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * The patcher refuses entity metadata, and that is right: renaming an entity is not a field write
   * — every reference to it has to move too, which is what `edit.content` does. A surface that
   * offered `id` here would look like it renamed something and would have changed one line.
   */
  it('refuses to write an entity id, because renaming is a different operation', async () => {
    const session = await open()
    try {
      await expect(
        write(session, { path: ['Unit', 'Marine', 'id'], value: 'Grunt' }),
      ).rejects.toThrow()
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses a request that does not identify a field', async () => {
    const session = await open()
    try {
      await expect(write(session, { groupId: 'tree', key: 'x', path: ['Unit'] })).rejects.toThrow(
        /namespace, entityId/u,
      )
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses an entity the catalog does not hold instead of writing somewhere', async () => {
    const session = await open()
    try {
      await expect(
        write(session, { path: ['Unit', 'Ghost', 'LifeMax', 'value'], value: '1' }),
      ).rejects.toThrow(/no entity Unit\/Ghost/u)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * MK2 behaviour, pinned: setting a field the entity does not yet carry adds it, rather than
   * refusing. That is what a modder means by setting a value, and the schema check that decides
   * whether the field is legal at all belongs to the validator, not the patcher.
   */
  it('adds a field the entity does not yet carry', async () => {
    const session = await open()
    try {
      const text = written(
        await write(session, { path: ['Unit', 'Marine', 'Mover'], value: 'Ground' }),
      )
      expect(text).toContain('Mover')
      expect(text).toContain('<LifeMax value="45"/>')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('replaces one local indexed entry with a minimal removed tombstone', () => {
    const source = [
      '<Catalog>',
      '    <CUnit id="Marine">',
      '        <CostResource index="Minerals" value="50"/>',
      '        <CostResource index="Vespene" value="25"/>',
      '    </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const patched = patchCatalogIndexedEntryRemoval(
      source,
      'CUnit',
      'Marine',
      'CostResource',
      'Minerals',
    )
    expect(patched.changed).toBe(true)
    expect(patched.text).toContain('<CostResource index="Minerals" removed="1"/>')
    expect(patched.text).toContain('<CostResource index="Vespene" value="25"/>')
    expect(patched.text).not.toContain('index="Minerals" value="50"')
  })

  it('updates one indexed entry and clears its tombstone without changing sibling payload', () => {
    const source = [
      '<Catalog>',
      '    <CUnit id="Marine">',
      '        <CostResource index="Minerals" removed="1" custom="kept"/>',
      '        <CostResource index="Vespene" value="25"/>',
      '    </CUnit>',
      '</Catalog>',
      '',
    ].join(NL)
    const patched = patchCatalogIndexedEntry(
      source,
      'CUnit',
      'Marine',
      'CostResource',
      'Minerals',
      '75',
    )
    expect(patched.changed).toBe(true)
    expect(patched.text).toContain('<CostResource index="Minerals" custom="kept" value="75"/>')
    expect(patched.text).not.toContain('removed="1"')
    expect(patched.text).toContain('<CostResource index="Vespene" value="25"/>')
  })

  it('writes a structured indexed entry without changing its siblings', () => {
    const source = [
      '<Catalog>',
      '    <CAbilAttack id="Attack">',
      '        <CmdButtonArray index="Execute" removed="1"/>',
      '        <CmdButtonArray index="Cancel" DefaultButtonFace="Cancel"/>',
      '    </CAbilAttack>',
      '</Catalog>',
      '',
    ].join(NL)
    const patched = patchCatalogIndexedEntry(
      source,
      'CAbilAttack',
      'Attack',
      'CmdButtonArray',
      'Execute',
      { DefaultButtonFace: 'Attack', State: 'Enabled' },
    )
    expect(patched.changed).toBe(true)
    expect(patched.text).toContain(
      '<CmdButtonArray index="Execute" DefaultButtonFace="Attack" State="Enabled"/>',
    )
    expect(patched.text).not.toContain('removed="1"')
    expect(patched.text).toContain('<CmdButtonArray index="Cancel" DefaultButtonFace="Cancel"/>')
  })

  it('refuses a structured replacement that would discard native fields', () => {
    const source = [
      '<Catalog>',
      '    <CAbilAttack id="Attack">',
      '        <CmdButtonArray index="Execute" DefaultButtonFace="Old" State="Enabled"/>',
      '    </CAbilAttack>',
      '</Catalog>',
      '',
    ].join(NL)
    const patched = patchCatalogIndexedEntry(
      source,
      'CAbilAttack',
      'Attack',
      'CmdButtonArray',
      'Execute',
      { DefaultButtonFace: 'New' },
    )
    expect(patched).toMatchObject({
      changed: false,
      text: source,
      reason: "structured indexed replacement must include existing field 'CmdButtonArray.State'",
    })
  })

  it('refuses a structured replacement that would discard nested native fields', () => {
    const source = [
      '<Catalog>',
      '    <CAbilAttack id="Attack">',
      '        <CmdButtonArray index="Execute">',
      '            <Nested Known="old" NativeOnly="keep"/>',
      '        </CmdButtonArray>',
      '    </CAbilAttack>',
      '</Catalog>',
      '',
    ].join(NL)
    const patched = patchCatalogIndexedEntry(
      source,
      'CAbilAttack',
      'Attack',
      'CmdButtonArray',
      'Execute',
      { Nested: { Known: 'new' } },
    )
    expect(patched).toMatchObject({
      changed: false,
      reason:
        "structured indexed replacement must include existing field 'CmdButtonArray.Nested.NativeOnly'",
    })
    expect(patched.text).toBe(source)
  })
})
