import {
  createInspectionCodec,
  createRelationGraphSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  replaceBytes,
} from '@modkit/codec-kit'
import { getObjectEntityLinks, readObjects, writeObjects, type PlacedObjectsResult } from '../../../../shared/format/formats/objects.js'

const ID = 'blizzard/sc2-map-objects'
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

export const operations = Object.freeze([
  Object.freeze({ id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['json']) }),
  Object.freeze({ id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: Object.freeze(['read-source']), outputKinds: Object.freeze(['bytes']) }),
  Object.freeze({ id: 'edit.content', handlerId: 'set-reference', mutatesSource: true, requiredPermissions: Object.freeze(['read-source', 'write-source']), outputKinds: Object.freeze(['edit-plan']) }),
])

const allObjects = (data: PlacedObjectsResult) => [
  ...data.units.map(value => ({ kind: 'unit', value })),
  ...data.doodads.map(value => ({ kind: 'doodad', value })),
  ...data.points.map(value => ({ kind: 'point', value })),
  ...data.cameras.map(value => ({ kind: 'camera', value })),
]

function editableObject(data: PlacedObjectsResult, id: number, field: string) {
  if (field === 'unitType') return data.units.find(item => item.id === id)
  if (field === 'sound' || field === 'model' || field === 'soundActor') return data.points.find(item => item.id === id)
  throw new RangeError(`unsupported Objects reference field ${field}`)
}


const catalogNodeId = (namespace: string, value: string): string => `catalog:C${namespace}:${value}`

export const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-map-objects', label: 'StarCraft II placed map objects', mediaType: 'application/xml' }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    const structural = /^\s*(?:<\?xml\b[^>]*>\s*)?<PlacedObjects(?:\s|>)/u.test(decoder.decode(prefix))
    if (!structural) return { confidence: 0, kind: 'structure', note: 'placed-objects-root-missing' }
    return { confidence: /(?:^|[\\/])(?:Objects|mapObjects)$/iu.test(uri) ? 1 : 0.995, kind: 'structure', note: 'PlacedObjects' }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const data = readObjects(decoder.decode(bytes))
    const objects = allObjects(data)
    if (objects.length > context.budget.maxNodes) throw new RangeError('Objects exceeds the inspection node budget')
    const links = getObjectEntityLinks(data)
    const objectNodes = objects.map(({ kind, value }) => ({ id: `object:${kind}:${value.id}`, label: `${kind} ${value.id}`, type: kind, kind: `sc2-map-${kind}` }))
    const targetNodes = [...new Map(links.map(link => {
      const type = `C${link.namespace}`
      const id = catalogNodeId(link.namespace, link.value)
      return [id, { id, label: link.value, type }]
    })).values()].sort((left, right) => left.id.localeCompare(right.id))
    const diagnostics = Object.freeze(data.version > 0 ? [] : [{ severity: 'warning', code: 'blizzard.sc2-map-objects/version', message: 'PlacedObjects has no positive Version attribute' }])
    return {
      summary: { format: 'sc2-map-objects', version: data.version, objects: objects.length, units: data.units.length, doodads: data.doodads.length, points: data.points.length, cameras: data.cameras.length, references: links.length },
      metadata: [{ id: 'sc2-map-objects', label: 'SC2 placed objects', entries: [{ key: 'version', value: data.version }, { key: 'objects', value: objects.length }, { key: 'references', value: links.length }] }],
      traits: [{ id: 'content.text', parameters: { language: 'xml' } }, { id: 'scene.objects', parameters: { count: objects.length } }],
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({ kind: 'sc2-map-objects', label: 'Placed objects', preview: String(objects.length), children: objects.map(({ kind, value }) => ({ kind: `sc2-map-${kind}`, label: `${kind} ${value.id}`, preview: 'unitType' in value ? value.unitType : 'type' in value ? value.type : value.name ?? '', semanticPath: [kind, String(value.id)] })) }),
        'common.view/table-data-source': createTableDataSource({ header: ['kind', 'id', 'position', 'type/name'], rows: objects.map(({ kind, value }) => [kind, String(value.id), value.position, 'unitType' in value ? value.unitType : 'type' in value ? value.type : value.name ?? '']) }),
        'common.view/relation-graph-source': createRelationGraphSource({ snapshotId: String(context.input.revisions.revision), nodes: [...objectNodes, ...targetNodes], edges: links.map(link => ({ from: `object:${link.elementType}:${link.id}`, to: catalogNodeId(link.namespace, link.value), role: link.field })), completeness: 'complete' }),
      },
      diagnostics,
      unsupportedFeatures: ['formatting-preserving-structural-edit'],
      handlers: {
        validate: async () => ({ kind: 'json', value: diagnostics }),
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        'set-reference': async (input: any) => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('edit.content requires an object')
          if (!Number.isSafeInteger(input.id) || input.id < 0) throw new RangeError('id must be a non-negative safe integer')
          if (typeof input.field !== 'string' || typeof input.value !== 'string' || input.value.length === 0) throw new TypeError('field and non-empty value are required')
          const next = structuredClone(data)
          const target = editableObject(next, input.id, input.field)
          if (target === undefined) throw new RangeError(`Objects has no editable ${input.field} on object ${input.id}`)
          ;(target as any)[input.field] = input.value
          const output = encoder.encode(writeObjects(next))
          const reopened = readObjects(decoder.decode(output))
          if ((editableObject(reopened, input.id, input.field) as any)?.[input.field] !== input.value) throw new TypeError('Objects writer did not preserve the requested reference')
          return { kind: 'edit-plan', plan: editPlanFromInput(context.input, { planId: `sc2-map-objects:set-reference:${input.id}:${input.field}`, edits: [replaceBytes(0, bytes.byteLength, output, `set Objects ${input.id}.${input.field}`)], fidelity: { roundTrip: 'semantic', preservesUnknownData: false, notes: ['Known attributes are preserved; XML formatting and unsupported child elements may be normalized'] } }) }
        },
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
