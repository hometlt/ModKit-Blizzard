import type { JsonObject, JsonValue, ModelNode } from '@modkit/sdk'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { ModelProjection } from '@modkit/uv/model/materializer'
import type { M3SequenceBinding } from './animation-binding.js'

export interface M3EffectsSource {
  readonly effects: JsonObject
  /** Native producer-only DTO; consumed before publishing UV_game_effects. */
  readonly particleLighting?: readonly boolean[]
  readonly diagnostics: readonly JsonObject[]
  readonly animationMetadata: JsonValue
  readonly sequenceIndexSpace?: 'combined'
  readonly sidecarBinding?: JsonObject
  readonly emissionMeshes?: readonly {
    readonly particle: number
    readonly mesh: number
    readonly regionId: string
  }[]
}

/** The projection node of emitters that ride on no bone (native bone index -1). */
export const M3_UNBOUND_EFFECTS_NODE = 'm3/unbound-effects'

const kinds = ['particles', 'ribbons', 'forces', 'warps', 'projectors'] as const
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`invalid ${label}`)
  return value as JsonObject
}
function index(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`invalid ${label}`)
  return value
}
function items(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`invalid ${label}`)
  return value
}

/**
 * The complete frozen effects projection as the materializer's `effects`, emitters naming their
 * bones and materials by projection id. The shared scene decides which visual modes it supports;
 * this mapping never reduces rich effects to the renderer's current subset. Simulation values stay
 * in M3's own frame: the materializer names that frame the effects' `spaceNode`.
 */
export function projectM3Effects(
  input: M3EffectsSource | undefined,
  nodeIds: ReadonlySet<string>,
  materialIds: ReadonlySet<string>,
  sequenceBindings: readonly M3SequenceBinding[],
  budget: { readonly maxDepth: number; readonly maxNodes: number; readonly maxJsonBytes: number; readonly maxScalarBytes: number },
  signal?: AbortSignal,
):
  | {
      readonly effects: NonNullable<ModelProjection['effects']>
      readonly particleLighting?: readonly boolean[]
      /** The node of emitters on no bone, when some are; a root of the projection. */
      readonly unboundNode?: ModelNode
      readonly mapping: JsonObject
      readonly warnings: readonly string[]
    }
  | undefined {
  if (input === undefined) return undefined
  const owned = object(
    snapshotJson(
      input,
      {
        maxDepth: budget.maxDepth,
        maxNodes: budget.maxNodes,
        maxBytes: Math.min(budget.maxScalarBytes, budget.maxJsonBytes),
      },
      signal,
    ),
    'M3 effects source',
  )
  const effects = object(owned['effects'], 'M3 effects'),
    count = kinds.reduce((sum, kind) => sum + items(effects[kind], kind).length, 0)
  const particleLighting = owned['particleLighting']
  if (particleLighting !== undefined &&
      (!Array.isArray(particleLighting) ||
       particleLighting.length !== items(effects['particles'], 'particles').length ||
       particleLighting.some(lit => typeof lit !== 'boolean')))
    throw new TypeError('M3 particle lighting must cover expanded emitter ordinals')
  if (count === 0) return undefined
  let unbound = false
  const nativeSequences = new Map<number, number>()
  const combined = owned['sequenceIndexSpace'] === 'combined'
  if (owned['sequenceIndexSpace'] !== undefined && !combined)
    throw new TypeError('invalid M3 effect sequence index space')
  if (combined) object(owned['sidecarBinding'], 'M3 combined effect source binding')
  for (const binding of sequenceBindings) {
    if (!combined && binding.source !== 'base') continue
    const nativeIndex = index(
      combined ? binding.combinedSequenceIndex : binding.nativeSequenceIndex,
      'effect source sequence',
    )
    if (nativeSequences.has(nativeIndex))
      throw new TypeError('duplicate M3 effect native sequence binding')
    nativeSequences.set(
      nativeIndex,
      index(binding.combinedSequenceIndex, 'effect combined sequence'),
    )
  }
  const nodeOf = (value: JsonValue | undefined): string => {
    if (value === -1) {
      unbound = true
      return M3_UNBOUND_EFFECTS_NODE
    }
    const ordinal = index(value, 'M3 effect bone'),
      id = `bone/${ordinal}`
    if (!nodeIds.has(id)) throw new TypeError(`M3 effect bone ${ordinal} has no UVM node`)
    return id
  }
  const materialOf = (value: JsonValue | undefined): string => {
    const ordinal = index(value, 'M3 effect material'),
      id = `material-${ordinal}`
    if (!materialIds.has(id)) throw new TypeError(`M3 effect material ${ordinal} has no UVM material`)
    return id
  }
  // Bones anywhere below an emitter (a ribbon's spline endpoints) become node ids too; a material
  // is the emitter's own.
  const remap = (value: JsonValue, entry: boolean): JsonValue => {
    signal?.throwIfAborted()
    if (Array.isArray(value)) return value.map(item => remap(item, false))
    if (value === null || typeof value !== 'object') return value
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (key === 'boneIndex') output['nodeId'] = nodeOf(item)
      else if (key === 'materialIndex') {
        if (!entry) throw new TypeError('M3 effect names a material below its emitter')
        output['materialId'] = materialOf(item)
      } else if (key === 'sequenceIndex') {
        const nativeIndex = index(item, 'M3 effect track sequence'),
          combinedIndex = nativeSequences.get(nativeIndex)
        if (combinedIndex === undefined)
          throw new TypeError(`M3 effect sequence ${nativeIndex} has no explicit clip binding`)
        output[key] = combinedIndex
      } else output[key] = remap(item, false)
    }
    return output
  }
  const mapped: Record<string, JsonObject[]> = {}
  const correspondences: JsonObject[] = []
  for (const kind of kinds) {
    mapped[kind] = items(effects[kind], kind).map((value, ordinal) => {
      const native = object(value, `M3 ${kind} ${ordinal}`),
        converted = { ...object(remap(native, true), 'mapped M3 effect') }
      if (typeof converted['name'] !== 'string' || converted['name'].trim().length === 0)
        converted['name'] = `M3 ${kind} ${ordinal}`
      if (converted['nodeId'] === undefined) throw new TypeError('M3 effect is missing a bone anchor')
      if (
        (kind === 'particles' || kind === 'ribbons' || kind === 'projectors') &&
        converted['materialId'] === undefined
      )
        throw new TypeError('M3 effect is missing a material')
      correspondences.push({
        kind,
        emitterIndex: ordinal,
        nativeBoneIndex: native['boneIndex'] ?? null,
        nodeId: converted['nodeId'],
        ...(native['materialIndex'] === undefined
          ? {}
          : { nativeMaterialIndex: native['materialIndex'], materialId: converted['materialId'] ?? null }),
      })
      if (kind === 'particles' && converted['emitShapeMeshes'] !== undefined) {
        // Triangles as number lists; the materializer writes them to accessors.
        converted['emitShapeMeshes'] = items(converted['emitShapeMeshes'], 'effect emission meshes').map(
          candidate => {
            const geometry = object(candidate, 'effect emission mesh'),
              positions = items(geometry['positions'], 'effect emission positions'),
              indices = items(geometry['indices'], 'effect emission indices')
            if (
              positions.length === 0 ||
              positions.length % 3 !== 0 ||
              indices.length === 0 ||
              indices.length % 3 !== 0 ||
              positions.some(value => typeof value !== 'number' || !Number.isFinite(value))
            )
              throw new TypeError('invalid M3 effect triangle geometry')
            for (const value of indices)
              if (index(value, 'effect triangle index') >= positions.length / 3)
                throw new RangeError('M3 effect triangle exceeds positions')
            return { positions: [...positions], indices: [...indices] }
          },
        )
      }
      return converted
    })
  }
  const diagnostics = items(owned['diagnostics'], 'M3 effect diagnostics')
  const warnings = diagnostics.map(value => {
    const diagnostic = object(value, 'M3 effect diagnostic')
    return `${String(diagnostic['code'])}: ${String(diagnostic['message'])}`
  })
  return {
    ...(particleLighting === undefined ? {} : { particleLighting: particleLighting as boolean[] }),
    effects: { profile: 'm3', trackTimeUnit: 'seconds', ...mapped },
    ...(unbound
      ? {
          unboundNode: {
            id: M3_UNBOUND_EFFECTS_NODE,
            name: 'M3 unbound effects',
            childIds: [],
            meshIds: [],
            transform: IDENTITY,
          },
        }
      : {}),
    mapping: {
      correspondences,
      emissionMeshes: items(owned['emissionMeshes'], 'emission mesh correspondences'),
      diagnostics,
      animationMetadata: owned['animationMetadata'] ?? null,
      ...(combined
        ? { sidecarBinding: object(owned['sidecarBinding'], 'M3 combined effect binding') }
        : {}),
      nativeSequenceBindings: sequenceBindings
        .filter(binding => combined || binding.source === 'base')
        .map(binding => ({
          source: binding.source,
          ...(binding.logicalId === undefined ? {} : { logicalId: binding.logicalId }),
          nativeSequenceIndex: binding.nativeSequenceIndex,
          combinedSequenceIndex: binding.combinedSequenceIndex,
          clipId: binding.clipId,
        })),
      notes: [
        'Emitter indices are the frozen projection ordinals, including expanded PARC copies; they are not claimed as raw PAR_ section indices.',
        'The pinned M3 effects adapter supplies all projected fields; unsupported native fields stay in the exact native source and explicit adapter diagnostics.',
        'Ribbons use the pinned 20 Hz preview cadence; M3 does not store a portable spawn cadence.',
        combined
          ? 'Admitted sidecar effect tracks use exact native animation IDs and explicit source-to-combined sequence bindings.'
          : 'Effect tracks use base-source native sequence bindings.',
      ],
    },
    warnings,
  }
}
