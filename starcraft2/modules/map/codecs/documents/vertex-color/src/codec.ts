import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readVertexColor } from '../../../../shared/format/formats/vertex-color.js'

const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-color', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function dataOffset(bytes: Uint8Array, wanted: number): { offset: number; length: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const count = view.getUint32(8, true); let offset = 32
  if (wanted < 0 || wanted >= count) throw new RangeError('entry is outside vertex-color strokes')
  for (let index = 0; index < count; index += 1) { if (offset + 36 > bytes.length) throw new RangeError('truncated vertex-color entry'); const length = view.getUint32(offset + 32, true); const start = offset + 36; if (start + length > bytes.length) throw new RangeError('truncated vertex-color data'); if (index === wanted) return { offset: start, length }; offset = start + length }
  throw new RangeError('vertex-color entry missing')
}

export const definition: any = Object.freeze({
  id: 'blizzard/sc2-vertex-color', format: Object.freeze({ id: 'sc2-vertex-color', label: 'StarCraft II terrain vertex color', mediaType: 'application/octet-stream' }), operations,
  async detect(prefix: Uint8Array, uri: string) { const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === 'VTCL'; const path = /(?:^|[\\/])(?:t3VertCol|mapVertexColor)$/iu.test(uri); return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: 'VTCL' } : { confidence: 0, kind: 'magic', note: 'VTCL-missing' } },
  async inspect(bytes: Uint8Array, context: any) {
    const map = readVertexColor(bytes); if (map.entries.length + 1 > context.budget.maxNodes) throw new RangeError('Vertex-color strokes exceed the inspection node budget')
    const diagnostics = Object.freeze(map.version === 104 ? [] : [{ id: 'vtcl-version', category: 'compatibility' as const, severity: 'warning' as const, code: 'blizzard.sc2-vertex-color/version', message: `Unverified VTCL version ${map.version}` }])
    return {
      summary: { format: 'sc2-vertex-color', version: map.version, entries: map.entries.length, colorBytes: map.entries.reduce((sum, entry) => sum + entry.data.length, 0) },
      metadata: [{ id: 'sc2-vertex-color', label: 'SC2 vertex color', entries: [{ key: 'version', value: map.version }, { key: 'strokes', value: map.entries.length }] }], traits: [{ id: 'content.binary', parameters: { magic: 'VTCL', version: map.version } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-vertex-color', label: 'Vertex-color strokes', preview: `${map.entries.length}`, children: map.entries.map((entry, index) => ({ kind: 'vertex-color-stroke', label: `Stroke ${index}`, preview: `${entry.data.length} colors; ${entry.header.minX},${entry.header.minY}–${entry.header.maxX},${entry.header.maxY}`, semanticPath: ['entries', String(index)] })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['index', 'minX', 'minY', 'maxX', 'maxY', 'colors'], rows: map.entries.map((entry, index) => [String(index), String(entry.header.minX), String(entry.header.minY), String(entry.header.maxX), String(entry.header.maxY), String(entry.data.length)]) }),
      }, diagnostics,
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }), 'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-color': async (input: any) => { if (input === null || typeof input !== 'object' || !Number.isSafeInteger(input.entry) || !Number.isSafeInteger(input.index)) throw new TypeError('entry and index must be integers'); const location = dataOffset(bytes, input.entry); if (input.index < 0 || input.index >= location.length) throw new RangeError('index is outside vertex-color entry'); if (!Number.isSafeInteger(input.value) || input.value < 0 || input.value > 255) throw new RangeError('value must be an unsigned byte'); const output = bytes.slice(); output[location.offset + input.index] = input.value; if (readVertexColor(output).entries[input.entry]?.data[input.index] !== input.value) throw new TypeError('Vertex-color patch failed verification'); return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-vertex-color:set:${input.entry}:${input.index}`, edits: [replaceBytes(location.offset + input.index, 1, new Uint8Array([input.value]), 'set vertex color')], fidelity: { roundTrip: 'byte-identical', preservesUnknownData: true, notes: ['Only the selected authored color byte is replaced'] } }) } },
      },
    }
  },
})
export { operations }
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
