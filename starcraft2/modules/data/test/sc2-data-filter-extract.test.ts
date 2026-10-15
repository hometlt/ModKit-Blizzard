/**
 * Catalog filtering and dependency extraction, from the ported helpers.
 *
 * `Filter` and `extractSubtree` were carried across and had no way in. What is tested here is the
 * translation and the two things a caller would otherwise get wrong: the implicit default entity,
 * which is in every namespace and almost never what anyone means, and the claim that an extraction
 * walks the same graph the codec publishes rather than a second traversal that could disagree.
 */
import { describe, expect, it } from 'vitest'
import { createCodec, allOperations } from '../codecs/sc2data/src/codec.js'

const NL = '\n'
const encoder = new TextEncoder()

const CATALOG = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Catalog>',
  // The implicit default: every SC2 namespace has one, and everything inherits from it.
  '    <CUnit>',
  '        <LifeMax value="1"/>',
  '    </CUnit>',
  '    <CUnit id="Marine">',
  '        <LifeMax value="45"/>',
  '        <WeaponArray Link="GaussRifle"/>',
  '    </CUnit>',
  '    <CUnit id="Zealot">',
  '        <LifeMax value="100"/>',
  '    </CUnit>',
  '    <CWeapon id="GaussRifle">',
  '        <Range value="5"/>',
  '    </CWeapon>',
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

async function open() {
  return createCodec(context).open(input(CATALOG), 'inspect', budget)
}

async function call(session: never, handler: string, request: unknown) {
  const result = (await (
    session as never as {
      operations(): { invoke(id: string, input: unknown): Promise<unknown> }
    }
  )
    .operations()
    .invoke(handler, request as never)) as {
    state?: string
    reason?: string
    output?: { value?: unknown }
  }
  if (result.state === 'rejected') throw new Error(`refused: ${String(result.reason)}`)
  return result.output?.value as Record<string, never>
}

describe('sc2-data filter', () => {
  it('declares both operations', () => {
    const ids = allOperations.map(operation => String(operation.id))
    expect(ids).toContain('blizzard/sc2-data.filter')
    expect(ids).toContain('blizzard/sc2-data.extract')
  })

  /*
   * The default entity is the trap. Every namespace has one with an empty id, everything inherits
   * from it, and a caller listing "the units in this mod" does not mean it — so it is excluded
   * unless asked for.
   */
  it('excludes the implicit default entity unless the caller asks for it', async () => {
    const session = await open()
    try {
      const filtered = await call(session, 'filter-entities', { namespace: 'Unit' })
      expect((filtered['entities'] as { id: string }[]).map(item => item.id).sort()).toEqual([
        'Marine',
        'Zealot',
      ])
      const all = await call(session, 'filter-entities', { namespace: 'Unit', mode: 'all' })
      expect((all['entities'] as { id: string }[]).some(item => item.id === '')).toBe(true)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('narrows by a case-insensitive id substring', async () => {
    const session = await open()
    try {
      const found = await call(session, 'filter-entities', { namespace: 'Unit', id: 'mar' })
      expect((found['entities'] as { id: string }[]).map(item => item.id)).toEqual(['Marine'])
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses a request with no namespace instead of returning everything', async () => {
    const session = await open()
    try {
      await expect(call(session, 'filter-entities', {})).rejects.toThrow(/namespace/u)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})

describe('sc2-data extract', () => {
  it('pulls the dependency subtree of a seed, following links out of its namespace', async () => {
    const session = await open()
    try {
      const found = await call(session, 'extract-subtree', {
        seeds: [{ namespace: 'Unit', id: 'Marine' }],
      })
      const ids = (found['entities'] as { namespace: string; id: string }[]).map(
        item => `${item.namespace}/${item.id}`,
      )
      expect(ids).toContain('Unit/Marine')
      // The weapon it links to comes with it; the unrelated unit does not.
      expect(ids).toContain('Weapon/GaussRifle')
      expect(ids).not.toContain('Unit/Zealot')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('honours an excluded namespace', async () => {
    const session = await open()
    try {
      const found = await call(session, 'extract-subtree', {
        seeds: [{ namespace: 'Unit', id: 'Marine' }],
        excludeNamespaces: ['Weapon'],
      })
      const ids = (found['entities'] as { namespace: string; id: string }[]).map(
        item => `${item.namespace}/${item.id}`,
      )
      expect(ids).not.toContain('Weapon/GaussRifle')
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses when no seed exists rather than returning an empty subtree', async () => {
    const session = await open()
    try {
      await expect(
        call(session, 'extract-subtree', { seeds: [{ namespace: 'Unit', id: 'Ghost' }] }),
      ).rejects.toThrow(/at least one seed/u)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})
