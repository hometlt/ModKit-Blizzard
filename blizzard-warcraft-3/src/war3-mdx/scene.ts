/**
 * Warcraft III model -> MK3 model facets.
 *
 * The decode itself is the ported MK2 implementation over the vendored war3-model parser; this
 * module only restates its `RenderModel` in the common facet vocabulary. It invents nothing: a
 * bone without a pivot keeps an identity transform rather than a guessed one, and a texture slot
 * without a path publishes no resource reference. All four supported UV sets cross the common
 * geometry facet; layer CoordId selects the authored set, and HD baked AO selects UV1 by flag.
 * ATCH/PRE1 model paths publish reference-only sidecars, without resolving or spawning them.
 * PRE2 SortPrimsFarZ/Unfogged remain native material metadata, not a runtime sorting/fog claim.
 */
import type {
  RenderAnimation,
  RenderBone,
  RenderMaterial,
  RenderMesh,
  RenderModel,
  RenderTextureLayer,
} from '@modkit/codec-kit/legacy/models'
import type { model as War3 } from '../lib/war3-model/index.js'

/** MDX pivot points are absolute; a node's local transform is its offset from its parent's pivot. */
interface War3Node {
  readonly index: number
  readonly name: string
  readonly parentIndex: number
  readonly pivot: readonly [number, number, number]
  readonly flags: number
  readonly animation?: War3NodeAnimation
  readonly eventTrack?: { readonly frames: readonly number[]; readonly globalSeqId: number | null }
}

interface War3AnimationKey {
  readonly frame: number
  readonly vector: readonly number[]
  /** Hermite: the tangent over the key interval; Bezier: the control point. Line types 2 and 3 only. */
  readonly inTan?: readonly number[]
  readonly outTan?: readonly number[]
}
interface War3AnimationTrack {
  readonly lineType: number
  readonly globalSeqId: number | null
  readonly keys: readonly War3AnimationKey[]
}
interface War3NodeAnimation {
  readonly translation?: War3AnimationTrack
  readonly rotation?: War3AnimationTrack
  readonly scaling?: War3AnimationTrack
}

export const WAR3_ROOT_NODE_ID = 'war3-root'

const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

const finiteTriple = (value: unknown): value is readonly [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(item => Number.isFinite(item))

function readWar3Nodes(model: RenderModel): readonly War3Node[] {
  const metadata = model.metadata
  const raw = metadata === undefined ? undefined : metadata['war3Nodes']
  if (!Array.isArray(raw)) return []
  const nodes: War3Node[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const index = record['index'],
      parentIndex = record['parentIndex'],
      pivot = record['pivot'],
      name = record['name'],
      flags = record['flags']
    if (!Number.isSafeInteger(index) || (index as number) < 0) continue
    if (!finiteTriple(pivot)) continue
    nodes.push({
      index: index as number,
      name: typeof name === 'string' ? name : `Node_${String(index)}`,
      parentIndex: Number.isSafeInteger(parentIndex) ? (parentIndex as number) : -1,
      pivot,
      flags: Number.isFinite(flags) ? (flags as number) : 0,
      ...(isNodeAnimation(record['animation']) ? { animation: record['animation'] } : {}),
      ...(isEventTrack(record['eventTrack']) ? { eventTrack: record['eventTrack'] } : {}),
    })
  }
  return nodes
}

const isEventTrack = (value: unknown): value is NonNullable<War3Node['eventTrack']> => {
  if (typeof value !== 'object' || value === null) return false
  const track = value as Record<string, unknown>
  return (
    Array.isArray(track['frames']) &&
    track['frames'].every(frame => Number.isFinite(frame)) &&
    (track['globalSeqId'] === null || Number.isSafeInteger(track['globalSeqId']))
  )
}

/**
 * What an event object does, by the kind its name starts with (mdx-m3-viewer
 * `eventobjectemitterobject.ts`, WhiteoutFlakes `DecodeEventKind`): SND a sound, SPN a spawned
 * model, SPL a ground splat, UBR an uber splat, FPT a footprint (a splat). The fourth character is a
 * free tag (`SNDx…`, `UBRa…`); what follows it names the row of the game's table
 * (`UI/SoundInfo/AnimSounds.slk`, `Splats/SpawnData.slk`, `SplatData.slk`, `UberSplatData.slk`).
 */
function eventPayload(name: string): { kind: string; code: string } | undefined {
  const trimmed = name.trim()
  const kind = /^(SND|SPN|SPL|UBR|FPT)/iu.exec(trimmed)?.[1]?.toUpperCase()
  const code = trimmed.slice(4)
  return kind === undefined || code === '' ? undefined : { kind, code }
}

/** At most this many events per clip: a long sequence over a short global cycle. */
const WAR3_MAX_CLIP_EVENTS = 4096

/**
 * The events an event object fires in the sequence [start, end] (KEVT): each key inside the
 * sequence, in seconds from its start; a track on a global sequence fires at its keys every cycle
 * from the sequence's start. The event happens at the object's node; its kind and table row ride in
 * the payload, for a player that knows the game's tables.
 */
function war3ClipEvents(
  nodes: readonly War3Node[],
  start: number,
  end: number,
  globalSequences: readonly unknown[],
) {
  const events: { timeSeconds: number; name: string; nodeId: string; payload?: { kind: string; code: string } }[] = []
  for (const node of nodes) {
    const track = node.eventTrack
    if (track === undefined) continue
    const payload = eventPayload(node.name)
    const fire = (frame: number) => {
      if (events.length < WAR3_MAX_CLIP_EVENTS)
        events.push({ timeSeconds: (frame - start) / 1000, name: node.name, nodeId: nodeId(node.index), ...(payload === undefined ? {} : { payload }) })
    }
    if (track.globalSeqId === null) {
      for (const frame of track.frames) if (frame >= start && frame <= end) fire(frame)
      continue
    }
    const length = finiteNumber(globalSequences[track.globalSeqId])
    if (length === undefined || !(length > 0)) continue
    for (let cycle = start; cycle <= end && events.length < WAR3_MAX_CLIP_EVENTS; cycle += length)
      for (const frame of track.frames) if (cycle + frame <= end) fire(cycle + frame)
  }
  return events.sort((left, right) => left.timeSeconds - right.timeSeconds)
}

const isTrack = (value: unknown): value is War3AnimationTrack => {
  if (typeof value !== 'object' || value === null) return false
  const track = value as Record<string, unknown>
  return (
    Number.isFinite(track['lineType']) &&
    Array.isArray(track['keys']) &&
    track['keys'].every(
      key =>
        typeof key === 'object' &&
        key !== null &&
        Number.isFinite((key as Record<string, unknown>)['frame']) &&
        Array.isArray((key as Record<string, unknown>)['vector']),
    )
  )
}

const isNodeAnimation = (value: unknown): value is War3NodeAnimation => {
  if (typeof value !== 'object' || value === null) return false
  const animation = value as Record<string, unknown>
  return ['translation', 'rotation', 'scaling'].every(
    key => animation[key] === undefined || isTrack(animation[key]),
  )
}

const nodeId = (index: number): string => `war3-node-${String(index)}`

/** The scene id of a native node index, for callers outside this module. */
export const war3NodeId = (index: number): string => nodeId(index)

/**
 * A fully billboarded node's camera rule: mdx-m3-viewer's `mdx/node.ts` convertBasis — rotateY(-π/2),
 * then rotateX(-π/2) — which turns the node's +X, the card's face, toward the viewer, its Z upright.
 */
export const WAR3_BILLBOARD = Object.freeze({
  mode: 'inverse-camera' as const,
  // quatFromAxisAngle's sin(π/4) and cos(π/4), as M3 pins its own (they differ in the last bit).
  basisRotations: Object.freeze([
    Object.freeze([0, -Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] as const),
    Object.freeze([-Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)] as const),
  ]),
})

/**
 * An axis-locked billboard's camera rule (flags 0x10, 0x20, 0x40): mdx-m3-viewer's `skeletalnode.ts`
 * turns the node about its locked axis until its local Y (lock X) or X (locks Y and Z) points to the
 * viewer — an `aim` at the view direction d with that axis kept, the other one along −d by the
 * correction. Exact where the node's parents and own rotation leave its axes as authored; the
 * viewer's mirror of a lock-X node's Z (Warsmash) is not reproduced.
 */
const half = Math.SQRT1_2
const WAR3_LOCKED_BILLBOARDS = Object.freeze(
  ([
    [0x10, 'frame-x', [1, 0, 0, 0]],
    [0x20, 'frame-y', [0, 1, 0, 0]],
    [0x40, 'frame-z', [0, 0, -half, half]],
  ] as const).map(([flag, lock, correction]) =>
    Object.freeze({ flag, billboard: Object.freeze({ mode: 'aim' as const, aim: 'view' as const, lock, correction, rootCorrection: correction }) }),
  ),
)

/** A node's camera rule from its flags, as a `ModelNode` fragment: full (0x8) first, then the axis-locked kinds. */
const war3Billboard = (flags: number) => {
  const billboard = (flags & 0x8) !== 0 ? WAR3_BILLBOARD : WAR3_LOCKED_BILLBOARDS.find(item => (flags & item.flag) !== 0)?.billboard
  return billboard === undefined ? {} : { billboard }
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const meshId = (index: number): string => `war3-geoset-${String(index)}`
const geosetNodeId = (index: number): string => `war3-geoset-node-${String(index)}`
const primitiveId = (index: number): string => `war3-geoset-${String(index)}-primitive`
const materialId = (index: number): string => `war3-material-${String(index)}`
const emitterMaterialId = (kind: string, index: number): string =>
  `war3-${kind}-material-${String(index)}`

type EmitterKind = 'particles' | 'ribbons'
const EMITTER_KINDS: readonly EmitterKind[] = ['particles', 'ribbons']

interface War3Emitter {
  readonly kind: EmitterKind
  readonly index: number
  readonly record: Readonly<Record<string, unknown>>
  readonly nodeIndex: number | undefined
  readonly materialIndex: number | undefined
  readonly texturePath: string | undefined
  /** The model each particle is, for a version 1 emitter. */
  readonly modelPath: string | undefined
}

/** Emitters as this codec decoded them, with the two joins a UVM effect needs resolved. */
export function war3Emitters(model: RenderModel): readonly War3Emitter[] {
  const effects = model.effects
  if (effects === undefined) return []
  const out: War3Emitter[] = []
  for (const kind of EMITTER_KINDS) {
    const source = effects[kind]
    if (source === undefined) continue
    for (const [index, emitter] of source.entries()) {
      const record = emitter as unknown as Readonly<Record<string, unknown>>
      const nodeIndex = record['boneIndex']
      const materialIndex = record['materialIndex']
      const texturePath = record['texturePath']
      const modelPaths = record['modelPaths']
      const modelPath = Array.isArray(modelPaths) && typeof modelPaths[0] === 'string' ? modelPaths[0] : undefined
      out.push({
        kind,
        index,
        record,
        nodeIndex:
          Number.isSafeInteger(nodeIndex) && (nodeIndex as number) >= 0
            ? (nodeIndex as number)
            : undefined,
        materialIndex:
          Number.isSafeInteger(materialIndex) && (materialIndex as number) >= 0
            ? (materialIndex as number)
            : undefined,
        texturePath:
          typeof texturePath === 'string' && texturePath !== '' ? texturePath : undefined,
        modelPath,
      })
    }
  }
  return out
}

/**
 * A UVM effect must name a material, and a Warcraft III emitter names a texture instead. This
 * publishes one material per such emitter, carrying that texture and nothing invented. Emitters
 * that do reference a native material keep it. A model particle draws its model's own materials;
 * its emitter's material is white and textureless, there only for the join.
 */
export function war3EmitterMaterials(model: RenderModel) {
  return war3Emitters(model)
    .filter(
      emitter =>
        emitter.materialIndex === undefined &&
        (emitter.texturePath !== undefined || emitter.modelPath !== undefined),
    )
    .map(emitter => {
      const filterMode = finiteNumber(emitter.record['filterMode']) ?? 0
      const nativeMaterials = model.metadata?.['war3ParticleMaterials']
      const native = emitter.kind === 'particles' && Array.isArray(nativeMaterials)
        ? nativeMaterials.find((candidate: unknown) => typeof candidate === 'object' && candidate !== null &&
          (candidate as Record<string, unknown>)['index'] === emitter.index) as Record<string, unknown> | undefined
        : undefined
      const replaceableId = finiteNumber(native?.['replaceableId']) ?? 0
      return war3SpriteMaterial(
        emitterMaterialId(emitter.kind, emitter.index),
        typeof emitter.record['name'] === 'string' && emitter.record['name'] !== ''
          ? (emitter.record['name'] as string)
          : `${emitter.kind} ${String(emitter.index)}`,
        emitter.texturePath,
        {
          blendMode: WAR3_EMITTER_BLEND[filterMode] ?? 1,
          priority: finiteNumber(native?.['priorityPlane']) ?? finiteNumber(emitter.record['priorityPlane']) ?? 0,
          alphaTestThreshold: filterMode === 4 ? 0.75 : 4 / 255,
          metadata: { source: 'war3', emitter: emitter.kind, emitterIndex: emitter.index, filterMode, replaceableId,
            ...(typeof native?.['sortPrimsFarZ'] === 'boolean' ? { sortPrimsFarZ: native['sortPrimsFarZ'] ? 1 : 0 } : {}),
            ...(typeof native?.['unfogged'] === 'boolean' ? { unfogged: native['unfogged'] ? 1 : 0 } : {}),
          },
          teamColor: replaceableId === 1 || replaceableId === 2,
          ...(typeof native?.['unshaded'] === 'boolean' ? { unshaded: native['unshaded'] } : {}),
        },
      )
    })
}

/**
 * A sprite's material: its texture under a blend (render-material numbering: 1 blend, 3 additive,
 * 4 modulate, 5 modulate 2x), unlit and two-sided, coloured and faded by the sprite's colour, which
 * reaches it as the vertex colour, and with `teamColor` multiplied by the player's colour. Emitters
 * and baked PopcornFX batches (popcorn.ts) draw with it.
 */
export function war3SpriteMaterial(
  id: string,
  name: string,
  texturePath: string | undefined,
  pass: {
    readonly blendMode: number
    readonly priority: number
    readonly alphaTestThreshold: number
    readonly metadata: Readonly<Record<string, string | number>>
    /** Multiply the sprite by the player's colour: an `emissive1` layer of the team colour, op 0. */
    readonly teamColor?: boolean
    /** PRE2 lighting is native; baked particles and legacy callers remain unlit by default. */
    readonly unshaded?: boolean
  },
) {
  return {
    id,
    name,
    layers: texturePath === undefined ? [] : [{ slot: 'diffuse', resourceId: texturePath }],
    shader: {
      id: 'modkit.render-material.v1',
      parameters: {
        renderModel: {
          version: 1,
          layers: texturePath === undefined ? [] : [{ label: 'diffuse', path: texturePath }],
          standard: {
            layers: {
              diffuse: {
                slot: 'diffuse',
                texturePath: texturePath ?? null,
                ...(texturePath === undefined ? { constantColor: { value: [1, 1, 1, 1] } } : {}),
                uvSource: 0,
                channels: 1,
                op: 6,
                teamColorMode: 0,
                invert: false,
                clampResult: false,
                wrapX: false,
                wrapY: false,
              },
              ...(pass.teamColor === true
                ? {
                    emissive1: {
                      slot: 'emissive1',
                      texturePath: null,
                      // alpha 0: teamColorMode 1 takes the team colour whole; op 0 multiplies the colour by it
                      constantColor: { value: [1, 1, 1, 0] },
                      uvSource: 0,
                      channels: 1,
                      op: 0,
                      teamColorMode: 1,
                      invert: false,
                      clampResult: false,
                      wrapX: false,
                      wrapY: false,
                    },
                  }
                : {}),
            },
            blendMode: pass.blendMode,
            priority: pass.priority,
            specularity: 0,
            specMult: 0,
            emisMult: 0,
            specMode: 0,
            alphaTestThreshold: pass.alphaTestThreshold,
            twoSided: true,
            unshaded: pass.unshaded ?? true,
            doubleLambert: false,
            clampOutput: true,
            usesVertexColor: true,
            usesVertexAlpha: true,
          },
          metadata: pass.metadata,
        },
      },
    },
  }
}

/**
 * ParticleEmitter2 filter mode → common blend (mdx-m3-viewer `emitterFilterMode`): Blend, Additive
 * (SRC_ALPHA, ONE), Modulate, Modulate2x, and AlphaKey — blended over a 0.75 alpha key.
 */
const WAR3_EMITTER_BLEND = Object.freeze([1, 3, 4, 5, 1])

/**
 * Emitters as facet records — `common.view/model-effect-source`.
 *
 * The same emitters the UVM effect extension carries, restated in the common vocabulary so a
 * viewer lists them without knowing what an MDX is. Parameters stay in Warcraft III's own words:
 * its `tailLength` and `squirt` have no portable meaning, and renaming them would only lose the
 * connection to the file.
 */
export function war3Effects(model: RenderModel) {
  const addresses = new Set(['boneIndex', 'materialIndex', 'texturePath', 'modelPaths', 'name'])
  return war3Emitters(model).map(emitter => {
    const properties: { key: string; value: string | number | boolean; animated?: boolean }[] = []
    for (const [key, value] of Object.entries(emitter.record)) {
      if (addresses.has(key)) continue
      if (value !== null && typeof value === 'object') {
        // A track is an animated value and says so; a list is structured data that does not fit a
        // scalar, and calling it animated would be a claim the file never made.
        if (Array.isArray(value)) properties.push({ key, value: 'list' })
        else properties.push({ key, value: 'track', animated: true })
        continue
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        properties.push({ key, value })
    }
    const name = emitter.record['name']
    // Singular, because one record is one emitter — and the id follows the kind rather than the
    // plural field it was read from, so `kind` and `id` cannot drift apart.
    const kind = emitter.kind === 'particles' ? 'particle' : 'ribbon'
    return {
      id: `${kind}-${String(emitter.index)}`,
      kind,
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
      ...(emitter.nodeIndex === undefined ? {} : { nodeId: nodeId(emitter.nodeIndex) }),
      ...(emitter.materialIndex === undefined
        ? {}
        : { materialId: materialId(emitter.materialIndex) }),
      ...(emitter.texturePath === undefined
        ? emitter.modelPath === undefined
          ? {}
          : { resourceId: emitter.modelPath }
        : { resourceId: emitter.texturePath }),
      ...(properties.length === 0 ? {} : { properties }),
    }
  })
}

type FacetProperty = { key: string; value: string | number | boolean; animated?: boolean }

/** Native fields as facet properties: a scalar as itself, a vector per component, a track as one. */
function nativeProperties(fields: Readonly<Record<string, unknown>>): FacetProperty[] {
  const properties: FacetProperty[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
      properties.push({ key, value })
    else if (value instanceof Float32Array)
      value.forEach((component, index) =>
        properties.push({ key: `${key}[${String(index)}]`, value: component }),
      )
    else if (value !== undefined && value !== null)
      properties.push({ key, value: 'track', animated: true })
  }
  return properties
}

/**
 * Cameras — `common.view/model-camera-source`. A Warcraft III camera is not a node of the model
 * hierarchy: it states a position and a target of its own, which stay in the properties.
 */
export function war3Cameras(native: War3.Model) {
  return native.Cameras.map((camera, index) => ({
    id: `camera-${String(index)}`,
    ...(camera.Name ? { name: camera.Name } : {}),
    ...(Number.isFinite(camera.FieldOfView) ? { fieldOfViewRadians: camera.FieldOfView } : {}),
    ...(Number.isFinite(camera.NearClip) ? { nearClip: camera.NearClip } : {}),
    ...(Number.isFinite(camera.FarClip) ? { farClip: camera.FarClip } : {}),
    properties: nativeProperties({
      Position: camera.Position,
      TargetPosition: camera.TargetPosition,
      Translation: camera.Translation,
      Rotation: camera.Rotation,
      TargetTranslation: camera.TargetTranslation,
    }),
  }))
}

const LIGHT_KINDS = Object.freeze(['omnidirectional', 'directional', 'ambient'])

/**
 * Lights — `common.view/model-light-source`. A light is a node of the hierarchy, so it is joined to
 * the scene node it is. Colour and intensity are stated only when they are one fixed value; an
 * animated one stays a track in the properties, as do attenuation and the ambient terms.
 */
export function war3Lights(native: War3.Model, model: RenderModel) {
  const known = new Set(readWar3Nodes(model).map(node => node.index))
  return native.Lights.map((light, index) => {
    const color =
      light.Color instanceof Float32Array && light.Color.length >= 3
        ? ([light.Color[0] ?? 0, light.Color[1] ?? 0, light.Color[2] ?? 0] as const)
        : undefined
    const intensity = typeof light.Intensity === 'number' ? light.Intensity : undefined
    return {
      id: `light-${String(index)}`,
      kind: LIGHT_KINDS[light.LightType] ?? `light-type-${String(light.LightType)}`,
      ...(light.Name ? { name: light.Name } : {}),
      ...(typeof light.ObjectId === 'number' && known.has(light.ObjectId)
        ? { nodeId: nodeId(light.ObjectId) }
        : {}),
      ...(color === undefined ? {} : { color }),
      ...(intensity === undefined ? {} : { intensity }),
      properties: nativeProperties({
        AttenuationStart: light.AttenuationStart,
        AttenuationEnd: light.AttenuationEnd,
        AmbColor: light.AmbColor,
        AmbIntensity: light.AmbIntensity,
        Visibility: light.Visibility,
        ...(color === undefined ? { Color: light.Color } : {}),
        ...(intensity === undefined ? { Intensity: light.Intensity } : {}),
      }),
    }
  })
}

/** The UVM material index an emitter points at, native or published for it. */
export function war3EmitterMaterialKey(emitter: War3Emitter): string | undefined {
  if (emitter.materialIndex !== undefined) return materialId(emitter.materialIndex)
  return emitter.texturePath === undefined && emitter.modelPath === undefined
    ? undefined
    : emitterMaterialId(emitter.kind, emitter.index)
}

export const war3EmitterNodeKey = (emitter: War3Emitter): string | undefined =>
  emitter.nodeIndex === undefined ? undefined : nodeId(emitter.nodeIndex)

/** MDX pivots are absolute, so a node's own translation is its offset from its parent's pivot. */
function pivotOffset(
  node: War3Node,
  byIndex: ReadonlyMap<number, War3Node>,
): readonly [number, number, number] {
  const parent = node.parentIndex < 0 ? undefined : byIndex.get(node.parentIndex)
  const [x, y, z] = node.pivot
  const [px, py, pz] = parent?.pivot ?? [0, 0, 0]
  // Rounded to float32 here rather than wherever it first lands in a buffer: glTF stores single
  // precision, and a node transform that disagrees with its own bone pose by one ulp is refused.
  return [Math.fround(x - px), Math.fround(y - py), Math.fround(z - pz)]
}

/** Column-major translation by the node's offset from its parent pivot. */
function localTransform(node: War3Node, byIndex: ReadonlyMap<number, War3Node>): readonly number[] {
  const [x, y, z] = pivotOffset(node, byIndex)
  if (x === 0 && y === 0 && z === 0) return identity
  return Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
}

/** A geoset's Reforged level of detail; a classic geoset (none stated) is drawn at every level. */
const levelOfDetail = (mesh: RenderMesh): number => {
  const value = finiteNumber(mesh.metadata?.['levelOfDetail'])
  return value === undefined || !Number.isSafeInteger(value) ? -1 : value
}

/**
 * Reforged's levels of detail (`common.view/model-lod-source`, the materializer's `lods`): one level
 * per stated LOD, order 0 the full model, each naming its geosets' nodes. A geoset at -1 is in none
 * and drawn at every level. None for a model with a single level: the game draws LOD 0 (or -1)
 * geosets only (mdx-m3-viewer `setupgeosets.ts`), so the coarser copies are switched, never summed.
 */
export function war3LodLevels(model: RenderModel) {
  const byLevel = new Map<number, string[]>()
  for (const [index, mesh] of model.meshes.entries()) {
    const level = levelOfDetail(mesh)
    if (level < 0) continue
    const nodes = byLevel.get(level)
    if (nodes === undefined) byLevel.set(level, [geosetNodeId(index)])
    else nodes.push(geosetNodeId(index))
  }
  if (byLevel.size < 2) return []
  return [...byLevel]
    .sort(([left], [right]) => left - right)
    .map(([order, nodeIds]) => ({ id: `war3-lod-${String(order)}`, order, nodeIds: Object.freeze(nodeIds) }))
}

export function war3SceneNodes(model: RenderModel) {
  const war3Nodes = readWar3Nodes(model)
  const byIndex = new Map(war3Nodes.map(node => [node.index, node]))
  const children = new Map<number, string[]>()
  const roots: string[] = []
  for (const node of war3Nodes) {
    const parent = node.parentIndex < 0 ? undefined : byIndex.get(node.parentIndex)
    if (parent === undefined) {
      roots.push(nodeId(node.index))
      continue
    }
    const list = children.get(parent.index)
    if (list === undefined) children.set(parent.index, [nodeId(node.index)])
    else list.push(nodeId(node.index))
  }
  // A glTF node carries at most one mesh, so every geoset gets its own node under the root. They
  // bind to bones through vertex groups rather than through a parent, so the nodes stay at
  // identity and the binding is published by the skeleton facet.
  // A geoset of a level of detail is a scene root of its own: the materializer groups whole roots
  // per level (MSFT_lod), and a level replaces another in place, under the same frame.
  const levels = new Set(war3LodLevels(model).flatMap(level => level.nodeIds))
  const geosetNodes = model.meshes.map((_mesh, index) => ({
    id: geosetNodeId(index),
    name: `Geoset ${String(index)}`,
    childIds: Object.freeze([]),
    meshIds: Object.freeze([meshId(index)]),
    transform: identity,
  }))
  return [
    {
      id: WAR3_ROOT_NODE_ID,
      name: 'Warcraft III model',
      childIds: Object.freeze([...geosetNodes.map(node => node.id).filter(id => !levels.has(id)), ...roots]),
      meshIds: Object.freeze([]),
      transform: identity,
    },
    ...geosetNodes,
    ...war3Nodes.map(node => ({
      id: nodeId(node.index),
      name: node.name,
      childIds: Object.freeze(children.get(node.index) ?? []),
      meshIds: Object.freeze([]),
      transform: localTransform(node, byIndex),
      // The game turns a billboarded node toward the camera every frame (`ModelNode.billboard`):
      // the viewer applies it from this facet, the materializer writes it as UV_node_billboard.
      // CameraAnchored (0x80) keeps its authored rotation.
      ...war3Billboard(node.flags),
    })),
  ]
}

// ---------------------------------------------------------------------------------------------
// Layers as draw passes.
//
// Warcraft III draws each layer of a material as its own pass over the same geoset, in layer
// order, every pass with its own blend, depth and culling state (mdx-m3-viewer `Layer`,
// WhiteoutFlakes `geoset_pass_bls.h` EmitLayers). The classic team colour is exactly that: an
// opaque layer of the player's colour, then the skin blended over it by its own alpha. Folding the
// layers into one material drew only the first — flat team colour — and a blend, additive or
// two-sided layer drew as an opaque one-sided card. So each layer is published as its own material
// on its own primitive over the geoset's geometry; the renderer's LessEqual depth lets a later pass
// land on an earlier one, and translucent passes draw after the opaque ones in layer order.

/** One MDX layer as the render model reads it (`war3Passes`, render-model.ts). */
interface War3Pass {
  readonly layerIndex: number
  readonly coordId: number
  /** Reforged's layer shader: 1 HD, 0 or null the classic fixed function. */
  readonly shaderTypeId: number | null
  readonly emissiveGain: number
  readonly filterMode: number
  readonly shading: number
  readonly alpha: number
  readonly alphaTrack?: War3AnimationTrack
  readonly replaceableId: number | null
  readonly textureFlags: number
  readonly uvAnimation?: {
    readonly translation?: War3AnimationTrack
    readonly rotation?: War3AnimationTrack
    readonly scaling?: War3AnimationTrack
  }
  readonly slots: readonly { readonly label: string; readonly path: string }[]
  /** Texture-id tracks (KMTF) of the layer's slots: each id's texture and the track choosing it. */
  readonly flipbooks?: readonly War3Flipbook[]
  /** For one texture of a flipbook pass: the id its track names that texture by. */
  readonly variant?: number
}

interface War3Flipbook {
  readonly label: string
  readonly track: War3AnimationTrack
  readonly paths: Readonly<Record<string, string>>
}

/** Blend state per filter mode (mdx-m3-viewer `layerFilterMode`, WhiteoutFlakes `bls_mat_params.cpp`). */
const WAR3_PASS_STATES = Object.freeze([
  // 0 None: opaque, writes depth.
  { alphaMode: 'opaque', blendMode: 'opaque' },
  // 1 Transparent: alpha test at 0.75, writes depth, drawn with the opaque passes.
  { alphaMode: 'mask', alphaCutoff: 0.75, blendMode: 'alpha-test' },
  // 2 Blend: SRC_ALPHA, ONE_MINUS_SRC_ALPHA without a depth write.
  { alphaMode: 'blend', blendMode: 'alpha-blend' },
  // 3 Additive and 4 AddAlpha: SRC_ALPHA, ONE — black adds nothing.
  { alphaMode: 'blend', blendMode: 'additive' },
  { alphaMode: 'blend', blendMode: 'additive' },
  // 5 Modulate: the destination times the source; 6 Modulate2x twice that.
  { alphaMode: 'blend', blendMode: 'modulate' },
  { alphaMode: 'blend', blendMode: 'modulate2x' },
] as const)

const SHADING_FLAGS = Object.freeze([
  [0x1, 'Unshaded'],
  [0x2, 'SphereEnvMap'],
  [0x10, 'TwoSided'],
  [0x20, 'Unfogged'],
  [0x40, 'NoDepthTest'],
  [0x80, 'NoDepthSet'],
] as const)

/** A geoset whose combined alpha is at or below this is not drawn (WhiteoutFlakes `wc3_classify.cpp`). */
export const WAR3_HIDDEN_ALPHA = 0.004

// A flipbook pass draws one texture of its track; its ids name that texture's id after the layer's.
const variantSuffix = (variant: number | undefined) => (variant === undefined ? '' : `-frame-${String(variant)}`)
const passMaterialId = (materialIndex: number, layerIndex: number, variant?: number): string =>
  (layerIndex === 0 ? materialId(materialIndex) : `${materialId(materialIndex)}-layer-${String(layerIndex)}`) +
  variantSuffix(variant)
const passPrimitiveId = (geosetIndex: number, layerIndex: number, variant?: number): string =>
  layerIndex === 0 && variant === undefined
    ? primitiveId(geosetIndex)
    : `war3-geoset-${String(geosetIndex)}-layer-${String(layerIndex)}${variantSuffix(variant)}-primitive`

function readWar3Passes(material: RenderMaterial | undefined): readonly War3Pass[] | undefined {
  const raw = material?.metadata?.['war3Passes']
  if (!Array.isArray(raw)) return undefined
  const passes: War3Pass[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const layerIndex = record['layerIndex']
    if (!Number.isSafeInteger(layerIndex) || (layerIndex as number) < 0) continue
    const slots = Array.isArray(record['slots'])
      ? (record['slots'] as unknown[]).flatMap(slot => {
          const entry = slot as Record<string, unknown> | null
          return typeof entry?.['label'] === 'string' && typeof entry['path'] === 'string'
            ? [{ label: entry['label'], path: entry['path'] }]
            : []
        })
      : []
    const alphaTrack = record['alphaTrack']
    const rawUv = record['uvAnimation'] as Record<string, unknown> | null | undefined
    const uvAnimation =
      rawUv === null || typeof rawUv !== 'object'
        ? undefined
        : Object.fromEntries(
            (['translation', 'rotation', 'scaling'] as const).flatMap(key =>
              isTrack(rawUv[key]) ? [[key, rawUv[key]]] : [],
            ),
          )
    const flipbooks = Array.isArray(record['flipbooks'])
      ? (record['flipbooks'] as unknown[]).flatMap(item => {
          const entry = item as Record<string, unknown> | null
          const paths = entry?.['paths']
          return typeof entry?.['label'] === 'string' && isTrack(entry['track']) && typeof paths === 'object' && paths !== null
            ? [{ label: entry['label'], track: entry['track'], paths: paths as Record<string, string> }]
            : []
        })
      : []
    passes.push({
      ...(flipbooks.length === 0 ? {} : { flipbooks }),
      layerIndex: layerIndex as number,
      coordId: finiteNumber(record['coordId']) ?? 0,
      shaderTypeId: finiteNumber(record['shaderTypeId']) ?? null,
      emissiveGain: finiteNumber(record['emissiveGain']) ?? 1,
      filterMode: finiteNumber(record['filterMode']) ?? 0,
      shading: finiteNumber(record['shading']) ?? 0,
      alpha: finiteNumber(record['alpha']) ?? 1,
      ...(isTrack(alphaTrack) ? { alphaTrack } : {}),
      replaceableId: finiteNumber(record['replaceableId']) ?? null,
      textureFlags: finiteNumber(record['textureFlags']) ?? 0,
      ...(uvAnimation === undefined || Object.keys(uvAnimation).length === 0 ? {} : { uvAnimation }),
      slots,
    })
  }
  return passes
}

/**
 * The passes a geoset draws: its material's layers, less a layer whose alpha is zero and never
 * animated — the game skips it in every sequence. `undefined` when the render model states no
 * passes (a model read by another adapter), so the geoset keeps its single primitive.
 */
function geosetPasses(model: RenderModel, mesh: RenderMesh): readonly War3Pass[] | undefined {
  const passes = readWar3Passes(model.materials[mesh.materialIndex])
  if (passes === undefined || passes.length === 0) return undefined
  const drawn = passes.filter(pass => pass.alphaTrack !== undefined || pass.alpha > WAR3_HIDDEN_ALPHA)
  return withFlipbooks(drawn.length === 0 ? passes.slice(0, 1) : drawn)
}

/**
 * A flipbook layer (KMTF: HD water, fountains, coral) draws one texture at a time, chosen by its
 * texture-id track. The common material samples one texture per slot, so the layer becomes one pass
 * per texture its first track names, each with that texture in every flipbook slot (a slot's track
 * keyed in step with the first gives the texture of the same key), and `visibilityChannels` shows
 * each pass only while the track names its texture.
 */
function withFlipbooks(passes: readonly War3Pass[]): readonly War3Pass[] {
  return passes.flatMap(pass => {
    const flipbooks = pass.flipbooks ?? []
    const [driver] = flipbooks
    if (driver === undefined) return [pass]
    const variants = [...new Set(driver.track.keys.map(key => key.vector[0] ?? 0))].filter(
      id => driver.paths[String(id)] !== undefined,
    )
    if (variants.length < 2) return [pass]
    return variants.map(variant => {
      const at = driver.track.keys.findIndex(key => (key.vector[0] ?? 0) === variant)
      const paths = new Map(
        flipbooks.flatMap(flipbook => {
          const id = flipbook.track.keys[at]?.vector[0]
          const path = id === undefined ? undefined : flipbook.paths[String(id)]
          return path === undefined ? [] : [[flipbook.label, path] as const]
        }),
      )
      return {
        ...pass,
        variant,
        slots: pass.slots.map(slot => ({ label: slot.label, path: paths.get(slot.label) ?? slot.path })),
      }
    })
  })
}

/**
 * The texture id a flipbook's track names at `frame` of the sequence [start, end], step by step as
 * the game reads a texture id. A track on a global sequence runs its own cycle from the sequence's
 * start; `globalSequences` sizes it.
 */
function flipbookAt(
  track: War3AnimationTrack,
  start: number,
  end: number,
  frame: number,
  globalSequences: readonly unknown[],
): number {
  const first = track.keys[0]?.vector[0] ?? 0
  if (track.globalSeqId === null) return war3ScalarAt({ ...track, lineType: 0 }, first, start, end, frame)
  const length = finiteNumber(globalSequences[track.globalSeqId])
  if (length === undefined || !(length > 0)) return first
  const local = (frame - start) % length
  let id = first
  for (const key of track.keys) if (key.frame <= local) id = key.vector[0] ?? id
  return id
}

/** The frames of [start, end] where a flipbook's track can change: its own keys, or each cycle's. */
function flipbookFrames(
  track: War3AnimationTrack,
  start: number,
  end: number,
  globalSequences: readonly unknown[],
): number[] {
  if (track.globalSeqId === null) return track.keys.map(key => key.frame).filter(frame => frame >= start && frame <= end)
  const length = finiteNumber(globalSequences[track.globalSeqId])
  if (length === undefined || !(length > 0)) return []
  const frames: number[] = []
  for (let cycle = start; cycle <= end && frames.length < WAR3_FLIPBOOK_MAX_KEYS; cycle += length)
    for (const key of track.keys) if (cycle + key.frame <= end) frames.push(cycle + key.frame)
  return frames
}

/** At most this many keys per flipbook pass and sequence: a long sequence over a short cycle. */
const WAR3_FLIPBOOK_MAX_KEYS = 4096

/**
 * WC3 filter mode → the common render-material blend (`standardBlendModeName`, codec-kit): 0
 * opaque or alpha-tested, 1 blend, 3 add-alpha (SRC_ALPHA, ONE), 4 modulate, 5 modulate2x. The
 * game's Additive and AddAlpha are both SRC_ALPHA, ONE; common 2 (SRC_COLOR, ONE) is not theirs.
 */
const WAR3_STANDARD_BLEND = Object.freeze([0, 0, 1, 3, 3, 4, 5])

/**
 * A layer's alpha track as a render-material `sequenceTracks` entry per sequence: sequence-local
 * seconds, step or linear, with the value the game samples at both ends of the sequence so the
 * held ends agree with its loop (`war3ScalarAt`). Hermite and Bezier alphas are carried linearly.
 */
function alphaSequenceTracks(model: RenderModel, track: War3AnimationTrack) {
  return materialSequenceTracks(model, track, [1], value => [value[0] ?? 1])
}

/**
 * The material one layer draws with, stated in the common render-material vocabulary every Modkit
 * renderer executes (`modkit.render-material.v1`, the `StandardMaterialModel` SPEC_UVM §11.3 names as
 * `UV_game_material`'s payload): its texture, blend, alpha test, culling, shading and priority. The
 * glTF coverage fields beside it are for readers without that vocabulary.
 */
function passMaterial(
  model: RenderModel,
  material: RenderMaterial,
  materialIndex: number,
  pass: War3Pass,
  passCount: number,
) {
  const metadata = material.metadata ?? {}
  if (!Number.isInteger(pass.coordId) || pass.coordId < 0 || pass.coordId > 3)
    throw new RangeError(`Warcraft III layer UV set ${String(pass.coordId)} is unsupported`)
  // The common material's 2/3 are environment coordinates; explicit UV2/3 are 9/10.
  const uvSource = [0, 1, 9, 10][pass.coordId]!
  const priorityPlane = finiteNumber(metadata['priorityPlane']) ?? 0
  const renderMode = finiteNumber(metadata['renderMode']) ?? 0
  // A filter mode past Modulate2x draws as Blend (mdx-m3-viewer).
  const filterMode = pass.filterMode >= 0 && pass.filterMode <= 6 ? pass.filterMode : 2
  const state = WAR3_PASS_STATES[filterMode]!
  // A None or Transparent layer faded below full alpha draws blended (WhiteoutFlakes
  // `layer_material.cpp`); only a fixed fade is known here, an animated one keeps its mode.
  const faded = filterMode <= 1 && pass.alphaTrack === undefined && pass.alpha < 0.99
  const coverage = faded ? { alphaMode: 'blend' as const, blendMode: 'alpha-blend' as const } : state
  const flagNames = SHADING_FLAGS.filter(([bit]) => (pass.shading & bit) !== 0).map(([, name]) => name)
  const diffusePath = pass.slots.find(slot => slot.label === 'diffuse')?.path
  const wrapX = (pass.textureFlags & 1) !== 0
  const wrapY = (pass.textureFlags & 2) !== 0
  const alphaTracks = pass.alphaTrack === undefined ? [] : alphaSequenceTracks(model, pass.alphaTrack)
  const alphaFactor =
    pass.alpha === 1 && alphaTracks.length === 0
      ? undefined
      : { value: pass.alpha, ...(alphaTracks.length === 0 ? {} : { sequenceTracks: alphaTracks }) }
  // Team colour (replaceable 1) is the player's colour itself: a textureless layer whose colour the
  // renderer's team colour replaces whole (`teamColorMode` mixes by the constant's zero alpha).
  // Team glow (replaceable 2) in an additive pass: TeamGlowNN is the glow of TeamGlow00 — its red
  // channel, opaque — in the slot's colour, so the pass draws the team colour weighted by that red.
  const teamGlow = pass.replaceableId === 2 && (filterMode === 3 || filterMode === 4) && diffusePath !== undefined
  const teamColor = pass.replaceableId === 1 || teamGlow
  const diffuse = {
    slot: 'diffuse',
    texturePath: teamColor ? null : (diffusePath ?? null),
    ...(teamColor || diffusePath === undefined ? { constantColor: { value: [1, 1, 1, teamColor ? 0 : 1] } } : {}),
    uvSource,
    // RGBA, added onto the black start: the texel is the colour.
    channels: 1,
    op: 6,
    teamColorMode: teamColor ? 1 : 0,
    invert: false,
    clampResult: false,
    wrapX,
    wrapY,
    ...(alphaFactor === undefined ? {} : { alphaFactor }),
    ...uvTransformOf(model, pass.uvAnimation),
  }
  const glowShape = {
    slot: 'alpha1',
    texturePath: diffusePath ?? null,
    uvSource,
    // RRRR: the glow's red as the alpha the additive pass weights the colour by.
    channels: 3,
    op: 6,
    teamColorMode: 0,
    invert: false,
    clampResult: false,
    wrapX,
    wrapY,
    ...uvTransformOf(model, pass.uvAnimation),
  }
  // Reforged's HD shader: the layer's ORM map is occlusion (R), roughness (G), metallic (B) and the
  // team colour mask (A); the normal map is BC5 (X red, Y green); the emissive map is added after
  // light by the layer's gain. Its sixth slot, the environment map, is never sampled (W3ModelViewer
  // `docs/mdx-format-verified.md` §5, from the game's `hd.bls`).
  const hd = hdLayers(pass, metadata, wrapX, wrapY, uvTransformOf(model, pass.uvAnimation))
  const standard = {
    layers: hd !== undefined ? { diffuse, ...hd.layers } : teamGlow ? { diffuse, alpha1: glowShape } : { diffuse },
    ...(hd === undefined
      ? {}
      : {
          lightingModel: 'pbr-metallic-roughness',
          metallicFactor: 1,
          roughnessFactor: 1,
          colorPipeline: 'linear-srgb',
          normalMapFormat: 'bc5',
          teamColorMaskMix: true,
          environmentTintByBase: true,
        }),
    blendMode: faded ? 1 : (WAR3_STANDARD_BLEND[filterMode] ?? 1),
    priority: priorityPlane,
    specularity: 0,
    specMult: 0,
    emisMult: hd?.emisMult ?? 0,
    specMode: 0,
    // Transparent keys at 0.75; every other translucent mode drops 4/255 (WhiteoutFlakes `bls_frame.cpp`).
    alphaTestThreshold: filterMode === 1 ? 0.75 : filterMode === 0 && !faded ? 0 : 4 / 255,
    twoSided: (pass.shading & 0x10) !== 0 || (renderMode & 0x2) !== 0,
    unshaded: (pass.shading & 0x1) !== 0,
    doubleLambert: false,
    clampOutput: true,
    // A geoset's colour, which its primitive carries as vertex colour (`war3GeosetGeometry`); a
    // primitive without one reads white.
    usesVertexColor: true,
    usesVertexAlpha: false,
    // No `sourceFlags`: those are a StarCraft II MAT_ record's own flags, which a writer copies
    // verbatim. The layer's shading flags are Warcraft III's and stay in `metadata`.
  }
  return {
    id: passMaterialId(materialIndex, pass.layerIndex, pass.variant),
    name:
      (passCount > 1 ? `${material.name} layer ${String(pass.layerIndex)}` : material.name) +
      (pass.variant === undefined ? '' : ` frame ${String(pass.variant)}`),
    alphaMode: coverage.alphaMode,
    ...('alphaCutoff' in coverage ? { alphaCutoff: coverage.alphaCutoff } : {}),
    blendMode: coverage.blendMode,
    priority: priorityPlane,
    nativeFlags: pass.shading,
    ...(flagNames.length === 0 ? {} : { flagNames }),
    layers: pass.slots.map(slot => ({ slot: layerSlot(slot.label), resourceId: slot.path, uvSource: pass.coordId })),
    shader: {
      id: 'modkit.render-material.v1',
      parameters: {
        renderModel: {
          version: 1,
          layers: pass.slots.map(slot => ({ label: slot.label, path: slot.path })),
          standard,
          metadata: {
            source: 'war3',
            materialIndex,
            layerIndex: pass.layerIndex,
            filterMode: pass.filterMode,
            shading: pass.shading,
            priorityPlane,
            renderMode,
            replaceableId: pass.replaceableId,
            textureFlags: pass.textureFlags,
          },
        },
      },
    },
  }
}

/**
 * The sky HD metal reflects: the specular element (1) of Lordaeron Summer's day probe, the game's
 * default lighting set, at one prefiltered level (mip 3 of 9, roughness 3/8 — one blur for every
 * surface until a material samples its level by roughness), its faces as the game stores them
 * (−X and −Z swapped; WhiteoutFlakes `env_probe.h`, W3ModelViewer `ReflectionCube.cs`).
 */
const WAR3_HD_REFLECTION = 'Environment/EnvironmentMap/LordaeronSummer/Day_IBL.dds#layer=1&mip=3&faces=0,5,2,3,4,1'

/**
 * The HD layers of a Reforged pass (`hdLayers` above), or `undefined` for a classic pass: shader 1,
 * or a 1000-format material named `Shader_HD_*`, with an ORM map.
 */
function hdLayers(
  pass: War3Pass,
  metadata: Readonly<Record<string, unknown>>,
  wrapX: boolean,
  wrapY: boolean,
  uv: ReturnType<typeof uvTransformOf>,
) {
  const shader = typeof metadata['shader'] === 'string' ? metadata['shader'] : ''
  const path = (label: string) => pass.slots.find(slot => slot.label === label)?.path
  const orm = path('orm')
  if (orm === undefined || !(pass.shaderTypeId === 1 || /^Shader_HD_/iu.test(shader))) return undefined
  const sample = (texturePath: string, channels: number, op: number) => ({
    texturePath,
    uvSource: [0, 1, 9, 10][pass.coordId]!,
    channels,
    op,
    teamColorMode: 0,
    invert: false,
    clampResult: false,
    wrapX,
    wrapY,
    ...uv,
  })
  const normal = path('normal')
  const emissive = path('emissive')
  return {
    layers: {
      // channels: 1 RGBA, 2 AAAA, 3 RRRR, 4 GGGG, 5 BBBB
      ...(normal === undefined ? {} : { normal: { slot: 'normal', ...sample(normal, 1, 6) } }),
      // WhiteoutLib f3e57087 Layer::ShadingFlag::AmbientOcclusion: baked AO is a second unwrap.
      ...((pass.shading & 0x400) === 0 ? {} : { ao: { slot: 'ao', ...sample(orm, 3, 6), uvSource: 1 } }),
      roughness: { slot: 'roughness', ...sample(orm, 4, 6) },
      metalness: { slot: 'metalness', ...sample(orm, 5, 6) },
      teamColorMask: { slot: 'teamColorMask', ...sample(orm, 2, 6) },
      // Metal reflects the game's sky by the reflected ray (uv source 2), added where the ORM says
      // metallic and tinted by the base colour — F0 = albedo × metallic.
      envi: { slot: 'envi', ...sample(WAR3_HD_REFLECTION, 1, 2), uvSource: 2 },
      enviMask: { slot: 'enviMask', ...sample(orm, 5, 6) },
      ...(emissive === undefined || pass.emissiveGain === 0 ? {} : { emissive1: { slot: 'emissive1', ...sample(emissive, 0, 6) } }),
    },
    emisMult: emissive === undefined ? 0 : pass.emissiveGain,
  }
}

/** Every material of the model, one per layer pass, for the facet and the UVM. */
export function war3PassMaterials(model: RenderModel) {
  return model.materials.flatMap((material: RenderMaterial, materialIndex: number) => {
    const passes = readWar3Passes(material)
    if (passes === undefined || passes.length === 0) return [war3Material(material, materialIndex)]
    return withFlipbooks(passes).map(pass => passMaterial(model, material, materialIndex, pass, passes.length))
  })
}

/** The UVM material id of one layer pass, for callers that join a pass to its material. */
export const war3PassMaterialKey = (materialIndex: number, layerIndex: number): string =>
  passMaterialId(materialIndex, layerIndex)

/**
 * A scalar track at one frame of a sequence, the way the game samples it (mdx-m3-viewer `SdSequence`
 * after Retera, WhiteoutFlakes `mdx_animation.cpp`): only keys inside the sequence count; none gives
 * the default, one gives itself; before the first and after the last it runs across the loop from
 * the last key to the first. Hermite and Bezier are read as linear — the value only decides whether
 * a pass is drawn. A global-sequence track keeps its first key: no clip states that clock.
 */
function war3ScalarAt(
  track: War3AnimationTrack | undefined,
  fallback: number,
  start: number,
  end: number,
  frame: number,
): number {
  if (track?.globalSeqId !== null && track !== undefined) return track.keys[0]?.vector[0] ?? fallback
  return war3VectorAt(track, [fallback], start, end, frame)[0] ?? fallback
}

/** `war3ScalarAt` for every component of a vector track, over the interval [start, end]. */
function war3VectorAt(
  track: War3AnimationTrack | undefined,
  fallback: readonly number[],
  start: number,
  end: number,
  frame: number,
): number[] {
  if (track === undefined) return [...fallback]
  const keys = track.keys.filter(key => key.frame >= start && key.frame <= end)
  const first = keys[0]
  const value = (key: War3AnimationKey) => fallback.map((component, axis) => key.vector[axis] ?? component)
  if (first === undefined) return [...fallback]
  const last = keys[keys.length - 1]!
  if (keys.length === 1) return value(first)
  const period = end - start
  let from = last,
    to = first,
    span = first.frame + period - last.frame,
    offset = frame >= last.frame ? frame - last.frame : frame + period - last.frame
  if (frame >= first.frame && frame < last.frame) {
    const next = keys.findIndex(key => key.frame > frame)
    from = keys[next - 1]!
    to = keys[next]!
    span = to.frame - from.frame
    offset = frame - from.frame
  }
  const a = value(from)
  if (track.lineType === 0 || span <= 0) return a
  const b = value(to)
  const t = Math.min(1, Math.max(0, offset / span))
  return a.map((component, axis) => component + ((b[axis] ?? component) - component) * t)
}

/**
 * A layer-material track as render-material `sequenceTracks`: sequence-local seconds, the game's
 * value at both ends of each sequence (`war3VectorAt`), step or linear — Hermite and Bezier are
 * carried linearly. A global-sequence track runs in every clip on its own clock (`concurrent`,
 * wrapping at the global sequence's length), which is how the game plays it.
 */
function materialSequenceTracks(
  model: RenderModel,
  track: War3AnimationTrack,
  fallback: readonly number[],
  map: (value: readonly number[]) => number[],
) {
  const lineType = track.lineType === 0 ? 0 : 1
  const sampled = (start: number, end: number) => {
    const keys = track.keys.filter(key => key.frame >= start && key.frame <= end)
    if (keys.length === 0) return undefined
    const frames = [...new Set([start, ...keys.map(key => key.frame), end])].sort((a, b) => a - b)
    return {
      lineType,
      globalSeqId: null,
      keys: frames.map(frame => ({
        frame: (frame - start) / 1000,
        vector: map(war3VectorAt(track, fallback, start, end, frame)),
      })),
    }
  }
  if (track.globalSeqId !== null) {
    const raw = model.metadata?.['war3GlobalSequences']
    const duration = Array.isArray(raw) ? finiteNumber(raw[track.globalSeqId]) : undefined
    if (duration === undefined || duration <= 0) return []
    const global = sampled(0, duration)
    if (global === undefined) return []
    return model.animations.map((_animation: RenderAnimation, sequenceIndex: number) => ({
      sequenceIndex,
      concurrent: true,
      wrapSeconds: duration / 1000,
      track: global,
    }))
  }
  return model.animations.flatMap((animation: RenderAnimation, sequenceIndex: number) => {
    const start = animation.startFrame ?? 0
    const track = sampled(start, animation.endFrame ?? start)
    return track === undefined ? [] : [{ sequenceIndex, track }]
  })
}

/** A quaternion's turn about Z, the axis a UV rotation keys (WhiteoutFlakes: θ = 2·atan2(z, w)). */
const uvTurn = (q: readonly number[]) => 2 * Math.atan2(q[2] ?? 0, q[3] ?? 1)

/**
 * The layer's texture animation as the render material's UV transform. The game moves UVs as
 * R(θ)·S·(uv + T − 0.5) + 0.5; the material computes (rotate(uv, −angle) − 0.5 − offset)·tiling + 0.5,
 * so offset = −T and tiling = S exactly, and angle = −θ is exact for a rotation on its own — a
 * layer that both rotates and moves its UVs turns them before moving them.
 */
function uvTransformOf(model: RenderModel, animation: War3Pass['uvAnimation']) {
  if (animation === undefined) return {}
  const offset = animation.translation === undefined
    ? []
    : materialSequenceTracks(model, animation.translation, [0, 0, 0], value => [-(value[0] ?? 0), -(value[1] ?? 0)])
  const tiling = animation.scaling === undefined
    ? []
    : materialSequenceTracks(model, animation.scaling, [1, 1, 1], value => [value[0] ?? 1, value[1] ?? 1])
  const rotation = animation.rotation === undefined
    ? []
    : materialSequenceTracks(model, unwrappedTurns(animation.rotation), [0], value => [0, 0, -(value[0] ?? 0)])
  if (offset.length === 0 && tiling.length === 0 && rotation.length === 0) return {}
  return {
    uvOffset: { value: [0, 0], ...(offset.length === 0 ? {} : { sequenceTracks: offset }) },
    uvTiling: { value: [1, 1], ...(tiling.length === 0 ? {} : { sequenceTracks: tiling }) },
    uvAngle: { value: [0, 0, 0], ...(rotation.length === 0 ? {} : { sequenceTracks: rotation }) },
  }
}

/** A rotation track as its turn angle per key, kept continuous so interpolation takes the short way. */
function unwrappedTurns(track: War3AnimationTrack): War3AnimationTrack {
  let previous: number | undefined
  return {
    ...track,
    keys: track.keys.map(key => {
      let angle = uvTurn(key.vector)
      if (previous !== undefined) {
        while (angle - previous > Math.PI) angle -= 2 * Math.PI
        while (angle - previous < -Math.PI) angle += 2 * Math.PI
      }
      previous = angle
      return { frame: key.frame, vector: [angle] }
    }),
  }
}

interface War3GeosetAnimation {
  readonly alpha: number
  readonly alphaTrack?: War3AnimationTrack
  /** Red first, 0..1: the colour the game multiplies every pass of the geoset by. */
  readonly color?: readonly [number, number, number]
  readonly colorTrack?: War3AnimationTrack
}

function readWar3GeosetAnimations(model: RenderModel): ReadonlyMap<number, War3GeosetAnimation> {
  const raw = model.metadata?.['war3GeosetAnimations']
  const out = new Map<number, War3GeosetAnimation>()
  if (!Array.isArray(raw)) return out
  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const geosetIndex = record['geosetIndex']
    if (!Number.isSafeInteger(geosetIndex) || out.has(geosetIndex as number)) continue
    const alphaTrack = record['alphaTrack']
    const color = record['color']
    const colorTrack = record['colorTrack']
    out.set(geosetIndex as number, {
      alpha: finiteNumber(record['alpha']) ?? 1,
      ...(isTrack(alphaTrack) ? { alphaTrack } : {}),
      ...(Array.isArray(color) && color.length === 3 && color.every(value => Number.isFinite(value))
        ? { color: color as unknown as readonly [number, number, number] }
        : {}),
      ...(isTrack(colorTrack) ? { colorTrack } : {}),
    })
  }
  return out
}

/**
 * Whether each pass of each geoset is drawn through one sequence — `visibility` channels on the
 * pass primitives. The game draws a pass while geoset alpha × layer alpha stays above
 * `WAR3_HIDDEN_ALPHA`; this is how gore, decay bones and a unit's fade-out come and go. A pass drawn
 * throughout the sequence gets no channel.
 */
function visibilityChannels(model: RenderModel, startFrame: number, endFrame: number) {
  const animations = readWar3GeosetAnimations(model)
  const sequences = model.metadata?.['war3GlobalSequences']
  const globalSequences: readonly unknown[] = Array.isArray(sequences) ? sequences : []
  const channels: {
    target: string
    kind: 'visibility'
    firstFrame: number
    lastFrame: number
    interpolation: 'step' | 'linear'
    samples: { frame: number; timeMilliseconds: number; timeSeconds: number; value: number[] }[]
  }[] = []
  const inRange = (track: War3AnimationTrack | undefined) =>
    track === undefined || track.globalSeqId !== null
      ? []
      : track.keys.filter(key => key.frame >= startFrame && key.frame <= endFrame)
  for (const [geosetIndex, mesh] of model.meshes.entries()) {
    const passes = geosetPasses(model, mesh)
    const geoset = animations.get(geosetIndex)
    // A geoset with a track reads 1 in a sequence that keys none of it; without one, its fixed alpha.
    const geosetDefault = geoset?.alphaTrack === undefined ? (geoset?.alpha ?? 1) : 1
    for (const pass of passes ?? [undefined]) {
      const tracks = [geoset?.alphaTrack, pass?.alphaTrack]
      const keyed = tracks.flatMap(inRange)
      const passDefault = pass === undefined ? 1 : pass.alphaTrack === undefined ? pass.alpha : 1
      // A flipbook pass is drawn only while its layer's texture-id track names its texture.
      const flipbook = pass?.variant === undefined ? undefined : pass.flipbooks?.[0]
      const shown = (frame: number) =>
        flipbook === undefined ||
        flipbookAt(flipbook.track, startFrame, endFrame, frame, globalSequences) === pass?.variant
      const valueAt = (frame: number) => {
        const value =
          war3ScalarAt(geoset?.alphaTrack, geosetDefault, startFrame, endFrame, frame) *
          (pass === undefined ? 1 : war3ScalarAt(pass.alphaTrack, passDefault, startFrame, endFrame, frame))
        return value > WAR3_HIDDEN_ALPHA && shown(frame) ? value : 0
      }
      const frames = [
        ...new Set([
          startFrame,
          ...keyed.map(key => key.frame),
          ...(flipbook === undefined ? [] : flipbookFrames(flipbook.track, startFrame, endFrame, globalSequences)),
          endFrame,
        ]),
      ].sort((a, b) => a - b)
      const values = frames.map(valueAt)
      if (values.every(value => value > 0)) continue
      const interpolation = flipbook !== undefined || tracks.every(
        track => track === undefined || inRange(track).length === 0 || track.lineType === 0,
      )
        ? ('step' as const)
        : ('linear' as const)
      // A step channel needs only the frames where its value changes, and its last: a flipbook
      // texture is shown once a cycle, so its pass keeps two keys a cycle instead of every key.
      const kept = frames.flatMap((frame, ordinal) =>
        interpolation === 'linear' ||
        ordinal === 0 ||
        ordinal === frames.length - 1 ||
        values[ordinal] !== values[ordinal - 1]
          ? [{ frame, value: values[ordinal]! }]
          : [],
      )
      channels.push({
        target:
          pass === undefined ? primitiveId(geosetIndex) : passPrimitiveId(geosetIndex, pass.layerIndex, pass.variant),
        kind: 'visibility',
        firstFrame: 0,
        lastFrame: kept.length - 1,
        interpolation,
        samples: kept.map(({ frame, value }, ordinal) => ({
          frame: ordinal,
          timeMilliseconds: frame,
          timeSeconds: (frame - startFrame) / 1000,
          value: [value],
        })),
      })
    }
  }
  return channels
}

export function war3SceneMeshes(model: RenderModel) {
  return model.meshes.map((mesh: RenderMesh, index: number) => ({
    id: meshId(index),
    name: mesh.name === '' ? `Geoset ${String(index)}` : mesh.name,
    primitiveIds: Object.freeze(
      (geosetPasses(model, mesh) ?? [undefined]).map(pass =>
        pass === undefined ? primitiveId(index) : passPrimitiveId(index, pass.layerIndex, pass.variant),
      ),
    ),
  }))
}

export function war3ScenePrimitives(model: RenderModel) {
  return model.meshes.flatMap((mesh: RenderMesh, index: number) => {
    const geometry = war3GeosetGeometry(model, mesh, index)
    const passes = geosetPasses(model, mesh)
    if (passes === undefined) return [geometry]
    // The passes share the geoset's arrays; each draws them with its own layer's material.
    return passes.map(pass => {
      if (pass.slots.length > 0 && [mesh.uvs, mesh.uvs1, mesh.uvs2, mesh.uvs3][pass.coordId] === undefined)
        throw new TypeError(`Warcraft III geoset ${String(index)} has no layer UV set ${String(pass.coordId)}`)
      if ((pass.shading & 0x400) !== 0 && mesh.uvs1 === undefined)
        throw new TypeError(`Warcraft III geoset ${String(index)} requests baked AO without UV set 1`)
      return {
        ...geometry,
        id: passPrimitiveId(index, pass.layerIndex, pass.variant),
        materialId: passMaterialId(mesh.materialIndex, pass.layerIndex, pass.variant),
      }
    })
  })
}

/** The geoset's geometry as one primitive, with the material its first layer draws. */
function war3GeosetGeometry(model: RenderModel, mesh: RenderMesh, index: number) {
  const colors = geosetColors(mesh, geosetTint(model, index))
  const textureCoordinateSets = [mesh.uvs, mesh.uvs1, mesh.uvs2, mesh.uvs3].flatMap((coordinates, set) =>
    coordinates === undefined ? [] : [{ set, coordinates }],
  )
  return {
    id: primitiveId(index),
    topology: 'triangles' as const,
    positions: mesh.positions,
    // Geoset indices are 16-bit in MDX; the facet buffer is 32-bit for every publisher.
    indices: mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices),
    ...(mesh.normals === undefined ? {} : { normals: mesh.normals }),
    ...(mesh.tangents === undefined ? {} : { tangents: mesh.tangents }),
    ...(colors === undefined ? {} : { colors }),
    ...(mesh.uvs === undefined ? {} : { textureCoordinates: mesh.uvs }),
    ...(textureCoordinateSets.length === 0 ? {} : { textureCoordinateSets }),
    // Warcraft III binds a vertex to a matrix group, which the adapter spread over four equal,
    // unit-sum weights (groups of more than four capped there), or — Reforged's SKIN — to four
    // weighted bones; either is what the portable skin takes.
    ...(mesh.boneIndices === undefined || mesh.boneWeights === undefined
      ? {}
      : {
          boneIndices: Uint32Array.from(mesh.boneIndices),
          boneWeights: mesh.boneWeights,
          hierarchyId: WAR3_ROOT_NODE_ID,
        }),
    ...(mesh.materialIndex >= 0 && mesh.materialIndex < model.materials.length
      ? { materialId: materialId(mesh.materialIndex) }
      : {}),
  }
}

/**
 * The colour a geoset is tinted by (GEOA), when it tints: the game multiplies every pass of the
 * geoset by it (mdx-m3-viewer `sd.vert` u_geosetColor, WhiteoutFlakes `geosetColors`). The Infernal's
 * grey fire is green only by it. An animated colour keeps its first key: the common vocabulary has
 * no colour channel for a primitive.
 */
function geosetTint(model: RenderModel, index: number): readonly [number, number, number] | undefined {
  const animation = readWar3GeosetAnimations(model).get(index)
  const first = animation?.colorTrack?.keys[0]?.vector
  const color: readonly [number, number, number] | undefined =
    first !== undefined && first.length >= 3
      ? [first[0] ?? 1, first[1] ?? 1, first[2] ?? 1]
      : animation?.color
  if (color === undefined || color.every(component => Math.abs(component - 1) < 1 / 512)) return undefined
  return color.map(component => Math.min(1, Math.max(0, component))) as unknown as readonly [number, number, number]
}

/** A geoset's vertex colours under its tint: the mesh's own, if any, multiplied by it. */
function geosetColors(mesh: RenderMesh, tint: readonly [number, number, number] | undefined) {
  if (tint === undefined) return mesh.colors
  const count = mesh.positions.length / 3
  const colors = new Float32Array(count * 4)
  for (let vertex = 0; vertex < count; vertex++)
    for (let channel = 0; channel < 4; channel++)
      colors[vertex * 4 + channel] =
        (mesh.colors?.[vertex * 4 + channel] ?? 1) * (channel < 3 ? tint[channel]! : 1)
  return colors
}

/** Texture closure and native ATCH/PRE1 sidecar names; host resource ports own all opening. */
export function war3ResourceReferences(model: RenderModel, native: War3.Model | Readonly<Record<string, unknown>>) {
  const seen = new Set<string>()
  const references: { id: string; role: 'texture' | 'sidecar'; provenance: 'reference-only' }[] = []
  // Roles remain distinct even when an unusual document uses the same path for both.
  const add = (path: string | undefined, role: 'texture' | 'sidecar' = 'texture'): void => {
    if (path === undefined || path.trim() === '' || seen.has(`${role}:${path}`)) return
    seen.add(`${role}:${path}`)
    references.push({ id: path, role, provenance: 'reference-only' })
  }
  for (const material of model.materials) for (const layer of material.layers) add(layer.path)
  // Every texture a pass draws: a flipbook's other frames, the sky HD metal reflects.
  for (const material of war3PassMaterials(model)) {
    const shader = 'shader' in material ? (material.shader as { parameters: Record<string, unknown> }) : undefined
    const standard = (shader?.parameters['renderModel'] as { standard?: { layers?: Record<string, { texturePath?: string | null }> } } | undefined)?.standard
    for (const layer of Object.values(standard?.layers ?? {})) add(layer.texturePath ?? undefined)
  }
  // An emitter's texture is a resource the model depends on just as a material layer is.
  for (const emitter of war3Emitters(model)) add(emitter.texturePath)
  // Read native paths, not the preview's .mdl→.mdx aliases: the facet preserves authored names.
  for (const records of [native['Attachments'], native['ParticleEmitters']]) {
    if (!Array.isArray(records)) continue
    for (const record of records)
      if (typeof record === 'object' && record !== null && typeof record.Path === 'string') add(record.Path, 'sidecar')
  }
  return references
}

function layerSlot(label: string): string {
  const slot = label.trim().toLowerCase()
  return slot === '' ? 'diffuse' : slot
}

/** Records the adapter carried over from the model, read back without inventing a missing one. */
function metadataRecords(model: RenderModel, key: string): readonly Record<string, unknown>[] {
  const raw = model.metadata?.[key]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
}

/**
 * Attachment points — `common.view/model-socket-source`.
 *
 * Warcraft III states no forward or up axis for an attachment, so no orientation is published:
 * the contract reserves that for formats that declare both. The native name is carried verbatim
 * because scripts reference it, and the role stays `attach` unless the name proves narrower.
 */
export function war3Sockets(model: RenderModel) {
  const known = new Set(readWar3Nodes(model).map(node => node.index))
  return metadataRecords(model, 'war3Attachments').map((record, ordinal) => {
    const name =
      typeof record['name'] === 'string' ? record['name'] : `Attachment ${String(ordinal)}`
    const index = record['nodeIndex']
    const target = typeof index === 'number' && known.has(index) ? nodeId(index) : WAR3_ROOT_NODE_ID
    // The attachment's own node, when the model declared one: that is where its transform is, and
    // it is the node a writer has to put an ATCH record back on.
    const own = record['ownNodeIndex']
    return {
      id: `war3-attachment-${String(ordinal)}`,
      nodeId: target,
      role: socketRole(name),
      sourceName: name,
      ...(typeof own === 'number' && known.has(own) ? { ownNodeId: nodeId(own) } : {}),
    }
  })
}

/** Warcraft III attachment names are a documented vocabulary; only exact matches narrow the role. */
function socketRole(name: string): string {
  const lowered = name.toLowerCase()
  if (lowered.includes('overhead')) return 'overhead'
  if (lowered.includes('origin')) return 'origin'
  if (lowered.includes('foot')) return 'foot'
  if (lowered.includes('hand')) return 'hand'
  if (lowered.includes('weapon')) return 'weapon'
  if (lowered.includes('chest')) return 'chest'
  if (lowered.includes('head')) return 'head'
  if (lowered.includes('sprite')) return 'sprite'
  return 'attach'
}

/**
 * Collision volumes — `common.view/model-collision-source`.
 *
 * Warcraft III declares a box by two opposite corners and a sphere by one point and a radius.
 * Both are declared volumes, never a mesh carrying a collision role.
 */
export function war3Collisions(model: RenderModel) {
  const known = new Set(readWar3Nodes(model).map(node => node.index))
  return metadataRecords(model, 'war3Collisions').map((record, ordinal) => {
    const own = record['ownNodeIndex']
    return {
      id: `war3-collision-${String(ordinal)}`,
      kind: record['kind'] === 'sphere' ? 'sphere' : 'box',
      origin: 'declared-volume' as const,
      types: ['collision'],
      ...(typeof own === 'number' && known.has(own) ? { ownNodeId: nodeId(own) } : {}),
      ...(collisionShape(record) === undefined ? {} : { shape: collisionShape(record)! }),
    }
  })
}

/**
 * A Warcraft III collision volume in the common vocabulary.
 *
 * The native record is two corner points for a box or a centre and a radius for a sphere; UVM
 * states a box by its extents and a sphere by its radius. A volume with no extent in some axis -
 * a degenerate box - has nothing to state, so it is left out rather than widened to a minimum
 * the model never declared. The result is the sdk's `ModelCollisionShape` (a `size` of three
 * extents) and plain JSON, which the UVM pass writes as is.
 */
function collisionShape(record: Record<string, unknown>) {
  const vertices = Array.isArray(record['vertices'])
    ? record['vertices'].map(value => finiteNumber(value))
    : []
  if (record['kind'] === 'sphere') {
    const radius = finiteNumber(record['radius'])
    if (radius === undefined || radius <= 0) return undefined
    const centre = vertices.slice(0, 3)
    const matrix =
      centre.length === 3 && centre.every(value => value !== undefined)
        ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, centre[0]!, centre[1]!, centre[2]!, 1]
        : undefined
    return { kind: 'sphere' as const, radius, ...(matrix === undefined ? {} : { matrix }) }
  }
  if (vertices.length < 6 || vertices.some(value => value === undefined)) return undefined
  const extent = (axis: number) => Math.abs(vertices[axis + 3]! - vertices[axis]!)
  const size: [number, number, number] = [extent(0), extent(1), extent(2)]
  if (size.some(value => !(value > 0))) return undefined
  const centre = [0, 1, 2].map(axis => (vertices[axis]! + vertices[axis + 3]!) / 2)
  return {
    kind: 'box' as const,
    size,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, centre[0]!, centre[1]!, centre[2]!, 1],
  }
}

/**
 * The model's materials: one per layer pass (`war3PassMaterials`), which is how the game draws them.
 * A render model read without its passes keeps one material per native material.
 */
export function war3Materials(model: RenderModel) {
  return war3PassMaterials(model)
}

/** One native material as its layer list alone, for a render model that states no passes. */
function war3Material(material: RenderMaterial, index: number) {
  return {
    id: materialId(index),
    name: material.name === '' ? `Material ${String(index)}` : material.name,
    layers: material.layers.map((layer: RenderTextureLayer) => ({
      slot: layerSlot(layer.label),
      ...(layer.path === '' ? {} : { resourceId: layer.path }),
    })),
  }
}

/**
 * The Warcraft III node hierarchy, published as the skeleton facet.
 *
 * MDX keeps bones, helpers, attachments, emitters and collision shapes in one object-id space and
 * parents them to each other freely — a bone hanging off a helper is ordinary. Publishing only the
 * bones would break exactly those parent links, so every node is a binding and `flagNames` says
 * which ones geosets actually bind to.
 */
export function war3SkeletonBindings(model: RenderModel) {
  const war3Nodes = readWar3Nodes(model)
  const byIndex = new Map(war3Nodes.map(node => [node.index, node]))
  const boneIndices = new Set(model.skeleton.bones.map(bone => bone.index))
  return war3Nodes.map(node => ({
    partId: WAR3_ROOT_NODE_ID,
    boneIndex: node.index,
    boneName: node.name === '' ? null : node.name,
    provenance: 'direct' as const,
    hierarchyId: WAR3_ROOT_NODE_ID,
    // A parent that is not itself in the hierarchy cannot be honoured; such a node is a root here
    // and the residual keeps the native parent id.
    parentBoneIndex:
      node.parentIndex >= 0 && byIndex.has(node.parentIndex) ? node.parentIndex : null,
    nodeId: nodeId(node.index),
    nativeFlags: node.flags,
    ...(boneIndices.has(node.index) ? { flagNames: ['bone'] as const } : {}),
    // A Warcraft III node's bind pose is the pivot hierarchy with no authored rotation or scale.
    // Its bind transform in model space is a pure translation to the absolute pivot, and the
    // inverse is the translation back. Both are read off the document.
    localPose: {
      translation: pivotOffset(node, byIndex),
      rotation: [0, 0, 0, 1] as const,
      scale: [1, 1, 1] as const,
    },
    inverseBindMatrix: Object.freeze([
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      -node.pivot[0],
      -node.pivot[1],
      -node.pivot[2],
      1,
    ]),
  }))
}

/**
 * MDX interpolation. Hermite (2) and Bezier (3) become `cubic-spline`, whose tangents are the
 * derivative per second (glTF CUBICSPLINE); an unknown line type stays unstated, which the facet
 * documents as "cannot be sampled generically" rather than claiming linear.
 */
function channelInterpolation(
  lineType: number,
  kind: 'rotation' | 'translation' | 'scale',
): 'step' | 'linear' | 'spherical-linear' | 'cubic-spline' | undefined {
  if (lineType === 0) return 'step'
  if (lineType === 1) return kind === 'rotation' ? 'spherical-linear' : 'linear'
  if (lineType === 2 || lineType === 3) return 'cubic-spline'
  return undefined
}

/**
 * One side of a key as a derivative per second. MDX states a Hermite tangent over the whole key
 * interval and a Bezier control point beside the key (m = 3·(control − value) leaving it,
 * 3·(value − control) arriving), so both divide by that interval's seconds. The first key has
 * no arriving interval and the last no leaving one: zero, as glTF ignores them.
 */
function derivative(
  lineType: 2 | 3,
  key: War3AnimationKey,
  side: 'inTan' | 'outTan',
  spanSeconds: number,
): number[] | undefined {
  if (spanSeconds === 0) return key.vector.map(() => 0)
  const tangent = key[side]
  if (!(spanSeconds > 0) || tangent?.length !== key.vector.length) return undefined
  const result = key.vector.map((value, index) => {
    const authored = tangent[index]!
    if (lineType === 2) return authored / spanSeconds
    return (3 * (side === 'outTan' ? authored - value : value - authored)) / spanSeconds
  })
  return result.every(Number.isFinite) ? result : undefined
}

function trackChannels(
  node: War3Node,
  kind: 'translation' | 'rotation' | 'scale',
  track: War3AnimationTrack | undefined,
  startFrame: number,
  endFrame: number,
  /** Added to every translation key: MDX keys move a node from its pivot (WhiteoutFlakes
   * `mdx_animation.cpp`), and a channel replaces the rest translation, which is that pivot's
   * offset from the parent's. Without it a keyed bone jumped to its parent's pivot. */
  rest: readonly [number, number, number] = [0, 0, 0],
  /** Global sequence lengths in milliseconds (`war3GlobalSequences`). */
  globalSequences: readonly unknown[] = [],
) {
  if (track === undefined) return []
  // A global-sequence track runs in every clip on its own clock, from 0 to the global sequence's
  // length and around again (flies, flags, rotors): a concurrent channel wrapping at that length.
  const globalLength = track.globalSeqId === null ? undefined : finiteNumber(globalSequences[track.globalSeqId])
  if (track.globalSeqId !== null && !(globalLength !== undefined && globalLength > 0)) return []
  const keys =
    globalLength === undefined
      ? track.keys.filter(key => key.frame >= startFrame && key.frame <= endFrame)
      : track.keys.filter(key => key.frame >= 0 && key.frame <= globalLength)
  if (keys.length === 0) return []
  const origin = globalLength === undefined ? startFrame : 0
  const seconds = (index: number) => keys[index]!.frame / 1000
  const tangents =
    track.lineType === 2 || track.lineType === 3
      ? keys.map((key, index) => {
          const lineType = track.lineType as 2 | 3
          const inTangent = derivative(lineType, key, 'inTan', index === 0 ? 0 : seconds(index) - seconds(index - 1))
          const outTangent = derivative(
            lineType,
            key,
            'outTan',
            index === keys.length - 1 ? 0 : seconds(index + 1) - seconds(index),
          )
          return inTangent === undefined || outTangent === undefined ? undefined : { inTangent, outTangent }
        })
      : undefined
  // A key without its tangents leaves the curve unknown: the channel then states no interpolation.
  const interpolation =
    tangents?.some(tangent => tangent === undefined) === true
      ? undefined
      : channelInterpolation(track.lineType, kind)
  return [
    {
      // The scene-node id, not the native name: this is what joins a channel to a node.
      target: nodeId(node.index),
      kind,
      firstFrame: 0,
      lastFrame: keys.length - 1,
      ...(interpolation === undefined ? {} : { interpolation }),
      ...(globalLength === undefined ? {} : { concurrent: true, wrapSeconds: globalLength / 1000 }),
      samples: keys.map((key, ordinal) => ({
        frame: ordinal,
        timeMilliseconds: key.frame,
        timeSeconds: (key.frame - origin) / 1000,
        value:
          kind === 'translation'
            ? [0, 1, 2].map(axis => Math.fround((key.vector[axis] ?? 0) + rest[axis]!))
            : key.vector,
        ...(interpolation === 'cubic-spline' ? tangents![ordinal] : {}),
      })),
    },
  ]
}

/** The projection's id of the model's sequence `index` (its clip). */
export const war3ClipId = (index: number): string => `war3-sequence-${String(index)}`

export function war3AnimationClips(model: RenderModel) {
  const war3Nodes = readWar3Nodes(model)
  const byIndex = new Map(war3Nodes.map(node => [node.index, node]))
  const rawGlobal = model.metadata?.['war3GlobalSequences']
  const globalSequences: readonly unknown[] = Array.isArray(rawGlobal) ? rawGlobal : []
  return model.animations.map((animation: RenderAnimation, index: number) => {
    const metadata = animation.metadata ?? {}
    const nonLooping = metadata['nonLooping']
    const startFrame = animation.startFrame ?? 0
    const endFrame = animation.endFrame ?? startFrame
    const channels = [
      ...war3Nodes.flatMap(node => [
        ...trackChannels(
          node,
          'translation',
          node.animation?.translation,
          startFrame,
          endFrame,
          pivotOffset(node, byIndex),
          globalSequences,
        ),
        ...trackChannels(node, 'rotation', node.animation?.rotation, startFrame, endFrame, undefined, globalSequences),
        ...trackChannels(node, 'scale', node.animation?.scaling, startFrame, endFrame, undefined, globalSequences),
      ]),
      ...visibilityChannels(model, startFrame, endFrame),
    ]
    const events = war3ClipEvents(war3Nodes, startFrame, endFrame, globalSequences)
    return {
      id: war3ClipId(index),
      name: animation.name === '' ? `Sequence ${String(index)}` : animation.name,
      kind: 'animation' as const,
      provenance: 'direct' as const,
      // MDX sequence intervals are milliseconds; the frame count is that span, not a key count.
      frames: Math.max(0, Math.round(endFrame - startFrame)),
      durationSeconds: animation.durationSeconds,
      sequenceIndex: index,
      hierarchyId: WAR3_ROOT_NODE_ID,
      nativeTimeBounds: { startMilliseconds: startFrame, endMilliseconds: endFrame },
      ...(typeof nonLooping === 'boolean' ? { looping: !nonLooping } : {}),
      channels,
      ...(events.length === 0 ? {} : { events }),
    }
  })
}

export function war3SceneInfo(model: RenderModel, textures: number) {
  return {
    scenes: 1,
    nodes: readWar3Nodes(model).length + model.meshes.length + 1,
    meshes: model.meshes.length,
    // A geoset draws one primitive per layer pass.
    primitives: model.meshes.reduce(
      (count: number, mesh: RenderMesh) => count + (geosetPasses(model, mesh)?.length ?? 1),
      0,
    ),
    materials: model.materials.length,
    textures,
    animations: model.animations.length,
    ...(model.bounds === undefined || model.bounds === null
      ? {}
      : {
          bounds: {
            min: [model.bounds.min.x, model.bounds.min.y, model.bounds.min.z] as const,
            max: [model.bounds.max.x, model.bounds.max.y, model.bounds.max.z] as const,
          },
        }),
    // Always decoded: this codec reads the geosets out of the document. A model with no geoset —
    // an emitter-only helper, for instance — has no geometry, which is not the same as geometry
    // this source cannot reach.
    // StarCraft II, Warcraft III and Diablo III all publish z-up geometry; a viewer that
    // assumed the glTF default would lay the model on its side.
    upAxis: '+z' as const,
    geometryAccess: 'decoded' as const,
  }
}
