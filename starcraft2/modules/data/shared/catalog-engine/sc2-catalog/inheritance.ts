import type { RawFields, RawObject, RawValue } from '../xml/index.js'
import type { SchemaRegistry } from '../sc2-schema/index.js'
import type { CatalogEntity } from './types.js'
import { mergeFields, withoutTombstones } from './merge.js'

type EntityLookup = (namespace: string, id: string) => CatalogEntity | undefined

/** Merged chain prefixes: the entity that ends one → leaf class → fields merged up to it. */
export type ChainPrefixCache = Map<CatalogEntity, Map<string, RawFields>>

/** The anonymous `default="1"` template an entity without an explicit parent inherits from. */
export type ClassDefaultLookup = (entity: CatalogEntity) => CatalogEntity | undefined

/**
 * Build parent → child chain for an entity.
 * Returns array ordered root-first (CBase at index 0, entity at last).
 * Stops silently on dangling parent references or cycles.
 *
 * With `defaultOf` an entity without a parent inherits its own class's template (see
 * `TypedCatalog`); without it, the namespace's merged template (id `''`) as before.
 */
export function buildChain(
  entity: CatalogEntity,
  lookup: EntityLookup,
  defaultOf?: ClassDefaultLookup,
): CatalogEntity[] {
  const chain: CatalogEntity[] = []
  // By identity: every anonymous template has the id `''`.
  const seen = new Set<CatalogEntity>()

  let cur: CatalogEntity | undefined = entity
  while (cur !== undefined) {
    if (seen.has(cur)) break
    seen.add(cur)
    chain.unshift(cur)
    if (cur.parent !== undefined) {
      cur = lookup(entity.namespace, cur.parent)
    } else if (defaultOf !== undefined) {
      cur = defaultOf(cur)
    } else if (cur.id !== '') {
      // SC2 implicit default: entities without an explicit parent inherit from the default entity (id='')
      cur = lookup(entity.namespace, '')
    } else {
      cur = undefined
    }
  }

  return chain
}

/**
 * Resolve an entity by merging its full parent chain.
 * Returns merged RawFields from root to leaf (child wins).
 * Result is not cached here — caching is TypedCatalog's responsibility.
 */
export function resolveEntity(
  entity: CatalogEntity,
  lookup: EntityLookup,
  schema: SchemaRegistry,
  defaultOf?: ClassDefaultLookup,
  prefixes?: ChainPrefixCache,
): RawFields {
  const chain = buildChain(entity, lookup, defaultOf)
  const fields = schema.resolveFields(entity.class)

  // A chain prefix merges the same way for every entity below it, so siblings share their
  // ancestors' merge (per leaf class: its schema decides how lists merge). Tombstones stay in a
  // prefix; only the finished chain drops them.
  let start = 0
  let result: RawFields = {}
  for (let index = chain.length - 1; index >= 0 && prefixes !== undefined; index -= 1) {
    const cached = prefixes.get(chain[index]!)?.get(entity.class)
    if (cached !== undefined) {
      result = cached
      start = index + 1
      break
    }
  }
  for (let index = start; index < chain.length; index += 1) {
    const link = chain[index]!
    result = mergeFields(result, link.data, fields)
    if (prefixes !== undefined) {
      const byClass = prefixes.get(link) ?? new Map<string, RawFields>()
      byClass.set(entity.class, result)
      prefixes.set(link, byClass)
    }
  }
  result = withoutTombstones(result)

  // Normalise: schema array fields that ended up as a non-array value (single XML element)
  // should always be returned as arrays so callers can rely on consistent types.
  const wrapped: Record<string, RawValue> = {}
  for (const [key, val] of Object.entries(result)) {
    if (fields[key]?.isArray === true && !Array.isArray(val)) wrapped[key] = [val]
  }
  if (Object.keys(wrapped).length > 0) result = { ...result, ...wrapped }

  // Normalise mixed explicit/implicit indices in numeric-indexed arrays.
  // SC2 assigns a running index per element in document order; an explicit
  // `index="N"` sets the counter, so a following bare element continues from N+1
  // (e.g. `<On index="84"/>` then a bare `<On/>` → slot 85). Without this a bare
  // element keeps only its array position, diverging from SC2/old-parser.
  // Data-driven (not schema-gated, since not every array field is in the builtin
  // schema): applied only to arrays that actually MIX numeric-`index` elements
  // with bare object elements — id-keyed (named) and scalar arrays never match.
  for (const [key, val] of Object.entries(result)) {
    if (!Array.isArray(val)) continue
    const next = assignSequentialIndices(val as RawValue[])
    if (next !== undefined) result = { ...result, [key]: next }
  }

  return result
}

/**
 * Fill in `index` on bare elements of a numeric-indexed array using the SC2
 * running-counter rule. Returns a new array, or undefined when the array is not
 * a mix of explicit-numeric-index and bare object elements (nothing to do).
 */
function assignSequentialIndices(arr: RawValue[]): RawValue[] | undefined {
  const isObj = (x: RawValue): x is RawObject =>
    x !== null && typeof x === 'object' && !Array.isArray(x)

  let hasExplicit = false
  let hasBare = false
  for (const it of arr) {
    if (!isObj(it)) return undefined            // scalar array — leave as-is
    const idx = (it as RawObject)['index']
    if (typeof idx === 'string' && /^\d+$/.test(idx)) hasExplicit = true
    else if (idx === undefined) hasBare = true
    else return undefined                        // non-numeric index (e.g. id-keyed) — leave as-is
  }
  if (!hasExplicit || !hasBare) return undefined

  let counter = 0
  return arr.map(it => {
    const o = it as RawObject
    const idx = o['index']
    if (typeof idx === 'string' && /^\d+$/.test(idx)) {
      counter = Number(idx) + 1
      return it
    }
    const assigned = { index: String(counter), ...o }
    counter++
    return assigned
  })
}
