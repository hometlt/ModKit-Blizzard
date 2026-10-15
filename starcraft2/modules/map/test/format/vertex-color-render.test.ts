import { expect, it } from 'vitest'
import { readVertexColor, writeVertexColor, vertexColorScalarGrid } from '../../shared/format/formats/vertex-color.js'

function fixture(version: number) {
  const fixed = version === 103 ? 24 : 32
  const bytes = new Uint8Array(32 + 2 * (fixed + 4 + 25))
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('VTCL'))
  view.setUint32(4, version, true)
  view.setUint32(8, 2, true)
  let offset = 32
  for (let block = 0; block < 2; block++) {
    view.setInt32(offset + 4, 1, true)
    view.setFloat32(offset + 8, block * 4, true)
    view.setFloat32(offset + 16, block * 4 + 4, true)
    view.setFloat32(offset + 20, 4, true)
    view.setUint32(offset + fixed, 25, true)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) bytes[offset + fixed + 4 + y * 5 + x] = (block * 4 + x) * 20 + y
    offset += fixed + 4 + 25
  }
  return bytes
}

it.each([103, 104])('decodes VTCL %i bounds/layers, reconstructs seams and preserves all bytes', version => {
  const bytes = fixture(version), decoded = readVertexColor(bytes)
  expect(decoded.entries[1].header).toMatchObject({ textureIndex: 0, layerIndex: 1, minX: 4, minY: 0, maxX: 8, maxY: 4 })
  expect(writeVertexColor(decoded)).toEqual(bytes)
  const grid = vertexColorScalarGrid(decoded, 9, 5)
  expect(grid.length).toBe(45)
  for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) expect(grid[y * 9 + x]).toBe(x * 20 + y)
  expect(() => readVertexColor(bytes.subarray(0, bytes.length - 1))).toThrow()
})

it('rejects unsupported versions and excessive grids, keeps unknown records out of shading', () => {
  const bytes = fixture(104), view = new DataView(bytes.buffer)
  view.setUint32(4, 105, true)
  expect(() => readVertexColor(bytes)).toThrow(/version/)
  view.setUint32(4, 104, true)
  view.setInt32(36, 4, true)
  const decoded = readVertexColor(bytes)
  expect(vertexColorScalarGrid(decoded, 9, 5)[0]).toBe(255)
  expect(() => vertexColorScalarGrid(decoded, 100000, 100000)).toThrow(/budget/)
})
