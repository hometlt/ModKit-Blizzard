/**
 * A matchmaking queue header (`.s2qh`): a ladder or other matchmaking queue and the maps it plays.
 *
 * Shown like a publication header, with the names of the game's own schema
 * (`Battlenet::MatchMaker::Header` and what it references); the map pool is also a table — one row
 * per map with its Battle.net id and extension mods. The same reader serves the Battle.net provider's
 * `describeQueues`, so the codec and the live answer cannot disagree.
 */
import { createInspectionCodec, createTableDataSource, createTreeDataSource,
  type InspectionTreeNode } from '@modkit/codec-kit'

import { decodeCacheHeader, reference, type CacheNode } from '../../../content-sources/cache-header.js'
import { decodeQueueHeader, ladderMode, MAP_LINK_FIELDS, QUEUE_BASE_FIELDS, QUEUE_HANDLE_FIELDS,
  QUEUE_HEADER_FIELDS, QUEUE_MAP_FIELDS } from '../../../content-sources/queue-header.js'

const decoder = new TextDecoder('utf-8', { fatal: false })
const HANDLE_KINDS: Readonly<Record<string, string>> = {
  s2ql: 'queue locale table', s2qh: 'queue header', s2mv: 'image', s2mh: 'publication header',
}
/** Names of nested structures by the name of the field that holds them. */
const NESTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  HeaderBase: QUEUE_BASE_FIELDS, m_handle: QUEUE_HANDLE_FIELDS, m_link: MAP_LINK_FIELDS,
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
    if (bytes.length === 4 && bytes.every(byte => byte === 0 || (byte >= 32 && byte < 127))) return decoder.decode(bytes).replace(/^\0+/u, '')
    const printable = bytes.length <= 96 && bytes.every(byte => byte >= 32 && byte < 127)
    return printable ? decoder.decode(bytes) : `${bytes.length} bytes`
  }
  return `kind ${node.kind}`
}

const children = (node: CacheNode, names: Readonly<Record<string, string>> | undefined, path: readonly string[],
  itemNames?: Readonly<Record<string, string>>): InspectionTreeNode[] => {
  if (node.kind === 5) {
    return [...(node.value as Map<bigint, CacheNode>).entries()].map(([tag, child]) => {
      const name = names?.[String(tag)] ?? String(tag)
      return {
        kind: 'field', label: name, preview: label(child), semanticPath: [...path, String(tag)],
        children: children(child, NESTED[name], [...path, String(tag)], name === 'm_maps' ? QUEUE_MAP_FIELDS : undefined),
      }
    })
  }
  if (node.kind === 0) {
    return (node.value as CacheNode[]).map((child, index) => ({
      kind: 'item', label: `[${index}]`, preview: label(child),
      semanticPath: [...path, String(index)], children: children(child, itemNames, [...path, String(index)]),
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
  id: 'blizzard/sc2-queue-header',
  format: Object.freeze({ id: 'sc2-queue-header', label: 'Matchmaking queue header', mediaType: 'application/octet-stream' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/\.s2qh$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 's2qh' }
    // No magic: a tagged tree like a publication header, which claims unnamed files already.
    return { confidence: 0, kind: 'structure', note: prefix[0] === 5 ? 'tagged-map-without-extension' : 'not-tagged-map' }
  },
  async inspect(bytes: Uint8Array, context: { budget: { maxNodes: number } }) {
    const queue = decodeQueueHeader(bytes)
    if (queue.maps.length > context.budget.maxNodes) throw new RangeError('Queue header exceeds the inspection node budget')
    const mode = ladderMode(queue)
    const title = `${queue.region} queue ${queue.id} v${queue.version}`
    const rows = queue.maps.map((map, index) => [String(index), String(map.id), map.mods.join(', '),
      map.variantIndex === undefined ? '' : String(map.variantIndex), map.speed ?? ''])
    return {
      summary: { format: 'sc2-queue-header', region: queue.region, id: queue.id, version: queue.version,
        teamSize: queue.teamSize, teamCount: queue.teamCount, tags: queue.tags, maps: queue.maps.length, ...(mode ? { ladder: mode } : {}) },
      metadata: [{
        id: 'sc2-queue-header', label: 'Matchmaking queue',
        entries: [
          { key: 'region', value: queue.region },
          { key: 'id', value: queue.id },
          { key: 'version', value: queue.version },
          { key: 'teams', value: `${queue.teamCount} × ${queue.teamSize}` },
          { key: 'tags', value: queue.tags.join(' ') },
          { key: 'ladder', value: mode ?? 'no' },
          { key: 'maps', value: queue.maps.length },
        ],
      }],
      traits: [],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-queue-header', label: title, preview: `${queue.tags.join(' ')} · ${queue.maps.length} map(s)`,
          children: children(decodeCacheHeader(bytes), QUEUE_HEADER_FIELDS, []),
        }),
        'common.view/table-data-source': createTableDataSource({ header: ['#', 'map id', 'mods', 'variant', 'speed'], rows }),
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
