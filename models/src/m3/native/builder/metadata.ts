import type {
  M3StructureData,
  M3Reference,
  AttachmentPoint,
  MaterialInfo,
  BoneInfo,
  HitVolume,
  BoundsInfo,
  LightInfo,
  TurretInfo,
  SectionResolver,
  CameraInfo,
  RibbonInfo,
  ParticleSystemInfo,
  ProjectionInfo,
  ForceInfo,
  BillboardInfo,
  WarpInfo,
  ShadowboxInfo,
  RigidBodyInfo,
  RigidBodyShapeInfo,
  PhysicsConstraintInfo,
  PhysicsJointInfo,
  PhysicsClothInfo,
  IkInfo,
} from '../types.js'
import { getSectionString } from '../utils/texture.js'
import { m3MatrixToArray } from '../utils/matrix.js'
import { BoneResolver } from '../utils/bone-resolver.js'
import { MATERIAL_LAYER_FIELDS, UI_LAYER_FIELDS } from './material-helpers.js'

export function buildAttachmentPoints(
  model: M3StructureData,
  sections: SectionResolver,
): AttachmentPoint[] {
  const attSection = sections.getSectionByReference(
    model.attachment_points as M3Reference | undefined,
  )
  if (!attSection) return []
  return (attSection.content as M3StructureData[]).map((att, i) => ({
    name: getSectionString(sections, att.name as M3Reference | null) ?? `Attachment_${i}`,
    boneIndex: (att.bone as number) ?? -1,
  }))
}

export function getModelTextureFilenames(
  model: M3StructureData,
  sections: SectionResolver,
): Set<string> {
  const filenames = new Set<string>()
  const matSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  if (matSection) {
    for (const mat of matSection.content as M3StructureData[]) {
      for (const field of MATERIAL_LAYER_FIELDS) {
        const ref = mat[field] as M3Reference | undefined
        if (!ref) continue
        const layerSec = sections.getSectionByReference(ref)
        const layer = layerSec?.content[0] as M3StructureData | undefined
        if (!layer || !layer.color_bitmap) continue
        const m3Path = getSectionString(sections, layer.color_bitmap as M3Reference | null)
        if (m3Path) {
          const filename = m3Path.replace(/\\/g, '/').split('/').pop()
          if (filename) filenames.add(filename)
        }
      }
    }
  }
  return filenames
}

/** Returns the full relative texture paths as stored in the M3 binary, forward-slash normalised.
 *  E.g. "Assets/Textures/Foo_Diffuse.dds" — join with an sc2mod root for direct file lookup. */
export function getModelTexturePaths(model: M3StructureData, sections: SectionResolver): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const matSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  if (matSection) {
    for (const mat of matSection.content as M3StructureData[]) {
      for (const field of MATERIAL_LAYER_FIELDS) {
        const ref = mat[field] as M3Reference | undefined
        if (!ref) continue
        const layerSec = sections.getSectionByReference(ref)
        const layer = layerSec?.content[0] as M3StructureData | undefined
        if (!layer || !layer.color_bitmap) continue
        const m3Path = getSectionString(sections, layer.color_bitmap as M3Reference | null)
        if (m3Path) {
          const normalized = m3Path.replace(/\\/g, '/')
          if (normalized && !seen.has(normalized)) {
            seen.add(normalized)
            paths.push(normalized)
          }
        }
      }
    }
  }
  return paths
}

export function buildMaterialList(
  model: M3StructureData,
  sections: SectionResolver,
): MaterialInfo[] {
  const matSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  if (!matSection) return []

  return (matSection.content as M3StructureData[]).map((mat, i) => {
    const name = getSectionString(sections, mat.name as M3Reference | null) || `Material_${i}`
    const textures: { label: string; filename: string }[] = []
    for (const { key, label } of UI_LAYER_FIELDS) {
      const ref = mat[key] as M3Reference | undefined
      if (!ref) continue
      const layerSec = sections.getSectionByReference(ref)
      const layer = layerSec?.content[0] as M3StructureData | undefined
      if (!layer || !layer.color_bitmap) continue
      const m3Path = getSectionString(sections, layer.color_bitmap as M3Reference | null)
      if (!m3Path) continue
      const normalized = m3Path.replace(/\\/g, '/')
      textures.push({ label, filename: normalized })
    }
    return { name, textures }
  })
}

export function buildBoneHierarchy(model: M3StructureData, sections: SectionResolver): BoneInfo[] {
  const boneSection = sections.getSectionByReference(model.bones as M3Reference | undefined)
  if (!boneSection) return []
  return (boneSection.content as M3StructureData[]).map((bone, i) => ({
    index: i,
    name: getSectionString(sections, bone.name as M3Reference | null) || `Bone_${i}`,
    parentIndex: bone.parent != null && (bone.parent as number) >= 0 ? (bone.parent as number) : -1,
    flags: (bone.flags as number) ?? 0,
  }))
}

export function buildHitVolumes(
  model: M3StructureData,
  sections: SectionResolver,
): { tight: HitVolume | null; hittests: HitVolume[]; attachmentVolumes: HitVolume[] } {
  function ssgsToObj(s: M3StructureData | undefined, i: number): HitVolume | null {
    if (!s || s.shape === undefined) return null
    try {
      return {
        index: i,
        shape: s.shape as number,
        boneIndex: s.bone as number,
        matrix4: m3MatrixToArray(s.matrix as M3StructureData),
        size0: s.size0 as number,
        size1: s.size1 as number,
        size2: s.size2 as number,
      }
    } catch {
      return null
    }
  }

  function atvlToObj(a: M3StructureData | undefined, i: number): HitVolume | null {
    if (!a) return null
    try {
      return {
        index: i,
        shape: a.shape as number,
        boneIndex: a.bone0 as number,
        matrix4: m3MatrixToArray(a.matrix as M3StructureData),
        size0: a.size0 as number,
        size1: a.size1 as number,
        size2: a.size2 as number,
      }
    } catch {
      return null
    }
  }

  const hitSection = sections.getSectionByReference(model.hittests as M3Reference | undefined)
  const hittests: HitVolume[] = []
  if (hitSection) {
    const content = hitSection.content as M3StructureData[]
    for (let i = 0; i < content.length; i++) {
      const v = ssgsToObj(content[i], i)
      if (v) hittests.push(v)
    }
  }

  const atvlSection = sections.getSectionByReference(
    model.attachment_volumes as M3Reference | undefined,
  )
  const attachmentVolumes: HitVolume[] = []
  if (atvlSection) {
    const content = atvlSection.content as M3StructureData[]
    for (let i = 0; i < content.length; i++) {
      const v = atvlToObj(content[i], i)
      if (v) attachmentVolumes.push(v)
    }
  }

  let tight: HitVolume | null = null
  try {
    if (model.hittest_tight) {
      tight = ssgsToObj(model.hittest_tight as M3StructureData, -1)
    }
  } catch {
    // ignore
  }

  return { tight, hittests, attachmentVolumes }
}

export function buildBounds(model: M3StructureData): BoundsInfo | null {
  const b = model.boundings as Record<string, number | Record<string, number>> | undefined
  if (!b) return null
  const min = b.min as Record<string, number> | undefined
  const max = b.max as Record<string, number> | undefined
  if (!min || !max) return null
  return {
    left: min.x,
    right: max.x,
    back: min.y,
    front: max.y,
    bottom: min.z,
    top: max.z,
    radius: (b.radius as number) ?? 0,
  }
}

export function buildLights(model: M3StructureData, sections: SectionResolver): LightInfo[] {
  const lightSection = sections.getSectionByReference(model.lights as M3Reference | undefined)
  if (!lightSection || !lightSection.content.length) return []
  const bones = new BoneResolver(sections, model)
  const shapeNames = ['Directional', 'Point', 'Spot']
  return (lightSection.content as M3StructureData[]).map((l, i) => {
    const boneIndex = (l.bone as number) ?? -1
    const type = (l.shape as number) ?? 0
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Light_${i}`),
      type,
      shape: shapeNames[type] ?? 'Unknown',
      boneIndex,
      flags: (l.flags as number) ?? 0,
      color: readAnimVec3(l.color as M3StructureData | undefined),
      intensity: readAnimFloat(l.intensity as M3StructureData | undefined, 1),
      specularColor: readAnimVec3(l.spec_color as M3StructureData | undefined),
      specularIntensity: readAnimFloat(l.spec_intensity as M3StructureData | undefined, 1),
      decay: readAnimFloat(l.decay as M3StructureData | undefined, 1),
      attenuationNear: readAnimFloat(l.attenuation_near as M3StructureData | undefined, 0),
      attenuationFar: (l.attenuation_far as number) ?? 0,
      hotspot: readAnimFloat(l.hotspot as M3StructureData | undefined, 0),
      falloff: readAnimFloat(l.falloff as M3StructureData | undefined, 0),
    }
  })
}

export function buildTurrets(model: M3StructureData, sections: SectionResolver): TurretInfo[] {
  const turretSection = sections.getSectionByReference(model.turrets as M3Reference | undefined)
  if (!turretSection || !turretSection.content.length) return []
  const partData = (sections.getSectionByReference(model.turret_parts as M3Reference | undefined)
    ?.content ?? []) as M3StructureData[]
  const bones = new BoneResolver(sections, model)

  return (turretSection.content as M3StructureData[]).map((t, i) => {
    const name = getSectionString(sections, t.name as M3Reference | null) || `Turret_${i}`
    const partIndices = (sections.getSectionByReference(t.parts as M3Reference | undefined)
      ?.content ?? []) as number[]
    const parts = partIndices
      .map(ii => {
        const p = partData[ii]
        if (!p) return null
        const boneIndex = (p.bone as number) ?? -1
        return { boneIndex, boneName: bones.getNameOrFallback(boneIndex, `Bone_${boneIndex}`) }
      })
      .filter(Boolean) as { boneIndex: number; boneName: string }[]
    return { index: i, name, parts }
  })
}

export function buildCameras(model: M3StructureData, sections: SectionResolver): CameraInfo[] {
  const cameraSection = sections.getSectionByReference(model.cameras as M3Reference | undefined)
  if (!cameraSection) return []
  const bones = new BoneResolver(sections, model)

  function getAnimFloat(animRef: M3StructureData | number | undefined, fallback: number): number {
    if (typeof animRef === 'number') return Number.isFinite(animRef) ? animRef : fallback
    if (!animRef) return fallback
    const defVal =
      (animRef.default as number) ?? (animRef as unknown as Record<string, number>).default
    if (typeof defVal === 'number' && !isNaN(defVal)) return defVal
    return fallback
  }

  return (cameraSection.content as M3StructureData[]).map((c, i) => {
    const boneIndex = (c.bone as number) ?? -1
    const shadowClipDistance = getAnimFloat(
      c.shadow_clip_distance as M3StructureData | undefined,
      10,
    )
    const focusDistance = getAnimFloat(c.focus_distance as M3StructureData | undefined, 2)
    const farFocusRange = getAnimFloat(c.far_focus_range as M3StructureData | undefined, 1)
    const nearFocusRange = getAnimFloat(c.near_focus_range as M3StructureData | undefined, 2)
    return {
      index: i,
      name:
        getSectionString(sections, c.name as M3Reference | null) ||
        bones.getNameOrFallback(boneIndex, `Camera_${i}`),
      boneIndex,
      fieldOfView: getAnimFloat(c.field_of_view as M3StructureData | undefined, 0.5),
      farClip: getAnimFloat(
        (c.far_clip ?? c.far_clip_static) as M3StructureData | number | undefined,
        10000,
      ),
      nearClip: getAnimFloat(
        (c.near_clip ?? c.near_clip_static) as M3StructureData | number | undefined,
        0.1,
      ),
      shadowClipDistance,
      focusDistance,
      farFocusRange,
      nearFocusRange,
      nearFalloffStart: getAnimFloat(c.near_falloff_start as M3StructureData | undefined, 0),
      nearFalloffEnd: getAnimFloat(c.near_falloff_end as M3StructureData | undefined, 0),
      dofType: (c.depth_of_field_type as number) ?? 3,
      bokehFStop: getAnimFloat(c.bokeh_f_stop as M3StructureData | undefined, 0),
      bokehMaxCoCDiameter: getAnimFloat(c.bokeh_max_coc_diameter as M3StructureData | undefined, 0),
      // Compatibility aliases for the pre-spec-alignment public API.
      clip2: shadowClipDistance,
      focalDepth: focusDistance,
      falloffStart: farFocusRange,
      falloffEnd: nearFocusRange,
      depthOfField: getAnimFloat(c.depth_of_field as M3StructureData | undefined, 0.5),
      useVerticalFov: Boolean(c.use_vertical_fov ?? 1),
    }
  })
}

// ── Material texture helper ───────────────────────────────────────────────────

function getEffectTextureFilename(
  model: M3StructureData,
  sections: SectionResolver,
  materialRefIndex: number,
): string | null {
  const matRefSection = sections.getSectionByReference(
    model.material_references as M3Reference | undefined,
  )
  if (!matRefSection) return null
  const matRef = (matRefSection.content as M3StructureData[])[materialRefIndex]
  if (!matRef || (matRef.type as number) !== 1) return null
  const matSection = sections.getSectionByReference(
    model.materials_standard as M3Reference | undefined,
  )
  if (!matSection) return null
  const mat = (matSection.content as M3StructureData[])[(matRef.material_index as number) ?? 0]
  if (!mat) return null
  for (const key of ['layer_emis1', 'layer_emis2', 'layer_diff']) {
    const ref = mat[key] as M3Reference | undefined
    if (!ref) continue
    const layerSec = sections.getSectionByReference(ref)
    const layer = layerSec?.content[0] as M3StructureData | undefined
    if (!layer?.color_bitmap) continue
    const path = getSectionString(sections, layer.color_bitmap as M3Reference | null)
    if (path) return path
  }
  return null
}

// ── Animation reference helpers ───────────────────────────────────────────────

function readAnimFloat(ref: M3StructureData | null | undefined, fallback = 0): number {
  if (!ref) return fallback
  return (ref.default as number) ?? fallback
}

function readAnimColor(ref: M3StructureData | null | undefined): [number, number, number, number] {
  if (!ref) return [1, 1, 1, 1]
  const col = ref.default as M3StructureData | null
  if (!col) return [1, 1, 1, 1]
  return [
    ((col.r as number) ?? 255) / 255,
    ((col.g as number) ?? 255) / 255,
    ((col.b as number) ?? 255) / 255,
    ((col.a as number) ?? 255) / 255,
  ]
}

function readAnimVec3(
  ref: M3StructureData | null | undefined,
  fb: [number, number, number] = [1, 1, 1],
): [number, number, number] {
  if (!ref) return fb
  const v = ref.default as M3StructureData | null
  if (!v) return fb
  return [(v.x as number) ?? fb[0], (v.y as number) ?? fb[1], (v.z as number) ?? fb[2]]
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildRibbons(model: M3StructureData, sections: SectionResolver): RibbonInfo[] {
  const ribbonSection = sections.getSectionByReference(model.ribbons as M3Reference | undefined)
  if (!ribbonSection) return []
  const bones = new BoneResolver(sections, model)

  return (ribbonSection.content as M3StructureData[]).map((r, i) => {
    const boneIndex = (r.bone as number) ?? -1
    const materialIndex = (r.material_reference_index as number) ?? 0
    const colorBase = readAnimColor(r.color_base as M3StructureData | undefined)
    const colorMid = readAnimColor(r.color_mid as M3StructureData | undefined)
    const colorTip = readAnimColor(r.color_tip as M3StructureData | undefined)
    const sizeCurve = readAnimVec3(r.scale as M3StructureData | undefined, [0.5, 0.5, 0.5])
    const sizeBase: [number, number, number] = [sizeCurve[0], sizeCurve[0], sizeCurve[0]]
    const sizeMid: [number, number, number] = [sizeCurve[1], sizeCurve[1], sizeCurve[1]]
    const sizeTip: [number, number, number] = [sizeCurve[2], sizeCurve[2], sizeCurve[2]]
    const lifespan = readAnimFloat(r.lifespan as M3StructureData | undefined, 1)

    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Ribbon_${i}`),
      boneIndex,
      materialIndex,
      materialName: `Material_${materialIndex}`,
      segments: 32,
      edge: 1,
      color: [colorBase[0], colorBase[1], colorBase[2]] as [number, number, number],
      alpha: colorBase[3],
      size: sizeCurve,
      duration: lifespan,
      lifespan,
      speed: readAnimFloat(r.speed as M3StructureData | undefined, 0),
      gravityX: (r.gravity_x as number) ?? 0,
      gravityY: (r.gravity_y as number) ?? 0,
      gravityZ: (r.gravity as number) ?? 0,
      drag: (r.drag as number) ?? 0,
      colorBase,
      colorMid,
      colorTip,
      colorAnimMid: (r.color_anim_mid as number) ?? 0.5,
      sizeBase,
      sizeMid,
      sizeTip,
      sizeAnimMid: (r.scale_anim_mid_time as number) ?? (r.scale_anim_mid as number) ?? 0.5,
      ribbonType: (r.ribbon_type as number) ?? 0,
      divisions: (r.divisions as number) ?? 8,
      sides: (r.sides as number) ?? 1,
      starRatio: (r.star_ratio as number) ?? 0.5,
      segmentLength: readAnimFloat(r.length as M3StructureData | undefined, 0.2),
      flags: (r.flags as number) ?? 0,
      textureFilename: getEffectTextureFilename(model, sections, materialIndex),
    }
  })
}

export function buildParticles(
  model: M3StructureData,
  sections: SectionResolver,
): ParticleSystemInfo[] {
  const particleSection = sections.getSectionByReference(
    model.particle_systems as M3Reference | undefined,
  )
  if (!particleSection) return []
  const bones = new BoneResolver(sections, model)

  return (particleSection.content as M3StructureData[]).map((p, i) => {
    const boneIndex = (p.bone as number) ?? -1
    const materialIndex = (p.material_reference_index as number) ?? 0
    const flags = (p.flags as number) ?? 0
    const addlFlags = (p.additional_flags as number) ?? 0
    const sizeCurve = readAnimVec3(p.size as M3StructureData | undefined, [0.1, 0.1, 0.1])
    const sizeRandomCurve = readAnimVec3(p.size2 as M3StructureData | undefined, sizeCurve)
    const sizeInit: [number, number, number] = [sizeCurve[0], sizeCurve[0], sizeCurve[0]]
    const sizeMid: [number, number, number] = [sizeCurve[1], sizeCurve[1], sizeCurve[1]]
    const sizeEnd: [number, number, number] = [sizeCurve[2], sizeCurve[2], sizeCurve[2]]
    const sizeRandomInit: [number, number, number] = [
      sizeRandomCurve[0],
      sizeRandomCurve[0],
      sizeRandomCurve[0],
    ]
    const sizeRandomMid: [number, number, number] = [
      sizeRandomCurve[1],
      sizeRandomCurve[1],
      sizeRandomCurve[1],
    ]
    const sizeRandomEnd: [number, number, number] = [
      sizeRandomCurve[2],
      sizeRandomCurve[2],
      sizeRandomCurve[2],
    ]

    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Particle_${i}`),
      boneIndex,
      materialIndex,
      materialName: `Material_${materialIndex}`,
      particleType: String((p.particle_type as number) ?? 0),
      emitType: String((p.emit_type as number) ?? 0),
      emitShape: String((p.emit_shape as number) ?? 0),
      emitRate: readAnimFloat(p.emit_rate as M3StructureData | undefined, 10),
      lifespan: readAnimFloat(p.lifespan as M3StructureData | undefined, 1),
      maxParticles: (p.emit_max as number) ?? 100,
      gravity: (p.gravity as number) ?? 0,
      friction: (p.friction as number) ?? 0,
      drag: (p.drag as number) ?? 0,
      emitSpeed: readAnimFloat(p.emit_speed as M3StructureData | undefined, 1),
      emitAngleX: readAnimFloat(p.emit_angle_x as M3StructureData | undefined, 0),
      emitAngleY: readAnimFloat(p.emit_angle_y as M3StructureData | undefined, 0),
      emitSpreadX: readAnimFloat(p.emit_spread_x as M3StructureData | undefined, 0.5),
      emitSpreadY: readAnimFloat(p.emit_spread_y as M3StructureData | undefined, 0.5),
      emitShapeSize: readAnimVec3(p.emit_shape_size as M3StructureData | undefined, [1, 1, 1]),
      emitShapeRadius: readAnimFloat(p.emit_shape_radius as M3StructureData | undefined, 1),
      sizeInit,
      sizeMid,
      sizeEnd,
      sizeRandomInit,
      sizeRandomMid,
      sizeRandomEnd,
      sizeRandomize: Number(p.size_randomize ?? 0) !== 0,
      sizeAnimMid: (p.size_anim_mid as number) ?? 0.5,
      colorInit: readAnimColor(p.color_init as M3StructureData | undefined),
      colorMid: readAnimColor(p.color_mid as M3StructureData | undefined),
      colorEnd: readAnimColor(p.color_end as M3StructureData | undefined),
      colorAnimMid: (p.color_anim_mid as number) ?? 0.5,
      flags,
      localSpace: (addlFlags & 0x8) === 0,
      textureFilename: getEffectTextureFilename(model, sections, materialIndex),
    }
  })
}

export function buildProjections(
  model: M3StructureData,
  sections: SectionResolver,
): ProjectionInfo[] {
  const projSection = sections.getSectionByReference(model.projections as M3Reference | undefined)
  if (!projSection) return []
  const bones = new BoneResolver(sections, model)

  return (projSection.content as M3StructureData[]).map((p, i) => {
    const boneIndex = (p.bone as number) ?? -1
    const materialIndex = (p.material_reference_index as number) ?? 0
    const projectionType = (p.projection_type as number) ?? 0
    const projectionTypes = ['Orthographic', 'Perspective']
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Projection_${i}`),
      projectionType,
      type: projectionTypes[projectionType] ?? `Unknown_${projectionType}`,
      boneIndex,
      materialIndex,
      materialName: `Material_${materialIndex}`,
      offset: readAnimVec3(p.offset as M3StructureData | undefined, [0, 0, 0]),
      pitch: readAnimFloat(p.pitch as M3StructureData | undefined, 0),
      yaw: readAnimFloat(p.yaw as M3StructureData | undefined, 0),
      roll: readAnimFloat(p.roll as M3StructureData | undefined, 0),
      fieldOfView: readAnimFloat(p.field_of_view as M3StructureData | undefined, 0),
      aspectRatio: readAnimFloat(p.aspect_ratio as M3StructureData | undefined, 0),
      near: readAnimFloat(p.near as M3StructureData | undefined, 0),
      far: readAnimFloat(p.far as M3StructureData | undefined, 0),
      boxOffsetZBottom: readAnimFloat(p.box_offset_z_bottom as M3StructureData | undefined, 0),
      boxOffsetZTop: readAnimFloat(p.box_offset_z_top as M3StructureData | undefined, 0),
      boxOffsetXLeft: readAnimFloat(p.box_offset_x_left as M3StructureData | undefined, 0),
      boxOffsetXRight: readAnimFloat(p.box_offset_x_right as M3StructureData | undefined, 0),
      boxOffsetYFront: readAnimFloat(p.box_offset_y_front as M3StructureData | undefined, 0),
      boxOffsetYBack: readAnimFloat(p.box_offset_y_back as M3StructureData | undefined, 0),
      falloff: (p.falloff as number) ?? 0,
      alphaInit: (p.alpha_init as number) ?? 0,
      alphaMid: (p.alpha_mid as number) ?? 0,
      alphaEnd: (p.alpha_end as number) ?? 0,
      lifetimeAttack: (p.lifetime_attack as number) ?? 0,
      lifetimeAttackTo: (p.lifetime_attack_to as number) ?? 0,
      lifetimeHold: (p.lifetime_hold as number) ?? 0,
      lifetimeHoldTo: (p.lifetime_hold_to as number) ?? 0,
      lifetimeDecay: (p.lifetime_decay as number) ?? 0,
      lifetimeDecayTo: (p.lifetime_decay_to as number) ?? 0,
      attenuationDistance: (p.attenuation_distance as number) ?? 0,
      active: readAnimFloat(p.active as M3StructureData | undefined, 0),
      layer: (p.layer as number) ?? 0,
      lodReduce: (p.lod_reduce as number) ?? 0,
      lodCut: (p.lod_cut as number) ?? 0,
      flags: (p.flags as number) ?? 0,
    }
  })
}

export function buildForces(model: M3StructureData, sections: SectionResolver): ForceInfo[] {
  const forceSection = sections.getSectionByReference(model.forces as M3Reference | undefined)
  if (!forceSection) return []
  const bones = new BoneResolver(sections, model)
  const forceTypes = ['Radial', 'Wind', 'Explosion']
  const forceShapes = ['Sphere', 'Cylinder', 'Box', 'Hemisphere']

  return (forceSection.content as M3StructureData[]).map((f, i) => {
    const boneIndex = (f.bone as number) ?? -1
    const forceType = (f.force_type as number) ?? 0
    const shape = (f.shape as number) ?? 0
    const flags = (f.flags as number) ?? 0
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Force_${i}`),
      boneIndex,
      forceType,
      type: forceTypes[forceType] ?? `Unknown_${forceType}`,
      shape,
      shapeName: forceShapes[shape] ?? `Unknown_${shape}`,
      unknownFor0: (f.unknown_for0 as number) ?? 0,
      flags,
      channels: (f.channels as number) ?? 0,
      falloff: (flags & 0x1) !== 0,
      heightGradient: (flags & 0x2) !== 0,
      unbounded: (flags & 0x4) !== 0,
      strength: readAnimFloat(f.strength as M3StructureData | undefined, 0),
      width: readAnimFloat(f.width as M3StructureData | undefined, 0),
      height: readAnimFloat(f.height as M3StructureData | undefined, 0),
      length: readAnimFloat(f.length as M3StructureData | undefined, 0),
    }
  })
}

export function buildBillboards(
  model: M3StructureData,
  sections: SectionResolver,
): BillboardInfo[] {
  const bbSection = sections.getSectionByReference(model.billboards as M3Reference | undefined)
  if (!bbSection) return []
  const bones = new BoneResolver(sections, model)

  const names = ['world-x', 'world-y', 'world-z', 'bone-x', 'unused', 'bone-y', 'free']
  const quaternion = (value: unknown): [number, number, number, number] => {
    const q = (value ?? {}) as Record<string, unknown>
    const component = (key: string, fallback: number) =>
      typeof q[key] === 'number' && Number.isFinite(q[key]) ? (q[key] as number) : fallback
    return [component('x', 0), component('y', 0), component('z', 0), component('w', 1)]
  }
  return (bbSection.content as M3StructureData[]).map((b, i) => {
    const boneIndex = (b.bone as number) ?? -1
    const billboardType = Number(b.billboard_type ?? 6)
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Billboard_${i}`),
      boneIndex,
      type: names[billboardType] ?? `type-${billboardType}`,
      billboardType,
      cameraLookAt: Number(b.camera_look_at ?? 1) !== 0,
      up: quaternion(b.up),
      forward: quaternion(b.forward),
    }
  })
}

export function buildWarps(model: M3StructureData, sections: SectionResolver): WarpInfo[] {
  const warpSection = sections.getSectionByReference(model.warps as M3Reference | undefined)
  if (!warpSection) return []
  const bones = new BoneResolver(sections, model)

  return (warpSection.content as M3StructureData[]).map((w, i) => {
    const boneIndex = (w.bone as number) ?? -1
    const warpType = (w.unknown861f507b as number) ?? 0
    const height = readAnimFloat(w.unknown9306aac0 as M3StructureData | undefined, 0)
    const angular = readAnimFloat(w.unknown50c7f2b4 as M3StructureData | undefined, 0)
    const axial = readAnimFloat(w.unknown8d9c977c as M3StructureData | undefined, 0)
    const radial = readAnimFloat(w.unknownca6025a2 as M3StructureData | undefined, 0)
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `Warp_${i}`),
      boneIndex,
      unknown861f507b: warpType,
      warpType,
      unknowncf03b856: (w.unknowncf03b856 as number) ?? 0,
      radius: readAnimFloat(w.radius as M3StructureData | undefined, 0),
      unknown9306aac0: height,
      height,
      strength: readAnimFloat(w.strength as M3StructureData | undefined, 0),
      unknown50c7f2b4: angular,
      angular,
      unknown8d9c977c: axial,
      axial,
      unknownca6025a2: radial,
      radial,
    }
  })
}

export function buildShadowboxes(
  model: M3StructureData,
  sections: SectionResolver,
): ShadowboxInfo[] {
  const sbSection = sections.getSectionByReference(model.shadowboxes as M3Reference | undefined)
  if (!sbSection) return []

  return (sbSection.content as M3StructureData[]).map((s, i) => {
    const matrix4 = m3MatrixToArray(s.matrix as M3StructureData)
    const halfExtents: [number, number, number] = [
      Math.hypot(matrix4[0] ?? 0, matrix4[1] ?? 0, matrix4[2] ?? 0),
      Math.hypot(matrix4[4] ?? 0, matrix4[5] ?? 0, matrix4[6] ?? 0),
      Math.hypot(matrix4[8] ?? 0, matrix4[9] ?? 0, matrix4[10] ?? 0),
    ]
    return {
      index: i,
      name: `Shadowbox_${i}`,
      matrix4,
      position: [matrix4[12] ?? 0, matrix4[13] ?? 0, matrix4[14] ?? 0],
      halfExtents,
      size: [halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2],
    }
  })
}

export function buildRigidBodies(
  model: M3StructureData,
  sections: SectionResolver,
): RigidBodyInfo[] {
  const rbSection = sections.getSectionByReference(
    model.physics_rigidbodies as M3Reference | undefined,
  )
  if (!rbSection) return []
  const bones = new BoneResolver(sections, model)
  const shapeNames: RigidBodyShapeInfo['shape'][] = [
    'Box',
    'Sphere',
    'Capsule',
    'Cylinder',
    'ConvexHull',
    'Mesh',
  ]

  return (rbSection.content as M3StructureData[]).map((r, i) => {
    const boneIndex = (r.bone as number) ?? -1
    const shapeSection = sections.getSectionByReference(r.physics_shape as M3Reference | undefined)
    const shapes = ((shapeSection?.content ?? []) as M3StructureData[]).map((shape, shapeIndex) => {
      const shapeCode = finiteNumber(shape.shape, -1)
      return {
        index: shapeIndex,
        shape: shapeNames[shapeCode] ?? 'Unknown',
        shapeCode,
        matrix4: safeMatrix4(shape.matrix),
        size: [
          finiteNumber(shape.size0, 1),
          finiteNumber(shape.size1, 1),
          finiteNumber(shape.size2, 1),
        ],
        vertices: referenceVector3s(sections, shape.vertices),
      } satisfies RigidBodyShapeInfo
    })
    const primaryShape = shapes[0]
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `RigidBody_${i}`),
      boneIndex,
      // Preserve the legacy summary fields for existing editor panels.
      shape: primaryShape?.shape ?? 'Unknown',
      size: primaryShape?.size ?? [1, 1, 1],
      mass: finiteNumber(r.mass, 1),
      friction: finiteNumber(r.friction, 0.5),
      restitution: finiteNumber(r.bounce, 0.2),
      simulationType: finiteNumber(r.simulation_type, 1),
      physicalMaterial: finiteNumber(r.physical_material, 0),
      dampingLinear: finiteNumber(r.damping_linear, 0.001),
      dampingAngular: finiteNumber(r.damping_angular, 0.001),
      gravityFactor: finiteNumber(r.gravity_factor, 1),
      flags: finiteNumber(r.flags, 0),
      localForces: finiteNumber(r.local_forces, 0),
      worldForces: finiteNumber(r.world_forces, 0),
      priority: finiteNumber(r.priority, 0),
      shapes,
    }
  })
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function safeMatrix4(value: unknown): number[] {
  try {
    return m3MatrixToArray(value as M3StructureData)
  } catch {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  }
}

function referenceVector3s(sections: SectionResolver, value: unknown): [number, number, number][] {
  const section = sections.getSectionByReference(value as M3Reference | undefined)
  if (!section) return []
  const vertices: [number, number, number][] = []
  for (const entry of section.content as unknown[]) {
    if (Array.isArray(entry) || ArrayBuffer.isView(entry)) {
      const values = Array.from(entry as ArrayLike<number>)
      vertices.push([
        finiteNumber(values[0], 0),
        finiteNumber(values[1], 0),
        finiteNumber(values[2], 0),
      ])
      continue
    }
    const vector = entry as M3StructureData
    vertices.push([
      finiteNumber(vector?.x, 0),
      finiteNumber(vector?.y, 0),
      finiteNumber(vector?.z, 0),
    ])
  }
  return vertices
}

export function buildPhysicsConstraints(
  model: M3StructureData,
  sections: SectionResolver,
): PhysicsConstraintInfo[] {
  const constraintSection = sections.getSectionByReference(
    model.physics_constraints as M3Reference | undefined,
  )
  if (!constraintSection) return []
  return (constraintSection.content as M3StructureData[]).map((constraint, index) => {
    const dependentSection = sections.getSectionByReference(
      constraint.dependents as M3Reference | undefined,
    )
    const dependentIndices = (dependentSection?.content ?? [])
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value >= 0)
    return {
      index,
      dependentIndices,
      rigidBodyIndex0: (constraint.rigid_body1 as number) ?? -1,
      rigidBodyIndex1: (constraint.rigid_body2 as number) ?? -1,
      flags: (constraint.flags as number) ?? 0,
      breakForce: (constraint.break_force as number) ?? 0,
    }
  })
}

export function buildPhysicsJoints(
  model: M3StructureData,
  sections: SectionResolver,
): PhysicsJointInfo[] {
  const jointSection = sections.getSectionByReference(
    model.physics_joints as M3Reference | undefined,
  )
  if (!jointSection) return []
  const bones = new BoneResolver(sections, model)

  return (jointSection.content as M3StructureData[]).map((j, i) => {
    const boneIndex0 = (j.bone0 as number) ?? -1
    const boneIndex1 = (j.bone1 as number) ?? -1
    return {
      index: i,
      name: `Joint_${i}`,
      boneIndex0,
      boneIndex1,
      boneName0: bones.getNameOrFallback(boneIndex0, `Bone_${boneIndex0}`),
      boneName1: bones.getNameOrFallback(boneIndex1, `Bone_${boneIndex1}`),
      type: (j.type as string) ?? 'Hinge',
      position: [
        (j.position_x as number) ?? 0,
        (j.position_y as number) ?? 0,
        (j.position_z as number) ?? 0,
      ],
      limits: { min: (j.limit_min as number) ?? 0, max: (j.limit_max as number) ?? 90 },
    }
  })
}

export function buildPhysicsCloths(
  model: M3StructureData,
  sections: SectionResolver,
): PhysicsClothInfo[] {
  const clothSection = sections.getSectionByReference(
    model.physics_cloths as M3Reference | undefined,
  )
  if (!clothSection) return []

  return (clothSection.content as M3StructureData[]).map((c, i) => {
    const bonesVal = c.bones
    const boneIndices = Array.isArray(bonesVal) ? bonesVal.map(b => Number(b)) : []
    return {
      index: i,
      name: `Cloth_${i}`,
      boneIndices,
      vertexCount: (c.vertex_count as number) ?? 0,
      stiffness: (c.stiffness as number) ?? 0.5,
    }
  })
}

export function buildIk(model: M3StructureData, sections: SectionResolver): IkInfo[] {
  const ikSection = sections.getSectionByReference(model.ik as M3Reference | undefined)
  if (!ikSection) return []
  const bones = new BoneResolver(sections, model)

  return (ikSection.content as M3StructureData[]).map((ik, i) => {
    const boneIndex = (ik.bone as number) ?? -1
    return {
      index: i,
      name: bones.getNameOrFallback(boneIndex, `IK_${i}`),
      boneIndex,
      targetBoneIndex: (ik.target_bone as number) ?? -1,
      effectorBoneIndex: (ik.effector_bone as number) ?? -1,
      type: (ik.type as string) ?? 'LookAt',
      weight: (ik.weight as number) ?? 1,
      enabled: (ik.enabled as boolean) ?? true,
    }
  })
}
