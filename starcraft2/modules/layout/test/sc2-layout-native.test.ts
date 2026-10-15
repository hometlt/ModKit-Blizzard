import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  A1_SPEC_SCHEMA_ENTRIES,
  createSpecSchemaRegistry,
  validateContributionManifest,
} from '@modkit/sdk'
import {
  SC2_LAYOUT_OPERATION_MAP,
  createCodec,
  operations,
} from '../../../dist/modules/layout/codecs/layout/src/codec.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = {
  maxInputBytes: 4_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 4_000_000,
  maxDiagnostics: 1_000,
}

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures', 'layout', name), 'utf8')

function layoutInput(text: string, name = 'TechTreePanel.SC2Layout') {
  const bytes = encoder.encode(text)
  const uri = `memory://sc2/${name}`
  const revision = 'content-hash.sha256:sc2-layout-native-fixture'
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
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
      compositionFingerprint: 'sc2-layout-native',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

async function opened(text = fixture('TechTreePanel.SC2Layout')) {
  return createCodec().open(layoutInput(text) as never, 'full', budget)
}

const workspaceDocuments = [
  {
    uri: 'memory://sc2/StandardTemplates.SC2Layout',
    text: fixture('StandardTemplates.SC2Layout'),
  },
  {
    uri: 'memory://sc2/TechTreePanel.SC2Layout',
    text: fixture('TechTreePanel.SC2Layout'),
  },
]

describe('SC2Layout native M5 codec', () => {
  it('publishes valid partial manifests with the complete executable operation table', async () => {
    const contributionDirectory = resolve(import.meta.dirname, '..', '..', '..', 'contributions')
    const codecManifestPath = resolve(import.meta.dirname, '..', 'codecs', 'layout', 'codec.json')
    const providerManifestPath = resolve(import.meta.dirname, '..', 'providers', 'language', 'provider.json')
    const manifest = JSON.parse(readFileSync(codecManifestPath, 'utf8'))
    expect(manifest.status).toBe('partial')
    const portable = manifest.runtimeVariants.find(
      (variant: { variantId?: string }) => variant.variantId === 'portable',
    )
    expect(portable?.target.environments).toEqual(['browser-worker', 'node-worker'])
    const portableEntrypoint = resolve(import.meta.dirname, '..', '..', '..', portable.entrypoint)
    expect(existsSync(portableEntrypoint)).toBe(true)
    expect(readFileSync(portableEntrypoint, 'utf8')).not.toMatch(
      /(?:from\s*|import\s*\()["'](?:node:|fs["']|path["']|util["']|stream["'])/u,
    )
    expect(manifest.spec.operations).toEqual(
      expect.arrayContaining(operations.map(item => expect.objectContaining(item))),
    )
    for (const manifestPath of [
      codecManifestPath,
      providerManifestPath,
      resolve(contributionDirectory, 'subject-kind-sc2-layout.json'),
    ]) {
      const value = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const validation = await validateContributionManifest(
        value,
        createSpecSchemaRegistry(A1_SPEC_SCHEMA_ENTRIES),
      )
      expect(validation.specState, JSON.stringify(validation.diagnostics)).toBe('validated')
      expect(validation.diagnostics.filter(item => item.severity === 'error')).toEqual([])
    }
  })

  it('maps every admitted legacy and M5 operation to one native handler', () => {
    expect(Object.keys(SC2_LAYOUT_OPERATION_MAP)).toEqual([
      'sc2-layout.parse',
      'sc2-layout.resolve',
      'selector.resolve',
      'view.render',
      'sc2-layout.render-visual',
      'view.inspect',
      'asset.validate',
      'edit.structure',
      'sc2-layout.language-features',
      'export.convert',
      'export.raw',
      'view.template',
      'blizzard/sc2-layout.preview',
      'blizzard/sc2-layout.tech-tree',
    ])
    expect(operations).toHaveLength(14)
    expect(new Set(operations.map(item => item.handlerId)).size).toBe(14)
  })

  it('projects metadata plus text, bytes, table and tree data sources', async () => {
    const session = await opened(
      '<Desc><Frame type="Button" name="Close"><Shortcut val="@Button/Hotkey/Cancel"/></Frame></Desc>',
    )
    try {
      const descriptor = await session.descriptor()
      expect(descriptor.constraints.readOnly).toBe(false)
      expect(descriptor.dataSources.map(source => source.contract)).toEqual(
        expect.arrayContaining([
          'common.view/text-data-source',
          'common.view/byte-range-source',
          'common.view/table-data-source',
          'common.view/tree-data-source',
          'common.view/relation-graph-source',
        ]),
      )
      expect(descriptor.operations.map(operation => operation.handlerId)).toEqual(
        expect.arrayContaining(['parse', 'resolve', 'selector-resolve', 'validate', 'render-visual']),
      )
      const table = await session.dataSource('common.view/table-data-source', 1)
      try {
        expect(await (table.value as any).shape()).toMatchObject({ columns: 3 })
        expect(await (table.value as any).rows({ kind: 'range', from: 0, count: 5 })).toEqual(
          expect.objectContaining({ items: expect.any(Array) }),
        )
      } finally {
        await table.release()
      }
      const relations = await session.dataSource('common.view/relation-graph-source', 1)
      try {
        expect(await (relations.value as any).summary()).toMatchObject({
          completeness: 'partial',
          totalEdges: expect.any(Number),
        })
        const edges = await (relations.value as any).edges({ limit: 100 })
        expect(edges.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'Shortcut' }),
          ]),
        )
      } finally {
        await relations.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('publishes frames, animations and state groups with declaration navigation through the common tree', async () => {
    const text =
      '<Desc>\n<Frame type="Frame" name="Panel">\n' +
      '<Animation name="Fade"/>\n<StateGroup name="Visibility"/>\n' +
      '<Frame type="Label" name="Title"/>\n</Frame>\n</Desc>'
    const session = await opened(text)
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as import('@modkit/sdk').TreeDataSource
        const frames = await tree.children(await tree.root(), { limit: 10 })
        expect(frames.items).toHaveLength(1)
        const frame = frames.items[0]
        if (frame === undefined) throw new Error('Expected the Panel frame')
        const children = await tree.children(frame, { limit: 10 })
        const facts = await Promise.all(children.items.map(node => tree.facts(node)))
        expect(facts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'animation',
              label: 'Fade',
              semanticPath: ['TechTreePanel', 'Panel', 'Fade'],
            }),
            expect.objectContaining({
              kind: 'state-group',
              label: 'Visibility',
              semanticPath: ['TechTreePanel', 'Panel', 'Visibility'],
            }),
            expect.objectContaining({ kind: 'frame', label: 'Title' }),
          ]),
        )
        for (const item of facts.filter(item => item.kind !== 'schema')) {
          expect(item.subjectId).toBe('memory://sc2/TechTreePanel.SC2Layout')
          expect(item.range).toBeDefined()
          const range = item.range
          if (range === undefined) throw new Error('Expected a declaration range')
          expect(text.slice(range.utf16Offset, range.utf16Offset + range.utf16Length)).toContain(
            `name="${item.label}"`,
          )
        }
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('exposes native hookups, description fields and inherited class properties through the common tree', async () => {
    const session = await opened('<Desc><Frame type="ConsolePanel" name="Console"/></Desc>')
    try {
      const lease = await session.dataSource('common.view/tree-data-source', 1)
      try {
        const tree = lease.value as import('@modkit/sdk').TreeDataSource
        const children = async (parent: import('@modkit/sdk').TreeNodeRef) => {
          const page = await tree.children(parent, { limit: 256 })
          return Promise.all(page.items.map(async node => ({ node, facts: await tree.facts(node) })))
        }
        const frames = await children(await tree.root())
        const frame = frames[0]
        if (frame === undefined) throw new Error('Expected the Console frame')
        const schema = (await children(frame.node)).find(item => item.facts.kind === 'schema')
        if (schema === undefined) throw new Error('Expected the frame schema')
        expect(schema.facts.value).toMatchObject({ frameType: 'ConsolePanel' })
        const groups = await children(schema.node)
        const hookups = groups.find(item => item.facts.kind === 'hookups')
        const description = groups.find(item => item.facts.label === 'CModelFrameDesc')
        const frameClass = groups.find(item => item.facts.label === 'CFrame')
        if (hookups === undefined || description === undefined || frameClass === undefined) {
          throw new Error('Expected native hookups, description fields and the inherited CFrame class')
        }
        expect((await children(hookups.node)).map(item => item.facts.value)).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'MinimapModel', required: true })]),
        )
        expect(await children(description.node)).toHaveLength(7)
        const properties = (await children(frameClass.node)).map(item => item.facts)
        expect(properties).toEqual(expect.arrayContaining([
          expect.objectContaining({ label: 'Visible', value: expect.objectContaining({ readOnly: true, type: expect.any(String) }) }),
          expect.objectContaining({ label: 'AcceptsMouse', value: expect.objectContaining({
            label: 'Determines if frame can receive mouse events.',
            description: expect.stringContaining('mouse events will propagate'),
          }) }),
        ]))
        // Schema inspection must not advertise a native mutation that this tree cannot perform.
        expect(properties.every(item => item.editable === undefined)).toBe(true)
      } finally {
        await lease.release()
      }
    } finally {
      await session.dispose()
    }
  })

  it('executes every read handler across parse, schema, resolve, render, language and export', async () => {
    const source = fixture('TechTreePanel.SC2Layout')
    const session = await opened(source)
    try {
      expect(await session.operations().invoke('parse', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { includes: ['StandardTemplates.SC2Layout'] } },
      })
      expect(await session.operations().invoke('inspect', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json' },
      })
      for (const handlerId of ['render-structural', 'export-html']) {
        const rendered = await session.operations().invoke(handlerId, {})
        expect(rendered.state).toBe('ok')
        if (rendered.state === 'ok' && rendered.output.kind === 'bytes') {
          expect(decoder.decode(rendered.output.value)).toContain('<!DOCTYPE html>')
        }
      }
      expect(
        await session.operations().invoke('validate', { documents: workspaceDocuments }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            documents: 2,
            schema: { frameTypes: expect.any(Number) },
            diagnostics: expect.any(Array),
          },
        },
      })
      expect(
        await session.operations().invoke('selector-resolve', {
          documents: workspaceDocuments,
          selector: '$parent/NodConstructionYard',
        }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: { selector: '$parent/NodConstructionYard', path: expect.any(Array) },
        },
      })
      expect(
        await session.operations().invoke('resolve', {
          documents: workspaceDocuments,
          rootPath: 'CategoryFrame_Nod',
        }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: { root: { name: 'CategoryFrame_Nod' }, workspaceDocuments: 2 },
        },
      })
      expect(
        await session.operations().invoke('render-visual', {
          documents: workspaceDocuments,
          rootPath: 'CategoryFrame_Nod',
          viewport: { width: 1280, height: 1024 },
        }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            completeness: 'partial',
            fidelity: { sourceDocuments: 2, resolvedFrames: expect.any(Number) },
            displayItems: expect.any(Array),
            html: expect.stringContaining('<!DOCTYPE html>'),
          },
        },
      })
      expect(
        await session.operations().invoke('language-features', {
          documents: workspaceDocuments,
          rootPath: 'CategoryFrame_Nod',
          selector: '$parent/NodConstructionYard',
          completionPrefix: 'Bu',
        }),
      ).toMatchObject({
        state: 'ok',
        output: {
          kind: 'json',
          value: {
            diagnostics: expect.any(Array),
            symbols: [{ name: 'CategoryFrame_Nod' }],
            selector: { path: expect.any(Array) },
          },
        },
      })
      for (const handlerId of [
        'game-template-preview',
        'layout-preview',
        'tech-tree-preview',
      ]) {
        expect(
          await session.operations().invoke(handlerId, {
            documents: workspaceDocuments,
            rootPath: 'CategoryFrame_Nod',
            viewport: { width: 1280, height: 1024 },
          }),
        ).toMatchObject({ state: 'ok', output: { kind: 'json' } })
      }
      const raw = await session.operations().invoke('export-raw', {})
      expect(raw.state).toBe('ok')
      if (raw.state === 'ok' && raw.output.kind === 'bytes') {
        expect(decoder.decode(raw.output.value)).toBe(source)
      }
    } finally {
      await session.dispose()
    }
  })

  it('builds the pinned raw-preserving catalog-reference rename as a native MK3 edit plan', async () => {
    const source =
      '<?xml version="1.0"?><Desc><!--keep--><Frame type="Button" name="Close"><Shortcut val="@Button/Hotkey/Cancel"/></Frame></Desc>'
    const session = await opened(source)
    try {
      const result = await session.operations().invoke('rename-reference', {
        namespace: 'Button',
        oldId: 'Cancel',
        newId: 'Confirm',
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      expect(result.output.plan.fidelity).toMatchObject({
        roundTrip: 'byte-identical',
        preservesUnknownData: true,
      })
      expect(result.output.plan.edits).toHaveLength(1)
      const edit = result.output.plan.edits[0]!
      expect(edit.operation).toBe('replace')
      expect(edit.payload.kind).toBe('inline')
      if (edit.payload.kind === 'inline') {
        const edited = decoder.decode(edit.payload.bytes)
        expect(edited).toContain('<!--keep-->')
        expect(edited).toContain('@Button/Hotkey/Confirm')
      }
    } finally {
      await session.dispose()
    }
  })

  it('returns a committable byte-identical plan when a reference rename is a no-op', async () => {
    const source = '<?xml version="1.0"?><Desc><Frame type="Button" name="Close"/></Desc>'
    const session = await opened(source)
    try {
      const result = await session.operations().invoke('rename-reference', {
        namespace: 'Button',
        oldId: 'Missing',
        newId: 'Confirm',
      })
      expect(result.state).toBe('ok')
      if (result.state !== 'ok' || result.output.kind !== 'edit-plan') return
      expect(result.output.plan.edits).toHaveLength(1)
      expect(result.output.plan.diagnostics).toEqual([
        expect.objectContaining({
          code: 'blizzard/sc2-layout-reference-rename-no-op',
          severity: 'information',
        }),
      ])
      const edit = result.output.plan.edits[0]!
      expect(edit.payload.kind).toBe('inline')
      if (edit.payload.kind === 'inline') expect(decoder.decode(edit.payload.bytes)).toBe(source)
    } finally {
      await session.dispose()
    }
  })
})
