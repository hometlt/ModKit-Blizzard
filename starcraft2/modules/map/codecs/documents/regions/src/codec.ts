import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readRegions, writeRegions, type RegionsResult } from '../../../../shared/format/formats/regions.js'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()
export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-name', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

function clone(data: RegionsResult): RegionsResult {
  const regions = data.regions.map(region => ({ ...region, shapes: region.shapes.map(shape => ({ ...shape, ...('extra' in shape ? { extra: { ...shape.extra } } : {}) })) }))
  return { regions, byId: new Map(regions.map(region => [region.id, region])), byName: new Map(regions.map(region => [region.name, region])) }
}

export const definition: any = Object.freeze({
  id: 'blizzard/sc2-map-regions',
  format: Object.freeze({ id: 'sc2-map-regions', label: 'StarCraft II map regions', mediaType: 'application/xml' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/(?:^|[\\/])(?:Regions|mapRegions)$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 'Regions' }
    return /<Regions(?:\s|>)/u.test(decoder.decode(prefix)) ? { confidence: 0.9, kind: 'structure', note: 'Regions-root' } : { confidence: 0, kind: 'structure', note: 'Regions-root-missing' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const xml = decoder.decode(bytes)
    const data = readRegions(xml)
    const shapeCount = data.regions.reduce((sum, region) => sum + region.shapes.length, 0)
    if (data.regions.length + shapeCount + 1 > context.budget.maxNodes) throw new RangeError('Regions exceeds the inspection node budget')
    const diagnostics = Object.freeze([
      ...(!/<Regions(?:\s|>)/u.test(xml) || !/<\/Regions\s*>/u.test(xml) ? [{ id: 'regions-root', category: 'syntax' as const, severity: 'warning' as const, code: 'blizzard.sc2-map-regions/missing-root', message: 'Document must contain a complete Regions root' }] : []),
      ...data.regions.filter(region => !Number.isSafeInteger(region.id)).map((region, index) => ({ id: `region-${index}-id`, category: 'semantic' as const, severity: 'warning' as const, code: 'blizzard.sc2-map-regions/invalid-id', message: `Region ${index} has an invalid id (${String(region.id)})` })),
    ])
    return {
      summary: { format: 'sc2-map-regions', regions: data.regions.length, shapes: shapeCount },
      metadata: [{ id: 'sc2-map-regions', label: 'SC2 Regions', entries: [{ key: 'regions', value: data.regions.length }, { key: 'shapes', value: shapeCount }] }],
      traits: [{ id: 'content.text', parameters: { language: 'xml' } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-map-regions', label: 'Regions', preview: `${data.regions.length} regions`, children: data.regions.map(region => ({ kind: 'sc2-map-region', label: region.name || `Region ${region.id}`, preview: `${region.shapes.length} shapes`, semanticPath: ['regions', String(region.id)], children: region.shapes.map((shape, index) => ({ kind: 'region-shape', label: shape.type, preview: 'center' in shape ? `${shape.center} r=${shape.radius}` : 'min' in shape ? `${shape.min ?? ''}–${shape.max ?? ''}` : `${Object.keys(shape.extra).length} fields`, semanticPath: ['regions', String(region.id), 'shapes', String(index)] })) })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['id', 'name', 'color', 'shapes'], rows: data.regions.map(region => [String(region.id), region.name, region.color ?? '', String(region.shapes.length)]) }),
      },
      diagnostics,
      unsupportedFeatures: ['formatting-preserving-structured-edit'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-name': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.id) || typeof input.name !== 'string') throw new TypeError('edit.content requires an integer id and string name')
          const next = clone(data)
          const region = next.byId.get(input.id)
          if (region === undefined) throw new RangeError(`Regions has no region ${input.id}`)
          region.name = input.name
          const output = encoder.encode(writeRegions(next))
          if (readRegions(decoder.decode(output)).byId.get(input.id)?.name !== input.name) throw new TypeError('Regions writer failed verification')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-map-regions:set-name:${input.id}`, edits: [replaceBytes(0, bytes.byteLength, output, `rename region ${input.id}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: false, notes: ['Known regions and shapes are preserved; XML formatting and unmodeled elements may be normalized'] } }) }
        },
      },
    }
  },
})
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
