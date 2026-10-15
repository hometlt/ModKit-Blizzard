import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec } from '../../codecs/triggers/runtime.js'
import { createCodec as createGalaxyCodec } from '../../../../dist/modules/galaxy/codecs/galaxy/codec.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 32,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('SC2 Trigger codec has no service dependency')
    },
    async resolveUnknown() {
      throw new Error('SC2 Trigger codec has no foreign service dependency')
    },
  },
}

function inputFor(text: string) {
  const bytes = encoder.encode(text)
  const uri = 'memory://sc2/Triggers'
  const revision = 'content-hash.sha256:trigger-conversion-fixture'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
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
      compositionFingerprint: 'trigger-conversion-fixture',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

describe('SC2 Trigger codec public conversion operations', () => {
  it('converts the current Galaxy document from its own codec session', async () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../galaxy/codecs/galaxy/codec.json'), 'utf8'))
    const validation = await validateContributionManifest(manifest, createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES))
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    const session = await (await createGalaxyCodec(context)).open(inputFor('void fromDocument() { return; }'), 'full', budget)
    try {
      expect((await session.descriptor()).operations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'blizzard/galaxy.to-triggers', handlerId: 'to-triggers', mutatesSource: false }),
      ]))
      const result = await session.operations().invoke('to-triggers', { libraryId: 'TEST' })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('Expected reconstructed TriggerData')
      expect(result.output.value.output.triggerData).toContain('<Identifier>fromDocument</Identifier>')
      expect(result.output.value.fidelity.verification.semanticModelExact).toBe(true)
    } finally { await session.dispose() }
  })
  it('keeps the contribution manifest valid with namespaced conversion operations', async () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../codecs/triggers/codec.json'),
        'utf8',
      ),
    )
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState).toBe('validated')
    expect(validation.activationEligible).toBe(false)
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('exposes both read-only directions alongside the native edit operation', async () => {
    const text = readFileSync(
      resolve(import.meta.dirname, '../fixtures', 'pinned-runtime-fixture.Triggers'),
      'utf8',
    )
    const session = await (await createCodec(context)).open(inputFor(text), 'full', budget)
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'blizzard/sc2-triggers.trigger-to-galaxy',
            handlerId: 'trigger-to-galaxy',
            mutatesSource: false,
          }),
          expect.objectContaining({
            id: 'blizzard/sc2-triggers.galaxy-to-triggers',
            handlerId: 'galaxy-to-triggers',
            mutatesSource: false,
          }),
        ]),
      )

      const forward = await session.operations().invoke('trigger-to-galaxy', {})
      expect(forward.state).toBe('ok')
      if (forward.state !== 'ok' || forward.output.kind !== 'json') {
        throw new Error('Trigger-to-Galaxy operation did not return JSON')
      }
      expect(forward.output.value.fidelity).toMatchObject({
        direction: 'trigger-to-galaxy',
        completeness: 'complete',
      })

      const reverse = await session.operations().invoke('galaxy-to-triggers', {
        libraryId: forward.output.value.output.libraryId,
        script: forward.output.value.output.script,
        header: forward.output.value.output.header,
      })
      expect(reverse.state).toBe('ok')
      if (reverse.state !== 'ok' || reverse.output.kind !== 'json') {
        throw new Error('Galaxy-to-Triggers operation did not return JSON')
      }
      expect(reverse.output.value).toMatchObject({
        operation: 'galaxy-to-triggers',
        output: { libraryId: 'RuntimeFixture', elements: 2 },
        fidelity: {
          completeness: 'complete',
          verification: { generatedTriggerDataReparsed: true },
        },
      })
    } finally {
      await session.dispose()
    }
  })
})
