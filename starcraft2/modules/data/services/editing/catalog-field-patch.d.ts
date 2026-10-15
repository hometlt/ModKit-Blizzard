export interface PatchResult {
  text: string
  changed: boolean
  reason?: string
}
export function catalogFieldExists(
  xml: string,
  className: string,
  id: string,
  fieldPath: string,
): boolean
export function insertCatalogEntityDeclaration(
  xml: string,
  className: string,
  id: string,
): PatchResult
export function insertCatalogEntityXml(xml: string, className: string, id: string, declaration: string): PatchResult
export function patchCatalogField(
  xml: string,
  className: string,
  id: string,
  fieldPath: string,
  newValue: string | null,
): PatchResult
export function patchCatalogIndexedEntryRemoval(
  xml: string,
  className: string,
  id: string,
  fieldPath: string,
  index: string | number,
  indexKey?: string,
): PatchResult
export function patchCatalogIndexedEntry(
  xml: string,
  className: string,
  id: string,
  fieldPath: string,
  index: string | number,
  newValue: import('@modkit/core').JsonValue,
  indexKey?: string,
): PatchResult
