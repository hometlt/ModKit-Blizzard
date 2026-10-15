import { describe, it, expect, beforeAll } from 'vitest'
import { Store } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import type { SchemaRegistry } from '../../../../shared/layout-engine/sc2-layout-core/core.js'
import { resolveFrameByPath } from '../../../../shared/format/rendering/resolve/resolve.js'
import { resolvePropertyValue } from '../../../../shared/format/rendering/resolve/constants.js'
import { solveLayout } from '../../../../shared/format/rendering/solve/solver.js'
import { buildDisplayList } from '../../../../shared/format/rendering/model/build.js'
import { emitHtml } from '../../../../shared/format/rendering/emit/html.js'
import type { ImageItem, TextItem, BoxItem } from '../../../../shared/format/rendering/model/display.js'
import { createTestRegistry } from '../repo-root.js'

let schema: SchemaRegistry
beforeAll(() => {
  schema = createTestRegistry()
})

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Desc>
  <Constant name="Line" val="255,0,0"/>
  <Frame type="Frame" name="Root">
    <Frame type="Image" name="Plate" template=""><Anchor relative="$parent"/>
      <Texture val="@UI/Plate_Crimson"/><TextureType val="Normal"/><RenderPriority val="1"/>
    </Frame>
    <Frame type="Image" name="Line">
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
      <Anchor side="Top" relative="$parent" pos="Min" offset="0"/>
      <Width val="100"/><Height val="2"/>
      <LayerColor val="#Line"/><RenderPriority val="0"/>
    </Frame>
    <Frame type="Label" name="Title">
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/>
      <Anchor side="Top" relative="$parent" pos="Min" offset="0"/>
      <Width val="80"/><Height val="20"/>
      <Text val="@Unit/Name/Foo"/><Style val="TitleStyle"/>
    </Frame>
    <Frame type="Frame" name="Hidden"><Visible val="false"/><Width val="10"/><Height val="10"/>
      <Anchor side="Left" relative="$parent" pos="Min" offset="0"/><Anchor side="Top" relative="$parent" pos="Min" offset="0"/>
    </Frame>
  </Frame>
</Desc>`

function build(includeHidden = false) {
  const store = new Store(schema)
  store.updateDocument('file:///M.SC2Layout', XML)
  const root = resolveFrameByPath(store, 'M/Root')!
  const solve = solveLayout(root, {
    rootRect: { x: 0, y: 0, width: 400, height: 300 },
    resolveValue: raw => {
      const v = resolvePropertyValue(store.index, raw)
      return v == null ? undefined : Number.parseFloat(v)
    },
  })
  const list = buildDisplayList(root, solve, {
    includeHidden,
    resolveValue: raw => resolvePropertyValue(store.index, raw),
  })
  return { list, root }
}

describe('buildDisplayList', () => {
  it('maps frame types to item kinds', () => {
    const { list } = build()
    const byPath = new Map(list.items.map(i => [i.descPath.join('/'), i]))
    expect(byPath.get('Root/Plate')?.kind).toBe('image')
    expect(byPath.get('Root/Line')?.kind).toBe('image')
    expect(byPath.get('Root/Title')?.kind).toBe('text')
    expect(byPath.get('Root')?.kind).toBe('box')
  })

  it('emits assets as ids and tints as parsed colours', () => {
    const { list } = build()
    const plate = list.items.find(i => i.descPath.join('/') === 'Root/Plate') as ImageItem
    expect(plate.asset).toEqual({ kind: 'alias', value: 'UI/Plate_Crimson' })
    expect(plate.textureType).toBe('Normal')

    const line = list.items.find(i => i.descPath.join('/') === 'Root/Line') as ImageItem
    expect(line.asset).toBeUndefined() // pure tint, no texture
    expect(line.tint).toEqual({ r: 255, g: 0, b: 0, a: 1 }) // #Line constant resolved
  })

  it('emits text/style as ids, deferring resolution', () => {
    const { list } = build()
    const title = list.items.find(i => i.descPath.join('/') === 'Root/Title') as TextItem
    expect(title.text).toBe('@Unit/Name/Foo')
    expect(title.styleRef).toBe('TitleStyle')
  })

  it('orders siblings back-to-front by RenderPriority then declaration order', () => {
    const { list } = build()
    const order = list.items.map(i => i.descPath.join('/'))
    // Root first (parent), then Line (priority 0) before Plate (priority 1).
    expect(order.indexOf('Root')).toBeLessThan(order.indexOf('Root/Line'))
    expect(order.indexOf('Root/Line')).toBeLessThan(order.indexOf('Root/Plate'))
  })

  it('skips hidden frames by default, includes them dimmed on request', () => {
    expect(build(false).list.items.some(i => i.descPath.join('/') === 'Root/Hidden')).toBe(false)
    const withHidden = build(true).list.items.find(i => i.descPath.join('/') === 'Root/Hidden')
    expect(withHidden?.visible).toBe(false)
  })

  it('carries source attribution onto items', () => {
    const { list } = build()
    const plate = list.items.find(i => i.descPath.join('/') === 'Root/Plate')!
    expect(plate.source?.uri).toBe('file:///M.SC2Layout')
    expect(plate.source?.start).toBeGreaterThan(0)
  })
})

describe('emitHtml', () => {
  it('produces absolutely-positioned divs with data hooks in paint order', () => {
    const { list } = build()
    const html = emitHtml(list, { document: false })
    expect(html).toContain('data-desc-path="Root/Plate"')
    expect(html).toContain('data-asset="alias:UI/Plate_Crimson"')
    expect(html).toContain('data-style="TitleStyle"')
    // Line tint rendered as rgba
    expect(html).toContain('background-color:rgba(255, 0, 0, 1)')
    // paint order: Line div appears before Plate div in source
    expect(html.indexOf('Root/Line')).toBeLessThan(html.indexOf('Root/Plate'))
  })
})
