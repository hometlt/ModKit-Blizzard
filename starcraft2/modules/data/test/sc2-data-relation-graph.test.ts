/**
 * The catalog relation graph, built by the ported walker.
 *
 * Which fields count as references is the library's knowledge — 646 lines that walk every typed
 * field including the ones nested in arrays and structs. What is tested here is the projection onto
 * the contract, and the two claims the graph makes about itself: what it contains, and whether it
 * knows it is incomplete.
 */
import { describe, expect, it } from 'vitest'
import { createCatalogRelationGraphSource } from '../codecs/sc2data/src/relation-graph.js'
import { entitySubjectId } from '../codecs/sc2data/src/entity-facts.js'

/** A catalog store shaped the way the ported walker expects, holding two linked entities. */
function catalog() {
  const marine = {
    id: 'Marine',
    class: 'CUnit',
    namespace: 'Unit',
    data: { WeaponArray: [{ Link: 'GaussRifle' }], Name: 'Unit/Name/Marine' },
  }
  const rifle = { id: 'GaussRifle', class: 'CWeapon', namespace: 'Weapon', data: {} }
  const store = new Map<string, Map<string, unknown>>([
    ['Unit', new Map([['Marine', marine]])],
    ['Weapon', new Map([['GaussRifle', rifle]])],
  ])
  return {
    get: (namespace: string, id: string) => store.get(namespace)?.get(id),
    all: (namespace: string) => [...(store.get(namespace)?.values() ?? [])],
    namespaces: () => [...store.keys()],
  } as never
}

const complete = { snapshotId: 'r1', complete: true }

describe('catalog relation graph', () => {
  it('publishes one node per entity, bucketed by namespace', async () => {
    const source = createCatalogRelationGraphSource(catalog(), complete)
    const summary = await source.summary()
    expect(summary.totalNodes).toBeGreaterThanOrEqual(2)
    expect(summary.types.map(bucket => bucket.id)).toContain('Unit')
    expect(summary.types.map(bucket => bucket.id)).toContain('Weapon')
    // Colour slots are assigned by position so a namespace keeps its colour between sessions.
    expect(summary.types.map(bucket => bucket.tone)).toEqual(
      summary.types.map((_, index) => index),
    )
  })

  it('finds a link nested inside an array field, which a flat scan would miss', async () => {
    const source = createCatalogRelationGraphSource(catalog(), complete)
    const edges = await source.edges({ limit: 100 })
    const link = edges.items.find(edge => edge.to === 'Weapon/GaussRifle')
    expect(link?.from).toBe('Unit/Marine')
    // The role names the field path, so two links between the same pair stay distinguishable.
    expect(link?.role).toContain('WeaponArray')
  })

  it('lets a declared entity open its card, under the id the card links by (parity plan 5.20)', async () => {
    const source = createCatalogRelationGraphSource(catalog(), complete)
    const nodes = await source.nodes({ limit: 100 })
    expect(nodes.items.find(node => node.id === 'Unit/Marine')?.subject).toBe(entitySubjectId('Unit', 'Marine'))
    expect(nodes.items.find(node => node.type === 'Text')?.subject).toBeUndefined()
  })

  it('treats a localized text key as a node of its own rather than dropping it', async () => {
    const source = createCatalogRelationGraphSource(catalog(), complete)
    const nodes = await source.nodes({ limit: 100 })
    const text = nodes.items.find(node => node.type === 'Text')
    expect(text?.label).toBe('Unit/Name/Marine')
    const edges = await source.edges({ limit: 100 })
    expect(edges.items.some(edge => edge.to === text?.id)).toBe(true)
  })

  /*
   * The claim that matters when a reader trusts the view. "This entity has no references" and
   * "this view cannot see them" look identical on screen, so the graph has to say which it is.
   */
  it('reports itself partial when the dependency chain was not resolved', async () => {
    const source = createCatalogRelationGraphSource(catalog(), {
      snapshotId: 'r1',
      complete: false,
      reason: 'the dependency chain is not fully resolved in this session',
    })
    const summary = await source.summary()
    expect(summary.completeness).toBe('partial')
    expect(summary.reason).toMatch(/dependency chain/u)
  })

  it('pages nodes and edges, and refuses a page request it cannot honour', async () => {
    const source = createCatalogRelationGraphSource(catalog(), complete)
    const first = await source.nodes({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    const second = await source.nodes({ limit: 1, cursor: first.nextCursor })
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    await expect(source.nodes({ limit: 0 })).rejects.toThrow(/positive safe integer/u)
    await expect(source.nodes({ limit: 5, cursor: 'nonsense' })).rejects.toThrow(/cursor/u)
  })

  it('is empty but usable for a catalog with nothing in it', async () => {
    const empty = {
      get: () => undefined,
      all: () => [],
      namespaces: () => [],
    } as never
    const source = createCatalogRelationGraphSource(empty, complete)
    expect((await source.summary()).totalNodes).toBe(0)
    expect((await source.edges({ limit: 10 })).items).toEqual([])
  })
})
