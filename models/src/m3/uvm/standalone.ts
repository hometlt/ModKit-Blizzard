import type { ModelProjection } from '@modkit/uv/model/materializer'

/** The native codec's explicit standalone interpretation, not a source-format detector. */
export const M3A_STANDALONE_ASSET_KIND = 'm3a-animation-bundle'

/**
 * Match the authored standalone M3A policy before either facets or UVM consume the projection.
 * Native sequences, skeleton and sockets remain intact. Inapplicable animation targets remain
 * descriptive channels; the common materializer records their losses rather than discarding them
 * here. The caller separately retains the original native metadata, resource references and bytes.
 */
export function projectStandaloneM3Bundle(source: ModelProjection): ModelProjection {
  const nodes = Object.freeze(
    (source.nodes ?? []).map(node => Object.freeze({ ...node, meshIds: Object.freeze([]) })),
  )
  return Object.freeze({
    ...source,
    info: Object.freeze({
      scenes: source.info.scenes,
      nodes: nodes.length,
      meshes: 0,
      primitives: 0,
      materials: 0,
      textures: 0,
      animations: source.info.animations,
      geometryAccess: source.info.geometryAccess,
    }),
    nodes,
    meshes: Object.freeze([]),
    primitives: Object.freeze([]),
    materials: Object.freeze([]),
    resourceClosure: Object.freeze({ mode: 'logical', entries: Object.freeze([]) }),
  })
}
