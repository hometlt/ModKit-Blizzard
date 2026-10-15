/** M3 publisher-only particle lighting. Derives surface programs for PAR_ LitParts without
 * changing mesh materials, native MATM indices or the shared UV vocabulary. Callers adapt native
 * RenderMaterial and public material references to this one policy. JSON ownership/output budgets
 * and cancellation are enforced; no sampling, resource acquisition or native writing occurs here.
 * See codecs/m3/codec.json and native/structures.xml (PAR_.lit_parts, MAT_.unshaded). */
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import type { ResourceBudget } from '@modkit/sdk'

export type M3ParticleLightingBudget = Pick<ResourceBudget, 'maxNodes' | 'maxDepth' | 'maxScalarBytes'>
export interface M3ParticleMaterialDerivation {
  readonly sourceIndex: number
  readonly targetIndex: number
}

/** Require a record without interpreting inert fields. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('M3 particle material requires an object')
  return value as Record<string, unknown>
}

/** Apply the emitter veto to each surface pass, retaining authored true and every other field. */
function unlitProgram(value: unknown): unknown {
  const program = record(value)
  let changed = false
  // The emitter veto cannot clear the surface's independently authored Unshaded flag.
  const standard = (value: unknown): Record<string, unknown> => {
    const surface = record(value)
    if (typeof surface['unshaded'] !== 'boolean')
      throw new TypeError('M3 particle material requires explicit unshaded')
    if (surface['unshaded']) return surface
    changed = true
    return { ...surface, unshaded: true }
  }
  const result = {
    ...program,
    ...(program['standard'] === undefined ? {} : { standard: standard(program['standard']) }),
    ...(program['composite'] === undefined ? {} : {
      composite: (() => {
        const composite = record(program['composite'])
        if (!Array.isArray(composite['passes'])) throw new TypeError('M3 composite passes absent')
        return { ...composite, passes: composite['passes'].map(raw => {
          const pass = record(raw)
          return { ...pass, material: standard(pass['material']) }
        }) }
      })(),
    }),
  }
  return changed ? result : value
}

/** Deduplicate only changed particle overrides by base identity; LitParts retains the base.
 * The dense internal DTO covers all expanded emitter ordinals, including inherited PARC copies. */
export function deriveM3ParticleMaterials<T>(
  materials: readonly T[],
  particleMaterialIndices: readonly number[],
  particleLighting: readonly boolean[],
  adapter: {
    readonly program: (material: T) => unknown | undefined
    readonly replace: (material: T, program: unknown, targetIndex: number) => T
  },
  budget: M3ParticleLightingBudget,
  signal?: AbortSignal,
): { readonly materials: readonly T[]; readonly particleMaterialIndices: readonly number[];
  readonly derivations: readonly M3ParticleMaterialDerivation[] } {
  for (const key of ['maxNodes', 'maxDepth', 'maxScalarBytes'] as const)
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0)
      throw new RangeError('M3 particle lighting budget must be positive')
  signal?.throwIfAborted()
  if (particleLighting.length !== particleMaterialIndices.length)
    throw new TypeError('M3 particle lighting must cover expanded emitter ordinals')
  const jsonBudget = { maxNodes: budget.maxNodes, maxDepth: budget.maxDepth, maxBytes: budget.maxScalarBytes }
  snapshotJson({ materials, particleMaterialIndices, particleLighting }, jsonBudget, signal)
  const output = [...materials], derived = new Map<number, number>()
  const derivations: M3ParticleMaterialDerivation[] = []
  const indices = particleMaterialIndices.map((sourceIndex, ordinal) => {
    signal?.throwIfAborted()
    const lit = particleLighting[ordinal]
    if (typeof lit !== 'boolean') throw new TypeError('M3 particle lighting requires booleans')
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= materials.length)
      throw new TypeError('M3 particle material index is absent')
    const base = materials[sourceIndex]!
    if (lit) return sourceIndex
    const previous = derived.get(sourceIndex)
    if (previous !== undefined) return previous
    const program = adapter.program(base)
    if (program === undefined) return sourceIndex
    const effective = unlitProgram(program)
    if (effective === program) return sourceIndex
    if (output.length >= budget.maxNodes) throw new RangeError('M3 particle materials exceed maxNodes')
    const targetIndex = output.length
    output.push(adapter.replace(base, effective, targetIndex))
    derived.set(sourceIndex, targetIndex)
    derivations.push({ sourceIndex, targetIndex })
    return targetIndex
  })
  const result = { materials: output, particleMaterialIndices: indices, derivations }
  snapshotJson(result, jsonBudget, signal)
  return result
}
