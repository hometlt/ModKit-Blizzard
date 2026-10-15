import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  readHeightMap,
  writeHeightMap,
  readSyncCliffLevel,
  writeSyncCliffLevel,
  readPathingInfo,
  readTextureMasks,
  readVertexColor,
  readObjects,
  readRegions,
  type SC2MapData,
} from '../../shared/format/index.js'
import { heightToPng, pngToHeight, cliffLevelToPng, pngToCliffLevel, overlayToPng, pathingToPng, textureToPng, vertexColorToPng } from '../../shared/image/map-image.js'
import { decodePng } from '../../shared/image/png.js'

const MAP = resolve(__dirname, '../../../../../testdata/ta-traynor.SC2Map')
const has = existsSync(MAP)
const hasEntry = (name: string) => existsSync(resolve(MAP, name))
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(MAP, name)))
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const text = (name: string) => new TextDecoder().decode(bytes(name))

function sampledColorCount(pixels: Uint8Array, stride = 257, stopAt = 16): number {
  const colors = new Set<string>()
  for (let i = 0; i < pixels.length; i += 3 * stride) {
    colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
    if (colors.size >= stopAt) break
  }
  return colors.size
}

describe.skipIf(!has)('real map ↔ PNG', () => {
  it('cliff level round-trips byte-exact through PNG', () => {
    const raw = bytes('t3SyncCliffLevel')
    const cliff = readSyncCliffLevel(raw)
    const back = pngToCliffLevel(cliffLevelToPng(cliff), cliff)
    expect(eq(raw, writeSyncCliffLevel(back))).toBe(true)
  })

  it('height map round-trips byte-exact through PNG (with ref)', () => {
    const raw = bytes('t3HeightMap')
    const h = readHeightMap(raw)
    const back = pngToHeight(heightToPng(h), h)
    expect(eq(raw, writeHeightMap(back))).toBe(true)
  })

  it('renders a texture PNG at the mask pixel resolution', () => {
    const masks = readTextureMasks(bytes('t3TextureMasks'))
    const d = decodePng(textureToPng(masks))
    expect(d.width).toBe(masks.sizeX)
    expect(d.height).toBe(masks.sizeY)
    expect(d.colorType).toBe(2)
    expect(sampledColorCount(d.pixels)).toBeGreaterThan(8)
  })

  it('renders pathing with multiple real-map debug colors', () => {
    if (!hasEntry('t3SyncPathingInfo')) return
    const pathing = readPathingInfo(bytes('t3SyncPathingInfo'))
    const d = decodePng(pathingToPng(pathing))
    expect(d.width).toBe(pathing.sizeX)
    expect(d.height).toBe(pathing.sizeY)
    expect(d.colorType).toBe(2)
    expect(sampledColorCount(d.pixels)).toBeGreaterThan(2)
  })

  it('renders vertex color with real-map variation', () => {
    if (!hasEntry('t3VertCol')) return
    const vertexColor = readVertexColor(bytes('t3VertCol'))
    const subset = { ...vertexColor, entries: vertexColor.entries.slice(0, 32) }
    const d = decodePng(vertexColorToPng(subset, { mapWidth: 136, mapHeight: 160, width: 68, height: 80 }))
    expect(d.width).toBe(68)
    expect(d.height).toBe(80)
    expect(d.colorType).toBe(2)
    expect(sampledColorCount(d.pixels, 17)).toBeGreaterThan(1)
  })

  it('renders object and region overlays over real map metadata', () => {
    if (!hasEntry('Objects') || !hasEntry('Regions')) return
    const map: SC2MapData = {
      rawFiles: new Map(),
      height: readHeightMap(bytes('t3HeightMap')),
      objects: readObjects(text('Objects')),
      regions: readRegions(text('Regions')),
    }
    const d = decodePng(overlayToPng(map, { width: 136, height: 160 }))
    expect(d.width).toBe(136)
    expect(d.height).toBe(160)
    expect(d.colorType).toBe(2)
    expect(sampledColorCount(d.pixels)).toBeGreaterThan(4)
  })
})
