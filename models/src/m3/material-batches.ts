import { modelPrimitiveByteLength } from '@modkit/codec-kit'
import type { ModelMesh, ModelPrimitive, ResourceBudget } from '@modkit/sdk'
import { getAllRegionBatches } from '../../dist/m3/native/builder/material-helpers.js'
import type { M3Reference, M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'
import { createM3SectionResolver } from './section-resolver.js'

export interface M3MaterialBinding {
  /** Geometry decoder's region identity; several ordered batches may share it. */
  readonly primitiveId: string
  readonly materialId: string
  /** A batch the game does not draw (MAT_ geometry_visible off): it makes no primitive. */
  readonly hidden?: true
}

/** Preserve every authored batch, including repeated uses of the same material. */
export function readM3MaterialBindings(
  sections: SectionResolver & { readonly model: M3StructureData },
  materials: readonly { readonly referenceIndex: number; readonly id: string }[],
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes'>,
  signal?: AbortSignal,
): {
  readonly bindings: readonly M3MaterialBinding[]
  readonly rejected: number
  readonly ambiguous: 0
} {
  const resolver = createM3SectionResolver(sections, budget, signal)
  const records = (reference: M3Reference | undefined): readonly M3StructureData[] =>
    (resolver.getSectionByReference(reference)?.content ?? []) as M3StructureData[]
  const byReference = new Map(materials.map(material => [material.referenceIndex, material.id]))
  const bindings: M3MaterialBinding[] = []
  let rejected = 0
  let regionOffset = 0
  for (const division of records(sections.model['divisions'] as M3Reference | undefined)) {
    const regions = records(division['regions'] as M3Reference | undefined)
    const batches = records(division['batches'] as M3Reference | undefined)
    for (const batch of batches) {
      const region = Number(batch['region_index'])
      const material = Number(batch['material_reference_index'])
      if (
        !Number.isSafeInteger(region) ||
        region < 0 ||
        region >= regions.length ||
        !byReference.has(material)
      )
        rejected++
    }
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
      for (const batch of getAllRegionBatches(sections.model, resolver, division, regionIndex)) {
        const materialId = byReference.get(batch.materialReferenceIndex)
        if (materialId === undefined) continue
        if (bindings.length >= budget.maxNodes)
          throw new RangeError('M3 material batches exceed maxNodes')
        bindings.push(
          Object.freeze({
            primitiveId: `mesh-0-primitive-${regionOffset + regionIndex}`,
            materialId,
            ...(batch.geometryVisible ? {} : { hidden: true as const }),
          }),
        )
      }
    }
    regionOffset += regions.length
  }
  return Object.freeze({ bindings: Object.freeze(bindings), rejected, ambiguous: 0 })
}

interface RegionGeometry {
  readonly meshes: readonly ModelMesh[]
  readonly primitives: readonly ModelPrimitive[]
  readonly decodedBytes: number
}

/** One MK3 primitive per draw batch; buffers remain shared until the source takes ownership. */
export function projectM3MaterialBatches<T extends RegionGeometry>(
  geometry: T,
  bindings: readonly M3MaterialBinding[],
  budget: Pick<ResourceBudget, 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): T {
  if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
  const byRegion = new Map<string, M3MaterialBinding[]>()
  for (const binding of bindings) {
    const region = byRegion.get(binding.primitiveId) ?? []
    region.push(binding)
    byRegion.set(binding.primitiveId, region)
  }
  const primitives: ModelPrimitive[] = []
  const remapped = new Map<string, string[]>()
  let decodedBytes = 0
  for (const region of geometry.primitives) {
    if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
    // Batches the game draws; a region whose every batch is hidden makes no primitive at all
    // (InvisibleWalkablePlatform's editor slab), not one without a material.
    const authored = byRegion.get(region.id)
    const batches = authored?.filter(batch => batch.hidden !== true)
    const count = batches?.length ?? 1
    decodedBytes += modelPrimitiveByteLength(region) * count
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > budget.maxScalarBytes) {
      throw new RangeError('M3 material batch geometry exceeds maxScalarBytes')
    }
    if (primitives.length + count > budget.maxNodes)
      throw new RangeError('M3 material batch primitives exceed maxNodes')
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const id = `mesh-0-primitive-${primitives.length}`
      const materialId = batches?.[index]?.materialId
      ids.push(id)
      primitives.push(
        Object.freeze({ ...region, id, ...(materialId === undefined ? {} : { materialId }) }),
      )
    }
    remapped.set(region.id, ids)
  }
  return Object.freeze({
    ...geometry,
    primitives: Object.freeze(primitives),
    meshes: Object.freeze(
      geometry.meshes.map(mesh =>
        Object.freeze({
          ...mesh,
          primitiveIds: Object.freeze(mesh.primitiveIds.flatMap(id => remapped.get(id) ?? [])),
        }),
      ),
    ),
    decodedBytes,
  })
}
