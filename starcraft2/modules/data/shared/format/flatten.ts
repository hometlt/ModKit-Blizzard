/**
 * SC2 catalog flatten — port of old-parser `SCMod.fixActorSoundsLimitIssue` (sc-mod.js:2050).
 *
 * SC2 computes a per-actor/sound hash over the parent + token-template structure;
 * large mod bundles overflow its limit ("actor limit hash error"). The fix is to
 * collapse each affected entity into a standalone definition:
 *
 *   1. inline the fully-resolved data (parent chain merged),
 *   2. expand the entity's `##tok##` / `$tok` token references into literal values,
 *   3. delete the token-parameter properties themselves,
 *   4. drop `parent=` and the `default` flag.
 *
 * Token model (SC2): a base entity declares a token with `<?token id=".." type=".."
 * value=".."?>` and references it as `##id##`; descendants supply the value via a
 * like-named attribute (`unitName="Marine"`). old-parser tracks declarations in
 * `$tokens` and, for **actors**, deletes exactly the declared token properties; for
 * **sounds** it deletes every lowercase-first property (`isToken`). Both rules are
 * reproduced here. Crucially, deletion is gated on the declaration being present in
 * the LOADED inheritance chain — so flattening a mod without its core dependencies
 * keeps `unitName` etc. (no declaration in scope), exactly like old-parser.
 *
 * Only Actor and Sound are touched. Core/builtin entities are skipped via `isCore`
 * so they stay shared; defaults (empty id / default="1") and self-parented entities
 * are skipped as in old-parser. Nothing is hardcoded per fixture.
 */

import type { RawFields, RawValue, TokenDecl } from '../catalog-engine/xml/index.js'
import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'
import { buildChain, substituteTokens } from '../catalog-engine/sc2-catalog/index.js'

/** Minimal catalog surface needed by the SC2 Actor/Sound flatten transform. */
export interface CatalogFlattenStore {
  all(namespace: string): CatalogEntity[]
  get(namespace: string, id: string): CatalogEntity | undefined
  getResolved(namespace: string, id: string): RawFields | undefined
}

export interface FlattenOptions {
  /** Namespaces to flatten. Default: ['Actor', 'Sound']. */
  namespaces?: string[]
  /**
   * Treat an entity as core/builtin (skip it — keep it as a shared dependency).
   * Default: nothing is core. For multi-mod bundles pass e.g.
   * `e => CORE_MODS.some(m => e.source?.mod?.includes(m))`.
   */
  isCore?: (entity: CatalogEntity) => boolean
  /**
   * Which properties count as deletable tokens for a namespace.
   *  - 'declared' (default for everything except Sound): only `<?token?>`-declared ids.
   *  - 'lowercase' (default for Sound): every lowercase-first scalar property.
   */
  tokenRule?: (namespace: string) => 'declared' | 'lowercase'
}

export interface FlattenResult {
  entitiesFlattened: number
  tokensRemoved: number
  parentsRemoved: number
}

/** old-parser isToken: a property is a token when its first character is lowercase. */
function isLowerToken(prop: string): boolean {
  const c = prop.charAt(0)
  return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase()
}

/** Structural keys that are lowercase but never tokens. */
const NON_TOKEN_LOWER = new Set(['index', 'id', 'class', 'parent', 'default', 'removed'])

export function flatten(catalog: CatalogFlattenStore, opts: FlattenOptions = {}): FlattenResult {
  const namespaces = opts.namespaces ?? ['Actor', 'Sound']
  const isCore = opts.isCore ?? (() => false)
  const tokenRule = opts.tokenRule ?? ((ns: string) => (ns === 'Sound' ? 'lowercase' : 'declared'))
  const lookup = (ns: string, id: string) => catalog.get(ns, id)

  let entitiesFlattened = 0
  let tokensRemoved = 0
  let parentsRemoved = 0

  for (const ns of namespaces) {
    const rule = tokenRule(ns)

    // Pass 1 — snapshot resolved data + declared tokens BEFORE mutating any entity,
    // so flattening a parent cannot change what its children resolve to.
    const snapshot = new Map<string, { resolved: RawFields; declared: Map<string, TokenDecl> }>()
    for (const e of catalog.all(ns)) {
      if (!shouldFlatten(e, isCore)) continue
      const resolved = catalog.getResolved(ns, e.id)
      if (resolved === undefined) continue
      // Declared tokens = union of <?token?> decls along the inheritance chain.
      const declared = new Map<string, TokenDecl>()
      for (const anc of buildChain(e, lookup)) {
        for (const t of anc.tokens ?? []) declared.set(t.id, t)
      }
      snapshot.set(e.id, { resolved, declared })
    }

    // Pass 2 — inline, expand declared tokens, strip token props + parent.
    for (const e of catalog.all(ns)) {
      const snap = snapshot.get(e.id)
      if (snap === undefined) continue
      const { resolved, declared } = snap

      // Token value map: child override (resolved property) wins over declaration default.
      const tokenMap = new Map<string, string>()
      for (const [id, decl] of declared) {
        const override = resolved[id]
        const value = typeof override === 'string' ? override : decl.value
        if (typeof value === 'string') tokenMap.set(id, value)
      }
      tokenMap.set('id', e.id) // SC2 built-in ##id##

      const flat = substituteTokens(resolved, tokenMap) as RawFields

      // Decide which properties are deletable tokens.
      const isDeletable =
        rule === 'lowercase'
          ? (k: string, v: RawValue) =>
              !NON_TOKEN_LOWER.has(k) && isLowerToken(k) && typeof v === 'string'
          : (k: string, _v: RawValue) => declared.has(k)

      const cleaned: Record<string, RawValue> = {}
      for (const [k, v] of Object.entries(flat)) {
        if (isDeletable(k, v as RawValue)) {
          tokensRemoved++
          continue
        }
        cleaned[k] = v
      }

      ;(e as { data: RawFields }).data = cleaned as RawFields
      if (e.parent !== undefined) {
        delete (e as { parent?: string }).parent
        parentsRemoved++
      }
      entitiesFlattened++
    }
  }

  return { entitiesFlattened, tokensRemoved, parentsRemoved }
}

function shouldFlatten(e: CatalogEntity, isCore: (e: CatalogEntity) => boolean): boolean {
  if (e.id === '') return false // type default (empty id) — keep
  if (e.parent === e.id) return false // self-parented (old-parser $parent.id === id)
  if ((e as CatalogEntity & { readonly default?: string }).default === '1') return false
  if (isCore(e)) return false // shared dependency — keep
  return true
}
