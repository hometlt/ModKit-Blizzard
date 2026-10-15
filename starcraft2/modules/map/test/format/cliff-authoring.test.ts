import { describe, expect, it } from 'vitest'
import { authorCliffCells, cliffTilesFromCells } from '../../shared/format/cliff-tiles.js'

describe('native full-level cliff authoring', () => {
  it('authors the same two-unit wall lattice consumed by native cliff mesh selection', () => {
    const vertices = { sizeX: 5, sizeY: 3, levels: [
      4, 4, 4, 4, 4,
      4, 4, 8, 8, 8,
      4, 4, 8, 8, 8,
    ] }
    const cells = authorCliffCells(vertices, 1)
    expect(cells).toEqual([
      { index: 0, flags: 1, cliffSetIndex: 1, variation: 0 },
      { index: 1, flags: 1, cliffSetIndex: 1, variation: 0 },
    ])
    const mesh = cliffTilesFromCells(vertices, cells, 8)
    expect(mesh.tiles.map(tile => [tile.code, tile.x, tile.y, tile.z])).toEqual([
      ['BBCB', 1, 1, 8], ['BBCC', 3, 1, 8],
    ])
    expect(mesh.unsupported).toBe(0)
  })
  it('keeps plateau interiors flat and preserves all vertex levels', () => {
    const vertices = { sizeX: 3, sizeY: 3, levels: Array(9).fill(8) }
    const before = structuredClone(vertices)
    expect(authorCliffCells(vertices, 0)[0]?.flags).toBe(0)
    expect(vertices).toEqual(before)
  })
  it('refuses a ramp without its frames instead of turning it into a wall', () => {
    expect(() => authorCliffCells({ sizeX: 3, sizeY: 3, levels: [4, 5, 8, 4, 6, 8, 4, 7, 8] }, 0))
      .toThrow('ramps require frames')
    expect(() => authorCliffCells({ sizeX: 2, sizeY: 3, levels: Array(6).fill(4) }, 0))
      .toThrow('odd vertex grid')
  })
})
