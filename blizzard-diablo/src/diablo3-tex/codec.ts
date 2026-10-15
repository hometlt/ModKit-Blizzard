/**
 * Diablo III TEX texture codec.
 *
 * Validates TEX v47 and decodes the known raw and component-planar BC payloads without external
 * GPU tooling. Diablo stores a BC payload with its component planes separated, so the blocks are
 * reassembled before decoding rather than fed to a block decoder as they lie on disk.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import type { RasterAtlasRegion, RasterRegionRequest } from '@modkit/sdk'
import {
  createInspectionCodec,
  createRasterImageSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import { decodeBcSurface, type BcFormat } from '@modkit/codec-kit/texture/bc'

interface RawFormat {
  readonly label: string
  readonly bytesPerPixel: number
  readonly alpha: boolean
  readonly blockBytes?: undefined
  readonly bc?: undefined
}

interface BlockFormat {
  readonly label: string
  readonly blockBytes: number
  readonly bc: BcFormat
  readonly alpha: boolean
  readonly bytesPerPixel?: undefined
}

type TexFormat = RawFormat | BlockFormat

interface TexMip {
  readonly level: number
  readonly offset: number
  readonly size: number
  readonly width: number
  readonly height: number
  readonly expected: number
  /** Where face 0 of this level starts; the other faces follow it, `size` bytes each. */
  readonly start: number
}

interface Texture {
  readonly snoId: number
  readonly pixelFormat: number
  readonly format: TexFormat
  readonly width: number
  readonly height: number
  readonly faces: number
  readonly flags: number
  readonly extraMips: number
  readonly mips: readonly TexMip[]
  /** Levels the mip table lists, which may exceed the levels the file holds. */
  readonly tableEntries: number
  readonly frames: number
  readonly frameTableOffset: number
  readonly frameTableSize: number
  readonly decodedBytes: number
}

const ID = 'blizzard/diablo3-tex'
const MAGIC = 0xdeadbeef
const VERSION = 47
const HEADER_BYTES = 0x270
const MIP_TABLE = 0x38
const MAX_MIPS = 60
const FORMATS: Readonly<Record<number, TexFormat>> = Object.freeze({
  0: Object.freeze({ label: 'A8R8G8B8', bytesPerPixel: 4, alpha: true }),
  4: Object.freeze({ label: 'A4R4G4B4', bytesPerPixel: 2, alpha: true }),
  7: Object.freeze({ label: 'L8', bytesPerPixel: 1, alpha: false }),
  // 9 is opaque BC1 (hair, water normals): a three-colour block's fourth index is black, not a hole;
  // 10 is BC1 with punch-through alpha (D3ModelViewer `TexReader.cs`, MIT)
  9: Object.freeze({ label: 'BC1 / DXT1', blockBytes: 8, bc: 'DXT1', alpha: false }),
  10: Object.freeze({ label: 'BC1 / DXT1 variant', blockBytes: 8, bc: 'DXT1', alpha: true }),
  11: Object.freeze({ label: 'BC2 / DXT3', blockBytes: 16, bc: 'DXT3', alpha: true }),
  12: Object.freeze({ label: 'BC3 / DXT5', blockBytes: 16, bc: 'DXT5', alpha: true }),
  23: Object.freeze({ label: 'A8', bytesPerPixel: 1, alpha: true }),
  43: Object.freeze({ label: 'BC5 / ATI2', blockBytes: 16, bc: 'BC5', alpha: false }),
})

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function knownFormat(id: number): TexFormat | undefined {
  return FORMATS[id]
}

function checkedImageBytes(width: number, height: number): number {
  const value = width * height * 4
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError('Diablo III TEX dimensions overflow')
  return value
}

function parseTex(bytes: Uint8Array, context: InspectionContext): Texture {
  if (bytes.byteLength < HEADER_BYTES) throw new TypeError('Diablo III TEX header is truncated')
  const view = viewOf(bytes)
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) {
    throw new TypeError('Diablo III TEX signature or version is invalid')
  }
  const pixelFormat = view.getUint32(0x20, true)
  const format = knownFormat(pixelFormat)
  if (format === undefined)
    throw new TypeError(`unsupported Diablo III TEX pixel format ${pixelFormat}`)
  const width = view.getUint32(0x24, true)
  const height = view.getUint32(0x28, true)
  const faces = view.getUint32(0x2c, true)
  if (width === 0 || height === 0 || width > 0x10000 || height > 0x10000) {
    throw new RangeError('Diablo III TEX dimensions are invalid')
  }
  if (faces === 0 || faces > 256) throw new RangeError('Diablo III TEX face count is invalid')
  const decodedBytes = checkedImageBytes(width, height)
  if (decodedBytes > context.budget.maxScalarBytes) {
    throw new RangeError('Diablo III TEX decoded image exceeds maxScalarBytes budget')
  }
  const mips: TexMip[] = []
  let tableEntries = 0
  for (let level = 0; level < MAX_MIPS; level += 1) {
    const offset = view.getUint32(MIP_TABLE + level * 8, true)
    const size = view.getUint32(MIP_TABLE + level * 8 + 4, true)
    if ((offset === 0) !== (size === 0))
      throw new TypeError(`Diablo III TEX mip ${level} has an incomplete range`)
    if (offset === 0) break
    tableEntries += 1
    // The installed game's table often lists more levels than the file holds; the chain ends at
    // the first one that does not fit (13 installed textures). Mip 0 must, or there is no image.
    if (mips.length < level) continue
    const mipWidth = Math.max(1, width >>> level)
    const mipHeight = Math.max(1, height >>> level)
    const expected =
      format.blockBytes === undefined
        ? mipWidth * mipHeight * format.bytesPerPixel
        : Math.ceil(mipWidth / 4) * Math.ceil(mipHeight / 4) * format.blockBytes
    // Pixels of every format start past a 16-byte rectangle (four floats, a UV frame); every face
    // of a level follows the previous one (installed cube maps: one rectangle, then six faces).
    const start = offset + 16
    const end = start + faces * size
    const truncated = !Number.isSafeInteger(expected) || size < expected
    const outside = !Number.isSafeInteger(end) || end > bytes.byteLength
    if (level === 0 && truncated) throw new RangeError('Diablo III TEX mip 0 is truncated')
    if (level === 0 && outside) throw new RangeError('Diablo III TEX mip 0 faces are out of bounds')
    if (truncated || outside) continue
    mips.push(
      Object.freeze({ level, offset, size, width: mipWidth, height: mipHeight, expected, start }),
    )
  }
  if (mips.length === 0) throw new TypeError('Diablo III TEX has no mip levels')
  if (mips.length > context.budget.maxNodes)
    throw new RangeError('Diablo III TEX mips exceed maxNodes budget')
  const frames = view.getUint32(0x218, true)
  const frameTableOffset = view.getUint32(0x21c, true)
  const frameTableSize = view.getUint32(0x220, true)
  if (
    frames > 1 &&
    (frameTableSize < frames * 80 || frameTableOffset + frameTableSize > bytes.byteLength)
  ) {
    throw new RangeError('Diablo III TEX frame table is out of bounds')
  }
  return Object.freeze({
    snoId: view.getInt32(0x10, true),
    pixelFormat,
    format,
    width,
    height,
    faces,
    flags: view.getUint32(0x30, true),
    extraMips: view.getUint32(0x34, true),
    mips: Object.freeze(mips),
    tableEntries,
    frames,
    frameTableOffset,
    frameTableSize,
    decodedBytes,
  })
}

function copyPart(
  source: Uint8Array,
  sourceOffset: number,
  target: Uint8Array,
  targetOffset: number,
  length: number,
): void {
  target.set(source.subarray(sourceOffset, sourceOffset + length), targetOffset)
}

function unshuffle(format: TexFormat, source: Uint8Array): Uint8Array {
  const blockBytes = format.blockBytes
  if (blockBytes === undefined || source.byteLength % blockBytes !== 0) {
    throw new TypeError('Diablo III TEX compressed payload has an invalid size')
  }
  const output = new Uint8Array(source.byteLength)
  const half = source.byteLength / 2
  const blocks = source.byteLength / blockBytes
  for (let index = 0; index < blocks; index += 1) {
    const target = index * blockBytes
    if (blockBytes === 8) {
      copyPart(source, index * 4, output, target, 4)
      copyPart(source, half + index * 4, output, target + 4, 4)
    } else if (format === FORMATS[11]) {
      copyPart(source, index * 8, output, target, 8)
      copyPart(source, half + index * 4, output, target + 8, 4)
      copyPart(source, half + half / 2 + index * 4, output, target + 12, 4)
    } else {
      copyPart(source, index * 2, output, target, 2)
      copyPart(source, half / 4 + index * 6, output, target + 2, 6)
      copyPart(source, half + index * 4, output, target + 8, 4)
      copyPart(source, half + half / 2 + index * 4, output, target + 12, 4)
    }
  }
  return output
}

function decodeCompressed(payload: Uint8Array, texture: Texture, mip: TexMip): Uint8Array {
  // Only a block format reaches here; the raw formats go to decodeRaw.
  if (texture.format.bc === undefined)
    throw new TypeError("Diablo III TEX block decode requires a block-compressed format")
  const pixels = decodeBcSurface(unshuffle(texture.format, payload), 0, mip.width, mip.height, texture.format.bc)
  if (!texture.format.alpha) for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255
  return pixels
}

function decodeRaw(payload: Uint8Array, texture: Texture, mip: TexMip): Uint8Array {
  const output = new Uint8Array(mip.width * mip.height * 4)
  const view = viewOf(payload)
  for (let pixel = 0; pixel < mip.width * mip.height; pixel += 1) {
    const target = pixel * 4
    if (texture.pixelFormat === 0) {
      output.set(
        [payload[target + 2]!, payload[target + 1]!, payload[target]!, payload[target + 3]!],
        target,
      )
    } else if (texture.pixelFormat === 4) {
      const value = view.getUint16(pixel * 2, true)
      output.set(
        [
          ((value >>> 8) & 0xf) * 17,
          ((value >>> 4) & 0xf) * 17,
          (value & 0xf) * 17,
          ((value >>> 12) & 0xf) * 17,
        ],
        target,
      )
    } else if (texture.pixelFormat === 7) {
      output.set([payload[pixel]!, payload[pixel]!, payload[pixel]!, 255], target)
    } else {
      output.set([255, 255, 255, payload[pixel]!], target)
    }
  }
  return output
}

function decodedFace(bytes: Uint8Array, texture: Texture, level: number, face: number): Uint8Array {
  const mip = texture.mips[level]
  if (mip === undefined) throw new RangeError(`Diablo III TEX mip ${level} is not present`)
  if (!Number.isSafeInteger(face) || face < 0 || face >= texture.faces)
    throw new RangeError(`Diablo III TEX face ${face} is not present`)
  const compressed = texture.format.blockBytes !== undefined
  const offset = mip.start + face * mip.size
  const payload = bytes.subarray(offset, offset + mip.expected)
  return compressed ? decodeCompressed(payload, texture, mip) : decodeRaw(payload, texture, mip)
}

/**
 * The frames of an atlas in mip-0 pixels, rounded and clamped as MK2's cropFrame did. The frame
 * table's rectangles come first (the installed game leaves entry 0 empty), then the rectangle before
 * the mip-0 pixels, which in an atlas is one more frame; empty rectangles are skipped.
 */
function atlasRegions(bytes: Uint8Array, texture: Texture): RasterAtlasRegion[] {
  if (texture.frames <= 1) return []
  const view = viewOf(bytes)
  const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit, Math.round(value * limit)))
  const region = (offset: number, name: string) => {
    const [left, top, right, bottom] = [0, 4, 8, 12].map(delta => view.getFloat32(offset + delta, true))
    const x = clamp(left!, texture.width)
    const y = clamp(top!, texture.height)
    return { x, y, width: Math.max(0, clamp(right!, texture.width) - x), height: Math.max(0, clamp(bottom!, texture.height) - y), name }
  }
  return [
    ...Array.from({ length: texture.frames }, (_, frame) => region(texture.frameTableOffset + frame * 80, `frame ${frame}`)),
    region(texture.mips[0]!.offset, 'mip-0 rectangle'),
  ].filter(item => item.width > 0 && item.height > 0)
}

function regionReader(bytes: Uint8Array, texture: Texture) {
  const cache = new Map<string, Uint8Array>()
  return async (request: RasterRegionRequest) => {
    const values = [request.x, request.y, request.width, request.height, request.maxBytes]
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0))
      throw new TypeError('Diablo III TEX region values must be non-negative safe integers')
    if (
      request.pixelFormat !== 'rgba8' ||
      (request.frame ?? 0) !== 0 ||
      (request.layer ?? 0) !== 0 ||
      (request.slice ?? 0) !== 0
    ) {
      throw new RangeError(
        'Diablo III TEX exposes RGBA8 mip/face data for frame, layer, and slice zero',
      )
    }
    const level = request.mipLevel ?? 0
    const face = request.face ?? 0
    const mip = texture.mips[level]
    if (mip === undefined) throw new RangeError(`Diablo III TEX mip ${level} is not present`)
    if (request.x + request.width > mip.width || request.y + request.height > mip.height)
      throw new RangeError('Diablo III TEX region is outside the image')
    const length = request.width * request.height * 4
    if (!Number.isSafeInteger(length) || length > request.maxBytes)
      throw new RangeError('Diablo III TEX region exceeds maxBytes')
    const key = `${level}/${face}`
    let decoded = cache.get(key)
    if (decoded === undefined) {
      decoded = decodedFace(bytes, texture, level, face)
      cache.set(key, decoded)
    }
    const pixels = new Uint8Array(length)
    for (let row = 0; row < request.height; row += 1) {
      const start = ((request.y + row) * mip.width + request.x) * 4
      pixels.set(decoded.subarray(start, start + request.width * 4), row * request.width * 4)
    }
    return Object.freeze({
      width: request.width,
      height: request.height,
      rowStride: request.width * 4,
      pixelFormat: 'rgba8',
      pixels,
    })
  }
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'diablo3-tex',
    label: 'Diablo III TEX texture',
    mediaType: 'image/x-diablo3-tex',
  }),
  async detect(prefix: Uint8Array) {
    if (prefix.byteLength < 0x30) return { confidence: 0, kind: 'magic', note: 'header-truncated' }
    const view = viewOf(prefix)
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION)
      return { confidence: 0, kind: 'magic', note: 'signature-mismatch' }
    // other SNO groups share version 47 (an EffectGroup does): a texture also names a pixel format
    // and two dimensions
    const width = view.getUint32(0x24, true)
    const height = view.getUint32(0x28, true)
    return knownFormat(view.getUint32(0x20, true)) !== undefined && width > 0 && height > 0 && width <= 0x10000 && height <= 0x10000
      ? { confidence: 0.99, kind: 'magic', note: 'deadbeef-v47' }
      : { confidence: 0, kind: 'magic', note: 'not-a-texture-header' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const texture = parseTex(bytes, context)
    const regions = atlasRegions(bytes, texture)
    const raster = createRasterImageSource(
      bytes,
      'image/x-diablo3-tex',
      {
        width: texture.width,
        height: texture.height,
        depth: 1,
        layers: 1,
        faces: texture.faces,
        mipLevels: texture.mips.length,
        // An atlas is one image whose frames are regions of it, cropped with readRegion.
        frames: regions.length > 0 ? 1 : Math.max(1, texture.frames),
        channels: 4,
        bitDepth: 8,
        colorSpace: texture.pixelFormat === 43 ? 'linear' : 'srgb',
        alphaMode: texture.format.alpha ? 'straight' : 'none',
        orientation: 'top-left',
        decodedAccess: true,
        ...(regions.length > 0 ? { atlasRegions: regions } : {}),
      },
      regionReader(bytes, texture),
    )
    return {
      summary: {
        format: 'diablo3-tex',
        version: VERSION,
        snoId: texture.snoId,
        width: texture.width,
        height: texture.height,
        faces: texture.faces,
        mipLevels: texture.mips.length,
        frames: texture.frames,
        pixelFormat: texture.format.label,
        decodedAccess: true,
      },
      metadata: [
        {
          id: 'diablo3-tex-header',
          label: 'Diablo III TEX texture',
          entries: [
            { key: 'version', value: VERSION },
            { key: 'snoId', value: texture.snoId },
            { key: 'dimensions', value: `${texture.width}x${texture.height}` },
            { key: 'faces', value: texture.faces },
            { key: 'pixelFormat', value: texture.format.label },
            { key: 'mipLevels', value: texture.mips.length },
            { key: 'mipTableEntries', value: texture.tableEntries },
            { key: 'frames', value: texture.frames },
            { key: 'flags', value: texture.flags },
          ],
        },
      ],
      traits: [
        {
          id: 'image.raster',
          parameters: { width: texture.width, height: texture.height, bitDepth: 8 },
        },
        { id: 'image.channels', parameters: { count: 4, alpha: texture.format.alpha } },
        { id: 'content.binary', parameters: { version: VERSION } },
      ],
      maxDecodedBytes: texture.decodedBytes,
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'image',
          label: 'Diablo III TEX',
          preview: `${texture.width} × ${texture.height}; ${texture.format.label}`,
          children: texture.mips.map(mip => ({
            kind: 'mip',
            label: `Mip ${mip.level}`,
            preview: `${mip.width} × ${mip.height}; ${mip.size} bytes at ${mip.offset}`,
          })),
        }),
        'common.view/raster-image-source': raster,
      },
      unsupportedFeatures: ['texture-writing', 'mip-generation'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
