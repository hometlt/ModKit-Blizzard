import { describe, it, expect, beforeAll } from 'vitest'
import * as path from 'node:path'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { resolveConstant, resolvePropertyValue } from '../../../../shared/format/rendering/resolve/constants.js'
import { createTestRegistry } from '../repo-root.js'

let schema: SchemaRegistry
beforeAll(() => {
  schema = createTestRegistry()
})

const TPL_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Frame type="Frame" name="BaseTpl">
        <Width val="100"/>
        <Height val="50"/>
        <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
        <Frame type="Image" name="Icon">
            <Texture val="a.dds"/>
            <Width val="32"/>
        </Frame>
    </Frame>
    <Frame type="Frame" name="MidTpl" template="Tpl/BaseTpl">
        <Width val="200"/>
        <Frame type="Image" name="Icon">
            <Texture val="b.dds"/>
        </Frame>
    </Frame>
</Desc>`

const MAIN_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Constant name="Gap" val="5"/>
    <Constant name="Indirect" val="#Gap"/>
    <Frame type="Frame" name="Panel">
        <Anchor relative="$parent"/>
        <Frame type="Frame" name="Instance" template="Tpl/MidTpl">
            <Height val="75"/>
            <Anchor side="Top" relative="$parent" pos="Min" offset="#Gap"/>
            <Frame type="Label" name="Extra"/>
        </Frame>
    </Frame>
</Desc>`

const EXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Frame type="Frame" name="Panel/Instance" file="Main">
        <Width val="300"/>
    </Frame>
</Desc>`

function makeStore(docs: Record<string, string>): Store {
  const store = new Store(schema)
  for (const [name, text] of Object.entries(docs)) {
    store.updateDocument(`file:///fixture/${name}.SC2Layout`, text)
  }
  return store
}

describe('resolveFrameByPath', () => {
  it('merges the template chain weakest-first with own overrides', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!

    expect(frame.contributions.map(c => `${c.origin}:${c.descFqn}`)).toEqual([
      'template:Tpl/BaseTpl',
      'template:Tpl/MidTpl',
      'own:Main/Panel/Instance',
    ])
    // Width: BaseTpl 100 → MidTpl 200 (own declares none)
    expect(frame.properties.get('width')?.val).toBe('200')
    expect(frame.properties.get('width')?.overridden.map(p => p.val)).toEqual(['100'])
    // Height: BaseTpl 50 → own 75
    expect(frame.properties.get('height')?.val).toBe('75')
    expect(frame.properties.get('height')?.source.contribution.origin).toBe('own')
  })

  it('merges anchors per side (template Left coexists with own Top)', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!

    expect(frame.anchors.Left?.relative).toBe('$parent')
    expect(frame.anchors.Left?.source.contribution.origin).toBe('template')
    expect(frame.anchors.Top?.offset).toBe('#Gap')
    expect(frame.anchors.Top?.source.contribution.origin).toBe('own')
    expect(frame.anchors.Right).toBeUndefined()
  })

  it('expands a side-less anchor to all four sides', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    const panel = resolveFrameByPath(store, 'Main/Panel')!
    for (const side of ['Left', 'Top', 'Right', 'Bottom'] as const) {
      expect(panel.anchors[side]?.implicitSide).toBe(true)
      expect(panel.anchors[side]?.relative).toBe('$parent')
    }
  })

  it('merges children by name across contributions, template children first', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!

    expect(frame.children.map(c => c.name)).toEqual(['Icon', 'Extra'])
    const icon = frame.children[0]!
    expect(icon.type).toBe('Image')
    expect(icon.path).toEqual(['Instance', 'Icon'])
    // Texture: BaseTpl a.dds → MidTpl b.dds; Width 32 survives from BaseTpl
    expect(icon.properties.get('texture')?.val).toBe('b.dds')
    expect(icon.properties.get('texture')?.overridden.map(p => p.val)).toEqual(['a.dds'])
    expect(icon.properties.get('width')?.val).toBe('32')
  })

  it('applies file= hookup extensions as the strongest contribution', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML, Ext: EXT_XML })
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!

    expect(frame.contributions.at(-1)?.origin).toBe('hookup')
    expect(frame.properties.get('width')?.val).toBe('300')
    expect(frame.properties.get('width')?.overridden.map(p => p.val)).toEqual(['100', '200'])
  })

  it('reports missing templates as diagnostics and keeps resolving', () => {
    const store = makeStore({ Main: MAIN_XML }) // Tpl file absent
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!

    expect(frame.diagnostics.some(d => d.code === 'missing-template')).toBe(true)
    expect(frame.properties.get('height')?.val).toBe('75') // own props still merged
    expect(frame.children.map(c => c.name)).toEqual(['Extra'])
  })

  it('records source attribution (uri + element range) for merged values', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    const frame = resolveFrameByPath(store, 'Main/Panel/Instance')!
    const width = frame.properties.get('width')!

    expect(width.source.uri).toBe('file:///fixture/Tpl.SC2Layout')
    expect(TPL_XML.slice(width.source.start, width.source.start + 18)).toBe('<Width val="200"/>')
  })

  it('returns undefined for non-frame paths', () => {
    const store = makeStore({ Tpl: TPL_XML, Main: MAIN_XML })
    expect(resolveFrameByPath(store, 'Main/Nope')).toBeUndefined()
    expect(resolveFrameByPath(store, 'Main')).toBeUndefined() // file desc, not a frame
  })
})

// Runtime-path hookups: a `file=` extension can target — and even create — a
// frame that only exists at runtime because an intermediate frame came from a
// template (the pattern the tech-tree fixture uses to attach into
// GameUI/…/HelpMenuDialogGame/PanelFrame/TechTreePanel).
const DLG_TPL_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Frame type="Frame" name="DialogTpl">
        <Frame type="Frame" name="PanelFrame">
            <Width val="10"/>
        </Frame>
    </Frame>
</Desc>`

const DLG_BASE_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Frame type="Frame" name="Dialog" template="DlgTpl/DialogTpl"/>
</Desc>`

// Extends a runtime path (Dialog/PanelFrame) whose PanelFrame is template-created,
// and creates a brand-new child (Content) that exists in no base declaration.
const DLG_EXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
    <Frame type="Frame" name="Dialog/PanelFrame" file="DlgBase">
        <Height val="20"/>
    </Frame>
    <Frame type="TechTreePanel" name="Dialog/PanelFrame/Content" file="DlgBase">
        <Width val="99"/>
    </Frame>
</Desc>`

describe('runtime-path hookups', () => {
  it('attaches a hookup onto a template-created intermediate frame and creates new children', () => {
    const store = makeStore({ DlgTpl: DLG_TPL_XML, DlgBase: DLG_BASE_XML, DlgExt: DLG_EXT_XML })
    const dialog = resolveFrameByPath(store, 'DlgBase/Dialog')!

    const panel = getResolvedDescendant(dialog, ['PanelFrame'])!
    expect(panel).toBeDefined()
    // template Width 10 survives; hookup adds Height 20
    expect(panel.properties.get('width')?.val).toBe('10')
    expect(panel.properties.get('height')?.val).toBe('20')
    expect(panel.contributions.map(c => c.origin)).toContain('hookup')

    // Content exists only because the hookup created it under the runtime path.
    const content = getResolvedDescendant(dialog, ['PanelFrame', 'Content'])!
    expect(content).toBeDefined()
    expect(content.type).toBe('TechTreePanel')
    expect(content.path).toEqual(['Dialog', 'PanelFrame', 'Content'])
    expect(content.properties.get('width')?.val).toBe('99')
  })
})

describe('resolveConstant', () => {
  it('resolves direct and chained constants', () => {
    const store = makeStore({ Main: MAIN_XML })
    expect(resolveConstant(store.index, '#Gap')).toEqual({ value: '5', chain: ['Gap'] })
    expect(resolveConstant(store.index, '#Indirect')).toEqual({
      value: '5',
      chain: ['Indirect', 'Gap'],
    })
  })

  it('reports missing constants with the failing name', () => {
    const store = makeStore({ Main: MAIN_XML })
    expect(resolveConstant(store.index, '#Nope')).toEqual({ chain: ['Nope'], missing: 'Nope' })
  })

  it('passes through non-constant values', () => {
    const store = makeStore({ Main: MAIN_XML })
    expect(resolveConstant(store.index, '12')).toBeUndefined()
    expect(resolvePropertyValue(store.index, '12')).toBe('12')
    expect(resolvePropertyValue(store.index, '#Gap')).toBe('5')
    expect(resolvePropertyValue(store.index, '#Nope')).toBeUndefined()
  })
})
