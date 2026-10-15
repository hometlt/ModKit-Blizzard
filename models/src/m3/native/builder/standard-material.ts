import type {
  AnimatedColor,
  AnimatedScalar,
  AnimatedVec2,
  AnimatedVec3,
  CompositeMaterialModel,
  LayerChannelSelect,
  LayerColorOp,
  RenderMaterial,
  StandardLayerSlot,
  StandardMaterialLayer,
  StandardMaterialModel,
} from '@modkit/codec-kit/legacy/models'
import type { M3Reference, M3StructureData, SectionResolver } from '../types.js'
import { M3AnimationReferenceTrackExtractor } from '../animation/tracks.js'
import { getSectionString } from '../utils/texture.js'
import { nativeCompositePassIndices } from '../../uvm/material-layer-addresses.js'
import {
  MATM_TYPE_BUFFER,
  MATM_TYPE_COMPOSITE,
  MATM_TYPE_CREEP,
  MATM_TYPE_DISPLACEMENT,
  MATM_TYPE_HAIR,
  MATM_TYPE_LENS_FLARE,
  MATM_TYPE_REFLECTION,
  MATM_TYPE_SPLAT_TERRAIN_BAKE,
  MATM_TYPE_STANDARD,
  MATM_TYPE_TERRAIN,
  MATM_TYPE_VOLUME,
  MATM_TYPE_VOLUME_NOISE,
} from './material-helpers.js'

/**
 * M3 material projection: standard and ordered composite surfaces plus declared specialized
 * approximations. REF_ has no qualified shared shader: retain native loss facts, omit its
 * composite color passes, and refuse referenced shaderless projections and fresh native writes.
 * Native source parsing/inspection and original-graph preserving writes remain separate owners.
 */

/** MAT_ layer reference field → shader slot (P4 table 1.1). */
const LAYER_FIELD_TO_SLOT: readonly [string, StandardLayerSlot][] = [
  ['layer_diff', 'diffuse'],
  ['layer_decal', 'decal'],
  ['layer_spec', 'specular'],
  ['layer_gloss', 'gloss'],
  ['layer_emis1', 'emissive1'],
  ['layer_emis2', 'emissive2'],
  ['layer_envi', 'envi'],
  ['layer_envi_mask', 'enviMask'],
  ['layer_alpha1', 'alpha1'],
  ['layer_alpha2', 'alpha2'],
  ['layer_norm', 'normal'],
  ['layer_norm_blend1_mask', 'normalBlend1Mask'],
  ['layer_norm_blend2_mask', 'normalBlend2Mask'],
  ['layer_norm_blend1', 'normalBlend1'],
  ['layer_norm_blend2', 'normalBlend2'],
  ['layer_height', 'height'],
  ['layer_light', 'lightMap'],
  ['layer_ao', 'ao'],
]

// LAYR flag bits (structures.xml LAYR).
const LAYR_UV_WRAP_X = 0x4
const LAYR_UV_WRAP_Y = 0x8
const LAYR_COLOR_INVERT = 0x10
const LAYR_COLOR_CLAMP = 0x20
const LAYR_COLOR_ADD = 0x40
const LAYR_COLOR_MULT = 0x80
const LAYR_COLOR = 0x400
const LAYR_FRESNEL_TRANSFORM = 0x4000
const LAYR_FRESNEL_NORMALIZE = 0x8000
const LAYR_FRESNEL_LOCAL_TRANSFORM = 0x10000
const LAYR_FRESNEL_DO_NOT_MIRROR = 0x20000

// MAT_ flag bits consumed in P4 (others ride metadata untouched).
const MAT_VERTEX_COLOR = 0x1
const MAT_VERTEX_ALPHA = 0x2
const MAT_TWO_SIDED = 0x8
const MAT_UNSHADED = 0x10
const MAT_DEPTH_PREPASS = 0x100
const MAT_DOUBLE_LAMBERT = 0x80000
/** MAT_ simulate_roughness: the gloss blurs the environment instead of dimming the specular. */
const MAT_SIMULATE_ROUGHNESS = 0x800
const MAT_CLAMP_OUTPUT = 0x40000000

const SPECIALIZED_MATERIAL_TAGS: Readonly<Record<number, string>> = {
  [MATM_TYPE_DISPLACEMENT]: 'DIS_',
  [MATM_TYPE_TERRAIN]: 'TER_',
  [MATM_TYPE_VOLUME]: 'VOL_',
  [MATM_TYPE_VOLUME_NOISE]: 'VON_',
  [MATM_TYPE_CREEP]: 'CREP',
  [MATM_TYPE_HAIR]: 'HAI_',
  [MATM_TYPE_SPLAT_TERRAIN_BAKE]: 'STBM',
  [MATM_TYPE_REFLECTION]: 'REF_',
  [MATM_TYPE_LENS_FLARE]: 'LFLR',
  [MATM_TYPE_BUFFER]: 'MADD',
}

/**
 * Families with no color of their own: DIS_ refracts the frame behind it, TER_ shows the terrain
 * under the model. They publish a render presentation instead of a surface approximation.
 */
const COLORLESS_PRESENTATIONS: Readonly<Record<number, string>> = {
  [MATM_TYPE_DISPLACEMENT]: 'screen-distortion',
  [MATM_TYPE_TERRAIN]: 'terrain-projection',
}

export interface MaterialConversionDiagnostic {
  code: string
  message: string
}

export interface M3RenderMaterials {
  /** One entry per MATM material reference; mesh.materialIndex indexes this list. */
  materials: RenderMaterial[]
  diagnostics: MaterialConversionDiagnostic[]
}

function animFloat(
  ref: M3StructureData | null | undefined,
  fallback: number,
  animationTracks?: M3AnimationReferenceTrackExtractor,
): AnimatedScalar {
  const value = typeof ref?.default === 'number' ? (ref.default as number) : fallback
  const sequenceTracks = animationTracks?.extract(ref) ?? []
  return { value, ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}) }
}

function animVec2(
  ref: M3StructureData | null | undefined,
  fallback: readonly [number, number],
  animationTracks?: M3AnimationReferenceTrackExtractor,
): AnimatedVec2 {
  const v = ref?.default as M3StructureData | undefined
  const sequenceTracks = animationTracks?.extract(ref) ?? []
  if (v && typeof v.x === 'number' && typeof v.y === 'number') {
    return {
      value: [v.x as number, v.y as number],
      ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}),
    }
  }
  return { value: fallback, ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}) }
}

function animVec3(
  ref: M3StructureData | null | undefined,
  fallback: readonly [number, number, number],
  animationTracks?: M3AnimationReferenceTrackExtractor,
): AnimatedVec3 {
  const v = ref?.default as M3StructureData | undefined
  const sequenceTracks = animationTracks?.extract(ref) ?? []
  if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
    return {
      value: [v.x as number, v.y as number, v.z as number],
      ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}),
    }
  }
  return { value: fallback, ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}) }
}

function normalizedColorVector(
  vector: readonly number[],
): readonly [number, number, number, number] {
  const component = (index: number, fallback: number): number =>
    Math.min(Math.max((vector[index] ?? fallback) / 255, 0), 1)
  return [component(0, 255), component(1, 255), component(2, 255), component(3, 255)]
}

function animColor(
  ref: M3StructureData | null | undefined,
  animationTracks?: M3AnimationReferenceTrackExtractor,
): AnimatedColor {
  const c = ref?.default as M3StructureData | undefined
  const sequenceTracks =
    animationTracks?.extract(ref, { transformVector: normalizedColorVector }) ?? []
  if (c && typeof c.r === 'number') {
    return {
      value: normalizedColorVector([
        c.r as number,
        (c.g as number) ?? 255,
        (c.b as number) ?? 255,
        (c.a as number) ?? 255,
      ]),
      ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}),
    }
  }
  return {
    value: [1, 1, 1, 1],
    ...(sequenceTracks.length > 0 ? { sequenceTracks } : {}),
  }
}

function hasSequenceTracks(value: { sequenceTracks?: readonly unknown[] }): boolean {
  return (value.sequenceTracks?.length ?? 0) > 0
}

function finiteMaterialNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function materialVec3(
  value: unknown,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const vector = value as { x?: unknown; y?: unknown; z?: unknown } | undefined
  return [
    finiteMaterialNumber(vector?.x, fallback[0]),
    finiteMaterialNumber(vector?.y, fallback[1]),
    finiteMaterialNumber(vector?.z, fallback[2]),
  ]
}

function referenceNormalBlendFactors(
  sections: SectionResolver,
  ref: M3Reference | null | undefined,
  animationTracks?: M3AnimationReferenceTrackExtractor,
): readonly [
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
  AnimatedScalar,
] {
  const section = sections.getSectionByReference(ref)
  const entries = (section?.content ?? []) as M3StructureData[]
  const factor = (index: number, fallback: number): AnimatedScalar =>
    animFloat(entries[index]?.value as M3StructureData | undefined, fallback, animationTracks)
  return [
    factor(0, 1),
    factor(1, 0),
    factor(2, 0),
    factor(3, 0),
    factor(4, 1),
    factor(5, 0),
    factor(6, 0),
    factor(7, 0),
  ]
}

function resolveLayer(
  sections: SectionResolver,
  ref: M3Reference | undefined,
): M3StructureData | null {
  const section = sections.getSectionByReference(ref)
  return (section?.content?.[0] as M3StructureData | undefined) ?? null
}

function convertLayer(
  sections: SectionResolver,
  layer: M3StructureData,
  slot: StandardLayerSlot,
  op: LayerColorOp,
  animationTracks?: M3AnimationReferenceTrackExtractor,
): StandardMaterialLayer | null {
  const flags = (layer.flags as number) ?? 0
  const bitmapPath = getSectionString(sections, layer.color_bitmap as M3Reference | null)
  const usesConstantColor = (flags & LAYR_COLOR) !== 0
  if (!bitmapPath && !usesConstantColor) return null // disabled layer

  const channelsRaw = (layer.color_channels as number) ?? 0
  const converted: StandardMaterialLayer = {
    slot,
    // LAYR.color is a source selector: Blender M3 Studio imports COLOR when
    // this bit is set even if the stale bitmap reference is still populated.
    // Keeping that bitmap active would hide animated color_value in shaders.
    texturePath: usesConstantColor ? null : bitmapPath || null,
    uvSource: (layer.uv_source as number) ?? 0,
    channels: Math.min(Math.max(channelsRaw, 0), 5) as LayerChannelSelect,
    op,
    // The diffuse alpha is the team mask only when the layer selects more than RGB — the game's
    // layer shader gates TEAMCOLOR_DIFFUSE on `ChannelSelect != RGB` (psmateriallayer.fx, as
    // WhiteoutFlakes reads it). An RGB diffuse keeps its texel colour whatever its alpha holds.
    // Emissive team colour arrives via ops 4/5 instead.
    teamColorMode: slot === 'diffuse' && channelsRaw !== 0 ? 1 : 0,
    invert: (flags & LAYR_COLOR_INVERT) !== 0,
    clampResult: (flags & LAYR_COLOR_CLAMP) !== 0,
    wrapX: (flags & LAYR_UV_WRAP_X) !== 0,
    wrapY: (flags & LAYR_UV_WRAP_Y) !== 0,
  }
  if (usesConstantColor) {
    converted.constantColor = animColor(
      layer.color_value as M3StructureData | undefined,
      animationTracks,
    )
  }
  if (flags & LAYR_COLOR_MULT) {
    converted.colorMultiply = animFloat(
      layer.color_multiply as M3StructureData | undefined,
      1,
      animationTracks,
    )
  }
  if (flags & LAYR_COLOR_ADD) {
    converted.colorAdd = animFloat(
      layer.color_add as M3StructureData | undefined,
      0,
      animationTracks,
    )
  }
  const alphaFactor = animFloat(
    layer.color_brightness as M3StructureData | undefined,
    1,
    animationTracks,
  )
  if (alphaFactor.value !== 1 || hasSequenceTracks(alphaFactor)) {
    converted.alphaFactor = alphaFactor
  }
  const fresnelModeRaw = finiteMaterialNumber(layer.fresnel_type, 0)
  if (fresnelModeRaw === 1 || fresnelModeRaw === 2) {
    converted.fresnel = {
      mode: fresnelModeRaw,
      exponent: Math.max(0, finiteMaterialNumber(layer.fresnel_exponent, 4)),
      min: finiteMaterialNumber(layer.fresnel_min, 0),
      maxOffset: finiteMaterialNumber(layer.fresnel_max_offset, 1),
      transformMode:
        (flags & LAYR_FRESNEL_TRANSFORM) === 0 ? 0 : (flags & LAYR_FRESNEL_NORMALIZE) !== 0 ? 2 : 1,
      localTransform: (flags & LAYR_FRESNEL_LOCAL_TRANSFORM) !== 0,
      doNotMirror: (flags & LAYR_FRESNEL_DO_NOT_MIRROR) !== 0,
      translation: materialVec3(layer.fresnel_translation, [0, 0, 0]),
      invertMask: materialVec3(layer.fresnel_invert_mask, [0, 0, 0]),
      rotation: [
        finiteMaterialNumber(layer.fresnel_yaw, 0),
        finiteMaterialNumber(layer.fresnel_pitch, 0),
      ],
    }
  }

  const uvOffset = animVec2(layer.uv_offset as M3StructureData | undefined, [0, 0], animationTracks)
  if (uvOffset.value[0] !== 0 || uvOffset.value[1] !== 0 || hasSequenceTracks(uvOffset)) {
    converted.uvOffset = uvOffset
  }
  // structures.xml and Blender M3 Studio both model uv_angle as an animated
  // Vector3 Euler value (radians). Each component rotates its corresponding
  // triplanar projection; ordinary UVs use the authored Z component.
  const uvAngle = animVec3(
    layer.uv_angle as M3StructureData | undefined,
    [0, 0, 0],
    animationTracks,
  )
  if (
    uvAngle.value[0] !== 0 ||
    uvAngle.value[1] !== 0 ||
    uvAngle.value[2] !== 0 ||
    hasSequenceTracks(uvAngle)
  ) {
    converted.uvAngle = uvAngle
  }
  const uvTiling = animVec2(layer.uv_tiling as M3StructureData | undefined, [1, 1], animationTracks)
  if (uvTiling.value[0] !== 1 || uvTiling.value[1] !== 1 || hasSequenceTracks(uvTiling)) {
    converted.uvTiling = uvTiling
  }

  const uvTriplanarOffset = animVec3(
    layer.uv_triplanar_offset as M3StructureData | undefined,
    [0, 0, 0],
    animationTracks,
  )
  if (
    uvTriplanarOffset.value[0] !== 0 ||
    uvTriplanarOffset.value[1] !== 0 ||
    uvTriplanarOffset.value[2] !== 0 ||
    hasSequenceTracks(uvTriplanarOffset)
  ) {
    converted.uvTriplanarOffset = uvTriplanarOffset
  }
  const uvTriplanarScale = animVec3(
    layer.uv_triplanar_scale as M3StructureData | undefined,
    [1, 1, 1],
    animationTracks,
  )
  if (
    uvTriplanarScale.value[0] !== 1 ||
    uvTriplanarScale.value[1] !== 1 ||
    uvTriplanarScale.value[2] !== 1 ||
    hasSequenceTracks(uvTriplanarScale)
  ) {
    converted.uvTriplanarScale = uvTriplanarScale
  }

  const rows = (layer.uv_flipbook_rows as number) ?? 0
  const cols = (layer.uv_flipbook_cols as number) ?? 0
  if (rows > 0 && cols > 0 && rows * cols > 1) {
    converted.flipbook = {
      rows,
      cols,
      frame: animFloat(layer.uv_flipbook_frame as M3StructureData | undefined, 0, animationTracks),
    }
  }
  return converted
}

export function convertStandardMaterial(
  sections: SectionResolver,
  mat: M3StructureData,
  animationTracks?: M3AnimationReferenceTrackExtractor,
): StandardMaterialModel {
  const flags = (mat.flags as number) ?? 0
  const additionalFlags = (mat.additional_flags as number) ?? 0
  const validLayerOp = (value: unknown): LayerColorOp =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
      ? (value as LayerColorOp)
      : 2
  const layerOp = validLayerOp(mat.blend_mode_layer)
  const emis1Op = validLayerOp(mat.blend_mode_emis1)
  const emis2Op = validLayerOp(mat.blend_mode_emis2)

  const layers: Partial<Record<StandardLayerSlot, StandardMaterialLayer>> = {}
  for (const [field, slot] of LAYER_FIELD_TO_SLOT) {
    const layerStruct = resolveLayer(sections, mat[field] as M3Reference | undefined)
    if (!layerStruct) continue
    // MAT_ supplies the shared surface op plus two independent emissive ops.
    const op: LayerColorOp =
      slot === 'emissive1' ? emis1Op : slot === 'emissive2' ? emis2Op : layerOp
    const converted = convertLayer(sections, layerStruct, slot, op, animationTracks)
    if (converted) layers[slot] = converted
  }

  const parallaxHeight = animFloat(
    mat.parallax_height as M3StructureData | undefined,
    0,
    animationTracks,
  )
  const hasNormalBlendLayers =
    layers.normalBlend1 !== undefined ||
    layers.normalBlend2 !== undefined ||
    layers.normalBlend1Mask !== undefined ||
    layers.normalBlend2Mask !== undefined
  const normalBlendFactors = referenceNormalBlendFactors(
    sections,
    mat.normal_blend_mask_factor as M3Reference | undefined,
    animationTracks,
  )

  return {
    layers,
    sourceFlags: flags >>> 0,
    sourceAdditionalFlags: additionalFlags >>> 0,
    materialClass: (mat.material_class as number) ?? 0,
    blendMode: (mat.blend_mode as number) ?? 0,
    priority: (mat.priority as number) ?? 0,
    specularity: (mat.specularity as number) ?? 0,
    specMult: (mat.hdr_spec as number) ?? 1,
    emisMult: (mat.hdr_emis as number) ?? 1,
    environmentMultipliers: [
      finiteMaterialNumber(mat.hdr_envi_const, 1),
      finiteMaterialNumber(mat.hdr_envi_diff, 0),
      finiteMaterialNumber(mat.hdr_envi_spec, 0),
    ],
    ...(parallaxHeight.value !== 0 || hasSequenceTracks(parallaxHeight) ? { parallaxHeight } : {}),
    ...(hasNormalBlendLayers ? { normalBlendFactors } : {}),
    specMode: ((mat.spec_mode as number) ?? 0) === 1 ? 1 : 0,
    alphaTestThreshold: Math.min(Math.max(((mat.alpha_test_threshold as number) ?? 0) / 255, 0), 1),
    twoSided: (flags & MAT_TWO_SIDED) !== 0,
    unshaded: (flags & MAT_UNSHADED) !== 0,
    depthPrepass: (flags & MAT_DEPTH_PREPASS) !== 0,
    doubleLambert: (flags & MAT_DOUBLE_LAMBERT) !== 0,
    clampOutput: (flags & MAT_CLAMP_OUTPUT) !== 0,
    usesVertexColor: (flags & MAT_VERTEX_COLOR) !== 0 || (additionalFlags & 0x4) !== 0,
    usesVertexAlpha: (flags & MAT_VERTEX_ALPHA) !== 0 || (additionalFlags & 0x8) !== 0,
    ...specularEnergy(flags),
  }
}

/**
 * The engine dims the specular by FakeEnergyConservingSpec unless SimulateRoughness is set
 * (CMaterial_ApplyForDraw, as WhiteoutFlakes reads it); hdr_spec values of 2-5 assume the dim.
 * A separate object: the vendored codec-kit type predates the field until the next hop.
 */
function specularEnergy(flags: number): { readonly specularEnergyConservation: boolean } {
  return { specularEnergyConservation: (flags & MAT_SIMULATE_ROUGHNESS) === 0 }
}

type SpecializedMaterialConversion = {
  standard: StandardMaterialModel
  metadata: Record<string, unknown>
}

function surfaceMaterial(
  layers: Partial<Record<StandardLayerSlot, StandardMaterialLayer>>,
  overrides: Partial<Omit<StandardMaterialModel, 'layers'>> = {},
): StandardMaterialModel {
  return {
    layers,
    blendMode: 0,
    priority: 0,
    specularity: 0,
    specMult: 1,
    emisMult: 1,
    specMode: 0,
    alphaTestThreshold: 0,
    twoSided: false,
    unshaded: false,
    doubleLambert: false,
    clampOutput: false,
    usesVertexColor: false,
    usesVertexAlpha: false,
    ...overrides,
  }
}

function convertedLayers(
  sections: SectionResolver,
  mat: M3StructureData,
  mappings: readonly (readonly [field: string, slot: StandardLayerSlot, op?: LayerColorOp])[],
  animationTracks: M3AnimationReferenceTrackExtractor,
): Partial<Record<StandardLayerSlot, StandardMaterialLayer>> {
  const layers: Partial<Record<StandardLayerSlot, StandardMaterialLayer>> = {}
  for (const [field, slot, op = 2] of mappings) {
    const source = resolveLayer(sections, mat[field] as M3Reference | undefined)
    if (!source) continue
    const layer = convertLayer(sections, source, slot, op, animationTracks)
    if (layer) layers[slot] = layer
  }
  return layers
}

function textureLayer(path: string, slot: StandardLayerSlot): StandardMaterialLayer {
  return {
    slot,
    texturePath: path,
    uvSource: 0,
    channels: 1,
    op: 2,
    teamColorMode: 0,
    invert: false,
    clampResult: false,
    wrapX: false,
    wrapY: false,
  }
}

function bufferTexturePaths(sections: SectionResolver, mat: M3StructureData): string[] {
  const pathSection = sections.getSectionByReference(mat.value_data as M3Reference | undefined)
  const paths: string[] = []
  for (const entry of (pathSection?.content ?? []) as M3StructureData[]) {
    const path = getSectionString(sections, entry.path as M3Reference | null)
    if (path) paths.push(path)
  }
  return paths
}

function convertSpecializedMaterial(
  type: number,
  mat: M3StructureData,
  sections: SectionResolver,
  animationTracks: M3AnimationReferenceTrackExtractor,
): SpecializedMaterialConversion | null {
  if (type === MATM_TYPE_DISPLACEMENT) {
    const strength = animFloat(
      mat.strength_factor as M3StructureData | undefined,
      0,
      animationTracks,
    )
    return {
      standard: surfaceMaterial(
        convertedLayers(
          sections,
          mat,
          [
            ['layer_norm', 'normal'],
            ['layer_strength', 'height'],
          ],
          animationTracks,
        ),
        { priority: (mat.priority as number) ?? 0, parallaxHeight: strength },
      ),
      metadata: { strength, flags: (mat.flags as number) ?? 0 },
    }
  }

  if (type === MATM_TYPE_TERRAIN) {
    return {
      standard: surfaceMaterial(
        convertedLayers(sections, mat, [['layer_terrain', 'diffuse']], animationTracks),
      ),
      metadata: {},
    }
  }

  if (type === MATM_TYPE_VOLUME || type === MATM_TYPE_VOLUME_NOISE) {
    const density = animFloat(mat.density as M3StructureData | undefined, 1, animationTracks)
    const alphaThreshold = Math.min(Math.max(((mat.alpha_threshold as number) ?? 0) / 255, 0), 1)
    const layers = convertedLayers(
      sections,
      mat,
      [
        ['layer_color', 'diffuse'],
        ['layer_noise1', 'alpha1'],
        ['layer_noise2', 'alpha2'],
      ],
      animationTracks,
    )
    const metadata: Record<string, unknown> = {
      density,
      falloffType: (mat.falloff_type as number) ?? 0,
      flags: (mat.flags as number) ?? 0,
    }
    if (type === MATM_TYPE_VOLUME_NOISE) {
      metadata.cameraPositionMode = (mat.camera_position_mode as number) ?? 0
      metadata.nearPlane = animFloat(
        mat.near_plane as M3StructureData | undefined,
        0,
        animationTracks,
      )
      metadata.falloff = animFloat(mat.falloff as M3StructureData | undefined, 0, animationTracks)
      metadata.scrollRate = animVec3(
        mat.scroll_rate as M3StructureData | undefined,
        [0, 0, 0],
        animationTracks,
      )
      metadata.translation = animVec3(
        mat.translation as M3StructureData | undefined,
        [0, 0, 0],
        animationTracks,
      )
      metadata.scale = animVec3(
        mat.scale as M3StructureData | undefined,
        [1, 1, 1],
        animationTracks,
      )
      metadata.rotation = animVec3(
        mat.rotation as M3StructureData | undefined,
        [0, 0, 0],
        animationTracks,
      )
    } else {
      metadata.blendMode = (mat.blend_mode as number) ?? 0
    }
    return {
      standard: surfaceMaterial(layers, {
        blendMode: type === MATM_TYPE_VOLUME ? ((mat.blend_mode as number) ?? 1) : 1,
        alphaTestThreshold: alphaThreshold,
        twoSided: true,
        unshaded: true,
      }),
      metadata,
    }
  }

  if (type === MATM_TYPE_CREEP) {
    return {
      standard: surfaceMaterial(
        convertedLayers(sections, mat, [['layer_mask', 'diffuse']], animationTracks),
        { unshaded: true },
      ),
      metadata: { creepLow: (mat.creep_low as number) ?? 0 },
    }
  }

  if (type === MATM_TYPE_HAIR) {
    const diffuseColor = animColor(
      mat.color_diffuse as M3StructureData | undefined,
      animationTracks,
    )
    const specularColor = animColor(mat.color_spec as M3StructureData | undefined, animationTracks)
    return {
      standard: surfaceMaterial(
        convertedLayers(
          sections,
          mat,
          [
            ['layer_base', 'diffuse'],
            ['layer_spec_shift', 'specular'],
            ['layer_spec_noise', 'gloss'],
            ['layer_ao', 'ao'],
          ],
          animationTracks,
        ),
        {
          specularity: Math.max(0, finiteMaterialNumber(mat.spec_exponent0, 0)),
          twoSided: true,
        },
      ),
      metadata: {
        shiftPrimary: finiteMaterialNumber(mat.shift_primary, 0),
        shiftSecondary: finiteMaterialNumber(mat.shift_secondary, 0),
        diffuseColor,
        specularColor,
        specExponent0: finiteMaterialNumber(mat.spec_exponent0, 0),
        specExponent1: finiteMaterialNumber(mat.spec_exponent1, 0),
      },
    }
  }

  if (type === MATM_TYPE_SPLAT_TERRAIN_BAKE) {
    return {
      standard: surfaceMaterial(
        convertedLayers(
          sections,
          mat,
          [
            ['layer_diff', 'diffuse'],
            ['layer_norm', 'normal'],
            ['layer_spec', 'specular'],
          ],
          animationTracks,
        ),
      ),
      metadata: {},
    }
  }

  if (type === MATM_TYPE_LENS_FLARE) {
    const layers = convertedLayers(
      sections,
      mat,
      [
        ['layer_color', 'emissive1', 2],
        ['layer_unknown', 'alpha1', 2],
      ],
      animationTracks,
    )
    const columns = (mat.columns as number) ?? 0
    const rows = (mat.rows as number) ?? 0
    if (layers.emissive1 && columns > 0 && rows > 0 && columns * rows > 1) {
      layers.emissive1.flipbook = { cols: columns, rows, frame: { value: 0 } }
    }
    const intensity = animFloat(mat.intensity as M3StructureData | undefined, 1, animationTracks)
    const hdr = animFloat(mat.hdr as M3StructureData | undefined, 1, animationTracks)
    return {
      standard: surfaceMaterial(layers, {
        blendMode: 2,
        emisMult: Math.max(0, intensity.value * hdr.value),
        twoSided: true,
        unshaded: true,
      }),
      metadata: {
        columns,
        rows,
        distanceFade: (mat.distance_fade as number) ?? 0,
        intensity,
        color: animColor(mat.color as M3StructureData | undefined, animationTracks),
        hdr,
        size: animFloat(mat.size as M3StructureData | undefined, 1, animationTracks),
      },
    }
  }

  if (type === MATM_TYPE_BUFFER) {
    const texturePaths = bufferTexturePaths(sections, mat)
    const layers: Partial<Record<StandardLayerSlot, StandardMaterialLayer>> = {}
    if (texturePaths[0]) layers.diffuse = textureLayer(texturePaths[0], 'diffuse')
    return {
      standard: surfaceMaterial(layers),
      metadata: { texturePaths },
    }
  }

  return null
}

export function buildRenderMaterials(
  model: M3StructureData,
  sections: SectionResolver,
): M3RenderMaterials {
  const diagnostics: MaterialConversionDiagnostic[] = []
  const animationTracks = new M3AnimationReferenceTrackExtractor(model, sections)
  const matmSection = sections.getSectionByReference(
    model.material_references as M3Reference | undefined,
  )
  const matms = (matmSection?.content ?? []) as M3StructureData[]
  const standardSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  const standards = (standardSection?.content ?? []) as M3StructureData[]
  const compositeSection = sections.getSectionByReference(
    model.materials_composite as M3Reference | undefined,
  )
  const composites = (compositeSection?.content ?? []) as M3StructureData[]
  const materialEntries = (field: string): M3StructureData[] => {
    const section = sections.getSectionByReference(model[field] as M3Reference | undefined)
    return (section?.content ?? []) as M3StructureData[]
  }
  const specializedSources = new Map<number, M3StructureData[]>([
    [MATM_TYPE_DISPLACEMENT, materialEntries('materials_displacement')],
    [MATM_TYPE_TERRAIN, materialEntries('materials_terrain')],
    [MATM_TYPE_VOLUME, materialEntries('materials_volume')],
    [MATM_TYPE_VOLUME_NOISE, materialEntries('materials_volumenoise')],
    [MATM_TYPE_CREEP, materialEntries('materials_creep')],
    [MATM_TYPE_HAIR, materialEntries('materials_hair')],
    [MATM_TYPE_SPLAT_TERRAIN_BAKE, materialEntries('materials_splatterrainbake')],
    [MATM_TYPE_REFLECTION, materialEntries('materials_reflection')],
    [MATM_TYPE_LENS_FLARE, materialEntries('materials_lensflare')],
    [MATM_TYPE_BUFFER, materialEntries('materials_buffer')],
  ])

  const materialName = (mat: M3StructureData | undefined, fallback: string): string =>
    (mat ? getSectionString(sections, mat.name as M3Reference | null) : null) || fallback

  const legacyLayers = (standard: StandardMaterialModel): RenderMaterial['layers'] =>
    Object.values(standard.layers)
      .filter((layer): layer is StandardMaterialLayer => !!layer?.texturePath)
      .map(layer => ({
        label: layer.slot,
        path: layer.texturePath!,
        metadata: {
          wrapS: layer.wrapX ? 'repeat' : 'clamp',
          wrapT: layer.wrapY ? 'repeat' : 'clamp',
        },
      }))

  const approximated = new Set<number>()
  const convertSurfaceMatm = (
    matmIndex: number,
  ): {
    source: M3StructureData
    standard: StandardMaterialModel
    metadata: Record<string, unknown>
  } | null => {
    const matm = matms[matmIndex]
    const type = (matm?.type as number) ?? -1
    const materialIndex = (matm?.material_index as number) ?? -1
    if (type === MATM_TYPE_STANDARD) {
      const source = standards[materialIndex]
      return source
        ? {
            source,
            standard: convertStandardMaterial(sections, source, animationTracks),
            metadata: {},
          }
        : null
    }
    const source = specializedSources.get(type)?.[materialIndex]
    if (!source || isUnsupportedM3Material(type)) return null
    const converted = convertSpecializedMaterial(type, source, sections, animationTracks)
    return converted ? { source, ...converted } : null
  }

  const recordApproximation = (matmIndex: number, type: number): void => {
    if (approximated.has(matmIndex)) return
    approximated.add(matmIndex)
    diagnostics.push({
      code: 'material-family-approximated',
      message: `MATM ${matmIndex} ${SPECIALIZED_MATERIAL_TAGS[type]} uses the shared surface shader approximation`,
    })
  }

  const materials = matms.map((matm, matmIndex): RenderMaterial => {
    const type = (matm.type as number) ?? -1
    const materialIndex = (matm.material_index as number) ?? -1

    if (type === MATM_TYPE_COMPOSITE) {
      const cmp = composites[materialIndex]
      if (cmp) {
        const sectionsRef = sections.getSectionByReference(cmp.sections as M3Reference | undefined)
        const passes: CompositeMaterialModel['passes'] = []
        const nativePassIndices: number[] = []
        let omittedReflection = false
        for (const [nativePassIndex, cms] of ((sectionsRef?.content ?? []) as M3StructureData[]).entries()) {
          const passMatmIndex = (cms.material_reference_index as number) ?? -1
          const passMatm = matms[passMatmIndex]
          const passType = (passMatm?.type as number) ?? -1
          if (isUnsupportedM3Material(passType)) {
            const valid = specializedSources.get(passType)?.[passMatm?.material_index as number]
            diagnostics.push({
              code: valid ? 'material-reflection-unsupported' : 'material-reference-invalid',
              message: valid
                ? `composite material ${matmIndex} CMS ${nativePassIndex} REF_ has no supported reflection projection; omitted from color passes; fresh native write refused`
                : `composite material ${matmIndex} CMS ${nativePassIndex} references missing REF_ material`,
            })
            omittedReflection = true
            continue
          }
          const presentation = COLORLESS_PRESENTATIONS[passType]
          if (presentation !== undefined) {
            diagnostics.push({
              code: 'composite-pass-presentation-unrendered',
              message: `composite material ${matmIndex} pass references ${SPECIALIZED_MATERIAL_TAGS[passType]} presentation ${presentation}; it is preserved by the native source but omitted from color passes`,
            })
            continue
          }
          const pass = convertSurfaceMatm(passMatmIndex)
          if (!pass) {
            diagnostics.push({
              code: 'composite-pass-unsupported',
              message: `composite material ${matmIndex} pass references MATM ${passMatmIndex} (type ${passType}) which has no surface representation`,
            })
            continue
          }
          if (passType !== MATM_TYPE_STANDARD) recordApproximation(passMatmIndex, passType)
          nativePassIndices.push(nativePassIndex)
          passes.push({
            material: pass.standard,
            alphaFactor: animFloat(
              cms.alpha_factor as M3StructureData | undefined,
              1,
              animationTracks,
            ),
          })
        }
        const composite: CompositeMaterialModel = {
          passes,
          priority: (cmp.priority as number) ?? 0,
        }
        return {
          name: materialName(cmp, `Composite_${matmIndex}`),
          layers: passes.flatMap(pass => legacyLayers(pass.material)),
          composite,
          metadata: { matmType: type, materialIndex, sourceMaterialTag: 'CMP_',
            m3NativeCompositePassIndices: nativeCompositePassIndices(
              { m3NativeCompositePassIndices: nativePassIndices }, passes.length),
            ...(omittedReflection ? { m3UnsupportedMaterialFamilies: ['REF_'] } : {}),
          },
        }
      }
    } else {
      if (isUnsupportedM3Material(type) && specializedSources.get(type)?.[materialIndex]) {
        const source = specializedSources.get(type)![materialIndex]!
        diagnostics.push({ code: 'material-reflection-unsupported',
          message: `MATM ${matmIndex} REF_ has no supported reflection projection; fresh native write refused`,
        })
        return { name: materialName(source, `REF_${matmIndex}`), layers: [],
          metadata: { matmType: type, materialIndex, sourceMaterialTag: 'REF_',
            m3UnsupportedMaterialFamilies: ['REF_'] },
        }
      }
      const converted = convertSurfaceMatm(matmIndex)
      if (converted) {
        const presentation = COLORLESS_PRESENTATIONS[type]
        if (type !== MATM_TYPE_STANDARD && presentation === undefined)
          recordApproximation(matmIndex, type)
        const sourceMaterialTag =
          type === MATM_TYPE_STANDARD ? 'MAT_' : SPECIALIZED_MATERIAL_TAGS[type]
        return {
          name: materialName(converted.source, `${sourceMaterialTag}_${matmIndex}`),
          layers: legacyLayers(converted.standard),
          standard: converted.standard,
          metadata: {
            matmType: type,
            materialIndex,
            sourceMaterialTag,
            ...(presentation === undefined ? {} : { presentation }),
            renderSupport:
              type === MATM_TYPE_STANDARD
                ? 'native'
                : presentation === undefined
                  ? 'surface-approximation'
                  : 'presentation',
            ...converted.metadata,
          },
        }
      }
    }

    const knownTag = type === MATM_TYPE_COMPOSITE ? 'CMP_' : SPECIALIZED_MATERIAL_TAGS[type]
    diagnostics.push({
      code: knownTag ? 'material-reference-invalid' : 'material-type-unsupported',
      message: knownTag
        ? `MATM ${matmIndex} references missing ${knownTag} material ${materialIndex}`
        : `MATM ${matmIndex} has unsupported material type ${type}`,
    })
    return {
      name: `Material_${matmIndex}`,
      layers: [],
      metadata: { matmType: type, materialIndex },
    }
  })

  return { materials, diagnostics }
}

/** Derive native refusal identities once, before the MK3 aggregate snapshot charges the result. */
export function m3MaterialProjectionRefusals(
  materials: readonly Pick<RenderMaterial, 'standard' | 'composite' | 'metadata'>[],
): readonly number[] {
  return materials.flatMap((material, index) =>
    material.metadata?.['m3UnsupportedMaterialFamilies'] !== undefined &&
      material.standard === undefined && (material.composite?.passes.length ?? 0) === 0 ? [index] : [])
}

/** Distinguish native unsupported projection from budget or malformed-reference failures. */
export class M3MaterialProjectionError extends TypeError {
  /** Record a rejected native MATM identity without creating a shared render presentation. */
  constructor(index: number) {
    super(`M3 unsupported reflection render projection at MATM ${index}; native inspection remains available`)
  }
}

/** Reject only actual users of the already-classified native refusal identities. */
export function assertM3MaterialProjection(
  refusals: readonly number[],
  materialIndices: Iterable<number>,
): void {
  const refused = new Set(refusals)
  for (const index of materialIndices) if (refused.has(index)) throw new M3MaterialProjectionError(index)
}

/** Models classifies REF_ once; its control textures are not shared surface color layers. */
function isUnsupportedM3Material(type: number): boolean {
  return type === MATM_TYPE_REFLECTION
}

/** Source-wide native loss fact, including unused entries; never a native material residual. */
export function m3MaterialLossMetadata(model: M3StructureData, sections: SectionResolver): Record<string, unknown> {
  const references = sections.getSectionByReference(model.material_references as M3Reference | undefined)
  return (references?.content as M3StructureData[] | undefined)?.some(
    record => isUnsupportedM3Material(record.type as number),
  ) ? { m3UnsupportedMaterialFamilies: ['REF_'] } : {}
}
