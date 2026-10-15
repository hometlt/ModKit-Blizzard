import { describe, it, expect, beforeAll } from 'vitest'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { applyStateGroups } from '../../../../shared/format/rendering/states/apply.js'
import { createTestRegistry } from '../repo-root.js'

let schema: SchemaRegistry
beforeAll(() => {
  schema = createTestRegistry()
})

function store(xml: string): Store {
  const s = new Store(schema)
  s.updateDocument('file:///S.SC2Layout', xml)
  return s
}

// Mirrors GameUI's ControlGroupPanel/AlignmentRatioCheck: a conditional state
// with a When, and an unconditional default that re-anchors otherwise.
const ALIGN_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="Root">
    <Frame type="Frame" name="Panel">
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
      <StateGroup name="AlignmentRatioCheck">
        <DefaultState val="CenterAligned"/>
        <State name="LeftAligned">
          <When type="Property" frame="$this" WideAspect="True"/>
          <Action type="SetAnchor" frame="$this" side="Left" relative="$parent" pos="Max" offset="0"/>
          <Action type="SetProperty" frame="$this" Tag="left"/>
        </State>
        <State name="CenterAligned">
          <Action type="SetAnchor" frame="$this" side="Left" relative="$parent" pos="Mid" offset="-10"/>
          <Action type="SetProperty" frame="$this" Tag="center"/>
        </State>
      </StateGroup>
    </Frame>
  </Frame>
</Desc>`

describe('applyStateGroups — state selection & actions', () => {
  it('captures StateGroups on the resolved frame', () => {
    const panel = resolveFrameByPath(store(ALIGN_XML), 'S/Root/Panel')!
    expect(panel.stateGroups).toHaveLength(1)
    const sg = panel.stateGroups[0]!
    expect(sg.name).toBe('AlignmentRatioCheck')
    expect(sg.defaultState).toBe('CenterAligned')
    expect(sg.states.map(s => s.name)).toEqual(['LeftAligned', 'CenterAligned'])
    // Attribute NAMES are lower-cased by the XML scanner (values keep case).
    expect(sg.states[0]!.whens[0]).toMatchObject({
      type: 'Property',
      props: { wideaspect: 'True' },
    })
    expect(sg.states[0]!.actions.map(a => a.kind)).toEqual(['setAnchor', 'setProperty'])
  })

  it('falls back to the DefaultState when no When matches', () => {
    const root = resolveFrameByPath(store(ALIGN_XML), 'S/Root')!
    const res = applyStateGroups(root, { stateInputs: {}, index: store(ALIGN_XML).index })
    const panel = getResolvedDescendant(root, ['Panel'])!
    expect(res.active.get('Root/Panel#AlignmentRatioCheck')).toBe('CenterAligned')
    expect(panel.anchors.Left?.pos).toBe('Mid')
    expect(panel.anchors.Left?.offset).toBe('-10')
    expect(panel.properties.get('tag')?.val).toBe('center')
  })

  it('activates the conditional state when its When input matches, overriding the base anchor', () => {
    const s = store(ALIGN_XML)
    const root = resolveFrameByPath(s, 'S/Root')!
    const res = applyStateGroups(root, { stateInputs: { WideAspect: 'True' }, index: s.index })
    const panel = getResolvedDescendant(root, ['Panel'])!
    expect(res.active.get('Root/Panel#AlignmentRatioCheck')).toBe('LeftAligned')
    expect(panel.anchors.Left?.pos).toBe('Max') // re-anchored by SetAnchor
    expect(panel.properties.get('tag')?.val).toBe('left')
    // The applied anchor records provenance as 'state'.
    expect(panel.anchors.Left?.source.contribution.origin).toBe('state')
  })
})

// Mirrors ConsolePanel/ConsoleSkinState: CreateFromTemplate attaches a skin subtree.
const SKIN_XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="SkinTpl">
    <Frame type="Image" name="Border"><Texture val="border.dds"/></Frame>
  </Frame>
  <Frame type="Frame" name="Root">
    <Frame type="Frame" name="Console">
      <StateGroup name="ConsoleSkinState">
        <State name="Forged">
          <When type="Property" frame="$this" CurrentConsoleSkin="Forged"/>
          <Action type="CreateFromTemplate" frame="$this" template="S/SkinTpl"/>
        </State>
      </StateGroup>
    </Frame>
  </Frame>
</Desc>`

describe('applyStateGroups — CreateFromTemplate', () => {
  it('attaches the skin template subtree when the skin input matches', () => {
    const s = store(SKIN_XML)
    const root = resolveFrameByPath(s, 'S/Root')!
    const console = getResolvedDescendant(root, ['Console'])!
    expect(console.children).toHaveLength(0)

    applyStateGroups(root, { stateInputs: { CurrentConsoleSkin: 'Forged' }, index: s.index })

    expect(console.children.map(c => c.name)).toEqual(['SkinTpl'])
    const border = getResolvedDescendant(root, ['Console', 'SkinTpl', 'Border'])!
    expect(border.properties.get('texture')?.val).toBe('border.dds')
    expect(border.path).toEqual(['Root', 'Console', 'SkinTpl', 'Border']) // rebased
  })

  it('attaches nothing when the skin input does not match (no default)', () => {
    const s = store(SKIN_XML)
    const root = resolveFrameByPath(s, 'S/Root')!
    const res = applyStateGroups(root, {
      stateInputs: { CurrentConsoleSkin: 'Other' },
      index: s.index,
    })
    expect(getResolvedDescendant(root, ['Console'])!.children).toHaveLength(0)
    expect(res.diagnostics.some(d => d.code === 'no-state-matched')).toBe(true)
  })

  it('reports an unresolved template as a diagnostic', () => {
    const xml = SKIN_XML.replace('template="S/SkinTpl"', 'template="S/Missing"')
    const s = store(xml)
    const root = resolveFrameByPath(s, 'S/Root')!
    const res = applyStateGroups(root, {
      stateInputs: { CurrentConsoleSkin: 'Forged' },
      index: s.index,
    })
    expect(res.diagnostics.some(d => d.code === 'unresolved-template')).toBe(true)
  })
})
