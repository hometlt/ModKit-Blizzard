/**
 * The model the layout preview screens draw: the DescTree, the element view and the drawn text.
 *
 * Everything goes through `view.template`, the operation the generic template stage invokes, with
 * the documents a host snapshot would carry — the layouts a template names, the style sheet and the
 * strings — so what is asserted here is what the stage receives.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isGameTemplateDisplayItem,
  isGameTemplatePreviewResult,
  isGameTemplateTreeNode,
  type GameTemplateTreeNode,
} from '@modkit/sdk/templates'
import { createCodec } from '../codecs/layout/src/codec.js'

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

function inputFor(uri: string, text: string) {
  const bytes = new TextEncoder().encode(text)
  const revision = 'content-hash.sha256:sc2-layout-preview-model'
  const source = {
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
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
        source: source.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: 'sc2-layout-preview-model',
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => undefined }
    },
  }
}

async function preview(uri: string, text: string, input: Record<string, unknown>) {
  const session = await (await createCodec(context)).open(inputFor(uri, text), 'full', budget)
  try {
    const result = await session.operations().invoke('game-template-preview', input as never)
    if (result.state !== 'ok' || result.output.kind !== 'json') {
      throw new Error(`view.template failed: ${JSON.stringify(result)}`)
    }
    const value = result.output.value
    expect(isGameTemplatePreviewResult(value)).toBe(true)
    return value as unknown as {
      roots: readonly string[]
      rootPath: string
      resolvedTree: GameTemplateTreeNode
      displayItems: readonly Record<string, unknown>[]
    }
  } finally {
    await session.dispose()
  }
}

function node(root: GameTemplateTreeNode, ...path: string[]): GameTemplateTreeNode {
  let current = root
  for (const name of path) {
    const next = current.children.find(child => child.name === name)
    if (next === undefined) throw new Error(`missing node ${name}`)
    current = next
  }
  return current
}

const TECH_URI = 'memory://mod/Base.SC2Data/UI/Layout/TechTreePanel.SC2Layout'
const workspace = [
  {
    uri: 'memory://mod/Base.SC2Data/UI/Layout/StandardTemplates.SC2Layout',
    languageId: 'sc2-layout',
    version: 1,
    text: fixture('StandardTemplates.SC2Layout'),
  },
  { uri: TECH_URI, languageId: 'sc2-layout', version: 1, text: fixture('TechTreePanel.SC2Layout') },
]

describe('SC2Layout DescTree and element view model', () => {
  it('names where each node is declared, for Show in Text Editor and Reveal in DescTree (plan 3.33)', async () => {
    const text = '<Desc>\n  <Frame type="Frame" name="Root">\n    <Frame type="Label" name="Child"/>\n  </Frame>\n</Desc>'
    const session = await (await createCodec(context)).open(inputFor(TECH_URI, text), 'full', budget)
    try {
      const result = await session.operations().invoke('game-template-preview', {})
      if (result.state !== 'ok' || result.output.kind !== 'json') throw new Error('SC2Layout preview route failed')
      const root = (result.output.value as unknown as { resolvedTree: GameTemplateTreeNode }).resolvedTree
      const source = (node(root, 'Child') as unknown as { source?: { uri: string; start: number; end: number } }).source
      expect(source?.uri).toBe(TECH_URI)
      expect(text.slice(source!.start, source!.end)).toMatch(/^<Frame type="Label" name="Child"/u)
    } finally {
      await session.dispose()
    }
  })

  it('keeps template and visual routes on the same resolved frame identity', async () => {
    const text = '<Desc><Frame type="Frame" name="Root"><Frame type="Label" name="Child"/></Frame></Desc>'
    const session = await (await createCodec(context)).open(inputFor(TECH_URI, text), 'full', budget)
    try {
      const template = await session.operations().invoke('game-template-preview', {})
      const visual = await session.operations().invoke('render-visual', {})
      if (
        template.state !== 'ok' || template.output.kind !== 'json' ||
        visual.state !== 'ok' || visual.output.kind !== 'json'
      ) throw new Error('SC2Layout preview route failed')
      const templateRoot = (template.output.value as { resolvedTree: { path: string[] } }).resolvedTree
      const visualRoot = (visual.output.value as { resolvedTree: { path: string[] } }).resolvedTree
      expect(templateRoot.path).toEqual(visualRoot.path)
    } finally {
      await session.dispose()
    }
  })

  it('projects full-engine template overrides and state results without re-resolving them', async () => {
    const text = fixture('TechTreePanel.SC2Layout')
    const session = await (await createCodec(context)).open(inputFor(TECH_URI, text), 'full', budget)
    const input = {
      documents: workspace,
      workspaceDocuments: workspace,
      rootPath: 'CategoryFrame_Nod',
      states: { Mode: 'Hidden' },
    }
    try {
      const template = await session.operations().invoke('game-template-preview', input)
      const visual = await session.operations().invoke('render-visual', input)
      if (
        template.state !== 'ok' || template.output.kind !== 'json' ||
        visual.state !== 'ok' || visual.output.kind !== 'json'
      ) throw new Error('SC2Layout preview route failed')
      const projected = template.output.value as {
        resolvedTree: GameTemplateTreeNode
        displayItems: readonly Record<string, unknown>[]
        diagnostics: Array<{ code: string }>
      }
      const rendered = visual.output.value as {
        resolvedTree: { children: Array<{ name: string; properties: Array<{ tag: string; val?: string; source: { contribution: { origin: string } } }> }> }
        displayItems: Array<{ descPath: string[]; visible: boolean }>
        diagnostics: Array<{ code: string }>
      }
      const projectedYard = node(projected.resolvedTree, 'NodConstructionYard')
      const renderedYard = rendered.resolvedTree.children.find(item => item.name === 'NodConstructionYard')
      const projectedWidth = projectedYard.properties?.find(item => item.name === 'Width')
      const renderedWidth = renderedYard?.properties.find(item => item.tag === 'Width')
      expect(projectedWidth?.val).toBe(renderedWidth?.val)
      expect(projectedWidth?.source?.origin).toBe(renderedWidth?.source.contribution.origin)
      expect(
        projected.displayItems.find(item => (item['path'] as string[]).at(-1) === 'NodConstructionYard')?.['visible'],
      ).toBe(
        rendered.displayItems.find(item => item.descPath.at(-1) === 'NodConstructionYard')?.visible,
      )
      expect(projected.diagnostics.map(item => item.code)).toEqual(
        rendered.diagnostics.map(item => item.code),
      )
    } finally {
      await session.dispose()
    }
  })

  it('lists the resolved hierarchy with type, name and template link', async () => {
    const result = await preview(TECH_URI, fixture('TechTreePanel.SC2Layout'), {
      workspaceDocuments: workspace,
    })
    const tree = result.resolvedTree
    expect(isGameTemplateTreeNode(tree)).toBe(true)
    expect(result.roots).toEqual(['CategoryFrame_Nod'])
    expect(tree).toMatchObject({
      name: 'CategoryFrame_Nod',
      type: 'Panel',
      path: ['CategoryFrame_Nod'],
    })
    const yard = node(tree, 'NodConstructionYard')
    expect(yard).toMatchObject({
      type: 'Image',
      template: 'StandardTemplates/TechItemTemplate',
      path: ['CategoryFrame_Nod', 'NodConstructionYard'],
    })
    // The template's children are part of the resolved tree, attributed to the template.
    const icon = node(yard, 'BuildingIconBackgroundImage')
    expect(icon.path).toEqual([
      'CategoryFrame_Nod',
      'NodConstructionYard',
      'BuildingIconBackgroundImage',
    ])
    // Every drawn item is a tree node by the same path, so a selection can cross between them.
    const keys = new Set<string>()
    const visit = (item: GameTemplateTreeNode): void => {
      keys.add(item.path.join('/'))
      item.children.forEach(visit)
    }
    visit(tree)
    const drawn = result.displayItems.map(item => (item['path'] as string[]).join('/'))
    for (const item of result.displayItems) expect(isGameTemplateDisplayItem(item)).toBe(true)
    expect(drawn.every(key => keys.has(key))).toBe(true)
    // Six frames share one template; each of their icons is its own node.
    expect(new Set(drawn).size).toBe(drawn.length)
  })

  it('explains each property with its resolved value and the template it came from', async () => {
    const result = await preview(TECH_URI, fixture('TechTreePanel.SC2Layout'), {
      workspaceDocuments: workspace,
    })
    const yard = node(result.resolvedTree, 'NodConstructionYard')
    const width = yard.properties?.find(item => item.name === 'Width')
    expect(width).toMatchObject({
      val: '#ItemSize',
      resolved: '64',
      source: {
        origin: 'template',
        frame: 'StandardTemplates/TechItemTemplate',
        uri: workspace[0]?.uri,
      },
    })
    const left = yard.anchors?.find(item => item.side === 'Left')
    expect(left).toMatchObject({
      relative: '$parent',
      pos: 'Min',
      offset: '20',
      source: { origin: 'own', uri: TECH_URI },
    })
    const icon = node(yard, 'BuildingIconBackgroundImage')
    expect(icon.properties?.find(item => item.name === 'Texture')).toMatchObject({
      val: 'Assets/Textures/tech-icon.dds',
      source: {
        origin: 'template',
        frame: 'StandardTemplates/TechItemTemplate/BuildingIconBackgroundImage',
      },
    })
  })

  it('draws text through the snapshot strings and style sheet, and offers every root', async () => {
    const uri = 'memory://mod/Base.SC2Data/UI/Layout/Labels.SC2Layout'
    const text = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="Dialog">
    <Width val="400"/>
    <Height val="200"/>
    <Frame type="Label" name="Title">
      <Anchor side="Top" relative="$parent" pos="Min" offset="10"/>
      <Anchor side="Left" relative="$parent" pos="Min" offset="10"/>
      <Width val="300"/>
      <Height val="40"/>
      <Style val="@TitleStyle"/>
      <Text val="@UI/Dialog/Title"/>
    </Frame>
    <Frame type="Label" name="Missing">
      <Text val="@UI/Nowhere"/>
    </Frame>
  </Frame>
  <Frame type="Frame" name="Other"/>
</Desc>`
    const documents = [
      { uri, languageId: 'sc2-layout', version: 1, text },
      {
        uri: 'memory://mod/Base.SC2Data/UI/FontStyles.SC2Style',
        languageId: 'sc2-style',
        version: 1,
        text: `<?xml version="1.0" encoding="utf-8"?>
<StyleFile>
  <Constant name="ColorGold" val="ffd700"/>
  <Style name="BaseStyle" font="Fonts/Eurostile.otf" height="18" styleflags="Bold"/>
  <Style name="TitleStyle" template="BaseStyle" textcolor="#ColorGold" height="24"/>
</StyleFile>`,
      },
      {
        uri: 'memory://mod/enUS.SC2Data/LocalizedData/GameStrings.txt',
        languageId: 'sc2-strings',
        version: 1,
        text: 'UI/Dialog/Title=Nydus <c val="ff0000">Canal</c>\n',
      },
    ]
    const result = await preview(uri, text, { workspaceDocuments: documents })
    expect(result.roots).toEqual(['Dialog', 'Other'])
    const title = result.displayItems.find(item => (item['path'] as string[]).at(-1) === 'Title')
    expect(title).toMatchObject({
      kind: 'text',
      text: [
        { text: 'Nydus ', color: '#ffd700', bold: true, size: 24 },
        { text: 'Canal', color: '#ff0000', bold: true, size: 24 },
      ],
    })
    expect(
      node(result.resolvedTree, 'Title').properties?.find(item => item.name === 'Text'),
    ).toMatchObject({
      val: '@UI/Dialog/Title',
      resolved: 'Nydus <c val="ff0000">Canal</c>',
    })
    // A key the snapshot does not hold is drawn as written.
    const missing = result.displayItems.find(
      item => (item['path'] as string[]).at(-1) === 'Missing',
    )
    expect(missing).toMatchObject({ text: [{ text: '@UI/Nowhere' }] })

    const other = await preview(uri, text, { workspaceDocuments: documents, rootPath: 'Other' })
    expect(other.rootPath).toBe('Other')
    expect(other.resolvedTree.name).toBe('Other')
  })
})
