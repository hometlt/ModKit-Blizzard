import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readFluffDoodad, writeFluffDoodad } from '../../../../shared/format/formats/fluff-doodad.js'

const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-doodad', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function finite(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('coordinates must be finite numbers')
  return value
}

export const definition: any = Object.freeze({
  id: 'blizzard/sc2-fluff-doodad', format: Object.freeze({ id: 'sc2-fluff-doodad', label: 'StarCraft II fluff doodads', mediaType: 'application/octet-stream' }), operations,
  async detect(prefix: Uint8Array, uri: string) { const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === 'DLFT'; const path = /(?:^|[\\/])(?:t3FluffDoodad|mapFluffDoodad)$/iu.test(uri); return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: 'DLFT' } : { confidence: 0, kind: 'magic', note: 'DLFT-missing' } },
  async inspect(bytes: Uint8Array, context: any) {
    const map = readFluffDoodad(bytes)
    if (map.doodads.length + 1 > context.budget.maxNodes) throw new RangeError('Fluff doodads exceed the inspection node budget')
    const diagnostics = Object.freeze(map.doodads.flatMap((doodad, index) => doodad.type > 7 ? [{ id: `fluff-${index}`, category: 'semantic' as const, severity: 'warning' as const, code: 'blizzard.sc2-fluff-doodad/type-range', message: `Doodad ${index} has unknown type ${doodad.type}` }] : []))
    return {
      summary: { format: 'sc2-fluff-doodad', version: map.version, doodads: map.doodads.length, trailingBytes: map._raw.trailing.length },
      metadata: [{ id: 'sc2-fluff-doodad', label: 'SC2 fluff doodads', entries: [{ key: 'version', value: map.version }, { key: 'doodads', value: map.doodads.length }] }],
      traits: [{ id: 'content.binary', parameters: { magic: 'DLFT', version: map.version } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-fluff-doodad', label: 'Fluff doodads', preview: `${map.doodads.length}`, children: map.doodads.map((doodad, index) => ({ kind: 'fluff-doodad', label: `Doodad ${index}`, preview: `type ${doodad.type} at ${doodad.x}, ${doodad.y}`, semanticPath: ['doodads', String(index)] })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['index', 'x', 'y', 'type'], rows: map.doodads.map((doodad, index) => [String(index), String(doodad.x), String(doodad.y), String(doodad.type)]) }),
      }, diagnostics,
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-doodad': async (input: any) => {
          if (input === null || typeof input !== 'object' || !Number.isSafeInteger(input.index) || input.index < 0 || input.index >= map.doodads.length) throw new RangeError('index is outside fluff doodads')
          const current = map.doodads[input.index]!
          const type = input.type === undefined ? current.type : input.type
          if (!Number.isSafeInteger(type) || type < 0 || type > 255) throw new RangeError('type must be an unsigned byte')
          const next = readFluffDoodad(writeFluffDoodad(map)); next.doodads[input.index] = { x: finite(input.x, current.x), y: finite(input.y, current.y), type }
          const output = writeFluffDoodad(next); const reopened = readFluffDoodad(output).doodads[input.index]!
          if (reopened.type !== type) throw new TypeError('Fluff doodad writer failed verification')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-fluff-doodad:set:${input.index}`, edits: [replaceBytes(0, bytes.byteLength, output, `set fluff doodad ${input.index}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Header padding, trailing bytes and untouched doodads are preserved'] } }) }
        },
      },
    }
  },
})
export { operations }
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
