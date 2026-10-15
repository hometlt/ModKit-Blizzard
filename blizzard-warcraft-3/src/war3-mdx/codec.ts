/**
 * Warcraft III MDX/MDL codec.
 *
 * Decoding is the ported MK2 implementation over the vendored war3-model parser
 * (`src/lib/mk2/war3-mdx`, `src/lib/war3-model`); this module owns only the MK3 surface: budget
 * enforcement before parsing, cancellation, and the published facets. The MDX chunk inventory is
 * kept from the earlier dependency-free profile because it is the one view that still works on a
 * file the parser rejects. `model.export-uvm` also reads each PopcornFX emitter's `.pkb` beside the
 * model through the subject's logical resources and bakes it (popcorn.ts).
 * Resource references include textures and authored ATCH/PRE1 sidecar paths; unbound references
 * do not imply nested-model playback. Texture counts exclude sidecars.
 * model.write keeps MDX inputs inspectable but refuses a top-level source chunk absent from the
 * native reconstruction, naming its tag and offset. This is not nested-record/MDL-block or byte
 * preservation proof. UVM residual conversion has a separate native-preservation boundary.
 */
import type { HostOperationHandler } from '@modkit/host'
import type { InspectionContext } from '@modkit/codec-kit'
import type { JsonObject, JsonValue, OperationDecl } from '@modkit/sdk'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { animationSnapshotBudget } from '@modkit/codec-kit/model/animation'
import {
  createInspectionCodec,
  createModelAnimationSource,
  createModelCameraSource,
  createModelLightSource,
  createModelMaterialSource,
  createModelResourceRefsSource,
  createModelSceneSource,
  createModelCollisionSource,
  createModelEffectSource,
  createModelSkeletonSource,
  createModelLodSource,
  createModelSocketSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import {
  detectWar3ModelFormat,
  isWar3MdlText,
  isWar3MdxBinary,
} from './detect.js'
import {
  generateWar3Mdl,
  generateWar3Mdx,
  parseWar3Mdl,
  parseWar3Mdx,
  war3ModelToRenderModel,
} from './render-model.js'
import {
  war3AnimationClips,
  war3ClipId,
  war3Cameras,
  war3Collisions,
  war3Lights,
  war3Effects,
  war3Materials,
  war3LodLevels,
  war3Sockets,
  war3ResourceReferences,
  war3SceneInfo,
  war3SceneMeshes,
  war3SceneNodes,
  war3ScenePrimitives,
  war3SkeletonBindings,
} from './scene.js'
import { exportWar3Uvm } from './uvm.js'
import { readWar3PopcornBake, war3PopcornEmitters, war3PopcornNodeFrames } from './popcorn.js'

/**
 * What one Warcraft III world unit is, in metres, when the caller states nothing.
 *
 * A game's model units are a property of that game, measured against the cell a medium unit
 * occupies: StarCraft II authors at 1, Warcraft III at 0.35 (owner, 2026-09-23). The format
 * declares no metre length of its own, which is why this had to be told rather than derived.
 */
const WAR3_METERS_PER_SOURCE_UNIT = 0.35

const ID = 'blizzard/war3-mdx'
const ascii = new TextDecoder('ascii')
const utf8 = new TextDecoder('utf-8', { fatal: false })

type CodecBudget = InspectionContext['budget']
type CodecContext = InspectionContext
interface MdxChunk {
  readonly id: string
  readonly offset: number
  readonly payload: number
  readonly size: number
}

const tag = (bytes: Uint8Array, offset: number): string =>
  ascii.decode(bytes.subarray(offset, offset + 4))

/** Chunk walk only: it must keep working when the full parser refuses the file. */
function inventoryMdxChunks(bytes: Uint8Array, budget: CodecBudget): readonly MdxChunk[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: MdxChunk[] = []
  let offset = 4
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new RangeError('MDX chunk header is truncated')
    if (chunks.length >= budget.maxNodes)
      throw new RangeError('MDX chunk count exceeds maxNodes budget')
    const id = tag(bytes, offset)
    if (!/^[A-Z0-9]{4}$/u.test(id)) throw new TypeError(`MDX chunk id at ${String(offset)} is invalid`)
    const size = data.getUint32(offset + 4, true)
    const payload = offset + 8
    if (payload + size > bytes.byteLength) throw new RangeError(`MDX ${id} chunk is out of bounds`)
    chunks.push(Object.freeze({ id, offset, payload, size }))
    offset = payload + size
  }
  // Refused before the vendored parser sees the bytes: without VERS it has no version to branch on
  // and fails deep inside with a null dereference instead of naming the missing chunk.
  const version = chunks.find(chunk => chunk.id === 'VERS')
  if (version === undefined || version.size < 4) throw new TypeError('MDX VERS chunk is missing')
  return Object.freeze(chunks)
}

/**
 * The vendored parser allocates from the file's own declared counts, so the file is admitted
 * against the caller's budget before it is handed over rather than after.
 */
function admit(bytes: Uint8Array, context: CodecContext): void {
  context.signal?.throwIfAborted()
  if (bytes.byteLength > context.budget.maxScalarBytes)
    throw new RangeError('Warcraft III model exceeds maxScalarBytes budget')
}

function chargeModelWork(
  counts: { readonly nodes: number; readonly meshes: number; readonly materials: number },
  budget: CodecBudget,
): void {
  const work = counts.nodes + counts.meshes + counts.materials
  if (work > budget.maxNodes) throw new RangeError('Warcraft III model exceeds maxNodes budget')
}


const war3Operations: readonly OperationDecl[] = [
  {
    id: 'model.export-uvm' as OperationDecl['id'],
    handlerId: 'model-export-uvm',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['bytes'],
  },
  {
    id: 'model.write' as OperationDecl['id'],
    handlerId: 'model-write',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['bytes'],
  },
]

/** The container budget the UVM writer needs, derived from the caller's own resource budget. */
const containerBudgetOf = (budget: CodecBudget) => ({
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
  maxDepth: budget.maxDepth,
  maxNodes: budget.maxNodes,
})

function exportRequest(
  value: JsonValue,
  context: CodecContext,
  signal?: AbortSignal,
  extraKeys: readonly string[] = ['metersPerSourceUnit'],
): JsonObject {
  const request = snapshotJson(
    value,
    {
      maxBytes: context.budget.maxScalarBytes,
      maxDepth: context.budget.maxDepth + 2,
      maxNodes: context.budget.maxNodes,
    },
    signal,
  )
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new TypeError('model.export-uvm requires an options object')
  const record = request as JsonObject
  if (record['schemaVersion'] !== 1)
    throw new TypeError('model.export-uvm requires schemaVersion 1')
  if (Object.keys(record).some(key => key !== 'schemaVersion' && !extraKeys.includes(key)))
    throw new TypeError('unknown Warcraft III conversion option')
  return record
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'war3-mdx', label: 'Warcraft III MDX/MDL' }),
  operations: war3Operations,
  async detect(prefix: Uint8Array) {
    if (isWar3MdxBinary(prefix)) return { confidence: 0.99, kind: 'magic', note: 'mdlx-signature' }
    if (isWar3MdlText(prefix))
      return { confidence: 0.92, kind: 'structure', note: 'mdl-version-declaration' }
    return { confidence: 0, kind: 'structure', note: 'war3-model-mismatch' }
  },
  async inspect(bytes: Uint8Array, context: CodecContext) {
    admit(bytes, context)
    const encoding = detectWar3ModelFormat(bytes)
    if (encoding === 'unknown') throw new TypeError('Warcraft III model signature is invalid')
    const chunks = encoding === 'mdx' ? inventoryMdxChunks(bytes, context.budget) : []
    context.signal?.throwIfAborted()
    let model
    let native
    try {
      // The parsed document is kept beside the render model: the UVM residual is built from the
      // native records, not from a projection of them.
      native = encoding === 'mdx' ? parseWar3Mdx(bytes) : parseWar3Mdl(bytes)
      model = war3ModelToRenderModel(native, encoding, { includeRawMetadata: true })
    } catch (error) {
      // A malformed model must refuse with its format named, not leak the parser's own shape error.
      throw new TypeError(
        `Warcraft III ${encoding.toUpperCase()} model could not be decoded: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
    context.signal?.throwIfAborted()
    const nodes = war3SceneNodes(model)
    const sockets = war3Sockets(model)
    const lodLevels = war3LodLevels(model)
    const collisions = war3Collisions(model)
    const effectRecords = war3Effects(model)
    const cameras = war3Cameras(native)
    const lights = war3Lights(native, model)
    chargeModelWork(
      { nodes: nodes.length, meshes: model.meshes.length, materials: model.materials.length },
      context.budget,
    )
    const references = war3ResourceReferences(model, native)
    const textureCount = references.filter(reference => reference.role === 'texture').length
    const bindings = war3SkeletonBindings(model)
    const clips = war3AnimationClips(model)
    const effects = model.effects
    const particles = effects?.particles?.length ?? 0
    const ribbons = effects?.ribbons?.length ?? 0
    const info = model.metadata?.['info']
    const name =
      typeof info === 'object' && info !== null && typeof (info as Record<string, unknown>)['name'] === 'string'
        ? ((info as Record<string, unknown>)['name'] as string)
        : ''
    const rawVersion = model.metadata?.['version']
    const version = Number.isFinite(rawVersion) ? (rawVersion as number) : null
    return {
      summary: {
        format: 'war3-mdx',
        encoding,
        version,
        name,
        geosets: model.meshes.length,
        materials: model.materials.length,
        bones: model.skeleton.bones.length,
        sequences: model.animations.length,
        textures: textureCount,
        particleEmitters: particles,
        ribbonEmitters: ribbons,
        ...(encoding === 'mdx' ? { chunks: chunks.length } : {}),
      },
      metadata: [
        {
          id: 'war3-model',
          label: `Warcraft III ${encoding.toUpperCase()} model`,
          entries: [
            { key: 'encoding', value: encoding },
            { key: 'version', value: version ?? 'unknown' },
            { key: 'name', value: name || '(unnamed)' },
            { key: 'geosets', value: model.meshes.length },
            { key: 'materials', value: model.materials.length },
            { key: 'bones', value: model.skeleton.bones.length },
            { key: 'sequences', value: model.animations.length },
            { key: 'textures', value: textureCount },
            { key: 'particleEmitters', value: particles },
            { key: 'ribbonEmitters', value: ribbons },
            ...(encoding === 'mdx' ? [{ key: 'chunks', value: chunks.length }] : []),
          ],
        },
      ],
      traits: [{ id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } }],
      handlers: {
        'model-export-uvm': (async (value, invocation) => {
          const operationSignal = invocation.signal ?? context.signal
          const request = exportRequest(value, context, operationSignal)
          // The owner stated the game's own scale on 2026-09-23, so this is no longer the guess
          // this code refused to make: a caller that says nothing gets Warcraft III's number, and
          // a caller with a better one still overrides it.
          const stated = request['metersPerSourceUnit']
          const units = stated === undefined ? WAR3_METERS_PER_SOURCE_UNIT : stated
          if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0)
            throw new TypeError('model.export-uvm requires a positive metersPerSourceUnit')
          const popcorn = await readWar3PopcornBake(
            native,
            model.animations.map((animation, index) => ({
              clipId: war3ClipId(index),
              name: animation.name,
              startMs: animation.startFrame ?? 0,
              endMs: animation.endFrame ?? animation.startFrame ?? 0,
              looping: animation.metadata?.['nonLooping'] !== true,
            })),
            paths => readBesideModel(context, paths, operationSignal),
            operationSignal,
            war3PopcornNodeFrames(model, war3PopcornEmitters(native).map(emitter => emitter.nodeId)),
          )
          const exported = exportWar3Uvm(model, native as unknown as Readonly<Record<string, unknown>>, encoding, {
            assetId: context.source.ref.id,
            subjectRevision: context.source.revision,
            metersPerSourceUnit: units,
            budget: containerBudgetOf(context.budget),
            ...(popcorn === undefined ? {} : { popcorn }),
            ...(operationSignal === undefined ? {} : { signal: operationSignal }),
          })
          if (!exported.effects && (particles > 0 || ribbons > 0))
            invocation.reportDiagnostic?.({
              code: 'blizzard.war3-mdx/effects-not-projected',
              severity: 'warning',
              message: 'decoded emitters were not projected into UV_game_effects',
            })
          for (const note of exported.notes)
            invocation.reportDiagnostic?.({
              code: 'blizzard.war3-mdx/conversion-remainder',
              severity: 'warning',
              message: note,
            })
          return { kind: 'bytes', value: exported.bytes }
        }) satisfies HostOperationHandler,
        'model-write': (async (value, invocation) => {
          const operationSignal = invocation.signal ?? context.signal
          const request = exportRequest(value, context, operationSignal, ['encoding'])
          const target = request['encoding']
          if (target !== undefined && target !== 'mdx' && target !== 'mdl')
            throw new TypeError('model.write encoding must be mdx or mdl')
          const written =
            (target ?? encoding) === 'mdl'
              ? new TextEncoder().encode(generateWar3Mdl(native))
              : new Uint8Array(generateWar3Mdx(native) as unknown as ArrayBufferLike)
          if (encoding === 'mdx') {
            // Ask the existing native writer which chunks it can reconstruct; do not copy its
            // parser registry into a second manual list. MDL has no envelope for an opaque MDX tag.
            const reconstructed = (target ?? encoding) === 'mdx' ? written :
              new Uint8Array(generateWar3Mdx(native) as unknown as ArrayBufferLike)
            const represented = new Set(inventoryMdxChunks(reconstructed, context.budget).map(chunk => chunk.id))
            for (const chunk of chunks) {
              operationSignal?.throwIfAborted()
              if (!represented.has(chunk.id))
                throw new TypeError(`model.write cannot preserve MDX ${chunk.id} chunk at byte ${String(chunk.offset)}: native reconstruction omits it`)
            }
          }
          // Verified by reopening, as the M3 writer does: bytes that this codec cannot read back
          // are not a Warcraft III model, whatever the writer believed.
          const reopened =
            (target ?? encoding) === 'mdl'
              ? parseWar3Mdl(written)
              : parseWar3Mdx(written)
          if (reopened.Geosets.length !== native.Geosets.length)
            throw new TypeError('model.write produced bytes this codec cannot read back')
          return { kind: 'bytes', value: written }
        }) satisfies HostOperationHandler,
      },
      dataSources: {
        'common.view/model-scene-source': createModelSceneSource({
          info: war3SceneInfo(model, textureCount),
          nodes,
          meshes: war3SceneMeshes(model),
          primitives: war3ScenePrimitives(model),
        }),
        'common.view/model-material-source': createModelMaterialSource({
          materials: war3Materials(model),
        }),
        ...(sockets.length === 0
          ? {}
          : {
              'common.view/model-socket-source': createModelSocketSource({ sockets }),
            }),
        ...(lodLevels.length === 0 ? {} : { 'common.view/model-lod-source': createModelLodSource({ levels: lodLevels }) }),
        ...(collisions.length === 0
          ? {}
          : {
              'common.view/model-collision-source': createModelCollisionSource({
                volumes: collisions,
              }),
            }),
        ...(effectRecords.length === 0
          ? {}
          : {
              'common.view/model-effect-source': createModelEffectSource({
                effects: effectRecords,
                profile: 'mdx',
              }),
            }),
        ...(cameras.length === 0
          ? {}
          : { 'common.view/model-camera-source': createModelCameraSource({ cameras }) }),
        ...(lights.length === 0
          ? {}
          : { 'common.view/model-light-source': createModelLightSource({ lights }) }),
        ...(references.length === 0
          ? {}
          : {
              'common.view/model-resource-refs-source': createModelResourceRefsSource({
                references,
              }),
            }),
        ...(bindings.length === 0
          ? {}
          : {
              'common.view/model-skeleton-source': createModelSkeletonSource({
                bindings,
                hierarchies: 1,
              }),
            }),
        ...(clips.length === 0
          ? {}
          : {
              // sized by the clips themselves: a Reforged model's keys (HD Grunt) exceed the default budget
              'common.view/model-animation-source': createModelAnimationSource({ clips, budget: animationSnapshotBudget(clips) }),
            }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'model',
          label: name || `Warcraft III ${encoding.toUpperCase()}`,
          preview:
            `${String(model.meshes.length)} geosets, ${String(model.materials.length)} materials, ` +
            `${String(model.animations.length)} sequences`,
          children:
            encoding === 'mdx'
              ? chunks.map(chunk => ({
                  kind: 'chunk',
                  label: chunk.id,
                  preview: `${String(chunk.size)} bytes at ${String(chunk.payload)}`,
                }))
              : [
                  { kind: 'geosets', label: 'Geosets', preview: String(model.meshes.length) },
                  {
                    kind: 'sequences',
                    label: 'Sequences',
                    preview: String(model.animations.length),
                  },
                ],
        }),
      },
      unsupportedFeatures: [],
    }
  },
})

export const abiVersion = 1
/**
 * Files beside the model by their path in the game's tree (a CORN emitter's `.pkb`), read through
 * the subject's logical resources; one that does not read is undefined, and so is every one where
 * the host gives no resources.
 */
async function readBesideModel(
  context: InspectionContext,
  paths: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly (Uint8Array | undefined)[]> {
  const resources = context.logicalResources
  if (resources === undefined || paths.length === 0) return paths.map(() => undefined)
  const batch = await resources.readBatch(
    {
      items: paths.map(logicalId => ({
        requirement: {
          id: logicalId,
          logicalId,
          role: 'sidecar',
          scopes: ['current-mount', 'enclosing-container', 'workspace-dependency-layer'],
        },
      })),
      concurrency: 4,
      readTimeoutMs: 8000,
      totalTimeoutMs: 30000,
      maxBytes: BigInt(context.budget.maxScalarBytes),
    },
    signal,
  )
  return paths.map((_, index) => {
    const item = batch.items[index]
    return item?.state === 'read' ? item.bytes : undefined
  })
}

export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)

export { utf8 as war3TextDecoder }
