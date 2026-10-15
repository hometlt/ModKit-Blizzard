import type { CatalogEntity } from '../../../data/shared/catalog-engine/sc2-catalog/index.js'
import type { SC2Mod } from './mod.js'

/**
 * Host-agnostic entity-listing helpers over a hydrated {@link SC2Mod}. These are the pure core
 * that every UI surface (the VS Code Mod Card + MOD resource tree, and the LSP `modkit/modResource`
 * handler that backs the tree) shares, so the tree shows *by construction* the same entities the
 * language modules see — with no host duplicating the traversal (G8 / plan §S1: a capability a
 * second host needs lives in the library, not in a host).
 *
 * All functions take only the mod object + primitives (no VS Code / LSP types), so they are unit
 * testable and reusable from any host.
 */

/** One catalog entity as a UI row: `own` = this mod declares/patches it (vs. inherited). */
export interface ModEntitySummary {
  id: string
  name: string
  /** This mod (the last load-order entry) declares or patches the entity. */
  own: boolean
  /**
   * Its `EditorCategories` assignment (`ObjectType:Unit,ObjectFamily:Melee` →
   * `[['ObjectType','Unit'],['ObjectFamily','Melee']]`) for grouping in the Mod Card. Absent when
   * the entity has none. The MOD tree ignores this field; the Mod Card webview uses it.
   */
  cats?: Array<[string, string]>
}

/** A namespace and how many entities it holds (own = declared/patched by this mod, vs. inherited). */
export interface NamespaceSummary {
  ns: string
  own: number
  total: number
}

/** Whether this mod (the last load-order entry) declares or patches `entity`. */
export function isOwnEntity(entity: CatalogEntity, ownPath: string): boolean {
  const sources = entity.sources ?? (entity.source ? [entity.source] : [])
  return sources.some(s => s.mod === ownPath)
}

/** The primary mod's own path (the last load-order entry), or `''` when the mod is empty. */
function ownPathOf(mod: Pick<SC2Mod, 'loadOrder'>): string {
  const order = mod.loadOrder
  return order.length ? order[order.length - 1]! : ''
}

/** Parse an `EditorCategories` field value (`ObjectType:Unit,ObjectFamily:Melee`) into pairs. */
export function parseEditorCats(value: unknown): Array<[string, string]> | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : typeof (value as { value?: unknown })?.value === 'string'
        ? (value as { value: string }).value
        : undefined
  if (!raw) return undefined
  const pairs: Array<[string, string]> = []
  for (const part of raw.split(',')) {
    const colon = part.indexOf(':')
    if (colon <= 0) continue
    pairs.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()])
  }
  return pairs.length ? pairs : undefined
}

/** Plain (markup-stripped) localized name for `ns/id`, or `''` — cheap map lookup, no resolution. */
export function plainName(
  mod: { readonly locales: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>> },
  locale: string,
  ns: string,
  id: string,
): string {
  const loc = mod.locales.get(locale.toLowerCase()) ?? [...mod.locales.values()][0]
  if (!loc) return ''
  for (const file of loc.values()) {
    const v = file.get(`${ns}/Name/${id}`)
    if (v !== undefined)
      return v
        .replace(/<[^>]+>/g, '')
        .replace(/\$[^$]+\$/g, '')
        .trim()
  }
  return ''
}

/**
 * Every namespace the mod has game data in, with own/total entity counts (own = declared or
 * patched by this mod itself). Namespaces with no entities are dropped. The order is
 * {@link SC2Mod.namespaces}'s order (the caller sorts/filters for display).
 */
export function gameDataNamespaceSummaries(mod: Pick<SC2Mod, 'namespaces' | 'all' | 'loadOrder'>): NamespaceSummary[] {
  const ownPath = ownPathOf(mod)
  return mod
    .namespaces()
    .map(ns => {
      const all = mod.all(ns)
      let own = 0
      for (const e of all) if (isOwnEntity(e, ownPath)) own++
      return { ns, own, total: all.length }
    })
    .filter(n => n.total > 0)
}

/**
 * All entities of a namespace as {@link ModEntitySummary} rows — the full set (no cap), each
 * flagged own/inherited and carrying its `EditorCategories` assignment, sorted by id. Callers that
 * only want own entities filter on `own` themselves.
 */
export function collectModEntities(mod: SC2Mod, ns: string, locale: string): ModEntitySummary[] {
  const ownPath = ownPathOf(mod)
  const out: ModEntitySummary[] = []
  for (const e of mod.all(ns)) {
    if (!e.id) continue
    const resolved = mod.getResolved(ns, e.id) as Record<string, unknown> | undefined
    const cats = parseEditorCats(resolved?.['EditorCategories'])
    out.push({
      id: e.id,
      name: plainName(mod, locale, ns, e.id),
      own: isOwnEntity(e, ownPath),
      ...(cats ? { cats } : {}),
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
