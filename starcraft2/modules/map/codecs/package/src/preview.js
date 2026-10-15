import { adler32 } from '@modkit/codec-kit/compression'
import { crc32 } from '@modkit/codec-kit/checksum'

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEADER_BYTES = 32
const MAX_DIMENSION = 65_536

export const SC2_MAP_PREVIEW_PROVENANCE = Object.freeze({
  legacyCommit: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
  legacyDispatch: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/codec.ts',
  legacyRasterizer: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/image/map-image.ts',
  legacyPng: 'extensions/blizzard/starcraft-2/codecs/sc2-map/src/image/png.ts',
})

function checkedProduct(left, right, maximum, label) {
  const value = left * right
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} exceeds the preview budget`)
  }
  return value
}

function gridHeader(bytes, expectedMagic, stride, limits) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES) {
    throw new TypeError(`${expectedMagic} preview source is truncated`)
  }
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4))
  if (magic !== expectedMagic) {
    throw new TypeError(`${expectedMagic} preview source has ${magic || 'no'} magic`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(`${expectedMagic} preview dimensions are invalid`)
  }
  const cells = checkedProduct(width, height, limits.maxNodes, `${expectedMagic} cell count`)
  const required = HEADER_BYTES + cells * stride
  if (!Number.isSafeInteger(required) || required > bytes.byteLength) {
    throw new TypeError(`${expectedMagic} preview source is truncated`)
  }
  return Object.freeze({ view, width, height, cells })
}

// A deterministic zlib stream containing only RFC 1951 stored blocks keeps this renderer
// portable without adding a compression runtime to the codec's browser-worker variant.
function zlibStored(bytes) {
  const blocks = Math.ceil(bytes.byteLength / 65_535)
  const output = new Uint8Array(2 + bytes.byteLength + blocks * 5 + 4)
  output[0] = 0x78
  output[1] = 0x01
  let sourceOffset = 0
  let outputOffset = 2
  for (let block = 0; block < blocks; block += 1) {
    const length = Math.min(65_535, bytes.byteLength - sourceOffset)
    output[outputOffset] = block === blocks - 1 ? 1 : 0
    output[outputOffset + 1] = length & 0xff
    output[outputOffset + 2] = length >>> 8
    const complement = ~length & 0xffff
    output[outputOffset + 3] = complement & 0xff
    output[outputOffset + 4] = complement >>> 8
    output.set(bytes.subarray(sourceOffset, sourceOffset + length), outputOffset + 5)
    sourceOffset += length
    outputOffset += length + 5
  }
  new DataView(output.buffer).setUint32(outputOffset, adler32(bytes), false)
  return output
}

function chunk(type, data) {
  const output = new Uint8Array(12 + data.byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, data.byteLength, false)
  for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index)
  output.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(output.subarray(4, 8 + data.byteLength)), false)
  return output
}

function png(width, height, bitDepth, colorType, pixels, limits) {
  const channels = colorType === 2 ? 3 : 1
  const rowBytes = checkedProduct(
    width,
    channels * (bitDepth / 8),
    limits.maxScalarBytes,
    'PNG row',
  )
  const rawBytes = checkedProduct(rowBytes + 1, height, limits.maxScalarBytes, 'PNG scanlines')
  if (pixels.byteLength !== rowBytes * height) throw new TypeError('PNG pixel buffer is incomplete')
  const raw = new Uint8Array(rawBytes)
  for (let row = 0; row < height; row += 1) {
    raw.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1)
  }
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width, false)
  headerView.setUint32(4, height, false)
  header[8] = bitDepth
  header[9] = colorType
  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array()),
  ]
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  if (size > limits.maxScalarBytes) throw new RangeError('PNG output exceeds maxScalarBytes')
  const output = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

export function renderSc2HeightPreview(bytes, limits) {
  const grid = gridHeader(bytes, 'HMAP', 6, limits)
  const pixels = new Uint8Array(grid.cells * 2)
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const sourceIndex = y * grid.width + x
      const outputIndex = ((grid.height - 1 - y) * grid.width + x) * 2
      const height = grid.view.getUint16(HEADER_BYTES + sourceIndex * 6, true)
      pixels[outputIndex] = height >>> 8
      pixels[outputIndex + 1] = height & 0xff
    }
  }
  return png(grid.width, grid.height, 16, 0, pixels, limits)
}

const PATH_COLORS = Object.freeze({
  0x00: Object.freeze([42, 154, 99]),
  0x02: Object.freeze([230, 181, 70]),
  0x23: Object.freeze([45, 49, 57]),
  unknown: Object.freeze([177, 82, 178]),
})

export function renderSc2PathingPreview(bytes, limits) {
  const grid = gridHeader(bytes, 'PATH', 2, limits)
  const pixels = new Uint8Array(grid.cells * 3)
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const sourceIndex = y * grid.width + x
      const outputIndex = ((grid.height - 1 - y) * grid.width + x) * 3
      const value = grid.view.getUint16(HEADER_BYTES + sourceIndex * 2, true)
      const color = PATH_COLORS[value] ?? PATH_COLORS.unknown
      pixels.set(color, outputIndex)
    }
  }
  return png(grid.width, grid.height, 8, 2, pixels, limits)
}

function normalizeLayer(input) {
  if (input === undefined || input === null) return 'auto'
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('SC2 map preview requires an object input')
  }
  const layer = input.layer ?? 'auto'
  if (layer !== 'auto' && layer !== 'height' && layer !== 'pathing') {
    throw new TypeError(`SC2 map preview layer ${String(layer)} is not supported by MK3`)
  }
  return layer
}

function entryByBasename(archive, names) {
  const accepted = new Set(names)
  return archive.entries.find(entry => {
    const name = entry.path.replaceAll('\\', '/').split('/').at(-1)?.toLocaleLowerCase()
    return name !== undefined && accepted.has(name)
  })
}

export function renderSc2MapPreview(bytes, archive, input, limits, readEntry) {
  const layer = normalizeLayer(input)
  if (layer === 'auto' || layer === 'height') {
    const entry = entryByBasename(archive, ['t3heightmap', 'mapheightmap'])
    if (entry !== undefined)
      return renderSc2HeightPreview(readEntry(bytes, archive, entry.path), limits)
    if (layer === 'height') throw new TypeError('SC2 map has no HMAP document')
  }
  if (layer === 'auto' || layer === 'pathing') {
    const entry = entryByBasename(archive, ['t3syncpathinginfo', 'mappathinginfo'])
    if (entry !== undefined)
      return renderSc2PathingPreview(readEntry(bytes, archive, entry.path), limits)
    if (layer === 'pathing') throw new TypeError('SC2 map has no PATH document')
  }
  throw new TypeError('SC2 map has no supported HMAP or PATH preview document')
}

export async function renderSc2MapNamespacePreview(entries, readEntry, input, limits) {
  const layer = normalizeLayer(input)
  if (layer === 'auto' || layer === 'height') {
    const entry = entryByBasename({ entries }, ['t3heightmap', 'mapheightmap'])
    if (entry !== undefined) return renderSc2HeightPreview(await readEntry(entry.path), limits)
    if (layer === 'height') throw new TypeError('SC2 map has no HMAP document')
  }
  if (layer === 'auto' || layer === 'pathing') {
    const entry = entryByBasename({ entries }, ['t3syncpathinginfo', 'mappathinginfo'])
    if (entry !== undefined) return renderSc2PathingPreview(await readEntry(entry.path), limits)
    if (layer === 'pathing') throw new TypeError('SC2 map has no PATH document')
  }
  throw new TypeError('SC2 map has no supported HMAP or PATH preview document')
}
