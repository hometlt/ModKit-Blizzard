/**
 * Collect the `<?token?>` types declared for an entity along its inheritance
 * chain. A descendant supplies a token value via a like-named attribute
 * (`unitName="Marine"`), while the declaration — including its `type`
 * (e.g. `CUnitLink`) — lives on a base/template in the chain. Walkers use this
 * to resolve token attributes to namespaces from data, with no hardcoded tables.
 *
 * Returns a map keyed by token id → declared `type` (undefined when declared
 * without one). Token ids are case-sensitive and may start with any letter
 * (not only lower-case), so they are keyed exactly as declared. The deepest
 * declaration in the chain wins.
 *
 * Phase D item 3 moved this here from `@modkitx/ops`: `<?token?>` declarations are catalog
 * inheritance-chain semantics, which is `sc2-data`'s domain. `@modkitx/ops` re-exports it.
 */

import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'
import { buildChain } from '../catalog-engine/sc2-catalog/index.js'

type EntityLookup = (namespace: string, id: string) => CatalogEntity | undefined
type TokenDecl = { readonly id: string; readonly type?: string }
type TokenEntity = CatalogEntity & { tokens?: ReadonlyArray<TokenDecl> }

export function declaredTokenTypes(
  entity: CatalogEntity,
  lookup: EntityLookup,
): Map<string, string | undefined> {
  const types = new Map<string, string | undefined>()
  for (const ancestor of buildChain(entity, lookup)) {
    for (const decl of (ancestor as TokenEntity).tokens ?? []) {
      types.set(decl.id, decl.type)
    }
  }
  return types
}
