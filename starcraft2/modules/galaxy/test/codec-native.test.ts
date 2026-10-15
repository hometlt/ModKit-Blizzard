import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import { createCodec, GALAXY_OPERATION_MAP, operations } from '../../../dist/modules/galaxy/codecs/galaxy/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const source = `include "NativeLib"

int gv_count = 0;

int Add(int a, int b) {
  gv_count = a + b;
  return gv_count;
}

void Init() {
  int value = Add(gv_count, 2);
}
`
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

function galaxyInput(
  bytes: Uint8Array,
  uri = 'memory://Mods/Test.SC2Mod/Base.SC2Data/MapScript.galaxy',
) {
  const revision = 'content-hash.sha256:galaxy-native-fixture'
  const ref = { id: uri, uri }
  const sourcePort = {
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
      compositionFingerprint: 'galaxy-native',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: sourcePort, release: async () => {} }
    },
  }
}

async function opened(text = source) {
  return createCodec().open(galaxyInput(encoder.encode(text)) as never, 'full', budget)
}

describe('Galaxy native M5 adapter', () => {
  it('publishes a valid partial manifest with the executable operation table', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../codecs/galaxy/codec.json'), 'utf8'),
    )
    expect(manifest.status).toBe('partial')
    expect(manifest.spec.operations).toEqual(
      expect.arrayContaining(operations.map(item => expect.objectContaining(item))),
    )
    expect(Object.keys(GALAXY_OPERATION_MAP)).toEqual([
      'view.inspect',
      'script.symbols',
      'blizzard/galaxy.native-signatures',
      'script.references',
      'asset.validate',
      'script.completion',
      'script.format',
      'edit.structure',
      'export.convert',
      'blizzard/galaxy.to-engine',
      'blizzard/galaxy.to-triggers',
      'export.raw',
    ])
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('projects exact parser/checker symbols through text, tree and byte-range sources', async () => {
    const session = await opened('void Init() { int value = "bad"; }')
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            format: 'galaxy',
            fileName: 'MapScript.galaxy',
            nodes: expect.any(Number),
            symbols: 1,
            diagnostics: expect.any(Number),
          },
        },
      })
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.dataSources.map(item => item.contract)).toEqual(
        expect.arrayContaining([
          'common.view/text-data-source',
          'common.view/tree-data-source',
          'common.view/byte-range-source',
        ]),
      )
      expect(descriptor.metadata[0]?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'symbols', value: 1 })]),
      )
      expect(descriptor.diagnostics.map(item => item.message)).toEqual(
        expect.arrayContaining([expect.stringContaining("not assignable to 'int'")]),
      )

      const text = await session.dataSource('common.view/text-data-source', 1)
      try {
        expect(await text.value.info()).toMatchObject({ encoding: 'utf-8', lines: 1 })
        expect(
          await text.value.slice({ kind: 'from-line', line: 0, lineCount: 1, maxBytes: 128 }),
        ).toMatchObject({
          complete: true,
          text: 'void Init() { int value = "bad"; }',
        })
      } finally {
        await text.release()
      }

      const tree = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const root = await tree.value.root()
        expect(await tree.value.facts(root)).toMatchObject({
          kind: 'galaxy-source',
          label: 'MapScript.galaxy',
        })
        expect((await tree.value.children(root, { limit: 8 })).items).toHaveLength(1)
      } finally {
        await tree.release()
      }

      const bytes = await session.dataSource('common.view/byte-range-source', 1)
      try {
        const expected = encoder.encode('void Init() { int value = "bad"; }')
        expect(await bytes.value.size()).toBe(BigInt(expected.byteLength))
        expect(await bytes.value.read(0n, 9)).toEqual(expected.slice(0, 9))
      } finally {
        await bytes.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('executes symbols, references, completion, format, validation, raw and EngineProgram export', async () => {
    const session = await opened()
    try {
      expect(await session.operations().invoke('symbols', {})).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: expect.arrayContaining([expect.objectContaining({ name: 'Add' })]),
        },
      })
      const addUse = source.lastIndexOf('Add(')
      expect(await session.operations().invoke('references', { offset: addUse })).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: expect.arrayContaining([expect.objectContaining({ name: 'Add' })]),
        },
      })
      expect(
        await session.operations().invoke('completion', { offset: source.indexOf(');', addUse) }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: expect.arrayContaining([expect.objectContaining({ label: 'gv_count' })]),
        },
      })
      const formatted = await session
        .operations()
        .invoke('format', { insertSpaces: true, tabSize: 2 })
      expect(formatted.state).toBe('ok')
      expect(await session.operations().invoke('validate', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json' },
      })
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw.state).toBe('ok')
      if (raw.state === 'ok' && raw.output.kind === 'bytes')
        expect(decoder.decode(raw.output.value)).toBe(source)
      const converted = await session.operations().invoke('export-convert', {})
      expect(converted.state).toBe('ok')
      if (converted.state === 'ok' && converted.output.kind === 'bytes') {
        expect(decoder.decode(converted.output.value)).toContain('int Add')
      }
      const engine = await session.operations().invoke('to-engine', { moduleId: 'TestGalaxy' })
      expect(engine).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            program: {
              kind: 'EngineProgram',
              modules: [expect.objectContaining({ id: 'TestGalaxy' })],
            },
            fidelity: expect.objectContaining({ dropped: 0 }),
          },
        },
      })
    } finally {
      await session.dispose()
    }
  })

  it('pages exact native signatures through the ordinary codec operation', async () => {
    const session = await opened('native bool HasUnit(unit entity, int player);\nnative int Count();')
    try {
      expect(await session.operations().invoke('native-signatures', { limit: 1 })).toMatchObject({
        state: 'ok', output: { kind: 'json', value: { total: 2, nextOffset: 1,
          items: [{ name: 'HasUnit', returnType: 'bool', admission: 'unmapped-native' }] } },
      })
      expect(await session.operations().invoke('native-signatures', { offset: 1, limit: 1 })).toMatchObject({
        state: 'ok', output: { kind: 'json', value: { total: 2,
          items: [{ name: 'Count', returnType: 'int', admission: 'unmapped-native' }] } },
      })
    } finally { await session.dispose() }
  })

  it('returns a revision-pinned whole-source rename plan without changing other text', async () => {
    const session = await opened()
    try {
      const result = await session.operations().invoke('rename', {
        offset: source.lastIndexOf('gv_count'),
        newName: 'gv_total',
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      expect(result.output.plan.targets).toHaveLength(1)
      expect(result.output.plan.edits).toHaveLength(1)
      const edit = result.output.plan.edits[0]!
      expect(edit.payload.kind).toBe('inline')
      if (edit.payload.kind === 'inline') {
        const text = decoder.decode(edit.payload.bytes)
        expect(text.match(/gv_total/gu)).toHaveLength(4)
        expect(text.replaceAll('gv_total', 'gv_count')).toBe(source)
      }
    } finally {
      await session.dispose()
    }
  })
})
