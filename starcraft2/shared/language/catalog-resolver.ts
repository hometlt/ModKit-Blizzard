/**
 * Turn a `common.data/catalog-analysis@1` snapshot into the resolver the ported strings library
 * expects — the bridge that lets one SC2 codec read another's resolved data.
 *
 * This is the missing link behind a whole family of features. `<d ref="Effect,Foo,Amount"/>` in a
 * localization catalog names a field of an entity owned by the data codec; the markup renderer that
 * resolves it was ported long ago and has been unreachable ever since, because nothing carried a
 * value across that boundary. Nothing new had to be invented for it: the catalog-analysis contract
 * already publishes resolved entities and localized strings, and the SC2 data provider already
 * implements it.
 *
 * Two decisions are worth stating, because both prevent a specific wrong answer.
 *
 * A missing entity answers `undefined`, never an empty record. `validateStringRefs` treats an empty
 * record as "this entity exists and has no such field" and reports a broken reference, so answering
 * `{}` for an entity the snapshot simply did not cover would condemn a healthy catalog.
 *
 * The snapshot is a bounded window, not a database. It contains what the analyzer was asked for, so
 * a resolver built from one is honest only about what it holds; `coverage` says what that is, and a
 * caller that needs more asks the analyzer for more rather than assuming silence means absence.
 */
import type { StringCatalog } from '../../modules/strings/shared/core/complete.js'
import type { CatalogResolver } from '../../modules/strings/shared/core/resolve.js'

/** The parts of a catalog-analysis snapshot this bridge reads. */
export interface CatalogSnapshotLike {
  readonly entities?: readonly {
    readonly namespace: string
    readonly entityId: string
    readonly fields: Readonly<Record<string, unknown>>
  }[]
  readonly definitions?: readonly {
    readonly namespace: string
    readonly entityId: string
    readonly fields: Readonly<Record<string, unknown>>
  }[]
  readonly localizedStrings?: readonly {
    readonly key: string
    readonly value: string
    readonly resolvedLocale: string
  }[]
}

export interface CatalogTextStyles {
  /** `FontStyles.SC2Style` constants, without the leading `#`. */
  readonly constants?: Readonly<Record<string, string>>
  readonly styles?: Readonly<Record<string, {
    name: string
    attrs: Record<string, string>
    fonts?: string[]
    provenance?: readonly { uri: string; version?: number; kind: string; name: string }[]
    contextRevision?: string
    complete?: boolean
    resolved?: true
  }>>
  readonly contextRevision?: string
  readonly complete?: boolean
  readonly galaxyVariables?: Readonly<Record<string, string | number | boolean>>
}

export interface CatalogCoverage {
  readonly entities: number
  readonly strings: number
  readonly namespaces: readonly string[]
}

export interface CatalogBridge {
  readonly resolver: CatalogResolver
  /** What the snapshot actually holds, so a caller can report limits instead of guessing. */
  readonly coverage: CatalogCoverage
}

const key = (namespace: string, id: string) => `${namespace}\u0000${id}`

/**
 * Build the resolver. `styles` is separate because font styles come from a different file — and,
 * once sc2-style exists, from a different codec — than the game data.
 */
export function catalogResolverFromSnapshot(
  snapshot: CatalogSnapshotLike,
  styles: CatalogTextStyles = {},
): CatalogBridge {
  const entities = new Map<string, Record<string, unknown>>()
  /*
   * `definitions` first, then `entities`: both carry resolved fields, and where they overlap the
   * queried entity is the more specific answer, so it is written last and wins.
   */
  for (const group of [snapshot.definitions ?? [], snapshot.entities ?? []]) {
    for (const entity of group) {
      entities.set(key(entity.namespace, entity.entityId), { ...entity.fields })
    }
  }

  const strings = new Map<string, string>()
  for (const item of snapshot.localizedStrings ?? []) {
    if (!strings.has(item.key)) strings.set(item.key, item.value)
  }

  const resolver: CatalogResolver = {
    getResolved(namespace, id) {
      return entities.get(key(namespace, id))
    },
    getString(lookup) {
      return strings.get(lookup)
    },
    getGalaxyVar(name) {
      const value = styles.galaxyVariables?.[name]
      return value === undefined ? undefined : { value }
    },
    getTextConstant(name) {
      return styles.constants?.[name]
    },
    getTextStyle(name) {
      return styles.styles?.[name]
    },
  }

  return {
    resolver,
    coverage: {
      entities: entities.size,
      strings: strings.size,
      namespaces: [
        ...new Set([...entities.keys()].map(item => item.slice(0, item.indexOf('\u0000')))),
      ].sort(),
    },
  }
}

/**
 * The other half of the same bridge: the vocabulary the strings *completion* engine asks for.
 *
 * `CatalogResolver` above answers "what does this reference resolve to"; `StringCatalog` answers
 * "what could the author write here" — the namespaces and entities of `<d ref="Unit,Marine,…"/>`,
 * the key segments of `Unit/Name/Marine`, and the colour and style names of `<c val="…">` and
 * `<s val="…">`. MK2 built it from a loaded mod (`makeStringCatalog`); the shape of the answers is
 * carried over unchanged, and only where they come from differs, because MK3 has a snapshot rather
 * than a mod object.
 *
 * Every list is honest about being a window. An absent style sheet means "no styles are known
 * here", which is what an empty list says — not "this file uses no styles".
 */

export interface StringCatalogSources {
  /** Resolved entities, for namespace/entity/field completion. */
  readonly snapshot?: CatalogSnapshotLike
  /** `FontStyles.SC2Style` constants and styles, for `<c val>` and `<s val>`. */
  readonly styles?: CatalogTextStyles
  /**
   * Localization keys already in the workspace. Property segments (`Unit/<Tooltip>/Marine`) are not
   * in any schema — MK2 derived them from the keys a mod actually uses, and so does this.
   */
  readonly keys?: readonly string[]
  /** `Assets.txt` aliases (bare, without the leading `@@`) and the asset path each names. */
  readonly assets?: ReadonlyMap<string, string>
}

/**
 * Resolve a FontStyles colour constant to bare `RRGGBB[AA]`, for the swatch shown beside a
 * completion item. Ported from MK2: constants chain through `#Name` and bare-name references, and
 * a decimal `R,G,B[,A]` value is as legal as a hex one.
 */
export function resolveColorConstantHex(
  constants: Readonly<Record<string, string>>,
  name: string,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined
  const value = constants[name]?.trim()
  if (value === undefined || value === '') return undefined
  if (value.startsWith('#')) return resolveColorConstantHex(constants, value.slice(1), depth + 1)
  if (/^[A-Za-z_]\w*$/u.test(value) && Object.hasOwn(constants, value)) {
    return resolveColorConstantHex(constants, value, depth + 1)
  }
  const decimal = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d{1,3}))?$/u.exec(value)
  if (decimal !== null) {
    const byte = (part: string | undefined): string =>
      Math.max(0, Math.min(255, Number.parseInt(part ?? '255', 10)))
        .toString(16)
        .padStart(2, '0')
    return (
      byte(decimal[1]) +
      byte(decimal[2]) +
      byte(decimal[3]) +
      (decimal[4] === undefined ? '' : byte(decimal[4]))
    )
  }
  return /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(value) ? value : undefined
}

export function stringCatalogFromSources(sources: StringCatalogSources): StringCatalog {
  const fields = new Map<string, string[]>()
  const byNamespace = new Map<string, Set<string>>()
  for (const group of [sources.snapshot?.definitions ?? [], sources.snapshot?.entities ?? []]) {
    for (const entity of group) {
      if (entity.entityId === '') continue
      let ids = byNamespace.get(entity.namespace)
      if (ids === undefined) {
        ids = new Set<string>()
        byNamespace.set(entity.namespace, ids)
      }
      ids.add(entity.entityId)
      fields.set(key(entity.namespace, entity.entityId), Object.keys(entity.fields))
    }
  }

  /*
   * Property segments, derived from the keys in hand rather than from a schema — localization
   * property names are a convention, not a declared vocabulary, so the file's own usage is the only
   * honest source. `Unit/Name/Marine` contributes `Name` under `Unit`.
   */
  const properties = new Map<string, Set<string>>()
  for (const item of sources.keys ?? []) {
    const parts = item.split('/')
    if (parts.length < 3) continue
    const namespace = (parts[0] ?? '').toLowerCase()
    let set = properties.get(namespace)
    if (set === undefined) {
      set = new Set<string>()
      properties.set(namespace, set)
    }
    set.add(parts.slice(1, -1).join('/'))
  }

  const constants = sources.styles?.constants ?? {}
  const assetPaths = sources.assets ?? new Map<string, string>()
  const assets = [...assetPaths.keys()].sort()

  return {
    namespaces: () => [...byNamespace.keys()].sort(),
    entities: (namespace: string) => [...(byNamespace.get(namespace) ?? [])].sort(),
    fields: (namespace: string, entity: string) => fields.get(key(namespace, entity)) ?? [],
    properties: (namespace: string) => [...(properties.get(namespace.toLowerCase()) ?? [])].sort(),
    colors: () => Object.keys(constants).sort(),
    colorHex: (name: string) => resolveColorConstantHex(constants, name),
    styles: () => Object.keys(sources.styles?.styles ?? {}).sort(),
    assets: () => assets,
    assetPath: (alias: string) => assetPaths.get(alias),
  }
}
