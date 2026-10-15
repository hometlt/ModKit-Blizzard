/**
 * Warcraft III object-editor changes (`.w3u` units, `.w3t` items, `.w3b` destructables, `.w3d`
 * doodads, `.w3a` abilities, `.w3h` buffs, `.w3q` upgrades — as files and as `war3map.*` inside a
 * map), read with the vendored mdx-m3-viewer parsers (`src/lib/mdx-m3-viewer`). A file holds two
 * tables: changes to standard objects, and custom objects made from a base; each change names a
 * field by its four-letter id, and in the ability, doodad and upgrade files the level (or variation)
 * and data column it applies to. Published as a tree and one table of every change.
 * Version 3's opaque integer header is displayed independently of its ONE change list. Unknown
 * integers are preserved by the native parser/writer, not interpreted as flags or selected sets.
 * This inspection codec exposes no native write operation or resolved-data selection policy.
 */
import type { InspectionCodecDefinition, InspectionContext, InspectionTreeNode } from '@modkit/codec-kit'
import type { OperationDecl } from '@modkit/sdk'
import { createInspectionCodec, createTableDataSource, createTreeDataSource } from '@modkit/codec-kit'
import type ModificationTable from '../lib/mdx-m3-viewer/parsers/w3x/w3u/modificationtable.js'
import { MOD_TYPES, OBJECT_MOD_KINDS, extensionOf, modValue, objectId as id, readObjectMods } from './format.js'

const COLUMNS = ['table', 'object', 'base', 'field', 'level', 'data', 'type', 'value'] as const

/** Flatten the single native change list, keeping a v3 object's opaque header visible. */
function rows(table: ModificationTable, name: 'original' | 'custom', levels: boolean, version: number): string[][] {
  return table.objects.flatMap(object => {
    const header = version === 3 ? [object.unknownInts.join(',')] : []
    return object.modifications.map(change => [
      name,
      id(object.newId) || id(object.oldId),
      name === 'custom' ? id(object.oldId) : '',
      change.id,
      levels ? String(change.levelOrVariation) : '',
      levels ? String(change.dataPointer) : '',
      MOD_TYPES[change.variableType] ?? String(change.variableType),
      modValue(change),
      ...header,
    ])
  })
}

/** Preserve the object hierarchy, including headers on v3 objects with no changes. */
function tableNode(table: ModificationTable, name: 'original' | 'custom', levels: boolean, version: number): InspectionTreeNode {
  return {
    kind: 'table',
    label: name === 'original' ? 'Changed standard objects' : 'Custom objects',
    preview: String(table.objects.length),
    hasChildren: table.objects.length > 0,
    children: () =>
      table.objects.map(object => ({
        kind: 'object',
        label: id(object.newId) || id(object.oldId),
        preview: `${name === 'custom' ? `from ${id(object.oldId)}, ` : ''}${String(object.modifications.length)} changes`,
        hasChildren: version === 3 || object.modifications.length > 0,
        children: () => [
          ...(version === 3 ? [{ kind: 'unknown-header', label: 'v3 unknown integers', preview: JSON.stringify(object.unknownInts) }] : []),
          ...object.modifications.map(change => ({
            kind: 'change',
            label: levels && change.levelOrVariation > 0 ? `${change.id} [${String(change.levelOrVariation)}]` : change.id,
            preview: modValue(change),
          })),
        ],
      })),
  }
}

const operations: readonly OperationDecl[] = []

const definition = Object.freeze({
  id: 'blizzard/war3-object-mods',
  format: Object.freeze({ id: 'war3-object-mods', label: 'Warcraft III object-editor changes' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    const known = OBJECT_MOD_KINDS[extensionOf(uri)] !== undefined
    const version = prefix.byteLength >= 4 ? new DataView(prefix.buffer, prefix.byteOffset, 4).getInt32(0, true) : -1
    return known && version >= 1 && version <= 3
      ? { confidence: 0.9, kind: 'structure' as const, note: `object-mods-v${String(version)}` }
      : { confidence: 0, kind: 'extension' as const, note: 'not-object-mods' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    context.signal?.throwIfAborted()
    const extension = extensionOf(context.source.ref.uri)
    const file = readObjectMods(bytes, extension)
    const kind = OBJECT_MOD_KINDS[extension]!
    const levels = file.levels
    const nodes = [...file.original.objects, ...file.custom.objects]
      .reduce((total, object) => total + 1 + object.unknownInts.length + object.modifications.length, 0)
    if (nodes > context.budget.maxNodes) throw new RangeError(`${String(nodes)} object/change/header nodes, past the node budget`)
    const table = [...rows(file.original, 'original', levels, file.version), ...rows(file.custom, 'custom', levels, file.version)]
    const summary = {
      format: 'war3-object-mods',
      kind: kind.label,
      version: file.version,
      changedStandard: file.original.objects.length,
      custom: file.custom.objects.length,
      changes: table.length,
    }
    return {
      summary,
      metadata: [{ id: 'war3-object-mods', label: 'Warcraft III object-editor changes', entries: Object.entries(summary).map(([key, value]) => ({ key, value })) }],
      traits: [],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'object-mods',
          label: `Object-editor ${kind.label}`,
          preview: `${String(summary.changedStandard)} changed, ${String(summary.custom)} custom`,
          children: [tableNode(file.original, 'original', levels, file.version), tableNode(file.custom, 'custom', levels, file.version)],
        }),
        'common.view/table-data-source': createTableDataSource({ header: [...COLUMNS, ...(file.version === 3 ? ['v3-unknown-ints'] : [])], rows: table }),
      },
      unsupportedFeatures: file.version === 3 ? ['object-mods-v3-unknown-header-semantics'] : [],
    }
  },
} satisfies InspectionCodecDefinition)

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
