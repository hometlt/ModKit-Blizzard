/**
 * Diablo III appearance codec.
 *
 * Decoding is the ported implementation in `appearance.ts` — the one that also reads `.ani`
 * animations, `.ans` animation sets and `.acr` actor links. This module owns only the MK3 surface:
 * budgets, cancellation, the published facets and companion discovery.
 *
 * It replaces a second, narrower APP parser that used to live here. Two parsers for one format is
 * how they drift apart.
 */
import type { HostOperationHandler } from '@modkit/host'
import type { InspectionContext } from '@modkit/codec-kit'
import type { JsonValue, OperationDecl } from '@modkit/sdk'
import type { CodecIssue, RenderModel } from '@modkit/codec-kit/legacy/models'
import {
  createInspectionCodec,
  createModelAnimationSource,
  createModelCollisionSource,
  createModelMaterialSource,
  createModelResourceRefsSource,
  createModelSceneSource,
  createModelSkeletonSource,
  createModelSocketSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import {
  attachDiablo3Animations,
  diablo3AniSidecarPatterns,
  diablo3ShaderOf,
  isDiablo3Actor,
  isDiablo3AnimSet,
  isDiablo3Animation,
  isDiablo3Appearance,
  parseDiablo3ActorLinks,
  parseDiablo3AnimSet,
  parseDiablo3Appearance,
  parseDiablo3ShaderMap,
  parseDiablo3Shaders,
  type Diablo3RenderPass,
} from './appearance.js'
import { exportDiablo3Uvm } from './uvm.js'
import {
  diablo3AnimationClips,
  diablo3Collisions,
  diablo3Materials,
  diablo3Nodes,
  diablo3ResourceReferences,
  diablo3SceneInfo,
  diablo3SceneMeshes,
  diablo3SceneNodes,
  diablo3ScenePrimitives,
  diablo3SkeletonBindings,
  diablo3Sockets,
} from './scene.js'

const ID = 'blizzard/diablo3-app'
const MAGIC = 0xdeadbeef
const VERSION = 260

type CodecContext = InspectionContext

const diablo3Operations: readonly OperationDecl[] = [
  {
    id: 'model.export-uvm' as OperationDecl['id'],
    handlerId: 'model-export-uvm',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['bytes'],
  },
  {
    id: 'model.companions' as OperationDecl['id'],
    handlerId: 'diablo3-companion-patterns',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['json'],
  },
]

/** The appearance's own counts, read off the decoded model rather than the header a second time. */
function counts(model: RenderModel) {
  const vertices = model.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0)
  const indices = model.meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0)
  return { vertices, indices, triangles: indices / 3 }
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Several Anims of one set carry the same authored block name (the barbarian's set names 14
 * `barbarian_male_HTH_Death_Normal`); a repeated name gets its Anim SNO so every clip stays
 * addressable, and a target that keys sequences by name keeps them all.
 */
function distinctClipNames(model: RenderModel): RenderModel {
  const counts = new Map<string, number>()
  for (const animation of model.animations) counts.set(animation.name, (counts.get(animation.name) ?? 0) + 1)
  if ([...counts.values()].every(count => count === 1)) return model
  return {
    ...model,
    animations: model.animations.map(animation => {
      const source = String(animation.metadata?.['source'] ?? '')
      const sno = /(\d+)\.ani$/iu.exec(source)?.[1]
      return (counts.get(animation.name) ?? 0) > 1 && sno !== undefined
        ? { ...animation, name: `${animation.name} (Anim ${sno})` }
        : animation
    }),
  }
}

/** Where the linked files are looked up — the scopes the host uses for a game's own data links. */
const LINK_SCOPES = ['current-mount', 'enclosing-container', 'workspace-dependency-layer'] as const
/** The host's resource session serves 256 resources to one subject: the render passes, the actor, its sets and clips share them. */
const MAX_LINKED_RESOURCES = 250
const MAX_LINKED_ANIMATIONS = 240

/** Reads logical paths through the subject's resources; a path that does not read is absent. */
function linkReader(context: CodecContext, issues: CodecIssue[]) {
  const resources = context.logicalResources
  let used = 0
  const read = async (paths: readonly string[]) => {
    if (resources === undefined || paths.length === 0) return []
    used += paths.length
    const batch = await resources.readBatch(
      {
        items: paths.map(logicalId => ({
          requirement: { id: logicalId, logicalId, role: 'sidecar', scopes: LINK_SCOPES },
        })),
        concurrency: 4,
        readTimeoutMs: 8000,
        totalTimeoutMs: 10000,
        maxBytes: BigInt(context.budget.maxScalarBytes),
      },
      context.signal,
    )
    if (batch.state === 'refused')
      issues.push({ severity: 'warning', code: 'link-unread', message: batch.message })
    return batch.items.flatMap((item, index) =>
      item.state === 'read' ? [{ hint: paths[index]!, bytes: item.bytes }] : [],
    )
  }
  return { read, remaining: () => MAX_LINKED_RESOURCES - used }
}

/**
 * The storage root the links are read under (`<Group>/<file>` → its prefix) and, when the subject is
 * the appearance itself (`Appearance/<name>.app`), its name. A model a world opens through the host's
 * model port reads under the scene's identity (`Scene/<name>.scn`): the same storage, no actor name.
 */
async function appearanceLink(context: CodecContext): Promise<{ root: string; name?: string } | undefined> {
  const primary = (await context.logicalResources?.identity?.(context.signal))?.primaryLogicalId?.replaceAll('\\', '/') ?? ''
  const own = /^((?:.*\/)?)[^/]+\/([^/]+)\.app$/iu.exec(primary)
  if (own !== null) return { root: own[1] ?? '', name: own[2] ?? '' }
  const other = /^((?:.*\/)?)[^/]+\/[^/]+$/u.exec(primary)
  return other === null ? undefined : { root: other[1] ?? '' }
}

function withIssues(model: RenderModel, issues: readonly CodecIssue[]): RenderModel {
  if (issues.length === 0) return model
  const previous = model.metadata?.['issues']
  return {
    ...model,
    metadata: { ...model.metadata, issues: [...(Array.isArray(previous) ? previous : []), ...issues] },
  }
}

/**
 * Each material's render state, which the appearance does not hold: look 0's ShaderMap
 * (`ShaderMap/<sno>.shm`) names Shaders by tag, the engine's opaque tag chain picks one
 * (`Shaders/<sno>.shd`), and its first pass states blend, alpha test and culling. Read by exact
 * name through the host's logical resources, like the actor's clips; a material whose files do not
 * read keeps no pass and draws as the glTF defaults say.
 */
async function withRenderPasses(
  model: RenderModel,
  context: CodecContext,
  link: ReturnType<typeof linkReader>,
  root: string,
  issues: CodecIssue[],
): Promise<RenderModel> {
  const maps = [
    ...new Set(
      model.materials.flatMap(material => {
        const sno = material.metadata?.['shaderMapSnoId']
        return typeof sno === 'number' && sno > 0 ? [sno] : []
      }),
    ),
  ]
  if (maps.length === 0) return model
  const mapPath = (sno: number) => `${root}ShaderMap/${sno}.shm`
  const shaderOfMap = new Map<number, number>()
  for (const item of await link.read(maps.map(mapPath))) {
    try {
      const shader = diablo3ShaderOf(parseDiablo3ShaderMap(item.bytes))
      const sno = Number(/(\d+)\.shm$/u.exec(item.hint)?.[1])
      if (shader !== undefined && Number.isSafeInteger(sno)) shaderOfMap.set(sno, shader)
    } catch (error) {
      issues.push({ severity: 'warning', code: 'shader-map-invalid', message: `${item.hint}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const shaders = [...new Set(shaderOfMap.values())]
  const passes = new Map<number, Diablo3RenderPass>()
  for (const item of await link.read(shaders.map(sno => `${root}Shaders/${sno}.shd`))) {
    try {
      const sno = Number(/(\d+)\.shd$/u.exec(item.hint)?.[1])
      if (Number.isSafeInteger(sno)) passes.set(sno, parseDiablo3Shaders(item.bytes))
    } catch (error) {
      issues.push({ severity: 'warning', code: 'shader-invalid', message: `${item.hint}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return {
    ...model,
    materials: model.materials.map(material => {
      const map = material.metadata?.['shaderMapSnoId']
      const shader = typeof map === 'number' ? shaderOfMap.get(map) : undefined
      const pass = shader === undefined ? undefined : passes.get(shader)
      return pass === undefined ? material : { ...material, metadata: { ...material.metadata, shaderSnoId: shader, renderPass: pass } }
    }),
  }
}

/**
 * The game's own animation link: the actor named like the appearance (`Actor/<name>.acr`) names its
 * AnimSet, whose tag map — and its parent sets' — names every Anim by SNO. Each file is read by that
 * exact name through the host's logical resources, and the attach keeps only clips authored for
 * this appearance's SNO. An appearance with no such actor (static props, a monster whose actor is
 * named otherwise) keeps its model without clips; finding those needs a listing the codec lacks.
 */
async function withActorAnimations(
  model: RenderModel,
  link: ReturnType<typeof linkReader>,
  root: string,
  name: string,
  issues: CodecIssue[],
  signal: AbortSignal | undefined,
): Promise<RenderModel> {
  const read = link.read
  const linked = async (): Promise<RenderModel> => {
    const [actor] = await read([`${root}Actor/${name}.acr`])
    if (actor === undefined || !isDiablo3Actor(actor.bytes)) return model
    const snos = new Set<number>()
    // parent sets supply the tags a set does not override; the depth bound also ends a cycle
    let set = parseDiablo3ActorLinks(actor.bytes).animSetSnoId
    for (let depth = 0; set > 0 && depth < 8; depth += 1) {
      const [bytes] = await read([`${root}AnimSet/${set}.ans`])
      if (bytes === undefined || !isDiablo3AnimSet(bytes.bytes)) break
      const parsed = parseDiablo3AnimSet(bytes.bytes)
      for (const entry of parsed.animations) snos.add(entry.animationSnoId)
      set = parsed.parentAnimSetSnoId
    }
    const limit = Math.max(0, Math.min(MAX_LINKED_ANIMATIONS, link.remaining()))
    if (snos.size > limit)
      issues.push({
        severity: 'warning',
        code: 'animation-link-truncated',
        message: `the animation set names ${snos.size} animations; the first ${limit} are attached`,
      })
    const inputs = await read([...snos].slice(0, limit).map(sno => `${root}Anim/${sno}.ani`))
    return inputs.length === 0 ? model : distinctClipNames(attachDiablo3Animations(model, inputs))
  }
  try {
    return await linked()
  } catch (error) {
    // a broken actor or animation set degrades the clips, never the appearance itself
    if (signal?.aborted) throw error
    issues.push({
      severity: 'warning',
      code: 'animation-link-invalid',
      message: `the actor's animation link could not be read: ${error instanceof Error ? error.message : String(error)}`,
    })
    return model
  }
}

/** The game's links an appearance draws with: its materials' render passes, then its actor's clips. */
async function withGameLinks(model: RenderModel, context: CodecContext): Promise<RenderModel> {
  const place = await appearanceLink(context)
  if (context.logicalResources === undefined || place === undefined) return model
  const issues: CodecIssue[] = []
  const link = linkReader(context, issues)
  let linked = model
  try {
    linked = await withRenderPasses(linked, context, link, place.root, issues)
  } catch (error) {
    if (context.signal?.aborted) throw error
    issues.push({ severity: 'warning', code: 'shader-link-invalid', message: error instanceof Error ? error.message : String(error) })
  }
  if (place.name !== undefined)
    linked = await withActorAnimations(linked, link, place.root, place.name, issues, context.signal)
  return withIssues(linked, issues)
}

const definition = Object.freeze({
  id: ID,
  // the actor link is read through logical resources, which the host binds only after open
  deferInspection: true,
  format: Object.freeze({ id: 'diablo3-app', label: 'Diablo III appearance' }),
  operations: diablo3Operations,
  async detect(prefix: Uint8Array) {
    if (prefix.byteLength < 8) return { confidence: 0, kind: 'magic', note: 'header-truncated' }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
    if (view.getUint32(0, true) !== MAGIC) {
      // The same container holds animations, animation sets and actors; naming which one it is
      // keeps a mis-detected file from being reported as a broken appearance.
      if (isDiablo3Animation(prefix))
        return { confidence: 0, kind: 'magic', note: 'diablo3-animation-not-appearance' }
      if (isDiablo3AnimSet(prefix))
        return { confidence: 0, kind: 'magic', note: 'diablo3-animation-set-not-appearance' }
      if (isDiablo3Actor(prefix))
        return { confidence: 0, kind: 'magic', note: 'diablo3-actor-not-appearance' }
      return { confidence: 0, kind: 'magic', note: 'signature-mismatch' }
    }
    return view.getUint32(4, true) === VERSION
      ? { confidence: 0.99, kind: 'magic', note: 'deadbeef-v260' }
      : { confidence: 0, kind: 'magic', note: 'unsupported-version' }
  },
  async inspect(bytes: Uint8Array, context: CodecContext) {
    context.signal?.throwIfAborted()
    if (bytes.byteLength > context.budget.maxScalarBytes)
      throw new RangeError('Diablo III appearance exceeds maxScalarBytes budget')
    if (!isDiablo3Appearance(bytes))
      throw new TypeError('Diablo III APP header is invalid or unsupported')
    // Charged from the header, before the parser allocates from those same counts.
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (
      header.getUint32(0x24, true) + header.getUint32(0x0a8, true) + header.getUint32(0x1b4, true) >
      context.budget.maxNodes
    )
      throw new RangeError('Diablo III APP records exceed maxNodes budget')
    let model: RenderModel
    try {
      model = parseDiablo3Appearance(bytes, context.source.ref.id)
    } catch (error) {
      throw new TypeError(
        `Diablo III appearance could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    model = await withGameLinks(model, context)
    context.signal?.throwIfAborted()
    const nodes = diablo3SceneNodes(model)
    const { vertices, indices, triangles } = counts(model)
    // Decoded geometry records are charged too: the header states intent, the decode states size.
    if (
      vertices + indices + nodes.length + model.meshes.length + model.materials.length >
      context.budget.maxNodes
    )
      throw new RangeError('Diablo III APP geometry records exceed maxNodes budget')
    const metadata = model.metadata ?? {}
    const references = diablo3ResourceReferences(model)
    const bindings = diablo3SkeletonBindings(model)
    const clips = diablo3AnimationClips(model)
    const sockets = diablo3Sockets(model)
    const collisions = diablo3Collisions(model)
    const bounds = model.bounds
    const issues = Array.isArray(metadata['issues']) ? metadata['issues'] : []
    return {
      summary: {
        format: 'diablo3-app',
        version: VERSION,
        snoId: numberOf(metadata['snoId']),
        objectType: numberOf(metadata['objectType']),
        submeshes: model.meshes.length,
        vertices,
        indices,
        triangles,
        bones: diablo3Nodes(model).length,
        materials: model.materials.map(material => material.name),
        bounds:
          bounds === undefined || bounds === null
            ? null
            : {
                min: [bounds.min.x, bounds.min.y, bounds.min.z],
                max: [bounds.max.x, bounds.max.y, bounds.max.z],
              },
        animations: model.animations.length,
        geometryAccess: 'decoded',
      },
      metadata: [
        {
          id: 'diablo3-app-model',
          label: 'Diablo III appearance',
          entries: [
            { key: 'version', value: VERSION },
            { key: 'snoId', value: numberOf(metadata['snoId']) },
            { key: 'objectType', value: numberOf(metadata['objectType']) },
            { key: 'submeshes', value: model.meshes.length },
            { key: 'vertices', value: vertices },
            { key: 'triangles', value: triangles },
            { key: 'bones', value: diablo3Nodes(model).length },
            { key: 'materials', value: model.materials.map(material => material.name) },
          ],
        },
      ],
      traits: [
        { id: 'model.geometry', parameters: { triangles, bounds: bounds ?? null } },
        {
          id: 'structure.hierarchy',
          parameters: { bones: diablo3Nodes(model).length, submeshes: model.meshes.length },
        },
        { id: 'content.binary', parameters: { version: VERSION } },
      ],
      // a decode and its linked clips may report more than the subject's diagnostic budget
      diagnostics: issues.slice(0, context.budget.maxDiagnostics).flatMap((issue, index) => {
        if (typeof issue !== 'object' || issue === null) return []
        // `model-format-unmatched: diablo3-ani-bone` → the lowercase dash form the diagnostic schema admits
        const code = String((issue as Record<string, unknown>)['code'] ?? 'issue')
          .toLowerCase()
          .replace(/[^a-z0-9.]+/gu, '-')
          .replace(/^-+|-+$/gu, '')
        return [
          {
            id: `blizzard.diablo3-app/issue-${index}`,
            severity: 'warning' as const,
            category: /^(animation-link|link-|shader)/u.test(code) ? ('dependency' as const) : ('fidelity' as const),
            code: `blizzard.diablo3-app/${code}`,
            message: String((issue as Record<string, unknown>)['message'] ?? ''),
          },
        ]
      }),
      handlers: {
        // The shared conversion seam: this codec states the model, and the host routes the
        // document to whichever native encoder the caller asked for.
        'model-export-uvm': (async (request: unknown) => {
          const options = (request ?? {}) as { metersPerSourceUnit?: number }
          const exported = exportDiablo3Uvm(model, {
            assetId: context.source.ref.id,
            subjectRevision: context.source.revision,
            ...(options.metersPerSourceUnit === undefined
              ? {}
              : { metersPerSourceUnit: options.metersPerSourceUnit }),
            budget: {
              maxInputBytes: context.budget.maxScalarBytes,
              maxJsonBytes: context.budget.maxScalarBytes,
              maxDepth: context.budget.maxDepth,
              maxNodes: context.budget.maxNodes,
            },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          return { kind: 'bytes', value: exported.bytes }
        }) satisfies HostOperationHandler,
        // The appearance names no sidecar; the patterns are derived from its own path, and the
        // host decides whether anything matches them.
        'diablo3-companion-patterns': (async () => ({
          kind: 'json',
          value: {
            schemaVersion: 1,
            animations: diablo3AniSidecarPatterns(context.source.ref.id),
          } satisfies JsonValue,
        })) satisfies HostOperationHandler,
      },
      dataSources: {
        'common.view/model-scene-source': createModelSceneSource({
          info: diablo3SceneInfo(model, references.length),
          nodes,
          meshes: diablo3SceneMeshes(model),
          primitives: diablo3ScenePrimitives(model),
        }),
        'common.view/model-material-source': createModelMaterialSource({
          materials: diablo3Materials(model),
        }),
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
          : { 'common.view/model-animation-source': createModelAnimationSource({ clips }) }),
        ...(sockets.length === 0
          ? {}
          : { 'common.view/model-socket-source': createModelSocketSource({ sockets }) }),
        ...(collisions.length === 0
          ? {}
          : { 'common.view/model-collision-source': createModelCollisionSource({ volumes: collisions }) }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'model',
          label: 'Diablo III APP',
          preview: `${String(model.meshes.length)} submesh(es), ${String(diablo3Nodes(model).length)} bone(s)`,
          children: [
            ...model.meshes.map(mesh => ({
              kind: 'mesh',
              label: mesh.name,
              preview: `${String(mesh.positions.length / 3)} vertices; ${String(mesh.indices.length / 3)} triangles`,
            })),
            ...diablo3Nodes(model).map(node => ({
              kind: 'bone',
              label: node.name,
              preview: node.parentIndex < 0 ? 'root' : `parent ${String(node.parentIndex)}`,
            })),
          ],
        }),
      },
      unsupportedFeatures: [
        'tangent-publication',
        // Texture references are resolved by the host from the same storage; shaders are not.
        'material-shaders',
        'model-rendering',
        'model-writing',
      ],
    }
  },
})

export { attachDiablo3Animations }
export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
