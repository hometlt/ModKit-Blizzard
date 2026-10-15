import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import {
  createCodec,
  createCodecWithOptions,
  operations,
  SC2_BANK_OPERATION_MAP,
} from '../codecs/bank/src/codec.js'
import { createSc2BankCodec } from '../codecs/bank/src/artifact-codec.js'
import {
  parseBank,
  serializeBank,
  verifyBankSignature,
} from '../codecs/bank/src/core.js'
import { createMemoryAssetSource } from '@modkit/codec-kit/legacy/assets'
import { createProvider as createWriter } from '../../../shared/editing/providers/authored-text/runtime.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const xml =
  '<?xml version="1.0"?>\r\n<Bank version="1">\r\n<!-- retained --> <Section name="Stats"><Key name="Score"><Value int=\'7\'/></Key><Key name="Other"><Value string="A &amp; B"/></Key></Section>\r\n</Bank>'
const signatureInfo = { bankName: 'Progress', playerId: '2-S2-1-10', authorId: '2-S2-1-20' }
const signedPath = '/Accounts/123456/2-S2-1-10/Banks/2-S2-1-20/Progress.SC2Bank'
export const bankBudget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

export function bankInput(bytes: Uint8Array, uri = 'memory://Progress.SC2Bank') {
  const revision = 'content-hash.sha256:bank-native-fixture'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
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
    source: ref,
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
      compositionFingerprint: 'bank-native',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => {} }
    },
  }
}

async function opened(text = xml, path?: string, info?: typeof signatureInfo) {
  const codec = info === undefined ? createCodec() : createCodecWithOptions({ signatureInfo: info })
  return codec.open(bankInput(encoder.encode(text), path) as never, 'full', bankBudget)
}

function editedBytes(result: any) {
  expect(result.state).toBe('ok')
  expect(result.output.kind).toBe('edit-plan')
  const edit = result.output.plan.edits[0]
  expect(edit.operation).toBe('replace')
  expect(edit.range.offset).toBe(0n)
  expect(edit.payload.kind).toBe('inline')
  return edit.payload.bytes as Uint8Array
}

describe('SC2 bank native M2 operation and data surfaces', () => {
  it('publishes the actual native operation mapping and validates both manifests', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../codecs/bank/codec.json'), 'utf8'),
    )
    expect(manifest.spec.operations).toEqual(
      expect.arrayContaining(operations.map(item => expect.objectContaining(item))),
    )
    // Six legacy operations mapped from MK2, plus `verify` and `edit.field`, which are native.
    expect(operations).toHaveLength(8)
    expect(Object.keys(SC2_BANK_OPERATION_MAP)).toHaveLength(6)
    for (const name of ['../codecs/bank/codec.json', '../../../contributions/subject-kind-sc2-bank.json']) {
      const value = JSON.parse(
        readFileSync(resolve(import.meta.dirname, name), 'utf8'),
      )
      const validated = await validateContributionManifest(
        value,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(validated.specState, JSON.stringify(validated.diagnostics)).toBe('validated')
      expect(validated.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('invokes exact legacy inspect/validate products and retains native facts, hierarchy and raw bytes', async () => {
    const session = await opened()
    const legacy = createSc2BankCodec()
    const document = await legacy.open(
      createMemoryAssetSource(encoder.encode(xml), { path: 'memory://Progress.SC2Bank' }),
    )
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: (await legacy.describe(document)).metadata },
      })
      expect(await session.operations().invoke('validate', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: await legacy.validate(document) },
      })
      expect(await session.operations().invoke('export-raw', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'bytes', value: encoder.encode(xml) },
      })
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.dataSources).toHaveLength(6)
      const facts = await session.dataSource('common.view/subject-facts-source', 1)
      try {
        // The installed host composes native facts first, then descriptor metadata by fact id.
        // Check both complete native values and the additional generic card values explicitly.
        expect(await facts.value.facts('values', { limit: 20 })).toMatchObject({
          items: [
            { id: 'value-0-0', value: { type: 'int', value: '7', semantic: 7 },
              provenance: [{ semanticPath: ['sections', '0', 'keys', '0'] }] },
            { id: 'value-0-1', value: { type: 'string', value: 'A & B', semantic: 'A & B' },
              provenance: [{ semanticPath: ['sections', '0', 'keys', '1'] }] },
            { id: 'Stats/Score', value: 7, provenance: [] },
            { id: 'Stats/Other', value: 'A & B', provenance: [] },
          ],
        })
      } finally { await facts.release() }
    } finally {
      await session.dispose()
    }
  })

  it('disables signing when identity is missing and enables explicit identity with verify after reopen', async () => {
    const unavailable = await opened()
    try {
      expect(
        (await unavailable.descriptor()).operations.find(item => item.handlerId === 'sign'),
      ).toMatchObject({ state: 'disabled', reason: expect.stringMatching(/could not be inferred/) })
      expect((await unavailable.operations().invoke('sign', {})).state).not.toBe('ok')
    } finally {
      await unavailable.dispose()
    }
    const session = await opened(xml, undefined, signatureInfo)
    try {
      const bytes = editedBytes(await session.operations().invoke('sign', {}))
      expect(verifyBankSignature(parseBank(decoder.decode(bytes)), signatureInfo)).toBe(true)
      const reopened = await opened(decoder.decode(bytes), signedPath)
      try {
        expect(await reopened.operations().invoke('verify', {})).toMatchObject({
          state: 'ok',
          output: { kind: 'json', value: true },
        })
      } finally {
        await reopened.dispose()
      }
    } finally {
      await session.dispose()
    }
  })

  it('re-signs value edits only when the signature verified, and reports it will be invalid otherwise', async () => {
    const signer = await opened(xml, undefined, signatureInfo)
    const signed = decoder.decode(editedBytes(await signer.operations().invoke('sign', {})))
    await signer.dispose()
    const request = { section: 'Stats', key: 'Score', type: 'int', value: '42' }
    const planOf = (result: any) => result.output.plan

    const known = await opened(signed, signedPath)
    try {
      const result = await known.operations().invoke('patch-value', request)
      const after = decoder.decode(editedBytes(result))
      expect(parseBank(after).sections[0]?.keys[0]?.value?.value).toBe('42')
      expect(verifyBankSignature(parseBank(after), signatureInfo)).toBe(true)
      expect(after).not.toBe(signed.replace("int='7'", "int='42'"))
      expect(planOf(result).diagnostics).toEqual([])
      const field = await known.operations().invoke('edit-field', { path: ['Stats', 'Score'], value: 42 })
      expect(decoder.decode(editedBytes(field))).toBe(after)
    } finally {
      await known.dispose()
    }

    for (const path of [undefined, signedPath.replace('2-S2-1-20', '2-S2-1-99')]) {
      const unknown = await opened(signed, path)
      try {
        const result = await unknown.operations().invoke('patch-value', request)
        expect(decoder.decode(editedBytes(result))).toBe(signed.replace("int='7'", "int='42'"))
        expect(planOf(result).diagnostics).toEqual([
          expect.objectContaining({
            code: 'blizzard/sc2-bank-signature-will-be-invalid',
            severity: 'warning',
            message: expect.stringMatching(/will be invalid/),
          }),
        ])
        // A no-op edit leaves the signature as it was and says nothing.
        const noop = await unknown.operations().invoke('patch-value', { ...request, value: '7' })
        expect(decoder.decode(editedBytes(noop))).toBe(signed)
        expect(planOf(noop).diagnostics).toEqual([])
      } finally {
        await unknown.dispose()
      }
    }
  })

  it('patches same-type values without touching comments, quotes, CRLF or other keys and preserves no-op bytes', async () => {
    const session = await opened()
    try {
      const request = { section: 'Stats', key: 'Score', type: 'int', value: '42' }
      const after = editedBytes(await session.operations().invoke('patch-value', request))
      expect(decoder.decode(after)).toBe(xml.replace("int='7'", "int='42'"))
      expect(
        editedBytes(await session.operations().invoke('patch-value', { ...request, value: '7' })),
      ).toEqual(encoder.encode(xml))
      await expect(
        session.operations().invoke('patch-value', { ...request, key: 'Missing' }),
      ).rejects.toThrow('Key "Missing" not found in section "Stats"')
      expect(await session.operations().invoke('save-as', { sort: true })).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: serializeBank(parseBank(xml), { sort: true }) },
      })
    } finally {
      await session.dispose()
    }
  })

  it('preserves UTF-8 BOM on raw export and raw-preserving edits', async () => {
    const original = new Uint8Array(encoder.encode(xml).length + 3)
    original.set([0xef, 0xbb, 0xbf])
    original.set(encoder.encode(xml), 3)
    const session = await createCodec().open(bankInput(original) as never, 'full', bankBudget)
    try {
      expect(await session.operations().invoke('export-raw', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'bytes', value: original },
      })
      expect(
        editedBytes(
          await session
            .operations()
            .invoke('patch-value', { section: 'Stats', key: 'Score', type: 'int', value: '7' }),
        ),
      ).toEqual(original)
    } finally {
      await session.dispose()
    }
  })

  it('keeps the published unsigned no-op writer byte-identical', async () => {
    const writer = createWriter(
      { contract: 'common.edit/writer', major: 1, offerId: 'sc2-bank-unsigned-source' },
      { budgets: bankBudget },
    )
    const target = {
      targetId: 'bank',
      ownerSource: { id: 'bank', uri: 'memory://Progress.SC2Bank' },
    }
    const change = {
      targets: [target],
      edits: [
        {
          targetId: 'bank',
          source: target.ownerSource,
          operation: 'replace',
          payload: { kind: 'inline', bytes: encoder.encode(xml) },
        },
      ],
      semanticIntent: {
        kind: 'sc2-authored-text-save-v1',
        formatId: 'sc2-bank',
        sourceComplete: true,
        unknownDataPolicy: 'preserve-from-complete-snapshot',
        originalSignaturePresent: false,
      },
    }
    try {
      expect(await writer.value.validate(change)).toMatchObject({ valid: true })
      const plan = await writer.value.plan(change)
      expect(plan.edits[0].payload.bytes).toEqual(encoder.encode(xml))
      expect(plan.fidelity.roundTrip).toBe('byte-identical')
    } finally {
      await writer.release()
    }
  })
})
