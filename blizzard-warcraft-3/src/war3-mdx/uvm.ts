/**
 * Warcraft III model -> UVM.
 *
 * The projection handed to the materializer reuses the model facets this codec publishes.
 * Native KRCO facts join the existing ribbon colour sequence vocabulary here. It adds what common
 * glTF structures cannot carry: the emitters under `UV_game_effects` with the `mdx` profile, the
 * attachment and collision nodes under `UV_game_socket` and `UV_game_collision`, and a
 * `BlizzardMDX` residual holding the reconstruction facts a writer will need.
 * Native model-sidecar references enter the common closure; UVM/core cannot bind them and its
 * resource-closure remainder is reported rather than treating a model as a texture image.
 * KMTE animation and HD Fresnel have no qualified common material carrier; their native residual
 * preservation is reported separately from executable material animation, not claimed as playback.
 */
import type { JsonObject, JsonValue, RevisionId } from '@modkit/sdk'
import { admitWar3MaterialHeaders } from './native-material-headers.js'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { RenderModel } from '@modkit/codec-kit/legacy/models'
import { materializeUvmCore, type ModelProjection } from '@modkit/uv/model/materializer'
import {
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
  type UvmContainerBudget,
} from '@modkit/uv/model/container'
import { attachUvmFormatResidual } from '@modkit/uv/model/format-residual'
import { animationSnapshotBudget } from '@modkit/codec-kit/model/animation'
import type { War3PopcornBake } from './popcorn.js'
import { rebaseUvmScene } from '@modkit/scene/uvm/frame'
import {
  war3AnimationClips,
  war3Emitters,
  war3EmitterMaterialKey,
  war3EmitterMaterials,
  war3SpriteMaterial,
  war3EmitterNodeKey,
  war3Materials,
  war3ResourceReferences,
  war3SceneInfo,
  war3SceneMeshes,
  war3SceneNodes,
  war3ScenePrimitives,
  war3SkeletonBindings,
  war3Collisions,
  war3Sockets,
  war3NodeId,
  WAR3_ROOT_NODE_ID,
  war3LodLevels,
} from './scene.js'

export interface War3UvmOptions {
  readonly assetId: string
  readonly subjectRevision: RevisionId
  /**
   * Caller policy, never inferred from a model's size. Warcraft III world units have no declared
   * metre length; 1 keeps source units and is the only value that asserts nothing.
   */
  readonly metersPerSourceUnit?: number
  readonly budget: UvmContainerBudget
  /** The model's PopcornFX emitters baked (popcorn.ts), written as UV_game_baked_particles. */
  readonly popcorn?: War3PopcornBake
  readonly signal?: AbortSignal
}

const FORMAT_RESIDUAL_NAMESPACE = 'BlizzardMDX'

/** Restate native-backed facets and resource roles for the common UVM materializer. */
function projectionOf(model: RenderModel, native: Readonly<Record<string, unknown>>, popcorn?: War3PopcornBake): ModelProjection {
  const references = [
    ...war3ResourceReferences(model, native),
    ...(popcorn?.batches ?? []).map(batch => ({ id: batch.texture, role: 'texture' as const })),
  ].filter((reference, index, all) => all.findIndex(other => other.id === reference.id && other.role === reference.role) === index)
  const materials = [
    ...war3Materials(model),
    ...war3EmitterMaterials(model),
    ...(popcorn?.batches ?? []).map(batch =>
      war3SpriteMaterial(batch.materialId, batch.name, batch.texture, {
        blendMode: batch.blendMode,
        priority: 0,
        alphaTestThreshold: 4 / 255,
        metadata: { source: 'war3', emitter: 'popcorn' },
        teamColor: batch.teamColored,
      }),
    ),
  ]
  // exportWar3Uvm rebases the z-up scene itself; with upAxis the materializer would turn it again.
  const { upAxis: _upAxis, ...info } = war3SceneInfo(model, references.filter(reference => reference.role === 'texture').length)
  return {
    // The projection carries one material per emitter that names only a texture, so its declared
    // count is the projection's own, not the native material count the inspect facet reports.
    info: { ...info, materials: materials.length },
    nodes: war3SceneNodes(model),
    meshes: war3SceneMeshes(model),
    primitives: war3ScenePrimitives(model),
    materials,
    skeleton: war3SkeletonBindings(model),
    animations: war3AnimationClips(model),
    ...(war3LodLevels(model).length === 0 ? {} : { lods: war3LodLevels(model) }),
    resourceClosure: {
      mode: 'logical',
      entries: references.map(reference => ({
        role: reference.role,
        logicalId: reference.id,
      })),
    },
    // Sprites in the root node's frame, which the rebase below turns into metres and +y up.
    ...(popcorn === undefined || popcorn.tracks.length === 0
      ? {}
      : {
          bakedParticles: {
            spaceNodeId: WAR3_ROOT_NODE_ID,
            frameRate: popcorn.frameRate,
            batches: popcorn.batches.map(batch => ({
              name: batch.name,
              materialId: batch.materialId,
              orientation: batch.orientation,
              atlas: batch.atlas,
            })),
            tracks: popcorn.tracks,
          },
        }),
  }
}

const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

interface EmitterTrack {
  readonly lineType: number
  readonly globalSeqId: number | null
  readonly keys: readonly {
    readonly frame: number
    readonly vector: readonly number[]
    readonly inTan?: readonly number[]
    readonly outTan?: readonly number[]
  }[]
}

/**
 * An emitter's tracks cut at the model's sequence intervals and rebased to each sequence's start,
 * still in milliseconds: the sequence-local `sequenceAnimation` form StarCraft II publishes and
 * UVM clips use. Warcraft III keeps one track across the whole timeline, which a clip cannot
 * address. A global-sequence track runs on its own clock in every sequence: each sequence gets the
 * whole track as a concurrent one that wraps at the global sequence's length. A global sequence
 * the model does not size is reported and the emitter keeps its static value.
 */
function sequenceAnimationOf(
  animation: unknown,
  sequences: RenderModel['animations'],
  globalSequences: readonly unknown[],
  label: string,
  notes: string[],
): JsonObject | undefined {
  if (typeof animation !== 'object' || animation === null) return undefined
  const out: Record<string, JsonValue> = {}
  for (const [property, track] of Object.entries(
    animation as Readonly<Record<string, EmitterTrack | undefined>>,
  )) {
    if (track === undefined) continue
    if (track.globalSeqId !== null) {
      const length = globalSequences[track.globalSeqId]
      if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) {
        notes.push(
          `${label}.${property} runs on global sequence ${String(track.globalSeqId)}, which has no length; ` +
            'the static value stands',
        )
        continue
      }
      const keys = track.keys.map(key => ({
        frame: key.frame,
        vector: [...key.vector],
        ...(key.inTan === undefined ? {} : { inTan: [...key.inTan] }),
        ...(key.outTan === undefined ? {} : { outTan: [...key.outTan] }),
      }))
      out[property] = sequences.map((_, sequenceIndex) => ({
        sequenceIndex,
        track: { lineType: track.lineType, globalSeqId: null, keys },
        concurrent: true,
        wrapSeconds: length / 1000,
      }))
      continue
    }
    const perSequence: JsonValue[] = []
    for (const [sequenceIndex, sequence] of sequences.entries()) {
      const start = sequence.startFrame ?? 0
      const end = sequence.endFrame ?? start
      const keys = track.keys
        .filter(key => key.frame >= start && key.frame <= end)
        .map(key => ({
          frame: key.frame - start,
          vector: [...key.vector],
          ...(key.inTan === undefined ? {} : { inTan: [...key.inTan] }),
          ...(key.outTan === undefined ? {} : { outTan: [...key.outTan] }),
        }))
      if (keys.length > 0)
        perSequence.push({
          sequenceIndex,
          track: { lineType: track.lineType, globalSeqId: null, keys },
        })
    }
    if (perSequence.length > 0) out[property] = perSequence
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Emitters, in the shape `UV_game_effects` already declares, under the `mdx` profile the common
 * validator has always accepted. Node and material references are remapped to the indices the
 * materializer actually emitted; nothing is resolved against a name.
 *
 * The fields are the common vocabulary `buildEffects` already normalises to, at the top level
 * where the extension declares them. They used to sit under a private `native` object that the
 * schema does not allow and that no reader - the scene, this package's writer, the M3 exporter -
 * looked into, so every Warcraft III emitter crossed UVM with no width, speed or rate.
 */
function effectsExtension(
  model: RenderModel,
  nodeBindings: Readonly<Record<string, number>>,
  materialBindings: Readonly<Record<string, number>>,
  rootNode: number,
  notes: string[],
): JsonObject | undefined {
  const emitters = war3Emitters(model)
  if (emitters.length === 0) return undefined
  const entries: Record<string, JsonValue[]> = {}
  for (const emitter of emitters) {
    const nodeKey = war3EmitterNodeKey(emitter)
    const materialKey = war3EmitterMaterialKey(emitter)
    const material = materialKey === undefined ? undefined : materialBindings[materialKey]
    // Both joins are required by the extension. An emitter that resolves neither is reported
    // rather than attached with an invented index.
    if (material === undefined) continue
    const node = nodeKey === undefined ? undefined : nodeBindings[nodeKey]
    const list = entries[emitter.kind] ?? (entries[emitter.kind] = [])
    // Render-model indices are replaced by the UVM joins below; the tracks become sequence-local.
    const {
      name: nativeName,
      boneIndex: _boneIndex,
      materialIndex: _materialIndex,
      animation,
      ...fields
    } = emitter.record
    const name =
      typeof nativeName === 'string' && nativeName !== ''
        ? nativeName
        : `${emitter.kind}-${String(emitter.index)}`
    const ribbonColors = model.metadata?.['war3RibbonColorTracks']
    const ribbonColor = emitter.kind === 'ribbons' && Array.isArray(ribbonColors)
      ? ribbonColors.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null &&
          (candidate as Record<string, unknown>)['index'] === emitter.index) as Record<string, unknown> | undefined
      : undefined
    const sequenceAnimation = sequenceAnimationOf(
      ribbonColor === undefined ? animation : { ...(animation as object | undefined), color: ribbonColor['track'] },
      model.animations,
      Array.isArray(model.metadata?.['war3GlobalSequences']) ? model.metadata['war3GlobalSequences'] : [],
      `${emitter.kind}/${name}`,
      notes,
    )
    list.push({
      ...(fields as JsonObject),
      name,
      // Without its own node the emitter belongs to the model root: a statement about this
      // document, not a guess about the native one.
      node: node ?? rootNode,
      material,
      ...(sequenceAnimation === undefined ? {} : { sequenceAnimation }),
    } satisfies JsonValue)
  }
  if (Object.keys(entries).length === 0) return undefined
  return { profile: 'mdx', trackTimeUnit: 'milliseconds', spaceNode: rootNode, ...entries }
}

/**
 * Mark the nodes that are attachment points and collision volumes.
 *
 * Warcraft III writes both as ordinary nodes, so they are already in the scene with their own
 * transforms; what common glTF has no word for is *which* nodes they are. Annotating them in
 * place, rather than adding a parallel child per volume, keeps the node list the one the model
 * declared - so a writer rebuilds the same file and does not have to strip duplicates.
 *
 * A node that can be named is annotated; one the projection did not emit is left alone rather
 * than attached to a guessed index.
 */
function withSpatialMetadata(
  container: UvmContainer,
  model: RenderModel,
  nodeBindings: Readonly<Record<string, number>>,
  notes: string[],
): UvmContainer {
  const document = container.document
  const nodes = (Array.isArray(document['nodes']) ? document['nodes'] : []).map(node =>
    typeof node === 'object' && node !== null && !Array.isArray(node)
      ? { ...(node as JsonObject) }
      : node,
  )
  const annotate = (index: number | undefined, name: string, value: JsonObject): boolean => {
    const node = index === undefined ? undefined : nodes[index]
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
    const target = node as Record<string, JsonValue>
    const existing =
      typeof target['extensions'] === 'object' &&
      target['extensions'] !== null &&
      !Array.isArray(target['extensions'])
        ? (target['extensions'] as JsonObject)
        : {}
    target['extensions'] = { ...existing, [name]: value }
    return true
  }

  const used = new Set<string>()
  const roleOrdinals = new Map<string, number>()
  for (const socket of war3Sockets(model)) {
    const index = socket.ownNodeId === undefined ? undefined : nodeBindings[socket.ownNodeId]
    const ordinal = roleOrdinals.get(socket.role) ?? 0
    const written = annotate(index, 'UV_game_socket', {
      role: socket.role,
      index: ordinal,
      sourceName: socket.sourceName,
      extras: { modkit: { id: socket.id, nodeId: `node-${String(index ?? 0)}` } },
    })
    if (written) {
      roleOrdinals.set(socket.role, ordinal + 1)
      used.add('UV_game_socket')
    } else notes.push(`attachment ${socket.sourceName} has no node in the common scene`)
  }

  for (const volume of war3Collisions(model)) {
    const index = volume.ownNodeId === undefined ? undefined : nodeBindings[volume.ownNodeId]
    if (volume.shape === undefined) {
      notes.push(`collision volume ${volume.id} has no finite extent and was not published`)
      continue
    }
    // Warcraft III collision shapes are the model's hit volumes; that is the UV role for them.
    if (annotate(index, 'UV_game_collision', { role: 'hit', shapes: [volume.shape] }))
      used.add('UV_game_collision')
    else notes.push(`collision volume ${volume.id} has no node in the common scene`)
  }

  if (used.size === 0) return container
  const declared = Array.isArray(document['extensionsUsed'])
    ? (document['extensionsUsed'] as JsonValue[])
    : []
  return {
    ...container,
    document: {
      ...document,
      nodes: nodes as JsonValue[],
      extensionsUsed: [...new Set([...declared.map(String), ...used])],
    },
  }
}

/**
 * State the unit the document is in.
 *
 * Warcraft III world units have no declared metre length, so the caller's `metersPerSourceUnit`
 * is the only thing that says what one unit means - and a target that has to rescale, like the
 * StarCraft II writer, refuses a document that says nothing. Declaring it is what makes this a
 * complete statement rather than a number the next tool has to guess.
 */
function withUnits(container: UvmContainer, metersPerSourceUnit: number): UvmContainer {
  const document = container.document
  const existing =
    document['extensions'] === undefined
      ? {}
      : (document['extensions'] as Readonly<Record<string, JsonValue>>)
  if (existing['UV_units'] !== undefined) return container
  const declared = Array.isArray(document['extensionsUsed'])
    ? (document['extensionsUsed'] as JsonValue[])
    : []
  return {
    ...container,
    document: {
      ...document,
      extensions: {
        ...existing,
        UV_units: { sourceUnit: 'war3-world-unit', metersPerSourceUnit },
      },
      extensionsUsed: declared.includes('UV_units') ? declared : [...declared, 'UV_units'],
    },
  }
}

function withEffects(container: UvmContainer, extension: JsonObject | undefined): UvmContainer {
  if (extension === undefined) return container
  const document = container.document
  const existing =
    document['extensions'] === undefined
      ? {}
      : (document['extensions'] as Readonly<Record<string, JsonValue>>)
  const declared = Array.isArray(document['extensionsUsed'])
    ? (document['extensionsUsed'] as JsonValue[])
    : []
  return {
    ...container,
    document: {
      ...document,
      extensions: { ...existing, UV_game_effects: extension },
      extensionsUsed: declared.includes('UV_game_effects')
        ? declared
        : [...declared, 'UV_game_effects'],
    },
  }
}

/**
 * Reconstruction facts common glTF cannot hold.
 *
 * Geometry, skin, materials and motion live in the common structures; what stays here are the
 * native records a writer cannot rebuild from them — the chunk-level declarations of the document.
 * Source bytes are deliberately absent: this is a record of what the document said, not a second
 * copy of it.
 */
function residualOf(
  native: Readonly<Record<string, unknown>>,
  encoding: 'mdx' | 'mdl',
  budget: UvmContainerBudget,
  signal?: AbortSignal,
): JsonObject {
  // The parser hands back typed arrays; JSON keeps numbers. Converting here rather than at each
  // call site means no native record reaches the snapshot in a shape it would refuse.
  const plain = (value: unknown): JsonValue => {
    // Typed-array contents are sanitised too: a non-finite float reaching the snapshot is
    // rejected there, and a residual that cannot be written is a lost conversion.
    if (ArrayBuffer.isView(value))
      return Array.from(value as unknown as ArrayLike<number>, item =>
        Number.isFinite(item) ? item : 0,
      )
    if (Array.isArray(value)) return value.map(plain)
    if (value === null || value === undefined) return null
    if (typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plain(item)]),
      )
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    if (typeof value === 'string' || typeof value === 'boolean') return value
    return null
  }
  const snapshot = (value: unknown): JsonValue =>
    snapshotJson(
      plain(value),
      { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxJsonBytes },
      signal,
    )
  const info = (native['Info'] ?? {}) as Record<string, unknown>
  const geosets = Array.isArray(native['Geosets']) ? native['Geosets'] : []
  return {
    encoding,
    formatVersion: numberOf(native['Version']) ?? 800,
    info: snapshot(info),
    textures: snapshot(native['Textures'] ?? []),
    materials: snapshot(native['Materials'] ?? []),
    sequences: snapshot(native['Sequences'] ?? []),
    globalSequences: snapshot(native['GlobalSequences'] ?? []),
    // Nodes carry their own animation tracks, which is how motion that glTF TRS cannot state
    // (Hermite, Bezier, global-sequence clocks) survives the round trip.
    nodes: snapshot(native['Nodes'] ?? []),
    pivotPoints: snapshot(native['PivotPoints'] ?? []),
    bones: snapshot(
      (Array.isArray(native['Bones']) ? native['Bones'] : []).map(bone => ({
        objectId: (bone as Record<string, unknown>)['ObjectId'],
        geosetId: (bone as Record<string, unknown>)['GeosetId'] ?? null,
        geosetAnimId: (bone as Record<string, unknown>)['GeosetAnimId'] ?? null,
      })),
    ),
    // Everything about a geoset except its buffers, which the common geometry already carries.
    geosets: snapshot(
      geosets.map(geoset => {
        const record = geoset as Record<string, unknown>
        return {
          materialId: record['MaterialID'] ?? 0,
          selectionGroup: record['SelectionGroup'] ?? 0,
          unselectable: record['Unselectable'] === true,
          minimumExtent: record['MinimumExtent'] ?? [],
          maximumExtent: record['MaximumExtent'] ?? [],
          boundsRadius: record['BoundsRadius'] ?? 0,
          anims: record['Anims'] ?? [],
          ...(record['Name'] === undefined ? {} : { name: record['Name'] }),
        }
      }),
    ),
    geosetAnims: snapshot(native['GeosetAnims'] ?? []),
    attachments: snapshot(native['Attachments'] ?? []),
    collisionShapes: snapshot(native['CollisionShapes'] ?? []),
    eventObjects: snapshot(native['EventObjects'] ?? []),
    cameras: snapshot(native['Cameras'] ?? []),
    lights: snapshot(native['Lights'] ?? []),
    textureAnims: snapshot(native['TextureAnims'] ?? []),
    particleEmitters: snapshot(native['ParticleEmitters'] ?? []),
    particleEmitters2: snapshot(native['ParticleEmitters2'] ?? []),
    ribbonEmitters: snapshot(native['RibbonEmitters'] ?? []),
    ...(native['ParticleEmitterPopcorns'] === undefined
      ? {}
      : { particleEmitterPopcorns: snapshot(native['ParticleEmitterPopcorns']) }),
    ...(native['FaceFX'] === undefined ? {} : { faceFX: snapshot(native['FaceFX']) }),
    ...(native['BindPoses'] === undefined ? {} : { bindPoses: snapshot(native['BindPoses']) }),
  }
}

/** Report native HD material facts that the current common material vocabulary cannot execute. */
function materialRemainders(native: Readonly<Record<string, unknown>>, signal?: AbortSignal): string[] {
  const notes: string[] = []
  if (!Array.isArray(native['Materials'])) return notes
  for (const [materialIndex, material] of native['Materials'].entries()) {
    signal?.throwIfAborted()
    if (typeof material !== 'object' || material === null || !Array.isArray(material.Layers)) continue
    for (const [layerIndex, layer] of material.Layers.entries()) {
      signal?.throwIfAborted()
      if (typeof layer !== 'object' || layer === null) continue
      const label = `material ${String(materialIndex)} layer ${String(layerIndex)}`
      const gain = layer.EmissiveGain
      if (typeof gain === 'object' && gain !== null && Array.isArray(gain.Keys))
        notes.push(`${label} animated EmissiveGain (KMTE) is retained in the native residual only; common material playback uses a constant gain`)
      const fresnel = ['FresnelColor', 'FresnelOpacity', 'FresnelTeamColor'].filter(field => layer[field] !== undefined)
      if (fresnel.length > 0)
        notes.push(`${label} ${fresnel.join('/')} is retained in the native residual only; WC3 HD Fresnel has no qualified common material projection`)
    }
  }
  return notes
}

/** Export common facets with native reconstruction records and explicit unprojected semantics. */
export function exportWar3Uvm(
  model: RenderModel,
  native: Readonly<Record<string, unknown>>,
  encoding: 'mdx' | 'mdl',
  options: War3UvmOptions,
): { readonly bytes: Uint8Array; readonly effects: boolean; readonly notes: readonly string[] } {
  // JSON residual normalization must not erase an unsupported native header before writer admission.
  admitWar3MaterialHeaders(native, 'mdx', options.signal)
  const scale = options.metersPerSourceUnit ?? 1
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('invalid metres per source unit')
  // Facet snapshots are charged in JSON bytes; the container budget counts the whole document.
  const facetBudget = {
    maxDepth: options.budget.maxDepth,
    maxNodes: options.budget.maxNodes,
    maxBytes: options.budget.maxJsonBytes,
  }
  const projection = projectionOf(model, native, options.popcorn)
  // Animation is charged by its own size, as the codec's animation source is: an HD model's keys
  // (Reforged's Grunt) exceed a budget the rest of the model fits in.
  const clipBudget = animationSnapshotBudget(projection.animations ?? [])
  const materialized = materializeUvmCore(
    projection,
    {
      scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
      profile: 'UVM/core@1.0',
      subjectRevision: options.subjectRevision,
      options: { assetId: options.assetId, sourceFormat: `war3-${encoding}` },
    },
    {
      materialBudget: facetBudget,
      skeletonBudget: facetBudget,
      animationBudget: {
        maxDepth: Math.max(facetBudget.maxDepth, clipBudget.maxDepth),
        maxNodes: Math.max(facetBudget.maxNodes, clipBudget.maxNodes),
        maxBytes: Math.max(facetBudget.maxBytes, clipBudget.maxBytes),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  const root = materialized.bindings.nodes[WAR3_ROOT_NODE_ID]
  if (root === undefined) throw new TypeError('the Warcraft III root node was not materialized')
  const container = readUvmContainer(materialized.bytes, options.budget, options.signal)
  const effectNotes: string[] = []
  if (Array.isArray(native['RibbonEmitters'])) for (const [index, candidate] of native['RibbonEmitters'].entries()) {
    const gravity = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>)['Gravity'] : undefined
    if (typeof gravity === 'number' && Number.isFinite(gravity) && gravity !== 0)
      effectNotes.push(`ribbon ${String(index)} gravity is retained in the native residual only; its common-frame direction is not qualified`)
  }
  const extension = effectsExtension(
    model,
    materialized.bindings.nodes,
    materialized.bindings.materials,
    root,
    effectNotes,
  )
  // Warcraft III is z-up like StarCraft II, so the same single shared-root rebase applies. A second
  // rotation for a guessed facing direction is not added.
  const spatialNotes: string[] = []
  const rebased = rebaseUvmScene(
    withSpatialMetadata(
      withUnits(withEffects(container, extension), scale),
      model,
      materialized.bindings.nodes,
      spatialNotes,
    ),
    [scale, 0, 0, 0, 0, 0, -scale, 0, 0, scale, 0, 0, 0, 0, 0, 1],
    options.budget,
    options.signal,
  )
  // The residual keeps the nodes' own animation tracks, as large as the clips: the document that
  // carries it is charged the model's budget plus theirs.
  const residualBudget = {
    ...options.budget,
    maxNodes: options.budget.maxNodes + clipBudget.maxNodes,
    maxJsonBytes: options.budget.maxJsonBytes + clipBudget.maxBytes,
  }
  const withResidual = attachUvmFormatResidual(
    rebased,
    {
      namespace: FORMAT_RESIDUAL_NAMESPACE,
      format: 'war3-mdx',
      profile: `war3-${encoding}@1`,
      residual: residualOf(native, encoding, residualBudget, options.signal),
      // The materializer's own source-id -> emitted-index maps, kept so a writer never has to
      // reconstruct the emission order by guessing at names.
      mapping: {
        nodes: materialized.bindings.nodes as JsonValue,
        meshes: materialized.bindings.meshes as JsonValue,
        materials: materialized.bindings.materials as JsonValue,
      },
    },
    residualBudget,
    options.signal,
  )
  return {
    bytes: writeUvmContainer(withResidual, residualBudget, options.signal),
    effects: extension !== undefined,
    // What the profile could not carry, in the materializer's own words. Hermite and Bezier tracks
    // travel as CUBICSPLINE; a track whose tangents are missing lands here instead, and its clip
    // stays selectable through UV_game_animation_clips without a resampled curve invented for it.
    notes: [
      ...materialized.receipt.diff
        .filter(entry => entry.facetId.startsWith('common.view/model-') || entry.facetId === 'uv.model/resource-closure@1')
        .map(entry => `${entry.path}: ${entry.note}`),
      ...effectNotes,
      ...materialRemainders(native, options.signal),
      ...spatialNotes,
      ...(options.popcorn?.notes ?? []),
    ],
  }
}
