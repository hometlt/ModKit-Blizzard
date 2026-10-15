/**
 * Schema-driven catalog entity rename — the catalog/entity half of what used to be
 * `@modkitx/ops`'s single ~780-line `renameEntities()` function (Phase D item 3,
 * "`sc2-data` schema/catalog/language/editor/cards").
 *
 * What lives here is exactly the part that is catalog semantics:
 *
 *   - plain link fields (`CLink` subclasses) and token attributes (resolved from each entity's
 *     `<?token?>` declarations — see `token-decls.ts`)
 *   - composite scalars: abilcmd `"X,Execute"`, catalog references `"Effect,X,Field"`,
 *     actor terms `"Abil.X.Start; ValidateUnit V"`, send payloads `"Create X"`,
 *     site-ops lists `"SOpA SOpB"`, queries `"::actor.X"` — rewritten in place by
 *     character-span splicing, so original formatting is preserved
 *   - `parent=` chains
 *   - GameStrings/ObjectStrings keys `"Ns/Field/<id>"` → `"Ns/Field/<newId>"` (new key added,
 *     old key kept — old-parser behavior), plus the entity fields holding those keys
 *   - entity ids embedded in localized string VALUES (`<d ref>`, `<d stringref>`, `$token:…$`)
 *   - re-keying the entities themselves
 *
 * What deliberately does NOT live here is the cross-domain orchestration the old function
 * interleaved: Triggers XML (`@modkitx/ops`'s `rename-triggers.ts`, Phase D item 4), `.SC2Layout`
 * files (`rename-layouts.ts`, item 5), and the SC2Map Objects/Preload/Triggers files
 * (`rename-objects.ts`/`rename-preload.ts`, item 7). Those domains have not been consolidated
 * yet, so `@modkitx/ops` still drives them — using the `mapped`/`canon`/`textKeyRenames` handles
 * this function returns. See `packages/ops/src/rename.ts`.
 *
 * Patching is driven by walking RAW entity data against the structure-types schema (not by a
 * pre-collected reference list), so the same rules apply uniformly and nothing depends on
 * relation-graph staleness.
 *
 * **This transform mutates the supplied store in place**, matching the behavior every existing
 * caller of `renameEntities()` depends on. `sc2-data`'s `AssetEditTransaction` wrapper in
 * `edit.ts` is what turns it into a validated plan plus `AssetOutput`s.
 */

import {
  DATA_CLASS_SCHEMA,
  CLink,
  CFile,
  CTuple,
  CWTuple,
  CDTuple,
  CSTuple,
  COTuple,
  CStringArray,
  CCArray,
  CSArray,
  CWArray,
  CRecord,
  CCatalogReference,
  CGameContentCreationData,
  CDataEntryPath,
  CATALOG_NAMESPACES,
  tokenTypeNamespace,
} from '../catalog-engine/sc2-schema/index.js'
import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'
import { declaredTokenTypes } from './token-decls.js'

/** One rename request. */
export interface CatalogRenameSpec {
  /** Namespace of the entity to rename. */
  namespace: string
  /** Current id. */
  oldId: string
  /** New id. May include '*' as a placeholder for the current id, e.g. "Prefix*". */
  newId: string
}

/**
 * A localized-string key referenced by an entity, as produced by a relation graph.
 *
 * Deliberately structural rather than `@modkitx/ops`'s `TextRef`: `data-processing` must never
 * import `@modkitx/ops` (the dependency runs the other way), and only these two fields are read.
 */
export interface CatalogTextReference {
  readonly from: { readonly namespace: string; readonly id: string }
  /** The string key, e.g. `Unit/Name/Marine`. */
  readonly key: string
}

/**
 * The minimal catalog store this transform needs. Both `@modkitx/mods-processing/sc2-mod-core`'s `SC2Mod` and
 * `@modkitx/data-processing/sc2-catalog`'s `TypedCatalog` satisfy it structurally; only `SC2Mod` carries `locales`,
 * so string re-keying degrades to a no-op on a bare catalog rather than throwing.
 */
export interface CatalogRenameStore {
  namespaces(): string[]
  all(namespace: string): CatalogEntity[]
  get(namespace: string, id: string): CatalogEntity | undefined
  /** Re-keys the store. Absent on stores that cannot rename; entities are then only patched. */
  renameEntry?(namespace: string, oldId: string, newId: string): void
  /** locale code → strings-file stem → key → value. Mutated in place when present. */
  readonly locales?: ReadonlyMap<string, ReadonlyMap<string, Map<string, string>>>
}

export interface CatalogRenameOptions {
  /**
   * Localized-string keys referenced by each entity, used for the old-parser `resolveText`
   * behavior: a `'*'`-masked spec applies its mask to the last segment of every string key the
   * renamed entity references. Omit to skip that pass.
   */
  readonly textReferences?: readonly CatalogTextReference[]
}

export interface CatalogRenameResult {
  /** Number of entities renamed. */
  entitiesRenamed: number
  /** Number of field values patched across all referencing entities. */
  referencesPatched: number
  /** Number of locale string keys re-keyed (new key added per locale/file). */
  stringsRenamed: number
  /**
   * old string key → new string key. Other domains (`.SC2Layout` reference values) need this to
   * patch their own references to the re-keyed strings.
   */
  readonly textKeyRenames: ReadonlyMap<string, string>
  /** `(namespace, id) -> newId` for the applied renames, namespace-canonicalized. */
  mapped(namespace: string, id: string): string | undefined
  /** Canonical spelling of a namespace, or `undefined` when it is not a catalog namespace. */
  canon(namespace: string): string | undefined
}

/** Reusable, non-mutating routing handles for sibling semantic rename transactions. */
export interface CatalogRenameRouting {
  mapped(namespace: string, id: string): string | undefined
  canon(namespace: string): string | undefined
}

/**
 * Builds the exact namespace/id mapper used by {@link renameCatalogEntities} without touching a
 * catalog. `sc2-mod` uses this to give sibling semantic transactions the same rename semantics.
 */
export function createCatalogRenameRouting(
  specs: readonly CatalogRenameSpec[],
  additionalNamespaces: readonly string[] = [],
): CatalogRenameRouting {
  const nsCanon = new Map<string, string>()
  for (const namespace of CATALOG_NAMESPACES) nsCanon.set(namespace.toLowerCase(), namespace)
  for (const namespace of additionalNamespaces) nsCanon.set(namespace.toLowerCase(), namespace)
  const canon = (namespace: string): string | undefined => nsCanon.get(namespace.toLowerCase())

  const renameMap = new Map<string, Map<string, string>>()
  for (const spec of specs) {
    const namespace = canon(spec.namespace) ?? spec.namespace
    const byId = renameMap.get(namespace) ?? new Map<string, string>()
    byId.set(spec.oldId, spec.newId.replace('*', spec.oldId))
    renameMap.set(namespace, byId)
  }
  const mapped = (namespace: string, id: string): string | undefined => {
    const canonical = canon(namespace)
    return canonical === undefined ? undefined : renameMap.get(canonical)?.get(id)
  }
  return { mapped, canon }
}

type AnyClass = { new (...args: unknown[]): unknown } & Record<string, unknown>
type DataObject = Record<string, unknown>

const SKIP_PROPS = new Set(['index', 'class', 'removed', 'id', 'ID', 'default'])

function isClass(v: unknown): v is AnyClass {
  return typeof v === 'function'
}

function isLinkClass(t: unknown): t is AnyClass & { link: string } {
  return isClass(t) && t.prototype instanceof CLink && typeof (t as any).link === 'string'
}

function isFileClass(t: unknown): boolean {
  const ctor = t as any
  return isClass(t) && (ctor === CFile || ctor.prototype instanceof CFile)
}

function isStructClass(t: unknown): t is AnyClass & { schema: DataObject } {
  return (
    isClass(t) &&
    !!(t as any).schema &&
    typeof (t as any).schema === 'object' &&
    Object.keys((t as any).schema).length > 0
  )
}

function isRecordClass(t: unknown): t is AnyClass & { value: unknown } {
  return isClass(t) && t.prototype instanceof CRecord && 'value' in t
}

function isRecordSpec(t: unknown): t is { index: unknown; value: unknown } {
  return (
    t !== null &&
    typeof t === 'object' &&
    !Array.isArray(t) &&
    'index' in (t as object) &&
    'value' in (t as object)
  )
}

function ownField(schema: DataObject, prop: string): unknown {
  return Object.prototype.hasOwnProperty.call(schema, prop) ? schema[prop] : undefined
}

function schemaField(schema: DataObject, prop: string): unknown {
  const exact = ownField(schema, prop)
  if (exact !== undefined) return exact
  if (!prop) return undefined
  const upperFirst = prop[0]!.toUpperCase() + prop.slice(1)
  return upperFirst === prop ? undefined : ownField(schema, upperFirst)
}

function structLinkField(t: unknown): unknown {
  if (!isStructClass(t)) return undefined
  const link = ownField((t as any).schema, 'Link')
  return isLinkClass(link) ? link : undefined
}

function isCatalogRefClass(t: AnyClass): boolean {
  const ctor = t as any
  return (
    ctor === CCatalogReference ||
    ctor === CGameContentCreationData ||
    ctor === CDataEntryPath ||
    ctor.prototype instanceof CCatalogReference ||
    ctor.prototype instanceof CGameContentCreationData ||
    ctor.prototype instanceof CDataEntryPath
  )
}

function tupleSeparator(t: AnyClass): string {
  const p = t.prototype
  if (p instanceof CWTuple) return ' '
  if (p instanceof CDTuple) return '.'
  if (p instanceof CSTuple) return ';'
  if (p instanceof COTuple) return ':'
  return ','
}

function arraySeparator(t: AnyClass): string {
  const p = t.prototype
  if (p instanceof CWArray) return ' '
  if (p instanceof CSArray) return ';'
  if (p instanceof CCArray) return ','
  return ','
}

/** A pending replacement inside a scalar string. */
interface Splice {
  start: number
  end: number
  text: string
}

/** `Ns,Entity,Field` reference tuple embedded in a localized string value. */
const STRING_REF_TUPLE = /([A-Za-z_]\w*),([A-Za-z_][\w@]*),([\w.[\]]+)/g

/**
 * Rewrite catalog references embedded in a localized string VALUE (`<d ref>`,
 * `<d stringref>`, and `$token:…:Ns,Id,Field$` operation expressions) when the
 * referenced entity was renamed. `newIdByKey` is keyed by `${nsLower}/${oldId}`.
 * The `@…` array suffix on an entity (e.g. `Marine@Upgrade`) is preserved.
 */
export function renameRefsInStringValue(value: string, newIdByKey: Map<string, string>): string {
  return value.replace(STRING_REF_TUPLE, (whole, ns: string, entity: string, field: string) => {
    const base = entity.replace(/@.*$/, '')
    const suffix = entity.slice(base.length)
    const newId = newIdByKey.get(`${ns.toLowerCase()}/${base}`)
    return newId ? `${ns},${newId}${suffix},${field}` : whole
  })
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * Rename catalog entities and patch every catalog-level reference form the schema knows about.
 *
 * Mutates `store` in place and returns both the counts and the handles (`mapped`, `canon`,
 * `textKeyRenames`) that other domains need to patch their own reference forms.
 */
export function renameCatalogEntities(
  store: CatalogRenameStore,
  specs: readonly CatalogRenameSpec[],
  options: CatalogRenameOptions = {},
): CatalogRenameResult {
  let entitiesRenamed = 0
  let referencesPatched = 0
  let stringsRenamed = 0

  // canonical ns map
  const { canon, mapped } = createCatalogRenameRouting(specs, store.namespaces())

  // per-namespace oldId → newId
  const resolvedSpecs: Array<{
    namespace: string
    oldId: string
    newId: string
    mask: string | null
  }> = []
  for (const spec of specs) {
    const ns = canon(spec.namespace) ?? spec.namespace
    const newId = spec.newId.replace('*', spec.oldId)
    // text-key mask (old-parser resolveText): a '*' pattern applies to the last
    // segment of every string key the renamed entity references
    const mask = spec.newId.includes('*') ? spec.newId : null
    resolvedSpecs.push({ namespace: ns, oldId: spec.oldId, newId, mask })
  }

  const lookup = (ns: string, id: string) => store.get(ns, id)
  // Declared `<?token?>` types for the entity currently being walked: exact
  // token id → declared `type`. Rebuilt per entity from its inheritance chain.
  let currentTokens = new Map<string, string | undefined>()

  // ── scalar rewriting (span-splice, preserves original formatting) ──────────

  /** Collect splices for one scalar string of schema type `t`. `base` offsets spans. */
  function collectSplices(value: string, t: unknown, base: number, out: Splice[]): void {
    if (!value || value === '*' || !isClass(t)) return

    // '::ns.link' query form
    if (value.startsWith('::')) {
      const m = /^::(\w+)\.([\w@_#-]+)/.exec(value)
      if (m) {
        const repl = mapped(m[1]!, m[2]!)
        if (repl !== undefined) {
          const start = base + 2 + m[1]!.length + 1
          out.push({ start, end: start + m[2]!.length, text: repl })
        }
      }
      return
    }

    if (isLinkClass(t)) {
      if ((t as any).link === 'String' || isFileClass(t)) return
      const repl = mapped((t as any).link, value)
      if (repl !== undefined) out.push({ start: base, end: base + value.length, text: repl })
      return
    }

    if (isFileClass(t)) return

    const shorthandLink = structLinkField(t)
    if (shorthandLink) {
      collectSplices(value, shorthandLink, base, out)
      return
    }

    if (isCatalogRefClass(t)) {
      // "Catalog,EntityId[,FieldPath]"
      const firstComma = value.indexOf(',')
      if (firstComma < 0) return
      const secondComma = value.indexOf(',', firstComma + 1)
      const idEnd = secondComma < 0 ? value.length : secondComma
      const nsTok = value.slice(0, firstComma).trim()
      const idTok = value.slice(firstComma + 1, idEnd).trim()
      const repl = mapped(nsTok, idTok)
      if (repl !== undefined) {
        const start = base + value.indexOf(idTok, firstComma + 1)
        out.push({ start, end: start + idTok.length, text: repl })
      }
      return
    }

    // Dyn scalar: instruction tables (send / terms / query / actor-key / driver)
    const resolver = (t as any).resolver as ((d: { value: string }) => unknown) | undefined
    if (typeof resolver === 'function') {
      const bang = value.startsWith('!') ? 1 : 0
      const stripped = value.slice(bang)
      let resolved: unknown
      try {
        resolved = resolver({ value: stripped })
      } catch {
        resolved = undefined
      }
      if (!resolved) return
      if (Array.isArray(resolved)) {
        // dotted event form: "Tag.Arg1.Arg2" — args at dot positions
        const off = stripped.indexOf('.')
        if (off < 0) return
        const parts = stripped.split('.')
        let cursor = parts[0]!.length + 1
        resolved.forEach((argT, i) => {
          const arg = parts[i + 1]
          if (arg === undefined) return
          if (arg && isLinkClass(argT)) {
            const repl = mapped((argT as any).link, arg)
            if (repl !== undefined) {
              out.push({
                start: base + bang + cursor,
                end: base + bang + cursor + arg.length,
                text: repl,
              })
            }
          }
          cursor += arg.length + 1
        })
        return
      }
      if (isClass(resolved) && resolved !== t) collectSplices(stripped, resolved, base + bang, out)
      return
    }

    // Union scalar (CRefKey): try each member type
    const unionTypes = (t as any).types as unknown[] | undefined
    if (Array.isArray(unionTypes) && !(t.prototype instanceof CTuple)) {
      for (const ut of unionTypes) {
        if (isLinkClass(ut)) collectSplices(value, ut, base, out)
      }
      return
    }

    // Tuple scalar: positional parse with brace groups for space separation
    if (t.prototype instanceof CTuple) {
      const memberTypes = (t as any).memberTypes as unknown[] | undefined
      if (!memberTypes || memberTypes.length === 0) return
      const sep = tupleSeparator(t)
      if (sep === ' ') {
        const re = /\{([^}]*)\}|(\S+)/g
        let m: RegExpExecArray | null
        let i = 0
        while ((m = re.exec(value)) !== null) {
          const argT = memberTypes[Math.min(i, memberTypes.length - 1)]
          if (m[1] !== undefined) {
            // brace group: per-word with the inner link type
            const inner = innerLinkType(argT)
            if (inner) {
              const groupBase = base + m.index + 1
              const wordRe = /\S+/g
              let w: RegExpExecArray | null
              while ((w = wordRe.exec(m[1])) !== null) {
                const repl = mapped((inner as any).link, w[0])
                if (repl !== undefined) {
                  out.push({
                    start: groupBase + w.index,
                    end: groupBase + w.index + w[0].length,
                    text: repl,
                  })
                }
              }
            }
          } else {
            collectSplices(m[2]!, argT, base + m.index, out)
          }
          i++
        }
      } else {
        let cursor = 0
        const parts = value.split(sep)
        parts.forEach((part, i) => {
          const argT = memberTypes[Math.min(i, memberTypes.length - 1)]
          const lead = part.length - part.trimStart().length
          collectSplices(part.trim(), argT, base + cursor + lead, out)
          cursor += part.length + sep.length
        })
      }
      return
    }

    // String-array scalar: split and recurse per item
    if (t.prototype instanceof CStringArray) {
      const memberType = (t as any).memberType as unknown
      if (!memberType) return
      const sep = arraySeparator(t)
      let cursor = 0
      for (const part of value.split(sep)) {
        const lead = part.length - part.trimStart().length
        if (part.trim()) collectSplices(part.trim(), memberType, base + cursor + lead, out)
        cursor += part.length + sep.length
      }
      return
    }
  }

  function innerLinkType(argT: unknown): unknown {
    if (!isClass(argT)) return undefined
    if (isLinkClass(argT)) return argT
    const a = argT as AnyClass
    if (a.prototype instanceof CTuple) {
      const mt = (a as any).memberTypes as unknown[] | undefined
      return mt?.find(x => isLinkClass(x))
    }
    if (a.prototype instanceof CStringArray) {
      const mt = (a as any).memberType
      return isLinkClass(mt) ? mt : undefined
    }
    return undefined
  }

  function applySplices(value: string, splices: Splice[]): string {
    if (splices.length === 0) return value
    splices.sort((a, b) => a.start - b.start)
    let result = ''
    let pos = 0
    for (const sp of splices) {
      if (sp.start < pos) continue // overlapping (shouldn't happen) — skip
      result += value.slice(pos, sp.start) + sp.text
      pos = sp.end
    }
    result += value.slice(pos)
    return result
  }

  function rewriteScalar(value: string, t: unknown): string | undefined {
    const splices: Splice[] = []
    collectSplices(value, t, 0, splices)
    if (splices.length === 0) return undefined
    referencesPatched += splices.length
    return applySplices(value, splices)
  }

  // ── raw-data walk with in-place rewriting ───────────────────────────────────

  /** Rewrite a raw scalar slot ("X" | {value} | {Link}) — returns new slot or undefined. */
  function rewriteSlot(slot: unknown, t: unknown): unknown {
    if (typeof slot === 'string') {
      return rewriteScalar(slot, t)
    }
    if (slot !== null && typeof slot === 'object' && !Array.isArray(slot)) {
      const o = slot as DataObject
      const key =
        typeof o['value'] === 'string' ? 'value' : typeof o['Link'] === 'string' ? 'Link' : null
      if (key) {
        const r = rewriteScalar(o[key] as string, t)
        if (r !== undefined) {
          o[key] = r
          return slot
        }
      }
    }
    return undefined
  }

  function isPlainStruct(t: unknown): boolean {
    return (
      isStructClass(t) &&
      !(
        isClass(t) &&
        ((t as AnyClass).prototype instanceof CTuple ||
          (t as AnyClass).prototype instanceof CStringArray)
      )
    )
  }

  /** One array/record item: struct → recurse; scalar slot → rewrite in place. */
  function visitItem(holder: any, key: any, item: unknown, inner: unknown): void {
    if (item === null || item === undefined) return
    if (isPlainStruct(inner) && typeof item === 'object' && !Array.isArray(item)) {
      walkObject(item as DataObject, (inner as any).schema)
      return
    }
    if (typeof item === 'string') {
      if (holder != null) {
        const r = rewriteScalar(item, inner)
        if (r !== undefined) holder[key] = r
      }
      return
    }
    if (typeof item === 'object' && !Array.isArray(item)) {
      rewriteSlot(item, inner) // mutates {value}/{Link} wrappers in place
    }
  }

  /**
   * Array/record field walker over every raw shape the XML parser produces:
   *   [ {...}, ... ]            items (with or without index attrs)
   *   { index:'K', ... }        single indexed item
   *   { Field: ... }            single struct item (keys belong to inner schema)
   *   { K: {...} | [{...}] }    word-keyed map
   *   "X" | { value:"X" }       single scalar item
   */
  function walkItems(holder: any, key: any, value: unknown, inner: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visitItem(value, i, item, inner))
      return
    }
    if (typeof value === 'string') {
      visitItem(holder, key, value, inner)
      return
    }
    if (value !== null && typeof value === 'object') {
      const o = value as DataObject
      if ('index' in o) {
        visitItem(holder, key, o, inner)
        return
      }
      // single struct item: keys overlap the inner struct schema
      if (isPlainStruct(inner) && Object.keys(o).some(k => k in (inner as any).schema)) {
        visitItem(holder, key, o, inner)
        return
      }
      // {value:"X"} scalar wrapper
      if (typeof o['value'] === 'string' && Object.keys(o).length <= 2) {
        visitItem(holder, key, o, inner)
        return
      }
      // word-keyed map
      for (const [k, v] of Object.entries(o)) {
        if (v === null || v === undefined) continue
        if (Array.isArray(v)) v.forEach((item, i) => visitItem(v, i, item, inner))
        else visitItem(o, k, v, inner)
      }
    }
  }

  function walkValue(
    holder: DataObject | unknown[],
    key: string | number,
    value: unknown,
    t: unknown,
  ): void {
    if (value === null || value === undefined || value === '') return

    // Array field: [Inner]
    if (Array.isArray(t) && t.length === 1) {
      walkItems(holder, key, value, t[0])
      return
    }

    // Record field
    const recSpec = isRecordSpec(t) ? t : isRecordClass(t) ? { value: (t as any).value } : null
    if (recSpec) {
      walkItems(holder, key, value, recSpec.value)
      return
    }

    // Struct
    if (isPlainStruct(t)) {
      if (Array.isArray(value)) {
        value.forEach(v => {
          if (v !== null && typeof v === 'object') walkObject(v as DataObject, (t as any).schema)
        })
      } else if (typeof value === 'object') {
        walkObject(value as DataObject, (t as any).schema)
      } else if (typeof value === 'string') {
        const r = rewriteScalar(value, t)
        if (r !== undefined) (holder as any)[key] = r
      }
      return
    }

    // Scalar leaf (possibly array of scalars)
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        const r = rewriteSlot(v, t)
        if (typeof r === 'string') (value as unknown[])[i] = r
      })
      return
    }
    const r = rewriteSlot(value, t)
    if (typeof r === 'string') {
      ;(holder as any)[key] = r
    }
  }

  function walkObject(obj: DataObject, schema: DataObject): void {
    for (const [prop, value] of Object.entries(obj)) {
      if (SKIP_PROPS.has(prop)) continue
      if (value === null || value === undefined || value === '') continue
      if (prop === 'parent') continue // handled separately per entity
      let t = ownField(schema, prop)
      if (t !== undefined) {
        walkValue(obj, prop, value, t)
        continue
      }
      if (currentTokens.has(prop)) {
        // Token attribute: value for a `<?token?>` declared on this entity's
        // inheritance chain. The declared type names the target namespace
        // (type="CUnitLink" → Unit); plain-string tokens (no type) aren't links.
        // Token ids are case-sensitive and may start with any letter, so the
        // property is matched exactly against the declaration.
        if (typeof value === 'string') {
          const ns = tokenTypeNamespace(currentTokens.get(prop))
          if (ns) {
            const repl = mapped(ns, value)
            if (repl !== undefined) {
              obj[prop] = repl
              referencesPatched++
            }
          }
        }
        continue
      }
      t = schemaField(schema, prop)
      if (t === undefined) continue
      walkValue(obj, prop, value, t)
    }
  }

  // ── 1. patch references in every entity's raw data ──────────────────────────

  for (const ns of store.namespaces()) {
    for (const entity of store.all(ns)) {
      const cls = (DATA_CLASS_SCHEMA as Record<string, unknown>)[entity.class]
      if (isClass(cls) && (cls as any).schema) {
        currentTokens = declaredTokenTypes(entity, lookup)
        walkObject(entity.data as DataObject, (cls as any).schema)
      }
      // parent= reference
      if (entity.parent) {
        const repl = mapped(entity.namespace, entity.parent)
        if (repl !== undefined) {
          ;(entity as { parent: string }).parent = repl
          referencesPatched++
        }
      }
    }
  }

  // ── 2. locale string keys: "<Ns>/<Field...>/<oldId>" → new key (old kept) ──
  // Also rewrite entity fields that hold those keys (CStringLink values appear
  // as raw strings "Ns/Field/Id"; ##id## token forms resolve automatically).

  const textKeyRenames = new Map<string, string>() // old key → new key

  const registerTextKey = (key: string, newLastSeg: string) => {
    const parts = key.split('/')
    if (parts.length < 2) return
    const newParts = [...parts]
    newParts[newParts.length - 1] = newLastSeg
    const newKey = newParts.join('/')
    if (newKey === key || textKeyRenames.has(key)) return
    textKeyRenames.set(key, newKey)
    let added = false
    if (store.locales !== undefined) {
      for (const localeFiles of store.locales.values()) {
        for (const fileMap of localeFiles.values()) {
          if (fileMap.has(key) && !fileMap.has(newKey)) {
            fileMap.set(newKey, fileMap.get(key)!) // old key kept (old-parser behavior)
            added = true
          }
        }
      }
    }
    if (added) stringsRenamed++
  }

  // a) keys whose last segment IS the renamed id and whose first segment matches
  //    the namespace: "Unit/Name/<oldId>" → "Unit/Name/<newId>"
  for (const { namespace, oldId, newId } of resolvedSpecs) {
    if (store.locales !== undefined) {
      for (const localeFiles of store.locales.values()) {
        for (const fileMap of localeFiles.values()) {
          for (const key of [...fileMap.keys()]) {
            const parts = key.split('/')
            if (parts.length < 2) continue
            if (parts[parts.length - 1] !== oldId) continue
            if (canon(parts[0]!) !== namespace) continue
            registerTextKey(key, newId)
          }
        }
      }
    }
  }

  // b) old-parser resolveText: every string key referenced by a renamed entity
  //    gets the mask applied to its last segment ("Weapon/Name/PsiBlast" →
  //    "Weapon/Name/CUSTOM_PsiBlast" when renaming the weapon that uses it)
  const textRefs = options.textReferences ?? []
  if (textRefs.length > 0) {
    const specByEntity = new Map<string, { mask: string | null }>()
    for (const sp of resolvedSpecs) specByEntity.set(`${sp.namespace}/${sp.oldId}`, sp)
    for (const tr of textRefs) {
      const sp = specByEntity.get(`${tr.from.namespace}/${tr.from.id}`)
      if (!sp || !sp.mask) continue
      const lastSeg = tr.key.split('/').pop()!
      registerTextKey(tr.key, sp.mask.replace('*', lastSeg))
    }
  }

  // rewrite raw string-key fields across all entities (exact full-value match)
  if (textKeyRenames.size > 0) {
    const patchTextKeys = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const r = textKeyRenames.get(value)
        if (r !== undefined) {
          referencesPatched++
          return r
        }
        return value
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          const r = patchTextKeys(v)
          if (r !== v) (value as unknown[])[i] = r
        })
        return value
      }
      if (value !== null && typeof value === 'object') {
        const o = value as DataObject
        for (const [k, v] of Object.entries(o)) {
          const r = patchTextKeys(v)
          if (r !== v) o[k] = r
        }
        return value
      }
      return value
    }
    for (const ns of store.namespaces()) {
      for (const entity of store.all(ns)) {
        patchTextKeys(entity.data)
      }
    }
  }

  // ── 2b. entity ids embedded in localized string VALUES: <d ref="Ns,OldId,Field"/>,
  //        <d stringref="Ns,OldId,Field"/>, and $token:…:Ns,OldId,Field$ operations ──
  {
    const newIdByKey = new Map<string, string>()
    for (const sp of resolvedSpecs)
      newIdByKey.set(`${sp.namespace.toLowerCase()}/${sp.oldId}`, sp.newId)
    if (newIdByKey.size > 0 && store.locales !== undefined) {
      for (const localeFiles of store.locales.values()) {
        for (const fileMap of localeFiles.values()) {
          for (const [key, value] of fileMap) {
            if (typeof value !== 'string' || value.indexOf(',') === -1) continue
            const next = renameRefsInStringValue(value, newIdByKey)
            if (next !== value) {
              fileMap.set(key, next)
              stringsRenamed++
            }
          }
        }
      }
    }
  }

  // ── 3. re-key the entities themselves ───────────────────────────────────────

  for (const { namespace, oldId, newId } of resolvedSpecs) {
    const entity = store.get(namespace, oldId)
    if (entity === undefined) continue
    if (typeof store.renameEntry === 'function') {
      store.renameEntry(namespace, oldId, newId)
    }
    entitiesRenamed++
  }

  return {
    entitiesRenamed,
    referencesPatched,
    stringsRenamed,
    textKeyRenames,
    mapped,
    canon,
  }
}
