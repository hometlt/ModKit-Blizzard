/** Bounded native material/texture parameter decoding and native projection refusal identities.
 * Refusal facts remain outside render programs; supported standard/composite publication is unchanged. */
import { createM3SectionResolver } from './section-resolver.js'
import { snapshotJson } from '@modkit/codec-kit'
import type { ModelMaterialRef, ResourceBudget } from '@modkit/sdk'
import { buildRenderMaterials, m3MaterialProjectionRefusals } from '../../dist/m3/native/builder/standard-material.js'
import { getModelTexturePaths } from '../../dist/m3/native/builder/metadata.js'
import type { M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'

interface MaterialParameterProjection {
  readonly unsupportedMaterialProjections: readonly number[]
  readonly materials: readonly {
    readonly name: string
    readonly layers: readonly { readonly label: string; readonly path: string }[]
    readonly shader?: NonNullable<ModelMaterialRef['shader']>
  }[]
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
}

/** Exact MODL → MAT_ → LAYR → CHAR references; unrelated strings are not resource claims. */
export function readM3TexturePaths(
  sections: SectionResolver & { readonly model: M3StructureData },
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): readonly string[] {
  const resolver = createM3SectionResolver(sections, budget, signal)
  return snapshotJson(
    getModelTexturePaths(sections.model, resolver),
    {
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
      maxBytes: budget.maxScalarBytes,
    },
    signal,
  ) as readonly string[]
}

/** Invoke the pinned material algorithm through a bounded, declared-reference resolver. */
export function decodeMaterialParameters(
  sections: SectionResolver & { readonly model: M3StructureData },
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes' | 'maxScalarBytes'>,
  signal?: AbortSignal,
): MaterialParameterProjection {
  const resolver = createM3SectionResolver(sections, budget, signal)
  const decoded = buildRenderMaterials(sections.model, resolver)
  // One aggregate snapshot charges repeated composite passes and animation keys, not just tables.
  return snapshotJson(
    {
      materials: decoded.materials.map(material => ({
        name: material.name,
        layers: material.layers,
        ...(material.standard === undefined && material.composite === undefined
          ? {}
          : {
              shader: {
                id: 'modkit.render-material.v1',
                parameters: {
                  renderModel: {
                    version: 1,
                    ...(typeof material.metadata?.['presentation'] === 'string'
                      ? { presentation: material.metadata['presentation'] }
                      : {}),
                    layers: material.layers,
                    standard: material.standard,
                    composite: material.composite,
                    metadata: material.metadata,
                  },
                },
              },
            }),
      })),
      diagnostics: decoded.diagnostics,
      unsupportedMaterialProjections: m3MaterialProjectionRefusals(decoded.materials),
    },
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxScalarBytes },
    signal,
  ) as unknown as MaterialParameterProjection
}
