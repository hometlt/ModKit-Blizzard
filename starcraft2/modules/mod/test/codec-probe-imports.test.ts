import { expect, it, vi } from 'vitest'

const heavyOwner = vi.hoisted(() => vi.fn(() => {
  throw new Error('SC2 mod authoring owner loaded before inspection')
}))
vi.mock('../shared/core/index.js', heavyOwner)
vi.mock('../shared/core/mod-of-files.js', heavyOwner)
vi.mock('../services/resources/src/mod-card.js', heavyOwner)
vi.mock('../../data/services/editing/entity-field-write.js', heavyOwner)
vi.mock('../codecs/mod/src/sc2-components-export.js', heavyOwner)
vi.mock('../codecs/mod/src/portable-json-export.js', heavyOwner)

it('constructs both mod codecs without loading model, cards, edits or exporters', async () => {
  const { createSc2ModCodec } = await import('../codecs/mod/src/codec.js')
  expect(createSc2ModCodec(true)).toBeDefined()
  expect(createSc2ModCodec(false)).toBeDefined()
  expect(heavyOwner).not.toHaveBeenCalled()
})
