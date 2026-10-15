/**
 * StarCraft tileset codec (`tileset\<era>.cv5`): the era's megatiles as an atlas — 32 a row, 32
 * pixels each, drawn on demand as the map codec draws its terrain — and its tile groups as a table
 * (group, terrain type, flags, the 16 megatiles). The other files of the era are companions: in a
 * storage the `tileset\` folder's `<era>.vx4ex`/`.vx4`, `.vr4`, `.vf4` and `.wpe`; on disk the files
 * beside the `.cv5`.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import { createInspectionCodec, createRasterImageSource, createTableDataSource } from '@modkit/codec-kit'
import type { CodecCandidateSource, RasterRegionRequest } from '@modkit/sdk'
import { fileNameOf } from '../uri.js'
import { loadTileset } from './companion.js'
import { ATLAS_COLUMNS, renderAtlas, type Tileset } from './tileset.js'

const IN_STORAGE = 'tileset-storage'
const BESIDE = 'tileset-beside'
const EXTENSIONS = ['vx4ex', 'vx4', 'vr4', 'vf4', 'wpe'] as const
const GROUP_BYTES = 52
/** Levels of the atlas image, as the terrain's: down to one pixel a megatile. */
const LEVELS = 6

const eraOf = (uri: string) => fileNameOf(uri).replace(/\.cv5$/u, '')

function requirement(id: string, patterns: readonly string[], scopes: readonly string[]) {
  return Object.freeze({
    id,
    role: 'tileset',
    ownership: 'companion' as const,
    patterns: Object.freeze(patterns),
    scopes: Object.freeze(scopes),
    cardinality: 'many' as const,
    // A tile group table reads without them; only the atlas needs the megatiles.
    required: false as const,
  })
}

function atlasRaster(tileset: Tileset, cv5: Uint8Array) {
  const megatiles = Math.floor(tileset.references.length / 16)
  const width = ATLAS_COLUMNS * 32
  const height = Math.ceil(megatiles / ATLAS_COLUMNS) * 32
  return createRasterImageSource(
    cv5,
    'application/x-starcraft-cv5',
    {
      width,
      height,
      depth: 1,
      layers: 1,
      faces: 1,
      mipLevels: LEVELS,
      frames: 1,
      channels: 3,
      bitDepth: 8,
      colorSpace: 'srgb',
      alphaMode: 'none',
      orientation: 'top-left',
      decodedAccess: true,
    },
    async (request: RasterRegionRequest) => {
      const level = request.mipLevel ?? 0
      if (request.pixelFormat !== 'rgba8' || (request.frame ?? 0) !== 0 || (request.layer ?? 0) !== 0 || (request.face ?? 0) !== 0 || (request.slice ?? 0) !== 0)
        throw new RangeError('the atlas gives RGBA8 pixels of one frame, layer and face')
      if (!Number.isSafeInteger(level) || level < 0 || level >= LEVELS) throw new RangeError(`the atlas has no level ${String(level)}`)
      if (![request.x, request.y, request.width, request.height].every(value => Number.isSafeInteger(value) && value >= 0))
        throw new TypeError('atlas region values must be non-negative safe integers')
      if (request.x + request.width > width >> level || request.y + request.height > height >> level) throw new RangeError('the region is outside the atlas')
      if (request.width * request.height * 4 > request.maxBytes) throw new RangeError('the atlas region exceeds maxBytes')
      const pixels = renderAtlas(tileset, request, level)
      return { width: request.width, height: request.height, rowStride: request.width * 4, pixelFormat: 'rgba8' as const, pixels }
    },
  )
}

const definition = Object.freeze({
  id: 'blizzard/starcraft1-tileset',
  format: Object.freeze({ id: 'starcraft1-tileset', label: 'StarCraft tileset' }),
  async planInput(source: CodecCandidateSource) {
    const era = 'ref' in source ? eraOf(source.ref.uri) : ''
    return Object.freeze({
      originKind: 'bundle' as const,
      candidate: Object.freeze({ bindingId: 'content', role: 'content', ownership: 'owned' as const }),
      requirements: Object.freeze(
        era === ''
          ? []
          : [
              // Naming the folder keeps a storage's search to it; a bare name would scan the whole storage.
              requirement(IN_STORAGE, EXTENSIONS.map(extension => `tileset/${era}.${extension}`), ['current-mount', 'enclosing-container']),
              requirement(BESIDE, EXTENSIONS.map(extension => `${era}.${extension}`), ['sibling-directory']),
            ],
      ),
    })
  },
  /** No magic: a `.cv5` of whole 52-byte groups. */
  async detect(prefix: Uint8Array, uri: string) {
    return fileNameOf(uri).endsWith('.cv5') && prefix.byteLength >= GROUP_BYTES
      ? { confidence: 0.7, kind: 'structure' as const, note: 'tile groups' }
      : { confidence: 0 }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    const era = eraOf(context.source.ref.uri)
    const loaded = await loadTileset(context.input, era, Number(context.budget.maxScalarBytes), context.budget.maxNodes, context.signal, [IN_STORAGE, BESIDE], bytes)
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const groups = Math.floor(bytes.byteLength / GROUP_BYTES)
    const rows = Array.from({ length: groups }, (_, group) => {
      const at = group * GROUP_BYTES
      return [
        String(group),
        String(data.getUint16(at, true)),
        `0x${data.getUint16(at + 2, true).toString(16).padStart(4, '0')}`,
        Array.from({ length: 16 }, (_, variant) => String(data.getUint16(at + 20 + 2 * variant, true))).join(', '),
      ]
    })
    const megatiles = loaded.tileset === undefined ? 0 : Math.floor(loaded.tileset.references.length / 16)
    return {
      summary: { format: 'starcraft1-tileset', era, groups, megatiles, drawn: loaded.tileset !== undefined },
      metadata: [{
        id: 'starcraft1-tileset',
        label: 'StarCraft tileset',
        entries: [
          { key: 'era', value: era },
          { key: 'groups', value: groups },
          { key: 'megatiles', value: megatiles },
        ],
      }],
      traits: [],
      dataSources: {
        'common.view/table-data-source': createTableDataSource({ header: ['group', 'type', 'flags', 'megatiles'], rows }),
        ...(loaded.tileset === undefined ? {} : { 'common.view/raster-image-source': atlasRaster(loaded.tileset, bytes) }),
      },
      companions: [IN_STORAGE, BESIDE].map(id => {
        const bindingIds = context.input.originKind === 'derived' ? [] : context.input.bindingsFor(id).map(binding => binding.bindingId)
        return {
          id,
          role: 'tileset',
          cardinality: 'many' as const,
          required: false,
          ...(bindingIds.length === 0 ? { state: 'missing' as const } : { state: 'resolved' as const, bindingIds }),
        }
      }),
      diagnostics: loaded.note === undefined
        ? []
        : [{ id: 'starcraft1-tileset.files', code: 'blizzard/starcraft1-tileset', category: 'dependency' as const, severity: 'information' as const, message: loaded.note }],
      unsupportedFeatures: ['hd-tiles', 'write'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
