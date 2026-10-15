/**
 * How a field's array entries are merged when two mods override the same entity.
 *
 *  indexed  — CWArray: merge by a numeric/string index attribute (e.g. WeaponArray index="0")
 *  named    — CCArray: merge by an id/name attribute (e.g. BehaviorArray id="Stimpack")
 *  append   — simple concat (e.g. GlossaryStrongArray — no identifying attr, order-sensitive)
 *  replace  — the whole array from the overriding mod replaces the parent (uncommon)
 */
export type ArrayMergeStrategy = 'indexed' | 'named' | 'append' | 'replace'

/**
 * Runtime description of a single field within a catalog type.
 */
export interface SchemaField {
  /** True if this field can hold multiple values (any array) */
  isArray: boolean

  /**
   * True if the scalar value or array element values are entity ID references
   * (links to another catalog entity). Used by rename to find all references.
   */
  isLink: boolean

  /**
   * Namespace this field links to (only relevant when isLink=true).
   * e.g. 'Unit', 'Abil', 'Effect', 'Actor', ...
   */
  linkNamespace?: string

  /**
   * Merge strategy for array fields. Ignored for scalar fields.
   * Default: 'indexed'
   */
  arrayMerge?: ArrayMergeStrategy

  /**
   * Name of the attribute used as the array index key.
   * For 'indexed': usually 'index'
   * For 'named': usually 'id' or 'name'
   */
  indexAttr?: string

  /**
   * For struct/object type fields: the nested schema
   */
  fields?: SchemaFields
}

export type SchemaFields = Readonly<Record<string, SchemaField>>

/**
 * Runtime schema for a single catalog type (e.g. CUnit, CAbilResearch).
 */
export interface CatalogTypeSchema {
  /** Type name, e.g. 'CUnit' */
  readonly name: string
  /** Parent type name for inheritance chain, e.g. 'CUnitHero' extends 'CUnit' */
  readonly parent?: string
  /** All known fields */
  readonly fields: SchemaFields
}

/**
 * Runtime schema registry — holds all catalog type schemas.
 * Used for merge, rename reference discovery, typed walk, and subtree extraction.
 */
export class SchemaRegistry {
  private types = new Map<string, CatalogTypeSchema>()

  register(schema: CatalogTypeSchema): void {
    this.types.set(schema.name, schema)
  }

  get(typeName: string): CatalogTypeSchema | undefined {
    return this.types.get(typeName)
  }

  has(typeName: string): boolean {
    return this.types.has(typeName)
  }

  /**
   * Returns all fields for a type including inherited fields from parent chain.
   * Later entries (child) win over earlier (parent) for field definitions.
   */
  resolveFields(typeName: string): SchemaFields {
    const chain = this.inheritanceChain(typeName)
    const merged: Record<string, SchemaField> = {}
    for (const type of chain) {
      Object.assign(merged, type.fields)
    }
    return merged
  }

  /**
   * Returns the full inheritance chain from root → leaf (CBase first, CUnit last).
   */
  inheritanceChain(typeName: string): CatalogTypeSchema[] {
    const chain: CatalogTypeSchema[] = []
    let current: string | undefined = typeName
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const schema = this.types.get(current)
      if (!schema) break
      chain.unshift(schema)  // prepend so root is first
      current = schema.parent
    }
    return chain
  }

  /** Walk all fields of a type (resolved + inherited) via callback */
  walkFields(typeName: string, data: Record<string, unknown>, cb: WalkCallback): void {
    const fields = this.resolveFields(typeName)
    walkObject(fields, data, cb, [])
  }

  all(): IterableIterator<CatalogTypeSchema> {
    return this.types.values()
  }
}

export interface WalkLocation {
  typeName: string
  fieldName: string
  path: readonly string[]
}

export type WalkCallback = (
  value: unknown,
  field: SchemaField,
  location: WalkLocation
) => void

function walkObject(
  fields: SchemaFields,
  data: Record<string, unknown>,
  cb: WalkCallback,
  path: string[]
): void {
  for (const [fieldName, fieldSchema] of Object.entries(fields)) {
    const value = data[fieldName]
    if (value === undefined) continue

    const location: WalkLocation = {
      typeName: path[0] ?? '',
      fieldName,
      path: [...path, fieldName],
    }

    if (fieldSchema.isArray && Array.isArray(value)) {
      for (const item of value as unknown[]) {
        cb(item, fieldSchema, location)
        if (fieldSchema.fields && typeof item === 'object' && item !== null) {
          walkObject(fieldSchema.fields, item as Record<string, unknown>, cb, [...path, fieldName])
        }
      }
    } else {
      cb(value, fieldSchema, location)
      if (fieldSchema.fields && typeof value === 'object' && value !== null) {
        walkObject(fieldSchema.fields, value as Record<string, unknown>, cb, [...path, fieldName])
      }
    }
  }
}
