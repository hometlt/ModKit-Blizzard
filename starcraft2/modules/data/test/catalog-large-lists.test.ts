import { expect, it } from 'vitest'
import { analyzeStarcraft2Data } from '../services/catalog/provider.js'

it('preserves large top-level and nested repeated fields in order', async () => {
  const count = 4096
  const values = Array.from({ length: count }, (_, i) => `<Extra value="v${i}"/>`).join('')
  const snapshot = await analyzeStarcraft2Data({
    workspaceId: 'large-lists',
    gameId: 'blizzard/starcraft-2',
    documents: [
      {
        rootId: 'fixture',
        path: 'UnitData.xml',
        text: `<Catalog><CUnit id="Many">${values}<Nested>${values}</Nested></CUnit></Catalog>`,
      },
    ],
    queries: [{ namespace: 'Unit', entityId: 'Many' }],
    maxDocuments: 1,
    maxTextBytes: 1_048_576,
    maxEntities: 8,
    maxDepth: 32,
  })
  const expected = Array.from({ length: count }, (_, i) => `v${i}`)
  expect(snapshot.entities[0].fields.Extra).toEqual(expected)
  expect(snapshot.entities[0].fields.Nested.Extra).toEqual(expected)
})
