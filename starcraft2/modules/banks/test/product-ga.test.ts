import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'

import {
  createCodec as createBankListCodec,
  definition as bankListDefinition,
} from '../codecs/bank-list/runtime.js'
import {
  createCodec as createBankCodec,
  definition as bankDefinition,
} from '../codecs/bank/runtime.js'
import { parseSc2Bank, scanGalaxyBankLoads } from '../shared/model.js'
import { createProvider as createAuthoredTextWriter } from '../../../shared/editing/providers/authored-text/runtime.js'

const encoder = new TextEncoder()
const budget = Object.freeze({
  maxInputBytes: 1_073_741_824n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 104_857_600n,
  maxDiagnostics: 1_000,
})
const contributionContext = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('SC2 bank codecs have no service dependency')
    },
    async resolveUnknown() {
      throw new Error('SC2 bank codecs have no foreign service dependency')
    },
  },
}

function inspectContext(uri: string) {
  const source = Object.freeze({ id: `source:${uri}`, uri, parentIds: Object.freeze([]) })
  return {
    budget,
    primary: { source },
    input: { revisions: { revision: 'content-hash.sha256:sc2-bank-fixture' } },
  }
}

function inputFor(text: string, uri: string) {
  const bytes = encoder.encode(text)
  const revision = 'content-hash.sha256:sc2-bank-fixture'
  const source = {
    kind: 'bytes' as const,
    ref: { id: `source:${uri}`, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  const binding = {
    sourceKind: 'candidate' as const,
    bindingId: 'content',
    role: 'content',
    ownership: 'owned' as const,
    source: source.ref,
    revision,
  }
  return {
    originKind: 'single' as const,
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: 'sc2-bank-fixture',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

describe('StarCraft II bank Product-GA read surfaces', () => {
  it('keeps bank, BankList, package and writer contributions schema-valid', async () => {
    for (const [name, path] of [
      ['codec-sc2-bank.json', resolve(import.meta.dirname, '../codecs/bank/codec.json')],
      ['codec-sc2-bank-list.json', resolve(import.meta.dirname, '../codecs/bank-list/codec.json')],
      ['codec-sc2-map-directory.json', resolve(import.meta.dirname, '../../../modules/map/codecs/package-directory/codec.json')],
      ['codec-sc2-mod-directory.json', resolve(import.meta.dirname, '../../../modules/mod/codecs/directory/codec.json')],
      ['codec-sc2-campaign-directory.json', resolve(import.meta.dirname, '../../../modules/campaign/codecs/directory/codec.json')],
      ['authored-text/provider.json', resolve(import.meta.dirname, '../../../shared/editing/providers/authored-text/provider.json')],
    ]) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      const validation = await validateContributionManifest(
        manifest,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(
        validation.specState,
        `${name}: ${JSON.stringify(validation.diagnostics, null, 2)}`,
      ).toBe('validated')
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('publishes typed bank facts and a Bank -> Section -> Key relation graph', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Bank version="1">
  <Section name="Progress">
    <Key name="Wins"><Value int="7"/></Key>
    <Key name="Title"><Value string="A &amp; B"/></Key>
  </Section>
</Bank>`
    const context = inspectContext('memory://Progress.SC2Bank')
    const inspected = await bankDefinition.inspect(encoder.encode(xml), context as never)
    expect(inspected.summary).toMatchObject({
      format: 'sc2-bank',
      sections: 1,
      keys: 2,
      valueTypes: ['int', 'string'],
      signaturePresent: false,
    })

    const facts = inspected.dataSources['common.view/subject-facts-source']
    await expect(facts.summary()).resolves.toMatchObject({
      identity: { kind: 'sc2-bank' },
      groupCount: 3,
      relationCount: 1,
    })
    await expect(facts.facts('values', { limit: 10 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          label: 'Progress / Wins',
          value: { type: 'int', value: '7', semantic: 7 },
        }),
        expect.objectContaining({
          label: 'Progress / Title',
          value: { type: 'string', value: 'A & B', semantic: 'A & B' },
        }),
      ]),
    })

    const graph = inspected.dataSources['common.view/relation-graph-source']
    await expect(graph.summary()).resolves.toMatchObject({
      totalNodes: 4,
      totalEdges: 3,
      completeness: 'complete',
    })
    await expect(graph.edges({ limit: 10 })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ role: 'contains-section' }),
        expect.objectContaining({ role: 'contains-key' }),
      ]),
    })
  })

  it('reads standalone BankList metadata as facts and bank relations', async () => {
    const xml = `<?xml version="1.0"?>
<BankList>
  <Bank Name="Progress" Player="1"/>
  <Bank Name="Shared" Region="EU"/>
</BankList>`
    const context = inspectContext('memory://BankList.xml')
    await expect(
      bankListDefinition.detect(encoder.encode(xml), 'memory://BankList.xml'),
    ).resolves.toMatchObject({
      confidence: 0.999,
    })
    const inspected = await bankListDefinition.inspect(encoder.encode(xml), context as never)
    expect(inspected.summary).toMatchObject({
      format: 'sc2-bank-list',
      banks: 2,
      bankNames: ['Progress', 'Shared'],
      playerScopedBanks: 1,
    })
    const facts = inspected.dataSources['common.view/subject-facts-source']
    await expect(facts.relations({ limit: 10 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ role: 'declares-bank', label: 'Progress' }),
        expect.objectContaining({ role: 'declares-bank', label: 'Shared' }),
      ],
    })
  })

  it('resolves only exact literal Galaxy BankLoad names and keeps dynamic calls explicit', () => {
    const scan = scanGalaxyBankLoads(
      `// BankLoad("Commented", 1)
void Init() {
  bank progress = BankLoad("Progress", 1);
  bank dynamic = BankLoad(bankName, 2);
}`,
      budget,
    )
    expect(scan).toEqual({
      calls: [{ name: 'Progress', playerExpression: '1', player: 1, offset: expect.any(Number) }],
      dynamicCalls: 1,
    })
  })

  it('publishes the bounded unsigned-bank writer and refuses signed or signature-unknown saves', async () => {
    const lease = createAuthoredTextWriter(
      { contract: 'common.edit/writer', major: 1, offerId: 'sc2-bank-unsigned-source' },
      contributionContext as never,
    )
    const writer = lease.value
    expect(writer.offer).toMatchObject({
      formatId: 'sc2-bank',
      fidelityEvidenceId: 'sc2-bank-unsigned-writer-v1',
      minimumRoundTrip: 'byte-identical',
    })
    const target = { targetId: 'bank', ownerSource: { id: 'source:bank' } }
    const baseChange = {
      targets: [target],
      edits: [
        {
          targetId: 'bank',
          source: target.ownerSource,
          operation: 'replace',
          payload: { kind: 'text', text: '<Bank version="1"/>' },
        },
      ],
      semanticIntent: {
        kind: 'sc2-authored-text-save-v1',
        formatId: 'sc2-bank',
        sourceComplete: true,
        unknownDataPolicy: 'preserve-from-complete-snapshot',
      },
    }
    for (const originalSignaturePresent of [true, undefined]) {
      const validation = await writer.validate({
        ...baseChange,
        semanticIntent: {
          ...baseChange.semanticIntent,
          ...(originalSignaturePresent === undefined ? {} : { originalSignaturePresent }),
        },
      })
      expect(validation).toMatchObject({
        valid: false,
        diagnostics: [
          expect.objectContaining({
            code: 'blizzard/sc2-bank-signature-unsupported',
          }),
        ],
      })
    }
    await lease.release()
  })

  it('assembles editable bank and read-only BankList sessions with facts and relations', async () => {
    for (const fixture of [
      {
        createCodec: createBankCodec,
        uri: 'memory://Progress.SC2Bank',
        text: '<Bank version="1"><Section name="S"><Key name="K"><Value int="1"/></Key></Section></Bank>',
      },
      {
        createCodec: createBankListCodec,
        uri: 'memory://BankList.xml',
        text: '<BankList><Bank Name="Progress" Player="1"/></BankList>',
      },
    ]) {
      const session = await (
        await fixture.createCodec(contributionContext as never)
      ).open(inputFor(fixture.text, fixture.uri) as never, 'full', budget)
      try {
        const descriptor = await session.descriptor()
        expect(descriptor.constraints.readOnly).toBe(fixture.createCodec !== createBankCodec)
        expect(descriptor.operations.some(operation => operation.mutatesSource === true)).toBe(
          fixture.createCodec === createBankCodec,
        )
        expect(descriptor.dataSources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ contract: 'common.view/subject-facts-source' }),
            expect.objectContaining({ contract: 'common.view/relation-graph-source' }),
          ]),
        )
      } finally {
        await session.dispose()
      }
    }
  })

  it('rejects structurally malformed banks before facts are produced', () => {
    expect(() => parseSc2Bank('<Bank><Section name="Broken"></Bank>', budget)).toThrow(
      /nesting is invalid/u,
    )
  })
})
