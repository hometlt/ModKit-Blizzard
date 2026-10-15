import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readTextureMasks, textureMaskWeight, writeTextureMasks, setTextureMaskWindow } from '../../../../shared/format/formats/texture-masks.js'
const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'blizzard/sc2-texture-masks.inspect-weight', handlerId: 'inspect-weight', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-weight', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])
function integer(value: unknown, name: string, min: number, max: number) { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`); return value as number }
export const definition: any = Object.freeze({
  id: 'blizzard/sc2-texture-masks', format: Object.freeze({ id: 'sc2-texture-masks', label: 'StarCraft II texture masks', mediaType: 'application/octet-stream' }), operations,
  async detect(prefix: Uint8Array, uri: string) { const magic = prefix.length >= 4 && String.fromCharCode(...prefix.subarray(0, 4)) === 'MASK'; const path = /(?:^|[\\/])(?:t3TextureMasks|mapTextureMasks)$/iu.test(uri); return magic ? { confidence: path ? 1 : 0.99, kind: path ? 'context' : 'magic', note: 'MASK' } : { confidence: 0, kind: 'magic', note: 'MASK-missing' } },
  async inspect(bytes: Uint8Array, context: any) {
    const map = readTextureMasks(bytes)
    if (map.layers + 2 > context.budget.maxNodes) throw new RangeError('TextureMasks exceeds the inspection node budget')
    const diagnostics = Object.freeze(map._raw.trailing.length === 0 ? [] : [{ id: 'texture-mask-trailing', category: 'structure' as const, severity: 'warning' as const, code: 'blizzard.sc2-texture-masks/trailing-bytes', message: `${map._raw.trailing.length} bytes do not form complete mask blocks and are preserved` }])
    const access = (input: any) => ({ layer: integer(input?.layer, 'layer', 0, map.layers - 1), x: integer(input?.x, 'x', 0, map.sizeX - 1), y: integer(input?.y, 'y', 0, map.sizeY - 1) })
    return {
      summary: { format: 'sc2-texture-masks', version: map.version, width: map.sizeX, height: map.sizeY, layers: map.layers, tilesX: map.tilesX, tilesY: map.tilesY, trailingBytes: map._raw.trailing.length },
      metadata: [{ id: 'sc2-texture-masks', label: 'SC2 TextureMasks', entries: [{ key: 'version', value: map.version }, { key: 'dimensions', value: `${map.sizeX}×${map.sizeY}` }, { key: 'layers', value: map.layers }, { key: 'blocksPerLayer', value: map.blocksPerLayer }] }],
      traits: [{ id: 'content.binary', parameters: { magic: 'MASK', version: map.version } }, { id: 'structure.layers', parameters: { width: map.sizeX, height: map.sizeY, count: map.layers } }],
      dataSources: { 'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-texture-masks', label: 'Texture masks', preview: `${map.layers} × ${map.sizeX}×${map.sizeY}`, children: Array.from({ length: map.layers }, (_, layer) => ({ kind: 'texture-mask-layer', label: `Layer ${layer}`, preview: `${map.blocksPerLayer} blocks`, semanticPath: ['layers', String(layer)] })) }), 'common.view/table-data-source': createTableDataSource({ header: ['layer', 'width', 'height', 'blocks'], rows: Array.from({ length: map.layers }, (_, layer) => [String(layer), String(map.sizeX), String(map.sizeY), String(map.blocksPerLayer)]) }) },
      diagnostics,
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'inspect-weight': async (input: any) => { const at = access(input); return { kind: 'json', value: { ...at, weight: textureMaskWeight(map, at.layer, at.x, at.y) } } },
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-weight': async (input: any) => { const at = access(input); const weight = integer(input?.weight, 'weight', 0, 15); const next = setTextureMaskWindow(map, at.layer, { x: at.x, y: map.sizeY - 1 - at.y, width: 1, height: 1, values: [weight] }); const output = writeTextureMasks(next); if (textureMaskWeight(readTextureMasks(output), at.layer, at.x, at.y) !== weight) throw new TypeError('TextureMasks writer failed verification'); return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-texture-masks:set-weight:${at.layer}:${at.x}:${at.y}`, edits: [replaceBytes(0, bytes.byteLength, output, `set texture mask ${at.layer} at (${at.x}, ${at.y})`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Header, block padding, trailing bytes, other layers and every unedited nibble are preserved'] } }) } },
      },
    }
  },
})
export { operations }
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)

