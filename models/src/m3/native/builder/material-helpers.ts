import type { M3Section, M3StructureData, M3Reference } from '../types.js'

/**
 * The real MAT_ layer reference fields (structures.xml MAT_ v15+, lines ~1180–1197).
 * Order matches the shader slot table in OPUS_TASK_P4_M3_MATERIALS.md §1.1.
 * The previous list contained mostly nonexistent names (layer_emi, layer_glow, …),
 * which is why most texture paths were never requested.
 */
export const MATERIAL_LAYER_FIELDS = [
  'layer_diff',
  'layer_decal',
  'layer_spec',
  'layer_gloss',
  'layer_emis1',
  'layer_emis2',
  'layer_envi',
  'layer_envi_mask',
  'layer_alpha1',
  'layer_alpha2',
  'layer_norm',
  'layer_height',
  'layer_light',
  'layer_ao',
  'layer_norm_blend1_mask',
  'layer_norm_blend2_mask',
  'layer_norm_blend1',
  'layer_norm_blend2',
]

export const UI_LAYER_FIELDS = [
  { key: 'layer_diff', label: 'Diffuse' },
  { key: 'layer_decal', label: 'Decal' },
  { key: 'layer_spec', label: 'Specular' },
  { key: 'layer_gloss', label: 'Gloss' },
  { key: 'layer_emis1', label: 'Emissive 1' },
  { key: 'layer_emis2', label: 'Emissive 2' },
  { key: 'layer_envi', label: 'Environment' },
  { key: 'layer_envi_mask', label: 'Environment Mask' },
  { key: 'layer_alpha1', label: 'Alpha Mask 1' },
  { key: 'layer_alpha2', label: 'Alpha Mask 2' },
  { key: 'layer_norm', label: 'Normal' },
  { key: 'layer_height', label: 'Height' },
  { key: 'layer_light', label: 'Light Map' },
  { key: 'layer_ao', label: 'Ambient Occlusion' },
]

type SectionResolver = {
  getSectionByReference(ref: M3Reference | null | undefined): M3Section | null
}

/** MATM material-reference types (structures.xml MATM). */
export const MATM_TYPE_STANDARD = 1
export const MATM_TYPE_DISPLACEMENT = 2
export const MATM_TYPE_COMPOSITE = 3
export const MATM_TYPE_TERRAIN = 4
export const MATM_TYPE_VOLUME = 5
export const MATM_TYPE_VOLUME_NOISE = 6
export const MATM_TYPE_CREEP = 7
/** Defunct in current SC2 assets but part of the documented MATM/HAI_ contract. */
export const MATM_TYPE_HAIR = 8
export const MATM_TYPE_SPLAT_TERRAIN_BAKE = 9
export const MATM_TYPE_REFLECTION = 10
export const MATM_TYPE_LENS_FLARE = 11
export const MATM_TYPE_BUFFER = 12

export interface RegionBatch {
  batchIndex: number
  /** Index into the MATM material_references list. */
  materialReferenceIndex: number
  /** MATM type: 1 = standard (MAT_), 3 = composite (CMP_), others unsupported. */
  matmType: number
  /** Index into the type-specific material list (materials_standard for type 1). */
  materialIndex: number
  /** Resolved MAT_ entry when matmType is standard, else null. */
  material: M3StructureData | null
  /**
   * Whether the game draws the batch's geometry. From MAT_ version 17 a standard material states it
   * (flag 0x80000000, geometry_visible); a mesh without it is there for hit tests, pathing or the
   * editor (InvisibleWalkablePlatform's slab), and the game never shows it. Earlier versions and
   * other material types always draw.
   */
  geometryVisible: boolean
}

/** MAT_ flag 0x80000000, stated from version 17 (structures.xml). */
const MAT_GEOMETRY_VISIBLE = 0x8000_0000
const MAT_GEOMETRY_VISIBLE_SINCE = 17

/**
 * All batches referencing a region, in stored batch order — a region can carry
 * several material batches (P3: the old single-`find` lookup dropped everything
 * after the first one).
 */
export function getAllRegionBatches(
  model: M3StructureData,
  sections: SectionResolver,
  division: M3StructureData,
  regionIndex: number,
): RegionBatch[] {
  const batchSection = sections.getSectionByReference(division.batches as M3Reference | undefined)
  if (!batchSection) return []
  const matRefSection = sections.getSectionByReference(
    model.material_references as M3Reference | undefined,
  )
  const matRefs = (matRefSection?.content ?? []) as M3StructureData[]
  const matSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  const standardMaterials = (matSection?.content ?? []) as M3StructureData[]

  const result: RegionBatch[] = []
  const batches = batchSection.content as M3StructureData[]
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]
    if (!batch || (batch.region_index as number) !== regionIndex) continue
    const materialReferenceIndex = (batch.material_reference_index as number) ?? 0
    const matRef = matRefs[materialReferenceIndex]
    const matmType = (matRef?.type as number) ?? -1
    const materialIndex = (matRef?.material_index as number) ?? -1
    const material =
      matmType === MATM_TYPE_STANDARD ? (standardMaterials[materialIndex] ?? null) : null
    const flags = Number(material?.flags ?? 0) >>> 0
    result.push({
      batchIndex,
      materialReferenceIndex,
      matmType,
      materialIndex,
      material,
      geometryVisible:
        material === null ||
        (matSection?.desc.version ?? 0) < MAT_GEOMETRY_VISIBLE_SINCE ||
        (flags & MAT_GEOMETRY_VISIBLE) !== 0,
    })
  }
  return result
}

/**
 * First standard material of a region — legacy single-material lookup kept for
 * existing consumers; new code should iterate getAllRegionBatches.
 */
export function getRegionMaterial(
  model: M3StructureData,
  sections: SectionResolver,
  division: M3StructureData,
  regionIndex: number,
): M3StructureData | null {
  for (const batch of getAllRegionBatches(model, sections, division, regionIndex)) {
    if (batch.material) return batch.material
  }
  return null
}
