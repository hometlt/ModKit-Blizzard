import { describe, expect, it } from 'vitest'
import { Store } from '../shared/layout-engine/sc2-layout-core/index/store.js'
import { layoutSchemaRegistry } from '../shared/schema-registry.js'
import { resolveFrameByPath } from '../shared/format/rendering/resolve/resolve.js'

function workspace() {
  const store = new Store(layoutSchemaRegistry())
  store.updateDocument('memory://Budget.SC2Layout', `
<Desc>
  <Frame type="Frame" name="Template"><Frame type="Label" name="Leaf"/></Frame>
  <Frame type="Frame" name="Root">
    <Frame type="Frame" name="A" template="Budget/Template"/>
    <Frame type="Frame" name="B" template="Budget/Template"/>
  </Frame>
</Desc>`, 1)
  return store
}

describe('Layout owner expansion budgets', () => {
  it('counts instantiated template children while constructing the tree', () => {
    const store = workspace()
    expect(() => resolveFrameByPath(store, 'Budget/Root', { maxNodes: 4 })).toThrow(/maxNodes/u)
    const root = resolveFrameByPath(store, 'Budget/Root', { maxNodes: 5 })!
    expect(root.children.map(child => child.children.map(leaf => leaf.path))).toEqual([
      [['Root', 'A', 'Leaf']],
      [['Root', 'B', 'Leaf']],
    ])
  })

  it('refuses silent depth truncation and keeps budgets local to each resolution', () => {
    const store = workspace()
    expect(() => resolveFrameByPath(store, 'Budget/Root', { maxDepth: 1 })).toThrow(/maxDepth/u)
    expect(resolveFrameByPath(store, 'Budget/Root', { maxDepth: 2, maxNodes: 5 })?.children).toHaveLength(2)
    expect(() => resolveFrameByPath(store, 'Budget/Root', { maxNodes: 0 })).toThrow(/maxNodes/u)
    expect(() => resolveFrameByPath(store, 'Budget/Root', { maxDepth: -1 })).toThrow(/maxDepth/u)
  })
})
