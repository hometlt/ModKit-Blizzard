import type { RawFields, TokenDecl } from '../xml/index.js'

export interface EntitySource {
  /** Path to the mod, e.g. 'C:/mods/Liberty.SC2Mod' */
  mod: string
  /** Path within the mod, e.g. 'GameData/UnitData.xml' */
  file: string
  line?: number
  /** The declaration's opening tag, when the parser tracked sources. */
  span?: import('../xml/index.js').EntrySpan
}

export interface CatalogEntity {
  readonly id: string
  readonly parent?: string
  /** Raw `default` attribute (`'1'` marks a default/template entity). */
  readonly default?: string
  /** C-prefixed type name, e.g. 'CUnit', 'CAbilResearch' */
  readonly class: string
  /** Namespace without C prefix, e.g. 'Unit', 'Abil' */
  readonly namespace: string
  /** Raw parsed fields from XML — before inheritance resolution */
  readonly data: RawFields
  /** `<?token?>` declarations on this entity (actor/sound templating). */
  readonly tokens?: ReadonlyArray<TokenDecl>
  /** First declaration site (the base mod that introduced the entity). */
  readonly source?: EntitySource
  /**
   * Every declaration/patch site in load order — an entity declared in liberty and
   * modified in swarm + void carries all three, so tooling can open each file.
   */
  readonly sources?: ReadonlyArray<EntitySource>
  /** The declaration that last wrote each top-level field of `data`, patches applied in order. */
  readonly fieldSources?: Readonly<Record<string, EntitySource>>
  /** Each declaration as written, in load order — what `data` merges, kept for leaf provenance. */
  readonly declarations?: ReadonlyArray<EntityDeclaration>
}

export interface EntityDeclaration {
  readonly source: EntitySource
  readonly data: RawFields
}

/**
 * Typed proxy over a namespace map.
 * Type-safe access via get(id). Runtime Proxy also enables ns.Marine property access.
 * Values are resolved (parent chain applied, tokens substituted).
 */
export interface TypedNamespace<T> {
  get(id: string): T | undefined
  all(): T[]
  find(fn: (entity: T) => boolean): T[]
  keys(): IterableIterator<string>
  values(): IterableIterator<T>
  readonly size: number
}
