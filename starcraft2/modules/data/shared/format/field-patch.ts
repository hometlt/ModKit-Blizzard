/**
 * Compatibility entrypoint for the pinned MK2 field-patch tests.
 * MK3 runtime ownership lives in modules/data/services/editing.
 */
export {
  catalogFieldExists,
  insertCatalogEntityDeclaration,
  patchCatalogField,
  type PatchResult,
} from '../../services/editing/catalog-field-patch.js'
