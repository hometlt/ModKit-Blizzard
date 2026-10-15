/**
 * Real GameData XML wraps entities in a `<Catalog>` root:
 *   <Catalog><CUnit id="…"><LifeMax value="…"/></CUnit></Catalog>
 *
 * So the *entity* is not the top-level element — it's the first element that is a known
 * catalog class. These helpers locate entities regardless of the wrapper (and still work
 * when entities appear at the top level, as in tests/snippets without `<Catalog>`).
 */

import { hasCatalogClass } from '../../catalog-engine/sc2-catalog/index.js'
import type { ScannedElement } from './xml-scan.js'

/**
 * Re-root a cursor element path at the entity: drop ancestors above the first
 * catalog-class element (e.g. `<Catalog>`). Returns `[]` when the cursor isn't inside
 * any catalog entity. The returned elements keep their absolute source offsets.
 */
export function entityPath(path: ScannedElement[]): ScannedElement[] {
  const i = path.findIndex(e => hasCatalogClass(e.tag))
  return i === -1 ? [] : path.slice(i)
}

/** All catalog entities in a scanned forest, descending through non-entity wrappers. */
export function catalogEntities(
  roots: ScannedElement[],
  out: ScannedElement[] = [],
): ScannedElement[] {
  for (const el of roots) {
    if (hasCatalogClass(el.tag)) out.push(el)
    else catalogEntities(el.children, out)
  }
  return out
}
