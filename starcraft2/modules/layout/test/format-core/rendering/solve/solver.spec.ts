import { describe, it, expect, beforeAll } from 'vitest'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import {
  resolveFrameByPath,
  getResolvedDescendant,
} from '../../../../shared/format/rendering/resolve/resolve.js'
import { resolvePropertyValue } from '../../../../shared/format/rendering/resolve/constants.js'
import { solveLayout } from '../../../../shared/format/rendering/solve/solver.js'
import type { ResolvedFrame } from '../../../../shared/format/rendering/resolve/types.js'
import { createTestRegistry } from '../repo-root.js'

let schema: SchemaRegistry
beforeAll(() => {
  schema = createTestRegistry()
})

function resolve(xml: string, framePath: string): { frame: ResolvedFrame; store: Store } {
  const store = new Store(schema)
  store.updateDocument('file:///T.SC2Layout', xml)
  const frame = resolveFrameByPath(store, framePath)!
  return { frame, store }
}

function rectOf(result: ReturnType<typeof solveLayout>, frame: ResolvedFrame | undefined) {
  return frame ? result.rects.get(frame) : undefined
}

describe('solveLayout closure rules', () => {
  const XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="Root">
    <Frame type="Frame" name="Fill"><Anchor relative="$parent"/></Frame>
    <Frame type="Frame" name="Sized"><Width val="100"/><Height val="40"/></Frame>
    <Frame type="Frame" name="MinPlusSize">
      <Anchor side="Left" relative="$parent" pos="Min" offset="10"/>
      <Anchor side="Top" relative="$parent" pos="Min" offset="20"/>
      <Width val="50"/><Height val="30"/>
    </Frame>
    <Frame type="Frame" name="MaxPlusSize">
      <Anchor side="Right" relative="$parent" pos="Max" offset="-10"/>
      <Width val="50"/>
    </Frame>
    <Frame type="Frame" name="BothEdges">
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
      <Anchor side="Right" relative="$parent" pos="Max" offset="0"/>
      <Width val="100"/>
    </Frame>
    <Frame type="Frame" name="Centered">
      <Anchor side="Left" relative="$parent" pos="Mid" offset="-100"/>
      <Anchor side="Right" relative="$parent" pos="Mid" offset="100"/>
    </Frame>
  </Frame>
</Desc>`

  it('fills the parent when a side-less anchor is used', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 800, height: 600 } })
    expect(rectOf(r, getResolvedDescendant(frame, ['Fill']))).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })
  })

  it('positions a size-only frame at the parent min', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 800, height: 600 } })
    expect(rectOf(r, getResolvedDescendant(frame, ['Sized']))).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    })
  })

  it('derives the far edge from one anchor plus size (min and max forms)', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 800, height: 600 } })
    expect(rectOf(r, getResolvedDescendant(frame, ['MinPlusSize']))).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 30,
    })
    const maxPlus = rectOf(r, getResolvedDescendant(frame, ['MaxPlusSize']))!
    expect(maxPlus.x).toBe(800 - 10 - 50) // right = 790, left = 740
    expect(maxPlus.width).toBe(50)
  })

  it('centers an explicit Width within a both-edge anchored span (SC2 tutorial rule)', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 800, height: 600 } })
    const both = rectOf(r, getResolvedDescendant(frame, ['BothEdges']))!
    expect(both.width).toBe(100) // Width honored, not stretched to 800
    expect(both.x).toBe(350) // centered in the 0..800 span → (400 - 50)
  })

  it('centers via Mid-pos anchors on both edges', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 800, height: 600 } })
    const c = rectOf(r, getResolvedDescendant(frame, ['Centered']))!
    expect(c.x).toBe(300) // 400 - 100
    expect(c.width).toBe(200)
  })
})

describe('solveLayout cross-frame references', () => {
  const XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Frame type="Frame" name="Root">
    <Frame type="Frame" name="A">
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
      <Anchor side="Top" relative="$parent" pos="Min" offset="0"/>
      <Width val="60"/><Height val="30"/>
    </Frame>
    <Frame type="Frame" name="B">
      <Anchor side="Top" relative="$parent/A" pos="Min" offset="0"/>
      <Anchor side="Left" relative="$parent/A" pos="Max" offset="5"/>
      <Width val="60"/><Height val="30"/>
    </Frame>
    <Frame type="Frame" name="Line">
      <Anchor side="Left" relative="$parent/A" pos="Mid" offset="0"/>
      <Anchor side="Right" relative="$parent/B" pos="Mid" offset="0"/>
      <Anchor side="Top" relative="$parent/A" pos="Max" offset="0"/>
      <Height val="2"/>
    </Frame>
  </Frame>
</Desc>`

  it('chains sibling anchors (B follows A) regardless of declaration order', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
    expect(rectOf(r, getResolvedDescendant(frame, ['B']))).toEqual({
      x: 65,
      y: 0,
      width: 60,
      height: 30,
    })
  })

  it('spans a connector line between two siblings’ midpoints (the LineH pattern)', () => {
    const { frame } = resolve(XML, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
    const line = rectOf(r, getResolvedDescendant(frame, ['Line']))!
    expect(line.x).toBe(30) // A mid-x = 30
    expect(line.x + line.width).toBe(95) // B mid-x = 65 + 30
    expect(line.y).toBe(30) // A max-y
    expect(line.height).toBe(2)
  })

  it('resolves $ancestor by name', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root"><Frame type="Frame" name="Mid"><Frame type="Frame" name="Leaf">
      <Anchor side="Left" relative="$ancestor[@name=Root]" pos="Min" offset="7"/>
      <Width val="10"/><Height val="10"/>
    </Frame></Frame></Frame></Desc>`
    const { frame } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
    expect(rectOf(r, getResolvedDescendant(frame, ['Mid', 'Leaf']))!.x).toBe(7)
  })
})

describe('solveLayout robustness', () => {
  it('reports an anchor cycle and still terminates with a fallback', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root">
  <Frame type="Frame" name="A"><Anchor side="Left" relative="$parent/B" pos="Min" offset="0"/><Width val="10"/></Frame>
  <Frame type="Frame" name="B"><Anchor side="Left" relative="$parent/A" pos="Min" offset="0"/><Width val="10"/></Frame>
</Frame></Desc>`
    const { frame } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
    expect(r.diagnostics.some(d => d.code === 'anchor-cycle')).toBe(true)
    expect(r.rects.size).toBeGreaterThan(0) // did not hang or throw
  })

  it('resolves a $-selector in a NON-leading path segment', () => {
    // The base-game tech tree wraps its arrows in a TechTreeConnectorFrame and reaches
    // back out to the category's structures with `$parent/$parent/<Frame>/...`.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root">
  <Frame type="Frame" name="Target">
    <Anchor side="Top" relative="$parent" pos="Min" offset="40"/><Height val="20"/>
  </Frame>
  <Frame type="Frame" name="Connector">
    <Anchor relative="$parent"/>
    <Frame type="Frame" name="Arrow">
      <Anchor side="Top" relative="$parent/$parent/Target" pos="Max" offset="0"/>
      <Height val="10"/>
    </Frame>
  </Frame>
</Frame></Desc>`
    const { frame } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 600 } })
    const arrow = rectOf(r, getResolvedDescendant(frame, ['Connector', 'Arrow']))!
    expect(arrow.y).toBe(60) // Target.Max = 40 + 20
    expect(arrow.height).toBe(10)
    expect(r.diagnostics.some(d => d.code === 'unresolved-ref')).toBe(false)
  })

  it('ignores an anchor that refers to the anchored frame itself', () => {
    // Real layouts contain these: the tech-tree `UnitListContainerFrame` anchors its
    // Bottom to `$parent/UnitListContainerFrame`. Treating that as a real edge gives the
    // frame a both-edges closure, and with an explicit Height it then gets CENTRED on a
    // bogus span — moving it half its own height off. The engine ignores such an anchor,
    // so the frame must behave exactly as if only Top were anchored.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root">
  <Frame type="Frame" name="Head">
    <Anchor side="Top" relative="$parent" pos="Min" offset="0"/><Height val="50"/>
  </Frame>
  <Frame type="Frame" name="List">
    <Anchor side="Top" relative="$parent/Head" pos="Max" offset="0"/>
    <Anchor side="Bottom" relative="$parent/List" pos="Max" offset="0"/>
    <Height val="300"/>
  </Frame>
</Frame></Desc>`
    const { frame } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 600 } })
    const list = rectOf(r, getResolvedDescendant(frame, ['List']))!
    expect(list.y).toBe(50) // starts at Head's Max, NOT centred on it
    expect(list.height).toBe(300)
    expect(r.diagnostics.some(d => d.code === 'self-anchor')).toBe(true)
    expect(r.diagnostics.some(d => d.code === 'anchor-cycle')).toBe(false)
  })

  it('flags an unresolved relative frame reference', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root"><Frame type="Frame" name="A">
      <Anchor side="Left" relative="$parent/Ghost" pos="Min" offset="0"/><Width val="10"/><Height val="10"/>
    </Frame></Frame></Desc>`
    const { frame } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
    expect(r.diagnostics.some(d => d.code === 'unresolved-ref')).toBe(true)
  })

  it('resolves #-constants in offsets and sizes via resolveValue', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Constant name="Gap" val="15"/>
  <Frame type="Frame" name="Root"><Frame type="Frame" name="A">
    <Anchor side="Left" relative="$parent" pos="Min" offset="#Gap"/>
    <Width val="#Gap"/><Height val="10"/>
  </Frame></Frame></Desc>`
    const { frame, store } = resolve(xml, 'T/Root')
    const r = solveLayout(frame, {
      rootRect: { x: 0, y: 0, width: 400, height: 200 },
      resolveValue: raw => {
        const v = resolvePropertyValue(store.index, raw)
        return v == null ? undefined : Number.parseFloat(v)
      },
    })
    const a = rectOf(r, getResolvedDescendant(frame, ['A']))!
    expect(a.x).toBe(15)
    expect(a.width).toBe(15)
    expect(r.diagnostics).toHaveLength(0)
  })

  it('is order-independent: shuffling siblings yields identical rects', () => {
    const base = (order: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<Desc><Frame type="Frame" name="Root">${order.map(n => frames[n]).join('')}</Frame></Desc>`
    const frames: Record<string, string> = {
      A: `<Frame type="Frame" name="A"><Anchor side="Left" relative="$parent" pos="Min" offset="0"/><Anchor side="Top" relative="$parent" pos="Min" offset="0"/><Width val="20"/><Height val="20"/></Frame>`,
      B: `<Frame type="Frame" name="B"><Anchor side="Left" relative="$parent/A" pos="Max" offset="4"/><Anchor side="Top" relative="$parent/A" pos="Min" offset="0"/><Width val="20"/><Height val="20"/></Frame>`,
    }
    const solveB = (order: string[]) => {
      const store = new Store(schema)
      store.updateDocument('file:///O.SC2Layout', base(order))
      const root = resolveFrameByPath(store, 'O/Root')!
      const r = solveLayout(root, { rootRect: { x: 0, y: 0, width: 400, height: 200 } })
      return r.rects.get(getResolvedDescendant(root, ['B'])!)
    }
    expect(solveB(['A', 'B'])).toEqual(solveB(['B', 'A']))
  })
})
