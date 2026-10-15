import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isGameTemplatePreviewResult } from '@modkit/sdk/templates'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec } from '../codecs/layout/src/codec.js'

const encoder = new TextEncoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}
const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('SC2Layout codec has no service dependency')
    },
    async resolveUnknown() {
      throw new Error('SC2Layout codec has no foreign service dependency')
    },
  },
}

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures', 'layout', name), 'utf8')

function inputFor(text: string) {
  const bytes = encoder.encode(text)
  const uri = 'memory://sc2/TechTreePanel.SC2Layout'
  const revision = 'content-hash.sha256:sc2-layout-fixture'
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
      compositionFingerprint: 'sc2-layout-fixture',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

describe('SC2Layout codec Product-GA routing', () => {
  it('keeps codec and language-provider contributions schema-valid', async () => {
    for (const manifestPath of [
      resolve(import.meta.dirname, '..', 'codecs', 'layout', 'codec.json'),
      resolve(import.meta.dirname, '..', 'providers', 'language', 'provider.json'),
    ]) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const validation = await validateContributionManifest(
        manifest,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(validation.specState, JSON.stringify(validation.diagnostics, null, 2)).toBe(
        'validated',
      )
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('exposes resolved layout and tech-tree candidate previews through generic operations', async () => {
    const tech = fixture('TechTreePanel.SC2Layout')
    const session = await (await createCodec(context)).open(inputFor(tech), 'full', budget)
    try {
      const descriptor = await session.descriptor()
      // Preview operations are read-only, while the document itself is editable through the
      // raw-preserving rename operation exercised by the native-host suite.
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'edit.content',
            handlerId: 'rename-reference',
            mutatesSource: true,
          }),
          expect.objectContaining({
            id: 'view.template',
            handlerId: 'game-template-preview',
            mutatesSource: false,
          }),
          expect.objectContaining({
            id: 'blizzard/sc2-layout.preview',
            handlerId: 'layout-preview',
            mutatesSource: false,
          }),
          expect.objectContaining({
            id: 'blizzard/sc2-layout.tech-tree',
            handlerId: 'tech-tree-preview',
            mutatesSource: false,
          }),
        ]),
      )
      const documents = [
        {
          uri: 'memory://sc2/StandardTemplates.SC2Layout',
          text: fixture('StandardTemplates.SC2Layout'),
        },
        { uri: 'memory://sc2/TechTreePanel.SC2Layout', text: tech },
      ]
      const result = await session.operations().invoke('tech-tree-preview', {
        documents,
        rootPath: 'CategoryFrame_Nod',
        viewport: { width: 1280, height: 1024 },
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'json') {
        throw new Error('SC2Layout tech-tree preview did not return JSON')
      }
      expect(result.output.value).toMatchObject({
        schemaVersion: 1,
        operationId: 'view.template',
        candidateContract: 'blizzard/game-template-preview-candidate@1',
        templateKind: 'sc2-tech-tree-v1',
        completeness: 'partial',
        fidelity: { comparison: 'semantic' },
      })
      expect(isGameTemplatePreviewResult(result.output.value)).toBe(true)

      const common = await session.operations().invoke('game-template-preview', {
        templateKind: 'sc2-tech-tree-v1',
        documents,
        rootPath: 'CategoryFrame_Nod',
      })
      expect(common).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: { operationId: 'view.template', templateKind: 'sc2-tech-tree-v1' },
        },
      })

      const controller = new AbortController()
      const large = `<Desc>${'<Frame name="Bounded"><Width val="1"/></Frame>'.repeat(12_000)}</Desc>`
      const cancelled = session.operations().invoke(
        'layout-preview',
        {
          documents: [{ uri: 'memory://sc2/Large.SC2Layout', text: large }],
        },
        { signal: controller.signal },
      )
      setTimeout(() => controller.abort(), 0)
      await expect(cancelled).resolves.toMatchObject({
        state: 'rejected',
        reason: 'cancelled',
      })
    } finally {
      await session.dispose()
    }
  })
})
