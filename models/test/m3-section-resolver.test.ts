/**
 * The M3 section traversal budget counts the data an M3 holds, not the number of times a reader
 * asks for it. Diablo III's barbarian (90 clips, dense keys) written as M3 was refused on reopen:
 * the scalar fields of every key were counted again beside the key, and the animation projection
 * asks for the same key arrays per channel and per sequence, each time charged afresh.
 */
import { describe, expect, it } from 'vitest'
import { createM3SectionResolver } from '../src/m3/section-resolver.js'

function keyedModel(count: number) {
  const vector = { x: { name: 'x' }, y: { name: 'y' }, z: { name: 'z' } }
  const keys = Array.from({ length: count }, (_, index) => ({ desc: { fields: vector }, x: index, y: 0, z: 0 }))
  const reference = { entries: count, index: 1 }
  const model = { desc: { fields: { keys: { name: 'keys', refTo: 'VEC3' } } }, keys: reference }
  const section = { desc: { history: { name: 'VEC3' } }, content: keys }
  return {
    reference,
    sections: {
      model,
      getSectionByReference: (value: unknown) => (value === reference ? section : null),
    },
  }
}

describe('M3 section traversal budget', () => {
  it('fits a record of animation keys, however often it is read', () => {
    // One reference field on the model, then the reference and its 1000 keys: 1002 nodes.
    const { reference, sections } = keyedModel(1000)
    const resolver = createM3SectionResolver(sections as never, { maxDepth: 8, maxNodes: 1_002 })
    for (let read = 0; read < 50; read += 1)
      expect(resolver.getSectionByReference(reference as never)?.content).toHaveLength(1000)
  })

  it('still refuses the keys that do not fit', () => {
    const { reference, sections } = keyedModel(1000)
    const resolver = createM3SectionResolver(sections as never, { maxDepth: 8, maxNodes: 1_001 })
    expect(() => resolver.getSectionByReference(reference as never)).toThrow(/exceeds maxNodes/u)
  })
})
