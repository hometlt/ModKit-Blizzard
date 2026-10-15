/**
 * `blizzard/wow-m2` — World of Warcraft M2 models (owner: GAME-WOW; manifest
 * `contributions/codec-wow-m2.json`).
 *
 * Opens a `.m2` (chunked `MD21` or flat `MD20`, versions 264–274), reads its first skin profile and
 * the `.anim` files of its external sequences through the subject's logical resources, and
 * publishes the scene (`./scene.ts`): `common.view/model-scene-source`, materials, texture
 * references, skeleton, sockets, animation clips and a chunk tree. `model.export-uvm` materializes
 * the same projection with `@modkit/uv` (`createUvmExportHandler`; z-up, one unit = a yard,
 * 0.9144 m, overridable by `metersPerSourceUnit`). Read-only: no writer.
 *
 * Companions are named by FileDataID (`SFID`, `AFID`, `SKID`, `SKPD`, `BFID`) and read as `filedataid/<id>` of the same
 * content source, the address the WoW content source (`../game/content-sources.ts`) serves for any
 * file; a flat pre-Legion model reads `<name>00.skin` beside itself. A companion that does not
 * read is a warning, never a refusal: without its skin the model is metadata only, without an
 * `.anim` that sequence has no motion. Inspection is deferred to first session access, after the
 * host binds the resource port.
 *
 * Shared SKEL chains are composed by native animation id + variation. ANIM buffers keep model,
 * bone and attachment domains separate. Reads are deduplicated in bounded batches, without the
 * previous 200-file truncation. Missing companions and projection approximations are reported.
 * BFID facial offsets are separately decoded for native inspection, with explicit application loss.
 * Qualified single-texture material/translation-only UV animations use the common material program.
 * Not projected yet: BONE application, `.phys`, lights, cameras, ribbons, particles, other UV/shader profiles, game-chosen textures
 * (types ≠ 0: skin, hair, cape — chosen from DB2 tables), LOD skins.
 *
 * Budgets: the source must fit `maxScalarBytes`; record counts are bounded by `maxNodes`;
 * companions read with the subject's budget and the host's per-subject resource ceiling.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import {
  createInspectionCodec,
  createModelAnimationSource,
  createModelMaterialSource,
  createModelResourceRefsSource,
  createModelSceneSource,
  createModelSkeletonSource,
  createModelSocketSource,
  createTreeDataSource,
} from '@modkit/codec-kit'
import { animationSnapshotBudget } from '@modkit/codec-kit/model/animation'
import { createUvmExportHandler } from '@modkit/uv/model/export-handler'
import type { LogicalResourceReadOutcome, LogicalResourceReadBatchResult, ResourceUnresolvedReason, OperationDecl } from '@modkit/sdk'
import {
  animPayload,
  isExternalSequence,
  isM2,
  md20Of,
  readM2,
  readSequences,
  readSkin,
  fileIdsOf,
  skeletonDescriptor,
  readSkeleton,
  readBonePose,
  type M2BonePose,
  type M2Sequence,
  type M2FileIds,
  type M2Skeleton,
  type M2SkeletonDescriptor,
  type M2Skin,
} from './reader.js'
import { composeSkeleton } from './skeleton.js'
import { WOW_METERS_PER_UNIT, buildM2Scene, m2Projection, fileDataIdPath } from './scene.js'

const ID = 'blizzard/wow-m2'
const SCOPES = ['current-mount', 'enclosing-container', 'workspace-dependency-layer'] as const
/** Bounded batches, without truncating the set of reachable animation files. */
const ANIM_BATCH_SIZE = 64

type ResourceFailureReason = Extract<LogicalResourceReadOutcome, { state: 'unresolved' }>['reason'] |
  Extract<LogicalResourceReadBatchResult, { state: 'refused' }>['reason']
type Issue = { readonly code: string; readonly message: string;
  readonly data?: { readonly state: 'unresolved' | 'refused'; readonly reason: ResourceFailureReason | 'unknown' } }
const RESOURCE_UNRESOLVED_REASONS = [
  'not-found', 'not-allowlisted', 'path-refused', 'scope-unsupported', 'budget-exceeded',
  'cycle-detected', 'session-disposed', 'source-revision-changed', 'permission-missing',
] satisfies readonly ResourceUnresolvedReason[]
const RESOURCE_ITEM_REASONS = new Set<string>([...RESOURCE_UNRESOLVED_REASONS,
  'deadline-exceeded', 'read-failed', 'size-mismatch'] satisfies readonly Extract<LogicalResourceReadOutcome, { state: 'unresolved' }>['reason'][])
const RESOURCE_BATCH_REASONS = new Set<string>([...RESOURCE_UNRESOLVED_REASONS,
  'deadline-exceeded', 'request-invalid', 'context-unavailable'] satisfies readonly Extract<LogicalResourceReadBatchResult, { state: 'refused' }>['reason'][])

/** Project the existing public outcome vocabulary without copying backend text or identities. */
function resourceIssue(state: 'unresolved' | 'refused', reason: unknown): Issue {
  const reasons = state === 'refused' ? RESOURCE_BATCH_REASONS : RESOURCE_ITEM_REASONS
  return { code: `resource-${state}`, message: 'A model companion could not be read.',
    data: { state, reason: typeof reason === 'string' && reasons.has(reason)
      ? reason as ResourceFailureReason : 'unknown' } }
}

const OPERATIONS: readonly OperationDecl[] = [
  {
    id: 'model.export-uvm' as OperationDecl['id'],
    handlerId: 'model-export-uvm',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['bytes'],
  },
]

/** Reads logical ids through the subject's resources; one that does not read is undefined. */
async function readCompanions(
  context: InspectionContext,
  ids: readonly string[],
  issues: Issue[],
  maxBytes = context.budget.maxScalarBytes,
): Promise<(Uint8Array | undefined)[]> {
  const resources = context.logicalResources
  context.signal?.throwIfAborted()
  if (resources === undefined || ids.length === 0) {
    for (let index = 0; index < ids.length; index++) issues.push(resourceIssue('refused', 'context-unavailable'))
    return ids.map(() => undefined)
  }
  const batch = await resources.readBatch(
    {
      items: ids.map(logicalId => ({ requirement: { id: logicalId, logicalId, role: 'sidecar', scopes: SCOPES } })),
      concurrency: 4,
      readTimeoutMs: 8000,
      totalTimeoutMs: 30000,
      maxBytes: BigInt(maxBytes),
    },
    context.signal,
  )
  if (batch.state === 'refused') {
    for (let index = 0; index < ids.length; index++) issues.push(resourceIssue('refused', batch.reason))
    return ids.map(() => undefined)
  }
  return ids.map((_, index) => {
    const item = batch.items[index]
    if (item?.state !== 'read') {
      issues.push(resourceIssue('unresolved', item?.reason))
    }
    return item?.state === 'read' ? item.bytes : undefined
  })
}

interface AnimationBuffers {
  readonly model: ReadonlyMap<number, Uint8Array>
  readonly bones: ReadonlyMap<number, Uint8Array>
  readonly attachments: ReadonlyMap<number, Uint8Array>
  readonly named: number
  readonly read: number
}

/** Resolves one native sequence table; domains stay separate and duplicate file reads are shared. */
async function loadAnimations(context: InspectionContext, sequences: readonly M2Sequence[], ids: M2FileIds,
  issues: Issue[], cache: Map<string, Uint8Array | undefined>, flatStem?: string): Promise<AnimationBuffers> {
  const names = new Map<number, string>()
  const byKey = new Map(ids.animations.filter(entry => entry.fileId !== 0)
    .map(entry => [`${String(entry.animId)}:${String(entry.subAnimId)}`, fileDataIdPath(entry.fileId)]))
  sequences.forEach((sequence, index) => {
    if (!isExternalSequence(sequence)) return
    const id = byKey.get(`${String(sequence.id)}:${String(sequence.variation)}`)
      ?? (flatStem === undefined ? undefined
        : `${flatStem}${String(sequence.id).padStart(4, '0')}-${String(sequence.variation).padStart(2, '0')}.anim`)
    if (id === undefined) issues.push({ code: 'anim-unnamed',
      message: `animation ${String(sequence.id)}.${String(sequence.variation)} has no companion identity` })
    else names.set(index, id)
  })
  const unique = [...new Set(names.values())].filter(id => !cache.has(id))
  let allocated = [...cache.values()].reduce((sum, value) => sum + (value?.byteLength ?? 0), 0)
  for (let start = 0; start < unique.length; start += ANIM_BATCH_SIZE) {
    const page = unique.slice(start, start + ANIM_BATCH_SIZE)
    const results = await readCompanions(context, page, issues)
    results.forEach((bytes, index) => {
      allocated += bytes?.byteLength ?? 0
      if (allocated > context.budget.maxScalarBytes) throw new RangeError('M2 animation companions exceed the byte budget')
      cache.set(page[index]!, bytes)
    })
  }
  const model = new Map<number, Uint8Array>()
  const bones = new Map<number, Uint8Array>()
  const attachments = new Map<number, Uint8Array>()
  let read = 0
  for (const [index, id] of names) {
    const bytes = cache.get(id)
    if (bytes === undefined) continue
    read += 1
    for (const [domain, output] of [['model', model], ['bones', bones], ['attachments', attachments]] as const) {
      const payload = animPayload(bytes, context.budget.maxNodes, domain)
      if (payload !== undefined) output.set(index, payload)
    }
  }
  return { model, bones, attachments, named: names.size, read }
}

/** Loads only the declared, bounded parent chain through the same subject resource port. */
async function loadSkeletons(context: InspectionContext, first: number | undefined, issues: Issue[],
  cache: Map<string, Uint8Array | undefined>): Promise<{ readonly parts: readonly M2Skeleton[]; readonly named: number; readonly read: number }> {
  const sources: { bytes: Uint8Array; descriptor: M2SkeletonDescriptor }[] = []
  const visited = new Set<number>()
  let id = first
  let bytesRead = 0
  while (id !== undefined) {
    context.signal?.throwIfAborted()
    if (visited.has(id)) throw new TypeError(`M2 parent skeleton cycle at ${String(id)}`)
    if (sources.length >= context.budget.maxDepth) throw new RangeError('M2 skeleton chain exceeds maxDepth')
    visited.add(id)
    const [bytes] = await readCompanions(context, [fileDataIdPath(id)], issues)
    if (bytes === undefined) {
      issues.push({ code: 'skeleton-unread', message: `${fileDataIdPath(id)} skeleton did not read` })
      break
    }
    bytesRead += bytes.byteLength
    if (bytesRead > context.budget.maxScalarBytes) throw new RangeError('M2 skeleton chain exceeds the byte budget')
    const descriptor = skeletonDescriptor(bytes, context.budget.maxNodes)
    sources.push({ bytes, descriptor })
    id = descriptor.parent
  }
  const parts: M2Skeleton[] = []
  let inheritedSequences: readonly M2Sequence[] = []
  let inheritedGlobalLoops: readonly number[] = []
  let named = 0
  let read = 0
  for (const source of [...sources].reverse()) {
    const sequences = source.descriptor.sequences ?? inheritedSequences
    const animations = await loadAnimations(context, sequences, source.descriptor.fileIds, issues, cache)
    const part = readSkeleton(source.bytes, { maxRecords: context.budget.maxNodes,
      animBuffers: animations.bones, attachmentAnimBuffers: animations.attachments,
      inheritedSequences, inheritedGlobalLoops })
    parts.unshift(part)
    inheritedSequences = part.sequences ?? inheritedSequences
    inheritedGlobalLoops = part.globalLoops ?? inheritedGlobalLoops
    named += animations.named
    read += animations.read
  }
  return { parts, named, read }
}

/** The skin a flat (pre-chunk) model names by convention: `<model>00.skin` beside it. */
async function siblingSkinId(context: InspectionContext): Promise<string | undefined> {
  const primary = (await context.logicalResources?.identity?.(context.signal))?.primaryLogicalId
  if (primary === undefined) return undefined
  const name = primary.replaceAll('\\', '/').split('/').pop() ?? ''
  return /\.m2$/iu.test(name) ? `${name.slice(0, -3)}00.skin` : undefined
}

/** BFID facial-pose companions retain their native matrices; they never replace SKEL joints. */
async function loadBonePoses(context: InspectionContext, ids: readonly number[], boneCount: number,
  issues: Issue[], cache: Map<string, Uint8Array | undefined>): Promise<{
    readonly named: number; readonly read: number;
    readonly poses: readonly { readonly logicalId: string; readonly pose: M2BonePose }[];
  }> {
  if (ids.length > context.budget.maxNodes) throw new RangeError('BONE reference count exceeds maxNodes budget')
  const names = [...new Set(ids.filter(id => id !== 0).map(fileDataIdPath))]
  const poses: { logicalId: string; pose: M2BonePose }[] = []
  let read = 0
  let offsets = 0
  let bytesRead = [...cache.values()].reduce((sum, bytes) => sum + (bytes?.byteLength ?? 0), 0)
  for (let start = 0; start < names.length; start += ANIM_BATCH_SIZE) {
    context.signal?.throwIfAborted()
    const page = names.slice(start, start + ANIM_BATCH_SIZE)
    const missing = page.filter(name => !cache.has(name))
    const remaining = context.budget.maxScalarBytes - bytesRead
    if (missing.length > 0 && remaining <= 0) throw new RangeError('BONE and animation companions exhaust maxScalarBytes budget')
    const buffers = await readCompanions(context, missing, issues, remaining)
    missing.forEach((name, index) => {
      const bytes = buffers[index]
      cache.set(name, bytes)
      bytesRead += bytes?.byteLength ?? 0
    })
    if (bytesRead > context.budget.maxScalarBytes) throw new RangeError('BONE and animation companions exceed maxScalarBytes budget')
    for (const logicalId of page) {
      const bytes = cache.get(logicalId)
      if (bytes === undefined) {
        issues.push({ code: 'bone-pose-unread', message: `${logicalId}: facial-pose companion did not read` })
        continue
      }
      read++
      try {
        const pose = readBonePose(bytes, context.budget.maxNodes - offsets, boneCount, context.signal)
        offsets += pose.offsets.length
        poses.push({ logicalId, pose })
      } catch (error) {
        context.signal?.throwIfAborted()
        issues.push({ code: 'bone-pose-invalid', message: `${logicalId}: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }
  if (names.length > 0) issues.push({ code: 'bone-pose-unprojected',
    message: 'BFID facial-pose offsets are native inspection data; FacePose application to animation/UVM is not admitted' })
  return { named: names.length, read, poses }
}

const definition = Object.freeze({
  id: ID,
  deferInspection: true,
  format: Object.freeze({ id: 'wow-m2', label: 'World of Warcraft M2' }),
  operations: OPERATIONS,
  async detect(prefix: Uint8Array) {
    return isM2(prefix)
      ? { confidence: 0.98, kind: 'magic' as const, note: 'md20-md21-signature' }
      : { confidence: 0, kind: 'structure' as const, note: 'wow-m2-mismatch' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    context.signal?.throwIfAborted()
    if (bytes.byteLength > context.budget.maxScalarBytes) throw new RangeError('M2 model exceeds maxScalarBytes budget')
    const maxRecords = context.budget.maxNodes
    const issues: Issue[] = []
    const { md20, chunks } = md20Of(bytes, maxRecords)
    const sequences = readSequences(md20, maxRecords)
    const skinProfiles = md20.byteLength >= 0x48 ? new DataView(md20.buffer, md20.byteOffset).getUint32(0x44, true) : 0
    const fileIds = fileIdsOf(bytes, chunks, skinProfiles)

    // Native dependency discovery and all reads use this one logical resource port.
    const skinId = fileIds.skins[0] ? fileDataIdPath(fileIds.skins[0]) : chunks.length === 0 ? await siblingSkinId(context) : undefined
    const skinBytes = skinId === undefined ? undefined : (await readCompanions(context, [skinId], issues))[0]
    const cache = new Map<string, Uint8Array | undefined>()
    const flatStem = chunks.length === 0 ? skinId?.replace(/00\.skin$/iu, '') : undefined
    const animations = await loadAnimations(context, sequences, fileIds, issues, cache, flatStem)
    const skeletons = await loadSkeletons(context, fileIds.skeleton, issues, cache)

    let skin: M2Skin | undefined
    if (skinBytes !== undefined) {
      try {
        skin = readSkin(skinBytes, maxRecords)
      } catch (error) {
        issues.push({ code: 'skin-invalid', message: `${skinId ?? 'skin'}: ${error instanceof Error ? error.message : String(error)}` })
      }
    } else if (skinId !== undefined) {
      issues.push({ code: 'skin-unread', message: `${skinId} did not read: the model is published without geometry` })
    } else if (skinProfiles > 0) {
      issues.push({ code: 'skin-unnamed', message: 'the model names no skin file' })
    }
    const model = composeSkeleton(readM2(bytes, { maxRecords, animBuffers: animations.model,
      attachmentAnimBuffers: animations.attachments }), skeletons.parts)
    const bonePoses = await loadBonePoses(context, [...fileIds.bones, ...skeletons.parts.flatMap(part => part.fileIds.bones)],
      model.bones.length, issues, cache)
    context.signal?.throwIfAborted()
    const scene = buildM2Scene(model, skin)
    for (const note of scene.notes) issues.push({ code: 'projection', message: note })
    if (scene.nodes.length + scene.primitives.length + scene.materials.length > maxRecords)
      throw new RangeError('M2 model exceeds maxNodes budget')
    const projection = m2Projection(scene)
    const name = model.name || 'M2'
    const counts = {
      version: model.version,
      vertices: model.vertices.count,
      bones: model.bones.length,
      sequences: model.sequences.length,
      textures: model.textures.length,
      materials: model.materials.length,
      batches: skin?.batches.length ?? 0,
      submeshes: skin?.submeshes.length ?? 0,
      attachments: model.attachments.length,
      events: model.events.length,
      chunks: chunks.length,
      animFilesRead: animations.read + skeletons.read,
      animFilesNamed: animations.named + skeletons.named,
      skeletonFilesRead: skeletons.parts.length,
      bonePoseFilesNamed: bonePoses.named,
      bonePoseFilesRead: bonePoses.read,
      bonePoseFilesDecoded: bonePoses.poses.length,
      bonePoseOffsets: bonePoses.poses.reduce((sum, item) => sum + item.pose.offsets.length, 0),
      selectableClips: scene.clips.length,
      motionClips: scene.clips.filter(clip => clip.channels.length > 0).length,
      animationChannels: scene.clips.reduce((sum, clip) => sum + clip.channels.length, 0),
    }
    return {
      summary: { format: 'wow-m2', name, ...counts },
      metadata: [
        {
          id: 'wow-m2',
          label: 'World of Warcraft M2',
          entries: [{ key: 'name', value: name }, ...Object.entries(counts).map(([key, value]) => ({ key, value }))],
        },
      ],
      traits: [{ id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } }],
      diagnostics: issues.slice(0, context.budget.maxDiagnostics).map((issue, index) => ({
        id: `blizzard.wow-m2/issue-${String(index)}`,
        severity: 'warning' as const,
        category: issue.code.endsWith('unread') || issue.code.endsWith('unnamed') ? ('dependency' as const) : ('fidelity' as const),
        code: `blizzard.wow-m2/${issue.code}`,
        message: issue.message,
        ...(issue.data === undefined ? {} : { data: issue.data }),
      })),
      handlers: {
        'model-export-uvm': createUvmExportHandler(projection, context, {
          sourceFormat: 'wow-m2',
          sourceUnit: 'wow-yard',
          metersPerSourceUnit: WOW_METERS_PER_UNIT,
          allowUnitOverride: true,
          animationBudget: animationSnapshotBudget(scene.clips),
        }),
      },
      dataSources: {
        'common.view/model-scene-source': createModelSceneSource({
          info: scene.info,
          nodes: scene.nodes,
          meshes: scene.meshes,
          primitives: scene.primitives,
        }),
        'common.view/model-material-source': createModelMaterialSource({ materials: scene.materials,
          budget: { maxBytes: context.budget.maxScalarBytes, maxNodes: context.budget.maxNodes, maxDepth: context.budget.maxDepth } }),
        ...(scene.textures.length === 0
          ? {}
          : { 'common.view/model-resource-refs-source': createModelResourceRefsSource({ references: scene.textures }) }),
        ...(scene.skeleton.length === 0
          ? {}
          : { 'common.view/model-skeleton-source': createModelSkeletonSource({ bindings: scene.skeleton, hierarchies: 1 }) }),
        ...(scene.sockets.length === 0 ? {} : { 'common.view/model-socket-source': createModelSocketSource({ sockets: scene.sockets }) }),
        ...(scene.clips.length === 0 ? {} : { 'common.view/model-animation-source': createModelAnimationSource({ clips: scene.clips, budget: animationSnapshotBudget(scene.clips) }) }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'model',
          label: name,
          preview: `${String(model.vertices.count)} vertices, ${String(model.bones.length)} bones, ${String(model.sequences.length)} sequences`,
          children: [
            ...chunks.map(chunk => ({ kind: 'chunk', label: chunk.tag, preview: `${String(chunk.size)} bytes at ${String(chunk.offset)}` })),
            ...bonePoses.poses.map(({ logicalId, pose }) => ({ kind: 'bone-pose', label: logicalId,
              preview: `${String(pose.offsets.length)} native facial-pose offsets (not projected)`,
              children: pose.offsets.map(offset => ({ kind: 'bone-offset', label: `bone ${String(offset.bone)}`,
                preview: offset.matrix.join(', ') })),
            })),
          ],
        }),
      },
      unsupportedFeatures: [...new Set([
        ...scene.notes.filter(note => note.includes(': ')).map(note => `wow-m2/${note.split(': ', 1)[0]!}`),
        ...(bonePoses.named > 0 ? ['wow-m2/bone-pose-application'] : []),
      ])],
    }
  },
})

export const abiVersion = 1

/** The contribution entrypoint: the shared inspection codec over this definition. */
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
