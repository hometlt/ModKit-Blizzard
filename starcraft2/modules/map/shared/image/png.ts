/**
 * Minimal PNG codec — just what map data needs: 16-bit grayscale (for height /
 * cliff levels) and 8-bit RGB (for texture/pathing visualizations).
 *
 * Browser-safe: uses `fflate` for the IDAT zlib stream and `DataView`/typed arrays
 * for everything else. Encoding writes a single `None`-filtered, non-interlaced
 * image; decoding handles all five PNG filter types so images produced by
 * external editors round-trip in.
 */

import { unzlibSync, zlibSync } from 'fflate'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// --- CRC32 (PNG polynomial) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type ColorType = 0 | 2 // grayscale | RGB

function channelsOf(colorType: ColorType): number {
  return colorType === 2 ? 3 : 1
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcRegion = out.subarray(4, 8 + data.length)
  dv.setUint32(8 + data.length, crc32(crcRegion), false)
  return out
}

interface EncodeInput {
  width: number
  height: number
  bitDepth: 8 | 16
  colorType: ColorType
  /** Raw sample bytes, row-major, big-endian for 16-bit, no filter bytes. */
  pixels: Uint8Array
}

function encode({ width, height, bitDepth, colorType, pixels }: EncodeInput): Uint8Array {
  const channels = channelsOf(colorType)
  const bytesPerPixel = channels * (bitDepth / 8)
  const rowBytes = width * bytesPerPixel
  if (pixels.length !== rowBytes * height) {
    throw new Error(`PNG encode: expected ${rowBytes * height} pixel bytes, got ${pixels.length}`)
  }

  // Prefix each scanline with filter byte 0 (None).
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width, false)
  dv.setUint32(4, height, false)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const idat = zlibSync(raw)

  const parts = [
    Uint8Array.from(SIGNATURE),
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export interface DecodedPng {
  width: number
  height: number
  bitDepth: number
  colorType: number
  channels: number
  /** Unfiltered raw samples, row-major, big-endian for 16-bit. */
  pixels: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function decodePng(png: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIGNATURE[i]) throw new Error('decodePng: not a PNG (bad signature)')
  }
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatParts: Uint8Array[] = []

  while (off + 8 <= png.length) {
    const len = dv.getUint32(off, false)
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!)
    const body = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength)
      width = h.getUint32(0, false)
      height = h.getUint32(4, false)
      bitDepth = body[8]!
      colorType = body[9]!
      if (body[12] !== 0) throw new Error('decodePng: interlaced PNGs are not supported')
    } else if (type === 'IDAT') {
      idatParts.push(body.slice())
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  const channels = channelsOf((colorType as ColorType) === 2 ? 2 : 0)
  const bytesPerPixel = channels * (bitDepth / 8)
  const rowBytes = width * bytesPerPixel

  // Concatenate + inflate IDAT.
  let idatLen = 0
  for (const p of idatParts) idatLen += p.length
  const idat = new Uint8Array(idatLen)
  {
    let o = 0
    for (const p of idatParts) {
      idat.set(p, o)
      o += p.length
    }
  }
  const raw = unzlibSync(idat)

  // Unfilter into a tightly-packed sample buffer.
  const out = new Uint8Array(rowBytes * height)
  const bpp = Math.max(1, bytesPerPixel)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!
    const rowIn = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes)
    const rowOut = out.subarray(y * rowBytes, (y + 1) * rowBytes)
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : undefined
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = rowIn[x]!
      const a = x >= bpp ? rowOut[x - bpp]! : 0
      const b = prev ? prev[x]! : 0
      const c = prev && x >= bpp ? prev[x - bpp]! : 0
      let val: number
      switch (filter) {
        case 0:
          val = rawByte
          break
        case 1:
          val = rawByte + a
          break
        case 2:
          val = rawByte + b
          break
        case 3:
          val = rawByte + ((a + b) >> 1)
          break
        case 4:
          val = rawByte + paeth(a, b, c)
          break
        default:
          throw new Error(`decodePng: unknown filter ${filter}`)
      }
      rowOut[x] = val & 0xff
    }
  }

  return { width, height, bitDepth, colorType, channels, pixels: out }
}

// --- typed convenience wrappers ---

/** Encode a 16-bit grayscale PNG from row-major `samples` (length width*height). */
export function encodeGray16(width: number, height: number, samples: Uint16Array): Uint8Array {
  if (samples.length !== width * height) {
    throw new Error(`encodeGray16: expected ${width * height} samples, got ${samples.length}`)
  }
  const pixels = new Uint8Array(width * height * 2)
  for (let i = 0; i < samples.length; i++) {
    pixels[i * 2] = (samples[i]! >> 8) & 0xff // big-endian
    pixels[i * 2 + 1] = samples[i]! & 0xff
  }
  return encode({ width, height, bitDepth: 16, colorType: 0, pixels })
}

/** Decode a 16-bit grayscale PNG to row-major samples. */
export function decodeGray16(png: Uint8Array): { width: number; height: number; samples: Uint16Array } {
  const d = decodePng(png)
  if (d.bitDepth !== 16 || d.colorType !== 0) {
    throw new Error(`decodeGray16: expected 16-bit grayscale, got bitDepth ${d.bitDepth} colorType ${d.colorType}`)
  }
  const samples = new Uint16Array(d.width * d.height)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (d.pixels[i * 2]! << 8) | d.pixels[i * 2 + 1]!
  }
  return { width: d.width, height: d.height, samples }
}

/** Encode an 8-bit RGB PNG from row-major `rgb` (length width*height*3). */
export function encodeRGB8(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodeRGB8: expected ${width * height * 3} bytes, got ${rgb.length}`)
  }
  return encode({ width, height, bitDepth: 8, colorType: 2, pixels: rgb })
}
