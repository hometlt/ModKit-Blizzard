/**
 * `blizzard/sc2-strings.translate`: the last MK2 operation this codec was missing.
 *
 * Everything about how a string is translated safely is the ported library's — masking markup,
 * sending only the literal text, and refusing a result whose placeholders came back wrong. So what
 * is tested here is the boundary: that the operation is declared with the permission it needs, that
 * it refuses a request it cannot serve, and that markup survives a translator that reorders text.
 *
 * The translator is injected. A test that reached a real service would be slow, flaky and would
 * measure Google rather than this codec.
 */
import { describe, expect, it } from 'vitest'
import { createCodec, operations } from '../codecs/strings/src/codec.js'

const NL = '\n'
const encoder = new TextEncoder()

const CATALOG = [
  'Unit/Name/Marine=Marine',
  'Unit/Tip/Marine=Trained at the <d ref="Unit,Barracks,Name"/> for <c val="ffcc00">50</c> minerals',
  '',
].join(NL)

function input(text: string, uri = 'memory://enUS.SC2Data/LocalizedData/GameStrings.txt') {
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
  maxInputBytes: 400_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 104_857_600,
  maxDiagnostics: 1_000,
} as never

function contextWith(service?: unknown) {
  return {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve(selection: { contract?: string }) {
      if (selection?.contract === 'common.language/translation' && service !== undefined) {
        return { value: service, release: async () => undefined }
      }
      throw new Error('no service dependency in this test')
    },
    async resolveUnknown() {
      throw new Error('no foreign service in this test')
    },
  },
  } as never
}

/**
 * A translation service that upper-cases what it is given, so a round trip is visible.
 *
 * It is resolved through the contract, not constructed inside the codec: talking to a service is
 * nobody's format-specific business, and the split is what this test exists to prove.
 */
function shoutingService(options: { readonly drop?: boolean } = {}) {
  return {
    contract: 'common.language/translation',
    async backends() {
      return [{ id: 'google', label: 'Test', requiresCredentials: false, available: true }]
    },
    async translate(request: { text: string }) {
      // `drop` models the failure the round-trip check exists for: a placeholder that vanished.
      const text = options.drop === true
        ? request.text.replaceAll(/\[\[MK\d+\]\]/gu, '').toUpperCase()
        : request.text.toUpperCase()
      return { text, changed: true, backend: 'google' }
    },
  }
}

async function open(text = CATALOG, service?: unknown) {
  return createCodec(contextWith(service)).open(input(text), 'inspect', budget)
}

async function call(session: never, request: unknown) {
  const result = (await (
    session as never as {
      operations(): { invoke(id: string, input: unknown): Promise<unknown> }
    }
  )
    .operations()
    .invoke('translate', request as never)) as {
    state?: string
    reason?: string
    output?: { value?: Record<string, unknown> }
  }
  if (result.state === 'rejected') throw new Error(`refused: ${String(result.reason)}`)
  return result.output?.value ?? {}
}

describe('sc2-strings translate', () => {
  it('keeps network and credential authority out of the codec operation', () => {
    const translate = operations.find(item => item.id === 'blizzard/sc2-strings.translate')
    expect(translate).toBeDefined()
    expect(translate?.mutatesSource).toBe(false)
    expect(translate?.requiredPermissions).toEqual(['read-source'])
  })

  it('translates the text and puts every markup segment back untouched', async () => {
    const session = await open(CATALOG, shoutingService())
    try {
      const result = await call(session, {
        key: 'Unit/Tip/Marine',
        sourceLanguage: 'en',
        targetLanguage: 'ru',
      })
      const translated = String(result['translated'])
      // The markup came back verbatim: same tags, same attributes, same order.
      expect(translated).toContain('<d ref="Unit,Barracks,Name"/>')
      expect(translated).toContain('<c val="ffcc00">')
      // The literal text around it went through the translator.
      expect(translated).toContain('TRAINED AT THE')
      expect(result['changed']).toBe(true)
      expect(result['source']).toBe(
        'Trained at the <d ref="Unit,Barracks,Name"/> for <c val="ffcc00">50</c> minerals',
      )
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  /*
   * A write is a separate, human-approved step. The operation says so by not mutating the source,
   * and this pins it: a translator that silently edited the file would put unreviewed text into a
   * shipped mod.
   */
  it('does not touch the file', async () => {
    const session = await open(CATALOG, shoutingService())
    try {
      const before = CATALOG
      await call(session, { key: 'Unit/Name/Marine', sourceLanguage: 'en', targetLanguage: 'ru' })
      const text = (await (
        session as never as { operations(): { invoke(id: string, input: unknown): Promise<never> } }
      )
        .operations()
        .invoke('export-raw', {})) as { output?: { value?: Uint8Array } }
      expect(new TextDecoder().decode(text.output?.value)).toBe(before)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })

  it('refuses a key it does not hold and a request with no target language', async () => {
    const session = await open()
    try {
      await expect(
        call(session, { key: 'Unit/Name/Ghost', sourceLanguage: 'en', targetLanguage: 'ru' }),
      ).rejects.toThrow(/no string "Unit\/Name\/Ghost"/u)
      await expect(call(session, { key: 'Unit/Name/Marine' })).rejects.toThrow(
        /sourceLanguage and targetLanguage/u,
      )
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})

/*
 * The check that decides whether a translation is applied at all.
 *
 * A service that loses a placeholder returns text that reads correctly and has lost a reference or a
 * colour. MK2 refused such a result and kept the original; that rule stayed with the format when the
 * transport moved out, because only the format knows what its placeholders stood for.
 */
describe('sc2-strings translate refuses an unsafe result', () => {
  it('keeps each open codec bound to its own configured provider', async () => {
    const first = await open(CATALOG, shoutingService())
    const second = await open(CATALOG, shoutingService({ drop: true }))
    try {
      const request = { key: 'Unit/Tip/Marine', sourceLanguage: 'en', targetLanguage: 'ru' }
      expect((await call(first, request))['changed']).toBe(true)
      expect((await call(second, request))['refused']).toMatch(/placeholder/u)
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it.each(['duplicate', 'reorder', 'unknown'])(
    'refuses %s placeholders and releases the provider lease',
    async mode => {
      let released = 0
      const service = {
        async translate(request: { text: string }) {
          const text = mode === 'duplicate'
            ? `${request.text} [[MK0]]`
            : mode === 'unknown'
              ? `${request.text} [[MK999]]`
              : request.text.replace('[[MK0]]', '[[MK_TEMP]]').replace('[[MK1]]', '[[MK0]]').replace('[[MK_TEMP]]', '[[MK1]]')
          return { text, changed: true, backend: 'google' }
        },
      }
      const context = {
        budgets: budget,
        diagnostics: { report() {} },
        contracts: {
          async resolve() { return { value: service, async release() { released += 1 } } },
        },
      }
      const session = await createCodec(context).open(input(CATALOG), 'inspect', budget)
      try {
        const result = await call(session, { key: 'Unit/Tip/Marine', sourceLanguage: 'en', targetLanguage: 'ru' })
        expect(result['translated']).toBe(result['source'])
        expect(result['changed']).toBe(false)
        expect(result['refused']).toMatch(/placeholder/u)
        expect(released).toBe(1)
      } finally {
        await session.dispose()
      }
    },
  )

  it('keeps the original value when a markup placeholder did not come back', async () => {
    const session = await open(CATALOG, shoutingService({ drop: true }))
    try {
      const result = await call(session, {
        key: 'Unit/Tip/Marine',
        sourceLanguage: 'en',
        targetLanguage: 'ru',
      })
      expect(result['translated']).toBe(result['source'])
      expect(result['changed']).toBe(false)
      expect(String(result['refused'])).toMatch(/placeholder/u)
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})

/*
 * D4: a localization file and a style sheet are two ends of one edge.
 *
 * A modder editing a style wants the strings that use it; one editing a string wants the style it
 * applies. Both questions are the same edge read from either end, so the codec publishes it as a
 * graph rather than as a list of names inside a value.
 */
describe('sc2-strings style relations', () => {
  const STYLED = [
    'Unit/Name/Marine=<s val="TooltipStyle">Marine</s>',
    'Unit/Tip/Marine=Costs <c val="ColorAttackInfo">50</c> minerals',
    'Unit/Tip/Ghost=Costs <c val="ffcc00">200</c> minerals',
    '',
  ].join(NL)

  it('links a string to every style and colour constant it applies', async () => {
    const session = await open(STYLED)
    try {
      const lease = await (session as never as {
        dataSource(contract: string, major: number): Promise<{ value: never; release(): Promise<void> }>
      }).dataSource('common.view/relation-graph-source', 1)
      const graph = lease.value as never as {
        summary(): Promise<{ completeness: string; reason?: string }>
        nodes(page: { limit: number }): Promise<{ items: readonly { id: string; type: string }[] }>
        edges(page: { limit: number }): Promise<{ items: readonly { from: string; to: string; role: string }[] }>
      }
      const nodes = await graph.nodes({ limit: 50 })
      expect(nodes.items.map(node => node.id)).toContain(
        'modkit-subject://blizzard%2Fsc2-style/Style/TooltipStyle',
      )
      expect(nodes.items.map(node => node.id)).toContain(
        'modkit-subject://blizzard%2Fsc2-style/Constant/ColorAttackInfo',
      )
      /*
       * A literal colour is a value, not a reference. Reporting `ffcc00` as a link would fill the
       * graph with edges to declarations that do not exist, which a reader then learns to ignore.
       */
      expect(nodes.items.some(node => node.id.includes('ffcc00'))).toBe(false)

      const edges = await graph.edges({ limit: 50 })
      expect(edges.items.some(edge => edge.role === 'style')).toBe(true)
      expect(edges.items.some(edge => edge.role === 'color')).toBe(true)

      // The sheet is a different document, so the graph says it cannot see the other end.
      const summary = await graph.summary()
      expect(summary.completeness).toBe('partial')
      expect(String(summary.reason)).toMatch(/style declarations/u)
      await lease.release()
    } finally {
      await (session as never as { dispose(): Promise<void> }).dispose()
    }
  })
})
