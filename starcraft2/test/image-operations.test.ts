/**
 * The StarCraft II texture operations, and the refusals that matter.
 *
 * A wrong button icon looks plausible and is discovered in the game rather than in the tool, so the
 * square rule, the size ceiling and the frame range are pinned here together with the two results a
 * caller depends on: the icon keeps a transparent frame with cut corners, and the normal map ends
 * up in the channel layout the shaders read.
 */
import { describe, expect, it } from 'vitest'
import type { RgbaImage } from '@modkit/codec-kit/raster'
import {
  SC2_BUTTON_ICON_OPERATION,
  SC2_NORMAL_MAP_OPERATION,
  convertNormalMapToSc2,
  prepareSc2ButtonIcon,
  prepareSc2StraightRoadAtlas,
  packSc2TerrainDiffuse,
  SC2_TERRAIN_DIFFUSE_OPERATION_ID,
} from '../modules/textures/shared/operations.js'
import { createProvider } from '../modules/textures/providers/image-operations/provider.js'
import { SERVICE_OPERATION_PROVIDER_CONTRACT } from '@modkit/sdk'

function solid(width: number, height: number, rgba: readonly number[]): RgbaImage {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) pixels.set(rgba, index * 4)
  return { width, height, pixels }
}

const alphaAt = (image: RgbaImage, x: number, y: number): number =>
  image.pixels[(y * image.width + x) * 4 + 3] as number

describe('SC2 straight-road atlas profile', () => {
  it('uses only the explicit source band and preserves its RGBA in both target halves', async () => {
    const source = { width: 2, height: 3, pixels: Uint8Array.from([
      1, 2, 3, 0, 4, 5, 6, 0,
      10, 20, 30, 64, 40, 50, 60, 192,
      90, 80, 70, 255, 60, 50, 40, 255,
    ]) }, before = source.pixels.slice()
    const result = await prepareSc2StraightRoadAtlas(source, { sourceRegion: { x: 0, y: 1, width: 2, height: 1 }, width: 2, height: 2, maxBytes: 1024 })
    expect([...result.pixels]).toEqual([10, 20, 30, 64, 40, 50, 60, 192, 10, 20, 30, 64, 40, 50, 60, 192])
    expect(source.pixels).toEqual(before)
    expect(result.pixels.buffer).not.toBe(source.pixels.buffer)
  })
  it('refuses out-of-bounds, odd sizes, excessive allocations and cancellation', async () => {
    const source = solid(4, 4, [1, 2, 3, 255]), options = { sourceRegion: { x: 0, y: 0, width: 4, height: 4 }, width: 4, height: 4, maxBytes: 1000 }
    await expect(prepareSc2StraightRoadAtlas(source, { ...options, sourceRegion: { ...options.sourceRegion, x: 1 } })).rejects.toThrow(/outside/)
    await expect(prepareSc2StraightRoadAtlas(source, { ...options, height: 3 })).rejects.toThrow(/even/)
    await expect(prepareSc2StraightRoadAtlas(source, { ...options, width: Number.MAX_SAFE_INTEGER })).rejects.toThrow(/budget/)
    await expect(prepareSc2StraightRoadAtlas(source, { ...options, maxBytes: 223 })).rejects.toThrow(/budget/)
    await expect(prepareSc2StraightRoadAtlas(source, options, AbortSignal.abort())).rejects.toThrow()
  })
})

describe('StarCraft II terrain diffuse specular packing', () => {
  it('preserves color, discards opacity and uses explicit specular without mutating input', () => {
    const source = { width: 2, height: 1, pixels: Buffer.from([23, 45, 67, 255, 89, 10, 11, 128]) }
    expect([...packSc2TerrainDiffuse(source).pixels]).toEqual([23, 45, 67, 0, 89, 10, 11, 0])
    expect([...packSc2TerrainDiffuse(source, { specularMask: Uint8Array.of(4, 180) }).pixels]).toEqual([23, 45, 67, 4, 89, 10, 11, 180])
    expect(source.pixels[3]).toBe(255)
    expect(() => packSc2TerrainDiffuse(source, { specularMask: new Uint8Array(1) })).toThrow(/per pixel/)
    expect(() => packSc2TerrainDiffuse(source, { defaultSpecular: 256 })).toThrow(/byte/)
  })
  it('is advertised and invokable through the existing public operation provider', async () => {
    const provider = createProvider({ contract: SERVICE_OPERATION_PROVIDER_CONTRACT, major: 1 } as never, {} as never)
    try {
      expect(provider.value.operations.some(op => op.id === SC2_TERRAIN_DIFFUSE_OPERATION_ID)).toBe(true)
      const result = await provider.value.invoke({ operationId: SC2_TERRAIN_DIFFUSE_OPERATION_ID,
        input: { image: { width: 1, height: 1, pixels: btoa(String.fromCharCode(9, 17, 33, 255)) } } } as never)
      expect(result).toMatchObject({ state: 'completed', value: { image: { pixels: btoa(String.fromCharCode(9, 17, 33, 0)) } } })
    } finally { await provider.release() }
  })
})

describe('StarCraft II button icons', () => {
  it('insets the icon, keeping the frame transparent and the corners cut', () => {
    const icon = prepareSc2ButtonIcon(solid(64, 64, [200, 30, 30, 255]))
    expect([icon.width, icon.height]).toEqual([64, 64])
    // The outer frame is untouched transparent, and the middle is the icon.
    expect(alphaAt(icon, 0, 0)).toBe(0)
    expect(alphaAt(icon, 32, 32)).toBe(255)
    // A corner just inside the inset area is cut by the rounded alpha.
    const inset = Math.floor((64 - Math.round(64 * (1 - (5 / 128) * 2))) / 2)
    expect(alphaAt(icon, inset, inset)).toBe(0)
  })

  it('refuses an icon that is not square, is too large, or asks for an absurd frame', () => {
    expect(() => prepareSc2ButtonIcon(solid(8, 4, [1, 2, 3, 255]))).toThrow(/square/u)
    expect(() => prepareSc2ButtonIcon(solid(512, 512, [1, 2, 3, 255]))).toThrow(/256/u)
    expect(() => prepareSc2ButtonIcon(solid(8, 8, [1, 2, 3, 255]), { framePercent: 0.9 })).toThrow(
      /fraction of the edge/u,
    )
  })
})

describe('the viewer surface', () => {
  it('names a written copy of a button icon <base>.button, as MK2 did (plan 7.13)', () => {
    expect(SC2_BUTTON_ICON_OPERATION.surface?.copyPresetId).toBe('button')
    expect(SC2_NORMAL_MAP_OPERATION.surface?.copyPresetId).toBeUndefined()
  })
})

describe('StarCraft II normal maps', () => {
  it('moves X into alpha, flips Y and clears blue for the specular mask', () => {
    const converted = convertNormalMapToSc2(solid(2, 2, [10, 20, 30, 255]))
    expect([...converted.pixels.subarray(0, 4)]).toEqual([30, 235, 0, 10])
  })
})
