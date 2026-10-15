/**
 * StarCraft GRP codec (`.grp`): a sprite's frames as one raster source with a frame per GRP frame,
 * each on the sprite's canvas. A GRP has no palette: the game draws units with the palette of the
 * map's tileset, so the host binds the `*.wpe` palettes near the file (the installation's
 * `tileset\*.wpe`) and the codec draws with the one the `palette` setting names — a tileset such as
 * `jungle` — or else Badlands. Without a palette the indices draw in grey. Player colours (the
 * remap the game applies to indices 8–15) are not applied.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { createInspectionCodec, createRasterImageSource, createTreeDataSource, readBoundCompanions } from '@modkit/codec-kit'
import { applyPalette, parsePalette } from '@modkit/codec-kit/raster/palette'
import type { RasterRegionRequest } from '@modkit/sdk'
import { fileNameOf } from '../uri.js'
import { decodeGrpFrame, readGrp, type Grp } from './grp.js'

const PALETTE = 'palette'
const DEFAULT_TILESET = 'badlands'
/** A tileset palette is 256 RGBx entries; anything larger is not one. */
const MAX_PALETTE_BYTES = 4096

interface ChosenPalette {
  /** Every palette the host bound, chosen or not: the descriptor names them all. */
  readonly bindingIds: readonly string[]
  readonly colors: Uint8Array
  readonly name?: string
  readonly note?: string
}

function grey(): Uint8Array {
  const colors = new Uint8Array(256 * 4)
  for (let index = 0; index < 256; index += 1) colors.set([index, index, index, 255], index * 4)
  return colors
}

async function choosePalette(context: InspectionContext): Promise<ChosenPalette> {
  const setting = context.settings['palette']
  const wanted = `${(typeof setting === 'string' && setting.trim() !== '' ? setting.trim() : DEFAULT_TILESET).toLowerCase().replace(/\.wpe$/u, '')}.wpe`
  const bound = await readBoundCompanions(context, PALETTE)
  const bindingIds = bound.map(item => item.bindingId)
  const chosen = bound.find(item => fileNameOf(item.uri) === wanted) ?? bound[0]
  if (chosen === undefined) return { bindingIds, colors: grey(), note: 'no tileset palette is bound; indices draw in grey' }
  if ('error' in chosen) return { bindingIds, colors: grey(), note: `${fileNameOf(chosen.uri)}: ${chosen.error}` }
  if (chosen.bytes.byteLength > MAX_PALETTE_BYTES) return { bindingIds, colors: grey(), note: `${fileNameOf(chosen.uri)} is too large for a palette` }
  return { bindingIds, colors: parsePalette(chosen.bytes, context.budget.maxNodes).colors, name: fileNameOf(chosen.uri) }
}

function regionReader(bytes: Uint8Array, grp: Grp, colors: Uint8Array) {
  const decoded = new Map<number, Uint8Array>()
  return async (request: RasterRegionRequest) => {
    const frame = request.frame ?? 0
    if (request.pixelFormat !== 'rgba8' || (request.mipLevel ?? 0) !== 0 || (request.layer ?? 0) !== 0 || (request.face ?? 0) !== 0 || (request.slice ?? 0) !== 0)
      throw new RangeError('a GRP gives RGBA8 frames of one level, layer and face')
    if (![request.x, request.y, request.width, request.height, frame].every(value => Number.isSafeInteger(value) && value >= 0))
      throw new TypeError('GRP region values must be non-negative safe integers')
    if (request.x + request.width > grp.width || request.y + request.height > grp.height) throw new RangeError('the region is outside the GRP canvas')
    const length = request.width * request.height * 4
    if (length > request.maxBytes) throw new RangeError('the GRP region exceeds maxBytes')
    let rgba = decoded.get(frame)
    if (rgba === undefined) decoded.set(frame, (rgba = applyPalette(decodeGrpFrame(bytes, grp, frame), colors, 0)))
    const pixels = new Uint8Array(length)
    for (let row = 0; row < request.height; row += 1) {
      const start = ((request.y + row) * grp.width + request.x) * 4
      pixels.set(rgba.subarray(start, start + request.width * 4), row * request.width * 4)
    }
    return { width: request.width, height: request.height, rowStride: request.width * 4, pixelFormat: 'rgba8' as const, pixels }
  }
}

const definition = Object.freeze({
  id: 'blizzard/starcraft1-grp',
  format: Object.freeze({ id: 'starcraft1-grp', label: 'StarCraft GRP sprite', mediaType: 'image/x-starcraft-grp' }),
  async planInput() {
    return Object.freeze({
      originKind: 'bundle' as const,
      candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' as const }),
      requirements: Object.freeze([
        Object.freeze({
          id: PALETTE,
          role: 'palette',
          ownership: 'companion' as const,
          // The game keeps its palettes in `tileset`; naming the folder lists it, not the whole storage.
          patterns: Object.freeze(['tileset/*.wpe']),
          scopes: Object.freeze(['sibling-directory', 'current-mount', 'enclosing-container']),
          cardinality: 'many' as const,
          // A sprite without its palette still opens, in grey.
          required: false as const,
        }),
      ]),
    })
  },
  /** No magic: a frame count, a canvas, and the first frames placed on it. */
  async detect(prefix: Uint8Array) {
    try {
      const count = prefix.byteLength >= 2 ? new DataView(prefix.buffer, prefix.byteOffset).getUint16(0, true) : 0
      const width = prefix.byteLength >= 4 ? new DataView(prefix.buffer, prefix.byteOffset).getUint16(2, true) : 0
      const height = prefix.byteLength >= 6 ? new DataView(prefix.buffer, prefix.byteOffset).getUint16(4, true) : 0
      if (count === 0 || width === 0 || height === 0 || width > 1024 || height > 1024) return { confidence: 0 }
      for (let index = 0; index < Math.min(count, Math.floor((prefix.byteLength - 6) / 8)); index += 1) {
        const at = 6 + index * 8
        if (prefix[at]! + prefix[at + 2]! > width || prefix[at + 1]! + prefix[at + 3]! > height) return { confidence: 0 }
      }
      return { confidence: 0.6, kind: 'structure' as const, note: `${String(count)} frames, ${String(width)} × ${String(height)}` }
    } catch {
      return { confidence: 0 }
    }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const grp = readGrp(bytes)
    const palette = await choosePalette(context)
    const raster = createRasterImageSource(
      bytes,
      'image/x-starcraft-grp',
      {
        width: grp.width,
        height: grp.height,
        depth: 1,
        layers: 1,
        faces: 1,
        mipLevels: 1,
        frames: grp.frames.length,
        channels: 4,
        bitDepth: 8,
        colorSpace: 'srgb',
        alphaMode: 'straight',
        orientation: 'top-left',
        decodedAccess: true,
      },
      regionReader(bytes, grp, palette.colors),
    )
    const limit = context.budget.maxNodes
    return {
      summary: { format: 'starcraft1-grp', frames: grp.frames.length, width: grp.width, height: grp.height, coded: grp.coded, palette: palette.name ?? null },
      metadata: [{
        id: 'starcraft1-grp',
        label: 'StarCraft GRP sprite',
        entries: [
          { key: 'frames', value: grp.frames.length },
          { key: 'size', value: `${String(grp.width)} × ${String(grp.height)}` },
          { key: 'palette', value: palette.name ?? 'grey' },
        ],
      }],
      traits: [],
      dataSources: {
        'common.view/raster-image-source': raster,
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'starcraft1-grp',
          label: 'GRP sprite',
          preview: `${String(grp.frames.length)} frames, ${String(grp.width)} × ${String(grp.height)}`,
          hasChildren: grp.frames.length > 0,
          children: () =>
            grp.frames.slice(0, limit).map((frame, index) => ({
              kind: 'frame',
              label: `Frame ${String(index)}`,
              preview: `${String(frame.width)} × ${String(frame.height)} at (${String(frame.x)}, ${String(frame.y)})`,
            })),
        }),
      },
      diagnostics: palette.note === undefined
        ? []
        : [{ id: 'starcraft1-grp.palette', code: 'blizzard/starcraft1-grp-palette', category: 'dependency' as const, severity: 'information' as const, message: palette.note }],
      companions: [{
        id: PALETTE,
        role: 'palette',
        cardinality: 'many' as const,
        required: false,
        ...(palette.bindingIds.length === 0 ? { state: 'missing' as const } : { state: 'resolved' as const, bindingIds: palette.bindingIds }),
      }],
      unsupportedFeatures: ['player-colour-remap', 'write'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
