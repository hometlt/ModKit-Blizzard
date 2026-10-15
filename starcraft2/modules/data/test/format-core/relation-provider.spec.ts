/**
 * The SC2 edge provider, driven end to end through the game-neutral traversal.
 *
 * The point of the pair is that this file contains StarCraft II's vocabulary and
 * `@modkitx/entity-cards` contains none of it, yet together they produce the graph the app used
 * to build by itself.
 */
import { describe, expect, it } from 'vitest'
import { buildRelationGraphView, relationGroupsOf } from '@modkit/codec-kit/legacy/entity-cards'
import {
  createCatalogRelationProvider,
  type CatalogRelationSource,
} from '../../shared/format/relation-provider.js'

const entity = (namespace: string, id: string) => ({ namespace, id })

const refs = [
  {
    from: entity('Unit', 'Marine'),
    to: entity('Weapon', 'GaussRifle'),
    path: 'WeaponArray.0.Link',
  },
  { from: entity('Unit', 'Marine'), to: entity('Abil', 'Stimpack'), path: 'AbilArray.0' },
  { from: entity('Weapon', 'GaussRifle'), to: entity('Effect', 'Damage'), path: 'Effect' },
  { from: entity('Unit', 'Barracks'), to: entity('Unit', 'Marine'), path: 'TechAliasArray.0' },
]

const source: CatalogRelationSource = {
  outgoing: (namespace, id) =>
    refs.filter(ref => ref.from.namespace === namespace && ref.from.id === id),
  incoming: (namespace, id) =>
    refs.filter(ref => ref.to.namespace === namespace && ref.to.id === id),
}

const marine = { kind: 'Unit', id: 'Marine' }

describe('createCatalogRelationProvider', () => {
  it('maps a catalog reference to a subject edge, keeping the field path as the relation', () => {
    const provider = createCatalogRelationProvider(source)
    const [edge] = provider.outgoing(marine)
    expect(edge).toEqual({
      from: { kind: 'Unit', id: 'Marine' },
      to: { kind: 'Weapon', id: 'GaussRifle' },
      relation: 'WeaponArray.0.Link',
    })
  })

  it('drives the game-neutral traversal without the traversal knowing any of this', () => {
    const view = buildRelationGraphView(marine, createCatalogRelationProvider(source), { depth: 2 })
    expect(view.nodes.map(node => node.id).sort()).toEqual([
      'Barracks',
      'Damage',
      'GaussRifle',
      'Marine',
      'Stimpack',
    ])
    expect(view.nodes.find(node => node.id === 'Damage')?.depth).toBe(2)
    expect(view.kindCounts.find(count => count.kind === 'Unit')?.count).toBe(2)
  })

  it('groups a card section by catalog namespace', () => {
    const groups = relationGroupsOf(marine, createCatalogRelationProvider(source))
    expect(groups.outgoing.map(group => group.kind)).toEqual(['Abil', 'Weapon'])
    expect(groups.incoming.map(group => group.kind)).toEqual(['Unit'])
  })

  it('uses supplied display names, and falls back to ids when the host has none', () => {
    const named = createCatalogRelationProvider(source, subject =>
      subject.id === 'Marine' ? 'Marine (Terran)' : undefined,
    )
    const view = buildRelationGraphView(marine, named)
    expect(view.nodes.find(node => node.id === 'Marine')?.label).toBe('Marine (Terran)')
    expect(view.nodes.find(node => node.id === 'GaussRifle')?.label).toBe('GaussRifle')
  })
})
