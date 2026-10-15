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
  operations,
  SC2_TRIGGER_OPERATION_MAP,
} from '../../../dist/modules/triggers/codecs/triggers/src/codec.js'
import {
  TRIGGER_RENAME_CONFLICT_CODE,
  TRIGGER_RENAME_CUSTOM_SCRIPT_CODE,
  TRIGGER_RENAME_NO_CATALOG_CODE,
  TRIGGER_RENAME_NO_OP_CODE,
} from '../../../dist/modules/triggers/services/editing/rename.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const source = `<?xml version="1.0" encoding="utf-8"?>
<TriggerData>
  <Library Id="DEMO">
    <Root>
      <Item Type="FunctionDef" Id="FUNC"/>
      <Item Type="Variable" Id="VAR"/>
    </Root>
    <Element Type="FunctionDef" Id="FUNC">
      <Identifier>DemoRun</Identifier>
      <FlagCustomScript/>
      <ScriptCode>return;</ScriptCode>
    </Element>
    <Element Type="Variable" Id="VAR">
      <Identifier>DemoCount</Identifier>
      <VariableType><Type Value="int"/></VariableType>
    </Element>
    <Element Type="Param" Id="UNIT">
      <ParameterDef Type="ParamDef" Library="Ntve" Id="PARAM"/>
      <Value>Marine</Value>
      <ValueType Type="gamelink"/>
      <ValueGameType Type="Unit"/>
    </Element>
  </Library>
</TriggerData>
`
const nativeDependency = `<TriggerData><Library Id="Ntve">
  <Element Type="ParamDef" Id="PARAM">
    <Identifier>unit</Identifier>
    <ParameterType><Type Value="string"/></ParameterType>
  </Element>
</Library></TriggerData>`
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

function triggerInput(bytes: Uint8Array) {
  const uri = 'memory://Mods/Test.SC2Mod/Triggers'
  const revision = 'content-hash.sha256:sc2-triggers-native-fixture'
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
    bindings: [{
      sourceKind: 'candidate' as const,
      bindingId: 'content',
      role: 'content',
      ownership: 'owned' as const,
      source: ref,
      revision,
    }],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: 'sc2-triggers-native',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: sourcePort, release: async () => {} }
    },
  }
}

async function opened(text = source) {
  return createCodec().open(triggerInput(encoder.encode(text)) as never, 'full', budget)
}

function editPlanText(result: any): string {
  expect(result.state).toBe('ok')
  expect(result.output?.kind).toBe('edit-plan')
  const payload = result.output.plan.edits[0]?.payload
  expect(payload?.kind).toBe('inline')
  if (payload?.kind !== 'inline') throw new Error('operation did not return inline edit bytes')
  return decoder.decode(payload.bytes)
}

describe('SC2 TriggerData native M5 adapter', () => {
  it('publishes a validated compiled manifest with every executable operation', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', 'codecs', 'triggers', 'codec.json'), 'utf8'),
    )
    expect(manifest.status).toBe('partial')
    expect(manifest.runtimeVariants.map((item: any) => item.entrypoint)).toEqual([
      './dist/modules/triggers/codecs/triggers/src/codec.js',
      './dist/modules/triggers/codecs/triggers/src/codec.js',
    ])
    expect(manifest.spec.operations).toEqual(
      expect.arrayContaining(operations.map(item => expect.objectContaining(item))),
    )
    expect(Object.keys(SC2_TRIGGER_OPERATION_MAP)).toHaveLength(18)
    const validation = await validateContributionManifest(
      manifest,
      createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
    )
    expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
    expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
  })

  it('leases real text, tree and byte-range sources from the exact source index', async () => {
    const session = await opened()
    try {
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            format: 'sc2-triggers',
            fileName: 'Triggers',
            libraries: ['DEMO'],
            elements: 3,
            scripts: 1,
            gameLinks: 1,
          },
        },
      })
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.dataSources.map(item => item.contract)).toEqual(expect.arrayContaining([
        'common.view/text-data-source',
        'common.view/tree-data-source',
        'common.view/byte-range-source',
      ]))

      const text = await session.dataSource('common.view/text-data-source', 1)
      try {
        expect((await text.value.slice({ kind: 'from-line', line: 0, lineCount: 2, maxBytes: 256 })).text)
          .toContain('<?xml version=')
      } finally {
        await text.release()
      }

      const tree = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const root = await tree.value.root()
        expect(await tree.value.facts(root)).toMatchObject({ kind: 'trigger-data', label: 'Triggers' })
        expect((await tree.value.children(root, { limit: 8 })).items).toHaveLength(1)
      } finally {
        await tree.release()
      }

      const ranges = await session.dataSource('common.view/byte-range-source', 1)
      try {
        const bytes = encoder.encode(source)
        expect(await ranges.value.size()).toBe(BigInt(bytes.length))
        expect(await ranges.value.read(0n, 24)).toEqual(bytes.slice(0, 24))
      } finally {
        await ranges.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('executes source-index, validation, search, conversion, edit and data-only Engine AST operations', async () => {
    const session = await opened()
    try {
      expect(await session.operations().invoke('symbols', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: expect.arrayContaining([
          expect.objectContaining({ type: 'FunctionDef', id: 'FUNC', name: 'DemoRun' }),
        ]) },
      })
      expect(await session.operations().invoke('references', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: expect.arrayContaining([
          expect.objectContaining({ target: expect.objectContaining({ library: 'Ntve', id: 'PARAM' }) }),
        ]) },
      })
      expect(await session.operations().invoke('search', { query: 'demo', types: ['Variable'] }))
        .toMatchObject({ state: 'ok', output: { kind: 'json', value: [expect.objectContaining({ id: 'VAR' })] } })
      expect(await session.operations().invoke('tree-page', { limit: 2 })).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { items: expect.any(Array), nextCursor: '2', total: 3 } },
      })
      expect(await session.operations().invoke('element-get', { id: 'VAR', library: 'DEMO' }))
        .toMatchObject({
          state: 'ok',
          output: { kind: 'json', value: {
            id: 'VAR',
            type: 'Variable',
            source: expect.stringContaining('<Element Type="Variable" Id="VAR">'),
          } },
        })
      expect(await session.operations().invoke('validate', {}))
        .toMatchObject({ state: 'ok', output: { kind: 'json' } })

      const converted = await session.operations().invoke('export-convert', {
        part: 'script',
        dependencyLibraries: [{ triggerData: nativeDependency }],
      })
      expect(converted.state).toBe('ok')
      if (converted.state === 'ok' && converted.output.kind === 'bytes') {
        expect(decoder.decode(converted.output.value)).toContain('libDEMO_gf_DemoRun')
      }
      const custom = await session.operations().invoke('trigger-to-galaxy', {
        dependencyLibraries: [{ triggerData: nativeDependency }],
      })
      expect(custom).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: {
          output: { libraryId: 'DEMO' },
          digest: { algorithm: 'sha-256', value: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        } },
      })
      if (custom.state !== 'ok' || custom.output.kind !== 'json') {
        throw new Error('trigger-to-galaxy did not return its structured output')
      }
      const forward = custom.output.value as any
      const reverse = await session.operations().invoke('galaxy-to-triggers', {
        libraryId: forward.output.libraryId,
        script: forward.output.script,
        header: forward.output.header,
        dependencyLibraries: [{ triggerData: nativeDependency }],
        verification: 'semantic',
      })
      expect(reverse).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: {
          output: { libraryId: 'DEMO', triggerData: expect.stringContaining('<TriggerData>') },
          fidelity: { verification: { generatedTriggerDataReparsed: true } },
        } },
      })
      expect(await session.operations().invoke('compare', {
        dependencyLibraries: [{ triggerData: nativeDependency }],
        verification: 'semantic',
      })).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { generatedTriggerDataReparsed: true } },
      })
      const engine = await session.operations().invoke('to-engine', {})
      expect(engine).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { program: { kind: 'EngineProgram', modules: [
          expect.objectContaining({ id: 'DEMO' }),
        ] } } },
      })

      const noOp = await session.operations().invoke('rename-gamelinks', {
        renames: [{ catalog: 'Unit', oldId: 'Zergling', newId: 'Hydralisk' }],
      })
      expect(noOp.state).toBe('ok')
      if (noOp.state !== 'ok' || noOp.output.kind !== 'edit-plan') return
      const noOpPayload = noOp.output.plan.edits[0]?.payload
      expect(noOpPayload?.kind).toBe('inline')
      if (noOpPayload?.kind === 'inline') expect(noOpPayload.bytes).toEqual(encoder.encode(source))
      expect(noOp.output.plan.diagnostics.map(item => item.code)).toEqual(
        expect.arrayContaining([TRIGGER_RENAME_NO_CATALOG_CODE, TRIGGER_RENAME_NO_OP_CODE]),
      )

      const changed = await session.operations().invoke('rename-gamelinks', {
        renames: [{ catalog: 'Unit', oldId: 'Marine', newId: 'Marauder' }],
      })
      expect(changed.state).toBe('ok')
      if (changed.state !== 'ok' || changed.output.kind !== 'edit-plan') return
      const payload = changed.output.plan.edits[0]?.payload
      expect(payload?.kind).toBe('inline')
      if (payload?.kind === 'inline') {
        const edited = decoder.decode(payload.bytes)
        expect(edited).toContain('<Value>Marauder</Value>')
        expect(edited.replace('Marauder', 'Marine')).toBe(source)
      }
      expect(changed.output.plan.diagnostics.map(item => item.code)).toEqual(
        expect.arrayContaining([TRIGGER_RENAME_NO_CATALOG_CODE, TRIGGER_RENAME_CUSTOM_SCRIPT_CODE]),
      )

      const conflicting = await session.operations().invoke('rename-gamelinks', {
        renames: [
          { catalog: 'Unit', oldId: 'Marine', newId: 'MarineA' },
          { catalog: 'unit', oldId: 'Marine', newId: 'MarineB' },
        ],
      })
      expect(conflicting.state).toBe('ok')
      if (conflicting.state !== 'ok' || conflicting.output.kind !== 'edit-plan') return
      expect(conflicting.output.plan.edits).toEqual([])
      expect(conflicting.output.plan.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({
          code: TRIGGER_RENAME_CONFLICT_CODE,
          severity: 'error',
        })]),
      )
      expect(await session.operations().invoke('export-raw', {}))
        .toMatchObject({ state: 'ok', output: { kind: 'bytes', value: encoder.encode(source) } })
    } finally {
      await session.dispose()
    }
  })

  it('produces revision-pinned parameter, insert, move and delete tree edits', async () => {
    const session = await opened()
    try {
      const updated = editPlanText(await session.operations().invoke('parameter-update', {
        element: { id: 'UNIT', library: 'DEMO', type: 'Param' },
        value: 'Marauder & <elite>',
      }))
      expect(updated).toContain('<Value>Marauder &amp; &lt;elite&gt;</Value>')
      expect(updated.replace('Marauder &amp; &lt;elite&gt;', 'Marine')).toBe(source)

      const inserted = editPlanText(await session.operations().invoke('element-insert', {
        library: 'DEMO',
        beforeId: 'VAR',
        beforeType: 'Variable',
        elementXml: '<Element Type="Param" Id="NEW"><Value>7</Value></Element>',
      }))
      expect(inserted.indexOf('<Element Type="Param" Id="NEW"'))
        .toBeLessThan(inserted.indexOf('<Element Type="Variable" Id="VAR"'))
      expect(inserted).toContain('    <Element Type="Param" Id="NEW"><Value>7</Value></Element>')

      await expect(session.operations().invoke('element-insert', {
        library: 'DEMO',
        elementXml: '<Element Type="Variable" Id="VAR"/>',
      })).rejects.toThrow('already exists')
      await expect(session.operations().invoke('element-insert', {
        library: 'DEMO',
        elementXml: '<Element Type="Param" Id="BAD"/> trailing text',
      })).rejects.toThrow('exactly one Element root')

      const deleted = editPlanText(await session.operations().invoke('element-delete', {
        element: { id: 'VAR', library: 'DEMO', type: 'Variable' },
      }))
      expect(deleted).not.toContain('<Element Type="Variable" Id="VAR">')
      expect(deleted).toContain('<Element Type="FunctionDef" Id="FUNC">')
    } finally {
      await session.dispose()
    }

    const twoLibraries = source.replace(
      '</TriggerData>',
      '  <Library Id="OTHER">\n  </Library>\n</TriggerData>',
    )
    const moveSession = await opened(twoLibraries)
    try {
      const moved = editPlanText(await moveSession.operations().invoke('element-move', {
        element: { id: 'VAR', library: 'DEMO', type: 'Variable' },
        library: 'OTHER',
      }))
      const other = moved.slice(moved.indexOf('<Library Id="OTHER">'))
      expect(other).toContain('<Element Type="Variable" Id="VAR">')
      expect(moved.match(/<Element Type="Variable" Id="VAR">/gu)).toHaveLength(1)
    } finally {
      await moveSession.dispose()
    }
  })
})
