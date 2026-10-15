/** Single-source structural parse. Kept local until another layout codec proves the verb. */
export const LAYOUT_PARSE_OPERATION_ID = 'sc2-layout.parse'

/** Dependency-workspace semantic resolution. Kept local until another layout codec proves it. */
export const LAYOUT_RESOLVE_OPERATION_ID = 'sc2-layout.resolve'

/** Schema-backed language-service access. Kept local until another layout codec proves it. */
export const LAYOUT_LANGUAGE_FEATURES_OPERATION_ID = 'sc2-layout.language-features'

/** Schema/workspace-backed visual renderer, distinct from the structural HTML preview. */
export const LAYOUT_VISUAL_RENDER_OPERATION_ID = 'sc2-layout.render-visual'

export const LAYOUT_OPERATION_IDS = {
  parse: LAYOUT_PARSE_OPERATION_ID,
  resolve: LAYOUT_RESOLVE_OPERATION_ID,
  render: 'view.render',
  renderVisual: LAYOUT_VISUAL_RENDER_OPERATION_ID,
  inspect: 'view.inspect',
  validate: 'asset.validate',
  edit: 'edit.structure',
  languageFeatures: LAYOUT_LANGUAGE_FEATURES_OPERATION_ID,
  exportHtml: 'export.convert',
  raw: 'export.raw',
  save: 'source.save',
} as const

export type LayoutOperationKey = keyof typeof LAYOUT_OPERATION_IDS
export type LayoutOperationId = (typeof LAYOUT_OPERATION_IDS)[LayoutOperationKey]

export const LAYOUT_OPERATION_ID_LIST: readonly LayoutOperationId[] = Object.freeze(
  Object.values(LAYOUT_OPERATION_IDS),
)
