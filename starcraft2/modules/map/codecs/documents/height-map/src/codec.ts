import {
  createInspectionCodec,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import {
  readHeightMap,
  writeHeightMap,
} from '../../../../shared/format/index.js'

const ID = 'blizzard/sc2-height-map'
const MAGIC = new TextEncoder().encode('HMAP')

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-cell', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function matchesMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.byteLength && MAGIC.every((value, index) => bytes[index] === value)
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`)
  }
  return value as number
}

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-height-map', label: 'StarCraft II terrain height map', mediaType: 'application/octet-stream' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (!matchesMagic(prefix)) return { confidence: 0, kind: 'structure', note: 'hmap-magic-missing' }
    return {
      confidence: /(?:^|[\\/])(?:t3HeightMap|mapHeightMap)$/iu.test(uri) ? 1 : 0.995,
      kind: 'magic',
      note: 'HMAP',
    }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const map = readHeightMap(bytes)
    const diagnostics = Object.freeze(map.version === 101 ? [] : [{
      severity: 'warning', code: 'blizzard.sc2-height-map/version',
      message: `HMAP version ${map.version}; version 101 is the verified profile`,
    }])
    const rows = map.cells.map((cell, index) => [
      String(index % map.sizeX),
      String(Math.floor(index / map.sizeX)),
      String(cell.heightBase),
      String(cell.heightAdjustments),
      String(cell.mask),
    ])
    return {
      summary: {
        format: 'sc2-height-map',
        version: map.version,
        width: map.sizeX,
        height: map.sizeY,
        cells: map.cells.length,
        trailingBytes: map._raw.trailing.byteLength,
      },
      metadata: [{
        id: 'sc2-height-map',
        label: 'SC2 HeightMap',
        entries: [
          { key: 'version', value: map.version },
          { key: 'width', value: map.sizeX },
          { key: 'height', value: map.sizeY },
          { key: 'cells', value: map.cells.length },
        ],
      }],
      traits: [
        { id: 'content.binary', parameters: { bytes: bytes.byteLength } },
        { id: 'structure.layers', parameters: { width: map.sizeX, height: map.sizeY, count: 1 } },
      ],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-height-map',
          label: 'Height map',
          preview: `${map.sizeX} × ${map.sizeY}`,
          children: [
            { kind: 'header', label: 'Version', preview: String(map.version), semanticPath: ['version'] },
            { kind: 'grid', label: 'Cells', preview: String(map.cells.length), semanticPath: ['cells'] },
          ],
        }),
        'common.view/table-data-source': createTableDataSource({
          header: ['x', 'y', 'heightBase', 'heightAdjustments', 'mask'],
          rows,
          cellFacts: ({ column }) => column >= 2
            ? { type: { kind: 'number', integer: true }, unit: 'native terrain quantization units' }
            : { type: { kind: 'number', integer: true } },
        }),
      },
      diagnostics,
      unsupportedFeatures: ['world-height-without-terrain-quantization-context'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-cell': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            throw new TypeError('edit.content requires an object')
          }
          const x = integer(input.x, 'x', 0, map.sizeX - 1)
          const y = integer(input.y, 'y', 0, map.sizeY - 1)
          const index = y * map.sizeX + x
          const current = map.cells[index]!
          const next = structuredClone(map)
          next.cells[index] = {
            heightBase: input.heightBase === undefined ? current.heightBase : integer(input.heightBase, 'heightBase', 0, 0xffff),
            heightAdjustments: input.heightAdjustments === undefined ? current.heightAdjustments : integer(input.heightAdjustments, 'heightAdjustments', 0, 0xffff),
            mask: input.mask === undefined ? current.mask : integer(input.mask, 'mask', 0, 0xffff),
          }
          const output = writeHeightMap(next)
          readHeightMap(output)
          return {
            kind: 'edit-plan',
            plan: editPlanFromInput(context.input, {
              planId: `sc2-height-map:set-cell:${x}:${y}`,
              edits: [replaceBytes(0, bytes.byteLength, output, `set HMAP cell (${x}, ${y})`)],
              fidelity: {
                roundTrip: 'semantic',
                preservesUnknownData: true,
                notes: ['Header padding, trailing bytes and every unedited cell are preserved'],
              },
            }),
          }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
