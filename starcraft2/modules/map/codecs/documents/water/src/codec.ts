import { createInspectionCodec, createRelationGraphSource, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { encodeWaterTemplateId, readWater, writeWater } from '../../../../shared/format/formats/water.js'
const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-zone', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])
function finite(value: unknown, fallback: number) { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('zone coordinates must be finite numbers'); return value }
export const definition: any = Object.freeze({
  id: 'blizzard/sc2-water', format: Object.freeze({ id: 'sc2-water', label: 'StarCraft II water zones', mediaType: 'application/octet-stream' }), operations,
  async detect(prefix: Uint8Array, uri: string) { const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === 'WATR'; const path = /(?:^|[\\/])(?:t3Water|mapWater)$/iu.test(uri); return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: 'WATR' } : { confidence: 0, kind: 'magic', note: 'WATR-missing' } },
  async inspect(bytes: Uint8Array, context: any) {
    const map = readWater(bytes)
    if (map.zones.length * 2 + 1 > context.budget.maxNodes) throw new RangeError('Water exceeds the inspection node budget')
    const diagnostics = Object.freeze(map.zones.flatMap((zone, index) => zone.endX < zone.startX || zone.endY < zone.startY ? [{ id: `water-zone-${index}`, category: 'semantic' as const, severity: 'warning' as const, code: 'blizzard.sc2-water/reversed-bounds', message: `Water zone ${index} has reversed bounds` }] : []))
    const targets = [...new Set(map.zones.map(zone => zone.templateId))].map(id => ({ id: `water:${id.toLowerCase()}`, label: id, type: 'catalog-entity', kind: 'Water' }))
    return {
      summary: { format: 'sc2-water', version: map.version, zones: map.zones.length, templates: targets.length, trailingBytes: map._raw.trailing.length },
      metadata: [{ id: 'sc2-water', label: 'SC2 Water', entries: [{ key: 'version', value: map.version }, { key: 'zones', value: map.zones.length }, { key: 'templates', value: targets.length }] }],
      traits: [{ id: 'content.binary', parameters: { magic: 'WATR', version: map.version } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-water', label: 'Water zones', preview: `${map.zones.length}`, children: map.zones.map((zone, index) => ({ kind: 'water-zone', label: zone.templateId || `Zone ${index}`, preview: `${zone.startX},${zone.startY}–${zone.endX},${zone.endY}`, semanticPath: ['zones', String(index)] })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['index', 'template', 'startX', 'startY', 'endX', 'endY'], rows: map.zones.map((zone, index) => [String(index), zone.templateId, String(zone.startX), String(zone.startY), String(zone.endX), String(zone.endY)]) }),
        'common.view/relation-graph-source': createRelationGraphSource({ snapshotId: String(context.input.revisions.revision), nodes: [{ id: 'water-document', label: 't3Water', type: 'water-document', kind: 'sc2-water' }, ...targets], edges: map.zones.map(zone => ({ from: 'water-document', to: `water:${zone.templateId.toLowerCase()}`, role: 'water-template' })), completeness: 'complete' }),
      },
      diagnostics,
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-zone': async (input: any) => { if (input === null || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.index) || input.index < 0 || input.index >= map.zones.length) throw new RangeError('index is outside water zones'); const next = readWater(writeWater(map)); const zone = next.zones[input.index]!; const templateId = input.templateId === undefined ? zone.templateId : input.templateId; if (typeof templateId !== 'string' || templateId.length === 0 || templateId.length >= 40 || !/^[\x20-\x7e]+$/u.test(templateId)) throw new TypeError('templateId must be 1..39 printable ASCII characters'); const changedTemplate = templateId !== zone.templateId; const updated = { ...zone, templateId, templateIdBytes: changedTemplate ? encodeWaterTemplateId(templateId) : zone.templateIdBytes, startX: finite(input.startX, zone.startX), startY: finite(input.startY, zone.startY), endX: finite(input.endX, zone.endX), endY: finite(input.endY, zone.endY) }; next.zones[input.index] = updated; const output = writeWater(next); const reopened = readWater(output).zones[input.index]!; if (reopened.templateId !== templateId || reopened.startX !== updated.startX || reopened.endY !== updated.endY) throw new TypeError('Water writer failed verification'); return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-water:set-zone:${input.index}`, edits: [replaceBytes(0, bytes.byteLength, output, `set water zone ${input.index}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Header, trailing bytes and untouched zones are preserved; template padding is preserved unless templateId changes'] } }) } },
      },
    }
  },
})
export { operations }
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
