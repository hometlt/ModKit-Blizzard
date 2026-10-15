/**
 * The wizard codec as a host sees it: what it claims in its manifest, what it accepts, and what the
 * surfaces hold once it is open.
 *
 * The detection tests are the ones worth keeping. A `.BlizWiz` lives anywhere inside a map or mod,
 * surrounded by other XML, so the extension alone must not win the file — and an XML document that
 * is not a wizard must not be claimed at all, however it is named.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec, operations } from '../codecs/wizard/src/codec.js'

const encoder = new TextEncoder()
const fixture = readFileSync(
  resolve(import.meta.dirname, 'fixtures/prototype-wizard.BlizWiz'),
  'utf8',
)
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

function input(bytes: Uint8Array, uri: string) {
  const revision = 'content-hash.sha256:sc2-wizard-native-fixture'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single' as const,
    bindings: [
      {
        sourceKind: 'candidate' as const,
        bindingId: 'content',
        role: 'content',
        ownership: 'owned' as const,
        source: ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: uri,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => {} }
    },
  }
}

const open = async (text: string, uri = 'memory://Test.SC2Mod/EditorWizards/Test.BlizWiz') =>
  createCodec().open(input(encoder.encode(text), uri) as never, 'full', budget)

/** The byte-probe request a host builds from the manifest's `probe` block. */
async function probe(text: string, uri: string) {
  const bytes = encoder.encode(text)
  return createCodec().probe({
    source: {
      kind: 'bytes' as const,
      ref: { id: uri, uri },
      size: BigInt(bytes.length),
      async read(offset: bigint, length: number) {
        return bytes.slice(Number(offset), Number(offset) + length)
      },
      async *stream() {
        yield bytes
      },
    },
    plan: { kind: 'bytes' as const, ranges: [{ from: 'start' as const, length: 4096 }], maxBytes: 4096 },
  } as never)
}

describe('SC2 data wizard contribution', () => {
  it('validates against the codec contribution schema', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../codecs/wizard/codec.json'), 'utf8'),
    )
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState, JSON.stringify(validation.diagnostics, null, 2)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('declares a handler for every operation it publishes, and no more', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../codecs/wizard/codec.json'), 'utf8'),
    )
    const declared = manifest.spec.operations
      .map((operation: { id: string }) => operation.id)
      .filter((id: string) => id !== 'view.inspect')
      .sort()
    expect(operations.map(operation => operation.id).sort()).toEqual(declared)
  })

  it('asks to write the source only for edit.field', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../codecs/wizard/codec.json'), 'utf8'),
    )
    for (const variant of manifest.runtimeVariants) {
      expect(variant.requestedPermissionClasses).toEqual(['read-source', 'write-source'])
    }
    const writers = manifest.spec.operations.filter((operation: { mutatesSource: boolean }) => operation.mutatesSource)
    expect(writers.map((operation: { id: string; requiredPermissions: string[] }) => [operation.id, operation.requiredPermissions])).toEqual([
      ['edit.field', ['read-source', 'write-source']],
    ])
  })
})

describe('SC2 data wizard edit plans', () => {
  const planFor = async (text: string, request: unknown, prefix = new Uint8Array()) => {
    const body = encoder.encode(text)
    const bytes = new Uint8Array(prefix.length + body.length)
    bytes.set(prefix)
    bytes.set(body, prefix.length)
    const session = await createCodec().open(input(bytes, 'memory://Test.BlizWiz') as never, 'full', budget)
    try {
      const result: any = await session.operations().invoke('edit-field', request)
      expect(result.state).toBe('ok')
      const plan = result.output.plan
      expect(plan.fidelity).toEqual({ roundTrip: 'byte-identical', preservesUnknownData: true })
      const edit = plan.edits[0]
      const offset = Number(edit.range.offset)
      const length = Number(edit.range.length)
      const written = new TextDecoder().decode(edit.payload.bytes)
      const after = new Uint8Array([...bytes.slice(0, offset), ...edit.payload.bytes, ...bytes.slice(offset + length)])
      return { old: new TextDecoder().decode(bytes.slice(offset, offset + length)), written, after }
    } finally {
      await session.dispose()
    }
  }
  const document =
    '<wizardfile><wizard id="W"><name>Мастер ✓</name><input id="I" type="int32"><default value="5"/></input><macro id="M">1 + 1</macro></wizard></wizardfile>'

  it('replaces exactly the old value bytes, past multi-byte text', async () => {
    const plan = await planFor(document, { path: ['wizard', 'W', 'input', 'I', 'default'], value: '7' })
    expect(plan).toMatchObject({ old: '5', written: '7' })
    expect(new TextDecoder().decode(plan.after)).toBe(document.replace('value="5"', 'value="7"'))
  })

  it('counts a UTF-8 byte order mark back in', async () => {
    const plan = await planFor(document, { path: ['wizard', 'W', 'macro', 'M'], value: '<2>' }, new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(plan).toMatchObject({ old: '1 + 1', written: '&lt;2&gt;' })
    expect([...plan.after.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it('refuses a path it cannot write', async () => {
    const session = await open(document, 'memory://Test.BlizWiz')
    try {
      await expect(session.operations().invoke('edit-field', { path: ['wizard', 'W', 'macro', 'Nope'], value: 'x' })).rejects.toThrow(/no macro Nope/u)
    } finally {
      await session.dispose()
    }
  })
})

describe('SC2 data wizard detection', () => {
  it('claims a file by its root element, wherever it is named', async () => {
    expect(await probe(fixture, 'a/b/Prototype.BlizWiz')).toMatchObject({
      codecId: 'blizzard/sc2-wizard',
      confidence: 0.99,
      evidence: [{ kind: 'structure', note: 'sc2-wizard-root-element' }],
    })
  })

  it('recognizes a case-variant root as a compatibility document', async () => {
    expect(
      await probe('<WizardFile><wizard id="W"><name>W</name></wizard></WizardFile>', 'a/W.BlizWiz'),
    ).toMatchObject({
      codecId: 'blizzard/sc2-wizard',
      confidence: 0.99,
      evidence: [{ kind: 'structure', note: 'sc2-wizard-root-element' }],
    })
  })

  it('recognizes a standalone wizard only when the BlizWiz extension supplies context', async () => {
    expect(
      await probe('<wizard id="W"><name>W</name></wizard>', 'a/W.BlizWiz'),
    ).toMatchObject({
      codecId: 'blizzard/sc2-wizard',
      confidence: 0.85,
      evidence: [{ kind: 'structure', note: 'sc2-wizard-compatibility-root-element' }],
    })
    expect(await probe('<wizard id="W"><name>W</name></wizard>', 'a/W.xml')).toMatchObject({
      confidence: 0,
    })
  })

  it('treats the extension alone as weak evidence, and other XML as none', async () => {
    expect(await probe('<?xml version="1.0"?>', 'a/Broken.BlizWiz')).toMatchObject({
      confidence: 0.4,
      evidence: [{ kind: 'context', note: 'sc2-wizard-path-evidence' }],
    })
    expect(await probe('<Catalog><CUnit id="Marine"/></Catalog>', 'a/Units.xml')).toMatchObject({
      confidence: 0,
    })
  })

  it('refuses to open something that is not a wizard file', async () => {
    await expect(open('<Catalog/>')).rejects.toThrow(/not a StarCraft II data wizard/u)
  })

  it('opens a standalone compatibility wizard without changing its source bytes', async () => {
    const text = '<wizard id="W"><name>W</name></wizard>'
    const session = await open(text, 'memory://Test.BlizWiz')
    try {
      await expect(session.operations().invoke('inspect', {})).resolves.toMatchObject({
        state: 'ok',
        output: { value: { format: 'sc2-wizard', wizards: 1, diagnostics: 1 } },
      })
      const exported = await session.operations().invoke('export-raw', {})
      expect(new TextDecoder().decode((exported as any).output.value)).toBe(text)
    } finally {
      await session.dispose()
    }
  })
})

describe('SC2 data wizard session', () => {
  it('publishes the tree, the input table and the wizard graph', async () => {
    const session = await open(fixture)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.dataSources).toEqual(
        expect.arrayContaining([
          { contract: 'common.view/tree-data-source', major: 1 },
          { contract: 'common.view/table-data-source', major: 1 },
          { contract: 'common.view/subject-facts-source', major: 1 },
          { contract: 'common.view/relation-graph-source', major: 1 },
        ]),
      )

      const tree = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const root = await tree.value.root()
        expect(await tree.value.facts(root)).toMatchObject({ kind: 'sc2-wizard-file' })
        const wizards = await tree.value.children(root, { cursor: '0', limit: 8 })
        expect(wizards.items).toHaveLength(1)
        expect(await tree.value.facts(wizards.items[0]!)).toMatchObject({
          kind: 'sc2-wizard',
          label: 'Prototype Wizard',
        })
      } finally {
        await tree.release()
      }

      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        const page = await table.value.rows({ kind: 'page', cursor: '0', count: 32 })
        expect(page.items.map((row: { cells: string[] }) => row.cells[1])).toContain('SimpleInteger')
      } finally {
        await table.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('inspects, validates and exports the bytes it was given', async () => {
    const session = await open(fixture)
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { format: 'sc2-wizard', wizards: 1, diagnostics: 0, catalogChecks: 'not-run' } },
      })
      expect((await session.descriptor()).constraints.unsupportedFeatures).toContain(
        'catalog, entry-type, field-path and object-type checks, which need the StarCraft II schema; the sc2-wizard language provider runs them',
      )
      expect(await session.operations().invoke('validate', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: [] },
      })
      const exported = await session.operations().invoke('export-raw', {})
      expect(new TextDecoder().decode((exported as any).output.value)).toBe(fixture)
    } finally {
      await session.dispose()
    }
  })

  it('outlines what a wizard generates', async () => {
    const session = await open(fixture)
    try {
      const result: any = await session
        .operations()
        .invoke('outline', { wizardId: 'PrototypeWizard' })
      expect(result.state).toBe('ok')
      expect(result.output.value).toHaveLength(1)
      expect(result.output.value[0].touchedFields).toContain('Actor.CActorUnit.WireframeVariations_Number')
      await expect(
        session.operations().invoke('outline', { wizardId: 'Missing' }),
      ).rejects.toThrow(/no wizard Missing/u)
    } finally {
      await session.dispose()
    }
  })

  it('evaluates what it can and refuses what needs a catalog', async () => {
    const session = await open(fixture)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'blizzard/sc2-wizard.evaluate', state: 'available' }),
        ]),
      )
      expect(descriptor.constraints.unsupportedFeatures).toContain(
        'evaluation of ref= catalog references, which needs loaded StarCraft II data',
      )
      const evaluated: any = await session.operations().invoke('evaluate', {
        wizardId: 'PrototypeWizard',
        text: '^TestMath1^',
        inputs: { SimpleInteger: 5 },
      })
      expect(evaluated.output.value).toMatchObject({ text: '11', resolved: true })
      await expect(
        session.operations().invoke('evaluate', {
          wizardId: 'PrototypeWizard',
          text: '^KillPlusLost^',
          loadId: 'Marine',
        }),
      ).rejects.toThrow(/needs loaded StarCraft II catalog data/u)
    } finally {
      await session.dispose()
    }
  })

  it('opens a wizard whose only findings are information', async () => {
    // An undocumented element is an information finding; the descriptor schema spells it
    // `information`, and `info` made the host refuse to open such a file.
    const session = await open('<wizardfile><wizard id="W"><name>W</name><input id="I" type="WizardText"><count>3</count></input></wizard></wizardfile>')
    try {
      const descriptor = await session.descriptor()
      expect((descriptor.diagnostics ?? []).map((item: any) => [item.code, item.severity])).toEqual([
        ['blizzard.sc2-wizard/unknown-element', 'information'],
      ])
    } finally {
      await session.dispose()
    }
  })

  it('reports a broken wizard as descriptor diagnostics rather than by failing to open', async () => {
    const session = await open(
      '<wizardfile><wizard id="W"><input id="A" type="int32"><condition input="Missing"/></input></wizard></wizardfile>',
    )
    try {
      const descriptor = await session.descriptor()
      const codes = (descriptor.diagnostics ?? []).map((item: any) => item.code)
      expect(codes).toContain('blizzard.sc2-wizard/missing-name')
      expect(codes).toContain('blizzard.sc2-wizard/unknown-input')
    } finally {
      await session.dispose()
    }
  })
})
