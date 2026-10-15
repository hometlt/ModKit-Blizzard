/** Native M3 preview projection. Meshes retain MATM identities; particle-only derived surfaces
 * share the strict lighting owner with UVM. No native writes or game-visual fidelity implied. */
import type {
  Bounds,
  RenderCollisionShape,
  RenderMesh,
  RenderModel,
} from '@modkit/codec-kit/legacy/models'
import type { M3Model } from './model.js'
import type { M3Reference, M3Section, M3StructureData, SectionResolver } from './types.js'
import { M3StructureDescription, type M3StructureHistory } from './binary/structures.js'
import { getAllRegionBatches } from './builder/material-helpers.js'
import { buildRenderMaterials, assertM3MaterialProjection, m3MaterialProjectionRefusals } from './builder/standard-material.js'
import { buildM3RenderEffects } from './builder/effects.js'
import { buildRenderSequences } from './animation/tracks.js'
import { invertAffineMatrix4 } from './utils/matrix.js'
import { buildVertexObject } from './utils/vertex.js'
import { getM3SectionInventory } from './lossless.js'
import { deriveM3ParticleMaterials } from '../particle-material-lighting.js'

export interface M3RenderModelOptions {
  includeRawMetadata?: boolean
}

/**
 * M3 camera/light animation references are currently sampled into static
 * preview metadata. This list is emitted with the preview so clients can
 * explain which authored values do not yet update during animation playback.
 */
export const M3_PREVIEW_ANIMATION_LIMITATIONS = {
  mode: 'bind-pose-default-values',
  cameras: [
    'boneTransform',
    'fieldOfView',
    'farClip',
    'nearClip',
    'clip2',
    'focalDepth',
    'falloffStart',
    'falloffEnd',
    'depthOfField',
  ],
  lights: [
    'boneTransform',
    'color',
    'intensity',
    'specularColor',
    'specularIntensity',
    'decay',
    'attenuationNear',
    'attenuationFar',
    'hotspot',
    'falloff',
  ],
} as const

type PreviewVector3 = [number, number, number]

interface M3PreviewTransform {
  position: PreviewVector3
  /** Authored camera/spot-light ray direction (local -Z). */
  forward: PreviewVector3
}

interface M3PreviewMetadata {
  camera: Record<string, unknown> | null
  lights: Array<Record<string, unknown>>
}

export function m3ModelToRenderModel(
  model: M3Model,
  options: M3RenderModelOptions = {},
): RenderModel {
  const sections = model.sections
  const source = model.model
  // MATM-keyed materials: mesh.materialIndex indexes material_references, so
  // standard AND composite materials route without renumbering (P4 S3).
  const { materials, diagnostics } = buildRenderMaterials(source, sections)
  // Per-sequence tracks for every bone (undriven bones get constant bind-pose
  // tracks — the P5 structural reset) + IREF inverse bind matrices.
  const { sequences, inverseBindMatrices } = buildRenderSequences(source, sections)
  const meshes = buildRenderMeshes(source, sections, sections.structureHistories)
  const effectConversion = buildM3RenderEffects(
    source,
    sections,
    model.particles,
    model.ribbons,
    model.forces,
    model.warps,
    model.projections,
    meshes,
  )
  assertM3MaterialProjection(m3MaterialProjectionRefusals(materials), [
    ...meshes.map(mesh => mesh.materialIndex),
    ...effectConversion.effects.particles.map(effect => effect.materialIndex),
    ...effectConversion.effects.ribbons.map(effect => effect.materialIndex),
    ...(effectConversion.effects.projectors ?? []).map(effect => effect.materialIndex),
  ])
  const particleMaterials = deriveM3ParticleMaterials(
    materials,
    effectConversion.effects.particles.map(particle => particle.materialIndex),
    effectConversion.particleLighting,
    { program: material => material, replace: (material, program) => ({ ...material, ...program as object }) },
    { maxNodes: 1_000_000, maxDepth: 128, maxScalarBytes: 268_435_456 },
  )
  const preview = buildM3PreviewMetadata(model, inverseBindMatrices)
  const collisionShapes = buildRenderCollisionShapes(model)
  const hasPreviewMetadata = preview.camera !== null || preview.lights.length > 0

  return {
    format: 'm3',
    meshes,
    skeleton: {
      bones: model.bones.map(bone => ({
        index: bone.index,
        name: bone.name,
        parentIndex: bone.parentIndex,
        flags: bone.flags,
        ...(inverseBindMatrices[bone.index]
          ? { inverseBindMatrix: inverseBindMatrices[bone.index] }
          : {}),
      })),
    },
    materials: [...particleMaterials.materials],
    animations: sequences,
    bounds: buildRenderBounds(model.bounds),
    // Effect tracks come out of the sequence conversion in seconds. Declared so a renderer
    // samples them in the right unit without testing which format it is drawing.
    effects: { ...effectConversion.effects, trackTimeUnit: 'seconds',
      particles: effectConversion.effects.particles.map((particle, index) => ({
        ...particle, materialIndex: particleMaterials.particleMaterialIndices[index]!,
      })),
    },
    ...(collisionShapes.length > 0 ? { collisionShapes } : {}),
    ...(options.includeRawMetadata ||
    diagnostics.length > 0 ||
    hasPreviewMetadata ||
    effectConversion.diagnostics.length > 0 ||
    effectConversion.animationMetadata
      ? {
          metadata: {
            ...(preview.camera ? { previewCamera: preview.camera } : {}),
            ...(preview.lights.length > 0 ? { previewLights: preview.lights } : {}),
            ...(hasPreviewMetadata
              ? { m3PreviewAnimationLimitations: M3_PREVIEW_ANIMATION_LIMITATIONS }
              : {}),
            ...(options.includeRawMetadata
              ? {
                  mdVersion: sections.mdVersion,
                  m3ModelVersion: source.desc.version,
                  m3ModelFlags: source.flags,
                  m3aHash: source.m3a_hash,
                  sections: sections.length,
                  m3SectionInventory: getM3SectionInventory(sections),
                  textures: [...model.textureFilenames],
                  counts: {
                    cameras: model.cameras.length,
                    lights: model.lights.length,
                    particles: model.particles.length,
                    ribbons: model.ribbons.length,
                    billboards: model.billboards.length,
                    attachmentPoints: model.attachmentPoints.length,
                    physicsConstraints: model.physicsConstraints.length,
                  },
                  m3Cameras: model.cameras,
                  m3Lights: model.lights,
                  m3Billboards: model.billboards,
                  m3AttachmentPoints: model.attachmentPoints,
                  m3Materials: model.materials,
                  m3HitVolumes: model.hitVolumes,
                  m3Turrets: model.turrets,
                  m3Ribbons: model.ribbons,
                  m3Particles: model.particles,
                  m3Projections: model.projections,
                  m3Forces: model.forces,
                  m3Warps: model.warps,
                  m3Shadowboxes: model.shadowboxes,
                  m3RigidBodies: model.rigidBodies,
                  m3PhysicsConstraints: model.physicsConstraints,
                  m3PhysicsJoints: model.physicsJoints,
                  m3PhysicsCloths: model.physicsCloths,
                  m3Ik: model.ik,
                }
              : {}),
            ...(diagnostics.length > 0 ? { materialDiagnostics: diagnostics } : {}),
            ...(effectConversion.diagnostics.length > 0
              ? { m3EffectDiagnostics: effectConversion.diagnostics }
              : {}),
            ...(effectConversion.animationMetadata
              ? { m3EffectAnimations: effectConversion.animationMetadata }
              : {}),
          },
        }
      : {}),
  }
}

function buildRenderCollisionShapes(model: M3Model): RenderCollisionShape[] {
  const result: RenderCollisionShape[] = []
  for (const body of model.rigidBodies) {
    // A body without the collidable bit is still usable when flags are absent
    // (older PHRB versions); explicit non-collidable modern bodies are skipped.
    if (body.flags !== 0 && (body.flags & 0x1) === 0) continue
    for (const shape of body.shapes) {
      const kind =
        shape.shape === 'Box'
          ? 'box'
          : shape.shape === 'Sphere'
            ? 'sphere'
            : shape.shape === 'Capsule'
              ? 'capsule'
              : shape.shape === 'Cylinder'
                ? 'cylinder'
                : shape.shape === 'ConvexHull'
                  ? 'convex-hull'
                  : shape.shape === 'Mesh'
                    ? 'mesh'
                    : null
      if (!kind) continue
      result.push({
        kind,
        boneIndex: body.boneIndex,
        matrix: shape.matrix4,
        size: shape.size,
        ...(shape.vertices.length > 0 ? { vertices: shape.vertices } : {}),
      })
    }
  }
  return result
}

function buildM3PreviewMetadata(
  model: M3Model,
  inverseBindMatrices: readonly (Float32Array | undefined)[],
): M3PreviewMetadata {
  const transformForBone = (boneIndex: number): M3PreviewTransform | null => {
    const inverseBind = inverseBindMatrices[boneIndex]
    if (!inverseBind) return null
    const world = invertAffineMatrix4(inverseBind)
    if (!world) return null
    const forward = normalizePreviewVector([-(world[8] ?? 0), -(world[9] ?? 0), -(world[10] ?? 0)])
    if (!forward) return null
    return {
      position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0],
      forward,
    }
  }

  let camera: Record<string, unknown> | null = null
  for (const source of model.cameras) {
    const transform = transformForBone(source.boneIndex)
    if (!transform) continue
    const nearClip = finitePositive(source.nearClip) ?? 0.1
    const farClip = finitePositive(source.farClip) ?? 10000
    camera = {
      name: source.name,
      position: transform.position,
      target: addPreviewVectors(transform.position, transform.forward),
      fieldOfView: finitePositive(source.fieldOfView) ?? 0.5,
      nearClip,
      farClip: farClip > nearClip ? farClip : Math.max(nearClip * 2, 10000),
      // The preview schema currently treats every FOV as vertical. Keep the
      // authored M3 axis so a future draw-time conversion can use its aspect.
      m3FovAxis: source.useVerticalFov ? 'vertical' : 'horizontal',
      m3BoneIndex: source.boneIndex,
    }
    break
  }

  const lights: Array<Record<string, unknown>> = []
  for (const source of model.lights) {
    if (lights.length >= 4) break
    const transform = transformForBone(source.boneIndex)
    if (!transform) continue
    // M3 LITE: 0 directional, 1 point, 2 spot. RenderModel preview metadata:
    // 1 directional, 0 point, 2 spot.
    const type = source.type === 0 ? 1 : source.type === 1 ? 0 : source.type === 2 ? 2 : null
    if (type === null) continue
    const intensity = finiteNonNegative(source.intensity) ?? 1
    const color = source.color.map(
      value => (finiteNonNegative(value) ?? 0) * intensity,
    ) as PreviewVector3
    const attenuationStart = finiteNonNegative(source.attenuationNear)
    const attenuationEnd = finitePositive(source.attenuationFar)
    const decayExponent = finiteNonNegative(source.decay)
    const hotspot = finiteNonNegative(source.hotspot)
    const falloff = finitePositive(source.falloff)
    // Spot metadata stores the authored light-ray direction. Directional
    // preview metadata instead expects the surface-to-light vector.
    const direction = type === 1 ? negatePreviewVector(transform.forward) : transform.forward

    lights.push({
      name: source.name,
      type,
      direction,
      color,
      ...(type === 1 ? {} : { position: transform.position }),
      ...(attenuationEnd !== undefined ? { range: attenuationEnd, attenuationEnd } : {}),
      ...(attenuationStart !== undefined ? { attenuationStart } : {}),
      ...(decayExponent !== undefined ? { decayExponent } : {}),
      ...(type === 2 && hotspot !== undefined ? { innerConeAngle: hotspot } : {}),
      ...(type === 2 && falloff !== undefined ? { outerConeAngle: falloff } : {}),
      m3BoneIndex: source.boneIndex,
    })
  }

  return { camera, lights }
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizePreviewVector(value: PreviewVector3): PreviewVector3 | null {
  const length = Math.hypot(value[0], value[1], value[2])
  if (!Number.isFinite(length) || length <= 1e-8) return null
  return [value[0] / length, value[1] / length, value[2] / length]
}

function addPreviewVectors(a: PreviewVector3, b: PreviewVector3): PreviewVector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function negatePreviewVector(value: PreviewVector3): PreviewVector3 {
  return [-value[0], -value[1], -value[2]]
}

function buildRenderMeshes(
  model: M3StructureData,
  sections: SectionResolver,
  structureHistories: Record<string, M3StructureHistory>,
): RenderMesh[] {
  const vertexFlags = (model.vertex_flags as number) ?? 0
  const vertexSection = sections.getSectionByReference(model.vertices as M3Reference | undefined)
  const divisionSection = sections.getSectionByReference(model.divisions as M3Reference | undefined)
  if (!vertexSection?.rawBytes || !divisionSection) return []

  const vertexDesc = M3StructureDescription.getVertexDescription(vertexFlags, structureHistories)
  const vertexCount = Math.floor(vertexSection.rawBytes.byteLength / vertexDesc.size)
  const vertexObjects = vertexDesc.instances(
    vertexSection.rawBytes,
    vertexCount,
  ) as M3StructureData[]
  const hasSkinning = (vertexFlags & 0x60) !== 0
  const boneLookup = getNumberSection(
    sections.getSectionByReference(model.bone_lookup as M3Reference | undefined),
  )
  const meshes: RenderMesh[] = []

  for (const division of divisionSection.content as M3StructureData[]) {
    const faceSection = sections.getSectionByReference(division.faces as M3Reference | undefined)
    const regionSection = sections.getSectionByReference(
      division.regions as M3Reference | undefined,
    )
    if (!faceSection || !regionSection) continue
    const faceIndices = faceSection.content as number[]

    ;(regionSection.content as M3StructureData[]).forEach((region, regionIndex) => {
      const firstVertexIndex = (region.first_vertex_index as number) ?? 0
      const vertexCountForRegion = (region.vertex_count as number) ?? 0
      const firstFaceIndex = (region.first_face_index as number) ?? 0
      const faceCount = (region.face_count as number) ?? 0
      const uvMultiply = (region.uv_multiply as number) ?? 16
      const uvOffset = (region.uv_offset as number) ?? 0
      const regionVersion = (region.desc?.version ?? 0) as number
      const firstBoneLookupIndex = (region.first_bone_lookup_index as number) ?? 0

      const positions = new Float32Array(vertexCountForRegion * 3)
      const normals = new Float32Array(vertexCountForRegion * 3)
      const tangents = new Float32Array(vertexCountForRegion * 4)
      const uvs = new Float32Array(vertexCountForRegion * 2)
      const uvsExtra: (Float32Array | undefined)[] = [undefined, undefined, undefined]
      const colors = new Float32Array(vertexCountForRegion * 4)
      const boneIndices = hasSkinning ? new Uint16Array(vertexCountForRegion * 4) : undefined
      const boneWeights = hasSkinning ? new Float32Array(vertexCountForRegion * 4) : undefined
      let normalCount = 0
      let tangentCount = 0
      let colorCount = 0

      for (let vi = 0; vi < vertexCountForRegion; vi += 1) {
        const vertex = buildVertexObject(vertexObjects[firstVertexIndex + vi], uvMultiply, uvOffset)
        positions.set(vertex.position, vi * 3)
        if (vertex.normal) {
          normals.set(vertex.normal, vi * 3)
          normalCount += 1
        }
        if (vertex.tangent) {
          tangents.set(vertex.tangent, vi * 4)
          tangentCount += 1
        }
        const uv = vertex.uv0 ?? vertex.fuv0 ?? [0, 0]
        uvs.set(uv, vi * 2)
        for (let uvSet = 1; uvSet <= 3; uvSet += 1) {
          const extra = vertex[`uv${uvSet}`] ?? vertex[`fuv${uvSet}`]
          if (!extra) continue
          let target = uvsExtra[uvSet - 1]
          if (!target) {
            target = new Float32Array(vertexCountForRegion * 2)
            uvsExtra[uvSet - 1] = target
          }
          target.set(extra, vi * 2)
        }
        if (vertex.color) {
          colors.set(vertex.color, vi * 4)
          colorCount += 1
        }
        if (boneIndices && boneWeights) {
          const sourceIndices = vertex.boneIndices ?? []
          const sourceWeights = vertex.weights ?? []
          for (let i = 0; i < 4; i += 1) {
            const offset = vi * 4 + i
            const lookupIndex = sourceIndices[i]
            boneIndices[offset] =
              lookupIndex !== undefined ? (boneLookup[firstBoneLookupIndex + lookupIndex] ?? 0) : 0
            boneWeights[offset] = sourceWeights[i] ?? (i === 0 ? 1 : 0)
          }
        }
      }

      const indices = buildRegionIndices(
        faceIndices,
        firstFaceIndex,
        faceCount,
        firstVertexIndex,
        regionVersion,
        vertexCountForRegion,
      )
      const geometry = {
        positions,
        ...(normalCount > 0 ? { normals } : {}),
        ...(tangentCount > 0 ? { tangents } : {}),
        uvs,
        ...(uvsExtra[0] ? { uvs1: uvsExtra[0] } : {}),
        ...(uvsExtra[1] ? { uvs2: uvsExtra[1] } : {}),
        ...(uvsExtra[2] ? { uvs3: uvsExtra[2] } : {}),
        ...(colorCount === vertexCountForRegion ? { colors } : {}),
        indices,
        ...(boneIndices ? { boneIndices } : {}),
        ...(boneWeights ? { boneWeights } : {}),
      }

      // One mesh per material batch (a region can carry several); geometry
      // buffers are shared between the batch meshes of the same region.
      const all = getAllRegionBatches(model, sections, division, regionIndex)
      // A batch the game does not draw (geometry_visible off) is not a mesh of the model.
      const batches = all.filter(batch => batch.geometryVisible)
      if (all.length > 0 && batches.length === 0) return
      if (batches.length === 0) {
        meshes.push({
          name: `M3_Region_${regionIndex}`,
          materialIndex: -1,
          ...geometry,
        })
        return
      }
      for (const batch of batches) {
        meshes.push({
          name:
            batches.length > 1
              ? `M3_Region_${regionIndex}_Batch_${batch.batchIndex}`
              : `M3_Region_${regionIndex}`,
          materialIndex: batch.materialReferenceIndex,
          ...geometry,
        })
      }
    })
  }

  return meshes
}

function buildRegionIndices(
  faceIndices: number[],
  firstFaceIndex: number,
  faceCount: number,
  firstVertexIndex: number,
  regionVersion: number,
  vertexCount: number,
): Uint16Array | Uint32Array {
  const values: number[] = []
  const faceEnd = firstFaceIndex + faceCount
  for (let i = firstFaceIndex; i < faceEnd && i + 2 < faceIndices.length; i += 3) {
    let a = faceIndices[i] ?? 0
    let b = faceIndices[i + 1] ?? 0
    let c = faceIndices[i + 2] ?? 0
    if (regionVersion <= 2) {
      a -= firstVertexIndex
      b -= firstVertexIndex
      c -= firstVertexIndex
    }
    values.push(a, b, c)
  }
  return vertexCount > 65535 ? new Uint32Array(values) : new Uint16Array(values)
}

function getNumberSection(section: M3Section | null): number[] {
  return (section?.content ?? []).filter((value): value is number => typeof value === 'number')
}

function buildRenderBounds(
  bounds: {
    left: number
    right: number
    back: number
    front: number
    bottom: number
    top: number
    radius: number
  } | null,
): Bounds | null {
  if (!bounds) return null
  return {
    min: { x: bounds.left, y: bounds.back, z: bounds.bottom },
    max: { x: bounds.right, y: bounds.front, z: bounds.top },
    radius: bounds.radius,
  }
}
