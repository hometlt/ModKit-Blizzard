// Blizzard BLP1/BLP2 read-only raster codec: validates headers/mip ranges and exposes top-mip
// RGBA regions for palettised, BLP2 BC/BGRA and baseline JPEG BLP1 (shared header, B/G/R/alpha
// planes via codec-kit). Decoding is lazy, bounded by the scalar/region budgets and cached per
// session. Progressive JPEG and BLP2 JPEG decoding are unsupported; no native texture writer.

import {
  createInspectionCodec,
  createRasterImageSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import { decodeBcSurface } from '@modkit/codec-kit/texture/bc'
import { decodeBaselineJpegPlanes } from '@modkit/codec-kit/raster/jpeg'

const ID = 'blizzard/blp'
const BLP1_HEADER_BYTES = 156
const BLP2_HEADER_BYTES = 148
const PALETTE_BYTES = 256 * 4
/** A JPEG header segment longer than this is not a header this format writes. */
const MAX_JPEG_HEADER_BYTES = 64 * 1024
const ascii = new TextDecoder('latin1')

function magic(bytes) {
  return bytes.byteLength < 4 ? '' : ascii.decode(bytes.subarray(0, 4))
}

function encodingLabel(value) {
  return value === 0
    ? 'jpeg'
    : value === 1
      ? 'paletted'
      : value === 2
        ? 'dxt/bcn'
        : value === 3
          ? 'bgra8'
          : `unknown-${value}`
}

function mipTable(data, offsetsAt, sizesAt, bytes) {
  const mips = []
  for (let level = 0; level < 16; level += 1) {
    const offset = data.getUint32(offsetsAt + level * 4, true)
    const size = data.getUint32(sizesAt + level * 4, true)
    if ((offset === 0) !== (size === 0))
      throw new TypeError(`BLP mip ${level} has an incomplete range`)
    if (offset === 0) continue
    if (offset + size > bytes.byteLength) throw new RangeError(`BLP mip ${level} is out of bounds`)
    mips.push(Object.freeze({ level, offset, size }))
  }
  return Object.freeze(mips)
}

function parseBlp(bytes, context) {
  const id = magic(bytes)
  const headerBytes = id === 'BLP1' ? BLP1_HEADER_BYTES : id === 'BLP2' ? BLP2_HEADER_BYTES : 0
  if (headerBytes === 0) throw new TypeError('BLP signature is invalid')
  if (bytes.byteLength < headerBytes) throw new RangeError(`${id} header is truncated`)
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = data.getUint32(12, true)
  const height = data.getUint32(16, true)
  if (width === 0 || height === 0) throw new TypeError('BLP dimensions must be positive')
  const decodedBytes = width * height * 4
  if (!Number.isSafeInteger(decodedBytes))
    throw new RangeError('BLP dimensions exceed safe integer range')
  const common = {
    id,
    width,
    height,
    decodedBytes,
    type: data.getUint32(4, true),
  }
  if (id === 'BLP1') {
    const alphaDepth = data.getUint32(8, true)
    if (![0, 1, 4, 8].includes(alphaDepth))
      throw new TypeError(`unsupported BLP1 alpha depth ${alphaDepth}`)
    const type = data.getUint32(4, true)
    const mips = mipTable(data, 28, 92, bytes)
    // A palettised BLP1 stores its 256-entry BGRA palette immediately after the header; a JPEG
    // BLP1 stores a shared JPEG header there instead, which every mip payload is appended to.
    const paletteOffset = BLP1_HEADER_BYTES
    let jpegHeaderOffset = 0
    let jpegHeaderSize = 0
    let decodedAccess = false
    if (type === 1) {
      decodedAccess = paletteOffset + PALETTE_BYTES <= bytes.byteLength && mips.length > 0
      if (decodedAccess)
        checkPalettised(bytes, mips, width, height, alphaDepth, decodedBytes, context)
    } else if (type === 0 && BLP1_HEADER_BYTES + 4 <= bytes.byteLength) {
      jpegHeaderSize = data.getUint32(BLP1_HEADER_BYTES, true)
      jpegHeaderOffset = BLP1_HEADER_BYTES + 4
      decodedAccess =
        mips.length > 0 &&
        jpegHeaderSize <= MAX_JPEG_HEADER_BYTES &&
        jpegHeaderOffset + jpegHeaderSize <= bytes.byteLength
      if (decodedAccess && decodedBytes > context.budget.maxScalarBytes)
        throw new RangeError('BLP decoded image exceeds maxScalarBytes budget')
    }
    return Object.freeze({
      ...common,
      encoding: type === 0 ? 'jpeg' : type === 1 ? 'paletted' : `unknown-${type}`,
      layout: type === 1 ? 'paletted' : 'jpeg',
      alphaDepth,
      alphaEncoding: data.getUint32(20, true),
      hasMipmaps: data.getUint32(24, true) !== 0,
      mips,
      paletteOffset,
      jpegHeaderOffset,
      jpegHeaderSize,
      decodedAccess,
    })
  }
  const encodingId = bytes[8] ?? 0
  const alphaDepth = bytes[9] ?? 0
  if (![0, 1, 4, 8].includes(alphaDepth))
    throw new TypeError(`unsupported BLP2 alpha depth ${alphaDepth}`)
  const mips = mipTable(data, 20, 84, bytes)
  const alphaEncoding = bytes[10] ?? 0
  const paletteOffset = BLP2_HEADER_BYTES
  const layout =
    encodingId === 3
      ? 'bgra'
      : encodingId === 1
        ? 'paletted'
        : encodingId === 2
          ? 'block'
          : 'jpeg'
  const top = mips.find(mip => mip.level === 0)
  let decodedAccess = false
  if (top !== undefined) {
    if (layout === 'bgra') {
      if (top.size < decodedBytes) throw new RangeError('BLP2 BGRA top mip is truncated')
      if (decodedBytes > context.budget.maxScalarBytes)
        throw new RangeError('BLP2 decoded image exceeds maxScalarBytes budget')
      decodedAccess = true
    } else if (layout === 'paletted') {
      decodedAccess = paletteOffset + PALETTE_BYTES <= bytes.byteLength
      if (decodedAccess)
        checkPalettised(bytes, mips, width, height, alphaDepth, decodedBytes, context)
    } else if (layout === 'block') {
      const format = blockFormat(alphaEncoding)
      if (format !== undefined) {
        if (top.size < blockBytes(width, height, format))
          throw new RangeError('BLP2 block-compressed top mip is truncated')
        if (decodedBytes > context.budget.maxScalarBytes)
          throw new RangeError('BLP2 decoded image exceeds maxScalarBytes budget')
        decodedAccess = true
      }
    }
  }
  return Object.freeze({
    ...common,
    encoding: encodingLabel(encodingId),
    encodingId,
    layout,
    alphaDepth,
    alphaEncoding,
    hasMipmaps: (bytes[11] ?? 0) !== 0,
    mips,
    paletteOffset,
    decodedAccess,
  })
}

/**
 * A palettised BLP stores one byte of palette index per pixel, optionally followed by a plane of
 * alpha at 1, 4 or 8 bits. The size check is the same for BLP1 and BLP2, so it lives here.
 */
function checkPalettised(bytes, mips, width, height, alphaDepth, decodedBytes, context) {
  const top = mips.find(mip => mip.level === 0)
  if (top === undefined) throw new TypeError('palettised BLP top mip is missing')
  const indexBytes = width * height
  const alphaBytes = Math.ceil((indexBytes * alphaDepth) / 8)
  if (top.size < indexBytes + alphaBytes)
    throw new RangeError('palettised BLP top mip is truncated')
  if (decodedBytes > context.budget.maxScalarBytes)
    throw new RangeError('BLP decoded image exceeds maxScalarBytes budget')
}

/** BLP2 names its block format in the alpha-encoding byte, the way the format documents it. */
function blockFormat(alphaEncoding) {
  return alphaEncoding === 0 || alphaEncoding === 1
    ? 'DXT1'
    : alphaEncoding === 2
      ? 'DXT3'
      : alphaEncoding === 7
        ? 'DXT5'
        : undefined
}

function blockBytes(width, height, format) {
  const perBlock = format === 'DXT1' ? 8 : 16
  return Math.ceil(width / 4) * Math.ceil(height / 4) * perBlock
}

/** Decode the top mip once, into straight RGBA, whichever layout the file uses. */
function decodeTopMip(bytes, texture) {
  const top = texture.mips.find(mip => mip.level === 0)
  if (top === undefined) throw new TypeError('BLP top mip is missing')
  const { width, height, layout } = texture
  const pixels = new Uint8Array(width * height * 4)
  if (layout === 'bgra') {
    for (let index = 0; index < width * height; index += 1) {
      const source = top.offset + index * 4
      const target = index * 4
      pixels[target] = bytes[source + 2] ?? 0
      pixels[target + 1] = bytes[source + 1] ?? 0
      pixels[target + 2] = bytes[source] ?? 0
      pixels[target + 3] = bytes[source + 3] ?? 255
    }
    return pixels
  }
  if (layout === 'block') {
    const format = blockFormat(texture.alphaEncoding)
    if (format === undefined) throw new TypeError('BLP block format is not decoded here')
    const rgba = decodeBcSurface(bytes, top.offset, width, height, format)
    pixels.set(rgba.subarray(0, pixels.length))
    // DXT1 without alpha still writes 255; the alpha depth says whether it means anything.
    if (texture.alphaDepth === 0)
      for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255
    return pixels
  }
  if (layout === 'jpeg') return decodeJpegMip(bytes, texture, top)
  if (layout !== 'paletted') throw new TypeError('BLP payload layout is not decoded here')
  const palette = texture.paletteOffset
  const indexBytes = width * height
  const alphaAt = top.offset + indexBytes
  for (let index = 0; index < indexBytes; index += 1) {
    const entry = palette + (bytes[top.offset + index] ?? 0) * 4
    const target = index * 4
    // Palette entries are BGRA, like every other Blizzard palette.
    pixels[target] = bytes[entry + 2] ?? 0
    pixels[target + 1] = bytes[entry + 1] ?? 0
    pixels[target + 2] = bytes[entry] ?? 0
    pixels[target + 3] = paletteAlpha(bytes, alphaAt, index, texture.alphaDepth)
  }
  return pixels
}

/**
 * A JPEG-compressed BLP mip.
 *
 * The file stores one JPEG header shared by every mip, so the complete stream is that header
 * followed by this mip's payload. Blizzard writes four components and defines their order
 * itself — blue, green, red, then the alpha mask — which is why the shared decoder hands back
 * planes rather than guessing a colour model for a four-channel JPEG.
 */
function decodeJpegMip(bytes, texture, top) {
  const header = bytes.subarray(
    texture.jpegHeaderOffset,
    texture.jpegHeaderOffset + texture.jpegHeaderSize,
  )
  const payload = bytes.subarray(top.offset, top.offset + top.size)
  const stream = new Uint8Array(header.byteLength + payload.byteLength)
  stream.set(header, 0)
  stream.set(payload, header.byteLength)
  const decoded = decodeBaselineJpegPlanes(stream, {
    maxBytes: texture.width * texture.height * 8,
  })
  if (decoded.width !== texture.width || decoded.height !== texture.height)
    throw new TypeError('BLP JPEG mip does not match the declared image size')
  const [blue, green, red, alpha] = decoded.planes.map(plane => plane.samples)
  if (blue === undefined || green === undefined || red === undefined)
    throw new TypeError('BLP JPEG mip carries fewer than three components')
  const pixels = new Uint8Array(texture.width * texture.height * 4)
  for (let index = 0; index < texture.width * texture.height; index += 1) {
    const target = index * 4
    pixels[target] = red[index] ?? 0
    pixels[target + 1] = green[index] ?? 0
    pixels[target + 2] = blue[index] ?? 0
    // The fourth channel is the alpha mask, and only when the header says there is one.
    pixels[target + 3] = texture.alphaDepth > 0 && alpha !== undefined ? (alpha[index] ?? 255) : 255
  }
  return pixels
}

function paletteAlpha(bytes, alphaAt, index, alphaDepth) {
  if (alphaDepth === 0) return 255
  if (alphaDepth === 8) return bytes[alphaAt + index] ?? 255
  if (alphaDepth === 4) {
    const packed = bytes[alphaAt + (index >>> 1)] ?? 0
    return (((index & 1) === 0 ? packed & 0xf : packed >>> 4) * 255) / 15
  }
  const packed = bytes[alphaAt + (index >>> 3)] ?? 0
  return ((packed >>> (index & 7)) & 1) === 0 ? 0 : 255
}

function regionReader(bytes, texture) {
  let decoded
  return async request => {
    const values = [request.x, request.y, request.width, request.height, request.maxBytes]
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError('BLP region coordinates must be non-negative safe integers')
    }
    if (
      request.pixelFormat !== 'rgba8' ||
      (request.frame ?? 0) !== 0 ||
      (request.mipLevel ?? 0) !== 0 ||
      (request.layer ?? 0) !== 0 ||
      (request.face ?? 0) !== 0 ||
      (request.slice ?? 0) !== 0
    ) {
      throw new RangeError('BLP exposes only mip/layer/face/slice zero as rgba8')
    }
    if (request.x + request.width > texture.width || request.y + request.height > texture.height) {
      throw new RangeError('BLP region is outside the image')
    }
    const outputBytes = request.width * request.height * 4
    if (!Number.isSafeInteger(outputBytes) || outputBytes > request.maxBytes) {
      throw new RangeError('BLP region exceeds maxBytes')
    }
    // The whole top mip is decoded once and then windowed: a block-compressed or palettised
    // layout cannot be addressed per pixel without decoding the block or palette entry anyway.
    decoded ??= decodeTopMip(bytes, texture)
    const pixels = new Uint8Array(outputBytes)
    for (let row = 0; row < request.height; row += 1) {
      const sourceRow = (request.y + row) * texture.width + request.x
      pixels.set(
        decoded.subarray(sourceRow * 4, (sourceRow + request.width) * 4),
        row * request.width * 4,
      )
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
  format: Object.freeze({ id: 'blp', label: 'Blizzard BLP texture', mediaType: 'image/x-blp' }),
  async detect(prefix) {
    const id = magic(prefix)
    return id === 'BLP1' || id === 'BLP2'
      ? { confidence: 0.99, kind: 'magic', note: id.toLowerCase() }
      : { confidence: 0, kind: 'magic', note: 'blp-signature-mismatch' }
  },
  async inspect(bytes, context) {
    const texture = parseBlp(bytes, context)
    const raster = createRasterImageSource(
      bytes,
      'image/x-blp',
      {
        width: texture.width,
        height: texture.height,
        depth: 1,
        layers: 1,
        faces: 1,
        mipLevels: Math.max(1, texture.mips.length),
        frames: 1,
        channels: texture.alphaDepth > 0 ? 4 : 3,
        bitDepth: 8,
        colorSpace: 'srgb',
        alphaMode: texture.alphaDepth > 0 ? 'straight' : 'none',
        orientation: 'top-left',
        decodedAccess: texture.decodedAccess,
      },
      texture.decodedAccess ? regionReader(bytes, texture) : undefined,
    )
    return {
      summary: {
        format: 'blp',
        version: texture.id,
        width: texture.width,
        height: texture.height,
        encoding: texture.encoding,
        alphaDepth: texture.alphaDepth,
        alphaEncoding: texture.alphaEncoding,
        mipLevels: texture.mips.length,
        decodedAccess: texture.decodedAccess,
      },
      metadata: [
        {
          id: 'blp-header',
          label: `${texture.id} texture`,
          entries: [
            { key: 'version', value: texture.id },
            { key: 'dimensions', value: `${texture.width}x${texture.height}` },
            { key: 'encoding', value: texture.encoding },
            { key: 'alphaDepth', value: texture.alphaDepth },
            { key: 'alphaEncoding', value: texture.alphaEncoding },
            { key: 'hasMipmaps', value: texture.hasMipmaps },
            { key: 'mipLevels', value: texture.mips.length },
            { key: 'decodedAccess', value: texture.decodedAccess },
          ],
        },
      ],
      traits: [
        {
          id: 'image.raster',
          parameters: { width: texture.width, height: texture.height, bitDepth: 8 },
        },
        {
          id: 'image.channels',
          parameters: { count: texture.alphaDepth > 0 ? 4 : 3, alpha: texture.alphaDepth > 0 },
        },
        { id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } },
      ],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'image',
          label: texture.id,
          preview: `${texture.width} × ${texture.height}; ${texture.encoding}`,
          children: texture.mips.map(mip => ({
            kind: 'mip',
            label: `Mip ${mip.level}`,
            preview: `${mip.size} bytes at ${mip.offset}`,
          })),
        }),
        'common.view/raster-image-source': raster,
      },
      ...(texture.decodedAccess ? { maxDecodedBytes: texture.decodedBytes } : {}),
      unsupportedFeatures: [
        ...(texture.decodedAccess ? [] : ['pixel-decoding-for-this-encoding']),
        'texture-writing',
        'mip-generation',
      ],
    }
  },
})

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition, context)
