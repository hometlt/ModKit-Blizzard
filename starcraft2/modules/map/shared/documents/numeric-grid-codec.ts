import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'

type CellValue = Readonly<Record<string, string | number | boolean>>
export interface NumericGridAdapter<T> {
  readonly id: string
  readonly formatId: string
  readonly label: string
  readonly magic: string
  readonly paths: readonly RegExp[]
  readonly read: (bytes: Uint8Array) => T
  readonly write: (data: T) => Uint8Array
  readonly dimensions: (data: T) => readonly [number, number]
  readonly version: (data: T) => number
  readonly cell: (data: T, index: number) => CellValue
  readonly setCell: (data: T, index: number, input: Readonly<Record<string, unknown>>) => void
  readonly preserved: (data: T) => CellValue
}

export function numericGridOperations(codecId: string) { return Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: `${codecId}.inspect-cell`, handlerId: 'inspect-cell', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-cell', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
]) }

function indexOf(input: any, width: number, height: number): number {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)) throw new TypeError('x and y must be safe integers')
  if (input.x < 0 || input.y < 0 || input.x >= width || input.y >= height) throw new RangeError(`cell (${input.x}, ${input.y}) is outside ${width}×${height}`)
  return input.y * width + input.x
}

export function createNumericGridCodec<T>(adapter: NumericGridAdapter<T>) {
  const operations = numericGridOperations(adapter.id)
  const definition: any = Object.freeze({
    id: adapter.id,
    format: Object.freeze({ id: adapter.formatId, label: adapter.label, mediaType: 'application/octet-stream' }),
    operations,
    async detect(prefix: Uint8Array, uri: string) {
      const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === adapter.magic
      const path = adapter.paths.some(pattern => pattern.test(uri))
      return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: adapter.magic } : { confidence: 0, kind: 'magic', note: `${adapter.magic}-missing` }
    },
    async inspect(bytes: Uint8Array, context: any) {
      const data = adapter.read(bytes)
      const [width, height] = adapter.dimensions(data)
      const count = width * height
      const sampleCount = Math.min(count, Math.max(0, Math.min(4096, context.budget.maxNodes - 2)))
      const rows = Array.from({ length: sampleCount }, (_, index) => {
        const value = adapter.cell(data, index)
        return [String(index % width), String(Math.floor(index / width)), JSON.stringify(value)]
      })
      const diagnostics = Object.freeze([])
      return {
        summary: { format: adapter.formatId, version: adapter.version(data), width, height, cells: count, sampledCells: sampleCount, ...adapter.preserved(data) },
        metadata: [{ id: adapter.formatId, label: adapter.label, entries: [{ key: 'version', value: adapter.version(data) }, { key: 'width', value: width }, { key: 'height', value: height }, { key: 'cells', value: count }, ...Object.entries(adapter.preserved(data)).map(([key, value]) => ({ key, value }))] }],
        traits: [{ id: 'content.binary', parameters: { magic: adapter.magic, version: adapter.version(data) } }],
        dataSources: {
          'common.view/tree-data-source': createTreeDataSource({ kind: adapter.formatId, label: adapter.label, preview: `${width}×${height}, v${adapter.version(data)}`, children: [{ kind: 'grid', label: 'Grid', preview: `${count} cells`, semanticPath: ['cells'] }, { kind: 'raw-preservation', label: 'Preserved binary fields', preview: JSON.stringify(adapter.preserved(data)), semanticPath: ['raw'] }] }),
          'common.view/table-data-source': createTableDataSource({ header: ['x', 'y', 'value'], rows }),
        },
        diagnostics,
        handlers: {
          validate: async () => ({ kind: 'json', value: diagnostics }),
          'inspect-cell': async (input: any) => { const index = indexOf(input, width, height); return { kind: 'json', value: { x: input.x, y: input.y, ...adapter.cell(data, index) } } },
          'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
          'set-cell': async (input: any) => {
            const index = indexOf(input, width, height)
            const next = adapter.read(adapter.write(data))
            adapter.setCell(next, index, input)
            const output = adapter.write(next)
            const reopened = adapter.read(output)
            if (JSON.stringify(adapter.cell(reopened, index)) !== JSON.stringify(adapter.cell(next, index))) throw new TypeError(`${adapter.label} writer failed cell verification`)
            return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `${adapter.formatId}:set-cell:${input.x}:${input.y}`, edits: [replaceBytes(0, bytes.byteLength, output, `set ${adapter.formatId} cell (${input.x}, ${input.y})`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Header, trailing bytes and every unedited cell are preserved by the native writer'] } }) }
          },
        },
      }
    },
  })
  return { definition, operations, createCodec: (context?: unknown) => createInspectionCodec(definition, context as never) }
}
