/** M3 native effects extraction and sequence metadata. Publisher-only particle lighting covers
 * expanded PAR_/PARC ordinals; consumers must remove this DTO before publishing generic effects. */
import {
  type RenderEffectVariation,
  type RenderMesh,
  type RenderModelEffects,
  type RenderParticleEmitter,
  type RenderParticleLifecycleSize,
  type RenderParticleEmitterSequenceAnimation,
  type RenderRibbonEmitter,
  type RenderRibbonEmitterSequenceAnimation,
  type SequenceIndexedAnimationTrack,
} from '@modkit/codec-kit/legacy/models'
import { MAX_EFFECT_RIBBON_SIDES } from '@modkit/codec-kit/model-math/effects-sim'
import { M3AnimationReferenceTrackExtractor } from '../animation/tracks.js'
import { parseAnimationReference, valueToComponents } from '../animation/evaluator.js'
import { getSectionString } from '../utils/texture.js'
import type {
  ForceInfo,
  M3Reference,
  M3StructureData,
  ParticleSystemInfo,
  ProjectionInfo,
  RibbonInfo,
  SectionResolver,
  WarpInfo,
} from '../types.js'

const PARTICLE_TAIL_TYPES = new Set([1, 9, 10])
const PARTICLE_SURFACE_COLLISION_FLAGS = 0x2 | 0x4
const PARTICLE_CUTOUT_FLAG = 0x10
const PARTICLE_MODEL_FLAG = 0x400000
const RIBBON_LENGTH_AND_TIME_FLAG = 0x1000
const EPSILON = 1e-6

/**
 * M3 stores ribbon lifetime/length/tessellation but no portable spawn cadence.
 * Use the 20 Hz cadence observed in Visecraft as a bounded live-preview default.
 */
export const M3_RIBBON_PREVIEW_EMISSION_RATE = 20

const M3_EMITTER_SHAPES = [
  'point',
  'plane',
  'sphere',
  'box',
  'cylinder',
  'disc',
  'spline',
  'mesh',
] as const

const M3_PARTICLE_INSTANCE_TYPES = [
  'billboard',
  'tail',
  'face-travel-direction',
  'face-world-direction',
  'single-axis',
  'terrain-oriented',
  'terrain-direction-oriented',
  'emitter-oriented',
  'physics-oriented',
  'pinned',
  'trail',
] as const

const M3_RIBBON_TYPES = ['billboard', 'planar', 'cylinder', 'star'] as const

type EffectKind = 'particle' | 'ribbon'

export interface M3EffectConversionDiagnostic {
  code: string
  severity: 'warning' | 'info'
  emitterKind: EffectKind
  /** `-1` denotes model-level data such as the PARC array. */
  emitterIndex: number
  fields: string[]
  message: string
}

export interface M3EffectParameterAnimation {
  sourceField: string
  renderFields: string[]
  animId: number
  interpolationType: number
  animFlags: number
  initValue: readonly number[]
  sequenceTracks: SequenceIndexedAnimationTrack[]
}

export interface M3EffectEmitterAnimationMetadata {
  emitterIndex: number
  parameters: M3EffectParameterAnimation[]
}

export interface M3EffectAnimationMetadata {
  /** Effect animation remains sequence-indexed until RenderModel supports it directly. */
  mode: 'm3-sequence-indexed'
  particles: M3EffectEmitterAnimationMetadata[]
  ribbons: M3EffectEmitterAnimationMetadata[]
}

export interface M3RenderEffectsConversion {
  effects: RenderModelEffects
  /** Publisher-only lighting by expanded ordinal, never part of RenderModelEffects. */
  particleLighting: boolean[]
  diagnostics: M3EffectConversionDiagnostic[]
  animationMetadata: M3EffectAnimationMetadata | null
}

interface AnimationField {
  sourceField: string
  renderFields: string[]
  transform?: (value: readonly number[]) => readonly number[]
}

const PARTICLE_ANIMATION_FIELDS: readonly AnimationField[] = [
  { sourceField: 'emit_rate', renderFields: ['emissionRate'] },
  { sourceField: 'lifespan', renderFields: ['lifeSpan'] },
  { sourceField: 'emit_speed', renderFields: ['speed'] },
  { sourceField: 'emit_angle_x', renderFields: ['emitAngleX'] },
  { sourceField: 'emit_angle_y', renderFields: ['emitAngleY'] },
  { sourceField: 'emit_spread_x', renderFields: ['emitSpreadX'] },
  { sourceField: 'emit_spread_y', renderFields: ['emitSpreadY'] },
  { sourceField: 'emit_shape_radius', renderFields: ['emitShapeRadius'] },
  { sourceField: 'emit_shape_size', renderFields: ['emitShapeSize', 'width', 'length'] },
  {
    sourceField: 'size',
    renderFields: ['lifecycleSize.start', 'lifecycleSize.middle', 'lifecycleSize.end'],
  },
  {
    sourceField: 'size2',
    renderFields: [
      'lifecycleSizeRandom.start',
      'lifecycleSizeRandom.middle',
      'lifecycleSizeRandom.end',
    ],
  },
  {
    sourceField: 'color_init',
    renderFields: ['segmentColors[0]', 'segmentAlphas[0]'],
    transform: normalizeColor,
  },
  {
    sourceField: 'color_mid',
    renderFields: ['segmentColors[1]', 'segmentAlphas[1]'],
    transform: normalizeColor,
  },
  {
    sourceField: 'color_end',
    renderFields: ['segmentColors[2]', 'segmentAlphas[2]'],
    transform: normalizeColor,
  },
  { sourceField: 'emit_count', renderFields: ['squirt'] },
]

const PARTICLE_COPY_ANIMATION_FIELDS: readonly AnimationField[] = [
  { sourceField: 'emit_rate', renderFields: ['emissionRate'] },
  { sourceField: 'emit_count', renderFields: ['squirt'] },
]

const RIBBON_ANIMATION_FIELDS: readonly AnimationField[] = [
  { sourceField: 'active', renderFields: ['visibility'], transform: normalizeVisibility },
  { sourceField: 'lifespan', renderFields: ['lifeSpan'] },
  { sourceField: 'speed', renderFields: ['speed'] },
  { sourceField: 'pitch', renderFields: ['pitch'] },
  { sourceField: 'yaw', renderFields: ['yaw'] },
  { sourceField: 'spread_x', renderFields: ['spreadX'] },
  { sourceField: 'spread_y', renderFields: ['spreadY'] },
  { sourceField: 'length', renderFields: ['maxLength'] },
  {
    sourceField: 'scale',
    renderFields: ['widths[0]', 'widths[1]', 'widths[2]'],
  },
  {
    sourceField: 'color_base',
    renderFields: ['segmentColors[0]', 'segmentAlphas[0]'],
    transform: normalizeColor,
  },
  {
    sourceField: 'color_mid',
    renderFields: ['segmentColors[1]', 'segmentAlphas[1]'],
    transform: normalizeColor,
  },
  {
    sourceField: 'color_tip',
    renderFields: ['segmentColors[2]', 'segmentAlphas[2]'],
    transform: normalizeColor,
  },
]

/**
 * Convert M3 PAR_/PARC/RIB_ records without pretending the generic effect
 * contract covers spline emitters, collision graphs, or ribbon cross-sections.
 */
export function buildM3RenderEffects(
  model: M3StructureData,
  sections: SectionResolver,
  particles: readonly ParticleSystemInfo[],
  ribbons: readonly RibbonInfo[],
  forces: readonly ForceInfo[] = [],
  warps: readonly WarpInfo[] = [],
  projectors: readonly ProjectionInfo[] = [],
  renderMeshes: readonly RenderMesh[] = [],
): M3RenderEffectsConversion {
  const particleRecords = sectionRecords(
    sections,
    model.particle_systems as M3Reference | undefined,
  )
  const ribbonRecords = sectionRecords(sections, model.ribbons as M3Reference | undefined)
  const particleCopyRecords = sectionRecords(
    sections,
    model.particle_copies as M3Reference | undefined,
  )
  const trackExtractor = new M3AnimationReferenceTrackExtractor(model, sections)
  const diagnostics: M3EffectConversionDiagnostic[] = []

  const particleAnimationMetadata: M3EffectEmitterAnimationMetadata[] = []
  const baseParticleAnimations: Array<M3EffectEmitterAnimationMetadata | null> = []
  const particleLighting: boolean[] = []
  const renderParticles = particles.map((particle, index): RenderParticleEmitter => {
    const raw = particleRecords[index]
    const shapeCode = finiteInteger(raw?.emit_shape, numericCode(particle.emitShape))
    const particleTypeCode = finiteInteger(raw?.particle_type, numericCode(particle.particleType))
    const emitShapeSize = animVector3(raw?.emit_shape_size, particle.emitShapeSize)
    const emitShapeRecords = raw
      ? sectionRecords(sections, raw.emit_shape_spline as M3Reference | undefined)
      : []
    const emitShapePoints = emitShapeRecords.map(record => animVector3(record.location, [0, 0, 0]))
    const emitShapePointSequenceAnimations = emitShapeRecords.map(record =>
      trackExtractor.extract(record.location as M3StructureData | undefined),
    )
    const hasAnimatedEmitShapePoints = emitShapePointSequenceAnimations.some(
      tracks => tracks.length > 0,
    )
    const emitShapeRegions = raw
      ? sectionNumbers(sections, raw.emit_shape_regions as M3Reference | undefined)
      : []
    const emitShapeMeshes = emissionMeshesForRegions(renderMeshes, emitShapeRegions)
    const emitShapeCutoutSize = animVector3(raw?.emit_shape_size_cutout, [0, 0, 0])
    const emitShapeCutoutRadius = Math.abs(animScalar(raw?.emit_shape_radius_cutout, 0))
    const sizeCurve = animVector3(raw?.size, [
      particle.sizeInit[0],
      particle.sizeMid[0],
      particle.sizeEnd[0],
    ])
    const sizeRandomCurve = animVector3(raw?.size2, [
      particle.sizeRandomInit[0],
      particle.sizeRandomMid[0],
      particle.sizeRandomEnd[0],
    ])
    const lifecycleSize = uniformLifecycleFromCurve(sizeCurve, particle.sizeAnimMid)
    const lifecycleSizeRandom = uniformLifecycleFromCurve(sizeRandomCurve, particle.sizeAnimMid)
    const sizeTimeMiddle = finiteNumber(raw?.size_anim_mid, particle.sizeAnimMid)
    const animation = raw
      ? effectAnimations(index, raw, PARTICLE_ANIMATION_FIELDS, trackExtractor)
      : null
    const sequenceAnimation = animation
      ? particleSequenceAnimation(animation.parameters)
      : undefined
    baseParticleAnimations[index] = animation
    if (animation) particleAnimationMetadata.push(animation)
    if (raw) {
      collectParticleDiagnostics(
        raw,
        index,
        shapeCode,
        particleTypeCode,
        emitShapePoints.length > 0,
        emitShapeMeshes.length > 0,
        diagnostics,
      )
    }

    const tail = PARTICLE_TAIL_TYPES.has(particleTypeCode)
    const rows = finitePositiveInteger(raw?.uv_flipbook_rows)
    const columns = finitePositiveInteger(raw?.uv_flipbook_cols)
    const startFrames = flipbookFrames(raw, 'start')
    const endFrames = flipbookFrames(raw, 'end')
    const emitCount = animScalar(raw?.emit_count, 0)
    const additionalFlags = finiteInteger(raw?.additional_flags, 0)
    const flags = finiteInteger(raw?.flags, 0)
    particleLighting.push((flags & 0x8000) !== 0)
    const modelPaths = raw
      ? sectionRecords(sections, raw.model_paths as M3Reference | undefined)
          .map(record => getSectionString(sections, record.path as M3Reference | null))
          .filter(path => path.length > 0)
      : []
    const rotationCurve = animVector3(raw?.rotation, [0, 0, 0])
    const rotationRandomCurve = animVector3(raw?.rotation2, rotationCurve)
    const colorRandom = [
      animColor(raw?.color2_init, particle.colorInit),
      animColor(raw?.color2_mid, particle.colorMid),
      animColor(raw?.color2_end, particle.colorEnd),
    ] as const
    const screenSpaceUv = {
      threshold: animScalar(raw?.uv_ss_threshold, 0),
      offset: animVector2(raw?.uv_ss_offset, [0, 0]),
      angle: animVector3(raw?.uv_ss_angle, [0, 0, 0]),
      tiling: animVector2(raw?.uv_ss_tiling, [1, 1]),
    } as const
    const bounceRibbonChance = Math.max(0, finiteNumber(raw?.spawn_ribbon_on_bounce_chance, 0))
    const bounceRibbonEmitterIndex = finiteInteger(raw?.ribbon_link_index, -1)
    const bounceRibbonTargetExists =
      bounceRibbonEmitterIndex >= 0 && bounceRibbonEmitterIndex < ribbons.length

    return {
      name: particle.name,
      boneIndex: particle.boneIndex,
      materialIndex: particle.materialIndex,
      ...(particle.textureFilename ? { texturePath: particle.textureFilename } : {}),
      width: Math.abs(emitShapeSize[0]),
      length: Math.abs(emitShapeSize[1]),
      alpha: particle.colorInit[3],
      squirt:
        emitCount > 0 ||
        animation?.parameters.some(parameter => parameter.sourceField === 'emit_count') === true,
      emitCount,
      emissionRate: particle.emitRate,
      lifeSpan: particle.lifespan,
      lifeSpanRandom: animScalar(raw?.lifespan_random, particle.lifespan),
      randomizeLifeSpan:
        (additionalFlags & 0x2) !== 0 || finiteInteger(raw?.lifespan_randomize, 0) !== 0,
      speed: particle.emitSpeed,
      speedRandom: animScalar(raw?.emit_speed_random, particle.emitSpeed),
      randomizeSpeed:
        (additionalFlags & 0x1) !== 0 || finiteInteger(raw?.emit_speed_randomize, 0) !== 0,
      mass: Math.max(EPSILON, finiteNumber(raw?.mass, 1)),
      massRandom: Math.max(EPSILON, finiteNumber(raw?.mass2, finiteNumber(raw?.mass, 1))),
      randomizeMass: (additionalFlags & 0x4) !== 0 || finiteInteger(raw?.mass_randomize, 0) !== 0,
      gravity: particle.gravity,
      tailLength: Math.abs(finiteNumber(raw?.instance_tail, 1)),
      ...particleTailMode(flags),
      timeMiddle: particle.colorAnimMid,
      ...(rows ? { rows } : {}),
      ...(columns ? { columns } : {}),
      head: !tail,
      tail,
      orientationMode: M3_PARTICLE_INSTANCE_TYPES[particleTypeCode] ?? 'billboard',
      localForceChannels: finiteInteger(raw?.local_forces, 0),
      worldForceChannels: finiteInteger(raw?.world_forces, 0),
      feedbackLocalForceChannels: finiteInteger(raw?.local_forces_fb, 0),
      feedbackWorldForceChannels: finiteInteger(raw?.world_forces_fb, 0),
      worldForceMassMultiplier: finiteNumber(raw?.world_forces_mass_mult, 1),
      noiseAmplitude: finiteNumber(raw?.noise_amplitude, 0),
      noiseFrequency: finiteNumber(raw?.noise_frequency, 0),
      noiseCohesion: finiteNumber(raw?.noise_cohesion, 0),
      noiseEdge: finiteNumber(raw?.noise_edge, 0),
      windMultiplier: finiteNumber(raw?.wind_multiplier, 1),
      maxParticles: Math.max(0, finiteInteger(raw?.emit_max, particle.maxParticles)),
      emitShape: M3_EMITTER_SHAPES[shapeCode] ?? String(shapeCode),
      emitShapeRadius: Math.abs(animScalar(raw?.emit_shape_radius, particle.emitShapeRadius)),
      emitShapeSize,
      ...(emitShapePoints.length > 0 ? { emitShapePoints } : {}),
      ...(hasAnimatedEmitShapePoints ? { emitShapePointSequenceAnimations } : {}),
      ...(emitShapeMeshes.length > 0 ? { emitShapeMeshes } : {}),
      emitShapeCutout: (finiteInteger(raw?.flags, 0) & PARTICLE_CUTOUT_FLAG) !== 0,
      emitShapeCutoutSize,
      emitShapeCutoutRadius,
      emitAngleX: particle.emitAngleX,
      emitAngleY: particle.emitAngleY,
      emitSpreadX: particle.emitSpreadX,
      emitSpreadY: particle.emitSpreadY,
      collideTerrain: (finiteInteger(raw?.flags, 0) & 0x2) !== 0,
      collideObjects: (finiteInteger(raw?.flags, 0) & 0x4) !== 0,
      bounce: Math.max(0, finiteNumber(raw?.bounce, 0)),
      maxCollisionEvents: Math.max(0, finiteInteger(raw?.collide_events_cull, 0)),
      ...(finiteInteger(raw?.collide_system, -1) >= 0
        ? { collisionEmitterIndex: finiteInteger(raw?.collide_system, -1) }
        : {}),
      collisionEmitMin: Math.max(0, finiteInteger(raw?.collide_emit_min, 0)),
      collisionEmitMax: Math.max(0, finiteInteger(raw?.collide_emit_max, 0)),
      collisionEmitChance: Math.max(0, finiteNumber(raw?.collide_emit_chance, 0)),
      collisionEmitEnergy: Math.max(0, finiteNumber(raw?.collide_emit_energy, 0)),
      ...(finiteInteger(raw?.collide_splat, -1) >= 0
        ? { collisionProjectorIndex: finiteInteger(raw?.collide_splat, -1) }
        : {}),
      collisionProjectorChance: Math.max(0, finiteNumber(raw?.collide_splat_chance, 0)),
      // Preserve a valid dormant authored link so a later chance edit can reactivate it.
      // An inactive out-of-range retail default is omitted, while an active invalid link is
      // still projected and rejected by the shared effect-link validator.
      ...(bounceRibbonEmitterIndex >= 0 && (bounceRibbonTargetExists || bounceRibbonChance > 0)
        ? { bounceRibbonEmitterIndex }
        : {}),
      bounceRibbonChance,
      ...(finiteInteger(raw?.trail_system, -1) >= 0
        ? { trailEmitterIndex: finiteInteger(raw?.trail_system, -1) }
        : {}),
      trailEmitChance: Math.max(0, finiteNumber(raw?.trail_chance, 0)),
      trailEmitRate: Math.max(0, animScalar(raw?.trail_rate, 0)),
      friction: particle.friction,
      drag: particle.drag,
      boneAnchored: true,
      modelSpace: raw ? !m3WorldSpace(raw) : particle.localSpace,
      lifecycleSize: { ...lifecycleSize, timeMiddle: sizeTimeMiddle },
      lifecycleSizeRandom: { ...lifecycleSizeRandom, timeMiddle: sizeTimeMiddle },
      randomizeSize: finiteInteger(raw?.size_randomize, particle.sizeRandomize ? 1 : 0) !== 0,
      lifecycleRotation: uniformLifecycleFromCurve(
        rotationCurve,
        finiteNumber(raw?.rotation_anim_mid, 0.5),
      ),
      lifecycleRotationRandom: uniformLifecycleFromCurve(
        rotationRandomCurve,
        finiteNumber(raw?.rotation_anim_mid, 0.5),
      ),
      randomizeRotation: finiteInteger(raw?.rotation_randomize, 0) !== 0,
      rotationRelative: (finiteInteger(raw?.rotation_flags, 0) & 0x2) !== 0,
      rotationAlwaysSet: (finiteInteger(raw?.rotation_flags, 0) & 0x4) !== 0,
      segmentColorsRandom: colorRandom.map(color => [color[0], color[1], color[2]]),
      segmentAlphasRandom: [colorRandom[0][3], colorRandom[1][3], colorRandom[2][3]],
      randomizeColor: finiteInteger(raw?.color_randomize, 0) !== 0,
      randomizeAlpha: finiteInteger(raw?.alpha_randomize, 0) !== 0,
      pitchVariation: effectVariation(raw, 'pitch'),
      yawVariation: effectVariation(raw, 'yaw'),
      speedVariation: effectVariation(raw, 'speed'),
      sizeVariation: effectVariation(raw, 'size'),
      alphaVariation: effectVariation(raw, 'alpha'),
      colorVariation: effectVariation(raw, 'color'),
      rotationVariation: effectVariation(raw, 'rotation'),
      spreadXVariation: effectVariation(raw, 'spread_x'),
      spreadYVariation: effectVariation(raw, 'spread_y'),
      parentVelocity: animScalar(raw?.parent_velocity, 0),
      ...(modelPaths.length > 0 ? { modelPaths } : {}),
      swapModelParticleYZ: (flags & 0x800000) !== 0,
      screenSpaceUv,
      // Scalar compatibility for existing MDX-style lifecycle consumers.
      particleScaling: sizeCurve,
      segmentColors: [
        [particle.colorInit[0], particle.colorInit[1], particle.colorInit[2]],
        [particle.colorMid[0], particle.colorMid[1], particle.colorMid[2]],
        [particle.colorEnd[0], particle.colorEnd[1], particle.colorEnd[2]],
      ],
      segmentAlphas: [particle.colorInit[3], particle.colorMid[3], particle.colorEnd[3]],
      ...(startFrames ? { lifeSpanUvAnim: startFrames } : {}),
      ...(endFrames ? { decayUvAnim: endFrames } : {}),
      ...(tail && startFrames ? { tailUvAnim: startFrames } : {}),
      ...(tail && endFrames ? { tailDecayUvAnim: endFrames } : {}),
      ...(sequenceAnimation ? { sequenceAnimation } : {}),
    }
  })

  // PARC records are global lightweight overrides. Each PAR_.copy_indices
  // entry creates another live instance of that base emitter at the copy bone.
  // A PARC may be shared by several PAR_ records, so expand relationships rather
  // than treating the global copy array as a one-to-one list.
  const referencedParticleCopies = new Set<number>()
  for (let sourceEmitterIndex = 0; sourceEmitterIndex < particles.length; sourceEmitterIndex++) {
    const raw = particleRecords[sourceEmitterIndex]
    const sourceEmitter = renderParticles[sourceEmitterIndex]
    if (!raw || !sourceEmitter) continue

    const copyIndices = sectionValues(sections, raw.copy_indices as M3Reference | undefined)
    for (const copyIndexValue of copyIndices) {
      const copyIndex = finiteInteger(copyIndexValue, -1)
      const copyRaw = particleCopyRecords[copyIndex]
      if (copyIndex < 0 || !copyRaw) {
        diagnostics.push(
          effectDiagnostic(
            'm3-particle-copy-reference-invalid',
            'particle',
            sourceEmitterIndex,
            ['copy_indices'],
            `Particle emitter ${sourceEmitterIndex} references missing PARC index ${copyIndex}.`,
          ),
        )
        continue
      }

      referencedParticleCopies.add(copyIndex)
      const emitterIndex = renderParticles.length
      const copyAnimation = effectAnimations(
        emitterIndex,
        copyRaw,
        PARTICLE_COPY_ANIMATION_FIELDS,
        trackExtractor,
      )
      const copySequenceOverrides = copyAnimation
        ? particleSequenceAnimation(copyAnimation.parameters)
        : undefined
      const sequenceAnimation = particleCopySequenceAnimation(
        sourceEmitter.sequenceAnimation,
        copySequenceOverrides,
      )
      const emissionRate = animScalar(copyRaw.emit_rate, sourceEmitter.emissionRate ?? 0)
      const emitCount = animScalar(copyRaw.emit_count, sourceEmitter.emitCount ?? 0)

      const renderCopy: RenderParticleEmitter = {
        ...sourceEmitter,
        name: `${sourceEmitter.name} [copy ${copyIndex}]`,
        boneIndex: finiteInteger(copyRaw.bone, sourceEmitter.boneIndex ?? 0),
        emissionRate,
        emitCount,
        squirt:
          emitCount > 0 ||
          copyAnimation?.parameters.some(parameter => parameter.sourceField === 'emit_count') ===
            true,
      }
      if (sequenceAnimation) renderCopy.sequenceAnimation = sequenceAnimation
      else delete renderCopy.sequenceAnimation
      renderParticles.push(renderCopy)
      particleLighting.push(particleLighting[sourceEmitterIndex]!)

      const inheritedParameters =
        baseParticleAnimations[sourceEmitterIndex]?.parameters.filter(
          parameter =>
            parameter.sourceField !== 'emit_rate' && parameter.sourceField !== 'emit_count',
        ) ?? []
      const parameters = [...inheritedParameters, ...(copyAnimation?.parameters ?? [])]
      if (parameters.length > 0) {
        particleAnimationMetadata.push({ emitterIndex, parameters })
      }
    }
  }

  for (let copyIndex = 0; copyIndex < particleCopyRecords.length; copyIndex++) {
    if (referencedParticleCopies.has(copyIndex)) continue
    diagnostics.push(
      effectDiagnostic(
        'm3-particle-copy-orphaned',
        'particle',
        -1,
        [`particle_copies[${copyIndex}]`],
        `PARC index ${copyIndex} is not referenced by any PAR_.copy_indices entry and cannot inherit an emitter definition.`,
      ),
    )
  }

  const ribbonAnimationMetadata: M3EffectEmitterAnimationMetadata[] = []
  const renderRibbons = ribbons.map((ribbon, index): RenderRibbonEmitter => {
    const raw = ribbonRecords[index]
    const ribbonTypeCode = finiteInteger(raw?.ribbon_type, ribbon.ribbonType)
    const sides = finitePositiveInteger(raw?.sides) ?? ribbon.sides
    const starRatio = finiteNumber(raw?.star_ratio, ribbon.starRatio)
    const authoredDivisions = finiteNumber(raw?.divisions, ribbon.divisions)
    const divisions = authoredDivisions > 0 ? authoredDivisions : ribbon.divisions
    const animation = raw
      ? effectAnimations(index, raw, RIBBON_ANIMATION_FIELDS, trackExtractor)
      : null
    const sequenceAnimation = animation ? ribbonSequenceAnimation(animation.parameters) : undefined
    if (animation) ribbonAnimationMetadata.push(animation)
    if (raw) collectRibbonDiagnostics(raw, index, diagnostics)
    const emissionRate = divisions > EPSILON ? divisions : M3_RIBBON_PREVIEW_EMISSION_RATE
    const additionalFlags = finiteInteger(raw?.additional_flags, 0)
    const flags = finiteInteger(raw?.flags, ribbon.flags)
    const splineEndpoints = raw
      ? sectionRecords(sections, raw.spline as M3Reference | undefined).map(record => {
          const sequenceAnimation = compactSplineEndpointAnimation({
            velocity: trackExtractor.extract(record.velocity as M3StructureData | undefined),
            velocityBaseFactor: trackExtractor.extract(
              record.velocity_base_fac as M3StructureData | undefined,
            ),
            velocityEndFactor: trackExtractor.extract(
              record.velocity_end_fac as M3StructureData | undefined,
            ),
            yaw: trackExtractor.extract(record.yaw as M3StructureData | undefined),
            pitch: trackExtractor.extract(record.pitch as M3StructureData | undefined),
          })
          return {
            boneIndex: finiteInteger(record.bone, ribbon.boneIndex),
            emissionOffset: plainVector3(record.emission_offset, [0, 0, 0]),
            emissionVector: plainVector3(record.emission_vector, [0, 0, 1]),
            velocity: animScalar(record.velocity, ribbon.speed),
            velocityBaseFactor: animScalar(record.velocity_base_fac, 1),
            velocityEndFactor: animScalar(record.velocity_end_fac, 1),
            yaw: animScalar(record.yaw, 0),
            pitch: animScalar(record.pitch, 0),
            yawVariation: effectVariation(record, 'yaw'),
            pitchVariation: effectVariation(record, 'pitch'),
            velocityVariation: effectVariation(record, 'velocity'),
            ...(sequenceAnimation ? { sequenceAnimation } : {}),
          }
        })
      : []
    if (divisions <= EPSILON) {
      diagnostics.push({
        code: 'm3-ribbon-cadence-approximated',
        severity: 'info',
        emitterKind: 'ribbon',
        emitterIndex: index,
        fields: ['render.emissionRate'],
        message: 'Ribbon divisions are zero; live preview uses the bounded 20 Hz fallback cadence.',
      })
    }

    // M3 scale.x is the authored birth width. RenderRibbonEmitter instead
    // stores distances on both sides of the spine, so split it symmetrically.
    const halfWidth = Math.abs(ribbon.sizeBase[0]) * 0.5
    return {
      name: ribbon.name,
      boneIndex: ribbon.boneIndex,
      materialIndex: ribbon.materialIndex,
      ...(ribbon.textureFilename ? { texturePath: ribbon.textureFilename } : {}),
      heightAbove: halfWidth,
      heightBelow: halfWidth,
      alpha: ribbon.alpha,
      visibility: animScalar(raw?.active, 1) === 0 ? 0 : 1,
      emissionRate,
      lifeSpan: ribbon.lifespan,
      lifeSpanRandom: animScalar(raw?.lifespan2, ribbon.lifespan),
      randomizeLifeSpan:
        (additionalFlags & 0x2) !== 0 || finiteInteger(raw?.lifespan_randomize, 0) !== 0,
      speed: animScalar(raw?.speed, ribbon.speed),
      speedRandom: animScalar(raw?.speed2, ribbon.speed),
      randomizeSpeed: (additionalFlags & 0x1) !== 0 || finiteInteger(raw?.speed_randomize, 0) !== 0,
      pitch: animScalar(raw?.pitch, 0),
      yaw: animScalar(raw?.yaw, 0),
      spreadX: animScalar(raw?.spread_x, 0),
      spreadY: animScalar(raw?.spread_y, 0),
      gravity: [
        finiteNumber(raw?.gravity_x, ribbon.gravityX),
        finiteNumber(raw?.gravity_y, ribbon.gravityY),
        -finiteNumber(raw?.gravity, ribbon.gravityZ),
      ],
      drag: finiteNumber(raw?.drag, ribbon.drag),
      mass: Math.max(EPSILON, finiteNumber(raw?.mass, 1)),
      massRandom: Math.max(EPSILON, finiteNumber(raw?.mass2, finiteNumber(raw?.mass, 1))),
      randomizeMass: (additionalFlags & 0x4) !== 0 || finiteInteger(raw?.mass_randomize, 0) !== 0,
      localForceChannels: finiteInteger(raw?.local_forces, 0),
      worldForceChannels: finiteInteger(raw?.world_forces, 0),
      feedbackLocalForceChannels: finiteInteger(raw?.local_forces_fb, 0),
      feedbackWorldForceChannels: finiteInteger(raw?.world_forces_fb, 0),
      worldForceMassMultiplier: finiteNumber(raw?.world_forces_mass_mult, 1),
      noiseAmplitude: finiteNumber(raw?.noise_amplitude, 0),
      noiseFrequency: finiteNumber(raw?.noise_frequency, 0),
      noiseCohesion: finiteNumber(raw?.noise_cohesion, 0),
      noiseEdge: finiteNumber(raw?.noise_edge, 0),
      collideTerrain: (flags & 0x2) !== 0,
      collideObjects: (flags & 0x4) !== 0,
      friction: Math.max(0, finiteNumber(raw?.friction, 0)),
      bounce: Math.max(0, finiteNumber(raw?.bounce, 0)),
      modelSpace: !m3WorldSpace(raw ?? {}),
      parentVelocity: animScalar(raw?.parent_velocity, 0),
      color: ribbon.color,
      widths: [
        Math.abs(ribbon.sizeBase[0]),
        Math.abs(ribbon.sizeMid[0]),
        Math.abs(ribbon.sizeTip[0]),
      ],
      widthTimeMiddle: ribbon.sizeAnimMid,
      segmentColors: [
        [ribbon.colorBase[0], ribbon.colorBase[1], ribbon.colorBase[2]],
        [ribbon.colorMid[0], ribbon.colorMid[1], ribbon.colorMid[2]],
        [ribbon.colorTip[0], ribbon.colorTip[1], ribbon.colorTip[2]],
      ],
      segmentAlphas: [ribbon.colorBase[3], ribbon.colorMid[3], ribbon.colorTip[3]],
      colorTimeMiddle: ribbon.colorAnimMid,
      ribbonType: M3_RIBBON_TYPES[ribbonTypeCode] ?? 'billboard',
      sides,
      starRatio: Math.min(1, Math.max(0, starRatio)),
      divisions,
      maxLength: Math.max(0, animScalar(raw?.length, ribbon.segmentLength)),
      lengthAndTime: (flags & RIBBON_LENGTH_AND_TIME_FLAG) !== 0,
      ...(splineEndpoints.length > 0 ? { splineEndpoints } : {}),
      pitchVariation: effectVariation(raw, 'pitch'),
      yawVariation: effectVariation(raw, 'yaw'),
      lengthVariation: effectVariation(raw, 'length'),
      scaleVariation: effectVariation(raw, 'scale'),
      alphaVariation: effectVariation(raw, 'alpha'),
      ...(sequenceAnimation ? { sequenceAnimation } : {}),
    }
  })

  const hasAnimationMetadata =
    particleAnimationMetadata.length > 0 || ribbonAnimationMetadata.length > 0
  return {
    particleLighting,
    effects: {
      particles: renderParticles,
      ribbons: renderRibbons,
      forces: forces.map(force => ({
        name: force.name,
        boneIndex: force.boneIndex,
        type: force.forceType === 1 ? 'wind' : force.forceType === 2 ? 'explosion' : 'radial',
        shape:
          force.shape === 1
            ? 'cylinder'
            : force.shape === 2
              ? 'box'
              : force.shape === 3
                ? 'hemisphere'
                : 'sphere',
        channels: force.channels,
        strength: force.strength,
        width: force.width,
        height: force.height,
        length: force.length,
        falloff: force.falloff,
        heightGradient: force.heightGradient,
        unbounded: force.unbounded,
      })),
      warps: warps.map(warp => ({
        name: warp.name,
        boneIndex: warp.boneIndex,
        warpType: warp.warpType,
        radius: warp.radius,
        height: warp.height,
        strength: warp.strength,
        angular: warp.angular,
        axial: warp.axial,
        radial: warp.radial,
      })),
      projectors: projectors.map(projector => ({
        name: projector.name,
        boneIndex: projector.boneIndex,
        materialIndex: projector.materialIndex,
        projectionType: projector.projectionType === 1 ? 'perspective' : 'orthographic',
        offset: projector.offset,
        pitch: projector.pitch,
        yaw: projector.yaw,
        roll: projector.roll,
        fieldOfView: projector.fieldOfView,
        aspectRatio: projector.aspectRatio,
        near: projector.near,
        far: projector.far,
        boxOffsetZBottom: projector.boxOffsetZBottom,
        boxOffsetZTop: projector.boxOffsetZTop,
        boxOffsetXLeft: projector.boxOffsetXLeft,
        boxOffsetXRight: projector.boxOffsetXRight,
        boxOffsetYFront: projector.boxOffsetYFront,
        boxOffsetYBack: projector.boxOffsetYBack,
        falloff: projector.falloff,
        alphaInit: projector.alphaInit,
        alphaMid: projector.alphaMid,
        alphaEnd: projector.alphaEnd,
        lifetimeAttack: projector.lifetimeAttack,
        lifetimeAttackTo: projector.lifetimeAttackTo,
        lifetimeHold: projector.lifetimeHold,
        lifetimeHoldTo: projector.lifetimeHoldTo,
        lifetimeDecay: projector.lifetimeDecay,
        lifetimeDecayTo: projector.lifetimeDecayTo,
        attenuationDistance: projector.attenuationDistance,
        active: projector.active,
        layer: projector.layer,
        flags: projector.flags,
      })),
    },
    diagnostics,
    animationMetadata: hasAnimationMetadata
      ? {
          mode: 'm3-sequence-indexed',
          particles: particleAnimationMetadata,
          ribbons: ribbonAnimationMetadata,
        }
      : null,
  }
}

function effectAnimations(
  emitterIndex: number,
  raw: M3StructureData,
  fields: readonly AnimationField[],
  extractor: M3AnimationReferenceTrackExtractor,
): M3EffectEmitterAnimationMetadata | null {
  const parameters: M3EffectParameterAnimation[] = []
  for (const field of fields) {
    const ref = raw[field.sourceField] as M3StructureData | undefined
    const parsed = parseAnimationReference(ref)
    if (!parsed) continue
    const sequenceTracks = extractor.extract(
      ref,
      field.transform ? { transformVector: field.transform } : {},
    )
    if (sequenceTracks.length === 0) continue
    parameters.push({
      sourceField: field.sourceField,
      renderFields: field.renderFields,
      animId: parsed.animId,
      interpolationType: parsed.interpolationType,
      animFlags: parsed.animFlags,
      initValue: field.transform ? field.transform(parsed.initValue) : parsed.initValue,
      sequenceTracks,
    })
  }
  return parameters.length > 0 ? { emitterIndex, parameters } : null
}

function particleSequenceAnimation(
  parameters: readonly M3EffectParameterAnimation[],
): RenderParticleEmitterSequenceAnimation | undefined {
  const animation: RenderParticleEmitterSequenceAnimation = {}
  for (const parameter of parameters) {
    const tracks = parameter.sequenceTracks
    switch (parameter.sourceField) {
      case 'emit_rate':
        animation.emissionRate = tracks
        break
      case 'lifespan':
        animation.lifeSpan = tracks
        break
      case 'emit_speed':
        animation.speed = tracks
        break
      case 'emit_angle_x':
        animation.emitAngleX = tracks
        break
      case 'emit_angle_y':
        animation.emitAngleY = tracks
        break
      case 'emit_spread_x':
        animation.emitSpreadX = tracks
        break
      case 'emit_spread_y':
        animation.emitSpreadY = tracks
        break
      case 'emit_shape_radius':
        animation.emitShapeRadius = tracks
        break
      case 'emit_shape_size':
        animation.emitShapeSize = tracks
        break
      case 'size':
        animation.lifecycleSizeStart = uniformComponentSequenceTracks(tracks, 0)
        animation.lifecycleSizeMiddle = uniformComponentSequenceTracks(tracks, 1)
        animation.lifecycleSizeEnd = uniformComponentSequenceTracks(tracks, 2)
        break
      case 'size2':
        animation.lifecycleSizeRandomStart = uniformComponentSequenceTracks(tracks, 0)
        animation.lifecycleSizeRandomMiddle = uniformComponentSequenceTracks(tracks, 1)
        animation.lifecycleSizeRandomEnd = uniformComponentSequenceTracks(tracks, 2)
        break
      case 'color_init':
        animation.segmentColorStart = tracks
        animation.segmentAlphaStart = alphaSequenceTracks(tracks)
        break
      case 'color_mid':
        animation.segmentColorMiddle = tracks
        animation.segmentAlphaMiddle = alphaSequenceTracks(tracks)
        break
      case 'color_end':
        animation.segmentColorEnd = tracks
        animation.segmentAlphaEnd = alphaSequenceTracks(tracks)
        break
      case 'emit_count':
        animation.emitCount = tracks
        break
    }
  }
  return Object.keys(animation).length > 0 ? animation : undefined
}

function ribbonSequenceAnimation(
  parameters: readonly M3EffectParameterAnimation[],
): RenderRibbonEmitterSequenceAnimation | undefined {
  const animation: RenderRibbonEmitterSequenceAnimation = {}
  for (const parameter of parameters) {
    const tracks = parameter.sequenceTracks
    switch (parameter.sourceField) {
      case 'active':
        animation.visibility = tracks
        break
      case 'lifespan':
        animation.lifeSpan = tracks
        break
      case 'speed':
        animation.speed = tracks
        break
      case 'pitch':
        animation.pitch = tracks
        break
      case 'yaw':
        animation.yaw = tracks
        break
      case 'spread_x':
        animation.spreadX = tracks
        break
      case 'spread_y':
        animation.spreadY = tracks
        break
      case 'length':
        animation.maxLength = tracks
        break
      case 'scale':
        animation.widthStart = componentSequenceTracks(tracks, 0)
        animation.widthMiddle = componentSequenceTracks(tracks, 1)
        animation.widthEnd = componentSequenceTracks(tracks, 2)
        break
      case 'color_base':
        animation.color = tracks
        animation.alpha = alphaSequenceTracks(tracks)
        animation.segmentColorStart = tracks
        animation.segmentAlphaStart = alphaSequenceTracks(tracks)
        break
      case 'color_mid':
        animation.segmentColorMiddle = tracks
        animation.segmentAlphaMiddle = alphaSequenceTracks(tracks)
        break
      case 'color_tip':
        animation.segmentColorEnd = tracks
        animation.segmentAlphaEnd = alphaSequenceTracks(tracks)
        break
    }
  }
  return Object.keys(animation).length > 0 ? animation : undefined
}

function alphaSequenceTracks(
  tracks: readonly SequenceIndexedAnimationTrack[],
): SequenceIndexedAnimationTrack[] {
  return transformSequenceTracks(tracks, value => [finiteNumber(value[3], 1)])
}

function componentSequenceTracks(
  tracks: readonly SequenceIndexedAnimationTrack[],
  component: number,
): SequenceIndexedAnimationTrack[] {
  return transformSequenceTracks(tracks, value => [finiteNumber(value[component], 0)])
}

function uniformComponentSequenceTracks(
  tracks: readonly SequenceIndexedAnimationTrack[],
  component: number,
): SequenceIndexedAnimationTrack[] {
  return transformSequenceTracks(tracks, value => {
    const scalar = finiteNumber(value[component], 0)
    return [scalar, scalar, scalar]
  })
}

function uniformLifecycleFromCurve(
  curve: readonly [number, number, number],
  timeMiddle: number,
): RenderParticleLifecycleSize {
  return {
    start: [curve[0], curve[0], curve[0]],
    middle: [curve[1], curve[1], curve[1]],
    end: [curve[2], curve[2], curve[2]],
    timeMiddle,
  }
}

function transformSequenceTracks(
  tracks: readonly SequenceIndexedAnimationTrack[],
  transform: (value: readonly number[]) => readonly number[],
): SequenceIndexedAnimationTrack[] {
  return tracks.map(entry => ({
    ...entry,
    track: {
      ...entry.track,
      keys: entry.track.keys.map(key => ({
        ...key,
        vector: transform(key.vector),
        ...(key.inTan ? { inTan: transform(key.inTan) } : {}),
        ...(key.outTan ? { outTan: transform(key.outTan) } : {}),
      })),
    },
  }))
}

function compactSplineEndpointAnimation(animation: {
  velocity: SequenceIndexedAnimationTrack[]
  velocityBaseFactor: SequenceIndexedAnimationTrack[]
  velocityEndFactor: SequenceIndexedAnimationTrack[]
  yaw: SequenceIndexedAnimationTrack[]
  pitch: SequenceIndexedAnimationTrack[]
}): typeof animation | undefined {
  return Object.values(animation).some(tracks => tracks.length > 0) ? animation : undefined
}

function collectParticleDiagnostics(
  raw: M3StructureData,
  index: number,
  shapeCode: number,
  particleTypeCode: number,
  hasSplinePoints: boolean,
  hasMeshRegions: boolean,
  diagnostics: M3EffectConversionDiagnostic[],
): void {
  const flags = finiteInteger(raw.flags, 0)

  addDiagnostic(diagnostics, raw, {
    code: 'm3-particle-emission-volume-partial',
    kind: 'particle',
    index,
    fields: [
      ...(shapeCode === 7 && !hasMeshRegions ? ['emit_shape'] : []),
      ...(shapeCode === 6 && !hasSplinePoints ? ['emit_shape'] : []),
      ...(referenceEntries(raw.emit_shape_spline) > 0 && !hasSplinePoints
        ? ['emit_shape_spline']
        : []),
      ...(referenceEntries(raw.emit_shape_regions) > 0 && !hasMeshRegions
        ? ['emit_shape_regions']
        : []),
    ],
    message:
      'Missing spline or mesh-region emission data falls back to the portable plane sampler.',
  })
  addDiagnostic(diagnostics, raw, {
    code: 'm3-particle-instance-orientation-partial',
    kind: 'particle',
    index,
    fields:
      particleTypeCode < 0 || particleTypeCode >= M3_PARTICLE_INSTANCE_TYPES.length
        ? ['particle_type']
        : [],
    message: `Unknown M3 particle instance type ${particleTypeCode} falls back to a camera-facing billboard.`,
  })
  addDiagnostic(diagnostics, raw, {
    code: 'm3-particle-model-resolver-dependent',
    severity: 'info',
    kind: 'particle',
    index,
    fields: [
      ...(flags & PARTICLE_MODEL_FLAG ? ['flags.model_particles'] : []),
      ...(referenceEntries(raw.model_paths) > 0 ? ['model_paths'] : []),
    ],
    message:
      'Nested model particles are live in Three.js and raw WebGL when the host supplies its model resolver/draw callback; otherwise the billboard fallback remains active.',
  })
  addDiagnostic(diagnostics, raw, {
    code: 'm3-particle-collision-host-dependent',
    severity: 'info',
    kind: 'particle',
    index,
    fields: flags & PARTICLE_SURFACE_COLLISION_FLAGS ? ['flags.collision'] : [],
    message:
      'Authored model collision shapes are used automatically; terrain and external scene surfaces remain host-provided.',
  })
}

function collectRibbonDiagnostics(
  raw: M3StructureData,
  index: number,
  diagnostics: M3EffectConversionDiagnostic[],
): void {
  const ribbonType = finiteInteger(raw.ribbon_type, 0)
  const ribbonSides = finiteInteger(raw.sides, 3)
  const starRatio = finiteNumber(raw.star_ratio, 0.5)

  addDiagnostic(diagnostics, raw, {
    code: 'm3-ribbon-cross-section-bounded',
    kind: 'ribbon',
    index,
    fields: [
      ...(ribbonType < 0 || ribbonType >= M3_RIBBON_TYPES.length ? ['ribbon_type'] : []),
      ...(ribbonType >= 2 && (ribbonSides < 3 || ribbonSides > MAX_EFFECT_RIBBON_SIDES)
        ? ['sides']
        : []),
      ...(ribbonType === 3 && (starRatio < 0 || starRatio > 1) ? ['star_ratio'] : []),
    ],
    message: `M3 ribbon cross-sections are live; invalid types fall back to billboard and polygon sides are bounded to ${MAX_EFFECT_RIBBON_SIDES}.`,
  })
}

interface PendingDiagnostic {
  code: string
  severity?: M3EffectConversionDiagnostic['severity']
  kind: EffectKind
  index: number
  fields: string[]
  message: string
}

function addDiagnostic(
  target: M3EffectConversionDiagnostic[],
  _raw: M3StructureData,
  pending: PendingDiagnostic,
): void {
  const fields = [...new Set(pending.fields)]
  if (fields.length === 0) return
  target.push(
    effectDiagnostic(
      pending.code,
      pending.kind,
      pending.index,
      fields,
      pending.message,
      pending.severity,
    ),
  )
}

function effectDiagnostic(
  code: string,
  emitterKind: EffectKind,
  emitterIndex: number,
  fields: string[],
  message: string,
  severity: M3EffectConversionDiagnostic['severity'] = 'warning',
): M3EffectConversionDiagnostic {
  return { code, severity, emitterKind, emitterIndex, fields, message }
}

function sectionRecords(
  sections: SectionResolver,
  ref: M3Reference | undefined,
): M3StructureData[] {
  return (sections.getSectionByReference(ref)?.content ?? []) as M3StructureData[]
}

function sectionValues(sections: SectionResolver, ref: M3Reference | undefined): unknown[] {
  return sections.getSectionByReference(ref)?.content ?? []
}

function sectionNumbers(sections: SectionResolver, ref: M3Reference | undefined): number[] {
  return sectionValues(sections, ref)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map(value => Math.trunc(value))
}

function emissionMeshesForRegions(
  meshes: readonly RenderMesh[],
  regionIndices: readonly number[],
): Array<{ positions: Float32Array; indices: Uint16Array | Uint32Array }> {
  const result: Array<{ positions: Float32Array; indices: Uint16Array | Uint32Array }> = []
  const seenPositions = new Set<Float32Array>()
  for (const regionIndex of regionIndices) {
    const baseName = `M3_Region_${regionIndex}`
    for (const mesh of meshes) {
      if (
        (mesh.primitiveTopology !== undefined && mesh.primitiveTopology !== 'triangles') ||
        (mesh.name !== baseName && !mesh.name.startsWith(`${baseName}_Batch_`)) ||
        seenPositions.has(mesh.positions)
      ) {
        continue
      }
      seenPositions.add(mesh.positions)
      result.push({ positions: mesh.positions, indices: mesh.indices })
    }
  }
  return result
}

function particleCopySequenceAnimation(
  inherited: RenderParticleEmitterSequenceAnimation | undefined,
  overrides: RenderParticleEmitterSequenceAnimation | undefined,
): RenderParticleEmitterSequenceAnimation | undefined {
  const animation: RenderParticleEmitterSequenceAnimation = inherited ? { ...inherited } : {}
  // PARC owns these channels. Never leak the source PAR_ tracks into a copy
  // merely because the copy has a constant/no-track animation reference.
  delete animation.emissionRate
  delete animation.emitCount
  if (overrides?.emissionRate) animation.emissionRate = overrides.emissionRate
  if (overrides?.emitCount) animation.emitCount = overrides.emitCount
  return Object.keys(animation).length > 0 ? animation : undefined
}

function numericCode(value: string): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : 0
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function finitePositiveInteger(value: unknown): number | undefined {
  const parsed = finiteInteger(value, 0)
  return parsed > 0 ? parsed : undefined
}

function animScalar(value: unknown, fallback: number): number {
  const parsed = parseAnimationReference(value as M3StructureData | undefined)
  return finiteNumber(parsed?.initValue[0], fallback)
}

function animVector3(
  value: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  const parsed = parseAnimationReference(value as M3StructureData | undefined)
  return [
    finiteNumber(parsed?.initValue[0], fallback[0]),
    finiteNumber(parsed?.initValue[1], fallback[1]),
    finiteNumber(parsed?.initValue[2], fallback[2]),
  ]
}

function animVector2(value: unknown, fallback: readonly [number, number]): [number, number] {
  const parsed = parseAnimationReference(value as M3StructureData | undefined)
  return [
    finiteNumber(parsed?.initValue[0], fallback[0]),
    finiteNumber(parsed?.initValue[1], fallback[1]),
  ]
}

function animColor(
  value: unknown,
  fallback: readonly [number, number, number, number],
): [number, number, number, number] {
  const parsed = parseAnimationReference(value as M3StructureData | undefined)
  if (!parsed) return [fallback[0], fallback[1], fallback[2], fallback[3]]
  const normalized = normalizeColor(parsed.initValue)
  return [normalized[0]!, normalized[1]!, normalized[2]!, normalized[3]!]
}

function plainVector3(
  value: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  const components = valueToComponents(value)
  return [
    finiteNumber(components[0], fallback[0]),
    finiteNumber(components[1], fallback[1]),
    finiteNumber(components[2], fallback[2]),
  ]
}

function effectVariation(
  raw: M3StructureData | undefined,
  prefix: string,
): RenderEffectVariation | undefined {
  if (!raw) return undefined
  const shape = finiteInteger(raw[`${prefix}_var_shape`], 0)
  const amplitude = animScalar(raw[`${prefix}_var_amplitude`], 0)
  const frequency = animScalar(raw[`${prefix}_var_frequency`], 0)
  if (shape === 0 && Math.abs(amplitude) <= EPSILON && Math.abs(frequency) <= EPSILON) {
    return undefined
  }
  return { shape, amplitude, frequency }
}

function normalizeColor(value: readonly number[]): readonly number[] {
  return [
    Math.min(1, Math.max(0, finiteNumber(value[0], 255) / 255)),
    Math.min(1, Math.max(0, finiteNumber(value[1], 255) / 255)),
    Math.min(1, Math.max(0, finiteNumber(value[2], 255) / 255)),
    Math.min(1, Math.max(0, finiteNumber(value[3], 255) / 255)),
  ]
}

function normalizeVisibility(value: readonly number[]): readonly number[] {
  return [finiteNumber(value[0], 0) === 0 ? 0 : 1]
}

function flipbookFrames(
  raw: M3StructureData | undefined,
  phase: 'start' | 'end',
): readonly [number, number, number] | null {
  if (!raw) return null
  const first = finiteInteger(raw[`uv_flipbook_${phase}_init_index`], 0)
  const last = finiteInteger(raw[`uv_flipbook_${phase}_stop_index`], first)
  return first !== 0 || last !== 0 ? [first, last, 0] : null
}

function referenceEntries(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  return finiteInteger((value as M3Reference).entries, 0)
}

/**
 * `tail_clamp` (0x40000) and `tail_fix` (0x100000) of a particle system's flags: how Particle.fx
 * sizes a tail (codec-kit RenderParticleEmitter `tailClamped`, `tailFixed`).
 */
function particleTailMode(flags: number): { tailClamped?: true; tailFixed?: true } {
  return {
    ...((flags & 0x40000) !== 0 ? { tailClamped: true as const } : {}),
    ...((flags & 0x100000) !== 0 ? { tailFixed: true as const } : {}),
  }
}

function m3WorldSpace(raw: M3StructureData): boolean {
  return typeof raw.additional_flags === 'number'
    ? (finiteInteger(raw.additional_flags, 0) & 0x8) !== 0
    : finiteInteger(raw.world_space, 0) !== 0
}
