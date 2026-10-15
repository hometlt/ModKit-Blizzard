/**
 * The data domain's operation vocabulary — canonical architecture section 9, "Data" row:
 *
 * > Browse/query, resolve inheritance, references, diagnostics, edit, compare, export, entity
 * > cards
 *
 * Each verb maps onto a shared host operation ID wherever `ASSET_CAPABILITIES.md` section 5
 * already defines one, so a host command, a settings UI, or a CLI can offer "validate" or
 * "search" across mods, maps, and data without knowing which domain answered.
 *
 * Three verbs have no shared equivalent, so they are declared here as codec-namespaced IDs.
 * Two of the three are domain-neutral by construction and are flagged for promotion; see the
 * TODOs below. The inferred `DataOperationId` union keeps this vocabulary precise without making
 * the domain registry depend on the historical asset DTO package.
 */

/**
 * TODO: promote to `@modkitx/assets` operations.ts.
 *
 * "Resolve the inheritance/prototype chain of an entity into its effective fields" is not an SC2
 * concept: every prototype-chained game-data format (SC2 catalogs, SAGE `.ini` inheritance,
 * Diablo III SNO) needs the identical verb, and a host must be able to invoke it across all of
 * them by one ID. It is namespaced to this codec only because Phase C forbids editing
 * `@modkitx/assets` from a domain package while several domain agents work in parallel.
 */
export const DATA_RESOLVE_INHERITANCE_OPERATION_ID = 'sc2-data.resolve-inheritance'

/**
 * TODO: promote to `@modkitx/assets` operations.ts.
 *
 * "Find every reference to this entity, with source ranges" is likewise domain-neutral —
 * scripts, layouts, and localization all answer the same question about their own symbols.
 * `asset.search` is deliberately NOT reused: search is a free-text query over content, whereas
 * this resolves a typed (namespace, id) target through schema-declared link fields.
 */
export const DATA_REFERENCES_OPERATION_ID = 'sc2-data.references'

/**
 * Deliberately codec-private, NOT a promotion candidate: an "entity card" is a rendered SC2
 * unit/ability summary assembled from catalog + strings + icons by `@modkitx/wiki`. That
 * assembly is a Phase D consolidation ("Move SC2 entity-card assembly into `sc2-data`"), so the
 * operation is declared and reported `disabled` rather than silently omitted.
 */
export const DATA_ENTITY_CARDS_OPERATION_ID = 'sc2-data.entity-cards'

export const DATA_OPERATION_IDS = {
  /** Section 9: "browse/query" — schema-typed queries over the loaded catalog. */
  query: 'asset.search',
  /** Section 9: "resolve inheritance" — merge an entity's parent chain into effective fields. */
  resolveInheritance: DATA_RESOLVE_INHERITANCE_OPERATION_ID,
  /** Section 9: "references" — positional references to a (namespace, id) target. */
  references: DATA_REFERENCES_OPERATION_ID,
  /** Section 9: "diagnostics" — schema/reference validation of the GameData source. */
  diagnostics: 'asset.validate',
  /** Section 9: "edit" — raw-preserving source edits to catalog entities. */
  edit: 'edit.content',
  /** Section 9: "compare" — compare an entity across the dependency chain's override layers. */
  compare: 'asset.compare',
  /** Section 9: "export" — catalog JSON/XML and data export. */
  export: 'export.convert',
  /** Section 9: "entity cards" — assembled unit/ability card data. */
  entityCards: DATA_ENTITY_CARDS_OPERATION_ID,
  /** Browse/inspect data served from the descriptor rather than a private webview. */
  inspect: 'view.inspect',
} as const

export type DataOperationKey = keyof typeof DATA_OPERATION_IDS
export type DataOperationId = (typeof DATA_OPERATION_IDS)[DataOperationKey]

export const DATA_OPERATION_ID_LIST: readonly DataOperationId[] = Object.freeze(
  Object.values(DATA_OPERATION_IDS),
)
