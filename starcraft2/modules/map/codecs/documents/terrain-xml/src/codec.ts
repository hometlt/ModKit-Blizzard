import { createInspectionCodec, createRelationGraphSource, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { parseTerrainXml } from '../../../../shared/format/terrain-params.js'
import { replaceXmlElementAttributes } from '../../../../shared/documents/xml-edit.js'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()
export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-height-parameters', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

export const definition: any = Object.freeze({
  id: 'blizzard/sc2-terrain-xml',
  format: Object.freeze({ id: 'sc2-terrain-xml', label: 'StarCraft II terrain parameters', mediaType: 'application/xml' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    if (/(?:^|[\\/])t3Terrain\.xml$/iu.test(uri)) return { confidence: 1, kind: 'context', note: 't3Terrain.xml' }
    const text = decoder.decode(prefix)
    return /<terrain(?:\s|>)/u.test(text) && /<heightMap(?:\s|>)/u.test(text) ? { confidence: 0.92, kind: 'structure', note: 'terrain-heightMap' } : { confidence: 0, kind: 'structure', note: 'terrain-root-missing' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const xml = decoder.decode(bytes)
    const data = parseTerrainXml(xml)
    const cliffCells = data.cliffCells ?? []
    const ramps = data.ramps ?? []
    const nodeCount = data.textures.length + (data.cliffSets?.length ?? 0) + cliffCells.length + ramps.length + 1
    if (nodeCount > context.budget.maxNodes) throw new RangeError('t3Terrain.xml exceeds the inspection node budget')
    const diagnostics = Object.freeze([
      ...(!/<terrain(?:\s|>)/u.test(xml) || !/<\/terrain\s*>/u.test(xml) ? [{ id: 'terrain-root', category: 'syntax' as const, severity: 'warning' as const, code: 'blizzard.sc2-terrain-xml/missing-root', message: 'Document must contain a complete terrain root' }] : []),
      ...(data.dimX === undefined || data.dimY === undefined ? [{ id: 'terrain-dimensions', category: 'semantic' as const, severity: 'warning' as const, code: 'blizzard.sc2-terrain-xml/missing-dimensions', message: 'heightMap dim is missing or invalid' }] : []),
    ])
    const textureNodes = data.textures.map(texture => ({ id: `texture:${texture.index}`, label: texture.name, type: 'terrain-texture', kind: 'Terrain' }))
    const cliffNodes = (data.cliffSets ?? []).flatMap((name, index) => name === undefined ? [] : [{ id: `cliff:${index}`, label: name, type: 'cliff-set', kind: 'Cliff' }])
    return {
      summary: { format: 'sc2-terrain-xml', tileSet: data.tileSet ?? null, dimensions: data.dimX === undefined ? null : [data.dimX, data.dimY], textures: data.textures.length, cliffSets: cliffNodes.length, cliffCells: cliffCells.length, ramps: ramps.length, quantizeScale: data.quantizeScale, quantizeBias: data.quantizeBias, standardHeight: data.standardHeight },
      metadata: [{ id: 'sc2-terrain-xml', label: 'SC2 terrain', entries: [{ key: 'tileSet', value: data.tileSet ?? '' }, { key: 'dimensions', value: data.dimX === undefined ? '' : `${data.dimX}×${data.dimY}` }, { key: 'textures', value: data.textures.length }, { key: 'cliffCells', value: cliffCells.length }, { key: 'ramps', value: ramps.length }] }],
      traits: [{ id: 'content.text', parameters: { language: 'xml' } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-terrain-xml', label: 'Terrain', preview: data.tileSet ?? '', children: [{ kind: 'height-map', label: 'Height map', preview: `${data.dimX ?? '?'}×${data.dimY ?? '?'}`, semanticPath: ['heightMap'] }, { kind: 'textures', label: 'Textures', preview: `${data.textures.length}`, semanticPath: ['textures'], children: data.textures.map(texture => ({ kind: 'terrain-texture', label: texture.name, preview: `index ${texture.index}`, semanticPath: ['textures', String(texture.index)] })) }, { kind: 'cliffs', label: 'Cliffs', preview: `${cliffCells.length} cells, ${ramps.length} ramps`, semanticPath: ['cliffs'] }] }),
        'common.view/table-data-source': createTableDataSource({ header: ['kind', 'index', 'name/value'], rows: [...data.textures.map(texture => ['texture', String(texture.index), texture.name]), ...cliffNodes.map((node, index) => ['cliff-set', String(index), node.label])] }),
        'common.view/relation-graph-source': createRelationGraphSource({ snapshotId: String(context.input.revisions.revision), nodes: [{ id: 'terrain', label: 't3Terrain.xml', type: 'terrain-document', kind: 'sc2-terrain-xml' }, ...textureNodes, ...cliffNodes], edges: [...textureNodes.map(node => ({ from: 'terrain', to: node.id, role: 'texture' })), ...cliffNodes.map(node => ({ from: 'terrain', to: node.id, role: 'cliff-set' }))], completeness: 'complete' }),
      },
      diagnostics,
      unsupportedFeatures: ['cliff-cell-editing', 'ramp-editing', 'texture-list-editing'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-height-parameters': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('edit.content requires an object')
          const values = { quantizeScale: input.quantizeScale, quantizeBias: input.quantizeBias, standardHeight: input.standardHeight }
          if (!Object.values(values).every(value => typeof value === 'number' && Number.isFinite(value))) throw new TypeError('quantizeScale, quantizeBias and standardHeight must be finite numbers')
          const outputXml = replaceXmlElementAttributes(xml, 'vertData', Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])))
          const reopened = parseTerrainXml(outputXml)
          if (reopened.quantizeScale !== values.quantizeScale || reopened.quantizeBias !== values.quantizeBias || reopened.standardHeight !== values.standardHeight) throw new TypeError('terrain parameter edit failed verification')
          const output = encoder.encode(outputXml)
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: 'sc2-terrain-xml:set-height-parameters', edits: [replaceBytes(0, bytes.byteLength, output, 'set terrain height quantization parameters')], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: ['Only three attributes on vertData are replaced; every other authored XML byte is preserved'] } }) }
        },
      },
    }
  },
})
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
