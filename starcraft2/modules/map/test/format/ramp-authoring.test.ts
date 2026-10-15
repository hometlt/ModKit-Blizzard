import { describe, expect, it } from 'vitest'
import { placeCliffRampTemplate, widenDiagonalCliffRampTemplate, rankDiagonalCliffRampPlacements, writeTerrainRampList, type CliffRampGrid, type CliffRampTemplate } from '../../shared/format/ramp-authoring.js'
import { parseTerrainXml } from '../../shared/format/terrain-params.js'

function grid(n: number): CliffRampGrid {
  return { vertices: { sizeX: n, sizeY: n, levels: Array(n * n).fill(4) },
    vertexMasks: Array(n * n).fill(1),
    cliffLevel: { sizeX: n - 1, sizeY: n - 1, version: 100, heights: Array((n - 1) ** 2).fill(64),
      _raw: { padding: new Uint8Array(16), trailing: new Uint8Array() } },
    cliffCells: Array.from({ length: ((n - 1) / 2) ** 2 }, (_, index) => ({ index, flags: 0, cliffSetIndex: 0, variation: 0 })) }
}

function fixture(): CliffRampTemplate {
  const source = grid(5)
  source.vertices.levels[6] = 6
  source.cliffLevel.heights[5] = 88 // Cell CLIF is distinct from the HMAP vertex classification.
  return { ...source, cliffCells: source.cliffCells.map(cell => ({ ...cell, flags: 2 })),
    bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
    ramp: { dir: 3, lo: 1, hi: 2, cliffSetIndex: 0,
      frames: { mid: { up: [1, 0], right: [0, -1], center: [2, 2], width: 1, height: 2 },
        leftHi: { up: [0, 0], right: [0, 0], center: [22, -8], width: 0, height: 0 } },
      variations: { leftLo: 0, rightLo: 0 } } }
}

describe('native ramp template placement', () => {
  it('fits asymmetric crossing points by width and lattice phase independently of map position', () => {
    const make = (center: [number, number], width: number): CliffRampTemplate => {
      const template = fixture()
      return { ...template, ramp: { ...template.ramp, dir: 5, frames: { mid: {
        up: [Math.SQRT1_2, -Math.SQRT1_2], right: [-Math.SQRT1_2, -Math.SQRT1_2], center, width, height: 2 * Math.SQRT2,
      } } } }
    }
    const templates = [make([2, 2], 6 * Math.SQRT2), make([1, 1], 3 * Math.SQRT2)]
    const points = Array.from({ length: 10 }, (_, i): [number, number] => [41 + i - 5, 63 + i - 5])
    const uphill: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2]
    const first = rankDiagonalCliffRampPlacements(templates, points, uphill)[0]!
    expect(first.templateIndex).toBe(1)
    expect(first.width).toBeCloseTo(10 * Math.SQRT2)
    expect(first.extraHalfWidth).toBe(2)
    for (const point of points) expect(Math.abs((point[0] - first.center[0] + point[1] - first.center[1]) * Math.SQRT1_2)).toBeLessThanOrEqual(first.width / 2 + 1e-5)
    const translated = rankDiagonalCliffRampPlacements(templates, points.map(([x, y]) => [x + 100, y - 40]), uphill)[0]!
    expect(translated).toMatchObject({ templateIndex: first.templateIndex, extraHalfWidth: first.extraHalfWidth,
      width: first.width, center: [first.center[0] + 100, first.center[1] - 40] })
    expect(translated.centerError).toBeCloseTo(first.centerError, 10)
    expect(rankDiagonalCliffRampPlacements(templates, points, [-uphill[0], -uphill[1]])).toEqual([])
    expect(() => rankDiagonalCliffRampPlacements(templates, [], uphill)).toThrow()
    expect(() => rankDiagonalCliffRampPlacements(templates, [[NaN, 0], [1, 1]], uphill)).toThrow()
    expect(() => rankDiagonalCliffRampPlacements(templates, [[Number.MAX_VALUE, 0], [1, 1]], uphill)).toThrow()
  })
  it('widens a diagonal ramp by repeating its centre and moving unchanged side frames', () => {
    const template: CliffRampTemplate = { ...grid(13), bounds: { minX: 2, minY: 2, maxX: 10, maxY: 10 },
      ramp: { ...fixture().ramp, dir: 5, frames: {
        mid: { up: [Math.SQRT1_2, -Math.SQRT1_2], right: [-Math.SQRT1_2, -Math.SQRT1_2], center: [6, 6], width: 2 * Math.SQRT2, height: 2 * Math.SQRT2 },
        leftLo: { up: [1, 0], right: [0, -1], center: [8, 8], width: 2, height: 2 },
        rightLo: { up: [1, 0], right: [0, -1], center: [4, 4], width: 2, height: 2 },
      } } }
    template.vertices.levels[6 * 13 + 6] = 6
    template.cliffLevel.heights[6 * 12 + 6] = 88
    template.cliffCells = template.cliffCells.map(cell => ({ ...cell, flags: 2 }))
    const before = structuredClone(template)
    const result = widenDiagonalCliffRampTemplate(template, 2)
    const fit = rankDiagonalCliffRampPlacements([template], Array.from({ length: 7 }, (_, i): [number, number] => [6 + i - 3, 6 + i - 3]), template.ramp.frames.mid!.up)[0]!
    expect(fit.extraHalfWidth).toBe(2)
    expect(fit.width).toBeCloseTo(2 * result.ramp.frames.mid!.width)
    expect(result.ramp.frames.mid?.width).toBeCloseTo(4 * Math.SQRT2)
    expect(result.ramp.frames.leftLo).toEqual({ ...template.ramp.frames.leftLo, center: [10, 10] })
    expect(result.ramp.frames.rightLo).toEqual({ ...template.ramp.frames.rightLo, center: [2, 2] })
    expect(result.vertices.levels[8 * 13 + 8]).toBe(6)
    expect(result.cliffLevel.heights[8 * 12 + 8]).toBe(88)
    expect(template).toEqual(before)
    expect(() => widenDiagonalCliffRampTemplate(template, 1)).toThrow('two-cell')
    expect(() => widenDiagonalCliffRampTemplate(template, 4)).toThrow('fit entirely')
    expect(() => widenDiagonalCliffRampTemplate(fixture(), 2)).toThrow('diagonal')
    expect(() => widenDiagonalCliffRampTemplate({ ...template, bounds: { ...template.bounds, minX: 1 } }, 2)).toThrow('lattice')
    expect(() => widenDiagonalCliffRampTemplate({ ...template, ramp: { ...template.ramp,
      frames: { ...template.ramp.frames, mid: { ...template.ramp.frames.mid!, up: [Number.NaN, 0] } } } }, 2)).toThrow('qualified')
    const placed = placeCliffRampTemplate(grid(17), result, { offsetX: 2, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 })
    expect(placed.vertices.levels[10 * 17 + 10]).toBe(10)
    expect(placed.cliffLevel.heights[10 * 16 + 10]).toBe(152)
    expect(placed.vertices.levels[0]).toBe(4)
    expect(placed.cliffCells.some(cell => cell.flags === 2)).toBe(true)
  })
  it('moves frames, independent height/cell grids and authored ramp tiles together', () => {
    const target = grid(9), template = fixture()
    const before = structuredClone({ target, template })
    const result = placeCliffRampTemplate(target, template, { offsetX: 2, offsetY: 4, levelOffset: 4, cliffSetIndex: 1 })
    expect(result.vertices.levels[5 * 9 + 3]).toBe(10)
    expect(result.vertexMasks[5 * 9 + 3]).toBe(2)
    expect(result.cliffLevel.heights[5 * 8 + 3]).toBe(152)
    expect(result.ramp.frames.mid?.center).toEqual([4, 6])
    expect(result.ramp.frames.leftHi).toBeUndefined()
    expect([result.ramp.lo, result.ramp.hi, result.ramp.cliffSetIndex]).toEqual([2, 3, 1])
    expect(result.cliffCells.find(cell => cell.index === 9)).toEqual({ index: 9, flags: 2, cliffSetIndex: 1, variation: 0 })
    expect(result.vertices.levels[0]).toBe(4)
    expect({ target, template }).toEqual(before)
  })
  it('refuses clipping and off-lattice placement', () => {
    expect(() => placeCliffRampTemplate(grid(9), fixture(), { offsetX: 1, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 })).toThrow('lattice')
    expect(() => placeCliffRampTemplate(grid(9), fixture(), { offsetX: 6, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 })).toThrow('fit entirely')
  })
  it('preserves target terrain outside authored ramp support, ignoring donor plateaus', () => {
    const source = grid(9), target = grid(13)
    source.vertices.levels[0] = 28 // Unrelated donor plateau inside rectangular bounds.
    source.vertices.levels[3 * 9 + 3] = 6
    source.cliffLevel.heights[3 * 8 + 3] = 88
    source.cliffCells[5]!.flags = 2 // Only the 2x2 cell at (2,2) belongs to the ramp.
    target.vertices.levels[10 * 13 + 10] = 16
    const template: CliffRampTemplate = { ...source, bounds: { minX: 0, minY: 0, maxX: 8, maxY: 8 },
      ramp: { ...fixture().ramp, frames: { mid: { up: [1, 0], right: [0, -1], center: [3, 3], width: 1, height: 1 } } } }
    const result = placeCliffRampTemplate(target, template, { offsetX: 2, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 })
    expect(result.changedVertices).toBe(9)
    expect(result.changedCells).toBe(4)
    expect(result.vertices.levels[5 * 13 + 5]).toBe(10)
    expect(result.cliffLevel.heights[5 * 12 + 5]).toBe(152)
    for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) {
      if (x >= 4 && x <= 6 && y >= 4 && y <= 6) continue
      const i = y * 13 + x
      expect(result.vertices.levels[i]).toBe(target.vertices.levels[i])
      expect(result.vertexMasks[i]).toBe(target.vertexMasks[i])
    }
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      if (x >= 4 && x < 6 && y >= 4 && y < 6) continue
      expect(result.cliffLevel.heights[y * 12 + x]).toBe(target.cliffLevel.heights[y * 12 + x])
    }
  })
  it('refuses unqualified layer masks when moving between cliff bands', () => {
    const template = fixture()
    template.vertexMasks = template.vertexMasks.map(() => 0x9001)
    expect(() => placeCliffRampTemplate(grid(9), template,
      { offsetX: 2, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 })).toThrow('qualified simple native layer masks')
  })
  it('does not wrap support coordinates into another row at template edges', () => {
    const template = fixture(), target = grid(13)
    template.cliffCells = template.cliffCells.map(cell => ({ ...cell, flags: cell.index === 1 ? 2 : 0 }))
    template.ramp.frames = { mid: { up: [1, 0], right: [0, -1], center: [3, 1], width: 1, height: 1 } }
    const untouched = 3 * 6 + 1 // Target cell (2,6), outside ramp support and its joins.
    target.cliffCells[untouched]!.variation = 7
    const result = placeCliffRampTemplate(target, template, { offsetX: 4, offsetY: 4, levelOffset: 4, cliffSetIndex: 0 })
    expect(result.cliffCells.find(cell => cell.index === untouched)).toEqual(target.cliffCells[untouched])
  })
  it('refuses overlapping ramp patches', () => {
    const placement = { offsetX: 2, offsetY: 2, levelOffset: 4, cliffSetIndex: 0 }
    const first = placeCliffRampTemplate(grid(9), fixture(), placement)
    expect(() => placeCliffRampTemplate(first, fixture(), placement)).toThrow('overlaps')
  })
  it('reopens frames and variations through the existing native XML reader', () => {
    const { ramp } = placeCliffRampTemplate(grid(9), fixture(), { offsetX: 2, offsetY: 2, levelOffset: 4, cliffSetIndex: 1 })
    const result = parseTerrainXml(`<terrain><heightMap>${writeTerrainRampList([ramp])}</heightMap></terrain>`)
    expect(result.ramps).toEqual([ramp])
    expect(() => writeTerrainRampList([{ ...ramp, hi: Number.NaN }])).toThrow('header')
  })
})
