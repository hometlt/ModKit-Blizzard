/**
 * The image a published map is listed with in the Arcade: the map icon of its Arcade info
 * (`S2Map::BnetHeader.m_arcadeData` = ArcadeGameInfo, header field 19, `m_mapIcon` = field 6), else
 * `m_bigMap` of the header's working set (field 4 → 3). Both are `Attribute::ArtId` { visual file
 * index, top, left, height, width } into the working set's visual files (`.s2mv`, public depot);
 * ArcadeGameInfo's own `m_visualizationFiles` was empty in all 837 headers of a game cache with Arcade
 * info. A map without a minimap has the editor's 24 × 24 placeholder as `m_bigMap` (278 of 1436
 * headers), which the Arcade covers with the icon (Star Battle Reloaded).
 *
 * Formats seen: minimaps 126 DXT5 DDS, 13 uncompressed TGA and one JPEG of 140; icons were all
 * uncompressed 32-bit TGA (15 of 15). Block, JPEG and TGA decoding, scaling and the PNG encoder are
 * codec-kit's; only the 128-byte DDS header is read here. An image that is not decoded counts as
 * missing, and the other one is tried.
 */
import { decodeBaselineJpeg, decodeTga, encodePng, plausibleTgaHeader, resizeRgba, type RgbaImage } from '@modkit/codec-kit/raster'
import { decodeBcSurface, type BcFormat } from '@modkit/codec-kit/texture/bc'
import { array, blob, decodeCacheHeader, field, number, optionalField, type CacheNode } from './cache-header.js'
import type { DepotComponentRequest } from './public-depot.js'
import type { BattleNetMapPreview } from './vfs-provider.js'

export interface MapPreviewRequest {
  readonly region: string
  /** Hex `CacheHandle40` of the revision's `.s2mh`, as a publication carries it. */
  readonly headerHandle: string
  /** Longest side of the returned image; larger images are scaled down (default 256). */
  readonly maxSize?: number
  readonly signal: AbortSignal
}

const VISUAL_BYTES = 16 * 1024 * 1024
/** The editor attaches a 24 × 24 placeholder to documents without an image. */
const PLACEHOLDER_PIXELS = 32
const BC_FORMATS: Readonly<Record<string, BcFormat>> = { DXT1: 'DXT1', DXT3: 'DXT3', DXT5: 'DXT5' }

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))

/** RGBA of a depot image (a map visual, an unlockable atlas), or null for a format that is not decoded here. */
export function decodeDepotImage(bytes: Uint8Array): RgbaImage | null {
  if (bytes.length >= 128 && ascii(bytes, 0) === 'DDS ') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const height = view.getUint32(12, true), width = view.getUint32(16, true)
    const format = BC_FORMATS[ascii(bytes, 84)]
    if (!format || !width || !height || width > 4096 || height > 4096) return null
    const blocks = Math.ceil(width / 4) * Math.ceil(height / 4) * (format === 'DXT1' ? 8 : 16)
    if (bytes.length < 128 + blocks) return null
    return { width, height, pixels: decodeBcSurface(bytes, 128, width, height, format) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    try { return decodeBaselineJpeg(bytes) } catch { return null }
  }
  // TGA has no signature: its header is checked, and the pixels bounded like a 4096 × 4096 image.
  if (plausibleTgaHeader(bytes)) {
    try { return decodeTga(bytes, 4096 * 4096 * 4) } catch { return null }
  }
  return null
}

export function crop(image: RgbaImage, left: number, top: number, right: number, bottom: number): RgbaImage {
  const x0 = Math.min(left, image.width), y0 = Math.min(top, image.height)
  const width = Math.max(0, Math.min(right, image.width) - x0), height = Math.max(0, Math.min(bottom, image.height) - y0)
  if (x0 === 0 && y0 === 0 && width === image.width && height === image.height) return image
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    pixels.set(image.pixels.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x0 + width) * 4), y * width * 4)
  return { width, height, pixels }
}

/** `Attribute::ArtId`: a rectangle of one of the working set's visual files. */
interface ArtId { readonly index: number; readonly top: number; readonly left: number; readonly height: number; readonly width: number }

function artId(node: CacheNode | undefined): ArtId | undefined {
  if (!node) return undefined
  const [index, top, left, height, width] = [0, 1, 2, 3, 4].map(tag => number(field(node, tag))) as [number, number, number, number, number]
  return { index, top, left, height, width }
}

export async function readMapPreview(readComponent: (request: DepotComponentRequest) => Promise<Uint8Array>,
  request: MapPreviewRequest): Promise<BattleNetMapPreview | null> {
  const header = field(decodeCacheHeader(await readComponent({ region: request.region, handle: request.headerHandle, signal: request.signal })), 0)
  const workingSet = optionalField(header, 4)
  const visuals = workingSet && optionalField(workingSet, 7)
  if (!visuals) return null
  const arcade = optionalField(header, 19)
  const candidates = [artId(arcade && optionalField(arcade, 6)), artId(optionalField(workingSet, 3))]
  let image: RgbaImage | undefined
  for (const art of candidates) {
    if (!art || art.width < PLACEHOLDER_PIXELS || art.height < PLACEHOLDER_PIXELS) continue
    const handle = array(visuals)[art.index]
    if (!handle) continue
    const decoded = decodeDepotImage(await readComponent({ region: request.region, handle: hex(blob(handle)), maximumBytes: VISUAL_BYTES, signal: request.signal }))
    if (!decoded) continue
    const cut = crop(decoded, art.left, art.top, art.left + art.width, art.top + art.height)
    if (cut.width >= PLACEHOLDER_PIXELS && cut.height >= PLACEHOLDER_PIXELS) { image = cut; break }
  }
  if (!image) return null
  const maxSize = Math.max(16, Math.min(1024, request.maxSize ?? 256))
  const scale = maxSize / Math.max(image.width, image.height)
  if (scale < 1) image = resizeRgba(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
  return { width: image.width, height: image.height, png: await encodePng(image.width, image.height, image.pixels, request.signal) }
}
