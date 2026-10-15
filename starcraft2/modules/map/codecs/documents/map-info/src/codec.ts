/** MapInfo document adapter: native dimensions/boundary and opt-in v39 Editor context edits.
 * edit.content retains its existing handler; explicit context action delegates to the format owner.
 * Unknown layout/tail fields stay opaque; catalog existence is the caller's responsibility. */
import { createInspectionCodec, createTableDataSource, createTreeDataSource, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import { readMapInfo, resizeMapInfo, writeMapInfo, mapInfoEditorTerrainContext,
  setMapInfoEditorTerrainContext } from '../../../../shared/format/formats/map-info.js'

const ID = 'blizzard/sc2-map-info'
export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-dimensions', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-map-info', label: 'StarCraft II MapInfo', mediaType: 'application/octet-stream' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    const exactPath = /(?:^|[\\/])MapInfo(?:_(?:LS|NoLS))?$/iu.test(uri)
    const magic = prefix.length >= 4 && prefix[0] === 0x49 && prefix[1] === 0x70 && prefix[2] === 0x61 && prefix[3] === 0x4d
    return magic ? { confidence: exactPath ? 1 : 0.99, kind: exactPath ? 'context' : 'magic', note: 'IpaM/MapI' } : { confidence: 0, kind: 'magic', note: 'MapInfo-magic-missing' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const data = readMapInfo(bytes)
    if (data.strings.length + 8 > context.budget.maxNodes) throw new RangeError('MapInfo exceeds the inspection node budget')
    const diagnostics = Object.freeze([
      ...(data.width === 0 || data.height === 0 ? [{ id: 'map-info-dimensions', category: 'semantic' as const, severity: 'warning' as const, code: 'blizzard.sc2-map-info/zero-dimension', message: 'Map dimensions must be non-zero' }] : []),
    ])
    const boundary = data.boundary
    const editorTerrainContext = mapInfoEditorTerrainContext(data)
    return {
      summary: { format: 'sc2-map-info', version: data.version, width: data.width, height: data.height, boundary: boundary ?? null, strings: data.strings.length, preservedBodyBytes: data.body.length, editorTerrainContext: editorTerrainContext ?? null },
      metadata: [{ id: 'sc2-map-info', label: 'SC2 MapInfo', entries: [{ key: 'version', value: data.version }, { key: 'width', value: data.width }, { key: 'height', value: data.height }, { key: 'bodyBytes', value: data.body.length }] }],
      traits: [{ id: 'content.binary', parameters: { format: 'MapI', version: data.version } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-map-info', label: 'MapInfo', preview: `${data.width}×${data.height}, v${data.version}`, children: [{ kind: 'dimensions', label: 'Dimensions', preview: `${data.width}×${data.height}`, semanticPath: ['dimensions'] }, ...(boundary === undefined ? [] : [{ kind: 'boundary', label: 'Playable boundary', preview: `${boundary.left},${boundary.bottom}–${boundary.right},${boundary.top}`, semanticPath: ['boundary'] }]), { kind: 'preserved-body', label: 'Version-dependent body', preview: `${data.body.length} bytes`, semanticPath: ['body'] }] }),
        'common.view/table-data-source': createTableDataSource({ header: ['field', 'value'], rows: [['version', String(data.version)], ['width', String(data.width)], ['height', String(data.height)], ['unknown1', String(data.unknown1)], ['unknown2', String(data.unknown2)], ['preservedBodyBytes', String(data.body.length)]] }),
      },
      diagnostics,
      unsupportedFeatures: ['unqualified-version-dependent-body-editing'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-dimensions': async (input: any) => {
          if (input?.action === 'set-editor-terrain-context') {
            if (typeof input.expectedContext !== 'string' || typeof input.context !== 'string' ||
                Object.keys(input).some(key => !['action', 'expectedContext', 'context'].includes(key)))
              throw new TypeError('Editor terrain context edit requires action, expectedContext and context')
            const output = writeMapInfo(setMapInfoEditorTerrainContext(data, input.expectedContext, input.context))
            if (BigInt(output.byteLength) > context.budget.maxInputBytes)
              throw new RangeError('MapInfo Editor context output exceeds the document byte budget')
            return { kind: 'edit-plan', plan: editPlanFromInput(context.input, {
              planId: `sc2-map-info:editor-terrain-context:${input.expectedContext}:${input.context}`,
              edits: [replaceBytes(0, bytes.byteLength, output, `set MapInfo Editor terrain context to ${input.context}`)],
              fidelity: { roundTrip: 'semantic', preservesUnknownData: true,
                notes: ['Only the admitted v39 Editor context string changed; flags, bounds and opaque suffix remain byte-preserved'] },
            }) }
          }
          if (input === null || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width <= 0 || input.height <= 0 || input.width > 0xffffffff || input.height > 0xffffffff) throw new RangeError('width and height must be positive uint32 values')
          const output = writeMapInfo(resizeMapInfo(data, input.width, input.height, input.boundary))
          const reopened = readMapInfo(output)
          if (reopened.width !== input.width || reopened.height !== input.height || reopened.body.length !== data.body.length) throw new TypeError('MapInfo writer failed dimension verification')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-map-info:set-dimensions:${input.width}x${input.height}`, edits: [replaceBytes(0, bytes.byteLength, output, `set MapInfo dimensions to ${input.width}×${input.height}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: true, notes: [reopened.boundary === undefined ? 'Only fixed-header dimensions changed; the opaque body was preserved byte-for-byte' : `The proven playable boundary was rewritten to ${reopened.boundary.left},${reopened.boundary.bottom}–${reopened.boundary.right},${reopened.boundary.top}; all other body bytes were preserved`] } }) }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
