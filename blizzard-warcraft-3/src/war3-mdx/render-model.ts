/**
 * Warcraft III model -> the shared render-model vocabulary.
 *
 * Carried over from the MK2 Warcraft III adapter and now ordinary MK3 code: it compiles under
 * the package's strict profile and speaks `@modkit/codec-kit/legacy/models`, the MK3 home of
 * that vocabulary. Geometry retains up to four authored UV sets; a malformed or unsupported set
 * is refused rather than discarded. PRE2 replacement and draw-state metadata remain native facts.
 * KRCO ribbon colour tracks are retained for the existing UVM sequence-animation publisher.
 * Native KMTE retains its independent authored static header for MDX reconstruction. Writers
 * admit finite exact float32 fallback carriers excluding negative zero; missing legacy carriers
 * keep the previous compatibility default 1, not a recovered source value. MDL refuses an
 * animated non-default header until its native representation is qualified. No playback is added.
 * `MDX-PORT-PROVENANCE.json` records where every line came from.
 */
import { admitWar3MaterialHeaders } from './native-material-headers.js'
import type {
  Bounds,
  ModelFormat,
  ModelParser,
  RenderAnimation,
  RenderMaterial,
  RenderMesh,
  RenderModel,
  RenderModelEffects,
  RenderParticleEmitterAnimation,
  RenderParticleEmitter,
  RenderRibbonEmitterAnimation,
  RenderRibbonEmitter,
  RenderTextureLayer,
} from '@modkit/codec-kit/legacy/models'
import {
  detectWar3ModelFormat,
  isWar3MdlText,
  isWar3MdxBinary,
  type WarcraftModelFormat,
} from './detect.js'
import { generateMDL, generateMDX, parseMDL, parseMDX, type model as War3 } from '../lib/war3-model/index.js'

export { detectWar3ModelFormat, type WarcraftModelFormat } from './detect.js'

export type War3Model = War3.Model
export type War3Geoset = War3.Geoset
export type War3Material = War3.Material

export interface War3RenderModelOptions {
  includeRawMetadata?: boolean
}

const textDecoder = new TextDecoder()
const WAR3_FILTER_MODE_NAMES = [
  'None',
  'Transparent',
  'Blend',
  'Additive',
  'AddAlpha',
  'Modulate',
  'Modulate2x',
] as const
export const WAR3_REPLACEABLE_TEXTURE_PATHS: Readonly<Record<number, string>> = {
  1: 'TeamColor\\TeamColor00',
  2: 'TeamGlow\\TeamGlow00',
  11: 'Cliff\\Cliff0',
  31: 'LordaeronTree\\LordaeronSummerTree',
  32: 'AshenvaleTree\\AshenTree',
  33: 'BarrensTree\\BarrensTree',
  34: 'NorthrendTree\\NorthTree',
  35: 'Mushroom\\MushroomTree',
  36: 'RuinsTree\\RuinsTree',
  37: 'OutlandMushroomTree\\MushroomTree',
}
const WAR3_LAYER_TEXTURE_ID_FIELDS = [
  'TextureID',
  'NormalTextureID',
  'ORMTextureID',
  'EmissiveTextureID',
  'TeamColorTextureID',
  'ReflectionsTextureID',
] as const

type War3LayerTextureIdField = (typeof WAR3_LAYER_TEXTURE_ID_FIELDS)[number]
type War3LayerWithTextureSlots = War3.Layer &
  Partial<Record<War3LayerTextureIdField, War3.Layer['TextureID'] | null>>
type War3UvTransform = [number, number, number, number, number, number, number, number, number]
interface War3AnimationKey {
  frame: number
  vector: number[]
  inTan?: number[]
  outTan?: number[]
}

interface War3AnimationTrack {
  lineType: number
  globalSeqId: number | null
  keys: War3AnimationKey[]
}

interface War3UvAnimation {
  translation?: War3AnimationTrack
  rotation?: War3AnimationTrack
  scaling?: War3AnimationTrack
}

interface War3TextureVariant {
  textureIndex: number
  path: string
}

interface War3NodeAnimation {
  translation?: War3AnimationTrack
  rotation?: War3AnimationTrack
  scaling?: War3AnimationTrack
}

interface War3NodeMetadata {
  index: number
  name: string
  parentIndex: number
  pivot: [number, number, number]
  flags: number
  animation?: War3NodeAnimation
  /** An event object's track (KEVT): the frames it fires at, on its global sequence when it names one. */
  eventTrack?: { frames: number[]; globalSeqId: number | null }
}

export function parseWar3Mdx(bytes: Uint8Array | ArrayBuffer): War3.Model {
  return parseMDX(toArrayBuffer(bytes))
}

export function parseWar3Mdl(input: string | Uint8Array): War3.Model {
  return parseMDL(typeof input === 'string' ? input : textDecoder.decode(input))
}

/** Re-emit native MDX, retaining admitted static KMTE headers separately from their keys. */
export function generateWar3Mdx(model: War3.Model): Uint8Array {
  admitWar3MaterialHeaders(model, 'mdx')
  return new Uint8Array(generateMDX(normalizeMdx1100TextureSlots(model)))
}

/** Re-emit native MDL only when its static/KMTE representation is qualified. */
export function generateWar3Mdl(model: War3.Model): string {
  admitWar3MaterialHeaders(model, 'mdl')
  return generateMDL(model)
}

export function war3ReplaceableTexturePath(
  replaceableId: number | undefined,
  modelVersion = 800,
): string | undefined {
  if (replaceableId === undefined || replaceableId === 0) return undefined
  const relative = WAR3_REPLACEABLE_TEXTURE_PATHS[replaceableId]
  if (!relative) return undefined
  const extension = modelVersion > 800 ? 'dds' : 'blp'
  return `ReplaceableTextures\\${relative}.${extension}`
}

export function parseWar3ModelToRenderModel(
  bytes: Uint8Array,
  hint = '',
  options: War3RenderModelOptions = {},
): RenderModel {
  const format = detectWar3ModelFormat(bytes, hint)
  if (format === 'mdx') return war3ModelToRenderModel(parseWar3Mdx(bytes), 'mdx', options)
  if (format === 'mdl') return war3ModelToRenderModel(parseWar3Mdl(bytes), 'mdl', options)
  throw new Error(`Unsupported Warcraft III model format for hint "${hint}"`)
}

export function war3ModelToRenderModel(
  model: War3.Model,
  format: WarcraftModelFormat,
  options: War3RenderModelOptions = {},
): RenderModel {
  const materials = buildMaterials(model)
  const meshes = model.Geosets.map((geoset, index) => geosetToRenderMesh(geoset, index))
  const effects = buildEffects(model)
  const previewMetadata = {
    ...buildPreviewMetadata(model),
    ...buildWar3RuntimeMetadata(model),
  }
  const metadata = options.includeRawMetadata
    ? {
        version: model.Version,
        info: {
          name: model.Info.Name,
          blendTime: model.Info.BlendTime,
        },
        counts: {
          textures: model.Textures.length,
          materials: model.Materials.length,
          geosets: model.Geosets.length,
          bones: model.Bones.length,
          helpers: model.Helpers.length,
          attachments: model.Attachments.length,
          particles:
            model.ParticleEmitters.length +
            model.ParticleEmitters2.length +
            (model.ParticleEmitterPopcorns?.length ?? 0),
          ribbons: model.RibbonEmitters.length,
          cameras: model.Cameras.length,
          lights: model.Lights.length,
        },
        textures: model.Textures.map(texture => ({
          image: texture.Image,
          replaceableId: texture.ReplaceableId ?? null,
          flags: texture.Flags ?? 0,
        })),
        ...previewMetadata,
      }
    : previewMetadata

  return {
    format,
    meshes,
    skeleton: {
      bones: model.Bones.map((bone, index) => ({
        index: bone.ObjectId ?? index,
        name: bone.Name,
        parentIndex: bone.Parent ?? -1,
      })),
    },
    materials,
    animations: buildAnimations(model),
    bounds: buildBounds(
      model.Info.MinimumExtent,
      model.Info.MaximumExtent,
      model.Info.BoundsRadius,
    ),
    effects,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function buildPreviewMetadata(model: War3.Model): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const camera = model.Cameras[0]
  if (camera?.Position && camera.TargetPosition) {
    out['previewCamera'] = {
      name: camera.Name,
      position: vector3(camera.Position),
      target: vector3(camera.TargetPosition),
      fieldOfView: camera.FieldOfView,
      nearClip: camera.NearClip,
      farClip: camera.FarClip,
    }
  }

  const previewLights = model.Lights.filter(light => light.LightType !== 2)
    .map(light => previewLightMetadata(light, camera))
    .filter((light): light is Record<string, unknown> => light !== null)
  if (previewLights.length > 0) out['previewLights'] = previewLights

  const ambientColor = previewAmbientColor(model.Lights)
  if (ambientColor) out['previewAmbientColor'] = ambientColor

  const light = model.Lights.find(item => item.LightType !== 2)
  if (light) {
    const lightColor = previewLightColor(light)
    out['previewLightColor'] = lightColor
    const direction = previewLightDirection(light, camera)
    if (direction) out['previewLightDirection'] = direction
  }

  return out
}

function buildWar3RuntimeMetadata(model: War3.Model): Record<string, unknown> {
  const nodes = buildWar3NodesMetadata(model)
  const attachments = buildWar3AttachmentMetadata(model)
  const collisions = buildWar3CollisionMetadata(model)
  const geosetAnimations = buildWar3GeosetAnimationMetadata(model)
  const ribbonColorTracks = model.RibbonEmitters.flatMap((emitter, index) =>
    isAnimVector(emitter.Color) ? [{ index, track: animVectorTrack(emitter.Color, 3) }] : [])
  return {
    ...(nodes.length > 0 ? { war3Nodes: nodes } : {}),
    ...(attachments.length > 0 ? { war3Attachments: attachments } : {}),
    ...(collisions.length > 0 ? { war3Collisions: collisions } : {}),
    ...(geosetAnimations.length > 0 ? { war3GeosetAnimations: geosetAnimations } : {}),
    // Legacy ribbon animation lacks a colour member; the existing UVM sequence vocabulary has it.
    ...(ribbonColorTracks.length > 0 ? { war3RibbonColorTracks: ribbonColorTracks } : {}),
    // Native material facts do not become unrecognized fields of UV_game_effects.
    ...(model.ParticleEmitters2.length === 0 ? {} : { war3ParticleMaterials: model.ParticleEmitters2.map((emitter, index) => ({
      index: model.ParticleEmitters.length + index,
      priorityPlane: emitter.PriorityPlane ?? 0,
      replaceableId: emitter.ReplaceableId ?? 0,
      unshaded: ((emitter.Flags ?? 0) & 0x8000) !== 0,
      sortPrimsFarZ: ((emitter.Flags ?? 0) & 0x10000) !== 0,
      // Preserve the native fog bit without inventing a common material fog contract.
      unfogged: ((emitter.Flags ?? 0) & 0x40000) !== 0,
    })) }),
    // Global sequence lengths in milliseconds: the clock a track with a GlobalSeqId runs on.
    ...(model.GlobalSequences.length > 0 ? { war3GlobalSequences: Array.from(model.GlobalSequences) } : {}),
  }
}

/**
 * Object ids address nodes inside the file; the scene addresses them by their position in the
 * node list. Resolving that here keeps the file's addressing in the adapter that reads the file.
 */
function war3NodeIndexByObjectId(model: War3.Model): ReadonlyMap<number, number> {
  const out = new Map<number, number>()
  for (const [index, node] of war3NodeObjects(model).entries()) {
    const objectId = node['ObjectId']
    if (typeof objectId === 'number' && Number.isSafeInteger(objectId) && !out.has(objectId))
      out.set(objectId, index)
  }
  return out
}

/**
 * Attachment points, as the model declares them.
 *
 * A Warcraft III attachment is an ordinary node with a name and an optional id; the name is the
 * only thing that says what it is for, and scripts reference it verbatim, so it is carried as
 * written rather than mapped onto a guessed role.
 */
/**
 * Warcraft III pads a name into a fixed-width field, so a declared name can arrive with trailing
 * spaces after its NUL trim. The padding is not part of the name; everything inside it is kept.
 */
function trimmedName(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').replace(/\s+$/u, '')
  return trimmed === '' ? fallback : trimmed
}

function buildWar3AttachmentMetadata(model: War3.Model): Record<string, unknown>[] {
  const byObjectId = war3NodeIndexByObjectId(model)
  const nodeIndexOf = (attachment: War3.Attachment): number | undefined =>
    (typeof attachment.Parent === 'number' ? byObjectId.get(attachment.Parent) : undefined) ??
    byObjectId.get(attachment.ObjectId)
  return model.Attachments.map((attachment, ordinal) => {
    const nodeIndex = nodeIndexOf(attachment)
    // A Warcraft III attachment is itself a node, and that node is where its transform and any
    // animation live. `nodeIndex` names the bone it hangs on; `ownNodeIndex` names the attachment
    // itself, which is what a writer has to put back.
    const ownNodeIndex = byObjectId.get(attachment.ObjectId)
    return {
      ordinal,
      name: trimmedName(attachment.Name, `Attachment ${String(ordinal)}`),
      ...(nodeIndex === undefined ? {} : { nodeIndex }),
      ...(ownNodeIndex === undefined ? {} : { ownNodeIndex }),
      ...(attachment.AttachmentID === undefined ? {} : { attachmentId: attachment.AttachmentID }),
      ...(attachment.Path === undefined || attachment.Path === ''
        ? {}
        : { path: attachment.Path }),
      pivot: Array.from(attachment.PivotPoint ?? []),
    }
  })
}

/** Collision shapes. Warcraft III declares boxes by two corners and spheres by one radius. */
function buildWar3CollisionMetadata(model: War3.Model): Record<string, unknown>[] {
  const byObjectId = war3NodeIndexByObjectId(model)
  return model.CollisionShapes.map((shape, ordinal) => {
    const vertices = Array.from(shape.Vertices ?? [])
    // Like an attachment, a collision shape is a node; naming it lets a writer rebuild the volume
    // where the model had it instead of at the origin.
    const ownNodeIndex = byObjectId.get(shape.ObjectId)
    return {
      ordinal,
      name: trimmedName(shape.Name, `CollisionShape ${String(ordinal)}`),
      ...(ownNodeIndex === undefined ? {} : { ownNodeIndex }),
      // War3.CollisionShapeType.Sphere is 2; the import here is type-only, so the value is
      // stated rather than dereferenced.
      kind: shape.Shape === 2 ? 'sphere' : 'box',
      vertices,
      ...(shape.BoundsRadius === undefined ? {} : { radius: shape.BoundsRadius }),
      pivot: Array.from(shape.PivotPoint ?? []),
    }
  })
}

function buildWar3NodesMetadata(model: War3.Model): War3NodeMetadata[] {
  return war3NodeObjects(model)
    .map((node, fallbackIndex) =>
      war3NodeMetadata(node, model.PivotPoints[fallbackIndex], fallbackIndex),
    )
    .filter((node): node is War3NodeMetadata => node !== null)
    .sort((a, b) => a.index - b.index)
}

type War3NodeLike = Record<string, unknown>

function war3NodeObjects(model: War3.Model): War3NodeLike[] {
  const nodes = model.Nodes as unknown as War3NodeLike[]
  if (Array.isArray(nodes) && nodes.length > 0) return nodes
  return [
    ...(model.Bones as unknown as War3NodeLike[]),
    ...(model.Helpers as unknown as War3NodeLike[]),
    ...(model.Attachments as unknown as War3NodeLike[]),
    ...(model.Lights as unknown as War3NodeLike[]),
    ...(model.ParticleEmitters as unknown as War3NodeLike[]),
    ...(model.ParticleEmitters2 as unknown as War3NodeLike[]),
    ...((model.ParticleEmitterPopcorns ?? []) as unknown as War3NodeLike[]),
    ...(model.RibbonEmitters as unknown as War3NodeLike[]),
    ...(model.EventObjects as unknown as War3NodeLike[]),
    ...(model.CollisionShapes as unknown as War3NodeLike[]),
  ]
}

function war3NodeMetadata(
  node: War3NodeLike,
  fallbackPivot: Float32Array | undefined,
  fallbackIndex: number,
): War3NodeMetadata | null {
  const rawIndex = node['ObjectId']
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? rawIndex : fallbackIndex
  if (!Number.isFinite(index) || index < 0) return null
  const rawParent = node['Parent']
  const parentIndex = typeof rawParent === 'number' && Number.isFinite(rawParent) ? rawParent : -1
  const rawFlags = node['Flags']
  const animation = war3NodeAnimation(node)
  const out: War3NodeMetadata = {
    index,
    // Same padding rule as attachments: `Origin Ref ` and its socket `Origin Ref` are one name.
    name: trimmedName(typeof node['Name'] === 'string' ? node['Name'] : undefined, `Node_${index}`),
    parentIndex,
    pivot: vector3(
      (node['PivotPoint'] as Float32Array | undefined) ??
        fallbackPivot ??
        new Float32Array([0, 0, 0]),
    ),
    flags: typeof rawFlags === 'number' && Number.isFinite(rawFlags) ? rawFlags : 0,
  }
  if (animation) out.animation = animation
  const eventTrack = node['EventTrack']
  if (eventTrack instanceof Uint32Array && eventTrack.length > 0) {
    const globalSeqId = node['GlobalSeqId']
    out.eventTrack = {
      frames: Array.from(eventTrack),
      globalSeqId: typeof globalSeqId === 'number' && Number.isSafeInteger(globalSeqId) && globalSeqId >= 0 ? globalSeqId : null,
    }
  }
  return out
}

function war3NodeAnimation(node: War3NodeLike): War3NodeAnimation | undefined {
  const animation: War3NodeAnimation = {}
  const translation = animVectorTrack(node['Translation'] as War3.AnimVector | undefined, 3)
  const rotation = animVectorTrack(node['Rotation'] as War3.AnimVector | undefined, 4)
  const scaling = animVectorTrack(node['Scaling'] as War3.AnimVector | undefined, 3)
  if (translation) animation.translation = translation
  if (rotation) animation.rotation = rotation
  if (scaling) animation.scaling = scaling
  return Object.keys(animation).length > 0 ? animation : undefined
}

function previewLightMetadata(
  light: War3.Light,
  camera: War3.Camera | undefined,
): Record<string, unknown> | null {
  const direction = previewLightDirection(light, camera)
  if (!direction) return null
  return {
    name: light.Name,
    type: light.LightType,
    direction,
    color: previewLightColor(light),
    ...(light.PivotPoint ? { position: vector3(light.PivotPoint) } : {}),
    ...(typeof light.AttenuationStart === 'number'
      ? { attenuationStart: light.AttenuationStart }
      : {}),
    ...(typeof light.AttenuationEnd === 'number' ? { attenuationEnd: light.AttenuationEnd } : {}),
  }
}

function previewAmbientColor(lights: readonly War3.Light[]): [number, number, number] | undefined {
  let r = 0
  let g = 0
  let b = 0
  let found = false
  for (const light of lights) {
    if (light.LightType !== 2) continue
    const color = staticFloat3(light.AmbColor) ?? staticFloat3(light.Color) ?? [1, 1, 1]
    const intensity = staticNumber(light.AmbIntensity) ?? staticNumber(light.Intensity) ?? 1
    r += color[0] * intensity
    g += color[1] * intensity
    b += color[2] * intensity
    found = true
  }
  return found ? [clamp01(r), clamp01(g), clamp01(b)] : undefined
}

function previewLightColor(light: War3.Light): [number, number, number] {
  const color = staticFloat3(light.Color) ?? staticFloat3(light.AmbColor) ?? [1, 1, 1]
  const intensity = staticNumber(light.Intensity) ?? staticNumber(light.AmbIntensity) ?? 1
  return [
    clamp01(color[0] * intensity),
    clamp01(color[1] * intensity),
    clamp01(color[2] * intensity),
  ]
}

function previewLightDirection(
  light: War3.Light,
  camera: War3.Camera | undefined,
): [number, number, number] | undefined {
  if (
    light.PivotPoint &&
    Math.hypot(light.PivotPoint[0] ?? 0, light.PivotPoint[1] ?? 0, light.PivotPoint[2] ?? 0) > 0
  ) {
    return vector3(light.PivotPoint)
  }
  if (camera?.Position && camera.TargetPosition) {
    const position = camera.Position
    const target = camera.TargetPosition
    return [
      (position[0] ?? 0) - (target[0] ?? 0),
      (position[1] ?? 0) - (target[1] ?? 0),
      (position[2] ?? 0) - (target[2] ?? 0),
    ]
  }
  return undefined
}

export class MdxModelParser implements ModelParser {
  readonly format: ModelFormat = 'mdx'

  constructor(private readonly options: War3RenderModelOptions = {}) {}

  canParse(headerMagic: Uint8Array): boolean {
    return isWar3MdxBinary(headerMagic)
  }

  parse(bytes: Uint8Array): RenderModel {
    return war3ModelToRenderModel(parseWar3Mdx(bytes), 'mdx', this.options)
  }
}

export class MdlModelParser implements ModelParser {
  readonly format: ModelFormat = 'mdl'

  constructor(private readonly options: War3RenderModelOptions = {}) {}

  canParse(headerMagic: Uint8Array): boolean {
    return isWar3MdlText(headerMagic)
  }

  parse(bytes: Uint8Array): RenderModel {
    return war3ModelToRenderModel(parseWar3Mdl(bytes), 'mdl', this.options)
  }
}

export function createMdxModelParser(options: War3RenderModelOptions = {}): MdxModelParser {
  return new MdxModelParser(options)
}

export function createMdlModelParser(options: War3RenderModelOptions = {}): MdlModelParser {
  return new MdlModelParser(options)
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function normalizeMdx1100TextureSlots(model: War3.Model): War3.Model {
  if (model.Version < 1100) return model

  let changed = false
  const materials = model.Materials.map(material => {
    let materialChanged = false
    const layers = material.Layers.map(layer => {
      const highestSlot = highestDefinedLayerTextureSlot(layer)
      if (highestSlot <= 0) return layer

      const normalized = { ...layer } as War3LayerWithTextureSlots
      let layerChanged = false
      for (let slot = 0; slot < highestSlot; slot += 1) {
        const field = WAR3_LAYER_TEXTURE_ID_FIELDS[slot]
        if (field && (normalized[field] === undefined || normalized[field] === null)) {
          normalized[field] = -1
          layerChanged = true
        }
      }

      if (!layerChanged) return layer
      materialChanged = true
      changed = true
      return normalized
    })

    return materialChanged ? { ...material, Layers: layers } : material
  })

  return changed ? { ...model, Materials: materials } : model
}

function highestDefinedLayerTextureSlot(layer: War3.Layer): number {
  const layerSlots = layer as War3LayerWithTextureSlots
  let highestSlot = -1
  for (let slot = 0; slot < WAR3_LAYER_TEXTURE_ID_FIELDS.length; slot += 1) {
    const field = WAR3_LAYER_TEXTURE_ID_FIELDS[slot]
    if (field && layerSlots[field] !== undefined && layerSlots[field] !== null) highestSlot = slot
  }
  return highestSlot
}

function buildMaterials(model: War3.Model): RenderMaterial[] {
  // Crystal has a different native program; the shared HD PBR material is not its substitute.
  // Refuse before either the legacy preview or the UVM projection can draw it as ordinary HD.
  for (const [materialIndex, material] of model.Materials.entries()) {
    if (material.Shader?.toLowerCase() === 'shader_hd_crystal' ||
        material.Layers.some(layer => layer.ShaderTypeId === 24))
      throw new Error(`Warcraft III material ${materialIndex}: Crystal shader (24/Shader_HD_Crystal) has no supported common projection`)
  }
  return model.Materials.map((material, materialIndex) => ({
    name: material.Shader ?? `Material_${materialIndex}`,
    layers: material.Layers.flatMap((layer, layerIndex) =>
      materialLayerToTextureLayers(model, layer, layerIndex),
    ),
    metadata: {
      source: 'war3',
      shader: material.Shader ?? null,
      priorityPlane: material.PriorityPlane ?? 0,
      renderMode: material.RenderMode ?? 0,
      layerCount: material.Layers.length,
      // Every native layer as the pass the game draws: `layers` above folds a layer that repeats
      // another's texture into it, and Warcraft III draws both.
      war3Passes: material.Layers.map((layer, layerIndex) => war3LayerPass(model, layer, layerIndex)),
    },
  }))
}

/**
 * One MDX layer as one draw pass over its geoset (mdx-m3-viewer `Layer`, WhiteoutFlakes WC3 profile):
 * its filter mode and shading flags set the pass's blend, depth and culling state, its own alpha
 * scales the pass, and its texture slots are what it samples.
 */
function war3LayerPass(
  model: War3.Model,
  layer: War3.Layer,
  layerIndex: number,
): Record<string, unknown> {
  const slots: { label: string; path: string }[] = []
  // A slot whose texture id is a track (KMTF) is a flipbook: the texture each id names, and the track.
  const flipbooks: { label: string; track: War3AnimationTrack; paths: Record<string, string> }[] = []
  for (const [label, field] of [
    ['diffuse', 'TextureID'],
    ['normal', 'NormalTextureID'],
    ['orm', 'ORMTextureID'],
    ['emissive', 'EmissiveTextureID'],
    ['teamColor', 'TeamColorTextureID'],
    ['reflections', 'ReflectionsTextureID'],
  ] as const) {
    const value = (layer as War3LayerWithTextureSlots)[field]
    const texture = textureInfo(model, staticOrFirstNumber(value))
    if (texture) slots.push({ label, path: texture.image })
    const track = scalarAnimationTrack(value)
    if (track !== undefined) {
      const paths: Record<string, string> = {}
      for (const key of track.keys) {
        const id = key.vector[0] ?? 0
        const image = textureInfo(model, id)?.image
        if (image !== undefined) paths[String(id)] = image
      }
      flipbooks.push({ label, track, paths })
    }
  }
  const diffuse = textureInfo(model, staticOrFirstNumber(layer.TextureID))
  return {
    layerIndex,
    // Reforged's shader: 1 the HD (PBR) shader, 0 or absent the classic fixed function.
    shaderTypeId: layer.ShaderTypeId ?? null,
    // The HD shader's emissive multiplier; a static 0 switches the emissive map off.
    emissiveGain: staticNumber(layer.EmissiveGain) ?? 1,
    filterMode: layer.FilterMode ?? 0,
    shading: layer.Shading ?? 0,
    alpha: staticNumber(layer.Alpha) ?? 1,
    alphaTrack: scalarAnimationTrack(layer.Alpha) ?? null,
    coordId: layer.CoordId ?? 0,
    replaceableId: diffuse?.replaceableId ?? null,
    textureFlags: diffuse?.flags ?? 0,
    // The layer's texture animation (TXAN): translation, rotation and scaling of its UVs.
    uvAnimation: war3LayerUvAnimation(model, layer) ?? null,
    slots,
    ...(flipbooks.length === 0 ? {} : { flipbooks }),
  }
}

/**
 * Geoset animations: the alpha that shows or hides a geoset (a death's gore, a decay's bones) and
 * the colour that tints it. A track keyed in some sequences leaves the others at the static value,
 * which the parser keeps only when no track replaced it, so a tracked geoset reads 1 there — what
 * mdx-m3-viewer and W3ModelViewer both do.
 */
function buildWar3GeosetAnimationMetadata(model: War3.Model): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<number>()
  for (const animation of model.GeosetAnims ?? []) {
    const geosetIndex = animation.GeosetId
    // The game reads the first animation that names a geoset.
    if (!Number.isSafeInteger(geosetIndex) || geosetIndex < 0 || seen.has(geosetIndex)) continue
    seen.add(geosetIndex)
    const alphaTrack = scalarAnimationTrack(animation.Alpha)
    const color = staticFloat3(animation.Color instanceof Float32Array ? animation.Color : undefined)
    const colorTrack = isAnimVector(animation.Color) ? animVectorTrack(animation.Color, 3) : undefined
    out.push({
      geosetIndex,
      alpha: staticNumber(animation.Alpha) ?? 1,
      ...(alphaTrack === undefined ? {} : { alphaTrack }),
      // A fixed colour is stored red first, a track's keys blue first (mdx-m3-viewer
      // `GeosetAnimation`, WhiteoutFlakes `mdx_model_adapter.cpp`); both are published red first.
      ...(color === undefined ? {} : { color: [color[0], color[1], color[2]] }),
      ...(colorTrack === undefined
        ? {}
        : {
            colorTrack: {
              ...colorTrack,
              keys: colorTrack.keys.map(key => ({
                ...key,
                vector: [key.vector[2] ?? 1, key.vector[1] ?? 1, key.vector[0] ?? 1],
              })),
            },
          }),
      flags: animation.Flags ?? 0,
    })
  }
  return out
}

function materialLayerToTextureLayers(
  model: War3.Model,
  layer: War3.Layer,
  layerIndex: number,
): RenderTextureLayer[] {
  const layers: RenderTextureLayer[] = []

  addTextureLayer(layers, 'diffuse', model, layer.TextureID, layer, layerIndex)
  addTextureLayer(layers, 'normal', model, layer.NormalTextureID, layer, layerIndex)
  addTextureLayer(layers, 'orm', model, layer.ORMTextureID, layer, layerIndex)
  addTextureLayer(layers, 'emissive', model, layer.EmissiveTextureID, layer, layerIndex)
  addTextureLayer(layers, 'teamColor', model, layer.TeamColorTextureID, layer, layerIndex)
  addTextureLayer(layers, 'reflections', model, layer.ReflectionsTextureID, layer, layerIndex)

  return layers
}

function addTextureLayer(
  layers: RenderTextureLayer[],
  label: string,
  model: War3.Model,
  textureId: War3.Layer['TextureID'] | undefined | null,
  sourceLayer: War3.Layer,
  sourceLayerIndex: number,
): void {
  const textureIndex = staticOrFirstNumber(textureId)
  const texture = textureInfo(model, textureIndex)
  if (!texture) return
  const path = texture.image
  if (layers.some(layer => layer.label === label && layer.path === path)) return
  layers.push({
    label,
    path,
    metadata: war3LayerMetadata(model, sourceLayer, sourceLayerIndex, texture, textureId),
  })
}

function war3LayerMetadata(
  model: War3.Model,
  layer: War3.Layer,
  layerIndex: number,
  texture: {
    index: number
    replaceableId: number | null
    flags: number
    syntheticReplaceablePath: boolean
  },
  textureId: War3.Layer['TextureID'] | undefined | null,
): Record<string, unknown> {
  const filterMode = layer.FilterMode ?? 0
  const uvTransform = war3LayerUvTransform(model, layer)
  const uvAnimation = war3LayerUvAnimation(model, layer)
  const alphaAnimation = scalarAnimationTrack(layer.Alpha)
  const textureIdAnimation = scalarAnimationTrack(textureId)
  const textureVariants = textureVariantMetadata(model, textureId)
  return {
    source: 'war3',
    layerIndex,
    textureIndex: texture.index,
    filterMode,
    filterModeName: WAR3_FILTER_MODE_NAMES[filterMode] ?? `Mode${filterMode}`,
    coordId: layer.CoordId ?? 0,
    alpha: staticOrFirstNumber(layer.Alpha) ?? 1,
    shading: layer.Shading ?? 0,
    tVertexAnimId: layer.TVertexAnimId ?? null,
    replaceableId: texture.replaceableId,
    textureFlags: texture.flags,
    syntheticReplaceablePath: texture.syntheticReplaceablePath,
    alphaAnimation: alphaAnimation ?? null,
    textureIdAnimation: textureIdAnimation ?? null,
    textureVariants: textureVariants ?? null,
    uvTransform: uvTransform ?? null,
    uvAnimation: uvAnimation ?? null,
  }
}

function war3LayerUvTransform(model: War3.Model, layer: War3.Layer): War3UvTransform | undefined {
  if (typeof layer.TVertexAnimId !== 'number') return undefined
  const textureAnim = model.TextureAnims[layer.TVertexAnimId]
  if (!textureAnim) return undefined
  const translation = animVectorValue3(textureAnim.Translation, [0, 0, 0])
  const rotation = animVectorValue4(textureAnim.Rotation, [0, 0, 0, 1])
  const scaling = animVectorValue3(textureAnim.Scaling, [1, 1, 1])
  return textureAnimMatrix(translation, rotation, scaling)
}

function war3LayerUvAnimation(model: War3.Model, layer: War3.Layer): War3UvAnimation | undefined {
  if (typeof layer.TVertexAnimId !== 'number') return undefined
  const textureAnim = model.TextureAnims[layer.TVertexAnimId]
  if (!textureAnim) return undefined
  const animation: War3UvAnimation = {}
  const translation = animVectorTrack(textureAnim.Translation, 3)
  const rotation = animVectorTrack(textureAnim.Rotation, 4)
  const scaling = animVectorTrack(textureAnim.Scaling, 3)
  if (translation) animation.translation = translation
  if (rotation) animation.rotation = rotation
  if (scaling) animation.scaling = scaling
  return Object.keys(animation).length > 0 ? animation : undefined
}

function scalarAnimationTrack(
  value: War3.AnimVector | number | undefined | null,
): War3AnimationTrack | undefined {
  return isAnimVector(value) ? animVectorTrack(value, 1) : undefined
}

function animVectorTrack(
  value: War3.AnimVector | undefined,
  dimensions: number,
): War3AnimationTrack | undefined {
  if (!value || value.Keys.length === 0) return undefined
  const keys = value.Keys.filter(key => key.Vector.length >= dimensions).map(key => {
    const out: War3AnimationKey = {
      frame: key.Frame,
      vector: animVectorComponents(key.Vector, dimensions),
    }
    if (key.InTan && key.InTan.length >= dimensions)
      out.inTan = animVectorComponents(key.InTan, dimensions)
    if (key.OutTan && key.OutTan.length >= dimensions)
      out.outTan = animVectorComponents(key.OutTan, dimensions)
    return out
  })
  if (keys.length === 0) return undefined
  return {
    lineType: value.LineType,
    globalSeqId:
      typeof value.GlobalSeqId === 'number' &&
      Number.isSafeInteger(value.GlobalSeqId) &&
      value.GlobalSeqId >= 0
        ? value.GlobalSeqId
        : null,
    keys,
  }
}

function animVectorComponents(value: Float32Array | Int32Array, dimensions: number): number[] {
  return Array.from(value.slice(0, dimensions), item => finiteNumber(item, 0))
}

function textureVariantMetadata(
  model: War3.Model,
  textureId: War3.Layer['TextureID'] | undefined | null,
): War3TextureVariant[] | undefined {
  const indices = new Set<number>()
  const defaultTextureIndex = staticOrFirstNumber(textureId)
  if (defaultTextureIndex !== undefined) indices.add(Math.trunc(defaultTextureIndex))
  if (isAnimVector(textureId)) {
    for (const key of textureId.Keys) {
      const value = key.Vector[0]
      if (typeof value === 'number' && Number.isFinite(value)) indices.add(Math.trunc(value))
    }
  }

  const variants: War3TextureVariant[] = []
  for (const textureIndex of indices) {
    const texture = textureInfo(model, textureIndex)
    if (texture) variants.push({ textureIndex: texture.index, path: texture.image })
  }
  return variants.length > 0 ? variants : undefined
}

function staticOrFirstNumber(
  value: War3.AnimVector | number | undefined | null,
): number | undefined {
  if (value === null) return undefined
  const staticValue = staticNumber(value)
  if (staticValue !== undefined) return staticValue
  if (!isAnimVector(value)) return undefined
  const first = value.Keys[0]?.Vector[0]
  return typeof first === 'number' && Number.isFinite(first) ? first : undefined
}

function isAnimVector(value: unknown): value is War3.AnimVector {
  return !!value && typeof value === 'object' && Array.isArray((value as War3.AnimVector).Keys)
}

function animVectorValue3(
  value: War3.AnimVector | undefined,
  fallback: readonly [number, number, number],
): [number, number, number] {
  const vector = value?.Keys[0]?.Vector
  if (!vector || vector.length < 3) return [fallback[0], fallback[1], fallback[2]]
  return [
    finiteNumber(vector[0], fallback[0]),
    finiteNumber(vector[1], fallback[1]),
    finiteNumber(vector[2], fallback[2]),
  ]
}

function animVectorValue4(
  value: War3.AnimVector | undefined,
  fallback: readonly [number, number, number, number],
): [number, number, number, number] {
  const vector = value?.Keys[0]?.Vector
  if (!vector || vector.length < 4) return [fallback[0], fallback[1], fallback[2], fallback[3]]
  return [
    finiteNumber(vector[0], fallback[0]),
    finiteNumber(vector[1], fallback[1]),
    finiteNumber(vector[2], fallback[2]),
    finiteNumber(vector[3], fallback[3]),
  ]
}

function textureAnimMatrix(
  translation: readonly [number, number, number],
  rotation: readonly [number, number, number, number],
  scaling: readonly [number, number, number],
): War3UvTransform {
  const x = rotation[0]
  const y = rotation[1]
  const z = rotation[2]
  const w = rotation[3]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const yy = y * y2
  const zz = z * z2
  const wz = w * z2
  return [
    (1 - yy - zz) * scaling[0],
    (xy + wz) * scaling[0],
    0,
    (xy - wz) * scaling[1],
    (1 - xx - zz) * scaling[1],
    0,
    translation[0],
    translation[1],
    1,
  ]
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function geosetToRenderMesh(geoset: War3.Geoset, index: number): RenderMesh {
  const positions = copyFloat32(geoset.Vertices)
  const vertexCount = Math.floor(positions.length / 3)
  const normals =
    geoset.Normals.length === positions.length ? copyFloat32(geoset.Normals) : undefined
  if (geoset.TVertices.length > 4) throw new RangeError(`Geoset ${String(index)} exceeds four supported UV sets`)
  const uvSets = geoset.TVertices.map((coordinates, set) => {
    if (coordinates.length !== vertexCount * 2)
      throw new RangeError(`Geoset ${String(index)} UV set ${String(set)} does not match its vertex count`)
    return copyFloat32(coordinates)
  })
  const skin = buildReforgedSkin(geoset, vertexCount) ?? buildClassicSkin(geoset, vertexCount)
  // Reforged's authored tangents (TANG): xyzw, w the bitangent's handedness, for its normal maps.
  const tangents =
    geoset.Tangents !== undefined && geoset.Tangents.length === vertexCount * 4 ? copyFloat32(geoset.Tangents) : undefined

  return {
    name: geoset.Name ?? `Geoset_${index}`,
    materialIndex: geoset.MaterialID ?? -1,
    positions,
    indices: copyUint16(geoset.Faces),
    ...(normals ? { normals } : {}),
    ...(tangents ? { tangents } : {}),
    ...(uvSets[0] === undefined ? {} : { uvs: uvSets[0] }),
    ...(uvSets[1] === undefined ? {} : { uvs1: uvSets[1] }),
    ...(uvSets[2] === undefined ? {} : { uvs2: uvSets[2] }),
    ...(uvSets[3] === undefined ? {} : { uvs3: uvSets[3] }),
    ...(skin ? { boneIndices: skin.boneIndices, boneWeights: skin.boneWeights } : {}),
    // Reforged's level of detail: 0 the full model, 1-3 coarser copies, -1 drawn at every level.
    ...(geoset.LevelOfDetail === undefined ? {} : { metadata: { levelOfDetail: geoset.LevelOfDetail } }),
  }
}

/**
 * Reforged's own skin (SKIN, format 1000 and later): per vertex four bone indices, then four
 * weights in 1/255. The indices address the same matrix list as the classic groups (mdx-m3-viewer
 * `setupgeosets.ts`), and where a geoset has both the game draws by this one — the classic groups
 * of an HD model are a coarse fallback. `null` when the geoset has none of the right length.
 */
function buildReforgedSkin(
  geoset: War3.Geoset,
  vertexCount: number,
): { boneIndices: Uint16Array; boneWeights: Float32Array } | null {
  const skin = geoset.SkinWeights
  if (skin === undefined || vertexCount === 0 || skin.length !== vertexCount * 8) return null
  const boneIndices = new Uint16Array(vertexCount * 4)
  const boneWeights = new Float32Array(vertexCount * 4)
  for (let vertex = 0; vertex < vertexCount; vertex += 1)
    for (let slot = 0; slot < 4; slot += 1) {
      boneIndices[vertex * 4 + slot] = skin[vertex * 8 + slot] ?? 0
      boneWeights[vertex * 4 + slot] = (skin[vertex * 8 + 4 + slot] ?? 0) / 255
    }
  return { boneIndices, boneWeights }
}

function buildClassicSkin(
  geoset: War3.Geoset,
  vertexCount: number,
): { boneIndices: Uint16Array; boneWeights: Float32Array } | null {
  if (vertexCount === 0 || geoset.VertexGroup.length < vertexCount || geoset.Groups.length === 0)
    return null

  const boneIndices = new Uint16Array(vertexCount * 4)
  const boneWeights = new Float32Array(vertexCount * 4)

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const groupIndex = geoset.VertexGroup[vertexIndex] ?? 0
    const group = geoset.Groups[groupIndex] ?? []
    const influenceCount = Math.min(group.length, 4)
    if (influenceCount === 0) continue

    const weight = 1 / influenceCount
    for (let slot = 0; slot < influenceCount; slot += 1) {
      const offset = vertexIndex * 4 + slot
      boneIndices[offset] = group[slot] ?? 0
      boneWeights[offset] = weight
    }
  }

  return { boneIndices, boneWeights }
}

function buildAnimations(model: War3.Model): RenderAnimation[] {
  return model.Sequences.map(sequence => {
    const start = sequence.Interval[0] ?? 0
    const end = sequence.Interval[1] ?? start
    return {
      name: sequence.Name,
      durationSeconds: Math.max(0, end - start) / 1000,
      startFrame: start,
      endFrame: end,
      concurrent: !sequence.NonLooping,
      priority: sequence.Rarity,
    }
  })
}

function buildEffects(model: War3.Model): RenderModelEffects {
  // Emitter tracks keep this format's authored frame times, which are milliseconds. Declared
  // so a renderer samples them in the right unit without asking which format it is drawing.
  const trackTimeUnit = 'milliseconds' as const
  const particles: RenderParticleEmitter[] = []
  for (const emitter of model.ParticleEmitters) {
    const effect: RenderParticleEmitter = {
      name: emitter.Name,
      // An emitter is a node of the hierarchy itself: its pivot and its own tracks place the
      // particles (mdx-m3-viewer `particle2.ts`), not the bone above it. Every kind below does the same.
      boneIndex: emitter.ObjectId,
      materialIndex: -1,
    }
    const alpha = staticOrFirstNumber(emitter.Visibility)
    const emissionRate = staticOrFirstNumber(emitter.EmissionRate)
    const lifeSpan = staticOrFirstNumber(emitter.LifeSpan)
    const speed = staticOrFirstNumber(emitter.InitVelocity)
    const gravity = staticOrFirstNumber(emitter.Gravity)
    // A version 1 emitter states its spread in radians (mdx-m3-viewer `particle.ts`); the common
    // MDX vocabulary, like ParticleEmitter2's, is degrees.
    const latitudeTrack = degreesOf(emitter.Latitude)
    const latitude = staticOrFirstNumber(latitudeTrack)
    if (alpha !== undefined) effect.alpha = alpha
    if (alpha !== undefined) effect.visibility = alpha
    if (emissionRate !== undefined) effect.emissionRate = emissionRate
    if (lifeSpan !== undefined) effect.lifeSpan = lifeSpan
    if (speed !== undefined) effect.speed = speed
    if (gravity !== undefined) effect.gravity = gravity
    if (latitude !== undefined) effect.latitude = latitude
    const animation = particleEmitterAnimation({
      visibility: emitter.Visibility,
      emissionRate: emitter.EmissionRate,
      lifeSpan: emitter.LifeSpan,
      speed: emitter.InitVelocity,
      gravity: emitter.Gravity,
      latitude: latitudeTrack,
    })
    if (animation) effect.animation = animation
    // Each particle is a model: the game loads the path's .mdx whatever its flags say
    // (mdx-m3-viewer `particleemitterobject.ts`). It is not a texture.
    const path = emitter.Path.trim()
    if (path !== '') effect.modelPaths = [path.replace(/\.mdl$/iu, '.mdx')]
    particles.push(effect)
  }
  for (const emitter of model.ParticleEmitters2) {
    const effect: RenderParticleEmitter = {
      name: emitter.Name,
      boneIndex: emitter.ObjectId,
      materialIndex: -1,
    }
    const width = staticOrFirstNumber(emitter.Width)
    const length = staticOrFirstNumber(emitter.Length)
    const visibility = staticOrFirstNumber(emitter.Visibility)
    const emissionRate = staticOrFirstNumber(emitter.EmissionRate)
    const lifeSpan = numberValue(emitter.LifeSpan)
    const speed = staticOrFirstNumber(emitter.Speed)
    const gravity = staticOrFirstNumber(emitter.Gravity)
    const latitude = staticOrFirstNumber(emitter.Latitude)
    const variation = staticOrFirstNumber(emitter.Variation)
    const tailLength = numberValue(emitter.TailLength)
    const timeMiddle = numberValue(emitter.Time)
    const rows = numberValue(emitter.Rows)
    const columns = numberValue(emitter.Columns)
    const filterMode = numberValue(emitter.FilterMode)
    const particleScaling = tuple3FromNumericArray(emitter.ParticleScaling)
    const segmentColors = segmentColorsFromWar3(emitter.SegmentColor)
    const segmentAlphas = segmentAlphasFromWar3(emitter.Alpha)
    const lifeSpanUvAnim = tuple3FromNumericArray(emitter.LifeSpanUVAnim)
    const decayUvAnim = tuple3FromNumericArray(emitter.DecayUVAnim)
    const tailUvAnim = tuple3FromNumericArray(emitter.TailUVAnim)
    const tailDecayUvAnim = tuple3FromNumericArray(emitter.TailDecayUVAnim)
    if (width !== undefined) effect.width = width
    if (length !== undefined) effect.length = length
    if (emitter.Alpha && emitter.Alpha.length > 0) effect.alpha = (emitter.Alpha[0] ?? 255) / 255
    if (visibility !== undefined) effect.visibility = visibility
    if (emitter.Squirt) effect.squirt = true
    if (emissionRate !== undefined) effect.emissionRate = emissionRate
    if (lifeSpan !== undefined) effect.lifeSpan = lifeSpan
    if (speed !== undefined) effect.speed = speed
    if (gravity !== undefined) effect.gravity = gravity
    if (latitude !== undefined) effect.latitude = latitude
    if (variation !== undefined) effect.variation = variation
    if (tailLength !== undefined) effect.tailLength = tailLength
    if (timeMiddle !== undefined) effect.timeMiddle = timeMiddle
    if (rows !== undefined) effect.rows = rows
    if (columns !== undefined) effect.columns = columns
    if (filterMode !== undefined) effect.filterMode = filterMode
    effect.head = (emitter.FrameFlags & 1) !== 0
    effect.tail = (emitter.FrameFlags & 2) !== 0
    effect.lineEmitter = ((emitter.Flags ?? 0) & 131072) !== 0
    if (((emitter.Flags ?? 0) & 524288) !== 0) effect.modelSpace = true
    effect.xyQuad = ((emitter.Flags ?? 0) & 1048576) !== 0
    if (particleScaling) effect.particleScaling = particleScaling
    if (segmentColors) effect.segmentColors = segmentColors
    if (segmentAlphas) effect.segmentAlphas = segmentAlphas
    if (lifeSpanUvAnim) effect.lifeSpanUvAnim = lifeSpanUvAnim
    if (decayUvAnim) effect.decayUvAnim = decayUvAnim
    if (tailUvAnim) effect.tailUvAnim = tailUvAnim
    if (tailDecayUvAnim) effect.tailDecayUvAnim = tailDecayUvAnim
    const animation = particleEmitterAnimation({
      width: emitter.Width,
      length: emitter.Length,
      visibility: emitter.Visibility,
      emissionRate: emitter.EmissionRate,
      lifeSpan: emitter.LifeSpan,
      speed: emitter.Speed,
      gravity: emitter.Gravity,
      latitude: emitter.Latitude,
      variation: emitter.Variation,
    })
    if (animation) effect.animation = animation
    const replaceableId = emitter.ReplaceableId ?? 0
    particles.push(withOptionalTexture(effect, replaceableId === 0
      ? texturePath(model, emitter.TextureID)
      : war3ReplaceableTexturePath(replaceableId, model.Version)))
  }
  // PopcornFX emitters (CORN) are programs, not MDX particle parameters: popcorn.ts runs their
  // `.pkb` and bakes what they draw (UV_game_baked_particles). Read as an MDX particle, one drew its
  // `.pkfx` path as a texture.

  const ribbons: RenderRibbonEmitter[] = model.RibbonEmitters.map(emitter => {
    const effect: RenderRibbonEmitter = {
      name: emitter.Name,
      boneIndex: emitter.ObjectId,
      materialIndex: emitter.MaterialID ?? -1,
      // Each edge is the emitter's pivot moved up and down its own Y by the heights, a flat strip
      // in that plane (mdx-m3-viewer `ribbon.ts`), not a strip turned to the camera.
      ribbonType: 'planar',
    }
    const heightAbove = staticOrFirstNumber(emitter.HeightAbove)
    const heightBelow = staticOrFirstNumber(emitter.HeightBelow)
    const alpha = staticOrFirstNumber(emitter.Alpha)
    const visibility = staticOrFirstNumber(emitter.Visibility)
    const emissionRate = numberValue(emitter.EmissionRate)
    const lifeSpan = numberValue(emitter.LifeSpan)
    const rows = numberValue(emitter.Rows)
    const columns = numberValue(emitter.Columns)
    const textureSlot = staticOrFirstNumber(emitter.TextureSlot)
    const color = tuple3FromNumericArray(emitter.Color instanceof Float32Array ? emitter.Color : emitter.ColorFallback ?? [1, 1, 1])
    if (heightAbove !== undefined) effect.heightAbove = heightAbove
    if (heightBelow !== undefined) effect.heightBelow = heightBelow
    if (alpha !== undefined) effect.alpha = alpha
    if (visibility !== undefined) effect.visibility = visibility
    if (emissionRate !== undefined) effect.emissionRate = emissionRate
    if (lifeSpan !== undefined) effect.lifeSpan = lifeSpan
    if (rows !== undefined) effect.rows = rows
    if (columns !== undefined) effect.columns = columns
    if (textureSlot !== undefined) effect.textureSlot = textureSlot
    if (color) effect.color = color
    const animation = ribbonEmitterAnimation({
      heightAbove: emitter.HeightAbove,
      heightBelow: emitter.HeightBelow,
      alpha: emitter.Alpha,
      visibility: emitter.Visibility,
      emissionRate: emitter.EmissionRate,
      lifeSpan: emitter.LifeSpan,
      textureSlot: emitter.TextureSlot,
    })
    if (animation) effect.animation = animation
    return withOptionalTexture(effect, texturePathForMaterial(model, emitter.MaterialID))
  })

  return { particles, ribbons, trackTimeUnit }
}

/** A value in radians, static or tracked, in degrees. */
function degreesOf(
  value: War3.AnimVector | number | null | undefined,
): War3.AnimVector | number | null | undefined {
  const scale = 180 / Math.PI
  if (typeof value === 'number') return value * scale
  if (value === null || value === undefined) return value
  const turn = (vector: Float32Array | Int32Array | undefined) =>
    vector === undefined ? undefined : Float32Array.from(vector, component => component * scale)
  return {
    ...value,
    Keys: value.Keys.map(key => ({
      ...key,
      Vector: turn(key.Vector)!,
      ...(key.InTan === undefined ? {} : { InTan: turn(key.InTan)! }),
      ...(key.OutTan === undefined ? {} : { OutTan: turn(key.OutTan)! }),
    })),
  }
}

function particleEmitterAnimation(fields: {
  width?: War3.AnimVector | number | null | undefined
  length?: War3.AnimVector | number | null | undefined
  visibility?: War3.AnimVector | number | null | undefined
  emissionRate?: War3.AnimVector | number | null | undefined
  lifeSpan?: War3.AnimVector | number | null | undefined
  speed?: War3.AnimVector | number | null | undefined
  gravity?: War3.AnimVector | number | null | undefined
  latitude?: War3.AnimVector | number | null | undefined
  variation?: War3.AnimVector | number | null | undefined
}): RenderParticleEmitterAnimation | undefined {
  const animation: RenderParticleEmitterAnimation = {}
  const width = scalarAnimationTrack(fields.width)
  const length = scalarAnimationTrack(fields.length)
  const visibility = scalarAnimationTrack(fields.visibility)
  const emissionRate = scalarAnimationTrack(fields.emissionRate)
  const lifeSpan = scalarAnimationTrack(fields.lifeSpan)
  const speed = scalarAnimationTrack(fields.speed)
  const gravity = scalarAnimationTrack(fields.gravity)
  const latitude = scalarAnimationTrack(fields.latitude)
  const variation = scalarAnimationTrack(fields.variation)
  if (width) animation.width = width
  if (length) animation.length = length
  if (visibility) animation.visibility = visibility
  if (emissionRate) animation.emissionRate = emissionRate
  if (lifeSpan) animation.lifeSpan = lifeSpan
  if (speed) animation.speed = speed
  if (gravity) animation.gravity = gravity
  if (latitude) animation.latitude = latitude
  if (variation) animation.variation = variation
  return Object.keys(animation).length > 0 ? animation : undefined
}

function ribbonEmitterAnimation(fields: {
  heightAbove?: War3.AnimVector | number | null | undefined
  heightBelow?: War3.AnimVector | number | null | undefined
  alpha?: War3.AnimVector | number | null | undefined
  visibility?: War3.AnimVector | number | null | undefined
  emissionRate?: War3.AnimVector | number | null | undefined
  lifeSpan?: War3.AnimVector | number | null | undefined
  textureSlot?: War3.AnimVector | number | null | undefined
}): RenderRibbonEmitterAnimation | undefined {
  const animation: RenderRibbonEmitterAnimation = {}
  const heightAbove = scalarAnimationTrack(fields.heightAbove)
  const heightBelow = scalarAnimationTrack(fields.heightBelow)
  const alpha = scalarAnimationTrack(fields.alpha)
  const visibility = scalarAnimationTrack(fields.visibility)
  const emissionRate = scalarAnimationTrack(fields.emissionRate)
  const lifeSpan = scalarAnimationTrack(fields.lifeSpan)
  const textureSlot = scalarAnimationTrack(fields.textureSlot)
  if (heightAbove) animation.heightAbove = heightAbove
  if (heightBelow) animation.heightBelow = heightBelow
  if (alpha) animation.alpha = alpha
  if (visibility) animation.visibility = visibility
  if (emissionRate) animation.emissionRate = emissionRate
  if (lifeSpan) animation.lifeSpan = lifeSpan
  if (textureSlot) animation.textureSlot = textureSlot
  return Object.keys(animation).length > 0 ? animation : undefined
}

function withOptionalTexture<T extends RenderParticleEmitter | RenderRibbonEmitter>(
  effect: T,
  texture: string | undefined,
): T {
  if (texture) effect.texturePath = texture
  return effect
}

function numberValue(value: number | undefined | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a finite three-component native vector without depending on its typed-array class. */
function tuple3FromNumericArray(
  value: ArrayLike<number> | undefined | null,
): [number, number, number] | undefined {
  if (!value || value.length < 3) return undefined
  const x = numberValue(value[0])
  const y = numberValue(value[1])
  const z = numberValue(value[2])
  return x === undefined || y === undefined || z === undefined ? undefined : [x, y, z]
}

function segmentColorsFromWar3(
  value: Float32Array[] | undefined | null,
): [number, number, number][] | undefined {
  if (!value || value.length < 3) return undefined
  const colors = value.slice(0, 3).map(color => tuple3FromNumericArray(color))
  return colors.every(Boolean) ? (colors as [number, number, number][]) : undefined
}

function segmentAlphasFromWar3(
  value: Uint8Array | undefined | null,
): [number, number, number] | undefined {
  if (!value || value.length < 3) return undefined
  return [
    clamp01((value[0] ?? 255) / 255),
    clamp01((value[1] ?? 255) / 255),
    clamp01((value[2] ?? 255) / 255),
  ]
}

function texturePathForMaterial(
  model: War3.Model,
  materialIndex: number | undefined,
): string | undefined {
  const material = typeof materialIndex === 'number' ? model.Materials[materialIndex] : undefined
  if (!material) return undefined

  for (const layer of material.Layers) {
    const path = texturePath(model, staticOrFirstNumber(layer.TextureID))
    if (path) return path
  }

  return undefined
}

function buildBounds(
  minimumExtent: Float32Array | undefined,
  maximumExtent: Float32Array | undefined,
  radius: number,
): Bounds | null {
  // MK3 deviation from the MK2 port: an MDL that declares no extents reached this with undefined
  // and threw a null dereference out of the codec. A model without extents has no bounds; that is
  // a fact to publish, not a crash.
  if (minimumExtent === undefined || maximumExtent === undefined) return null
  if (minimumExtent.length < 3 || maximumExtent.length < 3) return null
  return {
    min: { x: minimumExtent[0] ?? 0, y: minimumExtent[1] ?? 0, z: minimumExtent[2] ?? 0 },
    max: { x: maximumExtent[0] ?? 0, y: maximumExtent[1] ?? 0, z: maximumExtent[2] ?? 0 },
    radius,
  }
}

function texturePath(model: War3.Model, textureIndex: number | undefined): string | undefined {
  return textureInfo(model, textureIndex)?.image
}

function textureInfo(
  model: War3.Model,
  textureIndex: number | undefined,
):
  | {
      index: number
      image: string
      replaceableId: number | null
      flags: number
      syntheticReplaceablePath: boolean
    }
  | undefined {
  if (typeof textureIndex !== 'number' || textureIndex < 0) return undefined
  const texture = model.Textures[textureIndex]
  if (!texture) return undefined
  const image =
    texture.Image && texture.Image.length > 0
      ? texture.Image
      : war3ReplaceableTexturePath(texture.ReplaceableId, model.Version)
  if (!image) return undefined
  return {
    index: textureIndex,
    image,
    replaceableId: texture.ReplaceableId ?? null,
    flags: texture.Flags ?? 0,
    syntheticReplaceablePath: !texture.Image || texture.Image.length === 0,
  }
}

function staticNumber(
  value: War3.AnimVector | Float32Array | Int32Array | number | undefined,
): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function staticFloat3(
  value: War3.AnimVector | Float32Array | undefined,
): [number, number, number] | undefined {
  return value instanceof Float32Array && value.length >= 3
    ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0]
    : undefined
}

function vector3(value: Float32Array): [number, number, number] {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0]
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function copyFloat32(value: Float32Array): Float32Array {
  return new Float32Array(value)
}

function copyUint16(value: Uint16Array): Uint16Array {
  return new Uint16Array(value)
}
