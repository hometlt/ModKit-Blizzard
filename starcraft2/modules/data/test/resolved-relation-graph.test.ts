/**
 * The resolved-data relation graph names a node as a player reads it when the context read the
 * strings (parity plan 5.22), and keeps the id otherwise.
 */
import { describe, expect, it } from 'vitest'
import { openStarcraft2DataSource } from '../services/projections/data-sources.js'

const definition = (entityId: string, fields: Record<string, unknown> = {}) => ({
  namespace: 'Unit', typeId: 'CUnit', entityId, fields, sources: [], inheritanceChain: [], complete: true,
})

describe('resolved relation graph labels', () => {
  it('labels a node with the localized name of its Name key, else the conventional key, else the id', async () => {
    const snapshot = {
      snapshotId: 's1',
      definitions: [definition('Marine', { Name: 'Unit/Name/Marine' }), definition('Medic'), definition('Ghost')],
      relations: [],
      localizedStrings: [
        { key: 'Unit/Name/Marine', value: 'Морпех', requestedLocale: 'ruRU', resolvedLocale: 'ruRU', fallback: false },
        { key: 'Unit/Name/Medic', value: 'Медик', requestedLocale: 'ruRU', resolvedLocale: 'ruRU', fallback: false },
      ],
    }
    const graph = (openStarcraft2DataSource(snapshot, 'relations', 100) as {
      value: { nodes(request: { limit: number }): Promise<{ items: readonly { id: string; label: string }[] }> }
    }).value
    expect((await graph.nodes({ limit: 10 })).items.map(node => [node.id, node.label])).toEqual([
      ['Unit/Marine', 'Морпех'],
      ['Unit/Medic', 'Медик'],
      ['Unit/Ghost', 'Ghost'],
    ])
  })
})
