/**
 * Which declaration wrote each leaf of an entity's resolved fields — the provenance the authoring
 * index carries. The chain's declarations are replayed in the order `resolveEntity` merges them,
 * with its rules: list elements meet by slot key (running index), appended items keep their order,
 * a struct merges key by key, `removed="1"` clears its slot.
 * Leaf paths use a Map tree: recording a new slot and replacing a subtree visit only that path,
 * rather than scanning every previous leaf. The tree belongs to this resolution only; sources,
 * own-field sets, appended positions and removal evidence retain the canonical merge semantics.
 */
import type { RawArray, RawObject, RawValue } from '../xml/index.js'
import type { SchemaField, SchemaFields } from '../sc2-schema/index.js'
import type { CatalogEntity, EntitySource } from './types.js'
import { isTombstone, slotKeys } from './merge.js'

export interface LeafOrigin {
  readonly source: EntitySource
  readonly entity: CatalogEntity
}

export interface FieldProvenance {
  /** The declaration that last wrote the top-level field, and its entity. */
  readonly source: EntitySource
  readonly entity: CatalogEntity
  /** The origin of one leaf, by its path below the field as the resolved value spells it. */
  originAt(path: readonly string[]): LeafOrigin | undefined
}

export interface EntityProvenance {
  readonly fields: ReadonlyMap<string, FieldProvenance>
  /** Top-level fields the entity's own declarations write. */
  readonly own: ReadonlySet<string>
  /** Slots the entity's own declarations remove, the path starting at the top-level field. */
  readonly tombstones: readonly { readonly path: readonly string[]; readonly source: EntitySource }[]
}

const DEFAULT_LIST: SchemaField = { isArray: true, arrayMerge: 'indexed' } as SchemaField
const keyOf = (path: readonly string[]): string => JSON.stringify(path)
const isObj = (value: RawValue): value is RawObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
interface LeafNode {
  readonly children: Map<string, LeafNode>
  origin?: LeafOrigin
}

/** One top-level field's leaves; appended items are recorded as `#n` and read back by position. */
class FieldLeaves implements FieldProvenance {
  source: EntitySource
  entity: CatalogEntity
  private readonly leaves: LeafNode = { children: new Map() }
  /** Appended lists: path → item ids in order, `undefined` for an item a later slot removed. */
  private readonly appended = new Map<string, (string | undefined)[]>()
  private nextItem = 0

  constructor(source: EntitySource, entity: CatalogEntity) {
    this.source = source
    this.entity = entity
  }

  /** Locate an exact path; only writes create nodes, so absence stays cheap to check. */
  private leafAt(path: readonly string[], create = false): LeafNode | undefined {
    let node = this.leaves
    for (const part of path) {
      let next = node.children.get(part)
      if (next === undefined) {
        if (!create) return undefined
        next = { children: new Map() }
        node.children.set(part, next)
      }
      node = next
    }
    return node
  }

  /** Remove precisely this prefix and prune empty ancestors, preserving sibling origins. */
  clear(prefix: readonly string[]): void {
    if (prefix.length === 0) {
      this.leaves.children.clear()
      delete this.leaves.origin
      return
    }
    const parents: LeafNode[] = []
    let node = this.leaves
    for (const part of prefix) {
      const next = node.children.get(part)
      if (next === undefined) return
      parents.push(node)
      node = next
    }
    for (let index = prefix.length - 1; index >= 0; index -= 1) {
      const parent = parents[index]!
      parent.children.delete(prefix[index]!)
      if (parent === this.leaves || parent.origin !== undefined || parent.children.size > 0) break
    }
  }

  /** A scalar replaces its descendants while retaining origins on any enclosing path. */
  set(path: readonly string[], origin: LeafOrigin): void {
    const leaf = this.leafAt(path, true)!
    leaf.children.clear()
    leaf.origin = origin
  }

  /** An empty structure keeps existing descendants; a previously removed branch has none. */
  has(prefix: readonly string[]): boolean {
    const node = this.leafAt(prefix)
    return node !== undefined && (node.origin !== undefined || node.children.size > 0)
  }

  /** Keep a stable internal identity for an appended item while its running slot may change. */
  appendItem(path: readonly string[]): string {
    const order = this.appended.get(keyOf(path)) ?? []
    const id = `#${this.nextItem++}`
    order.push(id)
    this.appended.set(keyOf(path), order)
    return id
  }

  /** Remove the appended item in running slot `slot`; later items keep their slots until read. */
  removeItem(path: readonly string[], slot: number): void {
    const order = this.appended.get(keyOf(path))
    const id = order?.[slot]
    if (order === undefined || id === undefined) return
    order[slot] = undefined
    this.clear([...path, id])
  }

  /** Translate surviving appended positions, then return only the exact leaf's origin. */
  originAt(path: readonly string[]): LeafOrigin | undefined {
    const recorded: string[] = []
    for (const part of path) {
      const order = this.appended.get(keyOf(recorded))
      if (order !== undefined && /^\d+$/u.test(part)) {
        const id = order.filter((item): item is string => item !== undefined)[Number(part)]
        if (id === undefined) return undefined
        recorded.push(id)
      } else recorded.push(part)
    }
    return this.leafAt(recorded)?.origin
  }
}

interface Writing {
  readonly leaves: FieldLeaves
  readonly origin: LeafOrigin
  /** Collects removals when the declaration is the entity's own. */
  readonly removed?: (path: readonly string[]) => void
}

function write(value: RawValue, field: SchemaField | undefined, path: readonly string[], writing: Writing): void {
  if ((field?.isArray === true && field.arrayMerge !== 'replace') || (field === undefined && Array.isArray(value))) {
    writeList(Array.isArray(value) ? value as RawArray : [value], field ?? DEFAULT_LIST, path, writing)
  } else if (isObj(value)) {
    writeRecord(value, field?.fields, path, writing, new Set(['removed']))
  } else {
    writing.leaves.set(path, writing.origin)
  }
}

function writeRecord(
  value: RawObject,
  fields: SchemaFields | undefined,
  path: readonly string[],
  writing: Writing,
  ignored: ReadonlySet<string>,
): void {
  const entries = Object.entries(value).filter(([key]) => !ignored.has(key))
  if (entries.length === 0) {
    if (!writing.leaves.has(path)) writing.leaves.set(path, writing.origin)
    return
  }
  for (const [key, item] of entries) write(item, fields?.[key], [...path, key], writing)
}

function writeList(items: RawArray, field: SchemaField, path: readonly string[], writing: Writing): void {
  const strategy = field.arrayMerge ?? 'indexed'
  const indexAttr = strategy === 'append' ? 'index' : field.indexAttr ?? (strategy === 'named' ? 'id' : 'index')
  const keys = slotKeys(items, indexAttr)
  items.forEach((item, position) => {
    const key = keys[position]
    if (strategy === 'append') {
      if (isTombstone(item)) {
        if (key !== undefined && /^\d+$/u.test(key)) writing.leaves.removeItem(path, Number(key))
        return
      }
      const id = writing.leaves.appendItem(path)
      if (isObj(item)) writeRecord(item, field.fields, [...path, id], writing, new Set(['index', 'removed']))
      else writing.leaves.set([...path, id], writing.origin)
      return
    }
    const slot = [...path, key ?? writing.leaves.appendItem(path)]
    if (isTombstone(item)) {
      writing.leaves.clear(slot)
      writing.removed?.(slot)
      return
    }
    if (!isObj(item)) {
      writing.leaves.set(slot, writing.origin)
      return
    }
    // `{index, value}` is a scalar in its slot; a struct element merges key by key.
    const own = Object.keys(item).filter(name => name !== indexAttr && name !== 'removed')
    if (own.length === 1 && own[0] === 'value' && !isObj(item['value']!) && !Array.isArray(item['value'])) {
      writing.leaves.set(slot, writing.origin)
    } else {
      writeRecord(item, field.fields, slot, writing, new Set([indexAttr, 'removed']))
    }
  })
}

/**
 * Provenance of `entity` along `chain` (root first, the entity last), merging by the entity's
 * class schema as `resolveEntity` does.
 */
export function entityProvenance(entity: CatalogEntity, chain: readonly CatalogEntity[], schema: SchemaFields): EntityProvenance {
  const fields = new Map<string, FieldLeaves>()
  const own = new Set<string>()
  const tombstones: { path: readonly string[]; source: EntitySource }[] = []
  for (const link of chain) {
    const declarations = link.declarations ?? (link.source === undefined ? [] : [{ source: link.source, data: link.data }])
    for (const declaration of declarations) {
      for (const [fieldId, value] of Object.entries(declaration.data)) {
        const origin: LeafOrigin = { source: declaration.source, entity: link }
        let leaves = fields.get(fieldId)
        if (leaves === undefined) {
          leaves = new FieldLeaves(declaration.source, link)
          fields.set(fieldId, leaves)
        } else {
          leaves.source = declaration.source
          leaves.entity = link
        }
        const writing: Writing = link === entity
          ? { leaves, origin, removed: path => tombstones.push({ path: [fieldId, ...path], source: declaration.source }) }
          : { leaves, origin }
        write(value, schema[fieldId], [], writing)
        if (link === entity) own.add(fieldId)
      }
    }
  }
  return { fields, own, tombstones }
}
