/**
 * StarCraft II texture conventions, as operations any image viewer can offer.
 *
 * These are SC2 conventions, which is why they live here and not in
 * the generic image codecs: a button icon is inset in a transparent frame with rounded corners
 * because that is how the SC2 UI draws command-card buttons, and the normal-map channel layout is
 * the one the SC2 shaders read. Terrain diffuse alpha carries specular intensity rather than opacity.
 * Explicit straight-road atlas preparation preserves coverage and uses the qualified two-band
 * target profile; it does not infer source regions, junctions or portable UVW road definitions.
 * All operations work on decoded RGBA, so they apply to any format a host can
 * decode — a PNG, a TGA or a DDS alike — and the host re-encodes the result.
 *
 * Button-icon and normal transforms were ported from MK2
 * `extensions/common/images/codecs/dds/src/ops.ts`, where they sat behind a DDS
 * file command; the maths is unchanged, including the 5/128 default frame and the 16/118 corner
 * radius, so an icon prepared by MK3 is byte-comparable with one prepared by MK2.
 */
import type { JsonValue, ServiceOperationDescriptor } from '@modkit/sdk'
import { applyRoundedAlpha, resizeRgba, surfaceRegionReader, type RgbaImage } from '@modkit/codec-kit/raster'

export const SC2_BUTTON_ICON_OPERATION_ID = 'sc2-image.button-icon'
export const SC2_NORMAL_MAP_OPERATION_ID = 'sc2-image.normal-map'
export const SC2_TERRAIN_DIFFUSE_OPERATION_ID = 'sc2-image.terrain-diffuse'

/** Prepare the straight-road two-horizontal-band atlas qualified in the SC2 Editor pilot.
 * Region coordinates are explicit decoded-image pixels, independent of the source game.
 * Crop and bilinear filtering belong to codec-kit; RGBA coverage remains independent of
 * terrain diffuse/specular packing. Both target halves repeat the straight band: source
 * junction artwork is not reconstructed. This profile uses a road material with vertex
 * alpha disabled; enabling it hid the qualified CTile. No global M3 default is changed.
 * The caller must supply an admitted source region; this helper never infers one from alpha.
 * This is an authoring helper, not a separately registered MCP/image operation.
 */
export async function prepareSc2StraightRoadAtlas(image: RgbaImage, options: {
  readonly sourceRegion: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly width: number; readonly height: number; readonly maxBytes: number
}, signal?: AbortSignal): Promise<RgbaImage> {
  signal?.throwIfAborted()
  checked(image)
  const { sourceRegion: region, width, height, maxBytes } = options
  for (const value of [region.x, region.y, region.width, region.height, width, height, maxBytes])
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Road atlas dimensions and budget must be non-negative safe integers')
  if (region.width === 0 || region.height === 0 || width === 0 || height === 0 || height % 2 !== 0)
    throw new RangeError('Road atlas needs a non-empty source region and an even output height')
  if (region.x + region.width > image.width || region.y + region.height > image.height)
    throw new RangeError('Road atlas source region is outside the image')
  const bytes = image.pixels.byteLength + region.width * region.height * 4 + width * height * 6
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new RangeError('Road atlas exceeds cumulative RGBA byte budget')
  const cropped = await surfaceRegionReader(() => ({ width: image.width, height: image.height }), () => image.pixels)(
    { ...region, pixelFormat: 'rgba8', maxBytes }, signal,
  )
  signal?.throwIfAborted()
  const strip = resizeRgba(cropped, width, height / 2)
  const pixels = new Uint8Array(width * height * 4)
  pixels.set(strip.pixels)
  pixels.set(strip.pixels, strip.pixels.length)
  return { width, height, pixels }
}

/** Terrain diffuse alpha is specular intensity, not coverage (TerrainBlend_CopyTerrainSpec).
 * Preserve RGB exactly; missing source specular data explicitly becomes matte. */
export function packSc2TerrainDiffuse(image: RgbaImage, options: {
  readonly specularMask?: Uint8Array; readonly defaultSpecular?: number
} = {}): RgbaImage {
  checked(image)
  const value = options.defaultSpecular ?? 0
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Terrain specular must be a byte')
  const mask = options.specularMask
  if (mask !== undefined && (!(mask instanceof Uint8Array) || mask.length !== image.width * image.height))
    throw new RangeError('Terrain specular mask needs one byte per pixel')
  const pixels = new Uint8Array(image.pixels)
  for (let i = 0; i < image.width * image.height; i++) pixels[i * 4 + 3] = mask?.[i] ?? value
  return { width: image.width, height: image.height, pixels }
}

/** MK2's rule: a square icon, no larger than 256 × 256. */
export const SC2_BUTTON_ICON_MAXIMUM = 256
const DEFAULT_FRAME_FRACTION = 5 / 128
const CORNER_RADIUS_FRACTION = 16 / 118

export interface Sc2ButtonIconOptions {
  readonly framePercent?: number
}

function checked(image: RgbaImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new TypeError('an image needs a positive whole width and height')
  }
  if (image.pixels.length !== image.width * image.height * 4) {
    throw new TypeError('an image needs width * height * 4 RGBA bytes')
  }
}

/**
 * Inset a square icon in a transparent frame with rounded corners — MK2 `prepareSc2ButtonIcon`.
 */
export function prepareSc2ButtonIcon(
  image: RgbaImage,
  options: Sc2ButtonIconOptions = {},
): RgbaImage {
  checked(image)
  if (image.width !== image.height) {
    throw new TypeError(`a button icon must be square, got ${image.width} x ${image.height}`)
  }
  if (image.width > SC2_BUTTON_ICON_MAXIMUM) {
    throw new TypeError(
      `a button icon must be no larger than ${SC2_BUTTON_ICON_MAXIMUM} x ${SC2_BUTTON_ICON_MAXIMUM}, got ${image.width} x ${image.height}`,
    )
  }
  const frame = options.framePercent ?? DEFAULT_FRAME_FRACTION
  if (!Number.isFinite(frame) || frame < 0 || frame > 0.45) {
    throw new TypeError('a button icon frame is a fraction of the edge between 0 and 0.45')
  }
  const edge = image.width
  const inner = Math.max(1, Math.round(edge * (1 - frame * 2)))
  const radius = Math.max(1, Math.round(inner * CORNER_RADIUS_FRACTION))
  const border = Math.floor((edge - inner) / 2)
  const rounded = applyRoundedAlpha(resizeRgba(image, inner, inner), radius)
  const pixels = new Uint8Array(edge * edge * 4)
  for (let y = 0; y < inner; y += 1) {
    pixels.set(
      rounded.pixels.subarray(y * inner * 4, (y + 1) * inner * 4),
      ((y + border) * edge + border) * 4,
    )
  }
  return { width: edge, height: edge, pixels }
}

/**
 * Move a tangent-space normal map into the channel layout the SC2 shaders read — MK2
 * `convertNormalMapToSc2`, byte for byte.
 *
 * Source `(x, y, z)` becomes `(z, 255 - y, 0, x)`: X moves into alpha, Y is flipped for SC2's
 * handedness, Z takes red, and blue is cleared for the specular mask the pipeline puts there. The
 * shader reconstructs the third component, so storing it would waste a channel DXT5 compresses
 * badly anyway.
 */
export function convertNormalMapToSc2(image: RgbaImage): RgbaImage {
  checked(image)
  const pixels = new Uint8Array(image.pixels.length)
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    pixels[offset] = image.pixels[offset + 2] as number
    pixels[offset + 1] = 255 - (image.pixels[offset + 1] as number)
    pixels[offset + 2] = 0
    pixels[offset + 3] = image.pixels[offset] as number
  }
  return { width: image.width, height: image.height, pixels }
}

const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  required: ['image'],
  properties: {
    image: {
      type: 'object',
      required: ['width', 'height', 'pixels'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        pixels: { type: 'string' },
      },
      additionalProperties: false,
    },
    options: {
      type: 'object',
      properties: { framePercent: { type: 'number' } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

const IMAGE_RESULT_SCHEMA = {
  type: 'object',
  required: ['image'],
  properties: {
    image: {
      type: 'object',
      required: ['width', 'height', 'pixels'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        pixels: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

const BUDGET = {
  // A 4096 × 4096 RGBA texture, base64, with room for the request around it.
  maxInputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxWallTimeMs: 60 * 1000,
}

const SECTION = {
  target: 'viewer.image',
  sectionId: 'starcraft2',
  title: 'StarCraft II',
  icon: 'rocket',
} as const

/** The frame fraction, as the field the viewer draws beside the button. */
const BUTTON_ICON_FORMS: JsonValue = {
  schemaVersion: 1,
  forms: [
    {
      id: 'sc2-button-icon',
      label: 'Prepare a button icon',
      summary:
        'Insets a square icon (at most 256 × 256) in a transparent frame with rounded corners.',
      baseInput: {},
      fields: [
        {
          key: 'framePercent',
          label: 'Frame (fraction of the edge)',
          type: { kind: 'number', min: 0, max: 0.45 },
          inputPath: ['options', 'framePercent'],
          initial: DEFAULT_FRAME_FRACTION,
        },
      ],
    },
  ],
}

export const SC2_BUTTON_ICON_OPERATION: ServiceOperationDescriptor = {
  schemaVersion: 1,
  id: SC2_BUTTON_ICON_OPERATION_ID,
  title: 'Prepare a StarCraft II button icon',
  summary: 'Insets a square icon in a transparent frame with rounded corners.',
  effects: 'none',
  requiredPermissions: [],
  inputSchema: IMAGE_INPUT_SCHEMA,
  resultSchema: IMAGE_RESULT_SCHEMA,
  budget: BUDGET,
  // The viewer's "Write a copy" names the result `<base>.button.dds`, as MK2 did.
  surface: { ...SECTION, forms: BUTTON_ICON_FORMS, copyPresetId: 'button' },
}

export const SC2_NORMAL_MAP_OPERATION: ServiceOperationDescriptor = {
  schemaVersion: 1,
  id: SC2_NORMAL_MAP_OPERATION_ID,
  title: 'Convert a normal map to the StarCraft II layout',
  summary: 'Moves the normal channels into the layout the StarCraft II shaders read.',
  effects: 'none',
  requiredPermissions: [],
  inputSchema: IMAGE_INPUT_SCHEMA,
  resultSchema: IMAGE_RESULT_SCHEMA,
  budget: BUDGET,
  surface: SECTION,
}

export const SC2_TERRAIN_DIFFUSE_OPERATION: ServiceOperationDescriptor = {
  schemaVersion: 1, id: SC2_TERRAIN_DIFFUSE_OPERATION_ID,
  title: 'Pack StarCraft II terrain diffuse and specular',
  summary: 'Preserves RGB and replaces coverage alpha with a specular mask; defaults to matte.',
  effects: 'none', requiredPermissions: [],
  inputSchema: { ...IMAGE_INPUT_SCHEMA, properties: { image: IMAGE_INPUT_SCHEMA.properties.image,
    options: { type: 'object', properties: {
      specularMask: { type: 'string', description: 'Base64, one specular byte per pixel in image row order.' },
      defaultSpecular: { type: 'integer', minimum: 0, maximum: 255 },
    }, additionalProperties: false } } },
  resultSchema: IMAGE_RESULT_SCHEMA, budget: BUDGET, surface: SECTION,
}

export const SC2_IMAGE_OPERATIONS = [SC2_BUTTON_ICON_OPERATION, SC2_NORMAL_MAP_OPERATION, SC2_TERRAIN_DIFFUSE_OPERATION]

/** Decode the explicit scalar specular map for the public service operation. */
export function terrainDiffuseOptionsOf(input: unknown) {
  const options = (input as { options?: { specularMask?: unknown; defaultSpecular?: unknown } })?.options
  if (options?.specularMask !== undefined && typeof options.specularMask !== 'string') throw new TypeError('Expected base64 specular mask')
  if (options?.defaultSpecular !== undefined && typeof options.defaultSpecular !== 'number') throw new TypeError('Expected numeric default specular')
  return {
    ...(options?.specularMask === undefined ? {} : { specularMask: decodeBase64(options.specularMask as string) }),
    ...(options?.defaultSpecular === undefined ? {} : { defaultSpecular: options.defaultSpecular as number }),
  }
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), character => character.charCodeAt(0))
}

function encodeBase64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(text)
}

export function imageFromInput(input: unknown): RgbaImage {
  const record = (input ?? {}) as { image?: { width?: unknown; height?: unknown; pixels?: unknown } }
  const width = Number(record.image?.width)
  const height = Number(record.image?.height)
  const pixels = record.image?.pixels
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || typeof pixels !== 'string') {
    throw new TypeError('an image operation needs { image: { width, height, pixels } }')
  }
  const image = { width, height, pixels: decodeBase64(pixels) }
  checked(image)
  return image
}

export function imageToResult(image: RgbaImage): JsonValue {
  return {
    image: { width: image.width, height: image.height, pixels: encodeBase64(image.pixels) },
  }
}

export function framePercentOf(input: unknown): Sc2ButtonIconOptions {
  const record = (input ?? {}) as { options?: { framePercent?: unknown } }
  const frame = Number(record.options?.framePercent)
  return Number.isFinite(frame) ? { framePercent: frame } : {}
}
