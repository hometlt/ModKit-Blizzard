/**
 * Diablo III appearance -> UVM.
 *
 * The same seam StarCraft II and Warcraft III use: the codec projects its facets, the shared
 * materializer writes the document, and the host routes it to whatever native encoder the caller
 * asked for. Nothing here knows about any target format.
 */
import type { JsonValue, RevisionId } from '@modkit/sdk'
import type { RenderModel } from '@modkit/codec-kit/legacy/models'
import { materializeUvmCore, type ModelProjection } from '@modkit/uv/model/materializer'
import { rebaseUvmScene } from '@modkit/scene/uvm/frame'
import {
  readUvmContainer,
  writeUvmContainer,
  type UvmContainer,
} from '@modkit/uv/model/container'
import {
  DIABLO3_ROOT_NODE_ID,
  diablo3AnimationClips,
  diablo3Collisions,
  diablo3Materials,
  diablo3ResourceReferences,
  diablo3SceneInfo,
  diablo3SceneMeshes,
  diablo3SceneNodes,
  diablo3ScenePrimitives,
  diablo3SkeletonBindings,
  diablo3Sockets,
} from './scene.js'

export interface Diablo3UvmOptions {
  readonly assetId: string
  readonly subjectRevision: RevisionId
  readonly metersPerSourceUnit?: number
  readonly budget: {
    readonly maxInputBytes: number
    readonly maxJsonBytes: number
    readonly maxDepth: number
    readonly maxNodes: number
  }
  readonly signal?: AbortSignal
}

function projectionOf(model: RenderModel): ModelProjection {
  const references = diablo3ResourceReferences(model)
  // The export rebases the z-up scene itself; with upAxis the materializer would turn it again.
  const { upAxis: _upAxis, ...info } = diablo3SceneInfo(model, references.length)
  return {
    info,
    nodes: diablo3SceneNodes(model),
    meshes: diablo3SceneMeshes(model),
    primitives: diablo3ScenePrimitives(model),
    materials: diablo3Materials(model),
    skeleton: diablo3SkeletonBindings(model),
    animations: diablo3AnimationClips(model, true),
    sockets: diablo3Sockets(model),
    collisions: diablo3Collisions(model),
    resourceClosure: {
      mode: 'logical',
      entries: references.map(reference => ({
        role: reference.role,
        logicalId: reference.id,
      })),
    },
  }
}

export function exportDiablo3Uvm(
  model: RenderModel,
  options: Diablo3UvmOptions,
): { readonly bytes: Uint8Array } {
  const scale = options.metersPerSourceUnit ?? 1
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('invalid metres per source unit')
  const facetBudget = {
    maxDepth: options.budget.maxDepth,
    maxNodes: options.budget.maxNodes,
    maxBytes: options.budget.maxJsonBytes,
  }
  const materialized = materializeUvmCore(
    projectionOf(model),
    {
      scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
      profile: 'UVM/core@1.0',
      subjectRevision: options.subjectRevision,
      options: { assetId: options.assetId, sourceFormat: 'diablo3-app' },
    },
    {
      materialBudget: facetBudget,
      skeletonBudget: facetBudget,
      animationBudget: facetBudget,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  const root = materialized.bindings.nodes[DIABLO3_ROOT_NODE_ID]
  if (root === undefined) throw new TypeError('the Diablo III root node was not materialized')
  // Diablo III is z-up, like StarCraft II and Warcraft III, so the same shared-root rebase carries
  // the scene into the y-up convention UVM states. No extra rotation is invented for facing.
  const rebased = rebaseUvmScene(
    readUvmContainer(materialized.bytes, options.budget, options.signal),
    [scale, 0, 0, 0, 0, 0, -scale, 0, 0, scale, 0, 0, 0, 0, 0, 1],
    options.budget,
    options.signal,
  )
  return { bytes: writeUvmContainer(withUnits(rebased, scale), options.budget, options.signal) }
}

/**
 * State the unit the document is in.
 *
 * Diablo III world units have no declared metre length, so the caller's `metersPerSourceUnit` is
 * the only thing that says what one unit means. A target that has to rescale - the StarCraft II
 * writer - refuses a document that says nothing, so declaring it is what makes this a complete
 * statement rather than a number the next tool has to guess.
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
        UV_units: { sourceUnit: 'diablo3-world-unit', metersPerSourceUnit },
      },
      extensionsUsed: declared.includes('UV_units') ? declared : [...declared, 'UV_units'],
    },
  }
}
