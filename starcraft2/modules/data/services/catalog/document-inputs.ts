/** Ordered native Data input identity, shared without loading the schema or resolver. */
import type { CatalogDocument } from './catalog-analysis.js'

/** Every field affects parsing/provenance; document order and revision must also stay identical. */
export function sameCatalogDocuments(left: readonly CatalogDocument[], right: readonly CatalogDocument[]): boolean {
  return left.length === right.length && left.every((document, index) => {
    const other = right[index]
    return other?.rootId === document.rootId && other.path === document.path &&
      other.text === document.text && other.revision === document.revision
  })
}
