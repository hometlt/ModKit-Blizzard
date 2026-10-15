/**
 * SC2 Maps HRDT document inspection. Reads version-102 headers, blocks and native
 * 58-byte placement records through the shared parser; publishes read-only tree,
 * block table, diagnostics and byte-exact raw export. Placement normals and
 * opaque words retain their original bit representation. Explicit duplicate group-key repair
 * and bounded v102 group replacement use the shared writer. Spline inference and UVW export
 * remain unsupported here; Node and worker variants share this browser-safe source.
 */
import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readHardTile, repairHardTileGroupKeys, replaceHardTileGroups, type HardTileWriteBlock } from '../../../../shared/format/formats/hard-tile.js'

/** Present one original binary record without assigning meaning to its unknown bytes. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const REPAIR_OPERATION = 'blizzard/sc2-hard-tile.repair-group-keys'
const REPLACE_OPERATION = 'blizzard/sc2-hard-tile.replace-groups'
const uint32 = { type: 'integer', minimum: 0, maximum: 4294967295 }
const float32 = { type: 'number', minimum: -3.4028234663852886e38, maximum: 3.4028234663852886e38 }
/** Native structural fields are explicit; this schema does not assign portable road semantics. */
const vector = (items: object, length: number) => ({ type: 'array', items, minItems: length, maxItems: length })
const recordFields = {
  x: float32, y: float32, z: float32, normal: vector(float32, 3),
  unknownWords: vector(uint32, 6), scale: float32, tailWord: uint32,
  flags: vector({ type: 'integer', minimum: 0, maximum: 255 }, 2),
}
const groupFields = {
  name: { type: 'string', maxLength: 255, pattern: '^[^\\u0000]*$' },
  flags: vector({ type: 'integer', minimum: 0, maximum: 255 }, 3), tailWord: uint32,
  subs: { type: 'array', maxItems: 1000000, items: {
    type: 'object', additionalProperties: false, properties: recordFields, required: Object.keys(recordFields),
  } },
}
const replaceInputSchema = {
  $ref: 'modkit://blizzard/sc2-hard-tile/replace-groups.v1',
  document: {
    type: 'object', additionalProperties: false, required: ['groups'],
    description: 'Replace all native v102 groups. Header is preserved. Every opaque field must be explicit; duplicate group words are refused. This is not a portable road-chain input.',
    properties: { groups: { type: 'array', maxItems: 16384, items: {
      type: 'object', additionalProperties: false, properties: groupFields, required: Object.keys(groupFields),
    } } },
  },
}

const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: REPAIR_OPERATION, handlerId: 'repair-group-keys', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
  Object.freeze({ id: REPLACE_OPERATION, handlerId: 'replace-groups', inputSchema: replaceInputSchema, mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])
export const definition: any = Object.freeze({
  id: 'blizzard/sc2-hard-tile', format: Object.freeze({ id: 'sc2-hard-tile', label: 'StarCraft II hard tiles', mediaType: 'application/octet-stream' }), operations,
  async detect(prefix: Uint8Array, uri: string) { const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === 'HRDT'; const path = /(?:^|[\\/])(?:t3HardTile|mapHardTile)$/iu.test(uri); return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: 'HRDT' } : { confidence: 0, kind: 'magic', note: 'HRDT-missing' } },
  /** Inspect decoded native records while keeping incomplete bytes and existing block views visible. */
  async inspect(bytes: Uint8Array, context: any) {
    const map = readHardTile(bytes, {
      maxGroups: Math.min(context.budget.maxNodes, 16384),
      maxRecords: Math.min(context.budget.maxNodes, 1000000),
      maxNodes: context.budget.maxNodes,
    })
    const placements = map.blocks.reduce((sum, block) => sum + block.subs.length, 0)
    if (map.blocks.length + placements + 1 > context.budget.maxNodes)
      throw new RangeError('Hard-tile blocks exceed the inspection node budget')
    const opaqueBytes = bytes.length - map.decodedBytes
    const partial = map.rawRemainder !== undefined || map.version !== 102 || map.decodedBytes !== bytes.length || map.blocks.length !== map.declaredBlocks
    const duplicates = map.blocks.length - new Set(map.blocks.map(block => block.tailWord)).size
    const diagnostics = Object.freeze(partial ? [{
      id: 'hard-tile-layout', category: 'structure' as const, severity: 'warning' as const,
      code: 'blizzard.sc2-hard-tile/partial-layout',
      message: `The hard-tile layout is only partially decoded (${opaqueBytes} opaque byte(s) after offset ${map.decodedBytes}); editing is disabled and all bytes remain available through raw export`,
    }] : [])
    return {
      summary: { format: 'sc2-hard-tile', version: map.version, headerUnknownWords: map.unk, blocks: map.blocks.length, declaredBlocks: map.declaredBlocks, placements, decodedBytes: map.decodedBytes, opaqueBytes, partial },
      metadata: [{ id: 'sc2-hard-tile', label: 'SC2 hard tiles', entries: [{ key: 'version', value: map.version }, { key: 'blocks', value: map.blocks.length }, { key: 'editable', value: !partial }, { key: 'duplicateGroupKeys', value: map.blocks.length - new Set(map.blocks.map(block => block.tailWord)).size }] }],
      traits: [{ id: 'content.binary', parameters: { magic: 'HRDT', partialLayout: true } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-hard-tile', label: 'Hard tiles', preview: `${map.blocks.length}`,
          children: map.blocks.map((block, index) => ({
            kind: 'hard-tile-block', label: block.name || `Block ${index}`,
            preview: `${block.subs.length} placements`, semanticPath: ['blocks', String(index)],
            children: block.subs.map((placement, placementIndex) => ({
              kind: 'hard-tile-placement', label: `Placement ${placementIndex}`,
              preview: `${placement.x}, ${placement.y}, ${placement.z}`,
              semanticPath: ['blocks', String(index), 'subs', String(placementIndex)],
              value: { x: placement.x, y: placement.y, z: placement.z, normal: placement.normal, unknownWords: placement.unknownWords, scale: placement.scale, tailWord: placement.tailWord, flags: placement.flags, rawHex: hex(placement.raw) },
            })),
          })),
        }),
        'common.view/table-data-source': createTableDataSource({
          header: ['index', 'name', 'placements', 'flags', 'tailWord'],
          rows: map.blocks.map((block, index) => [String(index), block.name, String(block.subs.length), block.flags.join(','), String(block.tailWord)]),
        }),
      },
      operationStates: partial ? [REPAIR_OPERATION, REPLACE_OPERATION].map(id => ({ id, state: 'disabled', reason: 'Editing requires a fully decoded version102 document' })) : duplicates === 0 ? [{ id: REPAIR_OPERATION, state: 'disabled', reason: 'No duplicate group keys to repair' }] : [],
      diagnostics,
      handlers: { 'replace-groups': async (input: unknown) => {
        if (input === null || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).length !== 1 || !('groups' in input) || !Array.isArray(input.groups))
          throw new TypeError('Hard-tile replacement requires { groups: [...] }')
        const groups = input.groups as HardTileWriteBlock[]
        const nodeCount = groups.reduce((count, group) => count + 1 + (Array.isArray(group?.subs) ? group.subs.length : Infinity), 1)
        if (nodeCount > context.budget.maxNodes) throw new RangeError('Hard-tile replacement exceeds the total node budget')
        const replaced = replaceHardTileGroups(bytes, groups, {
          maxBytes: Math.min(context.budget.maxScalarBytes, 128 * 1024 * 1024),
          maxGroups: Math.min(context.budget.maxNodes, 16384),
          maxRecords: Math.min(context.budget.maxNodes, 1000000),
        })
        return { kind: 'edit-plan', plan: editPlanFromInput(context.input, {
          planId: 'sc2-hard-tile:replace-groups',
          edits: [replaceBytes(0, bytes.byteLength, replaced, 'replace explicit native road groups')],
          fidelity: { roundTrip: 'semantic', preservesUnknownData: false, notes: ['The original header survives; group contents are replaced explicitly, including opaque fields supplied by the caller. No inferred spline or material semantics.'] },
        }) }
      }, 'repair-group-keys': async (input: unknown) => {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0)
          throw new TypeError('Hard-tile group-key repair takes an empty object')
        const repaired = repairHardTileGroupKeys(bytes)
        if (repaired.changes.length === 0) throw new TypeError('No duplicate group keys to repair')
        return { kind: 'edit-plan', plan: editPlanFromInput(context.input, {
          planId: 'sc2-hard-tile:repair-group-keys',
          edits: [replaceBytes(0, bytes.byteLength, repaired.bytes, 'repair duplicate native road group keys')],
          fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Only repeated group words change; original unique keys and every other byte are preserved. No spline authoring is claimed.'] },
          diagnostics: [{ severity: 'information', code: 'blizzard/sc2-hard-tile-group-key-repair', message: `${repaired.changes.length} duplicate group key(s) repaired` }],
        }) }
      }, validate: async () => ({ kind: 'json', value: diagnostics }), 'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }) },
    }
  },
})
export { operations }
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
