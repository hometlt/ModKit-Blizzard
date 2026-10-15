import { createInspectionCodec, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readCellAttribute, writeCellAttribute } from '../../../../shared/format/formats/cell-attribute.js'

const ID = 'blizzard/sc2-cell-attribute'
const basename = (uri: string) => uri.replaceAll('\\', '/').split('/').at(-1) ?? ''

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'blizzard/sc2-cell-attribute.inspect-grid', handlerId: 'inspect-grid', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-cell', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be a positive safe integer`)
  return value as number
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${label} must be a non-negative safe integer`)
  return value as number
}
function byte(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 255) throw new RangeError(`${label} must be an integer in [0, 255]`)
  return value as number
}
function dimensions(input: any) { return { sizeX: positive(input?.width, 'width'), sizeY: positive(input?.height, 'height') } }
function gridSummary(bytes: Uint8Array, input: any) {
  const data = readCellAttribute(bytes, dimensions(input))
  const counts = new Uint32Array(256)
  for (const value of data.cells) counts[value] = (counts[value] ?? 0) + 1
  return {
    format: 'sc2-cell-attribute-grid', width: data.sizeX, height: data.sizeY,
    cells: data.cells.length, trailingBytes: data._raw.trailing.byteLength,
    values: Object.fromEntries([...counts.entries()].filter(([, count]) => count > 0).map(([value, count]) => [String(value), count])),
  }
}

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-cell-attribute', label: 'StarCraft II cell attribute layer', mediaType: 'application/octet-stream' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    const name = basename(uri)
    if (!/^CellAttribute_[A-Za-z0-9_]+$/u.test(name) || prefix.byteLength < 4) return { confidence: 0, kind: 'context', note: 'cell-attribute-path-or-header-missing' }
    return { confidence: 0.99, kind: 'context', note: `cell-attribute-${name.slice('CellAttribute_'.length)}` }
  },
  async inspect(bytes: Uint8Array, context: any) {
    if (bytes.byteLength < 4) throw new RangeError('CellAttribute requires a four-byte header')
    const suffix = basename(context.primary.source.uri).slice('CellAttribute_'.length)
    return {
      summary: { format: 'sc2-cell-attribute', suffix, byteLength: bytes.byteLength, payloadBytes: bytes.byteLength - 4, context: 'map-dimensions-required' },
      metadata: [{ id: 'sc2-cell-attribute', label: `CellAttribute_${suffix}`, entries: [{ key: 'suffix', value: suffix }, { key: 'payloadBytes', value: bytes.byteLength - 4 }, { key: 'context', value: 'map-dimensions-required' }] }],
      traits: [{ id: 'content.binary', parameters: { bytes: bytes.byteLength } }],
      dataSources: { 'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-cell-attribute', label: `CellAttribute_${suffix}`, preview: `${bytes.byteLength - 4} payload bytes`, children: [{ kind: 'header', label: 'Native header', preview: '4 bytes', semanticPath: ['header'] }, { kind: 'payload', label: 'Cell payload', preview: 'MapInfo dimensions required', semanticPath: ['cells'] }] }) },
      diagnostics: [],
      unsupportedFeatures: ['standalone-raster-without-map-dimensions', 'effective-navigation-composition'],
      handlers: {
        validate: async () => ({ kind: 'json', value: [] }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'inspect-grid': async (input: any) => ({ kind: 'json', value: gridSummary(bytes, input) }),
        'set-cell': async (input: any) => {
          const dims = dimensions(input)
          const x = nonNegative(input?.x, 'x')
          const y = nonNegative(input?.y, 'y')
          if (x >= dims.sizeX || y >= dims.sizeY) throw new RangeError('cell coordinate is outside the supplied map dimensions')
          const value = byte(input?.value, 'value')
          const data = readCellAttribute(bytes, dims)
          data.cells[y * dims.sizeX + x] = value
          const output = writeCellAttribute(data)
          if (readCellAttribute(output, dims).cells[y * dims.sizeX + x] !== value) throw new TypeError('CellAttribute writer did not preserve the requested value')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-cell-attribute:set-cell:${x}:${y}`, edits: [replaceBytes(0, bytes.byteLength, output, `set CellAttribute cell (${x}, ${y})`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Header, trailing bytes and every unedited cell are preserved'] } }) }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)

