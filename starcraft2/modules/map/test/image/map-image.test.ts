import { describe, it, expect } from 'vitest'
import {
  readHeightMap,
  writeHeightMap,
  readSyncCliffLevel,
  writeSyncCliffLevel,
  readPathingInfo,
  readTextureMasks,
} from '../../shared/format/index.js'
import {
  heightToPng,
  pngToHeight,
  cliffLevelToPng,
  pngToCliffLevel,
  pathingToPng,
  overlayToPng,
  composeOverlayToPng,
  vertexColorToPng,
  textureToPng,
} from '../../shared/image/map-image.js'
import { decodePng, encodeRGB8 } from '../../shared/image/png.js'
import type { SC2MapData } from '../../shared/format/index.js'

// --- hand-crafted fixtures (LE builders) ---
function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
}
function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff]
}

function hmap(): Uint8Array {
  // 2x2, varied base/adjustments/mask — cell order: heightBase, heightAdjustments, mask
  const head = [0x48, 0x4d, 0x41, 0x50, ...u32(101), ...u32(2), ...u32(2), ...new Array(16).fill(7)]
  const cells = [
    ...u16(100), ...u16(1), ...u16(1),
    ...u16(2000), ...u16(2), ...u16(2),
    ...u16(30000), ...u16(3), ...u16(3),
    ...u16(65535), ...u16(4), ...u16(0),
  ]
  return Uint8Array.from([...head, ...cells])
}

function clif(): Uint8Array {
  const head = [0x43, 0x4c, 0x49, 0x46, ...u32(100), ...u32(3), ...u32(1), ...new Array(16).fill(0)]
  const heights = [...u16(8), ...u16(10), ...u16(12)]
  return Uint8Array.from([...head, ...heights])
}

function path(): Uint8Array {
  const head = [0x50, 0x41, 0x54, 0x48, ...u32(100), ...u32(4), ...u32(1), ...new Array(16).fill(0)]
  const blocks = [...u16(0x00), ...u16(0x02), ...u16(0x23), ...u16(0x99)]
  return Uint8Array.from([...head, ...blocks])
}

function overlayFixture(): SC2MapData {
  return {
    rawFiles: new Map(),
    height: {
      sizeX: 10,
      sizeY: 10,
      version: 101,
      cells: new Array(100).fill(0).map(() => ({ heightAdjustments: 0, heightBase: 0, mask: 0 })),
      _raw: { padding: new Uint8Array(16), trailing: new Uint8Array(0) },
    },
    objects: {
      version: 1,
      units: [{ id: 1, variation: 0, position: '5,5,0', scale: '1,1,1', unitType: 'Marine', player: 1, textures: [], extra: {} }],
      doodads: [{ id: 4, variation: 0, position: '4,8,0', scale: '1,1,1', type: 'Tree', flags: [], extra: {} }],
      points: [{ id: 2, position: '2,2,0', scale: '1,1,1', type: 'Point', extra: {} }],
      cameras: [{ id: 3, position: '8,8,0', cameraValues: [], extra: {} }],
      byId: new Map(),
    },
    regions: {
      regions: [{ id: 1, name: 'R', shapes: [{ type: 'rect', min: '1,1', max: '3,3', extra: {} }] }],
      byId: new Map(),
      byName: new Map(),
    },
    water: {
      version: 110,
      zones: [{
        templateId: 'Water',
        templateIdBytes: new Uint8Array(40),
        startX: 6,
        startY: 1,
        endX: 9,
        endY: 3,
      }],
      _raw: { zero: new Uint8Array(20), trailing: new Uint8Array(0) },
    },
  }
}

describe('height map ↔ PNG', () => {
  it('round-trips byte-exact through PNG using a ref', () => {
    const original = hmap()
    const map = readHeightMap(original)
    const png = heightToPng(map) // encodes heightBase
    const back = pngToHeight(png, map) // ref carries adjustments + mask + padding
    expect(Array.from(writeHeightMap(back))).toEqual(Array.from(original))
  })

  it('encodes the requested channel with PNG row 0 = map north', () => {
    const map = readHeightMap(hmap())
    const d = decodePng(heightToPng(map, 'base'))
    expect(d.width).toBe(2)
    expect(d.bitDepth).toBe(16)
    // Grids store row 0 = south; the image flips rows so row 0 = north. Grid
    // cell (0,0) heightBase = 100 (big-endian 0x0064) lands on the LAST row.
    const o = (d.height - 1) * d.width * 2
    expect(d.pixels[o]).toBe(0x00)
    expect(d.pixels[o + 1]).toBe(0x64)
    // Grid row 1 (north) is the first image row: cell (0,1) base = 30000 = 0x7530.
    expect(d.pixels[0]).toBe(0x75)
    expect(d.pixels[1]).toBe(0x30)
  })
})

describe('cliff level ↔ PNG', () => {
  it('round-trips byte-exact (single channel, fully lossless with ref)', () => {
    const original = clif()
    const cliff = readSyncCliffLevel(original)
    const png = cliffLevelToPng(cliff)
    const back = pngToCliffLevel(png, cliff)
    expect(Array.from(writeSyncCliffLevel(back))).toEqual(Array.from(original))
  })
})

describe('pathing info -> PNG', () => {
  it('renders known pathing values to an RGB PNG', () => {
    const pathing = readPathingInfo(path())
    const d = decodePng(pathingToPng(pathing))
    expect(d.width).toBe(4)
    expect(d.height).toBe(1)
    expect(d.colorType).toBe(2)
    expect(Array.from(d.pixels.slice(0, 12))).toEqual([
      42, 154, 99,
      230, 181, 70,
      45, 49, 57,
      177, 82, 178,
    ])
  })
})

describe('map overlays -> PNG', () => {
  it('renders objects, regions, and water as RGB debug colors', () => {
    const map = overlayFixture()
    const d = decodePng(overlayToPng(map, { width: 20, height: 20 }))
    expect(d.width).toBe(20)
    expect(d.height).toBe(20)
    expect(d.colorType).toBe(2)

    const colors = new Set<string>()
    for (let i = 0; i < d.pixels.length; i += 3) {
      colors.add(`${d.pixels[i]},${d.pixels[i + 1]},${d.pixels[i + 2]}`)
    }
    expect(colors).toContain('91,173,255')   // unit
    expect(colors).toContain('179,126,74')   // doodad
    expect(colors).toContain('255,215,92')   // point
    expect(colors).toContain('228,99,99')    // camera
    expect(colors).toContain('115,238,151')  // region
    expect(colors).toContain('74,161,255')   // water
  })

  it('composes overlays onto an existing RGB PNG', () => {
    const basePixels = new Uint8Array(30 * 30 * 3)
    for (let i = 0; i < basePixels.length; i += 3) {
      basePixels[i] = 9
      basePixels[i + 1] = 10
      basePixels[i + 2] = 11
    }
    const d = decodePng(composeOverlayToPng(encodeRGB8(30, 30, basePixels), overlayFixture()))
    expect(d.width).toBe(30)
    expect(d.height).toBe(30)

    const colors = new Set<string>()
    for (let i = 0; i < d.pixels.length; i += 3) {
      colors.add(`${d.pixels[i]},${d.pixels[i + 1]},${d.pixels[i + 2]}`)
    }
    expect(colors).toContain('9,10,11')
    expect(colors).toContain('91,173,255')
    expect(colors).toContain('115,238,151')
  })
})

describe('vertex color -> PNG', () => {
  it('renders vertex paint intensities as darkening over a background', () => {
    const d = decodePng(vertexColorToPng({
      version: 104,
      prologue: new Uint8Array(16),
      entries: [{
        header: {
          raw: new Uint8Array(32),
          minX: 0,
          minY: 0,
          minZ: 0,
          maxX: 1,
          maxY: 1,
        },
        data: Uint8Array.from([0, 255, 128, 64]),
      }],
    }, { mapWidth: 2, mapHeight: 2, width: 2, height: 2 }))

    expect(d.width).toBe(2)
    expect(d.height).toBe(2)
    expect(d.colorType).toBe(2)
    const colors = new Set<string>()
    for (let i = 0; i < d.pixels.length; i += 3) {
      colors.add(`${d.pixels[i]},${d.pixels[i + 1]},${d.pixels[i + 2]}`)
    }
    expect(colors).toContain('0,0,0')
    expect(colors).toContain('255,255,255')
    expect(colors).toContain('128,128,128')
    expect(colors).toContain('64,64,64')
  })

  it('ignores a corrupt entry with a garbage coordinate instead of overflowing the buffer', () => {
    // A desynced t3VertCol entry can carry a garbage float (~3e20) in its bounds. Left
    // unbounded that explodes the output buffer ("Invalid typed array length"). The bad
    // entry must be skipped while a valid one still renders.
    const png = vertexColorToPng({
      version: 104,
      prologue: new Uint8Array(16),
      entries: [
        { header: { raw: new Uint8Array(32), minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1 }, data: Uint8Array.from([0, 255, 128, 64]) },
        { header: { raw: new Uint8Array(32), minX: 2.875e20, minY: 8, minZ: 14, maxX: 16, maxY: 10 }, data: Uint8Array.from([1, 2, 3]) },
      ],
    }, { mapWidth: 2, mapHeight: 2, width: 2, height: 2 })
    const d = decodePng(png)
    expect(d.width).toBe(2)
    expect(d.height).toBe(2)
  })
})

describe('texture masks → PNG', () => {
  it('produces a valid RGB PNG of the mask pixel size', () => {
    // minimal 64x64 single-tile, 1 layer with a set weight
    const head = [0x4d, 0x41, 0x53, 0x4b, ...u32(102), ...u32(0), ...u32(64), ...u32(64), ...new Array(44).fill(0)]
    const body = new Array(2048).fill(0)
    body[0] = 0xf0 // pixel (0,0) layer0 weight 0xF
    const masks = readTextureMasks(Uint8Array.from([...head, ...body]))
    const png = textureToPng(masks)
    const d = decodePng(png)
    expect(d.width).toBe(64)
    expect(d.height).toBe(64)
    expect(d.colorType).toBe(2)
    // Grid pixel (0,0) = map south-west; with PNG row 0 = north it lands on
    // the last image row, tinted by layer-0 color at full weight.
    expect(d.pixels[(d.height - 1) * d.width * 3]).toBeGreaterThan(0)
    expect(d.pixels[0]).toBe(0) // north-west corner has no weight
  })
})
