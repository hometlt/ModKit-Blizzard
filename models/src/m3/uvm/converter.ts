/** Source-free M3/M3A ↔ UVM orchestration: units/frames, geometry, animation, effects and typed
 * residual capture. Native material loss facts refuse fresh writes; they do not restore REF_. */
import { captureM3Billboards, addM3Billboards } from './billboards.js'
import type {
  JsonObject,
  ModelMaterialRef,
  RevisionId,
} from '@modkit/sdk'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { materializeUvmCore, type ModelProjection } from '@modkit/uv/model/materializer'
import {
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
  type UvmContainerBudget,
} from '@modkit/uv/model/container'
import { attachUvmFormatResidual } from '@modkit/uv/model/format-residual'
import { preserveUnweightedVertices } from '@modkit/scene/model'
import { mapM3AttachmentVolumes, mapM3HitTests, type M3AttachmentVolume } from './volumes.js'
import type { HitVolume } from '../../../dist/m3/native/types.js'
import { m3RigidBodyCollisions, type M3RigidBody } from './rigid-bodies.js'
import {
  materializeUvmAnimationMaterialTargets,
} from '@modkit/uv/model/animation-clips'
import type { M3SequenceBinding } from './animation-binding.js'
import { projectM3Effects, type M3EffectsSource } from './effects.js'
import { deriveM3ParticleMaterials } from '../particle-material-lighting.js'
import { replicateM3ParticleMaterial } from './material-binding.js'
import { projectM3StaticPreview, type M3StaticPreviewSource } from './preview.js'
import type { M3ResidualAnimationEventTrack, M3ResidualAnimationTrack } from '../animation-projection.js'
import { exportFreshM3FromUvm } from '../../../src/m3/runtime/fresh-export.js'

/** Already admitted by the native companion resolver; this converter does not discover or parse it. */
export interface M3UvmAnimationSidecar {
  readonly logicalId: string
  readonly revision: RevisionId
  readonly bytes: Uint8Array
  readonly metadata: JsonObject
  /** Exact IDs in projection.animations, not names or positional glTF animation IDs. */
  readonly clipIds: readonly string[]
  /** Native SEQS positions, including gaps rejected by decoding. Never derived from a clip ID. */
  readonly nativeSequenceIndices?: readonly number[]
}

export interface M3UvmConversionOptions {
  readonly assetId: string
  readonly subjectRevision: RevisionId
  /** Authoritative contribution format; neither shared magic nor companion presence selects it. */
  readonly sourceFormat?: 'm3' | 'm3a'
  readonly m3aHash?: number
  readonly m3aHashes?: readonly number[]
  readonly animationEvents?: readonly M3ResidualAnimationEventTrack[]
  readonly residualAnimationTracks?: readonly M3ResidualAnimationTrack[]
  /** Project/caller policy, never inferred from a model's size or from a sample in the spec. */
  readonly metersPerSourceUnit: number
  readonly budget: UvmContainerBudget & { readonly maxScalarBytes: number }
  readonly signal?: AbortSignal
  readonly attachmentVolumes?: readonly M3AttachmentVolume[]
  /** SSGS hit tests, written as UV `hit` collisions. */
  readonly hitTests?: readonly HitVolume[]
  readonly animationSidecars?: readonly M3UvmAnimationSidecar[]
  readonly rigidBodies?: readonly M3RigidBody[]
  readonly sequenceBindings?: readonly M3SequenceBinding[]
  readonly materialBinding?: JsonObject
  readonly effects?: M3EffectsSource
  readonly staticPreview?: M3StaticPreviewSource
  readonly animationReferenceIds?: readonly JsonObject[]
  /** Inactive standalone binding slots. The common UV helper retains known animated properties
   * only; no material, texture, image or resource is activated by this payload. */
  readonly animationMaterialTargets?: readonly ModelMaterialRef[]
}

function ownAnimationSidecars(
  input: readonly M3UvmAnimationSidecar[] | undefined,
  baseByteLength: number,
  budget: M3UvmConversionOptions['budget'],
  signal?: AbortSignal,
): readonly M3UvmAnimationSidecar[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new TypeError('M3 animationSidecars must be an array')
  if (input.length > budget.maxNodes) throw new RangeError('M3 animationSidecars exceed maxNodes')
  let total = baseByteLength
  const bytes = input.map(sidecar => {
    signal?.throwIfAborted()
    if (sidecar === null || typeof sidecar !== 'object' || !(sidecar.bytes instanceof Uint8Array))
      throw new TypeError('M3 animation sidecar requires bytes')
    total += sidecar.bytes.length
    if (
      sidecar.bytes.length === 0 ||
      !Number.isSafeInteger(total) ||
      total > budget.maxInputBytes ||
      total > budget.maxScalarBytes
    )
      throw new RangeError('M3 animation sidecar sources exceed byte budget')
    return Uint8Array.from(sidecar.bytes)
  })
  const records = snapshotJson(
    input.map(({ logicalId, revision, metadata, clipIds, nativeSequenceIndices }) => ({
      logicalId,
      revision,
      metadata,
      clipIds,
      ...(nativeSequenceIndices === undefined ? {} : { nativeSequenceIndices }),
    })),
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: Math.min(budget.maxJsonBytes, budget.maxScalarBytes),
    },
    signal,
  ) as unknown as readonly Omit<M3UvmAnimationSidecar, 'bytes'>[]
  const logicalIds = new Set<string>(),
    clipIds = new Set<string>()
  return records.map((record, index) => {
    if (
      typeof record.logicalId !== 'string' ||
      !record.logicalId.trim() ||
      record.logicalId !== record.logicalId.trim() ||
      typeof record.revision !== 'string' ||
      !record.revision.trim() ||
      logicalIds.has(record.logicalId)
    )
      throw new TypeError('M3 animation sidecar requires a unique logicalId and revision')
    logicalIds.add(record.logicalId)
    object(record.metadata, 'animation sidecar metadata')
    if (!Array.isArray(record.clipIds))
      throw new TypeError('M3 animation sidecar clipIds must be an array')
    for (const clipId of record.clipIds) {
      if (typeof clipId !== 'string' || !clipId.trim() || clipIds.has(clipId))
        throw new TypeError('M3 animation sidecar requires unique clip IDs')
      clipIds.add(clipId)
    }
    if (
      record.nativeSequenceIndices !== undefined &&
      (!Array.isArray(record.nativeSequenceIndices) ||
        record.nativeSequenceIndices.length !== record.clipIds.length ||
        record.nativeSequenceIndices.some(index => !Number.isSafeInteger(index) || index < 0) ||
        new Set(record.nativeSequenceIndices).size !== record.nativeSequenceIndices.length)
    )
      throw new TypeError(
        'M3 animation sidecar requires one distinct native sequence index per clip',
      )
    const owned = bytes[index]
    if (owned === undefined) throw new TypeError('M3 animation sidecar byte snapshot is absent')
    return { ...record, bytes: owned }
  })
}

function projectedEffectAnimationBindings(source: M3EffectsSource | undefined): readonly JsonObject[] {
  const result: JsonObject[] = []
  if (source === undefined || source.animationMetadata === null ||
      typeof source.animationMetadata !== 'object' || Array.isArray(source.animationMetadata))
    return result
  const metadata = source.animationMetadata as JsonObject
  const supported = {
    particles: new Set([
      'emit_rate', 'lifespan', 'emit_speed', 'emit_angle_x', 'emit_angle_y',
      'emit_spread_x', 'emit_spread_y', 'emit_shape_radius', 'emit_shape_size', 'emit_count',
    ]),
    ribbons: new Set([
      'active', 'lifespan', 'speed', 'pitch', 'yaw', 'spread_x', 'spread_y', 'length',
      'color_base', 'color_mid', 'color_tip',
    ]),
  }
  for (const kind of ['particles', 'ribbons'] as const) {
    const emitters = metadata[kind]
    if (!Array.isArray(emitters)) continue
    for (const rawEmitter of emitters) {
      if (rawEmitter === null || typeof rawEmitter !== 'object' || Array.isArray(rawEmitter)) continue
      const emitter = rawEmitter as JsonObject
      const emitterIndex = emitter['emitterIndex']
      const parameters = emitter['parameters']
      if (!Number.isSafeInteger(emitterIndex) || (emitterIndex as number) < 0 ||
          !Array.isArray(parameters)) continue
      for (const rawParameter of parameters) {
        if (rawParameter === null || typeof rawParameter !== 'object' || Array.isArray(rawParameter))
          continue
        const parameter = rawParameter as JsonObject
        const field = parameter['sourceField']
        const animId = parameter['animId']
        const interpolation = parameter['interpolationType']
        const flags = parameter['animFlags']
        if (
          typeof field === 'string' && supported[kind].has(field) &&
          typeof animId === 'number' && Number.isSafeInteger(animId) && animId >= 0 && animId <= 0xffffffff &&
          typeof interpolation === 'number' && Number.isSafeInteger(interpolation) && interpolation >= 0 && interpolation <= 0xffffffff &&
          typeof flags === 'number' && Number.isSafeInteger(flags) && flags >= 0 && flags <= 0xffffffff
        ) result.push({ kind, emitterIndex: emitterIndex as number, field, animId, interpolation, flags })
      }
    }
  }
  return result
}

function projectedEffectAnimationIds(bindings: readonly JsonObject[]): ReadonlySet<number> {
  const result = new Set<number>()
  for (const binding of bindings) result.add(binding['animId'] as number)
  return result
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`converted UVM ${label} is absent`)
  return value as JsonObject
}

/** Native decoding supplies the bounded projection and complete schema metadata. All UVM
 * layout, serialization and scene transformation stay with the shared owners. This conversion
 * emits source-free UVM. BlizzardM3 retains only residual data that common glTF/UVM cannot reproduce.
 */
export async function convertM3ProjectionToUvm(
  bytes: Uint8Array,
  projection: ModelProjection,
  metadata: JsonObject,
  options: M3UvmConversionOptions,
) {
  const { signal, metersPerSourceUnit: scale, sourceFormat = 'm3' } = options
  const budget = { ...options.budget }
  signal?.throwIfAborted()
  if (sourceFormat !== 'm3' && sourceFormat !== 'm3a')
    throw new TypeError('M3 conversion sourceFormat must be m3 or m3a')
  if (
    sourceFormat === 'm3a' &&
    ([
      projection.info.meshes,
      projection.info.primitives,
      projection.info.materials,
      projection.info.textures,
    ].some(count => count !== 0) ||
      (projection.meshes?.length ?? 0) > 0 ||
      (projection.primitives?.length ?? 0) > 0 ||
      (projection.materials?.length ?? 0) > 0 ||
      projection.info.bounds !== undefined ||
      projection.nodes?.some(node => node.meshIds.length > 0) ||
      (projection.resourceClosure?.entries?.length ?? 0) > 0)
  )
    throw new TypeError('M3A conversion requires an already selected animation-only projection')
  if (!Number.isFinite(scale) || scale <= 0)
    throw new TypeError('M3 conversion requires a positive finite metersPerSourceUnit')
  if (bytes.length > budget.maxInputBytes) throw new RangeError('M3 source exceeds maxInputBytes')
  const billboards = captureM3Billboards(
    projection.skeleton ?? [],
    budget.maxNodes,
    budget.maxJsonBytes,
    signal,
  )
  const staticPreview =
    sourceFormat === 'm3a' || options.staticPreview === undefined
      ? undefined
      : (snapshotJson(
          options.staticPreview,
          { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes },
          signal,
        ) as unknown as M3StaticPreviewSource)
  const sidecars = ownAnimationSidecars(
    options.animationSidecars,
    bytes.length,
    budget,
    signal,
  )
  const nativeMetadata = snapshotJson(
    metadata,
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxJsonBytes,
      sortKeys: true,
    },
    signal,
  ) as JsonObject
  const bindingMetadata = snapshotJson(
    {
      ...(options.sequenceBindings === undefined
        ? {}
        : { sequenceBindings: options.sequenceBindings }),
      ...(options.materialBinding === undefined
        ? {}
        : { materialBinding: options.materialBinding }),
    },
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes },
    signal,
  ) as JsonObject
  if (bindingMetadata['sequenceBindings'] !== undefined) {
    const bindings = bindingMetadata['sequenceBindings']
    const clips = projection.animations ?? []
    if (!Array.isArray(bindings) || bindings.length !== clips.length)
      throw new TypeError('M3 native sequence mapping must cover the complete projection')
    const seen = new Set<string>(),
      nativeIds = new Set<string>()
    for (const value of bindings) {
      const binding = object(value, 'native sequence binding')
      const clipId = binding['clipId'],
        nativeIndex = binding['nativeSequenceIndex'],
        combinedIndex = binding['combinedSequenceIndex']
      const clipIndex = clips.findIndex(clip => clip.id === clipId)
      const clip = clips[clipIndex]
      if (
        typeof clipId !== 'string' ||
        seen.has(clipId) ||
        clip === undefined ||
        combinedIndex !== (clip.sequenceIndex ?? clipIndex) ||
        typeof nativeIndex !== 'number' ||
        !Number.isSafeInteger(nativeIndex) ||
        nativeIndex < 0
      )
        throw new TypeError('M3 native sequence mapping disagrees with the projected clip')
      seen.add(clipId)
      const logicalId = binding['logicalId']
      const sidecar = sidecars.find(item => item.logicalId === logicalId)
      if (binding['source'] === 'sidecar') {
        const index = sidecar?.clipIds.indexOf(clipId) ?? -1
        if (
          index < 0 ||
          (sidecar?.nativeSequenceIndices !== undefined &&
            sidecar.nativeSequenceIndices[index] !== nativeIndex)
        )
          throw new TypeError('M3 native sequence mapping disagrees with its sidecar source')
      } else if (
        binding['source'] !== 'base' ||
        logicalId !== undefined ||
        sidecars.some(item => item.clipIds.includes(clipId))
      )
        throw new TypeError('M3 native sequence mapping has an invalid source identity')
      const nativeId = JSON.stringify([binding['source'], logicalId ?? null, nativeIndex])
      if (nativeIds.has(nativeId))
        throw new TypeError('M3 native sequence mapping repeats a source index')
      nativeIds.add(nativeId)
    }
  }
  const facetBudget = {
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
    maxBytes: budget.maxScalarBytes,
  }
  if (options.animationMaterialTargets !== undefined && sourceFormat !== 'm3a')
    throw new TypeError('inactive M3 animation materials require standalone M3A interpretation')
  const materialTargets = snapshotJson(
    materializeUvmAnimationMaterialTargets(
      options.animationMaterialTargets ?? [],
      facetBudget,
      signal,
    ),
    facetBudget,
    signal,
  ) as readonly JsonObject[]
  const { sockets = [], ...model } = projection
  const prepared = preserveUnweightedVertices(model, {
    maxBytes: budget.maxScalarBytes,
    maxNodes: budget.maxNodes,
    ...(signal === undefined ? {} : { signal }),
  })
  // Attachment volumes, hit tests and rigid bodies ride on bones; the materializer writes each as a
  // child of its bone's node with UV_game_collision, mesh and hull vertices in their accessors.
  const projectionNodes = prepared.projection.nodes ?? []
  const nodeIds = new Set(projectionNodes.map(node => node.id))
  const rigid = m3RigidBodyCollisions(options.rigidBodies, nodeIds, budget, signal)
  const collisions = [
    ...mapM3AttachmentVolumes(options.attachmentVolumes ?? [], nodeIds),
    ...mapM3HitTests(options.hitTests ?? [], nodeIds),
    ...rigid.volumes,
  ]
  const effects =
    sourceFormat === 'm3a'
      ? undefined
      : projectM3Effects(
          withDeclaredResourcePaths(options.effects, projection.resourceClosure?.entries ?? []),
          nodeIds,
          new Set((prepared.projection.materials ?? []).map(material => material.id)),
          (bindingMetadata['sequenceBindings'] ?? []) as unknown as readonly M3SequenceBinding[],
          budget,
          signal,
        )
  const preview =
    staticPreview === undefined
      ? undefined
      : projectM3StaticPreview(staticPreview, {
          cameraBoneNodeIds: staticPreview.inverseBindMatrices.map((_, index) => nodeIds.has(`bone/${index}`) ? `bone/${index}` : ''),
          metersPerSourceUnit: scale,
          budget,
          ...(signal === undefined ? {} : { signal }),
        })
  const baseMaterials = prepared.projection.materials ?? []
  const materialIndices = new Map(baseMaterials.map((material, index) => [material.id, index]))
  const particles = effects?.effects['particles'] ?? []
  const particleMaterials = effects?.particleLighting === undefined ? undefined : deriveM3ParticleMaterials(
    baseMaterials,
    particles.map(particle => {
      const materialId = object(particle, 'M3 particle')['materialId']
      const index = typeof materialId === 'string' ? materialIndices.get(materialId) : undefined
      if (index === undefined) throw new TypeError('M3 particle material binding absent')
      return index
    }),
    effects.particleLighting,
    { program: material => material.shader?.id === 'modkit.render-material.v1'
        ? material.shader.parameters['renderModel'] : undefined,
      replace: replicateM3ParticleMaterial },
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxScalarBytes: budget.maxScalarBytes }, signal,
  )
  const derivedIds = new Set(baseMaterials.map(material => material.id))
  for (const derivation of particleMaterials?.derivations ?? []) {
    const id = particleMaterials!.materials[derivation.targetIndex]!.id
    if (derivedIds.has(id)) throw new TypeError('M3 particle material identity collision')
    derivedIds.add(id)
  }
  const publishedEffects = effects === undefined ? undefined : {
    ...effects.effects,
    particles: particles.map((particle, index) => ({ ...object(particle, 'M3 particle'),
      ...(particleMaterials === undefined ? {} : {
        materialId: particleMaterials.materials[particleMaterials.particleMaterialIndices[index]!]!.id,
      }),
    })),
  }
  // An M3 attachment point is a helper node below its bone, carrying the socket: several may share
  // a bone, which a socket on the bone itself could not.
  const socketNodes = sockets.map((socket, index) => ({ socket, id: `m3/socket/${index}` }))
  for (const { socket } of socketNodes)
    if (!nodeIds.has(socket.nodeId)) throw new TypeError(`M3 socket ${socket.id} has no exact UVM bone node`)
  const helpersOf = new Map<string, string[]>()
  for (const { socket, id } of socketNodes) helpersOf.set(socket.nodeId, [...(helpersOf.get(socket.nodeId) ?? []), id])
  if (preview?.cameraParentNodeId !== undefined && preview.node !== undefined) {
    if (!nodeIds.has(preview.cameraParentNodeId)) throw new TypeError('M3 camera has no exact bone node')
    helpersOf.set(preview.cameraParentNodeId, [...(helpersOf.get(preview.cameraParentNodeId) ?? []), preview.node.id])
  }
  const nodes = [
    ...projectionNodes.map(node => {
      const helpers = helpersOf.get(node.id)
      return helpers === undefined ? node : { ...node, childIds: [...node.childIds, ...helpers] }
    }),
    ...socketNodes.map(({ socket, id }) => ({
      id,
      ...(socket.sourceName === undefined ? {} : { name: socket.sourceName }),
      childIds: [],
      meshIds: [],
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })),
    ...(effects?.unboundNode === undefined ? [] : [effects.unboundNode]),
    ...(preview?.node === undefined ? [] : [preview.node]),
  ]
  // SPEC_UVM_CONVERSION §2: the materializer's frame nodes (game units to metres, +z up to +y up)
  // apply to static and skinned geometry, sockets, effects, lights and all local TRS keys together.
  // A second yaw based on a guessed facing direction is not added.
  const materialized = materializeUvmCore(
    {
      ...prepared.projection,
      // M3 is +z up whatever the projection says (an M3A one says nothing).
      info: { ...prepared.projection.info, upAxis: '+z',
        ...(particleMaterials === undefined ? {} : { materials: particleMaterials.materials.length }),
      },
      ...(particleMaterials === undefined ? {} : { materials: particleMaterials.materials }),
      nodes,
      ...(socketNodes.length === 0
        ? {}
        : { sockets: socketNodes.map(({ socket, id }) => ({ ...socket, nodeId: id })) }),
      ...(collisions.length === 0 ? {} : { collisions }),
      ...(publishedEffects === undefined ? {} : { effects: publishedEffects }),
      // The preview's lights and camera are plain JSON in the wire form the materializer checks.
      ...(preview?.lights === undefined ? {} : { lights: preview.lights as NonNullable<ModelProjection['lights']> }),
      ...(preview?.camera === undefined
        ? {}
        : { cameras: [preview.camera as NonNullable<ModelProjection['cameras']>[number]] }),
    },
    {
      scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
      profile: 'UVM/core@1.0',
      subjectRevision: options.subjectRevision,
      options: {
        assetId: options.assetId,
        sourceFormat,
        units: { sourceUnit: 'sc2-game-unit', metersPerSourceUnit: scale },
      },
    },
    {
      materialBudget: facetBudget,
      skeletonBudget: facetBudget,
      animationBudget: facetBudget,
      ...(signal === undefined ? {} : { signal }),
    },
  )
  const transformed = addM3Billboards(
    readUvmContainer(materialized.bytes, budget, signal),
    billboards,
    materialized.bindings.nodes,
    budget.maxNodes,
    budget.maxJsonBytes,
    signal,
  )
  const cameraNode = preview?.camera === undefined ? undefined : materialized.bindings.nodes[preview.camera.nodeId]
  const previewMapping: JsonObject | undefined =
    preview === undefined
      ? undefined
      : {
          ...preview.mapping,
          ...(preview.mapping['camera'] === undefined || cameraNode === undefined
            ? {}
            : { camera: { ...object(preview.mapping['camera'], 'camera mapping'), camera: 0, node: cameraNode } }),
        }
  const originalExtensions = object(transformed.document['extensions'], 'extensions')
  const provenance = object(originalExtensions['UV_provenance'], 'provenance')
  const receipt =
    rigid.losses.length === 0
      ? materialized.receipt
      : {
          ...materialized.receipt,
          lostFacetIds: [
            ...new Set([
              ...materialized.receipt.lostFacetIds,
              ...rigid.losses.map(loss => loss.facetId),
            ]),
          ].sort(),
          diff: [...materialized.receipt.diff, ...rigid.losses],
        }
  const originalLosses = provenance['lost']
  if (!Array.isArray(originalLosses)) throw new TypeError('converted UVM provenance losses absent')
  if (!Array.isArray(transformed.document['extensionsUsed']))
    throw new TypeError('converted UVM structure is absent')
  const warnings = [
    ...(preview?.diagnostics ?? []),
    ...rigid.warnings,
    ...(effects?.warnings ?? []),
    ...(prepared.generatedBindings.length === 0
      ? []
      : [
          'Exactly unweighted vertices retain the MK2 CPU position through generated identity joints; this differs from the legacy GPU zero-weight collapse.',
        ]),
    ...(sockets.some(socket => socket.orientation === undefined)
      ? [
          'M3 ATT_ names and bone transforms are preserved. Native forward/up axes were not authored; UVM socket defaults are not claimed as native axes.',
        ]
      : []),
  ]
  const source: UvmContainer = {
    ...transformed,
    document: {
      ...transformed.document,
      extensions: {
        ...originalExtensions,
        ...(materialTargets.length === 0
          ? {}
          : {
              UV_game_animation_clips: {
                ...object(originalExtensions['UV_game_animation_clips'], 'animation clip catalog'),
                materialTargets,
              },
            }),
        UV_provenance: {
          ...provenance,
          ...(rigid.losses.length === 0 ? {} : { lost: [...originalLosses, ...rigid.warnings] }),
          ...(warnings.length === 0 ? {} : { warnings }),
          importer: { id: 'blizzard/m3', version: '1.0.0' },
          source: {
            format: sourceFormat,
            sourceUnits: 'sc2-game-unit',
            sourceAxes: { up: '+z', forward: '+x', handedness: 'right' },
          },
        },
      },
    },
  }
  if (sidecars.length > 0)
    throw new TypeError('source-free M3 conversion requires companion packages as separate UVM assets')
  if (rigid.losses.length > 0)
    throw new TypeError('source-free M3 conversion refuses unrepresented native rigid shapes')
  const billboardNodes = new Set(billboards.map(value => value.nodeId))
    const boneFlagXor = (projection.skeleton ?? []).flatMap(binding => {
      if (typeof binding.nativeFlags !== 'number' || !Number.isSafeInteger(binding.nativeFlags)) return []
      const canonical = 0x2a07 | (binding.nodeId !== undefined && billboardNodes.has(binding.nodeId) ? 0x10 : 0)
      const xor = (Number(binding.nativeFlags) ^ canonical) >>> 0
      return xor === 0 ? [] : [{ boneIndex: binding.boneIndex, xor }]
    })
    const rigidBodyResidual = rigid.bodies.map(({ shapes: _shapes, boneIndex: _bone, shape: _shape, size: _size, ...body }) => body)
    const previewResidual = (() => {
      if (staticPreview === undefined || previewMapping === undefined) return undefined
      const mapping = previewMapping
      const cameraMapping = mapping['camera'] === undefined ? undefined : object(mapping['camera'], 'camera mapping')
      const lightMappingsValue = mapping['lights']
      if (lightMappingsValue !== undefined && !Array.isArray(lightMappingsValue))
        throw new TypeError('M3 light mappings must be an array')
      const lightMappings = lightMappingsValue ?? []
      const mappedCamera = cameraMapping?.['nativeIndex']
      const mappedLights = new Set(lightMappings.map(value => object(value, 'light mapping')['nativeIndex']))
      const cameraExtras = typeof mappedCamera === 'number'
        ? (() => {
            if (cameraMapping === undefined) throw new TypeError('M3 camera mapping absent')
            const record = staticPreview.cameras[mappedCamera]
            if (record === undefined) throw new TypeError('M3 camera mapping source absent')
            const {
              name: _name, nearClip: _near, farClip: _far, fieldOfView: _fov,
              boneIndex, useVerticalFov, sequenceAnimation: _animation, ...extra
            } = record
            const camera = cameraMapping['camera']
            if (typeof camera !== 'number' || !Number.isSafeInteger(camera) ||
                typeof boneIndex !== 'number' || !Number.isSafeInteger(boneIndex))
              throw new TypeError('M3 camera mapping indices are invalid')
            return {
              nativeIndex: mappedCamera,
              camera,
              boneIndex,
              useVerticalFov: Boolean(useVerticalFov),
              ...extra,
            }
          })()
        : undefined
      return {
        ...(cameraExtras === undefined ? {} : { camera: cameraExtras }),
        lights: lightMappings,
        unprojectedCameras: staticPreview.cameras.flatMap((record, nativeIndex) =>
          nativeIndex === mappedCamera ? [] : [{ nativeIndex, record }]),
        unprojectedLights: staticPreview.lights.flatMap((record, nativeIndex) =>
          mappedLights.has(nativeIndex) ? [] : [{ nativeIndex, record }]),
      } as JsonObject
    })()
    const effectAnimationBindings = projectedEffectAnimationBindings(options.effects)
    const effectAnimationIds = projectedEffectAnimationIds(effectAnimationBindings)
    const sourceFreeAnimationTracks = (options.residualAnimationTracks ?? []).filter(
      track => !effectAnimationIds.has(track.animId),
    )
    const residual = attachUvmFormatResidual(
      source,
      {
        namespace: 'BlizzardM3',
        format: sourceFormat,
        profile: sourceFormat === 'm3a' ? 'portable-animation-v1' : 'portable-scene-v1',
        residual: {
          mdVersion: nativeMetadata['mdVersion'] ?? 34,
          ...(nativeMetadata['m3UnsupportedMaterialFamilies'] === undefined ? {}
            : { m3UnsupportedMaterialFamilies: nativeMetadata['m3UnsupportedMaterialFamilies'] }),
          ...(Number.isSafeInteger(options.m3aHash) ? { m3aHash: options.m3aHash } : {}),
          ...(options.m3aHashes === undefined ? {} : { m3aHashes: [...options.m3aHashes] }),
          ...(options.animationEvents === undefined || options.animationEvents.length === 0
            ? {}
            : { animationEvents: options.animationEvents.map(event => ({
                ...event,
                frames: [...event.frames],
                events: event.events.map(value => ({ ...value, matrix: [...value.matrix] })),
              })) }),
          ...(sourceFreeAnimationTracks.length === 0
            ? {}
            : { animationTracks: sourceFreeAnimationTracks.map(track => ({
                ...track, frames: [...track.frames], values: [...track.values],
              })) }),
          ...(boneFlagXor.length === 0 ? {} : { boneFlagXor }),
          ...(rigidBodyResidual.length === 0 ? {} : { rigidBodies: rigidBodyResidual }),
          ...(rigid.residualShapes.length === 0 ? {} : { degenerateRigidShapes: rigid.residualShapes }),
          ...(previewResidual === undefined ? {} : { preview: previewResidual }),
          ...(options.animationReferenceIds === undefined || options.animationReferenceIds.length === 0
            ? {}
            : { animationReferenceIds: options.animationReferenceIds }),
          ...(effectAnimationBindings.length === 0
            ? {}
            : { effectAnimationReferenceHeaders: effectAnimationBindings }),
        },
        mapping: {
          nodes: materialized.bindings.nodes,
          // The frame is the materializer's nodes, which the writer takes off.
          frame: { metersPerSourceUnit: scale, dataCoordinates: 'm3-native' },
        },
      },
      budget,
      signal,
    )
    return {
      container: residual,
      bytes: writeUvmContainer(residual, budget, signal),
      receipt,
    }
}

/**
 * One spelling per asset, in the effects extension too.
 *
 * StarCraft II asset paths are case-insensitive and Blizzard's own models mix separators - the
 * same texture appears as `Assets\\Textures\\x.dds` on one emitter and `Assets/Textures/x.dds` on
 * the next. Materials are already bound to the single spelling the resource closure declares; an
 * emitter that kept its own would name a resource this document says nothing about, so a consumer
 * resolving it by path comes up empty.
 *
 * A path the closure does not declare is left exactly as written: that is the model's own claim,
 * and rewriting it would invent a resource.
 */
function withDeclaredResourcePaths<Effects extends { readonly effects: JsonObject } | undefined>(
  source: Effects,
  entries: readonly { readonly logicalId?: string }[],
): Effects {
  if (source === undefined || entries.length === 0) return source
  const key = (value: string): string =>
    value.trim().split(String.fromCharCode(92)).join('/').toLowerCase()
  const declared = new Map<string, string>()
  for (const entry of entries)
    if (typeof entry.logicalId === 'string' && entry.logicalId !== '')
      declared.set(key(entry.logicalId), entry.logicalId)
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        name === 'texturePath' && typeof item === 'string' && item !== ''
          ? (declared.get(key(item)) ?? item)
          : rewrite(item),
      ]),
    )
  }
  return { ...source, effects: rewrite(source.effects) as JsonObject }
}

/** Encode an M3-family file from common UVM. A bounded BlizzardM3 residual is optional and is
 * consulted only when the document originated from the M3 family. Foreign UVM documents use
 * common scene data and deterministic M3 defaults. */
export function exportM3FromUvm(
  container: UvmContainer,
  budget: UvmContainerBudget,
  signal?: AbortSignal,
  /** Collects what the target format had nowhere to put, for a caller that can report it. */
  notes: string[] = [],
  materialPolicy: 'strict' | 'base-color-coverage' = 'strict',
) {
  const extras = container.document['extras']
  const envelope =
    extras !== null && typeof extras === 'object' && !Array.isArray(extras)
      ? ((extras as JsonObject)['BlizzardM3'] as JsonObject | undefined)
      : undefined
  if (envelope !== undefined && envelope['schemaVersion'] !== 1)
    throw new TypeError('M3 export requires source-free BlizzardM3 schemaVersion 1')
  const format = envelope?.['format'] ?? 'm3'
  if (format !== 'm3' && format !== 'm3a')
    throw new TypeError('M3 export residual has an invalid native format')
  const extensions = container.document['extensions']
  const units =
    extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)
      ? ((extensions as JsonObject)['UV_units'] as JsonObject | undefined)?.[
          'metersPerSourceUnit'
        ]
      : undefined
  if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0)
    throw new TypeError('M3 export requires positive UV_units.metersPerSourceUnit')
  return exportFreshM3FromUvm(
    container,
    units,
    {
      maxInputBytes: BigInt(budget.maxInputBytes),
      maxScalarBytes: budget.maxJsonBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxDiagnostics: budget.maxNodes,
    },
    signal,
    format,
    notes,
    materialPolicy,
  )
}
