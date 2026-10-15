import type { CatalogEntity } from '../catalog-engine/sc2-catalog/index.js'

/**
 * Minimal catalog surface needed by the filter helpers.
 *
 * Kept structural so the SC2 data codec can operate on `TypedCatalog`, `SC2Mod`, or another
 * compatible catalog view without importing a mod-level owner.
 */
export interface CatalogFilterStore {
  all(namespace: string): CatalogEntity[]
}

/**
 * Collection of predicate helpers for filtering catalog entities.
 *
 * Usage:
 *   const units = Filter.byNamespace(catalog, 'Unit')
 *   const custom = Filter.nonDefault(catalog, 'Unit')
 */
export const Filter = {
  /** All entities in a namespace. */
  byNamespace(catalog: CatalogFilterStore, namespace: string): CatalogEntity[] {
    return catalog.all(namespace)
  },

  /**
   * Entities that are NOT the implicit default (id = '').
   * The default entity is the SC2 base definition used by all other entries as implicit parent.
   */
  nonDefault(catalog: CatalogFilterStore, namespace: string): CatalogEntity[] {
    return catalog.all(namespace).filter(e => e.id !== '')
  },

  /** Entities whose id matches a predicate. */
  byId(
    catalog: CatalogFilterStore,
    namespace: string,
    predicate: (id: string) => boolean,
  ): CatalogEntity[] {
    return catalog.all(namespace).filter(e => predicate(e.id))
  },

  /** Entities of a specific class (exact match on the C-prefixed class name). */
  byClass(catalog: CatalogFilterStore, namespace: string, className: string): CatalogEntity[] {
    return catalog.all(namespace).filter(e => e.class === className)
  },

  /** Entities whose id starts with a given prefix. */
  byPrefix(catalog: CatalogFilterStore, namespace: string, prefix: string): CatalogEntity[] {
    return catalog.all(namespace).filter(e => e.id.startsWith(prefix))
  },

  /** All units (non-default). */
  units(catalog: CatalogFilterStore): CatalogEntity[] {
    return Filter.nonDefault(catalog, 'Unit')
  },

  /** All abilities (non-default). */
  abils(catalog: CatalogFilterStore): CatalogEntity[] {
    return Filter.nonDefault(catalog, 'Abil')
  },

  /** All actors (non-default). */
  actors(catalog: CatalogFilterStore): CatalogEntity[] {
    return Filter.nonDefault(catalog, 'Actor')
  },

  /** Entities that were loaded from a specific mod path. */
  fromMod(catalog: CatalogFilterStore, namespace: string, modPath: string): CatalogEntity[] {
    return catalog.all(namespace).filter(e => e.source?.mod === modPath)
  },
}
