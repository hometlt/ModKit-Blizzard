/**
 * A publication header (`.s2mh`): what Battle.net knows about a published map or mod.
 *
 * The file is a tagged tree whose field names are the game's own — `Battlenet::S2Map::BnetHeader`
 * and the structures it references — so it is shown with those names rather than tag numbers. The
 * depot handles it carries are resolved to what they address: an archive, a locale document or a
 * preview image, with the region and digest they were published under.
 */
import { createInspectionCodec, createTableDataSource, createTreeDataSource,
  type InspectionTreeNode } from '@modkit/codec-kit'

import { decodeCacheHeader, reference, type CacheNode } from '../../../content-sources/cache-header.js'

const decoder = new TextDecoder('utf-8', { fatal: false })

/** `Battlenet::S2Map::BnetHeader`. */
const HEADER_FIELDS: Readonly<Record<string, string>> = {
  0: 'm_handle', 1: 'm_name', 2: 'm_archiveCacheHandle', 3: 'm_mapNamespace', 4: 'm_workingSet',
  5: 'm_definitions', 7: 'm_resultDefinitions', 8: 'm_locales', 9: 'm_size', 10: 'm_tileset',
  12: 'm_defaultVariantIndex', 13: 'm_variants', 14: 'm_extraDependencies',
  15: 'm_addDefaultPermissions', 16: 'm_relevantPermissions', 17: 'm_requiredPermissions',
  18: 'm_labels', 19: 'm_arcadeData', 22: 'm_addMultiMod', 23: 'm_resourceList',
}
/** `Battlenet::Attribute::WorkingSet`, the block the header's field 4 holds. */
const WORKING_SET_FIELDS: Readonly<Record<string, string>> = {
  0: 'm_name', 1: 'm_description', 2: 'm_thumbnail', 3: 'm_bigMap', 4: 'm_maxPlayers',
  5: 'm_specialScope', 6: 'm_instances', 7: 'm_visualFiles', 8: 'm_locales',
  9: 'm_visibilityOverrides', 10: 'm_indexRestrictions', 11: 'm_permissionRestrictions',
}
const HANDLE_KINDS: Readonly<Record<string, string>> = {
  s2ma: 'archive', s2ml: 'locale document', s2mv: 'preview image', s2mh: 'publication header',
}

const label = (node: CacheNode): string => {
  if (node.kind === 9) return String(node.value)
  if (node.kind === 4) return node.value === undefined ? 'none' : label(node.value as CacheNode)
  if (node.kind === 0) return `${(node.value as CacheNode[]).length} item(s)`
  if (node.kind === 5) return `${(node.value as Map<bigint, CacheNode>).size} field(s)`
  if (node.value instanceof Uint8Array) {
    const bytes = node.value
    const handle = bytes.length === 40 ? reference(bytes) : undefined
    if (handle) return `${HANDLE_KINDS[handle.type] ?? handle.type} · ${handle.region} · ${handle.sha256.slice(0, 16)}…`
    const printable = bytes.length <= 96 && bytes.every(byte => byte >= 32 && byte < 127)
    return printable ? decoder.decode(bytes) : `${bytes.length} bytes`
  }
  return `kind ${node.kind}`
}

const children = (node: CacheNode, names: Readonly<Record<string, string>> | undefined, path: readonly string[]): InspectionTreeNode[] => {
  if (node.kind === 5) {
    return [...(node.value as Map<bigint, CacheNode>).entries()].map(([tag, child]) => ({
      kind: 'field',
      label: names?.[String(tag)] ?? String(tag),
      preview: label(child),
      semanticPath: [...path, String(tag)],
      children: children(child, names === HEADER_FIELDS && Number(tag) === 4 ? WORKING_SET_FIELDS : undefined, [...path, String(tag)]),
    }))
  }
  if (node.kind === 0) {
    return (node.value as CacheNode[]).map((child, index) => ({
      kind: 'item', label: `[${index}]`, preview: label(child),
      semanticPath: [...path, String(index)], children: children(child, undefined, [...path, String(index)]),
    }))
  }
  if (node.kind === 4 && node.value !== undefined) return children(node.value as CacheNode, names, path)
  return []
}

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
])

export const definition = Object.freeze({
  id: 'blizzard/sc2-publication-header',
  format: Object.freeze({ id: 'sc2-publication-header', label: 'Publication header', mediaType: 'application/octet-stream' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/\.s2mh$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 's2mh' }
    // The format has no magic; a header always starts a map whose first field is the identity.
    return prefix[0] === 5 ? { confidence: 0.4, kind: 'structure', note: 'tagged-map' }
      : { confidence: 0, kind: 'structure', note: 'not-tagged-map' }
  },
  async inspect(bytes: Uint8Array, context: { budget: { maxNodes: number } }) {
    const tree = decodeCacheHeader(bytes)
    const publication = (tree.value as Map<bigint, CacheNode>).get(0n)
    if (publication === undefined) throw new TypeError('A publication header starts with the publication it describes')
    const fields = publication.value as Map<bigint, CacheNode>
    const identity = fields.get(0n)?.value as Map<bigint, CacheNode> | undefined
    const id = Number(identity?.get(0n)?.value ?? 0)
    const version = Number(identity?.get(1n)?.value ?? 0)
    const name = label(fields.get(1n) ?? { kind: 2, value: new Uint8Array() })
    const rows = [...fields.entries()].map(([tag, node]) =>
      [HEADER_FIELDS[String(tag)] ?? String(tag), label(node)])
    if (rows.length > context.budget.maxNodes) throw new RangeError('Publication header exceeds the inspection node budget')
    return {
      summary: { format: 'sc2-publication-header', id, version: `${version >>> 16}.${version & 0xffff}`, name },
      metadata: [{
        id: 'sc2-publication-header', label: 'Publication header',
        entries: [
          { key: 'id', value: id },
          { key: 'version', value: `${version >>> 16}.${version & 0xffff}` },
          { key: 'name', value: name },
          { key: 'namespace', value: Number(fields.get(3n)?.value ?? 0) },
        ],
      }],
      traits: [],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-publication-header', label: name, preview: `#${id} · ${version >>> 16}.${version & 0xffff}`,
          children: children(publication, HEADER_FIELDS, []),
        }),
        'common.view/table-data-source': createTableDataSource({ header: ['field', 'value'], rows }),
      },
      diagnostics: [],
      unsupportedFeatures: [],
      handlers: {
        validate: async () => ({ kind: 'json', value: [] }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
      },
    }
  },
})
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition as never, context as never)
